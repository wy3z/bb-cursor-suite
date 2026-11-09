import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { SLOT_ATTRIBUTE, findBbEnvironmentPicker } from "./bb-picker";

const BB_FOOTER = `
  <div data-app-composer="" data-app-composer-role="primary">
    <form data-promptbox="">
      <div data-promptbox-action-row="">
        <span id="anchor" data-bb-agent-pills-environment-anchor=""></span>
      </div>
    </form>
    <div data-new-thread-footer="">
      <div id="row">
        <button type="button" aria-label="Project: demo" data-promptbox-project-control="">demo</button>
        <button type="button" id="env" aria-label="Environment" data-promptbox-shrinkable-control="">
          <span data-promptbox-full-label="">Project checkout</span>
        </button>
        <div class="contents"></div>
      </div>
    </div>
  </div>`;

function load(html: string): Document {
  return new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document;
}

describe("findBbEnvironmentPicker", () => {
  it("finds BB's environment button beside the project control in the new-thread footer", () => {
    const document = load(BB_FOOTER);
    const found = findBbEnvironmentPicker(document.getElementById("anchor"));
    expect(found?.button).toBe(document.getElementById("env"));
    expect(found?.row).toBe(document.getElementById("row"));
  });

  it("gives up when BB renames the control", () => {
    const document = load(BB_FOOTER.replace('aria-label="Environment"', 'aria-label="Workspace"'));
    expect(findBbEnvironmentPicker(document.getElementById("anchor"))).toBeNull();
  });

  it("gives up when the shrinkable marker or label structure is gone", () => {
    expect(findBbEnvironmentPicker(load(BB_FOOTER.replace(' data-promptbox-shrinkable-control=""', "")).getElementById("anchor"))).toBeNull();
    expect(findBbEnvironmentPicker(load(BB_FOOTER.replace(' data-promptbox-full-label=""', "")).getElementById("anchor"))).toBeNull();
  });

  it("gives up when the button is not beside the project control", () => {
    const moved = BB_FOOTER.replace(
      /(<button type="button" id="env"[\s\S]*?<\/button>)/,
      "<div>$1</div>",
    );
    expect(findBbEnvironmentPicker(load(moved).getElementById("anchor"))).toBeNull();
  });

  it("gives up outside the new-thread footer", () => {
    const document = load(BB_FOOTER.replace(' data-new-thread-footer=""', ""));
    expect(findBbEnvironmentPicker(document.getElementById("anchor"))).toBeNull();
  });

  it("gives up when two candidates match", () => {
    const doubled = BB_FOOTER.replace(
      '<div class="contents"></div>',
      '<button type="button" aria-label="Environment" data-promptbox-shrinkable-control=""><span data-promptbox-full-label="">x</span></button>',
    );
    expect(findBbEnvironmentPicker(load(doubled).getElementById("anchor"))).toBeNull();
  });

  it("gives up without exactly one project control", () => {
    const document = load(BB_FOOTER.replace(' data-promptbox-project-control=""', ""));
    expect(findBbEnvironmentPicker(document.getElementById("anchor"))).toBeNull();
  });

  it("gives up outside a composer", () => {
    const document = load(`<span id="anchor"></span>${BB_FOOTER.replace('id="anchor"', "")}`);
    expect(findBbEnvironmentPicker(document.getElementById("anchor"))).toBeNull();
    expect(findBbEnvironmentPicker(null)).toBeNull();
  });

  it("only looks inside the anchor's own composer", () => {
    const other = BB_FOOTER.replace('id="anchor"', "").replace('id="env"', 'id="other-env"').replace('id="row"', "");
    const document = load(`${other}${BB_FOOTER}`);
    expect(findBbEnvironmentPicker(document.getElementById("anchor"))?.button).toBe(document.getElementById("env"));
  });

  it("ignores an environment button inside its own slot", () => {
    const withSlot = BB_FOOTER.replace(
      '<div class="contents"></div>',
      `<span ${SLOT_ATTRIBUTE}=""><button type="button" aria-label="Environment" data-promptbox-shrinkable-control=""><span data-promptbox-full-label="">x</span></button></span>`,
    );
    expect(findBbEnvironmentPicker(load(withSlot).getElementById("anchor"))?.button.id).toBe("env");
  });
});
