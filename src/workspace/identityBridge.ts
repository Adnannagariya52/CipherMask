import type { EntityType } from '../engine/types.ts';
import type { SemanticCategory } from '../intelligence/schemas.ts';

export interface IdentityBridgeEntry {
  token: string;
  type: EntityType | SemanticCategory | string;
  canonicalKey: string;
  /** Latest original string observed in session RAM (never serialized into outbound/audit payloads). */
  latestOriginal: string;
  occurrenceCount: number;
  sourceIds: string[];
}

export interface LocalRestorationProjection {
  restoredText: string;
  restoredCount: number;
  unknownPlaceholders: string[];
}

function makeSessionSuffix(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buf = new Uint8Array(2);
    crypto.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, '0');
}

const TOKEN_PREFIX_MAP: Record<string, string> = {
  EMAIL: 'EMAIL',
  PHONE: 'PHONE',
  IPV4: 'IP',
  IPV6: 'IP',
  PAN: 'PAN',
  AADHAAR: 'AADHAAR',
  CARD: 'CARD',
  PERSON: 'PERSON',
  LOCATION: 'LOC',
  ORGANIZATION: 'ORG',
  ADDRESS: 'ADDR',
  DATE_OF_BIRTH: 'DOB',
  PERSONAL_ID: 'ID',
  HEALTH_CONTEXT: 'HEALTH',
  FINANCIAL_CONTEXT: 'FIN',
  EMPLOYMENT_CONTEXT: 'EMP',
  SECRET_CREDENTIAL: 'SECRET',
  OTHER_SENSITIVE: 'SENSITIVE',
  CONTEXT_ID: 'CTX',
  MANUAL: 'ENTITY',
};

/**
 * Conversation-scoped volatile Identity Bridge.
 * Generates collision-resistant placeholders (`[[CM_EMAIL_01_a9f2]]`) shared across prompt, TXT, CSV, and OCR
 * inside one conversation without leaking mappings or restored text to any cloud endpoint.
 */
export class IdentityBridgeRegistry {
  readonly conversationId: string;
  private readonly sessionSuffix: string;
  private readonly bucketToToken = new Map<string, string>();
  private readonly tokenToEntry = new Map<string, IdentityBridgeEntry>();
  private readonly counters = new Map<string, number>();

  constructor(conversationId: string) {
    this.conversationId = conversationId;
    this.sessionSuffix = makeSessionSuffix();
  }

  private bucketKey(type: string, canonicalKey: string): string {
    const group = type === 'IPV4' || type === 'IPV6' ? `IP:${type}` : type;
    return `${group}::${canonicalKey}`;
  }

  allocateOrGet(
    type: string,
    canonicalKey: string,
    originalSlice: string,
    sourceId: string,
    forbiddenText = '',
  ): string {
    const bKey = this.bucketKey(type, canonicalKey);
    const existingTok = this.bucketToToken.get(bKey);
    if (existingTok) {
      const entry = this.tokenToEntry.get(existingTok)!;
      entry.occurrenceCount += 1;
      if (!entry.sourceIds.includes(sourceId)) {
        entry.sourceIds.push(sourceId);
      }
      return existingTok;
    }

    const prefix = TOKEN_PREFIX_MAP[type] || 'ENTITY';
    let nextNum = (this.counters.get(prefix) ?? 0) + 1;
    let candidate = `[[CM_${prefix}_${String(nextNum).padStart(2, '0')}_${this.sessionSuffix}]]`;
    while (this.tokenToEntry.has(candidate) || (forbiddenText && forbiddenText.includes(candidate))) {
      nextNum += 1;
      candidate = `[[CM_${prefix}_${String(nextNum).padStart(2, '0')}_${this.sessionSuffix}]]`;
    }
    this.counters.set(prefix, nextNum);

    this.bucketToToken.set(bKey, candidate);
    this.tokenToEntry.set(candidate, {
      token: candidate,
      type,
      canonicalKey,
      latestOriginal: originalSlice,
      occurrenceCount: 1,
      sourceIds: [sourceId],
    });
    return candidate;
  }

  getAllKnownOriginals(): string[] {
    return Array.from(this.tokenToEntry.values())
      .map((e) => e.latestOriginal)
      .filter((s) => s.length >= 3);
  }

  getEntries(): IdentityBridgeEntry[] {
    return Array.from(this.tokenToEntry.values());
  }

  size(): number {
    return this.tokenToEntry.size;
  }

  clear(): void {
    this.bucketToToken.clear();
    this.tokenToEntry.clear();
    this.counters.clear();
  }
}

const PLACEHOLDER_SCAN_RE = /\[\[CM_[A-Z0-9_]+_[0-9]{2,4}_[0-9a-f]{4}\]\]/g;

/**
 * Produces a separate local-only restored display projection from an immutable assistant response.
 * Exact token matches only; unknown placeholders stay intact and are flagged.
 */
export function restoreKnownPlaceholders(
  responseText: string,
  registry: IdentityBridgeRegistry,
): LocalRestorationProjection {
  const entries = new Map(registry.getEntries().map((e) => [e.token, e]));
  const unknownSet = new Set<string>();
  let restoredCount = 0;

  const restoredText = responseText.replace(PLACEHOLDER_SCAN_RE, (match) => {
    const entry = entries.get(match);
    if (!entry) {
      unknownSet.add(match);
      return match;
    }
    restoredCount += 1;
    return entry.latestOriginal;
  });

  return {
    restoredText,
    restoredCount,
    unknownPlaceholders: Array.from(unknownSet),
  };
}
