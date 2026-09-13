/**
 * Subscription quota remaining.
 *
 * Each environment reads Claude, Codex, Cursor, and Antigravity subscription
 * windows from the provider CLIs' own credentials / app-server, or from the
 * Cursor app's local sign-in. Percentages and reset times cross the wire;
 * tokens, raw provider payloads, and credential material do not.
 *
 * @module quota
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Bumped whenever the shape of {@link QuotaSnapshot} changes incompatibly. The
 * client renders an empty panel when an environment reports an older version
 * rather than failing the whole sidebar.
 */
export const QUOTA_CONTRACT_VERSION = 2 as const;

export const QuotaProviderKind = Schema.Literals(["claude", "codex", "cursor", "antigravity"]);
export type QuotaProviderKind = typeof QuotaProviderKind.Type;

export const QuotaProviderStatus = Schema.Literals([
  "ok",
  "stale",
  "rateLimited",
  "unauthenticated",
  "unsupported",
  "unavailable",
  "failed",
]);
export type QuotaProviderStatus = typeof QuotaProviderStatus.Type;

export const QuotaWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  remainingPercent: Schema.Number,
  resetsAt: Schema.NullOr(IsoDateTime),
  durationMinutes: Schema.NullOr(Schema.Number),
});
export type QuotaWindow = typeof QuotaWindow.Type;

export const QuotaProviderSnapshot = Schema.Struct({
  provider: QuotaProviderKind,
  /** Opaque, provider-scoped identity used to collapse the same subscription across environments. */
  accountFingerprint: Schema.NullOr(TrimmedNonEmptyString),
  planLabel: Schema.NullOr(TrimmedNonEmptyString),
  fetchedAt: Schema.NullOr(IsoDateTime),
  status: QuotaProviderStatus,
  message: Schema.NullOr(TrimmedNonEmptyString),
  windows: Schema.Array(QuotaWindow),
});
export type QuotaProviderSnapshot = typeof QuotaProviderSnapshot.Type;

export const QuotaSnapshotInput = Schema.Struct({
  /** Bypass the short success cache when the previous provider call is old enough. */
  refresh: Schema.optional(Schema.Boolean),
});
export type QuotaSnapshotInput = typeof QuotaSnapshotInput.Type;

export const QuotaSnapshot = Schema.Struct({
  contractVersion: Schema.Number,
  readAt: IsoDateTime,
  providers: Schema.Array(QuotaProviderSnapshot),
});
export type QuotaSnapshot = typeof QuotaSnapshot.Type;
