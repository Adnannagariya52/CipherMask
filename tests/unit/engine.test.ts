import { describe, it, expect } from 'vitest';
import { validateLuhn } from '../../src/engine/validators/luhn.ts';
import { computeVerhoeffCheckDigit, validateAadhaar, validateVerhoeff } from '../../src/engine/validators/verhoeff.ts';
import { buildNormalizedView, mapNormalizedSpanToOriginal } from '../../src/engine/normalization.ts';
import { createDefaultPolicy } from '../../src/engine/redaction.ts';
import { applyRedactionPolicy, runDetectionPipeline } from '../../src/engine/pipeline.ts';
import { MIXED_FORMATS_SAMPLE, NOISY_TEXT_SAMPLE } from '../../src/fixtures/samples.ts';

describe('Validators (Luhn & Verhoeff)', () => {
  it('accepts valid Luhn test vector 4111 1111 1111 1111 and rejects 4111 1111 1111 1112', () => {
    expect(validateLuhn('4111 1111 1111 1111').valid).toBe(true);
    expect(validateLuhn('4111 1111 1111 1112').valid).toBe(false);
    expect(validateLuhn('1111 1111 1111 1111').valid).toBe(false);
    expect(validateLuhn('123456789012').valid).toBe(false); // < 13 digits
  });

  it('validates Verhoeff checksum vectors and rejects single-digit mutation', () => {
    const check = computeVerhoeffCheckDigit('23456789012');
    const valid = `23456789012${check}`;
    expect(validateVerhoeff(valid)).toBe(true);
    expect(validateAadhaar(`2345 6789 012${check}`).valid).toBe(true);

    const badLast = (check + 1) % 10;
    expect(validateAadhaar(`2345 6789 012${badLast}`).valid).toBe(false);
    expect(validateAadhaar('1345 6789 0120').valid).toBe(false); // cannot start with 1
  });
});

describe('Normalization & UTF-16 Offset Mapping', () => {
  it('maps normalized spans across zero-width chars, fullwidth digits, and surrogate-pair emojis', () => {
    const raw = 'User 😀 sent r\u200Bohan@example.in and \uFF14\uFF11\uFF11\uFF11 \uFF11\uFF11\uFF11\uFF11 \uFF11\uFF11\uFF11\uFF11 \uFF11\uFF11\uFF11\uFF11';
    const view = buildNormalizedView(raw);
    const idx = view.normalized.indexOf('rohan@example.in');
    expect(idx).toBeGreaterThan(-1);
    const orig = mapNormalizedSpanToOriginal(view, idx, idx + 'rohan@example.in'.length)!;
    expect(raw.slice(orig.start, orig.end)).toBe('r\u200Bohan@example.in');
  });
});

