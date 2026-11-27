import fs from 'node:fs';
import path from 'node:path';
import { GoogleGenAI } from '../optional-relay/node_modules/@google/genai/dist/node/index.mjs';

const ROOT = process.cwd();
const ENV_EXAMPLE = path.join(ROOT, '.env.example');
const ENV_LOCAL = path.join(ROOT, 'optional-relay', '.env.local');

function readKeyFromFile(filePath) {
  if (!fs.existsSync(filePath)) return '';
  const raw = fs.readFileSync(filePath, 'utf-8');
  const m = /^GEMINI_API_KEY=(.+)$/m.exec(raw);
  return m ? m[1].trim() : '';
}

function scoreModel(name) {
  const lower = name.toLowerCase();
  if (!lower.includes('gemini')) return -1;
  if (
    lower.includes('embedding') ||
    lower.includes('imagen') ||
    lower.includes('veo') ||
    lower.includes('tts') ||
    lower.includes('audio') ||
    lower.includes('robotics') ||
    lower.includes('computer-use')
  ) {
    return -1;
  }
  if (!lower.includes('flash')) return 10;
  if (lower.includes('2.5-flash') && !lower.includes('lite') && !lower.includes('exp') && !lower.includes('preview')) return 100;
  if (lower.includes('2.0-flash') && !lower.includes('lite') && !lower.includes('exp') && !lower.includes('001')) return 85;
  if (lower.includes('2.0-flash') && !lower.includes('lite')) return 80;
  if (lower.includes('2.5-flash-lite')) return 60;
  if (lower.includes('exp') || lower.includes('preview')) return 35;
  return 50;
}

async function main() {
  let key = readKeyFromFile(ENV_EXAMPLE);
  const fromExample = Boolean(key);
  if (!key) {
    key = readKeyFromFile(ENV_LOCAL);
  }
  if (!key) {
    console.error('No GEMINI_API_KEY found in .env.example or optional-relay/.env.local.');
    process.exit(1);
  }

  console.log(`[relay-setup] Key located (${fromExample ? 'migrating from .env.example' : 'from optional-relay/.env.local'}). Discovering models...`);

  const ai = new GoogleGenAI({ apiKey: key });
  const pager = await ai.models.list();
  const cands = [];

  for await (const mod of pager) {
    const name = (mod.name || '').replace(/^models\//, '');
    const methods = mod.supportedActions || mod.supportedGenerationMethods || [];
    const ok =
      methods.length === 0 ||
      methods.some((x) => String(x).toLowerCase().includes('generatecontent'));
    if (!ok) continue;
    const score = scoreModel(name);
    if (score >= 0) cands.push({ name, score });
    if (cands.length >= 60) break;
  }

  cands.sort((a, b) => b.score - a.score);
  console.log(`[relay-setup] Top candidates: ${cands.slice(0, 6).map((c) => c.name).join(', ')}`);

  let selected = null;
  let testReply = '';
  let lastErr = '';

  for (const cand of cands.slice(0, 6)) {
    try {
      const res = await ai.models.generateContent({
        model: cand.name,
        contents: 'Respond with exactly: GEMINI_OK',
        config: { maxOutputTokens: 16, temperature: 0, httpOptions: { timeout: 15_000 } },
      });
      if (res.text) {
        selected = cand.name;
        testReply = res.text.trim();
        break;
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      console.warn(`[relay-setup] Candidate ${cand.name} skipped: ${lastErr.slice(0, 120)}`);
    }
  }

  if (!selected) {
    console.error(`[relay-setup] Failed to validate any Gemini model. Last error: ${lastErr.slice(0, 200)}`);
    process.exit(1);
  }

  // Write key securely to ignored optional-relay/.env.local and scrub .env.example
  const envLocal = [
    '# Local gitignored Gemini relay configuration (do not commit)',
    `GEMINI_API_KEY=${key}`,
    `GEMINI_MODEL_ID=${selected}`,
    'GEMINI_PROVIDER_TIER=unpaid-demo',
    'ALLOWED_APP_ORIGIN=http://127.0.0.1:4173,http://localhost:4173,http://127.0.0.1:4174',
    'ENABLE_CLOUD_CHAT=true',
    'PORT=8787',
    '',
  ].join('\n');
  fs.writeFileSync(ENV_LOCAL, envLocal, 'utf-8');

  const cleanTemplate = [
    '# Optional Loopback Relay Configuration (copy to optional-relay/.env.local only if organizer approves cloud extension)',
    '# Never put secrets in VITE_* variables or commit real keys.',
    'GEMINI_API_KEY=',
    `GEMINI_MODEL_ID=${selected}`,
    'GEMINI_PROVIDER_TIER=unpaid-demo',
    'ALLOWED_APP_ORIGIN=http://127.0.0.1:4173,http://localhost:4173',
    'ENABLE_CLOUD_CHAT=false',
    'PORT=8787',
    '',
  ].join('\n');
  fs.writeFileSync(ENV_EXAMPLE, cleanTemplate, 'utf-8');

  console.log(
    JSON.stringify(
      {
        selectedModel: selected,
        testReply,
        envLocalConfigured: true,
        envExampleScrubbed: true,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error('[relay-setup ERROR]', err instanceof Error ? err.message.slice(0, 200) : String(err));
  process.exit(1);
});
