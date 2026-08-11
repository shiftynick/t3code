/**
 * Multi-environment subscription quota state.
 *
 * Mirror of `apps/web/src/state/quota.ts` over mobile's atom wiring.
 *
 * @module state/quota
 */
import { useAtomValue } from "@effect/atom-react";
import { QUOTA_CONTRACT_VERSION, type EnvironmentId, type QuotaSnapshot } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { appAtomRegistry } from "./atom-registry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

const EMPTY_QUOTA_INPUT = {} as const;

export interface EnvironmentQuotaStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly snapshot: QuotaSnapshot | null;
}

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
}).pipe(Atom.withLabel("mobile-quota:statuses"));

export interface QuotaView {
  readonly environments: readonly EnvironmentQuotaStatus[];
  readonly isPending: boolean;
  readonly isPartial: boolean;
  readonly refresh: () => void;
}

export function useQuota(): QuotaView {
  const environments = useAtomValue(quotaStatusesAtom);
  const refresh = useCallback(() => {
    for (const environment of environments) {
      appAtomRegistry.refresh(
        serverEnvironment.quotaSnapshot({
          environmentId: environment.environmentId,
          input: EMPTY_QUOTA_INPUT,
        }),
      );
    }
  }, [environments]);

  const answeredCount = environments.filter((environment) => environment.snapshot !== null).length;
  const stillReporting = environments.filter(
    (environment) => environment.snapshot === null && environment.error === null,
  ).length;

  return {
    environments,
    isPending: answeredCount === 0 && stillReporting > 0,
    isPartial: answeredCount > 0 && stillReporting > 0,
    refresh,
  };
}
