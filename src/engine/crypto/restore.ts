import { sha256Bytes } from './hash.ts';
import type { VaultPayload } from './vault.ts';
import { parseCsvSafe } from '../csv/parse.ts';
import { serializeCsvSafe } from '../csv/serialize.ts';

export interface RestoreResult {
  restoredText: string;
  restoredCount: number;
  format: 'text' | 'csv';
  notes: string[];
}

export async function restoreFromVault(
  sanitizedBytes: Uint8Array,
  payload: VaultPayload,
): Promise<RestoreResult> {
  const actualSha = await sha256Bytes(sanitizedBytes);
  if (actualSha !== payload.sanitizedSha256) {
    throw new Error(
      `Sanitized file SHA-256 mismatch (expected ${payload.sanitizedSha256.slice(0, 12)}…, got ${actualSha.slice(0, 12)}…). File may have been modified or wrong vault selected.`,
    );
  }

  const sanitizedText = new TextDecoder('utf-8', { fatal: false }).decode(sanitizedBytes);

  if (payload.format === 'text') {
    const sorted = [...payload.records].sort((a, b) => a.outStart - b.outStart);
    const out: string[] = [];
    let cursor = 0;
    let restoredCount = 0;

    for (const rec of sorted) {
      if (rec.outStart < cursor || rec.outEnd > sanitizedText.length || rec.outStart > rec.outEnd) {
        throw new Error(`Vault span out of bounds for token ${rec.token} at ${rec.outStart}–${rec.outEnd}.`);
      }
      const actualSlice = sanitizedText.slice(rec.outStart, rec.outEnd);
      if (actualSlice !== rec.token) {
        throw new Error(
          `Expected token '${rec.token}' at offset ${rec.outStart}–${rec.outEnd}, found '${actualSlice}'.`,
        );
      }
      out.push(sanitizedText.slice(cursor, rec.outStart));
      out.push(rec.originalSlice);
      cursor = rec.outEnd;
      restoredCount += 1;
    }
    out.push(sanitizedText.slice(cursor));

    return {
      restoredText: out.join(''),
      restoredCount,
      format: 'text',
      notes: [
        `Restored ${restoredCount} pseudonymized occurrence(s) with exact original formatting.`,
        'Any Full Mask or Partial Mask spans remain permanently redacted.',
      ],
    };
  }

  // CSV semantic restoration by cell coordinates
  const parsed = parseCsvSafe(sanitizedText, payload.csvDelimiter);
  const rows = parsed.rows.map((r) => [...r]);

  // Group records by (row, column) and apply in descending cellStart order
  const byCell = new Map<string, typeof payload.records>();
  for (const rec of payload.records) {
    if (rec.row === undefined || rec.column === undefined || rec.cellStart === undefined || rec.cellEnd === undefined) {
      throw new Error(`CSV vault record missing cell coordinates for token ${rec.token}.`);
    }
    const key = `${rec.row}:${rec.column}`;
    const list = byCell.get(key) ?? [];
    list.push(rec);
    byCell.set(key, list);
  }

  let restoredCount = 0;
  for (const [key, list] of byCell.entries()) {
    const [rStr, cStr] = key.split(':');
    const r = Number(rStr);
    const c = Number(cStr);
    if (!rows[r] || rows[r][c] === undefined) {
      throw new Error(`CSV cell (${r}, ${c}) missing in sanitized CSV.`);
    }
    let cellVal = rows[r][c];
    list.sort((a, b) => (b.cellStart ?? 0) - (a.cellStart ?? 0));
    for (const rec of list) {
      const start = rec.cellStart!;
      const end = rec.cellEnd!;
      const actual = cellVal.slice(start, end);
      if (actual !== rec.token) {
        throw new Error(`CSV cell (${r}, ${c}) expected '${rec.token}' at ${start}–${end}, found '${actual}'.`);
      }
      cellVal = cellVal.slice(0, start) + rec.originalSlice + cellVal.slice(end);
      restoredCount += 1;
    }
    rows[r][c] = cellVal;
  }

  const restoredCsv = serializeCsvSafe(rows, {
    delimiter: payload.csvDelimiter || parsed.diagnostics.delimiter,
    lineEnding: payload.csvLineEnding || parsed.diagnostics.lineEnding,
  });

  return {
    restoredText: restoredCsv,
    restoredCount,
    format: 'csv',
    notes: [
      `Semantically restored ${restoredCount} pseudonymized CSV cell occurrence(s).`,
      'CSV quoting/whitespace normalization may differ from pre-sanitized raw bytes; full/partial masks and generalized QI columns remain transformed.',
    ],
  };
}
