import {
  createElement,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent as ReactClipboardEvent,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { experimental_usePluginId, useRpc } from "@get-bb/plugin-sdk/app";
import { PROJECT_ICON_GLYPHS_HASH } from "./project-icon-glyphs-hash";
import type { projectIconGlyphContract } from "./contracts";
import {
  PICKER_GLYPH_PREFIX,
  PROJECT_ICON_COLORS,
  PROJECT_ICON_IMAGE_EDGE,
  filterProjectIconNames,
  isProjectIconPickerColor,
  projectIconColorClass,
  type CompactGlyph,
  type ProjectIcon,
  type ProjectIconPickerColor,
} from "./project-icon";

export type GlyphFetch = (names: string[] | null) => Promise<Record<string, CompactGlyph>>;

const STORE_PREFIX = "bbs-pi-glyphs:";
const STORE_LIMIT = 300;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const cache = new Map<string, CompactGlyph | null>();
const persisted = new Map<string, CompactGlyph>();
const listeners = new Set<() => void>();
const queued = new Set<string>();
let flushScheduled = false;
let allLoad: Promise<void> | null = null;
let failures = 0;
let version = 0;
let storeKey: string | null = null;

export function glyphStoreKey(pluginId: string, hash: string = PROJECT_ICON_GLYPHS_HASH): string {
  return `${STORE_PREFIX}${pluginId}:${hash}`;
}

export function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

function openStore(pluginId: string) {
  const key = glyphStoreKey(pluginId);
  if (storeKey === key) return;
  storeKey = key;
  try {
    if (typeof localStorage === "undefined") return;
    const stale: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const candidate = localStorage.key(index);
      if (candidate?.startsWith(`${STORE_PREFIX}${pluginId}:`) && candidate !== key) stale.push(candidate);
    }
    for (const candidate of stale) localStorage.removeItem(candidate);
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") {
      for (const [name, glyph] of Object.entries(parsed as Record<string, CompactGlyph>)) {
        if (Array.isArray(glyph) && !cache.has(name)) {
          cache.set(name, glyph);
          persisted.set(name, glyph);
        }
      }
    }
  } catch {
    return;
  }
}

function writeStore() {
  if (storeKey === null) return;
  try {
    const entries = [...persisted].slice(-STORE_LIMIT);
    localStorage.setItem(storeKey, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    return;
  }
}

function retryLater(run: () => void) {
  failures += 1;
  setTimeout(run, retryDelay(failures));
}

function emit() {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function requestGlyph(fetch: GlyphFetch, name: string) {
  if (cache.has(name) || queued.has(name)) return;
  queued.add(name);
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    flushScheduled = false;
    const names = [...queued];
    queued.clear();
    fetch(names).then(
      (glyphs) => {
        failures = 0;
        for (const requested of names) {
          const glyph = glyphs[requested];
          cache.set(requested, glyph ?? null);
          if (glyph) persisted.set(requested, glyph);
        }
        writeStore();
        emit();
      },
      () => retryLater(() => {
        for (const name of names) requestGlyph(fetch, name);
      }),
    );
  });
}

function requestAllGlyphs(fetch: GlyphFetch) {
  allLoad ??= fetch(null).then(
    (glyphs) => {
      failures = 0;
      for (const [name, glyph] of Object.entries(glyphs)) cache.set(name, glyph);
      emit();
    },
    () => {
      allLoad = null;
      retryLater(() => requestAllGlyphs(fetch));
    },
  );
}

function useGlyphFetch(): GlyphFetch {
  const rpc = useRpc<typeof projectIconGlyphContract>();
  openStore(experimental_usePluginId());
  return useCallback((names: string[] | null) => rpc.call("iconGlyphs", { names }).then((result) => result.glyphs as Record<string, CompactGlyph>), [rpc]);
}

function useGlyph(name: string): CompactGlyph | null | undefined {
  const fetch = useGlyphFetch();
  useSyncExternalStore(subscribe, () => version, () => version);
  useEffect(() => {
    if (!cache.has(name)) requestGlyph(fetch, name);
  }, [name, fetch]);
  return cache.get(name);
}

function GlyphSvg({ glyph, className, strokeWidth }: { glyph: CompactGlyph | null | undefined; className?: string; strokeWidth: number }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
      aria-hidden="true"
      focusable="false"
      data-bbs-glyph=""
    >
      {(glyph ?? []).map((element, index) =>
        typeof element === "string" ? <path key={index} d={element} /> : createElement(element[0], { ...element[1], key: index }),
      )}
    </svg>
  );
}

