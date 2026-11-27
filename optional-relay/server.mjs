import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { GoogleGenAI } from '@google/genai';

function loadLocalEnv() {
  const envPath = path.resolve(process.cwd(), 'optional-relay', '.env.local');
  const altPath = path.resolve(process.cwd(), '.env.local');
  for (const p of [envPath, altPath]) {
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf-8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!(key in process.env)) {
        process.env[key] = val;
      }
    }
  }
}

loadLocalEnv();

const ENABLED = process.env.ENABLE_CLOUD_CHAT === 'true';
const PORT = Number(process.env.PORT || 8787);
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_APP_ORIGIN || 'http://127.0.0.1:4173,http://localhost:4173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const ALLOWED_MODELS = new Set([
  process.env.GEMINI_MODEL_ID || 'gemini-flash-lite-latest',
  'gemini-flash-lite-latest',
  'gemini-flash-latest',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
]);

// Simple loopback rate limiter (30 requests per minute)
const requestTimestamps = [];
function allowRateLimit() {
  const now = Date.now();
  while (requestTimestamps.length > 0 && now - requestTimestamps[0] > 60_000) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length >= 30) return false;
  requestTimestamps.push(now);
  return true;
}

const EnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.literal('gemini'),
    model: z.string().min(3).max(80),
    systemInstruction: z.string().max(1000),
    history: z
      .array(z.object({ role: z.enum(['user', 'model']), text: z.string().min(1).max(32_000) }).strict())
      .max(20),
    currentPrompt: z.string().min(1).max(24_000),
    sanitizedAttachments: z
      .array(
        z
          .object({
            artifactId: z.string().min(1).max(64),
            safeLabel: z.string().min(1).max(80),
            kind: z.enum(['text', 'txt', 'csv']),
            sanitizedText: z.string().max(40_000),
            sha256: z.string().length(64),
          })
          .strict(),
      )
      .max(8),
    sanitizedImages: z
      .array(
        z
          .object({
            artifactId: z.string().min(1).max(64),
            safeLabel: z.string().min(1).max(80),
            mimeType: z.enum(['image/png', 'image/jpeg']),
            base64Data: z.string().min(16).max(6_000_000),
            sha256: z.string().length(64),
            byteLength: z.number().int().positive().max(4_500_000),
          })
          .strict(),
      )
      .max(4),
  })
  .strict();

const OBVIOUS_EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const OBVIOUS_PAN_RE = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/;

function jsonResponse(res, status, obj, origin) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  });
  res.end(JSON.stringify(obj));
}

function scoreFlashCandidate(modelName) {
  const n = modelName.toLowerCase();
  if (!n.includes('gemini')) return -1;
  if (
    n.includes('embedding') ||
    n.includes('imagen') ||
    n.includes('veo') ||
    n.includes('tts') ||
    n.includes('audio') ||
    n.includes('robotics') ||
    n.includes('image') ||
    n.includes('computer-use')
  ) {
    return -1;
  }
  if (!n.includes('flash')) return 10;
  if (n.includes('2.5-flash') && !n.includes('lite') && !n.includes('exp') && !n.includes('preview')) return 100;
  if (n === 'gemini-flash-latest') return 90;
  if (n === 'gemini-flash-lite-latest') return 85;
  if (n.includes('2.0-flash') && !n.includes('lite') && !n.includes('exp')) return 80;
  if (n.includes('exp') || n.includes('thinking') || n.includes('preview')) return 40;
  return 65;
}

