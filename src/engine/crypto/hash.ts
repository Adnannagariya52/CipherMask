export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

export async function sha256Bytes(data: Uint8Array): Promise<string> {
  if (typeof globalThis.crypto?.subtle?.digest !== 'function') {
    throw new Error('Web Crypto API (subtle.digest) is unavailable in this environment.');
  }
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer);
  return bytesToHex(new Uint8Array(digest));
}

export async function sha256Text(text: string): Promise<{ bytes: Uint8Array; sha256Hex: string }> {
  const bytes = new TextEncoder().encode(text);
  const sha256Hex = await sha256Bytes(bytes);
  return { bytes, sha256Hex };
}