export function ProjectIconGlyph({ name, className, strokeWidth = 1.5 }: { name: string; className?: string; strokeWidth?: number }) {
  return <GlyphSvg glyph={useGlyph(name)} className={className} strokeWidth={strokeWidth} />;
}

function PickerGlyph({ name, className }: { name: "none" | "upload" | "check"; className?: string }) {
  return <GlyphSvg glyph={useGlyph(`${PICKER_GLYPH_PREFIX}${name}`)} className={className} strokeWidth={1.5} />;
}

export function ProjectIconArt({
  icon,
  fallback,
  className,
  strokeWidth,
}: {
  icon: ProjectIcon | null;
  fallback: ReactNode;
  className?: string;
  strokeWidth?: number;
}) {
  if (icon === null) return <>{fallback}</>;
  const classes = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");
  if (icon.kind === "image") return <img className={classes("bbs-pi-art", "bbs-pi-image", className)} src={icon.src} alt="" aria-hidden="true" draggable={false} />;
  if (icon.kind === "emoji") return <span className={classes("bbs-pi-art", "bbs-pi-emoji", className)} aria-hidden="true">{icon.emoji}</span>;
  if (icon.kind === "monogram") {
    return (
      <span className={classes("bbs-pi-art", "bbs-pi-monogram", projectIconColorClass(icon.color), className)} aria-hidden="true">
        {icon.text}
      </span>
    );
  }
  return (
    <ProjectIconGlyph
      name={icon.name}
      strokeWidth={strokeWidth}
      className={classes("bbs-pi-art", "bbs-pi-glyph", icon.color === undefined ? "bbs-pi-plain" : projectIconColorClass(icon.color), className)}
    />
  );
}

const COLUMNS = 10;
const ROW_HEIGHT = 29;
const PANEL_MAX_HEIGHT = 338;
const GRID_MAX_HEIGHT = PANEL_MAX_HEIGHT - 16;
const NONE = "none";
const OFFSET = 4;
const EDGE_GAP = 8;

export function gridHeight(count: number): number {
  return Math.min(Math.ceil(count / COLUMNS) * ROW_HEIGHT, GRID_MAX_HEIGHT);
}

export function pickerColorOf(icon: ProjectIcon | null): ProjectIconPickerColor {
  if (icon?.kind === "glyph" && icon.color !== undefined && isProjectIconPickerColor(icon.color)) return icon.color;
  return "default";
}

export function nextGridIndex(key: string, index: number, count: number, columns: number = COLUMNS): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowRight":
      return Math.min(count - 1, index + 1);
    case "ArrowLeft":
      return Math.max(0, index - 1);
    case "ArrowDown":
      return index + columns < count ? index + columns : index;
    case "ArrowUp":
      return index - columns >= 0 ? index - columns : null;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return index;
  }
}

export async function imageToProjectIcon(file: Blob): Promise<ProjectIcon> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const width = image.naturalWidth || PROJECT_ICON_IMAGE_EDGE;
    const height = image.naturalHeight || PROJECT_ICON_IMAGE_EDGE;
    const scale = Math.min(1, PROJECT_ICON_IMAGE_EDGE / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas is unavailable.");
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { kind: "image", src: canvas.toDataURL("image/png") };
  } finally {
    URL.revokeObjectURL(url);
  }
}

const NAVIGATION_KEYS = new Set(["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"]);

