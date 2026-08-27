import type { EnvironmentId, QuotaProviderSnapshot, QuotaSnapshot } from "@t3tools/contracts";

export interface EnvironmentQuotaStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly snapshot: QuotaSnapshot | null;
}

const STATUS_RANK: Readonly<Record<QuotaProviderSnapshot["status"], number>> = {
  ok: 6,
  stale: 5,
  rateLimited: 4,
  unauthenticated: 3,
  unavailable: 2,
  unsupported: 1,
  failed: 0,
};

function isBetterSnapshot(
  candidate: QuotaProviderSnapshot,
  current: QuotaProviderSnapshot,
): boolean {
  const rankDifference = STATUS_RANK[candidate.status] - STATUS_RANK[current.status];
  if (rankDifference !== 0) return rankDifference > 0;
  if (candidate.windows.length !== current.windows.length) {
    return candidate.windows.length > current.windows.length;
  }
  return (candidate.fetchedAt ?? "") > (current.fetchedAt ?? "");
}

/**
 * Shows a shared provider subscription once while retaining distinct accounts
 * and providers that cannot expose a stable account identifier.
 */
export function dedupeEnvironmentQuotaStatuses(
  environments: readonly EnvironmentQuotaStatus[],
): readonly EnvironmentQuotaStatus[] {
  const winners = new Map<
    string,
    { readonly environmentIndex: number; readonly provider: QuotaProviderSnapshot }
  >();

  for (const [environmentIndex, environment] of environments.entries()) {
    for (const provider of environment.snapshot?.providers ?? []) {
      if (provider.accountFingerprint === null) continue;
      const key = `${provider.provider}:${provider.accountFingerprint}`;
      const current = winners.get(key);
      if (current === undefined || isBetterSnapshot(provider, current.provider)) {
        winners.set(key, { environmentIndex, provider });
      }
    }
  }

  const visible: EnvironmentQuotaStatus[] = [];
  for (const [environmentIndex, environment] of environments.entries()) {
    if (environment.snapshot === null) {
      visible.push(environment);
      continue;
    }
    const providers = environment.snapshot.providers.filter((provider) => {
      if (provider.accountFingerprint === null) return true;
      return (
        winners.get(`${provider.provider}:${provider.accountFingerprint}`)?.environmentIndex ===
        environmentIndex
      );
    });
    if (providers.length === 0) continue;
    visible.push({
      ...environment,
      snapshot: {
        ...environment.snapshot,
        providers,
      },
    });
  }
  return visible;
}
