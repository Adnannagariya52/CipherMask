import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { OutboundPrivacyFirewall } from '../../src/gateway/firewall.ts';
import { exportSanitizedCollectionZip } from '../../src/workspace/collection.ts';
import { sha256Text } from '../../src/engine/crypto/hash.ts';
import { createAuditReceipt } from '../../src/engine/audit.ts';

describe('Outbound Privacy Firewall & Collection ZIP', () => {
  it('blocks outbound bundles in strict build and whenever unmasked PII or raw originals appear', async () => {
    const fw = new OutboundPrivacyFirewall();
    const { sha256Hex } = await sha256Text('Clean sanitized text');

    const blockedRes = await fw.prepareRelease({
      conversationId: 'c1',
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      transportMode: 'relay',
      organizerPermitted: true,
      providerTier: 'unpaid-demo',
      sourceRevisions: { main: 1 },
      policyRevision: 1,
      findingsRevision: 1,
      transcriptRevision: 1,
      scansComplete: true,
      hasUnresolvedCriticalFindings: false,
      knownOriginals: ['Aarav Mehta'],
      envelope: {
        schemaVersion: 1,
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        systemInstruction: 'Preserve placeholders.',
        history: [],
        currentPrompt: 'Help Aarav Mehta with bob@example.org',
        sanitizedAttachments: [
          {
            artifactId: 'a1',
            safeLabel: 'doc_1.txt',
            kind: 'txt',
            sanitizedText: 'Clean sanitized text',
            sha256: sha256Hex,
          },
        ],
        sanitizedImages: [],
      },
    });

    expect(blockedRes.canApprove).toBe(false);
    // Strict profile + remaining email + unmasked original value all detected!
    expect(blockedRes.blockedReasons.some((r) => r.includes('Strict-local'))).toBe(true);
    expect(blockedRes.blockedReasons.some((r) => r.includes('remaining mandatory pattern'))).toBe(true);
    expect(blockedRes.blockedReasons.some((r) => r.includes('unmasked original'))).toBe(true);

    expect(() =>
      fw.approveRelease(blockedRes.reviewId, true, {
        conversationId: 'c1',
        sourceRevisions: { main: 1 },
        policyRevision: 1,
        findingsRevision: 1,
        transcriptRevision: 1,
        model: 'gemini-2.5-flash',
      }),
    ).toThrow();
  });

  it('exports sanitized collection ZIP containing zero raw sentinels or vaults', async () => {
    const sanText = 'Sanitized ticket for [[CM_EMAIL_01_a1b2]] error GATEWAY_TIMEOUT';
    const { bytes, sha256Hex } = await sha256Text(sanText);
    const receipt = await createAuditReceipt({
      inputFormat: 'txt',
      inputByteSize: 100,
      outputFormat: 'application/zip',
      outputBytes: bytes,
      policyPreset: 'CUSTOM',
      defaultMode: 'PSEUDONYM',
      enabledMethods: ['rules'],
      counts: { totalDetected: 1, uniqueEntities: 1, applied: 1, excluded: 0, rejected: 0, uncertain: 0, byType: { EMAIL: 1 } },
      durationsMs: { detection: 1, redaction: 1 },
      statusLabel: 'Sanitized',
      remainingFindings: 0,
      limitations: [],
      offlineAssetStatus: { rules: 'ready' },
    });

    const zipBytes = await exportSanitizedCollectionZip(
      [
        {
          artifactId: 'art1',
          sourceId: 's1',
          sourceRevision: 1,
          kind: 'txt',
          safeFilename: 'support_log_1.txt',
          mime: 'text/plain',
          bytes,
          sha256: sha256Hex,
        },
      ],
      receipt,
    );

    const loaded = await JSZip.loadAsync(zipBytes);
    const names = Object.keys(loaded.files);
    expect(names).toContain('support_log_1.txt');
    expect(names).toContain('audit-receipt.json');
    expect(names).toContain('collection-manifest.json');
    expect(names.some((n) => n.includes('vault'))).toBe(false);

    const content = await loaded.file('support_log_1.txt')!.async('string');
    expect(content).toBe(sanText);
  });
});
