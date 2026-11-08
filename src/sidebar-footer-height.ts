import { useEffect, type RefObject } from "react";

const SIDEBAR_FOOTER_HEIGHT_VAR = "--cs-sidebar-footer-height";

export function useSidebarFooterHeight(inside: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const body = inside.current?.closest<HTMLElement>('[data-testid="app-sidebar-body"]') ?? null;
    const footer = body?.querySelector<HTMLElement>(':scope > [data-sidebar="footer"]') ?? null;
    if (body === null || footer === null) return;
    const update = () => body.style.setProperty(SIDEBAR_FOOTER_HEIGHT_VAR, `${footer.offsetHeight}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(footer);
    return () => {
      observer.disconnect();
      body.style.removeProperty(SIDEBAR_FOOTER_HEIGHT_VAR);
    };
  }, [inside]);
}
