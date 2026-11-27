export interface TextChunk {
  index: number;
  start: number;
  end: number;
  text: string;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function clampToUnicodeBoundary(text: string, idx: number, direction: 'left' | 'right'): number {
  if (idx <= 0) return 0;
  if (idx >= text.length) return text.length;
  if (isLowSurrogate(text.charCodeAt(idx))) {
    return direction === 'left' ? Math.max(0, idx - 1) : Math.min(text.length, idx + 1);
  }
  return idx;
}

/**
 * Splits text into overlapping Unicode-safe windows so BERT-base-NER (512 tokens)
 * can process long documents while preserving exact global UTF-16 offsets.
 */
export function chunkTextUnicodeSafe(
  text: string,
  maxChars = 1100,
  overlapChars = 150,
): TextChunk[] {
  if (text.length === 0) return [];
  if (text.length <= maxChars) {
    return [{ index: 0, start: 0, end: text.length, text }];
  }

  const chunks: TextChunk[] = [];
  let start = 0;
  let index = 0;

  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars);
    end = clampToUnicodeBoundary(text, end, 'left');

    if (end < text.length) {
      // Prefer breaking cleanly on whitespace within last 180 chars of window
      const searchFrom = Math.max(start + Math.floor(maxChars * 0.6), end - 180);
      for (let i = end; i > searchFrom; i -= 1) {
        if (/\s/.test(text[i])) {
          end = i;
          break;
        }
      }
    }

    if (end <= start) {
      end = clampToUnicodeBoundary(text, Math.min(text.length, start + maxChars), 'right');
    }

    chunks.push({
      index,
      start,
      end,
      text: text.slice(start, end),
    });

    if (end >= text.length) break;
    const nextStart = Math.max(start + 1, end - overlapChars);
    start = clampToUnicodeBoundary(text, nextStart, 'right');
    index += 1;
  }

  return chunks;
}
