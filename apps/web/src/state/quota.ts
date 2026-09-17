/**
 * Multi-environment subscription quota state.
 *
 * Each connected environment answers the same typed query. Remaining windows
 * are not merged: they belong to the machine that holds the provider sign-in.
 *
 * @module state/quota
 */
import { useAtomValue } from "@effect/atom-react";
import {
  dedupeEnvironmentQuotaStatuses,
  type EnvironmentQuotaStatus,
} from "@t3tools/client-runtime/quota";
import {
  QUOTA_CONTRACT_VERSION,
  type EnvironmentId,
  type QuotaProviderKind,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useState } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

export type { EnvironmentQuotaStatus } from "@t3tools/client-runtime/quota";

const EMPTY_QUOTA_INPUT = {} as const;

const quotaStatusesAtom = Atom.make((get): readonly EnvironmentQuotaStatus[] => {
  const presentations = get(environmentPresentations.presentationsAtom);
  const statuses: EnvironmentQuotaStatus[] = [];
  for (const [environmentId, presentation] of presentations) {
    const result = get(
      serverEnvironment.quotaSnapshot({ environmentId, input: EMPTY_QUOTA_INPUT }),
    );
    const snapshot = Option.getOrNull(AsyncResult.value(result));
    statuses.push({
      environmentId,
      label: presentation.entry.target.label,
      isPending: result.waiting,
      error: result._tag === "Failure" ? "This environment could not report quota." : null,
      snapshot:
        snapshot !== null && snapshot.contractVersion === QUOTA_CONTRACT_VERSION ? snapshot : null,
    });
  }
  return statuses;
}).pipe(Atom.withLabel("web-quota:statuses"));

/** Identifies one in-flight refresh: a whole environment, or one of its providers. */
export function quotaRefreshKey(
  environmentId: EnvironmentId,
  provider?: QuotaProviderKind,
): string {
  return provider === undefined ? environmentId : `${environmentId}:${provider}`;
}

export interface QuotaView {
  readonly environments: readonly EnvironmentQuotaStatus[];
  readonly isPending: boolean;
  readonly isPartial: boolean;
  /** Re-reads every provider on every environment. */
  readonly refresh: () => void;
  /** Re-reads one provider on one environment, leaving the others cached. */
  readonly refreshProvider: (environmentId: EnvironmentId, provider: QuotaProviderKind) => void;
  readonly refreshingKeys: ReadonlySet<string>;
}

export function useQuota(): QuotaView {
  const environments = useAtomValue(quotaStatusesAtom);
  const requestRefresh = useAtomCommand(serverEnvironment.refreshQuotaSnapshot, {
    reportFailure: false,
  });
  const [refreshingKeys, setRefreshingKeys] = useState<ReadonlySet<string>>(() => new Set());

  const runRefresh = useCallback(
    (environmentId: EnvironmentId, provider?: QuotaProviderKind) => {
      const key = quotaRefreshKey(environmentId, provider);
      setRefreshingKeys((current) => {
        if (current.has(key)) return current;
        const next = new Set(current);
        next.add(key);
        return next;
      });
      void (async () => {
        await requestRefresh({
          environmentId,
          input: {
            refresh: true,
            ...(provider === undefined ? {} : { providers: [provider] }),
          },
        });
        // The forced read already refilled the server cache, so re-running the
        // shared query costs no provider call and updates every panel at once.
        appAtomRegistry.refresh(
          serverEnvironment.quotaSnapshot({ environmentId, input: EMPTY_QUOTA_INPUT }),
        );
        setRefreshingKeys((current) => {
          if (!current.has(key)) return current;
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      })();
    },
    [requestRefresh],
  );

  const refresh = useCallback(() => {
    for (const environment of environments) {
      runRefresh(environment.environmentId);
    }
  }, [environments, runRefresh]);

  const refreshProvider = useCallback(
    (environmentId: EnvironmentId, provider: QuotaProviderKind) => {
      runRefresh(environmentId, provider);
    },
    [runRefresh],
  );

  const answeredCount = environments.filter((environment) => environment.snapshot !== null).length;
  const stillReporting = environments.filter(
    (environment) => environment.snapshot === null && environment.error === null,
  ).length;

  return {
    environments: dedupeEnvironmentQuotaStatuses(environments),
    isPending: answeredCount === 0 && stillReporting > 0,
    isPartial: answeredCount > 0 && stillReporting > 0,
    refresh,
    refreshProvider,
    refreshingKeys,
  };
}
