import { describe, expect, it } from "@effect/vitest";
import type {
  EnvironmentId,
  QuotaProviderKind,
  QuotaProviderSnapshot,
  QuotaProviderStatus,
} from "@t3tools/contracts";

import { dedupeEnvironmentQuotaStatuses, type EnvironmentQuotaStatus } from "./quota.ts";

const provider = (
  kind: QuotaProviderKind,
  fingerprint: string | null,
  status: QuotaProviderStatus = "ok",
): QuotaProviderSnapshot => ({
  provider: kind,
  accountFingerprint: fingerprint,
  planLabel: null,
  fetchedAt: "2026-08-27T12:00:00.000Z",
  status,
  message: null,
  windows: [],
});

const environment = (
  id: string,
  providers: readonly QuotaProviderSnapshot[],
): EnvironmentQuotaStatus => ({
  environmentId: id as EnvironmentId,
  label: id,
  isPending: false,
  error: null,
  snapshot: {
    contractVersion: 2,
    readAt: "2026-08-27T12:00:00.000Z",
    providers,
  },
});

describe("dedupeEnvironmentQuotaStatuses", () => {
  it("shows the same provider subscription only once across environments", () => {
    const result = dedupeEnvironmentQuotaStatuses([
      environment("local", [provider("claude", "same")]),
      environment("remote", [provider("claude", "same")]),
    ]);

    expect(result.map((item) => item.label)).toEqual(["local"]);
  });

  it("keeps distinct accounts and snapshots without an identity", () => {
    const result = dedupeEnvironmentQuotaStatuses([
      environment("local", [provider("codex", "one"), provider("cursor", null)]),
      environment("remote", [provider("codex", "two"), provider("cursor", null)]),
    ]);

    expect(result).toHaveLength(2);
    expect(result.flatMap((item) => item.snapshot?.providers ?? [])).toHaveLength(4);
  });

  it("keeps a healthier reading and unrelated providers from either environment", () => {
    const result = dedupeEnvironmentQuotaStatuses([
      environment("local", [provider("claude", "same", "failed"), provider("codex", "codex")]),
      environment("remote", [provider("claude", "same", "ok"), provider("cursor", "cursor")]),
    ]);

    expect(result.map((item) => item.snapshot?.providers.map((item) => item.provider))).toEqual([
      ["codex"],
      ["claude", "cursor"],
    ]);
  });
});
