import { useEffect, useState } from "react";
import {
  PILLS_ATTRIBUTE,
  PILLS_PREFERENCE_EVENT,
  PILLS_PREFERENCE_KEY,
} from "./channels";

export function readPillsEnabled(): boolean {
  try {
    return window.localStorage.getItem(PILLS_PREFERENCE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writePillsEnabled(on: boolean): void {
  try {
    window.localStorage.setItem(PILLS_PREFERENCE_KEY, on ? "on" : "off");
  } catch {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<boolean>(PILLS_PREFERENCE_EVENT, { detail: on }),
  );
}

export function applyPillsEnabled(
  on: boolean,
  root: HTMLElement = document.documentElement,
): void {
  if (on) root.setAttribute(PILLS_ATTRIBUTE, "on");
  else root.removeAttribute(PILLS_ATTRIBUTE);
}

export function onPillsEnabledChange(
  listener: (on: boolean) => void,
): () => void {
  const onChange = (event: Event) => listener((event as CustomEvent<boolean>).detail);
  const onStorage = (event: StorageEvent) => {
    if (event.key === PILLS_PREFERENCE_KEY || event.key === null) {
      listener(readPillsEnabled());
    }
  };
  window.addEventListener(PILLS_PREFERENCE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(PILLS_PREFERENCE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function usePillsEnabled(): boolean {
  const [enabled, setEnabled] = useState(readPillsEnabled);
  useEffect(() => onPillsEnabledChange(setEnabled), []);
  return enabled;
}
