import Papa from 'papaparse';

const FORMULA_PREFIX_RE = /^[=+\-@\t\r]/;

export interface FormulaInspection {
  formulaCellCount: number;
  sampleLocations: Array<{ row: number; col: number }>;
}

export function inspectCsvFormulas(rows: string[][]): FormulaInspection {
  let formulaCellCount = 0;
  const sampleLocations: Array<{ row: number; col: number }> = [];

  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r];
    for (let c = 0; c < row.length; c += 1) {
      const val = row[c];
      if (val && FORMULA_PREFIX_RE.test(val)) {
        formulaCellCount += 1;
        if (sampleLocations.length < 10) {
          sampleLocations.push({ row: r, col: c });
        }
      }
    }
  }

  return { formulaCellCount, sampleLocations };
}

export interface SerializeCsvOptions {
  delimiter?: string;
  lineEnding?: '\r\n' | '\n';
  spreadsheetSafeEscape?: boolean;
}

export function serializeCsvSafe(rows: string[][], options: SerializeCsvOptions = {}): string {
  const delimiter = options.delimiter || ',';
  const newline = options.lineEnding || '\n';
  const safeRows = options.spreadsheetSafeEscape
    ? rows.map((row) =>
        row.map((cell) => (cell && FORMULA_PREFIX_RE.test(cell) ? `'${cell}` : cell)),
      )
    : rows;

  return Papa.unparse(safeRows, {
    delimiter,
    newline,
  });
}
