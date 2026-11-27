import Papa from 'papaparse';

export const CSV_MAX_BYTES = 5 * 1024 * 1024;
export const CSV_MAX_ROWS = 20_000;
export const CSV_MAX_COLS = 100;

export interface CsvParseDiagnostics {
  hadBom: boolean;
  delimiter: string;
  lineEnding: '\r\n' | '\n';
  rowCount: number;
  columnCount: number;
  inconsistentRowWidths: Array<{ rowIndex: number; length: number; expected: number }>;
  parseErrors: Array<{ row?: number; code: string; message: string }>;
  blankRowsCount: number;
}

export interface ParsedCsvResult {
  rows: string[][];
  diagnostics: CsvParseDiagnostics;
}

export function stripUtf8Bom(text: string): { clean: string; hadBom: boolean } {
  if (text.startsWith('\uFEFF')) {
    return { clean: text.slice(1), hadBom: true };
  }
  return { clean: text, hadBom: false };
}

export function detectLineEnding(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

export function parseCsvSafe(rawText: string, explicitDelimiter?: string): ParsedCsvResult {
  const { clean, hadBom } = stripUtf8Bom(rawText);
  const lineEnding = detectLineEnding(clean);

  if (new TextEncoder().encode(clean).length > CSV_MAX_BYTES) {
    throw new Error(`CSV exceeds maximum supported size (${(CSV_MAX_BYTES / (1024 * 1024)).toFixed(0)} MiB).`);
  }

  const parsed = Papa.parse<string[]>(clean, {
    delimiter: explicitDelimiter || '',
    header: false,
    dynamicTyping: false,
    skipEmptyLines: false,
  });

  const rows: string[][] = Array.isArray(parsed.data)
    ? parsed.data.map((r) => (Array.isArray(r) ? r.map((c) => (c == null ? '' : String(c))) : []))
    : [];

  // Trim a single trailing empty row caused by a final newline, while tracking genuine internal blank rows
  if (rows.length > 1) {
    const last = rows[rows.length - 1];
    if (last.length === 1 && last[0] === '' && clean.endsWith('\n')) {
      rows.pop();
    }
  }

  if (rows.length > CSV_MAX_ROWS) {
    throw new Error(`CSV has ${rows.length} rows, exceeding the ${CSV_MAX_ROWS} row limit.`);
  }

  const expectedCols = rows.length > 0 ? rows[0].length : 0;
  if (expectedCols > CSV_MAX_COLS) {
    throw new Error(`CSV has ${expectedCols} columns, exceeding the ${CSV_MAX_COLS} column limit.`);
  }

  const inconsistentRowWidths: Array<{ rowIndex: number; length: number; expected: number }> = [];
  let blankRowsCount = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (r.length === 1 && r[0] === '') {
      blankRowsCount += 1;
    }
    if (expectedCols > 0 && r.length !== expectedCols) {
      inconsistentRowWidths.push({ rowIndex: i, length: r.length, expected: expectedCols });
    }
    if (r.length > CSV_MAX_COLS) {
      throw new Error(`Row ${i + 1} has ${r.length} columns, exceeding ${CSV_MAX_COLS}.`);
    }
  }

  const parseErrors = (parsed.errors || []).map((e) => ({
    row: e.row,
    code: e.code || 'ParseError',
    message: e.message || 'CSV parsing error',
  }));

  return {
    rows,
    diagnostics: {
      hadBom,
      delimiter: parsed.meta?.delimiter || explicitDelimiter || ',',
      lineEnding,
      rowCount: rows.length,
      columnCount: expectedCols,
      inconsistentRowWidths,
      parseErrors,
      blankRowsCount,
    },
  };
}
