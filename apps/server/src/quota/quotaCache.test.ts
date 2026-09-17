import { describe, expect, it } from "@effect/vitest";

import { emptyProviderSnapshot } from "@t3tools/shared/quotaParse";

import {
  parseRetryAfterMs,
  shouldRefreshProvider,
  QUOTA_DEFAULT_RATE_LIMIT_MS,
  QUOTA_MIN_RATE_LIMIT_MS,
  shouldUseCachedSnapshot,
  type QuotaCacheEntry,
} from "./quotaCache.ts";

const nowMs = Date.parse("2026-08-11T16:00:00.000Z");

function entry(overrides: Partial<QuotaCacheEntry> = {}): QuotaCacheEntry {
  return {
    snapshot: emptyProviderSnapshot("claude", "ok", "", {
      fetchedAt: "2026-08-11T15:59:00.000Z",
      windows: [
        {
          id: "five_hour",
          label: "5-hour limit",
          remainingPercent: 80,
          resetsAt: "2026-08-11T20:00:00.000Z",
          durationMinutes: 300,
        },
      ],
    }),
    validUntilMs: nowMs + 120_000,
    lastRequestAtMs: nowMs - 10_000,
    rateLimitedUntilMs: 0,
    ...overrides,
  };
}

describe("shouldRefreshProvider", () => {
  it("forces only the named providers", () => {
    expect(shouldRefreshProvider({}, "claude")).toBe(false);
    expect(shouldRefreshProvider({ providers: ["claude"] }, "claude")).toBe(false);
    expect(shouldRefreshProvider({ refresh: true }, "cursor")).toBe(true);
    expect(shouldRefreshProvider({ refresh: true, providers: ["claude"] }, "claude")).toBe(true);
    expect(shouldRefreshProvider({ refresh: true, providers: ["claude"] }, "codex")).toBe(false);
    expect(shouldRefreshProvider({ refresh: true, providers: [] }, "claude")).toBe(false);
  });
});

describe("shouldUseCachedSnapshot", () => {
  it("reuses a fresh snapshot and honors manual refresh cooldown", () => {
    expect(shouldUseCachedSnapshot({ cached: undefined, nowMs, refresh: false })).toBe(false);
    expect(shouldUseCachedSnapshot({ cached: entry(), nowMs, refresh: false })).toBe(true);
    expect(shouldUseCachedSnapshot({ cached: entry(), nowMs, refresh: true })).toBe(true);
    expect(
      shouldUseCachedSnapshot({
        cached: entry({ lastRequestAtMs: nowMs - 31_000 }),
        nowMs,
        refresh: true,
      }),
    ).toBe(false);
  });

  it("keeps a rate-limited snapshot visible", () => {
    expect(
      shouldUseCachedSnapshot({
        cached: entry({ rateLimitedUntilMs: nowMs + 60_000 }),
        nowMs,
        refresh: true,
      }),
    ).toBe(true);
  });
});

describe("parseRetryAfterMs", () => {
  it("honors Retry-After seconds with a minimum cooldown", () => {
    expect(parseRetryAfterMs("12", nowMs)).toBe(QUOTA_MIN_RATE_LIMIT_MS);
    expect(parseRetryAfterMs("900", nowMs)).toBe(900_000);
    expect(parseRetryAfterMs(undefined, nowMs)).toBe(QUOTA_DEFAULT_RATE_LIMIT_MS);
  });
});
