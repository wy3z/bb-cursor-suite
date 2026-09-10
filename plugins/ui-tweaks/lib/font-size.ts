/** Stored as whole CSS points; one point is 96/72 CSS pixels. */
export function readFontSizeOffset(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.max(-6, Math.min(18, value))
    : 0;
}

export function mountFontSizeModifier(readOffset: () => number): {
  refresh: () => void;
  dispose: () => void;
} {
  const style = document.createElement("style");
  style.dataset.bbUiTweaksFontSize = "true";
  document.head.append(style);
  let frame = 0;

  const refresh = () => {
    // Measure the active theme without our override, so changes never compound.
    style.disabled = true;
    const base = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    const offset = readFontSizeOffset(readOffset());
    const rule = offset === 0 || !Number.isFinite(base)
      ? ""
      : `html:root { font-size: max(6pt, calc(${base}px + ${offset}pt)) !important; }`;
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
