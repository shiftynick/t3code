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
import { QUOTA_CONTRACT_VERSION } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

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
    environments: dedupeEnvironmentQuotaStatuses(environments),
    isPending: answeredCount === 0 && stillReporting > 0,
    isPartial: answeredCount > 0 && stillReporting > 0,
    refresh,
  };
}
