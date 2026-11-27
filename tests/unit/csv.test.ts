import { describe, it, expect } from 'vitest';
import { parseCsvSafe } from '../../src/engine/csv/parse.ts';
import { inspectCsvFormulas, serializeCsvSafe } from '../../src/engine/csv/serialize.ts';
import { redactCsvRows, suggestColumnRoles } from '../../src/engine/csv/classify.ts';
import { assessKAnonymity } from '../../src/engine/csv/risk.ts';
import {
  applyColumnTransformsToRows,
  inferColumnTransformKind,
  optimizeGeneralizationPolicy,
} from '../../src/engine/csv/optimizer.ts';
import { createDefaultPolicy } from '../../src/engine/redaction.ts';
import { SAMPLE_CSV_EDGE, SAMPLE_CSV_RISK } from '../../src/fixtures/samples.ts';

describe('CSV Parsing & Serialization', () => {
  it('preserves multiline cells, escaped quotes, leading zeros, duplicate headers, and blank fields', () => {
    const parsed = parseCsvSafe(`\uFEFF${SAMPLE_CSV_EDGE}`);
    expect(parsed.diagnostics.hadBom).toBe(true);
    expect(parsed.rows.length).toBe(3); // header + 2 data rows
    expect(parsed.rows[0]).toEqual(['Postal_Code', 'Email', 'Email', 'Notes']);
    expect(parsed.rows[1][0]).toBe('00412'); // leading zeros preserved!
    expect(parsed.rows[1][3]).toContain('Line one\nLine two with "escaped" quotes, and comma');
    expect(parsed.rows[2][2]).toBe('');

    const reserialized = serializeCsvSafe(parsed.rows, { delimiter: ',', lineEnding: '\n' });
    const reparsed = parseCsvSafe(reserialized);
    expect(reparsed.rows).toEqual(parsed.rows);
  });

  it('detects formula prefixes and optionally escapes them safely', () => {
    const rows = [
      ['Name', 'Note'],
      ['Alice', '=CMD()'],
      ['Bob', '+123'],
    ];
    const check = inspectCsvFormulas(rows);
    expect(check.formulaCellCount).toBe(2);

    const safeOut = serializeCsvSafe(rows, { spreadsheetSafeEscape: true });
    expect(safeOut).toContain("'=CMD()");
    expect(safeOut).toContain("'+123");
  });
});

describe('CSV Redaction, K-Anonymity Risk & Optimizer', () => {
  it('assigns consistent pseudonyms across repeated rows and detects unique QI combinations', () => {
    const parsed = parseCsvSafe(SAMPLE_CSV_RISK);
    const cols = suggestColumnRoles(parsed.rows, true);
    const policy = createDefaultPolicy('RESEARCH');
    const redacted = redactCsvRows(parsed.rows, true, cols, policy, true);

    // Row 1 and Row 14 share Aarav Mehta, email, & phone, while Employee_IDs EMP-101 vs EMP-114 are distinct
    expect(redacted.sanitizedRows[1][1]).toBe(redacted.sanitizedRows[14][1]); // Name pseudonym matches
    expect(redacted.sanitizedRows[1][2]).toBe(redacted.sanitizedRows[14][2]); // Email pseudonym matches
    expect(redacted.sanitizedRows[1][3]).toBe(redacted.sanitizedRows[14][3]); // Phone pseudonym matches
    expect(redacted.sanitizedRows[1][0]).not.toBe(redacted.sanitizedRows[14][0]); // EMP-101 vs EMP-114 distinct

    const dataRows = redacted.sanitizedRows.slice(1);
    // QIs: Age (4), City (5), Occupation (6)
    const qiIndices = [4, 5, 6];
    const beforeRisk = assessKAnonymity(dataRows, qiIndices, 2);
    expect(beforeRisk.applicable).toBe(true);
    expect(beforeRisk.kMin).toBe(1);
    expect(beforeRisk.singletonRows).toBeGreaterThan(0);
    expect(beforeRisk.rowsBelowTarget).toBeGreaterThan(0);

    // Run optimizer for targetK = 2
    const configs = qiIndices.map((colIdx) => ({
      columnIndex: colIdx,
      columnLabel: cols[colIdx].headerLabel,
      kind: inferColumnTransformKind(
        cols[colIdx].headerLabel,
        dataRows.map((r) => r[colIdx]),
      ),
      importanceWeight: 1,
      allowSuppression: true,
    }));

    const opt = optimizeGeneralizationPolicy({
      dataRows,
      configs,
      targetK: 2,
      searchBudget: 600,
    });

    expect(opt.searchExhaustive).toBe(true);
    expect(opt.bestPolicy).not.toBeNull();
    expect(opt.bestPolicy!.feasible).toBe(true);
    expect(opt.bestPolicy!.allSuppressedDegenerate).toBe(false);
    expect(opt.bestPolicy!.assessment.kMin).toBeGreaterThanOrEqual(2);
    expect(opt.bestPolicy!.assessment.singletonRows).toBe(0);

    const generalizedRows = applyColumnTransformsToRows(dataRows, opt.bestPolicy!.transformsByColumn);
    expect(generalizedRows.length).toBe(dataRows.length); // Zero silent row drops
  });

  it('handles edge cases: empty rows, no QIs, and targetK > N', () => {
    const emptyRisk = assessKAnonymity([], [0], 2);
    expect(emptyRisk.applicable).toBe(false);
    expect(emptyRisk.kMin).toBeNull();

    const noQiRisk = assessKAnonymity([['30', 'Pune']], [], 2);
    expect(noQiRisk.applicable).toBe(false);

    const impossibleRisk = assessKAnonymity([['30', 'Pune'], ['32', 'Pune']], [0, 1], 5);
    expect(impossibleRisk.targetImpossible).toBe(true);
    expect(impossibleRisk.kMin).toBe(1);
  });
});
