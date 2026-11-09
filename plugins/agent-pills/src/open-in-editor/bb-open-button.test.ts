import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { HIDDEN_ATTRIBUTE, findBbOpenButton, findBbOpenMenuItems, touchesOpenButton, watchBbOpenButton } from "./bb-open-button";
import { isCloudProvider, resetCloudLookups, threadOnCloudMachine, type CloudLookupSdk } from "./cloud";

const OPEN_BUTTON = `<span class="inline-flex" data-thread-header-responsive-action="" id="action"><span class="inline-flex items-center gap-1.5"><div class="inline-flex items-center"><button type="button" aria-label="Open workspace in Cursor (Ctrl + O)" id="open"><img alt=""></button><span class="inline-flex"><button type="button" aria-label="Choose another app to open workspace"><span data-icon="ChevronDown"></span></button></span></div></span></span>`;

const PANE = `
  <div data-split-pane-id="pane-1" id="pane">
    <header>
      <div data-testid="app-page-header-content-row">
        <span><button type="button" id="trigger" aria-label="Thread actions" aria-haspopup="menu" aria-expanded="false" data-state="closed"></button></span>
        <div><div class="flex items-center gap-1" data-thread-header-workflow-actions="" id="header">${OPEN_BUTTON}</div></div>
      </div>
    </header>
    <div data-thread-window="">
      <div data-scroll-footer="">
        <div data-app-composer="" data-app-composer-role="primary" data-promptbox-shell="">
          <div data-promptbox-action-row="">
            <div data-plugin-composer-action=""><span id="anchor" data-bb-agent-pills-open-in-anchor="" hidden></span></div>
          </div>
        </div>
      </div>
    </div>
  </div>`;

function load(html: string): Document {
  return new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document;
}

