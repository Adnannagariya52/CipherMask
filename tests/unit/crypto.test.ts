import { describe, it, expect } from 'vitest';
import { sha256Text } from '../../src/engine/crypto/hash.ts';
import {
  decryptVaultEnvelope,
  encryptVaultPayload,
  type VaultPayload,
} from '../../src/engine/crypto/vault.ts';
import { restoreFromVault } from '../../src/engine/crypto/restore.ts';
import { createAuditReceipt, verifyArtifactAgainstReceipt } from '../../src/engine/audit.ts';
import { createDefaultPolicy } from '../../src/engine/redaction.ts';
import { applyRedactionPolicy, runDetectionPipeline } from '../../src/engine/pipeline.ts';

describe('SHA-256 Audit & Receipt Verification', () => {
  it('computes NIST SHA-256 vector for "abc" and verifies matching/tampered receipts', async () => {
    const { sha256Hex } = await sha256Text('abc');
    expect(sha256Hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

    const bytes = new TextEncoder().encode('Sanitized sample text');
    const receipt = await createAuditReceipt({
      inputFormat: 'paste',
      inputByteSize: 40,
      outputFormat: 'text/plain',
      outputBytes: bytes,
      policyPreset: 'AI_SAFE',
      defaultMode: 'FULL',
      enabledMethods: ['regex', 'checksum'],
      counts: { totalDetected: 1, uniqueEntities: 1, applied: 1, excluded: 0, rejected: 0, uncertain: 0, byType: { EMAIL: 1 } },
      durationsMs: { detection: 1.2, redaction: 0.4 },
      statusLabel: 'No supported patterns detected by enabled checks',
      remainingFindings: 0,
      limitations: ['Synthetic test'],
      offlineAssetStatus: { shell: 'ready' },
    });

    const ok = await verifyArtifactAgainstReceipt(bytes, JSON.stringify(receipt));
    expect(ok.result.matched).toBe(true);

    const tampered = new TextEncoder().encode('Sanitized sample texT');
    const bad = await verifyArtifactAgainstReceipt(tampered, JSON.stringify(receipt));
    expect(bad.result.matched).toBe(false);
  });
});

describe('Encrypted Identity Vault & Restoration', () => {
  it('roundtrips formatting variants, skips preexisting literal tokens, and rejects wrong password / tampering / bad iterations', async () => {
    const original = 'Contact alice@Example.ORG, +91 98765 43210, 9876543210, note EMAIL_01 stays.';
    const policy = createDefaultPolicy('RESEARCH');
    const det = runDetectionPipeline(original, { policy, revision: 1 });
    const out = applyRedactionPolicy(original, det, policy);

    const { bytes: sanBytes, sha256Hex } = await sha256Text(out.sanitizedText);
    const payload: VaultPayload = {
      schemaVersion: 1,
      format: 'text',
      sanitizedSha256: sha256Hex,
      records: out.transformations
        .filter((t) => t.applied && t.mode === 'PSEUDONYM')
        .map((t) => ({
          type: t.type,
          token: t.replacement,
          originalSlice: t.originalSlice,
          outStart: t.outStart,
          outEnd: t.outEnd,
        })),
    };

    const envelope = await encryptVaultPayload(payload, 'correct-horse-battery-staple', 100_000);
    const envelopeJson = JSON.stringify(envelope);

    // Decrypt & restore
    const decrypted = await decryptVaultEnvelope(envelopeJson, 'correct-horse-battery-staple');
    const restored = await restoreFromVault(sanBytes, decrypted);
    expect(restored.restoredText).toBe(original);

    // Wrong password
    await expect(decryptVaultEnvelope(envelopeJson, 'wrong-password-here')).rejects.toThrow();

    // Tampered ciphertext
    const parsed = JSON.parse(envelopeJson);
    parsed.ciphertext = parsed.ciphertext.slice(0, -4) + 'AAAA';
    await expect(decryptVaultEnvelope(JSON.stringify(parsed), 'correct-horse-battery-staple')).rejects.toThrow();

    // Malicious huge iteration count rejected before KDF
    const dosParsed = JSON.parse(envelopeJson);
    dosParsed.iterations = 50_000_000;
    await expect(decryptVaultEnvelope(JSON.stringify(dosParsed), 'correct-horse-battery-staple')).rejects.toThrow(
      /bounds/i,
    );

    // Altered sanitized file rejected by hash check
    const alteredBytes = new TextEncoder().encode(out.sanitizedText + ' ');
    await expect(restoreFromVault(alteredBytes, decrypted)).rejects.toThrow(/mismatch/i);
  });
});
