import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ComponentType,
} from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { ICON_BODIES } from "./icon-data.js";
import {
  parseIconPack,
  parseSpinnerStyle,
  resolveIconPackForName,
  type IconAppearance,
  type IconPack,
  type SpinnerStyle,
} from "./icon-pack-preference.js";
import {
  PREFERENCES_CHANGE_EVENT,
  PREFERENCES_STORAGE_KEY,
} from "./preferences-storage.js";

const DEFAULT_APPEARANCE: IconAppearance = {
  iconPack: "default",
  spinnerStyle: "follow",
};

function readStoredAppearance(): IconAppearance {
  try {
    const stored = window.localStorage.getItem(PREFERENCES_STORAGE_KEY);
    if (stored === null) return DEFAULT_APPEARANCE;
    const value: unknown = JSON.parse(stored);
    if (typeof value !== "object" || value === null) return DEFAULT_APPEARANCE;
    const preferences = value as {
      iconPack?: unknown;
      spinnerStyle?: unknown;
    };
    return {
      iconPack: parseIconPack(preferences.iconPack),
      spinnerStyle: parseSpinnerStyle(preferences.spinnerStyle),
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

function sameAppearance(a: IconAppearance, b: IconAppearance): boolean {
  return a.iconPack === b.iconPack && a.spinnerStyle === b.spinnerStyle;
}

let snapshot: IconAppearance | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): IconAppearance {
  snapshot ??= readStoredAppearance();
  return snapshot;
}

function publish(next: IconAppearance) {
  if (snapshot !== null && sameAppearance(next, snapshot)) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function onPreferencesChange(event: Event) {
  const detail = (event as CustomEvent<unknown>).detail;
  if (typeof detail === "object" && detail !== null) {
    const preferences = detail as {
      iconPack?: unknown;
      spinnerStyle?: unknown;
    };
    publish({
      iconPack: parseIconPack(preferences.iconPack),
      spinnerStyle: parseSpinnerStyle(preferences.spinnerStyle),
    });
    return;
  }
  publish(readStoredAppearance());
}

function onStorage(event: StorageEvent) {
  if (event.key !== PREFERENCES_STORAGE_KEY && event.key !== null) return;
  publish(readStoredAppearance());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener(PREFERENCES_CHANGE_EVENT, onPreferencesChange);
    window.addEventListener("storage", onStorage);
  }
  // Reconcile changes that landed between render and subscription.
  publish(readStoredAppearance());

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener(PREFERENCES_CHANGE_EVENT, onPreferencesChange);
      window.removeEventListener("storage", onStorage);
    }
  };
}

function useIconAppearance(): IconAppearance {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function getPackBody(pack: IconPack, name: string): string | undefined {
  if (pack === "default") return undefined;
  const bodies: Readonly<Record<string, string>> = ICON_BODIES[pack];
  return bodies[name];
}

/** Settings previews force a pack without changing the saved preference. */
const PreviewPackContext = createContext<IconPack | null>(null);
/** The separate spinner choice applies only while previewing one option. */
const PreviewSpinnerContext = createContext<SpinnerStyle | null>(null);

function PackGlyph({ body, className }: { body: string; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      dangerouslySetInnerHTML={{ __html: body }}
      fill="none"
      focusable="false"
      style={{ width: "inherit", height: "inherit" }}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    />
  );
}

/**
 * One registered component per icon name. It reads the selected appearance at
 * render time, so switching repaints mounted icons without reloading the app.
 *
 * For BB Default, or a name the selected pack does not map, render the same
 * name through the host Icon. The host's recursion guard then draws that name's
 * real built-in artwork, so packs never need a copy of BB's Hugeicons.
 */
function createPackIcon(name: string): ComponentType<{ className?: string }> {
  function PackIcon({ className }: { className?: string }) {
    const appearance = useIconAppearance();
    const previewPack = useContext(PreviewPackContext);
    const previewSpinnerStyle = useContext(PreviewSpinnerContext);
    const pack = resolveIconPackForName(appearance, name, {
      previewPack,
      previewSpinnerStyle,
    });
    const body = getPackBody(pack, name);
    if (body === undefined) {
      return (
        <Icon
          name={name}
          className={className}
          style={{ width: "inherit", height: "inherit" }}
        />
      );
    }
    return <PackGlyph body={body} className={className} />;
  }
  PackIcon.displayName = `IconPack(${name})`;
  return PackIcon;
}

export function IconPackPreview({
  className,
  name,
  pack,
}: {
  className?: string;
  name: string;
  pack: IconPack;
}) {
  return (
    <PreviewPackContext.Provider value={pack}>
      <Icon aria-hidden="true" className={className} name={name} />
    </PreviewPackContext.Provider>
  );
}

export function SpinnerStylePreview({
  className,
  name,
  spinnerStyle,
}: {
  className?: string;
  name: string;
  spinnerStyle: SpinnerStyle;
}) {
  return (
    <PreviewSpinnerContext.Provider value={spinnerStyle}>
      <Icon aria-hidden="true" className={className} name={name} />
    </PreviewSpinnerContext.Provider>
  );
}

export function registerIconPacks(register: (definition: {
  name: string;
  component: ComponentType<{ className?: string }>;
}) => void): void {
  const names = new Set(
    Object.values(ICON_BODIES).flatMap((bodies) => Object.keys(bodies)),
  );
  for (const name of names) {
    register({ name, component: createPackIcon(name) });
  }
}
