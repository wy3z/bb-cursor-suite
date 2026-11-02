/**
 * The composer restyle is client-local, like a font preference: it changes
 * only this browser's look and needs no server row. localStorage keeps it
 * across reloads; the custom event keeps the settings section and the
 * content script in step without a reload.
 */
import {
  COMPOSER_ATTRIBUTE,
  COMPOSER_PREFERENCE_EVENT,
  COMPOSER_PREFERENCE_KEY,
} from "./channels";

export function readComposerRestyle(): boolean {
  try {
    return window.localStorage.getItem(COMPOSER_PREFERENCE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeComposerRestyle(on: boolean): void {
  try {
    window.localStorage.setItem(COMPOSER_PREFERENCE_KEY, on ? "on" : "off");
  } catch {
    // A blocked storage partition only loses persistence, not the live look.
  }
  window.dispatchEvent(
    new CustomEvent<boolean>(COMPOSER_PREFERENCE_EVENT, { detail: on }),
  );
}

export function applyComposerRestyle(
  on: boolean,
  root: HTMLElement = document.documentElement,
): void {
  if (on) root.setAttribute(COMPOSER_ATTRIBUTE, "cursor");
  else root.removeAttribute(COMPOSER_ATTRIBUTE);
}
