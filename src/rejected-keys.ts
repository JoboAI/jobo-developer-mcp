/**
 * API keys the Jobo API has just refused, remembered for a minute.
 *
 * The hosted server calls the API from inside the cluster, and the API blocks
 * an address for five minutes after 60 refused keys in five minutes
 * (`UnauthenticatedThrottleMiddleware`). One client looping on a revoked key
 * would spend that budget for everyone who comes through this server. So a
 * refused key is answered here, with the API's own refusal, until it is
 * forgotten: a key fixed in the client works again within a minute, and a
 * key that stays wrong reaches the API about once a minute instead of on
 * every call.
 *
 * Only a SHA-256 hash of each key is kept, never the key, and only in this
 * process. Bounded in size, so a flood of made-up keys cannot grow it.
 */

import { createHash } from "node:crypto";

/** How long a refused key is answered locally. */
export const REJECTED_KEY_TTL_MS = 60 * 1000;
/** The most keys remembered at once; the oldest is forgotten first. */
export const REJECTED_KEY_MAX_ENTRIES = 10_000;

/** What is stored for a key: its SHA-256, hex. Never the key. */
export function keyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

interface Rejection {
  expires: number;
  /** The API's answer, which names no key: replayed so a repeat reads the same. */
  body: string;
}

export class RejectedKeys {
  /** Hash → rejection. A Map keeps insertion order, so the first key is the oldest. */
  private readonly entries = new Map<string, Rejection>();

  constructor(
    private readonly ttlMs: number = REJECTED_KEY_TTL_MS,
    private readonly maxEntries: number = REJECTED_KEY_MAX_ENTRIES,
    private readonly now: () => number = Date.now,
  ) {}

  remember(key: string, body: string): void {
    const hash = keyHash(key);
    this.entries.delete(hash);
    this.entries.set(hash, { expires: this.now() + this.ttlMs, body });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** The API's refusal of this key, while it is remembered; undefined otherwise. */
  rejection(key: string): string | undefined {
    const hash = keyHash(key);
    const entry = this.entries.get(hash);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) {
      this.entries.delete(hash);
      return undefined;
    }
    return entry.body;
  }

  get size(): number {
    return this.entries.size;
  }

  /** The stored keys, for tests that check no raw API key is held. */
  storedKeys(): string[] {
    return [...this.entries.keys()];
  }

  clear(): void {
    this.entries.clear();
  }
}

/** The one store every lookup shares. */
export const rejectedKeys = new RejectedKeys();