async function discoverAndValidateFlashModel(ai) {
  const pager = await ai.models.list();
  const candidates = [];
  for await (const m of pager) {
    const rawName = (m.name || '').replace(/^models\//, '');
    const methods = m.supportedActions || m.supportedGenerationMethods || [];
    const supportsGen =
      methods.length === 0 || methods.some((x) => String(x).toLowerCase().includes('generatecontent'));
    const score = supportsGen ? scoreFlashCandidate(rawName) : -1;
    if (score >= 0) {
      candidates.push({ name: rawName, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  for (const cand of candidates.slice(0, 5)) {
    try {
      const test = await ai.models.generateContent({
        model: cand.name,
        contents: 'Respond with OK.',
        config: { maxOutputTokens: 16, temperature: 0 },
      });
      if (test.text) {
        ALLOWED_MODELS.add(cand.name);
        return {
          selectedModel: cand.name,
          validated: true,
          testReply: test.text.trim().slice(0, 40),
          availableCandidates: candidates.slice(0, 10).map((c) => c.name),
        };
      }
    } catch {
      // Try next candidate
    }
  }
  throw new Error('No listed Gemini Flash-class model succeeded a validation generation request.');
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const originAllowed = ALLOWED_ORIGINS.has(origin);
  const replyOrigin = originAllowed ? origin : Array.from(ALLOWED_ORIGINS)[0];

  if (req.method === 'OPTIONS') {
    if (!originAllowed) {
      res.writeHead(403);
      res.end();
      return;
    }
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    });
    res.end();
    return;
  }

  if (!originAllowed) {
    jsonResponse(res, 403, { error: 'Origin rejected by loopback relay policy.' }, replyOrigin);
    return;
  }

  if (!ENABLED) {
    jsonResponse(res, 403, { error: 'Cloud relay is disabled (ENABLE_CLOUD_CHAT != true).' }, replyOrigin);
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    jsonResponse(res, 503, { error: 'GEMINI_API_KEY is not configured in optional-relay/.env.local.' }, replyOrigin);
    return;
  }

  if (!allowRateLimit()) {
    jsonResponse(res, 429, { error: 'Loopback relay rate limit exceeded (30 req/min).' }, replyOrigin);
    return;
  }

  if (req.url === '/api/models' && req.method === 'GET') {
    try {
      const ai = new GoogleGenAI({ apiKey });
      const info = await discoverAndValidateFlashModel(ai);
      jsonResponse(res, 200, info, replyOrigin);
    } catch (err) {
      jsonResponse(res, 502, { error: err instanceof Error ? err.message : 'Model discovery failed.' }, replyOrigin);
    }
    return;
  }

  if (req.url !== '/api/gemini' || req.method !== 'POST') {
    jsonResponse(res, 404, { error: 'Not found' }, replyOrigin);
    return;
  }

  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 8_000_000) {
      jsonResponse(res, 413, { error: 'Request envelope too large.' }, replyOrigin);
      return;
    }
  }

  let parsedJson;
  try {
    parsedJson = JSON.parse(body);
  } catch {
    jsonResponse(res, 400, { error: 'Invalid JSON envelope.' }, replyOrigin);
    return;
  }

  const validated = EnvelopeSchema.safeParse(parsedJson);
  if (!validated.success) {
    jsonResponse(res, 400, { error: 'Envelope failed strict schema validation.' }, replyOrigin);
    return;
  }

  const env = validated.data;
  if (!ALLOWED_MODELS.has(env.model)) {
    jsonResponse(res, 400, { error: `Model '${env.model}' is not in relay allowlist.` }, replyOrigin);
    return;
  }

  const combinedText = [
    env.systemInstruction,
    ...env.history.map((h) => h.text),
    env.currentPrompt,
    ...env.sanitizedAttachments.map((a) => a.sanitizedText),
  ].join('\n');

  if (OBVIOUS_EMAIL_RE.test(combinedText) || OBVIOUS_PAN_RE.test(combinedText)) {
    jsonResponse(
      res,
      422,
      { error: 'Relay defense-in-depth blocked payload containing detectable Email or PAN pattern.' },
      replyOrigin,
    );
    return;
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const contents = env.history.map((h) => ({ role: h.role, parts: [{ text: h.text }] }));
    const currentParts = [{ text: env.currentPrompt }];
    for (const att of env.sanitizedAttachments) {
      currentParts.push({ text: `\n[Sanitized Attachment: ${att.safeLabel} (${att.kind})]\n${att.sanitizedText}` });
    }
    for (const img of env.sanitizedImages) {
      currentParts.push({ inlineData: { mimeType: img.mimeType, data: img.base64Data } });
    }
    contents.push({ role: 'user', parts: currentParts });

    const result = await ai.models.generateContent({
      model: env.model,
      contents,
      config: {
        systemInstruction: env.systemInstruction || undefined,
        temperature: 0.3,
        maxOutputTokens: 1024,
        httpOptions: { timeout: 30_000 },
      },
    });

    jsonResponse(
      res,
      200,
      {
        text: result.text || '',
        finishReason: result.candidates?.[0]?.finishReason,
        usageSummary: result.usageMetadata
          ? `in=${result.usageMetadata.promptTokenCount ?? '?'} out=${result.usageMetadata.candidatesTokenCount ?? '?'}`
          : undefined,
      },
      replyOrigin,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Upstream provider error';
    jsonResponse(res, 502, { error: msg.slice(0, 200) }, replyOrigin);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[CipherMask Optional Relay] Listening on http://127.0.0.1:${PORT}/api/gemini (enabled=${ENABLED})`);
});
