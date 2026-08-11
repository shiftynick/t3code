import { describe, expect, it } from "@effect/vitest";

import { formatQuotaReset, formatRemainingPercent } from "./quotaFormat.ts";

describe("formatRemainingPercent", () => {
  it("rounds and clamps", () => {
    expect(formatRemainingPercent(77.4)).toBe("77%");
    expect(formatRemainingPercent(-4)).toBe("0%");
    expect(formatRemainingPercent(140)).toBe("100%");
  });
});

describe("formatQuotaReset", () => {
  const now = Date.parse("2026-08-11T16:00:00.000Z");

  it("uses a short remaining window", () => {
    expect(formatQuotaReset("2026-08-11T16:40:00.000Z", now)).toBe("resets in 40m");
    expect(formatQuotaReset("2026-08-11T21:00:00.000Z", now)).toBe("resets in 5h");
    expect(formatQuotaReset("2026-08-13T16:00:00.000Z", now)).toBe("resets in 2d");
  });

  it("falls back to a calendar day for longer windows", () => {
    expect(formatQuotaReset("2026-08-20T18:00:00.000Z", now)).toBe("resets Aug 20");
  });
});
