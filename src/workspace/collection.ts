import JSZip from 'jszip';
import type { AuditReceipt } from '../engine/types.ts';

export type SourceKind = 'text' | 'txt' | 'csv' | 'image';

export interface WorkspaceSource {
  sourceId: string;
  kind: SourceKind;
  revision: number;
  mime: string;
  /** Safe generic display label; private filename stays strictly local */
  safeLabel: string;
  byteLength: number;
  rawText?: string;
  rawImageBytes?: Uint8Array;
  status: 'pending' | 'scanned' | 'sanitized' | 'error';
}

export interface SanitizedCollectionArtifact {
  artifactId: string;
  sourceId: string;
  sourceRevision: number;
  kind: SourceKind;
  safeFilename: string;
  mime: string;
  bytes: Uint8Array;
  sha256: string;
  /** Bounded sanitized text representation for chat/ZIP inspection (undefined for binary images unless OCR text included) */
  sanitizedTextPreview?: string;
}

/**
 * Bundles sanitized artifacts + aggregate public audit receipt into a downloadable ZIP.
 * Never includes raw sources, encrypted vaults, original filenames, or local restoration logs.
 */
export async function exportSanitizedCollectionZip(
  artifacts: SanitizedCollectionArtifact[],
  aggregateReceipt: AuditReceipt,
): Promise<Uint8Array> {
  const zip = new JSZip();

  const manifestEntries: Array<{
    artifactId: string;
    safeFilename: string;
    mime: string;
    bytes: number;
    sha256: string;
  }> = [];

  for (const art of artifacts) {
    zip.file(art.safeFilename, art.bytes);
    manifestEntries.push({
      artifactId: art.artifactId,
      safeFilename: art.safeFilename,
      mime: art.mime,
      bytes: art.bytes.byteLength,
      sha256: art.sha256,
    });
  }

  zip.file('audit-receipt.json', JSON.stringify(aggregateReceipt, null, 2));
  zip.file(
    'collection-manifest.json',
    JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        note: 'Contains sanitized outputs and aggregate counts only. Originals and Identity Vault mappings excluded.',
        artifacts: manifestEntries,
      },
      null,
      2,
    ),
  );

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