export function ProjectIconPickerPanel({
  value,
  onChange,
  onDone,
  clearable = true,
}: {
  value: ProjectIcon | null;
  onChange: (icon: ProjectIcon | null) => void;
  onDone?: () => void;
  clearable?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [pendingColor, setPendingColor] = useState<ProjectIconPickerColor>(() => pickerColorOf(value));
  const [imageError, setImageError] = useState<string | null>(null);
  const deferred = useDeferredValue(query);
  const searchRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const colorsRef = useRef<HTMLFieldSetElement>(null);
  const fetch = useGlyphFetch();
  const glyphValue = value?.kind === "glyph" ? value : null;
  const color = glyphValue ? pickerColorOf(glyphValue) : pendingColor;

  useEffect(() => {
    requestAllGlyphs(fetch);
  }, [fetch]);

  useEffect(() => {
    searchRef.current?.focus({ preventScroll: true });
  }, []);

  const names = filterProjectIconNames(deferred, glyphValue?.name);
  const cells = clearable ? [NONE, ...names] : names;
  const height = gridHeight(cells.length);
  const selectedIndex = cells.findIndex((name) => (name === NONE ? value === null : glyphValue?.name === name));
  const [activeCell, setActiveCell] = useState<string | null>(null);
  const activeIndex = activeCell !== null && cells.includes(activeCell) ? cells.indexOf(activeCell) : Math.max(0, selectedIndex);

  useEffect(() => {
    setActiveCell(null);
    if (gridRef.current) gridRef.current.scrollTop = 0;
  }, [deferred]);

  const pickImage = useCallback(
    async (file: Blob) => {
      try {
        onChange(await imageToProjectIcon(file));
        setImageError(null);
        onDone?.();
      } catch {
        setImageError("That image could not be read.");
      }
    },
    [onChange, onDone],
  );

  const choose = (name: string) => {
    if (name === NONE) {
      if (value !== null) onChange(null);
    } else onChange({ kind: "glyph", name, color });
    onDone?.();
  };

  const focusCell = (index: number) => {
    const name = cells[index];
    if (name === undefined) return;
    setActiveCell(name);
    const button = gridRef.current?.querySelector<HTMLButtonElement>(`[data-icon-color-picker-option="${CSS.escape(name)}"]`);
    button?.focus({ preventScroll: true });
    button?.scrollIntoView({ block: "nearest" });
  };

  const onGridKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!NAVIGATION_KEYS.has(event.key)) return;
    event.preventDefault();
    const next = nextGridIndex(event.key, activeIndex, cells.length);
    if (next === null) searchRef.current?.focus();
    else focusCell(next);
  };

  const colorIndex = PROJECT_ICON_COLORS.findIndex((option) => option.id === color);
  const onColorsKeyDown = (event: ReactKeyboardEvent<HTMLFieldSetElement>) => {
    if (!NAVIGATION_KEYS.has(event.key) || event.key === "ArrowUp" || event.key === "ArrowDown") return;
    event.preventDefault();
    const next = nextGridIndex(event.key, colorIndex, PROJECT_ICON_COLORS.length, PROJECT_ICON_COLORS.length) ?? colorIndex;
    const option = PROJECT_ICON_COLORS[next];
    if (!option) return;
    pickColor(option.id);
    colorsRef.current?.querySelector<HTMLButtonElement>(`[data-color="${option.id}"]`)?.focus();
  };

  const pickColor = (id: ProjectIconPickerColor) => {
    setPendingColor(id);
    if (glyphValue) onChange({ kind: "glyph", name: glyphValue.name, color: id });
  };

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusCell(activeIndex);
      return;
    }
    if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation();
  };

  const onPaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    const file = Array.from(event.clipboardData.files).find((item) => item.type.startsWith("image/"));
    if (!file) return;
    event.preventDefault();
    void pickImage(file);
  };

  return (
    <div className="bbs-icon-picker" onPaste={onPaste}>
      <div className="bbs-icon-picker__search">
        <input
          ref={searchRef}
          className="bbs-icon-picker__input"
          type="text"
          aria-label="Search icons"
          placeholder="Search icons..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKeyDown}
        />
        <button
          type="button"
          className="bbs-icon-picker__image"
          aria-label={value?.kind === "image" ? "Replace image" : "Upload image"}
          title="Image: upload or paste a PNG"
          aria-pressed={value?.kind === "image"}
          onClick={() => fileRef.current?.click()}
        >
          {value?.kind === "image" ? <img src={value.src} alt="" draggable={false} /> : <PickerGlyph name="upload" />}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/webp,image/svg+xml,image/gif,image/jpeg"
          tabIndex={-1}
          aria-hidden="true"
          hidden
          onChange={(event) => {
            const input = event.currentTarget;
            const file = input.files?.[0];
            input.value = "";
            if (file) void pickImage(file);
          }}
        />
      </div>
      {imageError !== null ? (
        <p className="bbs-icon-picker__error" role="alert">
          {imageError}
        </p>
      ) : null}
      <fieldset ref={colorsRef} className="bbs-icon-picker__colors" aria-label="Icon color" onKeyDown={onColorsKeyDown}>
        {PROJECT_ICON_COLORS.map((option) => {
          const selected = option.id === color;
          return (
            <button
              key={option.id}
              type="button"
              className={`bbs-icon-picker__cell bbs-icon-picker__color ${projectIconColorClass(option.id)}`}
              aria-label={option.label}
              aria-pressed={selected}
              tabIndex={selected ? 0 : -1}
              data-color={option.id}
              data-selected={selected || undefined}
              onClick={() => pickColor(option.id)}
            >
              <span className="bbs-icon-picker__swatch" />
              {selected ? (
                <span className="bbs-icon-picker__check">
                  <PickerGlyph name="check" />
                </span>
              ) : null}
            </button>
          );
        })}
      </fieldset>
      <div className="bbs-icon-picker__rule" aria-hidden="true" />
      <div className={`bbs-icon-picker__scroll ${projectIconColorClass(color)}`} data-icon-color-picker-tint={color}>
        {cells.length > 0 ? (
          <div ref={gridRef} role="group" aria-label="Icons" className="bbs-icon-picker__grid" style={{ height }} onKeyDown={onGridKeyDown}>
            {cells.map((name, index) => {
              const none = name === NONE;
              const selected = index === selectedIndex;
              return (
                <button
                  key={name}
                  type="button"
                  className="bbs-icon-picker__cell bbs-icon-picker__icon"
                  aria-label={none ? "No icon" : name}
                  title={none ? "No icon" : name}
                  aria-pressed={selected}
                  tabIndex={index === activeIndex ? 0 : -1}
                  data-icon-color-picker-option={name}
                  data-icon-color-picker-none={none || undefined}
                  data-selected={selected || undefined}
                  onFocus={() => setActiveCell(name)}
                  onClick={() => choose(name)}
                >
                  {none ? <PickerGlyph name="none" /> : <ProjectIconGlyph name={name} />}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="bbs-icon-picker__empty">No icons found</div>
        )}
      </div>
    </div>
  );
}

function place(anchor: HTMLElement, popup: HTMLElement): { top: number; left: number } {
  const rect = anchor.getBoundingClientRect();
  const width = popup.offsetWidth;
  const height = popup.offsetHeight;
  const below = rect.bottom + OFFSET;
  const fitsBelow = below + height <= window.innerHeight - EDGE_GAP;
  const above = rect.top - OFFSET - height;
  const top = fitsBelow || above < EDGE_GAP ? Math.max(EDGE_GAP, Math.min(below, window.innerHeight - EDGE_GAP - height)) : above;
  const left = Math.max(EDGE_GAP, Math.min(rect.left, window.innerWidth - EDGE_GAP - width));
  return { top, left };
}

export function ProjectIconPicker({
  anchor,
  open,
  onOpenChange,
  value,
  onChange,
  label = "Icon color picker",
  clearable = true,
}: {
  anchor: HTMLElement | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: ProjectIcon | null;
  onChange: (icon: ProjectIcon | null) => void;
  label?: string;
  clearable?: boolean;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  if (anchor !== null) anchorRef.current = anchor;
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const close = useCallback(() => {
    onOpenChange(false);
    const target = anchorRef.current;
    if (target?.isConnected) target.focus({ preventScroll: true });
  }, [onOpenChange]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const update = () => {
      const target = anchorRef.current;
      const popup = popupRef.current;
      if (target && popup) setPosition(place(target, popup));
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, anchor]);

  useLayoutEffect(() => {
    const popup = popupRef.current;
    if (!open || position === null || !popup || popup.contains(document.activeElement)) return;
    popup.querySelector<HTMLInputElement>(".bbs-icon-picker__input")?.focus({ preventScroll: true });
  }, [open, position]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && (popupRef.current?.contains(target) || anchorRef.current?.contains(target))) return;
      onOpenChange(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open, close, onOpenChange]);

  const onBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && !popupRef.current?.contains(next) && !anchorRef.current?.contains(next)) onOpenChange(false);
  };

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={popupRef}
      role="dialog"
      aria-label={label}
      className="bbs-icon-picker-popover"
      data-ui-icon-color-picker-popover=""
      onBlur={onBlur}
      style={position ? { top: position.top, left: position.left } : { top: 0, left: 0, opacity: 0, pointerEvents: "none" }}
    >
      <ProjectIconPickerPanel value={value} onChange={onChange} onDone={close} clearable={clearable} />
    </div>,
    document.body,
  );
}
