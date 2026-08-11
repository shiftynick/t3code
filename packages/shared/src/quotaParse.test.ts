import { describe, expect, it } from "@effect/vitest";

import {
  parseClaudeUsageWindows,
  parseCodexRateLimits,
  parseCursorPeriodUsage,
} from "./quotaParse.ts";

describe("parseClaudeUsageWindows", () => {
  it("maps known windows and ignores spend objects", () => {
    const windows = parseClaudeUsageWindows({
      five_hour: {
        utilization: 22.5,
        resets_at: "2026-07-26T18:00:00Z",
      },
      seven_day: {
        utilization: 41,
        resets_at: "2026-08-01T18:00:00Z",
      },
      extra_usage: {
        amount: 12,
      },
    });

    expect(windows).toEqual([
      {
        id: "five_hour",
        label: "5-hour limit",
        remainingPercent: 77.5,
        resetsAt: "2026-07-26T18:00:00.000Z",
        durationMinutes: 300,
      },
      {
        id: "seven_day",
        label: "7-day limit",
        remainingPercent: 59,
        resetsAt: "2026-08-01T18:00:00.000Z",
        durationMinutes: 10080,
      },
    ]);
  });

  it("adds scoped weekly model limits", () => {
    const windows = parseClaudeUsageWindows({
      limits: [
        {
          percent: 35,
          resets_at: "2026-08-01T18:00:00Z",
          kind: "weekly_model",
          group: "weekly",
          scope: {
            model: {
              id: "example-model",
              display_name: "Opus",
            },
          },
        },
      ],
    });

    expect(windows).toEqual([
      {
        id: "scoped:weekly_model:example-model:1",
        label: "7-day Opus",
        remainingPercent: 65,
        resetsAt: "2026-08-01T18:00:00.000Z",
        durationMinutes: 10080,
      },
    ]);
  });
});

describe("parseCodexRateLimits", () => {
  it("maps primary and secondary windows and drops the default Codex alias", () => {
    const parsed = parseCodexRateLimits({
      rateLimits: {
        planType: "plus",
        primary: {
          usedPercent: 20,
          windowDurationMins: 300,
          resetsAt: 1785092400,
        },
        secondary: {
          usedPercent: 35,
          windowDurationMins: 10080,
          resetsAt: 1785697200,
        },
      },
      rateLimitsByLimitId: {
        example: {
          limitName: "Codex",
          primary: {
            usedPercent: 20,
            windowDurationMins: 300,
            resetsAt: 1785092400,
          },
          secondary: {
            usedPercent: 35,
            windowDurationMins: 10080,
            resetsAt: 1785697200,
          },
        },
      },
    });

    expect(parsed.planLabel).toBe("Plus");
    expect(parsed.windows.map((window) => window.id)).toEqual(["|primary|300", "|secondary|10080"]);
    expect(parsed.windows[0]?.remainingPercent).toBe(80);
    expect(parsed.windows[1]?.remainingPercent).toBe(65);
  });
});

describe("parseCursorPeriodUsage", () => {
  it("maps included, auto, and API windows from plan usage", () => {
    const parsed = parseCursorPeriodUsage(
      {
        billingCycleStart: "1768399334000",
        billingCycleEnd: "1771077734000",
        planUsage: {
          includedSpend: 23222,
          remaining: 16778,
          limit: 40000,
          autoPercentUsed: 10.5,
          apiPercentUsed: 46.444,
          totalPercentUsed: 58.055,
        },
      },
      "ultra",
    );

    expect(parsed.planLabel).toBe("Ultra");
    expect(parsed.windows).toEqual([
      {
        id: "included",
        label: "Included",
        remainingPercent: 41.945,
        resetsAt: "2026-02-14T14:02:14.000Z",
        durationMinutes: 44_640,
      },
      {
        id: "auto",
        label: "Auto + Composer",
        remainingPercent: 89.5,
        resetsAt: "2026-02-14T14:02:14.000Z",
        durationMinutes: 44_640,
      },
      {
        id: "api",
        label: "API models",
        remainingPercent: 53.556,
        resetsAt: "2026-02-14T14:02:14.000Z",
        durationMinutes: 44_640,
      },
    ]);
  });

  it("derives included remaining from spend when remaining is absent", () => {
    const parsed = parseCursorPeriodUsage(
      {
        billingCycleStart: "1783476262000",
        billingCycleEnd: "1786154662000",
        planUsage: {
          includedSpend: 2000,
          limit: 2000,
          autoPercentUsed: 39.57666666666667,
          apiPercentUsed: 88.57777777777778,
          totalPercentUsed: 45.96811594202899,
        },
      },
      "pro",
    );

    expect(parsed.planLabel).toBe("Pro");
    expect(parsed.windows[0]).toMatchObject({
      id: "included",
      label: "Included",
      remainingPercent: 0,
    });
    expect(parsed.windows[1]?.remainingPercent).toBeCloseTo(60.42333333333333, 5);
    expect(parsed.windows[2]?.remainingPercent).toBeCloseTo(11.42222222222222, 5);
  });

  it("returns no windows when plan usage is missing", () => {
    expect(parseCursorPeriodUsage({ billingCycleEnd: "1771077734000" }, "pro").windows).toEqual([]);
  });
});
