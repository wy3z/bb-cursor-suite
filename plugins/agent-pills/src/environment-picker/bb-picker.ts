export const COMPOSER_ROOT = "[data-app-composer]";
export const NEW_THREAD_FOOTER = "[data-new-thread-footer]";
export const PROJECT_CONTROL = "[data-promptbox-project-control]";
export const BB_ENVIRONMENT_CONTROL = 'button[aria-label="Environment"][data-promptbox-shrinkable-control]';
export const REPLACED_ATTRIBUTE = "data-bb-agent-pills-environment-replaced";
export const SLOT_ATTRIBUTE = "data-bb-agent-pills-environment-slot";

export interface BbEnvironmentPicker {
  root: HTMLElement;
  row: HTMLElement;
  button: HTMLElement;
}

export function findBbEnvironmentPicker(anchor: Element | null): BbEnvironmentPicker | null {
  const root = anchor?.closest<HTMLElement>(COMPOSER_ROOT) ?? null;
  if (root === null) return null;
  const projects = root.querySelectorAll<HTMLElement>(PROJECT_CONTROL);
  if (projects.length !== 1) return null;
  const buttons = Array.from(root.querySelectorAll<HTMLElement>(BB_ENVIRONMENT_CONTROL)).filter(
    (button) => button.closest(`[${SLOT_ATTRIBUTE}]`) === null,
  );
  if (buttons.length !== 1) return null;
  const [project] = projects;
  const [button] = buttons;
  const row = button!.parentElement;
  if (row === null || row !== project!.parentElement) return null;
  const footer = row.closest<HTMLElement>(NEW_THREAD_FOOTER);
  if (footer === null || !root.contains(footer)) return null;
  if (button!.querySelector("[data-promptbox-full-label]") === null) return null;
  return { root, row, button: button! };
}
