export const VAULT_MAX_ENVELOPE_BYTES = 10 * 1024 * 1024;
export const VAULT_DEFAULT_ITERATIONS = 600_000;
export const VAULT_MIN_ITERATIONS = 100_000;
export const VAULT_MAX_ITERATIONS = 1_000_000;

export interface VaultOccurrenceRecord {
  type: string;
  token: string;
  originalSlice: string;
  outStart: number;
  outEnd: number;
  row?: number;
  column?: number;
  cellStart?: number;
  cellEnd?: number;
}

export interface VaultPayload {
  schemaVersion: 1;
  format: 'text' | 'csv';
  sanitizedSha256: string;
  csvDelimiter?: string;
  csvLineEnding?: '\n' | '\r\n';
  records: VaultOccurrenceRecord[];
}

export interface EncryptedVaultEnvelope {
  version: 1;
  algorithm: 'AES-GCM';
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function buildAdditionalData(meta: {
  version: number;
  algorithm: string;
  kdf: string;
  iterations: number;
  salt: string;
  iv: string;
}): ArrayBuffer {
  const canonical = `${meta.version}|${meta.algorithm}|${meta.kdf}|${meta.iterations}|${meta.salt}|${meta.iv}`;
  return toArrayBuffer(new TextEncoder().encode(canonical));
}

async function deriveAesKey(passphrase: string, salt: Uint8Array, iterations: number, usage: KeyUsage[]): Promise<CryptoKey> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto API is unavailable (requires localhost or HTTPS secure context).');
  }
  const passBytes = new TextEncoder().encode(passphrase);
  const baseKey = await crypto.subtle.importKey('raw', toArrayBuffer(passBytes), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: toArrayBuffer(salt),
      iterations,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    usage,
  );
}

export async function encryptVaultPayload(
  payload: VaultPayload,
  passphrase: string,
  iterations = VAULT_DEFAULT_ITERATIONS,
): Promise<EncryptedVaultEnvelope> {
  if (!passphrase || passphrase.length < 8) {
    throw new Error('Passphrase must be at least 8 characters long.');
  }
  if (iterations < VAULT_MIN_ITERATIONS || iterations > VAULT_MAX_ITERATIONS) {
    throw new Error(`Iterations must be between ${VAULT_MIN_ITERATIONS} and ${VAULT_MAX_ITERATIONS}.`);
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const saltB64 = toBase64(salt);
  const ivB64 = toBase64(iv);

  const key = await deriveAesKey(passphrase, salt, iterations, ['encrypt']);
  const aad = buildAdditionalData({
    version: 1,
    algorithm: 'AES-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: saltB64,
    iv: ivB64,
  });

  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: aad, tagLength: 128 },
    key,
    toArrayBuffer(plaintext),
  );

  return {
    version: 1,
    algorithm: 'AES-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: saltB64,
    iv: ivB64,
    ciphertext: toBase64(new Uint8Array(cipherBuffer)),
  };
}

export function validateVaultEnvelope(rawJson: string): EncryptedVaultEnvelope {
  if (new TextEncoder().encode(rawJson).length > VAULT_MAX_ENVELOPE_BYTES) {
    throw new Error('Vault file exceeds maximum allowed size (10 MiB).');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error('Invalid vault JSON format.');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid vault envelope structure.');
  }
  const env = parsed as Record<string, unknown>;
  if (env.version !== 1) throw new Error(`Unsupported vault version: ${String(env.version)}`);
  if (env.algorithm !== 'AES-GCM') throw new Error(`Unsupported vault algorithm: ${String(env.algorithm)}`);
  if (env.kdf !== 'PBKDF2-SHA256') throw new Error(`Unsupported vault KDF: ${String(env.kdf)}`);
  if (
    typeof env.iterations !== 'number' ||
    !Number.isInteger(env.iterations) ||
    env.iterations < VAULT_MIN_ITERATIONS ||
    env.iterations > VAULT_MAX_ITERATIONS
  ) {
    throw new Error('Vault iteration count is outside allowed safety bounds.');
  }
  if (typeof env.salt !== 'string' || typeof env.iv !== 'string' || typeof env.ciphertext !== 'string') {
    throw new Error('Vault envelope missing required cryptographic fields.');
  }
  const saltBytes = fromBase64(env.salt);
  const ivBytes = fromBase64(env.iv);
  const cipherBytes = fromBase64(env.ciphertext);
  if (saltBytes.length !== 16) throw new Error('Invalid vault salt length.');
  if (ivBytes.length !== 12) throw new Error('Invalid vault IV length.');
  if (cipherBytes.length < 16) throw new Error('Invalid vault ciphertext.');

  return {
    version: 1,
    algorithm: 'AES-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations: env.iterations,
    salt: env.salt,
    iv: env.iv,
    ciphertext: env.ciphertext,
  };
}

export async function decryptVaultEnvelope(
  rawEnvelopeJson: string,
  passphrase: string,
): Promise<VaultPayload> {
  const env = validateVaultEnvelope(rawEnvelopeJson);
  const salt = fromBase64(env.salt);
  const iv = fromBase64(env.iv);
  const ciphertext = fromBase64(env.ciphertext);

  const key = await deriveAesKey(passphrase, salt, env.iterations, ['decrypt']);
  const aad = buildAdditionalData(env);

  let plainBuffer: ArrayBuffer;
  try {
    plainBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: aad, tagLength: 128 },
      key,
      toArrayBuffer(ciphertext),
    );
  } catch {
    throw new Error('Decryption failed: incorrect passphrase or tampered vault file.');
  }

  const decoded = new TextDecoder().decode(plainBuffer);
  const payload = JSON.parse(decoded) as VaultPayload;
  if (
    !payload ||
    payload.schemaVersion !== 1 ||
    (payload.format !== 'text' && payload.format !== 'csv') ||
    typeof payload.sanitizedSha256 !== 'string' ||
    !Array.isArray(payload.records)
  ) {
    throw new Error('Decrypted vault payload failed schema validation.');
  }
  return payload;
}
