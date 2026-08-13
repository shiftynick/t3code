// @effect-diagnostics globalDate:off -- Reset labels are wall-clock remaining time for the viewer.
/**
 * Display formatting for subscription quota windows.
 *
 * @module quotaFormat
 */

export function formatRemainingPercent(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  const clamped = Math.max(0, Math.min(100, value));
  const rounded = Math.round(clamped);
  return `${rounded}%`;
}

export function formatQuotaReset(resetsAt: string | null, nowMs: number): string | null {
  if (resetsAt === null) return null;
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) return null;
  const remainingMs = resetMs - nowMs;
  if (remainingMs <= 0) return "resetting";
  const remainingMinutes = Math.round(remainingMs / 60_000);
  if (remainingMinutes < 60) return `resets in ${Math.max(1, remainingMinutes)}m`;
  const remainingHours = Math.round(remainingMs / 3_600_000);
  if (remainingHours < 24) return `resets in ${remainingHours}h`;
  const remainingDays = Math.round(remainingMs / 86_400_000);
  if (remainingDays < 7) return `resets in ${remainingDays}d`;
  return `resets ${formatResetDay(resetMs)}`;
}

function formatResetDay(resetMs: number): string {
  const month = new Date(resetMs).toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const day = new Date(resetMs).getUTCDate();
  return `${month} ${day}`;
}
