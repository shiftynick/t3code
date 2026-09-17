import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  QuotaProviderKind,
  QuotaProviderSnapshot,
  QuotaWindow,
} from "@t3tools/contracts";
import { formatQuotaReset, formatRemainingPercent } from "@t3tools/shared/quotaFormat";
import { ChevronRightIcon, GaugeIcon, RefreshCwIcon } from "lucide-react";
import { memo, useCallback, useEffect, type ReactNode } from "react";

import { resolveShortcutCommand } from "../../keybindings";
import { cn } from "../../lib/utils";
import { onToggleSidebarQuota } from "../../sidebarQuotaBus";
import { quotaRefreshKey, useQuota, type EnvironmentQuotaStatus } from "../../state/quota";
import {
  quotaEnvironmentCollapseKey,
  quotaProviderCollapseKey,
  useQuotaPanelStore,
} from "../../state/quotaPanelStore";
import { primaryServerKeybindingsAtom } from "../../state/server";
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
  const expanded = useQuotaPanelStore((state) => state.expanded);
  const setSidebarQuotaExpanded = useQuotaPanelStore((state) => state.setExpanded);
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
  const { environments, isPending, refresh, refreshProvider, refreshingKeys } = useQuota();
  // Only a whole-panel refresh spins this icon; a single provider row spins its own.
  const isRefreshingAll = environments.some((environment) =>
    refreshingKeys.has(quotaRefreshKey(environment.environmentId)),
  );

  return (
    <div
      className="mb-1 flex flex-col gap-2 rounded-[var(--control-radius)] border border-sidebar-border/80 px-2 py-2 group-data-[collapsible=icon]:hidden"
      data-slot="sidebar-quota-panel"
    >
      <div className="flex items-center justify-between gap-2 px-0.5">
        <span className="text-[11px] font-medium text-sidebar-muted-foreground">Remaining</span>
        <QuotaRefreshButton
          label="Refresh all quota"
          isRefreshing={isRefreshingAll}
          onRefresh={refresh}
        />
      </div>
      {isPending && environments.every((environment) => environment.snapshot === null) ? (
        <p className="px-0.5 text-[11px] text-sidebar-muted-foreground">Reading quota…</p>
      ) : (
        environments.map((environment) => (
          <EnvironmentQuotaBlock
            key={environment.environmentId}
            environment={environment}
            showLabel={environments.length > 1}
            onRefreshProvider={refreshProvider}
            refreshingKeys={refreshingKeys}
          />
        ))
      )}
    </div>
  );
});

