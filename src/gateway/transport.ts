import {
  IS_CLOUD_BUILD_PROFILE,
  OutboundEnvelopeSchema,
  type ApprovedOutboundSnapshot,
  type CloudResult,
  type CloudTransport,
} from './firewall.ts';

function sanitizeTransportError(status: number, bodyText: string): string {
  // Never echo keys or full raw payload in error messages
  const brief = bodyText.slice(0, 180).replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_KEY]');
  if (status === 401 || status === 403) return `Provider auth/permission error (HTTP ${status}): ${brief}`;
  if (status === 404) return `Selected Gemini model not found or unavailable (HTTP 404).`;
  if (status === 429) return `Rate limit / quota exceeded (HTTP 429). Retry after cooldown.`;
  return `Cloud provider error (HTTP ${status}): ${brief || 'request failed'}`;
}

function defaultRelayEndpoint(): string {
  if (typeof window !== 'undefined') {
    const h = window.location.hostname;
    if (h && h !== '127.0.0.1' && h !== 'localhost') {
      return '/api/gemini';
    }
  }
  return 'http://127.0.0.1:8787/api/gemini';
}

/**
 * Loopback / Same-Origin Relay transport (preferred when cloud mode is explicitly enabled).
 * Sends ONLY the exact approved serialized envelope to local relay (127.0.0.1:8787/api/gemini) or same-origin /api/gemini.
 */
export class RelayCloudTransport implements CloudTransport {
  private readonly relayUrl: string;

  constructor(relayUrl = defaultRelayEndpoint()) {
    this.relayUrl = relayUrl;
  }

  async send(snapshot: ApprovedOutboundSnapshot, signal: AbortSignal): Promise<CloudResult> {
    if (!IS_CLOUD_BUILD_PROFILE) {
      throw new Error('Strict-local build disables cloud relay requests.');
    }

    const res = await fetch(this.relayUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: snapshot.exactSerializedBody,
      signal,
    });

    const textBody = await res.text();
    if (!res.ok) {
      return {
        status: 'error',
        text: '',
        model: snapshot.model,
        errorMessage: sanitizeTransportError(res.status, textBody),
      };
    }

    const parsed = JSON.parse(textBody) as {
      text?: string;
      finishReason?: string;
      usageSummary?: string;
      error?: string;
    };
    if (parsed.error) {
      return { status: 'error', text: '', model: snapshot.model, errorMessage: parsed.error };
    }

    return {
      status: 'completed',
      text: parsed.text || '',
      model: snapshot.model,
      finishReason: parsed.finishReason,
      usageSummary: parsed.usageSummary,
    };
  }
}

/**
 * Optional demo-only Direct Browser BYOK transport (disabled unless cloud profile + explicit user key).
 * Uses `x-goog-api-key` header (never query string, never persisted).
 */
export class DirectByokGeminiTransport implements CloudTransport {
  private readonly getEphemeralKey: () => string;

  constructor(getEphemeralKey: () => string) {
    this.getEphemeralKey = getEphemeralKey;
  }

  async send(snapshot: ApprovedOutboundSnapshot, signal: AbortSignal): Promise<CloudResult> {
    if (!IS_CLOUD_BUILD_PROFILE) {
      throw new Error('Strict-local build disables direct Gemini requests.');
    }
    const apiKey = this.getEphemeralKey().trim();
    if (!apiKey) {
      throw new Error('No ephemeral Gemini API key entered.');
    }

    const envelope = OutboundEnvelopeSchema.parse(JSON.parse(snapshot.exactSerializedBody));
    const contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> = [];

    for (const h of envelope.history) {
      contents.push({ role: h.role, parts: [{ text: h.text }] });
    }

    const currentParts: Array<Record<string, unknown>> = [{ text: envelope.currentPrompt }];
    for (const att of envelope.sanitizedAttachments) {
      currentParts.push({
        text: `\n[Sanitized Attachment: ${att.safeLabel} (${att.kind})]\n${att.sanitizedText}`,
      });
    }
    for (const img of envelope.sanitizedImages) {
      currentParts.push({
        inlineData: {
          mimeType: img.mimeType,
          data: img.base64Data,
        },
      });
    }
    contents.push({ role: 'user', parts: currentParts });

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(envelope.model)}:generateContent`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        systemInstruction: envelope.systemInstruction
          ? { parts: [{ text: envelope.systemInstruction }] }
          : undefined,
        contents,
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 1024,
        },
      }),
      signal,
    });

    const raw = await res.text();
    if (!res.ok) {
      return {
        status: 'error',
        text: '',
        model: envelope.model,
        errorMessage: sanitizeTransportError(res.status, raw),
      };
    }

    const json = JSON.parse(raw) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
      }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const cand = json.candidates?.[0];
    const replyText = (cand?.content?.parts || []).map((p) => p.text || '').join('');
    const usage = json.usageMetadata
      ? `in=${json.usageMetadata.promptTokenCount ?? '?'} out=${json.usageMetadata.candidatesTokenCount ?? '?'}`
      : undefined;

    return {
      status: 'completed',
      text: replyText,
      model: envelope.model,
      finishReason: cand?.finishReason,
      usageSummary: usage,
    };
  }
}
