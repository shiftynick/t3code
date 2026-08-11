// @effect-diagnostics globalDate:off -- Provider reset timestamps are converted to ISO strings for the wire model.
/**
 * Normalize Claude and Codex subscription-quota payloads into the wire model.
 *
 * Raw provider JSON stays here. Callers must not log the input.
 *
 * @module quotaParse
 */
import type { QuotaProviderSnapshot, QuotaWindow } from "@t3tools/contracts";

const CLAUDE_KNOWN_WINDOWS: Readonly<
  Record<
    string,
    { readonly order: number; readonly label: string; readonly durationMinutes: number }
  >
> = {
  five_hour: { order: 0, label: "5-hour limit", durationMinutes: 300 },
  seven_day: { order: 1, label: "7-day limit", durationMinutes: 10080 },
  seven_day_oauth_apps: { order: 3, label: "7-day OAuth apps", durationMinutes: 10080 },
  seven_day_opus: { order: 4, label: "7-day Opus", durationMinutes: 10080 },
  seven_day_sonnet: { order: 5, label: "7-day Sonnet", durationMinutes: 10080 },
  seven_day_cowork: { order: 6, label: "7-day Cowork", durationMinutes: 10080 },
};

export function clampRemainingPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function humanizeQuotaName(value: string): string {
  const spaced = value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (spaced.length === 0) return "";
  return spaced
    .toLowerCase()
    .split(" ")
    .map((part) => (part.length === 0 ? part : part[0]!.toUpperCase() + part.slice(1)))
    .join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function readUnixSeconds(value: unknown): string | null {
  const seconds = readFiniteNumber(value);
  if (seconds === null || seconds <= 0 || seconds > 8_640_000_000) return null;
  return new Date(seconds * 1000).toISOString();
}

function durationLabel(minutes: number, fallback: string): string {
  if (Math.abs(minutes - 300) < 1) return "5-hour limit";
  if (Math.abs(minutes - 10080) < 1) return "7-day limit";
  if (minutes >= 28 * 24 * 60 && minutes <= 31 * 24 * 60) return "Monthly limit";
  if (minutes >= 1440) return `${Math.round(minutes / 1440)}-day limit`;
  if (minutes >= 60) return `${Math.round(minutes / 60)}-hour limit`;
  return `${humanizeQuotaName(fallback)} limit`;
}

export function parseClaudeUsageWindows(root: unknown): readonly QuotaWindow[] {
  if (!isRecord(root)) return [];

  const ranked: Array<{ readonly order: number; readonly window: QuotaWindow }> = [];
  for (const [name, value] of Object.entries(root)) {
    if (!isRecord(value)) continue;
    const used = readFiniteNumber(value.utilization);
    const resetsAt = readIsoTimestamp(value.resets_at);
    if (used === null || resetsAt === null) continue;
    const known = CLAUDE_KNOWN_WINDOWS[name];
    ranked.push({
      order: known?.order ?? 100,
      window: {
        id: name,
        label: known?.label ?? humanizeQuotaName(name),
        remainingPercent: clampRemainingPercent(100 - used),
        resetsAt,
        durationMinutes: known?.durationMinutes ?? null,
      },
    });
  }

  const limits = root.limits;
  if (Array.isArray(limits)) {
    limits.forEach((limit, index) => {
      if (!isRecord(limit)) return;
      const used = readFiniteNumber(limit.percent);
      const resetsAt = readIsoTimestamp(limit.resets_at);
      const scope = isRecord(limit.scope) ? limit.scope : null;
      const model = scope !== null && isRecord(scope.model) ? scope.model : null;
      const displayName = typeof model?.display_name === "string" ? model.display_name.trim() : "";
      if (used === null || resetsAt === null || displayName.length === 0) return;
      const kind = typeof limit.kind === "string" ? limit.kind : "";
      const group = typeof limit.group === "string" ? limit.group : "";
      const isWeekly = group.toLowerCase() === "weekly" || kind.toLowerCase().startsWith("weekly");
      const modelId = typeof model?.id === "string" ? model.id : displayName;
      ranked.push({
        order: 2,
        window: {
          id: `scoped:${kind}:${modelId}:${index + 1}`,
          label: isWeekly ? `7-day ${displayName}` : displayName,
          remainingPercent: clampRemainingPercent(100 - used),
          resetsAt,
          durationMinutes: isWeekly ? 10080 : null,
        },
      });
    });
  }

  return ranked
    .toSorted((left, right) => {
      if (left.order !== right.order) return left.order - right.order;
      return left.window.label.localeCompare(right.window.label);
    })
    .map((entry) => entry.window);
}

function addCodexLimitWindows(
  limit: Record<string, unknown>,
  prefix: string,
  output: QuotaWindow[],
): void {
  for (const key of ["primary", "secondary"] as const) {
    const window = limit[key];
    if (!isRecord(window)) continue;
    const used = readFiniteNumber(window.usedPercent);
    if (used === null) continue;
    const durationMinutes = readFiniteNumber(window.windowDurationMins) ?? 0;
    const duration = durationLabel(durationMinutes, key);
    output.push({
      id: `${prefix}|${key}|${Math.round(durationMinutes)}`,
      label: prefix.length === 0 ? duration : `${prefix} · ${duration}`,
      remainingPercent: clampRemainingPercent(100 - used),
      resetsAt: readUnixSeconds(window.resetsAt),
      durationMinutes: durationMinutes > 0 ? durationMinutes : null,
    });
  }
}

function isDefaultCodexAlias(primary: QuotaWindow, candidate: QuotaWindow): boolean {
  return candidate.id.toLowerCase() === `codex${primary.id}`.toLowerCase();
}

export function parseCodexRateLimits(result: unknown): {
  readonly planLabel: string | null;
  readonly windows: readonly QuotaWindow[];
} {
  if (!isRecord(result) || !isRecord(result.rateLimits)) {
    return { planLabel: null, windows: [] };
  }

  const windows: QuotaWindow[] = [];
  addCodexLimitWindows(result.rateLimits, "", windows);

  if (isRecord(result.rateLimitsByLimitId)) {
    for (const [name, value] of Object.entries(result.rateLimitsByLimitId)) {
      if (!isRecord(value)) continue;
      const label =
        typeof value.limitName === "string" && value.limitName.trim().length > 0
          ? value.limitName.trim()
          : humanizeQuotaName(name);
      addCodexLimitWindows(value, label, windows);
    }
  }

  const primaryWindows = windows.filter((window) => window.id.startsWith("|"));
  const withoutAliases = windows.filter(
    (window) => !primaryWindows.some((primary) => isDefaultCodexAlias(primary, window)),
  );
  const seen = new Set<string>();
  const distinct = withoutAliases.filter((window) => {
    const key = window.id.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const planType =
    typeof result.rateLimits.planType === "string" ? result.rateLimits.planType.trim() : "";
  return {
    planLabel: planType.length > 0 ? humanizeQuotaName(planType) : null,
    windows: distinct,
  };
}

export function emptyProviderSnapshot(
  provider: QuotaProviderSnapshot["provider"],
  status: QuotaProviderSnapshot["status"],
  message: string,
  extras: Partial<Pick<QuotaProviderSnapshot, "planLabel" | "fetchedAt" | "windows">> = {},
): QuotaProviderSnapshot {
  return {
    provider,
    planLabel: extras.planLabel ?? null,
    fetchedAt: extras.fetchedAt ?? null,
    status,
    message,
    windows: extras.windows ?? [],
  };
}
