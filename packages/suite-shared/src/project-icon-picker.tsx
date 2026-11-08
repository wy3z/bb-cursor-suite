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
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  PROJECT_ICON_COLORS,
  PROJECT_ICON_IMAGE_EDGE,
  filterProjectIconNames,
  isProjectIconPickerColor,
  projectIconColorClass,
  type ProjectIcon,
  type ProjectIconPickerColor,
  type ProjectIconShape,
} from "./project-icon";

type GlyphModule = typeof import("./project-icon-glyphs");

let glyphModule: GlyphModule | null = null;
let glyphLoad: Promise<void> | null = null;
const glyphListeners = new Set<() => void>();

export function preloadProjectIconGlyphs(): Promise<void> {
  if (glyphModule) return Promise.resolve();
  glyphLoad ??= import("./project-icon-glyphs").then(
    (loaded) => {
      glyphModule = loaded;
      for (const listener of glyphListeners) listener();
    },
    (error: unknown) => {
      glyphLoad = null;
      throw error;
    },
  );
  return glyphLoad;
}

function subscribeGlyphs(listener: () => void) {
  glyphListeners.add(listener);
  return () => glyphListeners.delete(listener);
}

function useGlyphModule(): GlyphModule | null {
  const loaded = useSyncExternalStore(subscribeGlyphs, () => glyphModule, () => null);
  useEffect(() => {
    if (!loaded) void preloadProjectIconGlyphs().catch(() => undefined);
  }, [loaded]);
  return loaded;
}

function Shape({ shape, className, strokeWidth }: { shape: ProjectIconShape | undefined; className?: string; strokeWidth: number }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true" focusable="false" data-bbs-glyph="">
      {(shape ?? []).map(([tag, attrs], index) => {
        const { key: _key, ...rest } = attrs as Record<string, string | number>;
        return createElement(tag, { ...rest, key: index, ...("strokeWidth" in rest ? { strokeWidth } : {}) });
      })}
    </svg>
  );
}

export function ProjectIconGlyph({ name, className, strokeWidth = 1.5 }: { name: string; className?: string; strokeWidth?: number }) {
  const glyphs = useGlyphModule();
  return <Shape shape={glyphs?.PROJECT_ICON_GLYPHS[name]} className={className} strokeWidth={strokeWidth} />;
}

function PickerGlyph({ name, className }: { name: keyof GlyphModule["PICKER_GLYPHS"]; className?: string }) {
  const glyphs = useGlyphModule();
  return <Shape shape={glyphs?.PICKER_GLYPHS[name]} className={className} strokeWidth={1.5} />;
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

function stopSearchKeys(event: ReactKeyboardEvent<HTMLInputElement>) {
  if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation();
}

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
  const scrollRef = useRef<HTMLDivElement>(null);
  const glyphValue = value?.kind === "glyph" ? value : null;
  const color = glyphValue ? pickerColorOf(glyphValue) : pendingColor;

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [deferred]);

  const names = filterProjectIconNames(deferred, glyphValue?.name);
  const cells = clearable ? [NONE, ...names] : names;
  const height = gridHeight(cells.length);

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

  const onGridClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-icon-color-picker-option]") : null;
    const option = target?.dataset.iconColorPickerOption;
    if (option === undefined) return;
    if (option === NONE) {
      if (value !== null) onChange(null);
      onDone?.();
      return;
    }
    onChange({ kind: "glyph", name: option, color });
    onDone?.();
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
          onKeyDown={stopSearchKeys}
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
      <fieldset className="bbs-icon-picker__colors" aria-label="Icon color">
        {PROJECT_ICON_COLORS.map((option) => {
          const selected = option.id === color;
          return (
            <button
              key={option.id}
              type="button"
              className={`bbs-icon-picker__cell bbs-icon-picker__color ${projectIconColorClass(option.id)}`}
              aria-label={option.label}
              aria-pressed={selected}
              data-selected={selected || undefined}
              onClick={() => {
                setPendingColor(option.id);
                if (glyphValue) onChange({ kind: "glyph", name: glyphValue.name, color: option.id });
              }}
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
          <div ref={scrollRef} role="group" aria-label="Icons" className="bbs-icon-picker__grid" style={{ height }} onClick={onGridClick}>
            {cells.map((name) => {
              const none = name === NONE;
              const selected = none ? value === null : glyphValue?.name === name;
              return (
                <button
                  key={name}
                  type="button"
                  className="bbs-icon-picker__cell bbs-icon-picker__icon"
                  aria-label={none ? "No icon" : name}
                  title={none ? "No icon" : name}
                  aria-pressed={selected}
                  data-icon-color-picker-option={name}
                  data-icon-color-picker-none={none || undefined}
                  data-selected={selected || undefined}
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

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={popupRef}
      role="dialog"
      aria-label={label}
      className="bbs-icon-picker-popover"
      data-ui-icon-color-picker-popover=""
      style={position ? { top: position.top, left: position.left } : { top: 0, left: 0, visibility: "hidden" }}
    >
      <ProjectIconPickerPanel value={value} onChange={onChange} onDone={close} clearable={clearable} />
    </div>,
    document.body,
  );
}
