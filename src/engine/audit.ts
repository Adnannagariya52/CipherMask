import type { AuditReceipt, CoreRedactionMode, PresetId } from './types.ts';
import { sha256Bytes } from './crypto/hash.ts';

export const APP_VERSION = '1.0.0';

export interface BuildAuditInput {
  inputFormat: AuditReceipt['inputFormat'];
  inputByteSize: number;
  outputFormat: string;
  outputBytes: Uint8Array;
  policyPreset: PresetId;
  defaultMode: CoreRedactionMode;
  enabledMethods: string[];
  counts: AuditReceipt['counts'];
  durationsMs: AuditReceipt['durationsMs'];
  statusLabel: string;
  remainingFindings: number;
  limitations: string[];
  csvSummary?: AuditReceipt['csvSummary'];
  visionSummary?: AuditReceipt['visionSummary'];
  offlineAssetStatus: Record<string, string>;
}

export async function createAuditReceipt(input: BuildAuditInput): Promise<AuditReceipt> {
  const outputSha256 = await sha256Bytes(input.outputBytes);
  return {
    schemaVersion: 1,
    appName: 'CipherMask',
    appVersion: APP_VERSION,
    generatedAt: new Date().toISOString(),
    inputFormat: input.inputFormat,
    inputByteSize: input.inputByteSize,
    outputFormat: input.outputFormat,
    outputByteSize: input.outputBytes.byteLength,
    outputSha256,
    policyPreset: input.policyPreset,
    defaultMode: input.defaultMode,
    enabledMethods: input.enabledMethods,
    counts: input.counts,
    durationsMs: input.durationsMs,
    verification: {
      statusLabel: input.statusLabel,
      remainingFindings: input.remainingFindings,
      limitations: input.limitations,
    },
    csvSummary: input.csvSummary,
    visionSummary: input.visionSummary,
    offlineAssetStatus: input.offlineAssetStatus,
  };
}

export interface ReceiptVerifyResult {
  matched: boolean;
  actualSha256: string;
  expectedSha256: string;
  actualBytes: number;
  expectedBytes: number;
  message: string;
}

export async function verifyArtifactAgainstReceipt(
  artifactBytes: Uint8Array,
  receiptJson: string,
): Promise<{ receipt: AuditReceipt; result: ReceiptVerifyResult }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(receiptJson);
  } catch {
    throw new Error('Receipt file is not valid JSON.');
  }
  const receipt = parsed as AuditReceipt;
  if (
    !receipt ||
    receipt.schemaVersion !== 1 ||
    receipt.appName !== 'CipherMask' ||
    typeof receipt.outputSha256 !== 'string'
  ) {
    throw new Error('Receipt file failed CipherMask schema validation.');
  }

  const actualSha256 = await sha256Bytes(artifactBytes);
  const matched = actualSha256 === receipt.outputSha256 && artifactBytes.byteLength === receipt.outputByteSize;

  return {
    receipt,
    result: {
      matched,
      actualSha256,
      expectedSha256: receipt.outputSha256,
      actualBytes: artifactBytes.byteLength,
      expectedBytes: receipt.outputByteSize,
      message: matched
        ? 'SHA-256 digest and byte length match the local receipt. (Proves integrity against this receipt, not external authenticity or zero transmission.)'
        : 'SHA-256 mismatch: the uploaded artifact bytes differ from the receipt.',
    },
  };
}
