export function startSendContextMenu(signal: AbortSignal): void {
  const onContextMenu = (event: MouseEvent) => {
    if (document.documentElement.getAttribute("data-bb-agent-pills-composer") !== "cursor") return;
    const target = event.target instanceof Element ? event.target : null;
    const submit = target?.closest<HTMLElement>("form[data-promptbox] [data-promptbox-submit-action]");
    if (!submit) return;
    const options = submit
      .closest("[data-promptbox-send-menu]")
      ?.querySelector<HTMLButtonElement>('button[aria-label="Send options"]');
    if (!options || options.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    options.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerType: "mouse", isPrimary: true }),
    );
  };
  document.addEventListener("contextmenu", onContextMenu, true);
  signal.addEventListener("abort", () => document.removeEventListener("contextmenu", onContextMenu, true));
}
