const SIDEBAR_QUOTA_TOGGLE_EVENT = "t3code:toggle-sidebar-quota";

export function toggleSidebarQuota(): void {
  window.dispatchEvent(new Event(SIDEBAR_QUOTA_TOGGLE_EVENT));
}

export function onToggleSidebarQuota(listener: () => void): () => void {
  window.addEventListener(SIDEBAR_QUOTA_TOGGLE_EVENT, listener);
  return () => window.removeEventListener(SIDEBAR_QUOTA_TOGGLE_EVENT, listener);
}
