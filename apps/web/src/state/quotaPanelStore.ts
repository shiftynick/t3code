/**
 * Sidebar quota panel view state: whether the panel is open, and which groups
 * the user folded away.
 *
 * Kept out of `uiStateStore` on purpose: the quota panel is a fork feature, and
 * its own storage key keeps it from colliding with upstream edits to the shared
 * persisted UI blob.
 *
 * @module state/quotaPanelStore
 */
import { create } from "zustand";

import { PERSISTED_STATE_KEY } from "../uiStateStore";

const STORAGE_KEY = "t3code:quota-panel:v1";

interface PersistedQuotaPanelState {
  readonly expanded: boolean;
  readonly collapsedKeys: readonly string[];
}

export function quotaEnvironmentCollapseKey(environmentId: string): string {
  return `environment:${environmentId}`;
}

export function quotaProviderCollapseKey(environmentId: string, provider: string): string {
  return `provider:${environmentId}:${provider}`;
}

/** Absent keys stay expanded, so a newly connected machine shows up. */
export function setQuotaGroupCollapsed(
  collapsedKeys: readonly string[],
  key: string,
  collapsed: boolean,
): readonly string[] {
  const isCollapsed = collapsedKeys.includes(key);
  if (isCollapsed === collapsed) {
    return collapsedKeys;
  }
  return collapsed
    ? [...collapsedKeys, key]
    : collapsedKeys.filter((collapsedKey) => collapsedKey !== key);
}

const EMPTY_STATE: PersistedQuotaPanelState = { expanded: false, collapsedKeys: [] };

/**
 * The open flag used to live in the shared UI blob, so fall back to it once: an
 * upgrade must not silently close a panel the user keeps open.
 */
export function parseQuotaPanelState(
  raw: string | null,
  legacyUiStateRaw: string | null,
): PersistedQuotaPanelState {
  try {
    if (raw) {
      const value = JSON.parse(raw) as Partial<PersistedQuotaPanelState> | null;
      return {
        expanded: value?.expanded === true,
        collapsedKeys: Array.isArray(value?.collapsedKeys)
          ? value.collapsedKeys.filter((key) => typeof key === "string")
          : [],
      };
    }
    if (legacyUiStateRaw) {
      const legacy = JSON.parse(legacyUiStateRaw) as { readonly sidebarQuotaExpanded?: unknown };
      return { ...EMPTY_STATE, expanded: legacy.sidebarQuotaExpanded === true };
    }
  } catch {
    return EMPTY_STATE;
  }
  return EMPTY_STATE;
}

function readPersistedState(): PersistedQuotaPanelState {
  if (typeof window === "undefined") {
    return EMPTY_STATE;
  }
  try {
    return parseQuotaPanelState(
      window.localStorage.getItem(STORAGE_KEY),
      window.localStorage.getItem(PERSISTED_STATE_KEY),
    );
  } catch {
    return EMPTY_STATE;
  }
}

function persistState(state: PersistedQuotaPanelState): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage failures must not break the panel.
  }
}

interface QuotaPanelStore extends PersistedQuotaPanelState {
  setExpanded: (expanded: boolean) => void;
  setCollapsed: (key: string, collapsed: boolean) => void;
}

export const useQuotaPanelStore = create<QuotaPanelStore>((set) => ({
  ...readPersistedState(),
  setExpanded: (expanded) =>
    set((state) => {
      if (state.expanded === expanded) {
        return state;
      }
      const next = { expanded, collapsedKeys: state.collapsedKeys };
      persistState(next);
      return next;
    }),
  setCollapsed: (key, collapsed) =>
    set((state) => {
      const collapsedKeys = setQuotaGroupCollapsed(state.collapsedKeys, key, collapsed);
      if (collapsedKeys === state.collapsedKeys) {
        return state;
      }
      const next = { expanded: state.expanded, collapsedKeys };
      persistState(next);
      return next;
    }),
}));
