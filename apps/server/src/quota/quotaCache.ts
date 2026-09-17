import type {
  QuotaProviderKind,
  QuotaProviderSnapshot,
  QuotaSnapshotInput,
} from "@t3tools/contracts";

export const QUOTA_SUCCESS_CACHE_MS = 2 * 60_000;
export const QUOTA_MANUAL_REFRESH_MIN_MS = 30_000;
export const QUOTA_DEFAULT_RATE_LIMIT_MS = 10 * 60_000;
export const QUOTA_MIN_RATE_LIMIT_MS = 5 * 60_000;

export interface QuotaCacheEntry {
  readonly snapshot: QuotaProviderSnapshot;
  readonly validUntilMs: number;
  readonly lastRequestAtMs: number;
  readonly rateLimitedUntilMs: number;
}

/**
 * A refresh limited to some providers leaves the rest on their normal cache, so
 * refreshing one panel row never drags a slow or rate-limited provider along.
 */
export function shouldRefreshProvider(
  input: QuotaSnapshotInput,
  provider: QuotaProviderKind,
): boolean {
  if (input.refresh !== true) return false;
  return input.providers === undefined || input.providers.includes(provider);
}

export function shouldUseCachedSnapshot(input: {
  readonly cached: QuotaCacheEntry | undefined;
  readonly nowMs: number;
  readonly refresh: boolean;
}): boolean {
  const cached = input.cached;
  if (cached === undefined) return false;
  if (input.nowMs < cached.rateLimitedUntilMs) return true;
  return input.refresh
    ? input.nowMs < cached.lastRequestAtMs + QUOTA_MANUAL_REFRESH_MIN_MS
    : input.nowMs < cached.validUntilMs;
}

export function parseRetryAfterMs(value: string | undefined, nowMs: number): number {
  if (value === undefined || value.trim().length === 0) {
    return QUOTA_DEFAULT_RATE_LIMIT_MS;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.max(seconds * 1000, QUOTA_MIN_RATE_LIMIT_MS);
  }
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.max(dateMs - nowMs, QUOTA_MIN_RATE_LIMIT_MS);
  }
  return QUOTA_DEFAULT_RATE_LIMIT_MS;
}
