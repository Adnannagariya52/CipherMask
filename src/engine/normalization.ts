/**
 * Unicode-safe normalization with exact UTF-16 [start, end) offset mapping.
 * Never mutates the original string; maps any normalized span back to the
 * smallest covering original UTF-16 interval.
 */

export interface NormalizedView {
  original: string;
  normalized: string;
  /** Original UTF-16 start (inclusive) for each code unit in `normalized`. */
  origStart: number[];
  /** Original UTF-16 end (exclusive) for each code unit in `normalized`. */
  origEnd: number[];
  /** True if any normalization rule changed or stripped characters inside the range. */
  wasTransformed: boolean;
}

const INVISIBLE_CODEPOINTS = new Set([
  0x00ad, // Soft hyphen
  0x034f, // Combining grapheme joiner
  0x061c, // Arabic letter mark
  0x180e, // Mongolian vowel separator
  0x200b, // Zero width space
  0x200c, // Zero width non-joiner
  0x200d, // Zero width joiner
  0x200e, // Left-to-right mark
  0x200f, // Right-to-left mark
  0x202a,
  0x202b,
  0x202c,
  0x202d,
  0x202e,
  0x2060, // Word joiner
  0x2061,
  0x2062,
  0x2063,
  0x2064,
  0xfeff, // BOM / ZWNBSP
]);

const SPACE_LIKE_CODEPOINTS = new Set([
  0x00a0, // NBSP
  0x1680,
  0x2000,
  0x2001,
  0x2002,
  0x2003,
  0x2004,
  0x2005,
  0x2006,
  0x2007,
  0x2008,
  0x2009,
  0x200a,
  0x202f,
  0x205f,
  0x3000,
]);

function mapCodePoint(cp: number): string | null {
  if (INVISIBLE_CODEPOINTS.has(cp)) {
    return null; // Strip invisible char
  }
  if (SPACE_LIKE_CODEPOINTS.has(cp)) {
    return ' ';
  }
  // Fullwidth ASCII ! .. ~
  if (cp >= 0xff01 && cp <= 0xff5e) {
    return String.fromCharCode(cp - 0xfee0);
  }
  // Ideographic full stop / fullwidth hyphen-minus variants
  if (cp === 0x3002) return '.';
  if (cp === 0x2010 || cp === 0x2011 || cp === 0x2012 || cp === 0x2013 || cp === 0x2014 || cp === 0x2212) {
    return '-';
  }
  // Arabic-Indic digits 0660..0669
  if (cp >= 0x0660 && cp <= 0x0669) {
    return String.fromCharCode(48 + (cp - 0x0660));
  }
  // Extended Arabic-Indic digits 06F0..06F9
  if (cp >= 0x06f0 && cp <= 0x06f9) {
    return String.fromCharCode(48 + (cp - 0x06f0));
  }
  // Devanagari digits 0966..096F
  if (cp >= 0x0966 && cp <= 0x096f) {
    return String.fromCharCode(48 + (cp - 0x0966));
  }
  return String.fromCodePoint(cp);
}

export function buildNormalizedView(original: string): NormalizedView {
  const chars: string[] = [];
  const origStart: number[] = [];
  const origEnd: number[] = [];
  let wasTransformed = false;

  for (let i = 0; i < original.length; ) {
    const cp = original.codePointAt(i)!;
    const unitLen = cp > 0xffff ? 2 : 1;
    const end = i + unitLen;
    const mapped = mapCodePoint(cp);

    if (mapped === null) {
      wasTransformed = true;
    } else {
      const origSlice = original.slice(i, end);
      if (mapped !== origSlice) {
        wasTransformed = true;
      }
      for (let k = 0; k < mapped.length; k += 1) {
        chars.push(mapped[k]);
        origStart.push(i);
        origEnd.push(end);
      }
    }
    i = end;
  }

  return {
    original,
    normalized: chars.join(''),
    origStart,
    origEnd,
    wasTransformed,
  };
}

/**
 * Maps a [normStart, normEnd) span on `view.normalized` back to original UTF-16 [start, end).
 */
export function mapNormalizedSpanToOriginal(
  view: NormalizedView,
  normStart: number,
  normEnd: number,
): { start: number; end: number } | null {
  if (normStart < 0 || normEnd <= normStart || normEnd > view.origEnd.length) {
    return null;
  }
  const start = view.origStart[normStart];
  const end = view.origEnd[normEnd - 1];
  if (start === undefined || end === undefined || end <= start) {
    return null;
  }
  return { start, end };
}

/**
 * Checks whether the original slice differs from the normalized slice (e.g., contained invisible chars or Unicode digits).
 */
export function spanRequiredNormalization(view: NormalizedView, normStart: number, normEnd: number): boolean {
  const mapped = mapNormalizedSpanToOriginal(view, normStart, normEnd);
  if (!mapped) return false;
  return view.original.slice(mapped.start, mapped.end) !== view.normalized.slice(normStart, normEnd);
}
