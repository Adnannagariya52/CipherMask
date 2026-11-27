import { describe, it, expect } from 'vitest';
import { clampRect, clientToCanonicalPixel, padRect, scaleRectFromInference, unionRects } from '../../src/engine/vision/geometry.ts';
import { detectImageSignature } from '../../src/engine/vision/decode.ts';
import { scanPngTextChunks } from '../../src/engine/vision/metadata.ts';
import { chunkTextUnicodeSafe } from '../../src/engine/ner/chunking.ts';

describe('Vision Geometry, Signatures & Metadata', () => {
  it('clamps, pads, unions, and converts client coordinates accurately', () => {
    expect(clampRect({ x: -10, y: 5, width: 50, height: 100 }, 100, 80)).toEqual({
      x: 0,
      y: 5,
      width: 40,
      height: 75,
    });

    expect(padRect({ x: 10, y: 10, width: 20, height: 20 }, 5, 5, 100, 100)).toEqual({
      x: 5,
      y: 5,
      width: 30,
      height: 30,
    });

    expect(
      unionRects([
        { x: 10, y: 20, width: 30, height: 10 },
        { x: 25, y: 15, width: 20, height: 25 },
      ]),
    ).toEqual({ x: 10, y: 15, width: 35, height: 25 });

    // Letterboxed 200x100 image inside 400x400 element (scale=2, offsetX=0, offsetY=100)
    const pt = clientToCanonicalPixel(200, 200, { left: 0, top: 0, width: 400, height: 400 }, 200, 100);
    expect(pt).toEqual({ x: 100, y: 50 });

    const scaled = scaleRectFromInference({ x: 50, y: 25, width: 20, height: 10 }, 0.5, 0.5, 400, 200);
    expect(scaled).toEqual({ x: 100, y: 50, width: 40, height: 20 });
  });

  it('validates PNG and JPEG signatures and detects PNG text chunks', () => {
    const pngSig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const jpgSig = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const badSig = new Uint8Array([0x47, 0x49, 0x46, 0x38]);

    expect(detectImageSignature(pngSig)).toBe('image/png');
    expect(detectImageSignature(jpgSig)).toBe('image/jpeg');
    expect(detectImageSignature(badSig)).toBeNull();

    // Minimal PNG with tEXt chunk before IEND
    const pngWithText = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0, 0, 0, 4, 0x74, 0x45, 0x58, 0x74, 65, 66, 67, 68, 0, 0, 0, 0, // tEXt len=4
      0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0, 0, 0, 0, // IEND
    ]);
    expect(scanPngTextChunks(pngWithText)).toEqual(['tEXt']);
  });

  it('chunks text at Unicode-safe boundaries without splitting surrogate pairs', () => {
    const emojis = '😀'.repeat(30); // 60 UTF-16 code units
    const chunks = chunkTextUnicodeSafe(emojis, 15, 4);
    for (const c of chunks) {
      const firstCode = c.text.charCodeAt(0);
      const lastCode = c.text.charCodeAt(c.text.length - 1);
      expect(firstCode >= 0xdc00 && firstCode <= 0xdfff).toBe(false);
      expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
    }
  });
});
