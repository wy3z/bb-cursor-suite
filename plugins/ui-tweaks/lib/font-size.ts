/** Stored as whole CSS points; one point is 96/72 CSS pixels. */
export function readFontSizeOffset(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.max(-6, Math.min(18, value))
    : 0;
}

export const SECTION_FONT_SIZE_MIN = -6;
export const SECTION_FONT_SIZE_MAX = 12;

/**
 * Containers whose text can be resized on their own. Order matters: nested
 * sections come after the sections that contain them, so their rules win.
 */
export const FONT_SIZE_SECTIONS = [
  { id: "main", label: "Main area", description: "Settings and other pages", selector: "[data-app-content-shell]" },
  { id: "sidebar", label: "Sidebar", description: "Projects, threads and navigation", selector: '[data-sidebar="sidebar"]' },
  { id: "header", label: "Thread header", description: "Title row above the chat", selector: '[data-testid="app-page-header-content-row"]' },
  { id: "chat", label: "Chat", description: "Messages and tool output", selector: "[data-thread-window]" },
  { id: "composer", label: "Prompt box", description: "Where you type", selector: "[data-app-composer]" },
  { id: "panel", label: "Right panel", description: "Files, changes and other side tabs", selector: "#thread-detail-secondary-panel" },
  { id: "menus", label: "Menus & popovers", description: "Dropdowns, tooltips and dialogs", selector: '[data-radix-popper-content-wrapper], [role="dialog"]' },
] as const;

export type FontSizeSectionId = (typeof FONT_SIZE_SECTIONS)[number]["id"] | "code";

export const CODE_FONT_SIZE_SECTION = {
  id: "code",
  label: "Code",
  description: "Inline code and code blocks, on top of their section",
} as const;

export type SectionFontSizes = Partial<Record<FontSizeSectionId, number>>;

const SECTION_IDS = new Set<string>([
  ...FONT_SIZE_SECTIONS.map((section) => section.id),
  CODE_FONT_SIZE_SECTION.id,
]);
const CODE_SELECTOR = "code, pre, kbd, samp";
// Tailwind 4 sizes text through these variables, so overriding them inside a
// container resizes its text without touching spacing.
const TEXT_SIZE_TOKENS = ["2xs", "xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl"];

export function readSectionFontSize(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.max(SECTION_FONT_SIZE_MIN, Math.min(SECTION_FONT_SIZE_MAX, value))
    : 0;
}

export function readSectionFontSizes(value: unknown): SectionFontSizes {
  if (typeof value !== "object" || value === null) return {};
  const sizes: SectionFontSizes = {};
  for (const [id, offset] of Object.entries(value)) {
    const size = readSectionFontSize(offset);
    if (SECTION_IDS.has(id) && size !== 0) sizes[id as FontSizeSectionId] = size;
  }
  return sizes;
}

function sectionRules(
  sizes: SectionFontSizes,
  tokens: Array<[string, string]>,
  bodyFontSize: number,
): string {
  if (!Object.values(sizes).some((size) => size !== 0)) return "";

  const declarations = (offset: number, withFontSize: boolean) => [
    ...tokens.map(([token, value]) => `--text-${token}: max(6pt, calc(${value} + ${offset}pt));`),
    ...(withFontSize ? [`font-size: max(6pt, calc(${bodyFontSize}px + ${offset}pt)) !important;`] : []),
  ].join(" ");

  const code = sizes.code ?? 0;
  const rules = [`:is(${CODE_SELECTOR}) { ${declarations(code, false)} }`];
  // Every section gets a rule, even at 0, so it resets anything inherited
  // from an enclosing section.
  for (const section of FONT_SIZE_SECTIONS) {
    const offset = sizes[section.id] ?? 0;
    rules.push(`:is(${section.selector}) { ${declarations(offset, true)} }`);
    rules.push(`:is(${section.selector}) :is(${CODE_SELECTOR}) { ${declarations(offset + code, false)} }`);
  }
  return rules.join("\n");
}

export function mountFontSizeModifier(read: () => {
  fontSizeOffset: number;
  sectionFontSizes: SectionFontSizes;
}): {
  refresh: () => void;
  dispose: () => void;
} {
  const style = document.createElement("style");
  style.dataset.bbUiTweaksFontSize = "true";
  document.head.append(style);
  let frame = 0;

  const refresh = () => {
    const { fontSizeOffset, sectionFontSizes } = read();
    // Measure the active theme without our override, so changes never compound.
    style.disabled = true;
    const rootStyle = getComputedStyle(document.documentElement);
    const base = Number.parseFloat(rootStyle.fontSize);
    const tokens = TEXT_SIZE_TOKENS
      .map((token) => [token, rootStyle.getPropertyValue(`--text-${token}`).trim()] as [string, string])
      .filter(([, value]) => value !== "");
    const offset = readFontSizeOffset(fontSizeOffset);
    const globalRule = offset === 0 || !Number.isFinite(base)
      ? ""
      : `html:root { font-size: max(6pt, calc(${base}px + ${offset}pt)) !important; }`;

    // Section containers inherit the body size, which follows the global rule.
    let bodyFontSize = Number.parseFloat(getComputedStyle(document.body).fontSize);
    if (globalRule) {
      style.textContent = globalRule;
      style.disabled = false;
      bodyFontSize = Number.parseFloat(getComputedStyle(document.body).fontSize);
    }
    const rule = [
      globalRule,
      Number.isFinite(bodyFontSize) ? sectionRules(sectionFontSizes, tokens, bodyFontSize) : "",
    ].filter(Boolean).join("\n");
    if (style.textContent !== rule) style.textContent = rule;
    style.disabled = false;
  };
  const queueRefresh = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      refresh();
    });
  };
  const observer = new MutationObserver((records) => {
    if (records.some((record) => record.target !== style && !style.contains(record.target))) {
      queueRefresh();
    }
  });
  observer.observe(document.documentElement, { attributes: true });
  observer.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true });
  window.addEventListener("resize", queueRefresh);
  document.head.addEventListener("load", queueRefresh, true);
  refresh();

  return {
    refresh,
    dispose() {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", queueRefresh);
      document.head.removeEventListener("load", queueRefresh, true);
      style.remove();
    },
  };
}
