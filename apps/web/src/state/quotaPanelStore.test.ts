import { describe, expect, it } from "vite-plus/test";

import {
  parseQuotaPanelState,
  quotaEnvironmentCollapseKey,
  quotaProviderCollapseKey,
  setQuotaGroupCollapsed,
} from "./quotaPanelStore";

describe("setQuotaGroupCollapsed", () => {
  it("collapses and expands one group without touching the others", () => {
    const environmentKey = quotaEnvironmentCollapseKey("environment-1");
    const providerKey = quotaProviderCollapseKey("environment-1", "codex");
    const collapsed = setQuotaGroupCollapsed(
      setQuotaGroupCollapsed([], environmentKey, true),
      providerKey,
      true,
    );

    expect(collapsed).toEqual([environmentKey, providerKey]);
    expect(setQuotaGroupCollapsed(collapsed, providerKey, true)).toBe(collapsed);
    expect(setQuotaGroupCollapsed(collapsed, providerKey, false)).toEqual([environmentKey]);
  });
});

describe("parseQuotaPanelState", () => {
  it("keeps a panel the user left open when the flag still lives in the shared UI blob", () => {
    expect(parseQuotaPanelState(null, JSON.stringify({ sidebarQuotaExpanded: true }))).toEqual({
      expanded: true,
      collapsedKeys: [],
    });
  });

  it("prefers its own state and survives unusable storage", () => {
    const own = JSON.stringify({ expanded: false, collapsedKeys: ["environment:one", 7] });
    expect(parseQuotaPanelState(own, JSON.stringify({ sidebarQuotaExpanded: true }))).toEqual({
      expanded: false,
      collapsedKeys: ["environment:one"],
    });
    expect(parseQuotaPanelState("not json", null)).toEqual({ expanded: false, collapsedKeys: [] });
    expect(parseQuotaPanelState(null, null)).toEqual({ expanded: false, collapsedKeys: [] });
  });
});