function EnvironmentQuotaBlock({
  environment,
  showLabel,
  onRefreshProvider,
  refreshingKeys,
}: {
  readonly environment: EnvironmentQuotaStatus;
  readonly showLabel: boolean;
  readonly onRefreshProvider: (environmentId: EnvironmentId, provider: QuotaProviderKind) => void;
  readonly refreshingKeys: ReadonlySet<string>;
}) {
  const collapseKey = quotaEnvironmentCollapseKey(environment.environmentId);
  const collapsed = useQuotaPanelStore((state) => state.collapsedKeys.includes(collapseKey));
  const setCollapsed = useQuotaPanelStore((state) => state.setCollapsed);
  // A single environment has nothing to group, so it stays a flat list.
  const groupable = showLabel;
  const hidden = groupable && collapsed;

  const header = groupable ? (
    <QuotaGroupHeader
      collapsed={collapsed}
      label={environment.label}
      onToggle={() => setCollapsed(collapseKey, !collapsed)}
      variant="environment"
    />
  ) : null;

  if (environment.error !== null && environment.snapshot === null) {
    return (
      <div className="flex flex-col gap-1">
        {header}
        {hidden ? null : (
          <p className="px-0.5 text-[11px] text-sidebar-muted-foreground">{environment.error}</p>
        )}
      </div>
    );
  }
  if (environment.snapshot === null) {
    return (
      <div className="flex flex-col gap-1">
        {header}
        {hidden ? null : (
          <p className="px-0.5 text-[11px] text-sidebar-muted-foreground">Reading quota…</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {header}
      {hidden
        ? null
        : environment.snapshot.providers.map((provider) => (
            <ProviderQuotaBlock
              key={provider.provider}
              environmentId={environment.environmentId}
              snapshot={provider}
              onRefresh={() => onRefreshProvider(environment.environmentId, provider.provider)}
              isRefreshing={refreshingKeys.has(
                quotaRefreshKey(environment.environmentId, provider.provider),
              )}
            />
          ))}
    </div>
  );
}

function QuotaGroupHeader({
  collapsed,
  label,
  onToggle,
  trailing,
  variant,
}: {
  readonly collapsed: boolean;
  readonly label: string;
  readonly onToggle: () => void;
  readonly trailing?: ReactNode;
  readonly variant: "environment" | "provider";
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        aria-expanded={!collapsed}
        className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-0.5 text-left outline-hidden ring-ring hover:bg-sidebar-row-hover focus-visible:ring-2"
        onClick={onToggle}
        type="button"
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
            collapsed ? null : "rotate-90",
          )}
        />
        <span
          className={cn(
            "truncate",
            variant === "environment"
              ? "text-[10px] font-medium uppercase tracking-wide text-sidebar-muted-foreground"
              : "text-[11px] font-medium text-sidebar-foreground",
          )}
        >
          {label}
        </span>
      </button>
      {trailing}
    </div>
  );
}

function QuotaRefreshButton({
  isRefreshing,
  label,
  onRefresh,
}: {
  readonly isRefreshing: boolean;
  readonly label: string;
  readonly onRefresh: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="rounded-md p-0.5 text-sidebar-muted-foreground outline-hidden ring-ring hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2"
      disabled={isRefreshing}
      onClick={onRefresh}
      type="button"
    >
      <RefreshCwIcon className={cn("size-3", isRefreshing ? "animate-spin" : null)} />
    </button>
  );
}

function ProviderQuotaBlock({
  environmentId,
  isRefreshing,
  onRefresh,
  snapshot,
}: {
  readonly environmentId: EnvironmentId;
  readonly isRefreshing: boolean;
  readonly onRefresh: () => void;
  readonly snapshot: QuotaProviderSnapshot;
}) {
  const collapseKey = quotaProviderCollapseKey(environmentId, snapshot.provider);
  const collapsed = useQuotaPanelStore((state) => state.collapsedKeys.includes(collapseKey));
  const setCollapsed = useQuotaPanelStore((state) => state.setCollapsed);
  const title = snapshot.planLabel
    ? `${PROVIDER_LABEL[snapshot.provider]} · ${snapshot.planLabel}`
    : PROVIDER_LABEL[snapshot.provider];
  // Collapsed rows still answer the question the panel exists for: how close
  // is this provider to its limit.
  const lowestRemaining =
    snapshot.windows.length > 0
      ? Math.min(...snapshot.windows.map((window) => clampRemaining(window.remainingPercent)))
      : null;

  return (
    <div className="flex flex-col gap-1">
      <QuotaGroupHeader
        collapsed={collapsed}
        label={title}
        onToggle={() => setCollapsed(collapseKey, !collapsed)}
        trailing={
          <div className="flex shrink-0 items-center gap-1">
            {collapsed && lowestRemaining !== null ? (
              <span className="text-[11px] tabular-nums text-sidebar-muted-foreground">
                {formatRemainingPercent(lowestRemaining)}
              </span>
            ) : null}
            <QuotaRefreshButton
              isRefreshing={isRefreshing}
              label={`Refresh ${PROVIDER_LABEL[snapshot.provider]} quota`}
              onRefresh={onRefresh}
            />
          </div>
        }
        variant="provider"
      />
      {collapsed ? null : (
        <>
          {snapshot.windows.length > 0 ? (
            snapshot.windows.map((window) => (
              <QuotaWindowRow key={window.id} provider={snapshot.provider} window={window} />
            ))
          ) : snapshot.message !== null ? (
            <p className="px-0.5 text-[11px] text-sidebar-muted-foreground">{snapshot.message}</p>
          ) : (
            <p className="px-0.5 text-[11px] text-sidebar-muted-foreground">
              No subscription windows.
            </p>
          )}
          {snapshot.windows.length > 0 && snapshot.message !== null ? (
            <p className="px-0.5 text-[10px] text-sidebar-muted-foreground">{snapshot.message}</p>
          ) : null}
        </>
      )}
    </div>
  );
}

function clampRemaining(remainingPercent: number): number {
  return Math.max(0, Math.min(100, remainingPercent));
}

function QuotaWindowRow({
  provider,
  window,
}: {
  readonly provider: QuotaProviderKind;
  readonly window: QuotaWindow;
}) {
  const reset = formatQuotaReset(window.resetsAt, Date.now());
  const remaining = clampRemaining(window.remainingPercent);

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