function window(document: Document): typeof globalThis {
  return document.defaultView as unknown as typeof globalThis;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("findBbOpenButton", () => {
  it("finds BB's Open in split button in the anchor's own pane header", () => {
    const document = load(PANE);
    const found = findBbOpenButton(document.getElementById("anchor"));
    expect(found?.action).toBe(document.getElementById("action"));
    expect(found?.pane).toBe(document.getElementById("pane"));
  });

  it("matches any editor name, not just Cursor", () => {
    const document = load(PANE.replace("Open workspace in Cursor (Ctrl + O)", "Open workspace in Zed"));
    expect(findBbOpenButton(document.getElementById("anchor"))?.action.id).toBe("action");
  });

  it("gives up when BB renames either button", () => {
    expect(findBbOpenButton(load(PANE.replace("Open workspace in Cursor", "Open in Cursor")).getElementById("anchor"))).toBeNull();
    expect(findBbOpenButton(load(PANE.replace("Choose another app to open workspace", "More")).getElementById("anchor"))).toBeNull();
    expect(findBbOpenButton(load(PANE.replace('aria-label="Open workspace in Cursor (Ctrl + O)"', 'aria-label="Open workspace in "')).getElementById("anchor"))).toBeNull();
  });

  it("gives up when the responsive-action or header markers are gone", () => {
    expect(findBbOpenButton(load(PANE.replace(' data-thread-header-responsive-action=""', "")).getElementById("anchor"))).toBeNull();
    expect(findBbOpenButton(load(PANE.replace(' data-thread-header-workflow-actions=""', "")).getElementById("anchor"))).toBeNull();
  });

  it("gives up when the button is not a direct child of the header actions", () => {
    const nested = PANE.replace(OPEN_BUTTON, `<div>${OPEN_BUTTON}</div>`);
    expect(findBbOpenButton(load(nested).getElementById("anchor"))).toBeNull();
  });

  it("gives up when two Open in buttons are in the pane", () => {
    const doubled = PANE.replace(OPEN_BUTTON, OPEN_BUTTON + OPEN_BUTTON.replace('id="action"', "").replace('id="open"', ""));
    expect(findBbOpenButton(load(doubled).getElementById("anchor"))).toBeNull();
    const elsewhere = PANE.replace('<div data-thread-window="">', '<div data-thread-window=""><button aria-label="Open workspace in Finder"></button>');
    expect(findBbOpenButton(load(elsewhere).getElementById("anchor"))).toBeNull();
  });

  it("gives up when the split button gains another button", () => {
    const extra = PANE.replace('<span class="inline-flex"><button', '<button aria-label="Pin"></button><span class="inline-flex"><button');
    expect(findBbOpenButton(load(extra).getElementById("anchor"))).toBeNull();
  });

  it("gives up outside a split pane, outside a primary composer, or with two composers", () => {
    expect(findBbOpenButton(load(PANE.replace(' data-split-pane-id="pane-1"', "")).getElementById("anchor"))).toBeNull();
    expect(findBbOpenButton(load(PANE.replace(' data-app-composer-role="primary"', "")).getElementById("anchor"))).toBeNull();
    const two = PANE.replace('<div data-thread-window="">', '<div data-thread-window=""><div data-app-composer="" data-app-composer-role="primary"></div>');
    expect(findBbOpenButton(load(two).getElementById("anchor"))).toBeNull();
    expect(findBbOpenButton(null)).toBeNull();
  });

  it("only looks in the anchor's own pane", () => {
    const other = PANE.replace('id="anchor"', "").replace('id="action"', 'id="other-action"').replace('id="pane"', "").replace('data-split-pane-id="pane-1"', 'data-split-pane-id="pane-2"');
    const document = load(`${other}${PANE}`);
    expect(findBbOpenButton(document.getElementById("anchor"))?.action.id).toBe("action");
  });
});

describe("watchBbOpenButton", () => {
  it("hides BB's button, hides its replacement after a re-render, and shows it again when disposed", async () => {
    const document = load(PANE);
    const previous = globalThis.MutationObserver;
    globalThis.MutationObserver = window(document).MutationObserver;
    try {
      const stop = watchBbOpenButton(document.getElementById("anchor")!);
      expect(document.getElementById("action")!.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(true);
      const header = document.getElementById("header")!;
      header.innerHTML = OPEN_BUTTON.replace('id="action"', 'id="fresh"');
      await settle();
      expect(document.getElementById("fresh")!.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(true);
      header.insertAdjacentHTML("beforeend", OPEN_BUTTON.replace('id="action"', 'id="second"').replace('id="open"', ""));
      await settle();
      expect(document.querySelectorAll(`[${HIDDEN_ATTRIBUTE}]`)).toHaveLength(0);
      document.getElementById("second")!.remove();
      await settle();
      expect(document.getElementById("fresh")!.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(true);
      stop();
      expect(document.querySelectorAll(`[${HIDDEN_ATTRIBUTE}]`)).toHaveLength(0);
    } finally {
      globalThis.MutationObserver = previous;
    }
  });

  it("leaves the button alone when the match isn't strict", () => {
    const document = load(PANE.replace("Choose another app to open workspace", "More"));
    const previous = globalThis.MutationObserver;
    globalThis.MutationObserver = window(document).MutationObserver;
    try {
      const stop = watchBbOpenButton(document.getElementById("anchor")!);
      expect(document.querySelectorAll(`[${HIDDEN_ATTRIBUTE}]`)).toHaveLength(0);
      stop();
    } finally {
      globalThis.MutationObserver = previous;
    }
  });
});

const item = (label: string, icon = "FolderOpen", id = "") =>
  `<button type="button" role="menuitem"${id ? ` id="${id}"` : ""}><span aria-hidden="true" data-icon="${icon}"></span>${label}</button>`;

const DRAWER = `
  <div data-bb-portaled-overlay="" aria-labelledby="drawer-title" aria-modal="true" data-persistent-drawer-content="" data-state="open" role="dialog" id="drawer">
    <h2 id="drawer-title">Thread actions</h2>
    <div id="items">${item("Open workspace in Cursor", "FolderOpen", "first")}${item("Open workspace in Zed", "FolderOpen", "second")}<hr id="rule">${item("Copy link", "Copy", "copy")}<hr id="later">${item("Archive", "Archive")}</div>
  </div>`;

function openMenu(html: string, drawer = DRAWER): Document {
  return load(html.replace('aria-expanded="false" data-state="closed"', 'aria-expanded="true" data-state="open"') + drawer);
}

describe("findBbOpenMenuItems", () => {
  it("finds the leading run of Open workspace items and its separator in the open Thread actions drawer", () => {
    const document = openMenu(PANE);
    expect(findBbOpenMenuItems(document.getElementById("anchor"))?.map((element) => element.id)).toEqual(["first", "second", "rule"]);
  });

  it("does nothing while the pane's menu is closed", () => {
    expect(findBbOpenMenuItems(load(PANE + DRAWER).getElementById("anchor"))).toBeNull();
  });

  it("matches a dropdown labelled by the trigger as well as the drawer", () => {
    const menu = `<div role="menu" data-state="open" aria-labelledby="trigger">${item("Open workspace in Cursor", "FolderOpen", "first")}<div role="separator" id="rule"></div>${item("Rename", "Edit")}</div>`;
    const document = openMenu(PANE, menu);
    expect(findBbOpenMenuItems(document.getElementById("anchor"))?.map((element) => element.id)).toEqual(["first", "rule"]);
  });

  it("gives up when the drawer isn't titled Thread actions, or two menus are open", () => {
    expect(findBbOpenMenuItems(openMenu(PANE, DRAWER.replace(">Thread actions<", ">Actions<")).getElementById("anchor"))).toBeNull();
    const second = `<div aria-labelledby="t2" data-persistent-drawer-content="" data-state="open" role="dialog"><h2 id="t2">Thread actions</h2><div>${item("Open workspace in Cursor")}<hr></div></div>`;
    expect(findBbOpenMenuItems(openMenu(PANE, DRAWER + second).getElementById("anchor"))).toBeNull();
  });

  it("gives up when another pane's menu is the open one, or two are open", () => {
    const other = PANE.replace('id="anchor"', "").replace('id="pane"', "").replace('id="trigger"', 'id="other-trigger"');
    const elsewhere = load(other.replace('aria-expanded="false" data-state="closed"', 'aria-expanded="true" data-state="open"') + PANE + DRAWER);
    expect(findBbOpenMenuItems(elsewhere.getElementById("anchor"))).toBeNull();
    const both = openMenu(other.replace('aria-expanded="false" data-state="closed"', 'aria-expanded="true" data-state="open"') + PANE);
    expect(findBbOpenMenuItems(both.getElementById("anchor"))).toBeNull();
  });

  it("gives up when the items aren't one run bounded by separators, or lack the folder icon", () => {
    expect(findBbOpenMenuItems(openMenu(PANE, DRAWER.replace('<hr id="rule">', "")).getElementById("anchor"))).toBeNull();
    const split = DRAWER.replace(item("Open workspace in Zed", "FolderOpen", "second"), item("Copy link", "Copy") + item("Open workspace in Zed", "FolderOpen", "second"));
    expect(findBbOpenMenuItems(openMenu(PANE, split).getElementById("anchor"))).toBeNull();
    expect(findBbOpenMenuItems(openMenu(PANE, DRAWER.replace('data-icon="FolderOpen"', 'data-icon="Folder"')).getElementById("anchor"))?.map((element) => element.id)).toBeUndefined();
  });

  it("keeps a lone trailing run's leading separator so no line is left at the end", () => {
    const tail = `<div data-bb-portaled-overlay="" aria-labelledby="dt" data-persistent-drawer-content="" data-state="open" role="dialog"><h2 id="dt">Thread actions</h2><div>${item("Rename", "Edit")}<hr id="rule">${item("Open workspace in Cursor", "FolderOpen", "first")}</div></div>`;
    expect(findBbOpenMenuItems(openMenu(PANE, tail).getElementById("anchor"))?.map((element) => element.id)).toEqual(["first", "rule"]);
  });
});

describe("watchBbOpenButton and the menu", () => {
  it("hides the menu entries when the drawer opens after the trigger, and restores them when disposed", async () => {
    const document = load(PANE);
    const previous = globalThis.MutationObserver;
    globalThis.MutationObserver = window(document).MutationObserver;
    try {
      const stop = watchBbOpenButton(document.getElementById("anchor")!);
      const trigger = document.getElementById("trigger")!;
      trigger.setAttribute("aria-expanded", "true");
      trigger.setAttribute("data-state", "open");
      await settle();
      document.body.insertAdjacentHTML("beforeend", DRAWER);
      await settle();
      expect(["first", "second", "rule"].every((id) => document.getElementById(id)!.hasAttribute(HIDDEN_ATTRIBUTE))).toBe(true);
      expect(document.getElementById("copy")!.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(false);
      expect(document.getElementById("action")!.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(true);
      stop();
      expect(document.querySelectorAll(`[${HIDDEN_ATTRIBUTE}]`)).toHaveLength(0);
    } finally {
      globalThis.MutationObserver = previous;
    }
  });
});

describe("touchesOpenButton", () => {
  it("reacts to header and composer changes and ignores the timeline", () => {
    const document = load(`${PANE}<div id="timeline"><p>text</p></div>`);
    const none = document.querySelectorAll("nothing");
    expect(touchesOpenButton({ target: document.getElementById("open")!, addedNodes: none, removedNodes: none })).toBe(true);
    expect(touchesOpenButton({ target: document.getElementById("trigger")!, addedNodes: none, removedNodes: none })).toBe(true);
    expect(touchesOpenButton({ target: document.getElementById("timeline")!, addedNodes: none, removedNodes: none })).toBe(false);
    expect(touchesOpenButton({ target: document.getElementById("timeline")!, addedNodes: document.querySelectorAll("#header"), removedNodes: none })).toBe(true);
    expect(touchesOpenButton({ target: document.getElementById("timeline")!, addedNodes: none, removedNodes: document.querySelectorAll("[data-app-composer]") })).toBe(true);
  });
});

function sdk(hosts: Record<string, string | null>, environments: Record<string, string>, threads: Record<string, string | null>, calls: string[] = []): CloudLookupSdk {
  return {
    threads: {
      get: async ({ threadId }) => {
        calls.push(`thread:${threadId}`);
        if (!(threadId in threads)) throw new Error("missing");
        return { environmentId: threads[threadId] };
      },
    },
    environments: {
      get: async ({ environmentId }) => {
        calls.push(`environment:${environmentId}`);
        return { hostId: environments[environmentId]! };
      },
    },
    hosts: {
      get: async ({ hostId }) => {
        calls.push(`host:${hostId}`);
        if (!(hostId in hosts)) throw new Error("missing");
        return { machineProviderId: hosts[hostId] };
      },
    },
  };
}

describe("threadOnCloudMachine", () => {
  it("says yes only when the thread's host has a machine provider", async () => {
    resetCloudLookups();
    const api = sdk({ local: null, boat: "boat-sandbox" }, { e1: "local", e2: "boat" }, { t1: "e1", t2: "e2", t3: null });
    expect(await threadOnCloudMachine(api, "t1")).toBe(false);
    expect(await threadOnCloudMachine(api, "t2")).toBe(true);
    expect(await threadOnCloudMachine(api, "t3")).toBeNull();
    expect(await threadOnCloudMachine(api, "missing")).toBeNull();
  });

  it("caches per environment and retries after a failure", async () => {
    resetCloudLookups();
    const calls: string[] = [];
    const hosts: Record<string, string | null> = {};
    const api = sdk(hosts, { e1: "h1" }, { t1: "e1" }, calls);
    expect(await threadOnCloudMachine(api, "t1")).toBeNull();
    hosts.h1 = "boat-sandbox";
    expect(await threadOnCloudMachine(api, "t1")).toBe(true);
    expect(await threadOnCloudMachine(api, "t1")).toBe(true);
    expect(calls.filter((call) => call === "host:h1")).toHaveLength(2);
  });

  it("treats a blank provider id as local", () => {
    expect(isCloudProvider("boat-sandbox")).toBe(true);
    expect(isCloudProvider("")).toBe(false);
    expect(isCloudProvider("  ")).toBe(false);
    expect(isCloudProvider(null)).toBe(false);
    expect(isCloudProvider(undefined)).toBe(false);
  });
});
