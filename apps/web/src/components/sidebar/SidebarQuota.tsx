import { useAtomValue } from "@effect/atom-react";
import type { QuotaProviderKind, QuotaProviderSnapshot, QuotaWindow } from "@t3tools/contracts";
import { formatQuotaReset, formatRemainingPercent } from "@t3tools/shared/quotaFormat";
import { GaugeIcon, RefreshCwIcon } from "lucide-react";
import { memo, useCallback, useEffect } from "react";

import { resolveShortcutCommand } from "../../keybindings";
import { cn } from "../../lib/utils";
import { onToggleSidebarQuota } from "../../sidebarQuotaBus";
import { useQuota, type EnvironmentQuotaStatus } from "../../state/quota";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useUiStateStore } from "../../uiStateStore";
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";

const PROVIDER_LABEL: Record<QuotaProviderKind, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  antigravity: "Antigravity",
};

const PROVIDER_BAR_CLASS: Record<QuotaProviderKind, string> = {
  claude: "bg-[#d97757]",
  codex: "bg-sidebar-foreground/70",
  cursor: "bg-[#5b8def]",
  antigravity: "bg-[#34a853]",
};

export const SidebarQuotaSection = memo(function SidebarQuotaSection() {
  const expanded = useUiStateStore((state) => state.sidebarQuotaExpanded);
  const setSidebarQuotaExpanded = useUiStateStore((state) => state.setSidebarQuotaExpanded);
  const { isMobile, setOpen, setOpenMobile, state } = useSidebar();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  const revealQuota = useCallback(() => {
    if (isMobile) {
      setOpenMobile(true);
    } else if (state === "collapsed") {
      setOpen(true);
    }
    setSidebarQuotaExpanded(true);
  }, [isMobile, setOpen, setOpenMobile, setSidebarQuotaExpanded, state]);

  const toggleQuota = useCallback(() => {
    if (expanded) {
      setSidebarQuotaExpanded(false);
      return;
    }
    revealQuota();
  }, [expanded, revealQuota, setSidebarQuotaExpanded]);

  useEffect(() => onToggleSidebarQuota(toggleQuota), [toggleQuota]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      if (resolveShortcutCommand(event, keybindings) !== "quota.toggle") return;
      event.preventDefault();
      event.stopPropagation();
      toggleQuota();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keybindings, toggleQuota]);

  return (
    <>
      {expanded ? (
        <SidebarMenuItem className="group-data-[collapsible=icon]:hidden">
          <SidebarQuotaPanel />
        </SidebarMenuItem>
      ) : null}
      <SidebarMenuItem>
        <SidebarMenuButton isActive={expanded} onClick={toggleQuota} tooltip="Quota">
          <GaugeIcon />
          <span>Quota</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </>
  );
});

const SidebarQuotaPanel = memo(function SidebarQuotaPanel() {
  const { environments, isPending, refresh } = useQuota();

  return (
    <div
      className="mb-1 flex flex-col gap-2 rounded-[var(--control-radius)] border border-sidebar-border/80 px-2 py-2 group-data-[collapsible=icon]:hidden"
      data-slot="sidebar-quota-panel"
    >
      <div className="flex items-center justify-between gap-2 px-0.5">
        <span className="text-[11px] font-medium text-sidebar-muted-foreground">Remaining</span>
        <button
          className="rounded-md p-0.5 text-sidebar-muted-foreground outline-hidden ring-ring hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2"
          onClick={refresh}
          type="button"
          aria-label="Refresh quota"
        >
          <RefreshCwIcon className="size-3" />
        </button>
      </div>
      {isPending && environments.every((environment) => environment.snapshot === null) ? (
        <p className="px-0.5 text-[11px] text-sidebar-muted-foreground">Reading quota…</p>
      ) : (
        environments.map((environment) => (
          <EnvironmentQuotaBlock
            key={environment.environmentId}
            environment={environment}
            showLabel={environments.length > 1}
          />
        ))
      )}
    </div>
  );
});

function EnvironmentQuotaBlock({
  environment,
  showLabel,
}: {
  readonly environment: EnvironmentQuotaStatus;
  readonly showLabel: boolean;
}) {
  if (environment.error !== null && environment.snapshot === null) {
    return (
      <div className="flex flex-col gap-1">
        {showLabel ? <EnvironmentLabel label={environment.label} /> : null}
        <p className="px-0.5 text-[11px] text-sidebar-muted-foreground">{environment.error}</p>
      </div>
    );
  }
  if (environment.snapshot === null) {
    return (
      <div className="flex flex-col gap-1">
        {showLabel ? <EnvironmentLabel label={environment.label} /> : null}
        <p className="px-0.5 text-[11px] text-sidebar-muted-foreground">Reading quota…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {showLabel ? <EnvironmentLabel label={environment.label} /> : null}
      {environment.snapshot.providers.map((provider) => (
        <ProviderQuotaBlock key={provider.provider} snapshot={provider} />
      ))}
    </div>
  );
}

function EnvironmentLabel({ label }: { readonly label: string }) {
  return (
    <p className="truncate px-0.5 text-[10px] font-medium uppercase tracking-wide text-sidebar-muted-foreground">
      {label}
    </p>
  );
}

function ProviderQuotaBlock({ snapshot }: { readonly snapshot: QuotaProviderSnapshot }) {
  const title = snapshot.planLabel
    ? `${PROVIDER_LABEL[snapshot.provider]} · ${snapshot.planLabel}`
    : PROVIDER_LABEL[snapshot.provider];

  return (
    <div className="flex flex-col gap-1">
      <p className="truncate px-0.5 text-[11px] font-medium text-sidebar-foreground">{title}</p>
      {snapshot.windows.length > 0 ? (
        snapshot.windows.map((window) => (
          <QuotaWindowRow key={window.id} provider={snapshot.provider} window={window} />
        ))
      ) : snapshot.message !== null ? (
        <p className="px-0.5 text-[11px] text-sidebar-muted-foreground">{snapshot.message}</p>
      ) : (
        <p className="px-0.5 text-[11px] text-sidebar-muted-foreground">No subscription windows.</p>
      )}
      {snapshot.windows.length > 0 && snapshot.message !== null ? (
        <p className="px-0.5 text-[10px] text-sidebar-muted-foreground">{snapshot.message}</p>
      ) : null}
    </div>
  );
}

function QuotaWindowRow({
  provider,
  window,
}: {
  readonly provider: QuotaProviderKind;
  readonly window: QuotaWindow;
}) {
  const reset = formatQuotaReset(window.resetsAt, Date.now());
  const remaining = Math.max(0, Math.min(100, window.remainingPercent));

  return (
    <div className="flex flex-col gap-0.5 px-0.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-[11px] text-sidebar-muted-foreground">
          {window.label}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-sidebar-foreground">
          {formatRemainingPercent(remaining)}
        </span>
      </div>
      <div aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-sidebar-border">
        <div
          className={cn("h-full rounded-full", PROVIDER_BAR_CLASS[provider])}
          style={{ width: `${remaining}%` }}
        />
      </div>
      {reset !== null ? (
        <span className="text-[10px] text-sidebar-muted-foreground">{reset}</span>
      ) : null}
    </div>
  );
}
