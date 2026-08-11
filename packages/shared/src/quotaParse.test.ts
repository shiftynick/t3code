import { describe, expect, it } from "@effect/vitest";

import { parseClaudeUsageWindows, parseCodexRateLimits } from "./quotaParse.ts";

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
