import {
  experimental_Icon as Icon,
  experimental_SidebarNavigationIcon as SidebarNavigationIcon,
  experimental_useSidebarNavigation as useSidebarNavigation,
  type ExperimentalSidebarNavigationItem,
} from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";

const ROW_CLASS =
  "cs-row group/nav flex w-full min-w-0 items-center rounded-md py-1 min-h-7 max-md:pointer-coarse:min-h-11 text-sm cursor-pointer outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

const IDLE_CLASS = "text-sidebar-foreground/95 hover:bg-sidebar-accent/60";
const ACTIVE_CLASS = "bg-sidebar-accent text-sidebar-accent-foreground";

function badgeText(item: ExperimentalSidebarNavigationItem) {
  const badge = item.badge;
  if (badge === null) return null;
  if (badge.text !== undefined) return badge.text;
  if (badge.count === undefined) return null;
  return badge.count > 9 ? "9+" : String(badge.count);
}

export function CursorNavigation() {
  const state = useSidebarNavigation();

  const items = state.items.filter(
    (item) => item.isVisible && item.action.kind !== "search-threads",
  );

  return (
    <div
      data-cursor-navigation=""
      className="cs-row-inset relative shrink-0 space-y-0.5 pb-1 pt-2"
    >
      {items.map((item) => {
        const isActive = item.id === state.activeItemId;
        const shortcut = state.isShortcutModifierHeld ? item.shortcut : null;
        const badge = badgeText(item);
        const label =
          item.badge === null ? item.label : `${item.label}, ${item.badge.label}`;

        return (
          <button
            key={item.id}
            type="button"
            aria-label={label}
            aria-current={isActive ? "page" : undefined}
            aria-busy={item.isLoading || undefined}
            aria-keyshortcuts={item.shortcut?.ariaKeyShortcuts}
            disabled={item.isDisabled || item.isLoading}
            className={cn(ROW_CLASS, isActive ? ACTIVE_CLASS : IDLE_CLASS)}
            onClick={() => state.actions.activate(item.id, { target: "current" })}
          >
            <SidebarNavigationIcon
              icon={item.icon}
              className={cn(
                "cs-nav-icon shrink-0",
                isActive ? "text-sidebar-accent-foreground" : "text-muted-foreground",
              )}
            />
            <span className="cs-row-text min-w-0 flex-1 truncate text-left">{item.label}</span>
            {shortcut === null ? null : (
              <span className="shrink-0 text-[length:var(--bbs-text-meta,11px)] text-subtle-foreground">
                {shortcut.label}
              </span>
            )}
            {badge === null ? null : (
              <span className="shrink-0 text-[length:var(--bbs-text-meta,11px)] tabular-nums text-muted-foreground">
                {badge}
              </span>
            )}
          </button>
        );
      })}
      <button
        type="button"
        className={cn(ROW_CLASS, IDLE_CLASS)}
        onClick={() => state.actions.openCustomize()}
      >
        <Icon
          name="SlidersHorizontal"
          className="cs-nav-icon shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="cs-row-text min-w-0 flex-1 truncate text-left">Customize</span>
      </button>
    </div>
  );
}
