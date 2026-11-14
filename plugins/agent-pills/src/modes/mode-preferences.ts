import { useEffect, useState } from "react";

const MODE_MENU_KEY = "bb-plugin-agent-pills.mode-menu.v1";
const MODE_MENU_EVENT = "bb:agent-pills-mode-menu-change";

export function readModeMenuEnabled(): boolean {
  try {
    return window.localStorage.getItem(MODE_MENU_KEY) === "on";
  } catch {
    return false;
  }
}

export function writeModeMenuEnabled(on: boolean): void {
  try {
    window.localStorage.setItem(MODE_MENU_KEY, on ? "on" : "off");
  } catch {
    return;
  }
  window.dispatchEvent(new CustomEvent<boolean>(MODE_MENU_EVENT, { detail: on }));
}

export function useModeMenuEnabled(): boolean {
  const [enabled, setEnabled] = useState(readModeMenuEnabled);
  useEffect(() => {
    const onChange = (event: Event) => setEnabled((event as CustomEvent<boolean>).detail);
    const onStorage = (event: StorageEvent) => {
      if (event.key === MODE_MENU_KEY || event.key === null) setEnabled(readModeMenuEnabled());
    };
    window.addEventListener(MODE_MENU_EVENT, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(MODE_MENU_EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return enabled;
}
