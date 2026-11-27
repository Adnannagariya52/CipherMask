import type { EntityType } from './types.ts';

const TOKEN_PREFIX: Record<EntityType, string> = {
  EMAIL: 'EMAIL',
  PHONE: 'PHONE',
  IPV4: 'IP',
  IPV6: 'IP',
  PAN: 'PAN',
  AADHAAR: 'AADHAAR',
  CARD: 'CARD',
  PERSON: 'PERSON',
  LOCATION: 'LOCATION',
  ORGANIZATION: 'ORG',
  CONTEXT_ID: 'CTX_ID',
  FACE: 'FACE',
  PERSON_REGION: 'PERSON_REGION',
  QR: 'QR',
  BARCODE: 'BARCODE',
  METADATA: 'METADATA',
  MANUAL: 'REDACTED',
};

/**
 * Volatile in-memory pseudonym allocator for the current document session.
 * Guarantees:
 * - Same (typeGroup + canonicalKey) maps to the same deterministic token across occurrences/cells.
 * - Collision-safe against preexisting literal tokens in the source text.
 * - Distinct canonical values receive distinct token numbers.
 */
export class SessionPseudonymAllocator {
  private readonly map = new Map<string, string>();
  private readonly counters = new Map<string, number>();
  private readonly forbiddenTokens: Set<string>;

  constructor(sourceText = '') {
    this.forbiddenTokens = new Set<string>();
    if (sourceText) {
      const existing = sourceText.match(/\b[A-Z_]+_\d{2,4}\b/g);
      if (existing) {
        for (const tok of existing) {
          this.forbiddenTokens.add(tok);
        }
      }
    }
  }

  private getPrefix(type: EntityType): string {
    return TOKEN_PREFIX[type] || 'ENTITY';
  }

  private getBucketKey(type: EntityType, canonicalKey: string): string {
    // Keep IPv4 and IPv6 tokens cleanly typed under IP_xx while keeping canonical key separate
    const group = type === 'IPV4' || type === 'IPV6' ? `IP:${type}` : type;
    return `${group}::${canonicalKey}`;
  }

  allocate(type: EntityType, canonicalKey: string): string {
    const bucketKey = this.getBucketKey(type, canonicalKey);
    const existing = this.map.get(bucketKey);
    if (existing) return existing;

    const prefix = this.getPrefix(type);
    let nextNum = (this.counters.get(prefix) ?? 0) + 1;
    let candidate = `${prefix}_${String(nextNum).padStart(2, '0')}`;
    while (this.forbiddenTokens.has(candidate)) {
      nextNum += 1;
      candidate = `${prefix}_${String(nextNum).padStart(2, '0')}`;
    }
    this.counters.set(prefix, nextNum);
    this.forbiddenTokens.add(candidate);
    this.map.set(bucketKey, candidate);
    return candidate;
  }

  size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
    this.counters.clear();
    this.forbiddenTokens.clear();
  }
}
