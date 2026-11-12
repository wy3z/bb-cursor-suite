import { useLayoutEffect } from "react";

const ROOT_MARKER_ATTRIBUTE = "data-cursor-sidebar-active";

let mountedSidebars = 0;

export function useSidebarRootMarker(): void {
  useLayoutEffect(() => {
    mountedSidebars += 1;
    document.documentElement.setAttribute(ROOT_MARKER_ATTRIBUTE, "");
    return () => {
      mountedSidebars -= 1;
      if (mountedSidebars === 0) {
        document.documentElement.removeAttribute(ROOT_MARKER_ATTRIBUTE);
      }
    };
  }, []);
}