describe('Shared Detection & Redaction Pipeline', () => {
  it('detects all 6 mandatory categories on NOISY_TEXT_SAMPLE and rejects invalid card/Aadhaar/IP', () => {
    const policy = createDefaultPolicy('AI_SAFE');
    const det = runDetectionPipeline(NOISY_TEXT_SAMPLE, { policy, revision: 1 });

    expect(det.countsByType.EMAIL).toBe(3); // 2 standard + 1 obfuscated
    expect(det.countsByType.PHONE).toBe(2);
    expect(det.countsByType.PAN).toBe(2);
    expect(det.countsByType.AADHAAR).toBe(1);
    expect(det.countsByType.CARD).toBe(1);
    expect(det.countsByType.IPV4).toBe(1);
    expect(det.countsByType.IPV6).toBe(1);

    // Rejected items tracked separately & never re-classified as shorter phone/Aadhaar
    expect(det.rejected.some((r) => r.type === 'CARD' && r.rawText === '4111 1111 1111 1112')).toBe(true);
    expect(det.rejected.some((r) => r.type === 'AADHAAR' && r.rawText === '2345 6789 0125')).toBe(true);
    expect(det.rejected.some((r) => r.type === 'IPV4' && r.rawText === '999.168.1.100')).toBe(true);
    expect(det.rejected.some((r) => r.type === 'IPV4' && r.rawText === '2.4.1.0')).toBe(true);
  });

  it('supports FULL, PARTIAL, and consistent PSEUDONYM modes while preserving non-PII slices', () => {
    const fullPolicy = createDefaultPolicy('AI_SAFE');
    const det = runDetectionPipeline(NOISY_TEXT_SAMPLE, { policy: fullPolicy, revision: 1 });

    // FULL mode
    const fullOut = applyRedactionPolicy(NOISY_TEXT_SAMPLE, det, fullPolicy);
    expect(fullOut.sanitizedText).toContain('[REDACTED]');
    expect(fullOut.sanitizedText).not.toContain('priya.sharma@example.org');
    expect(fullOut.sanitizedText).not.toContain('2345 6789 0124');
    expect(fullOut.sanitizedText).not.toContain('4111 1111 1111 1111');
    expect(fullOut.sanitizedText).toContain('Order Ref: ORD-2026-0419');

    // PARTIAL mode
    const partialPolicy = { ...createDefaultPolicy('CUSTOM'), defaultMode: 'PARTIAL' as const };
    const partialOut = applyRedactionPolicy(NOISY_TEXT_SAMPLE, det, partialPolicy);
    expect(partialOut.sanitizedText).toContain('XXXX XXXX 0124');
    expect(partialOut.sanitizedText).toContain('XXXX XXXX XXXX 1111');
    expect(partialOut.sanitizedText).toContain('XXXXXX234F');
    expect(partialOut.sanitizedText).toContain('192.168.xxx.xxx');

    // PSEUDONYM mode: repeated canonical identifiers get the exact same token
    const pseudoPolicy = createDefaultPolicy('RESEARCH');
    const pseudoOut = applyRedactionPolicy(NOISY_TEXT_SAMPLE, det, pseudoPolicy);
    const emailTokens = pseudoOut.transformations.filter((t) => t.type === 'EMAIL').map((t) => t.replacement);
    expect(emailTokens[0]).toBe('EMAIL_01');
    expect(emailTokens[1]).toBe('EMAIL_01'); // priya.sharma@example.org vs priya.sharma@EXAMPLE.ORG
    expect(emailTokens[2]).toBe('EMAIL_02'); // obfuscated support@ciphermask-demo.org

    const panTokens = pseudoOut.transformations.filter((t) => t.type === 'PAN').map((t) => t.replacement);
    expect(panTokens).toEqual(['PAN_01', 'PAN_01']);

    const phoneTokens = pseudoOut.transformations.filter((t) => t.type === 'PHONE').map((t) => t.replacement);
    expect(phoneTokens).toEqual(['PHONE_01', 'PHONE_01']);

    expect(pseudoOut.verification.remainingCount).toBe(0);
  });

  it('avoids colliding with preexisting literal tokens and handles mixed formats', () => {
    const policy = createDefaultPolicy('RESEARCH');
    const det = runDetectionPipeline(MIXED_FORMATS_SAMPLE, { policy, revision: 1 });
    const out = applyRedactionPolicy(MIXED_FORMATS_SAMPLE, det, policy);

    expect(out.sanitizedText).toContain('Preexisting Token EMAIL_01 should stay untouched');
    const emailTokens = out.transformations.filter((t) => t.type === 'EMAIL').map((t) => t.replacement);
    expect(emailTokens[0]).toBe('EMAIL_02'); // Skips EMAIL_01 collision!
    expect(det.countsByType.CARD).toBe(1); // Fullwidth card detected via Leak Hunter normalization
    expect(det.countsByType.IPV6).toBe(1);
    expect(det.countsByType.AADHAAR).toBe(1);
  });

  it('respects entity exclusions and reports them in verification', () => {
    const policy = createDefaultPolicy('AI_SAFE');
    const det = runDetectionPipeline('Contact alice@example.com or 10.0.0.5', { policy, revision: 1 });
    const ipCand = det.accepted.find((c) => c.type === 'IPV4')!;
    policy.entityOverrides[ipCand.id] = { reviewStatus: 'excluded' };

    const out = applyRedactionPolicy('Contact alice@example.com or 10.0.0.5', det, policy);
    expect(out.sanitizedText).toBe('Contact [REDACTED] or 10.0.0.5');
    expect(out.excludedCount).toBe(1);
    expect(out.verification.excludedCount).toBe(1);
    expect(out.verification.cleanByEnabledChecks).toBe(false);
  });
});
