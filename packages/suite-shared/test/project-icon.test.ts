import { describe, expect, it } from "bun:test";
import {
  PROJECT_ICON_CATALOG,
  PROJECT_ICON_COLORS,
  PROJECT_ICON_NAMES,
  checkPngBytes,
  filterProjectIconNames,
  findProjectIconName,
  isPngDataUrl,
  parseProjectIcon,
  serializeProjectIcon,
  type ProjectIcon,
} from "../src/project-icon";
import { PICKER_GLYPHS, PROJECT_ICON_GLYPHS } from "../src/project-icon-glyphs";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

function png(width: number, height: number, size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe("project icon parsing", () => {
  it("reads every stored form", () => {
    expect(parseProjectIcon("glyph:rocket:blue")).toEqual({ kind: "glyph", name: "rocket", color: "blue" });
    expect(parseProjectIcon("glyph:rocket:default")).toEqual({ kind: "glyph", name: "rocket", color: "default" });
    expect(parseProjectIcon("glyph:git-branch:brand")).toEqual({ kind: "glyph", name: "git-branch", color: "brand" });
    expect(parseProjectIcon("emoji:🚀")).toEqual({ kind: "emoji", emoji: "🚀" });
    expect(parseProjectIcon("monogram:ab:magenta")).toEqual({ kind: "monogram", text: "AB", color: "magenta" });
    expect(parseProjectIcon(PNG)).toEqual({ kind: "image", src: PNG });
  });

  it("keeps reading values written before the Cursor port", () => {
    expect(parseProjectIcon("glyph:Rocket:violet")).toEqual({ kind: "glyph", name: "Rocket", color: "violet" });
    expect(parseProjectIcon("glyph:FolderCode:teal")).toEqual({ kind: "glyph", name: "FolderCode", color: "teal" });
    expect(parseProjectIcon("Terminal")).toEqual({ kind: "glyph", name: "Terminal" });
    expect(parseProjectIcon("monogram:XY:emerald")).toEqual({ kind: "monogram", text: "XY", color: "emerald" });
  });

  it("drops unknown or malformed values", () => {
    for (const stored of ["", "glyph:rocket", "glyph:nope:blue", "glyph:rocket:chartreuse", "monogram:ABC:blue", "monogram:A", "emoji:", "data:image/jpeg;base64,AAAA", "data:image/png;base64,not base64!", "rocketship"]) {
      expect(parseProjectIcon(stored)).toBeNull();
    }
    expect(parseProjectIcon(`data:image/png;base64,${"A".repeat(300 * 1024)}`)).toBeNull();
  });

  it("round-trips through serialize", () => {
    const icons: ProjectIcon[] = [
      { kind: "glyph", name: "rocket", color: "green" },
      { kind: "glyph", name: "Terminal" },
      { kind: "emoji", emoji: "🧪" },
      { kind: "monogram", text: "PX", color: "red" },
      { kind: "image", src: PNG },
    ];
    for (const icon of icons) expect(parseProjectIcon(serializeProjectIcon(icon))).toEqual(icon);
  });

  it("validates PNG data URLs and bytes", () => {
    expect(isPngDataUrl(PNG)).toBe(true);
    expect(isPngDataUrl("data:image/png;base64,")).toBe(false);
    expect(checkPngBytes(png(64, 64))).toBeNull();
    expect(checkPngBytes(new Uint8Array(64))).toBe("That file is not a PNG.");
    expect(checkPngBytes(png(2048, 64))).toContain("2048x64");
    expect(checkPngBytes(png(64, 64, 200 * 1024))).toContain("200KB");
  });
});

describe("the Cursor picker catalog", () => {
  it("keeps Cursor's ten colours in its order", () => {
    expect(PROJECT_ICON_COLORS.map((color) => color.id)).toEqual(["default", "green", "cyan", "blue", "purple", "magenta", "orange", "yellow", "red", "brand"]);
  });

  it("lists unique names in Cursor's alphabetical order", () => {
    expect(new Set(PROJECT_ICON_NAMES).size).toBe(PROJECT_ICON_NAMES.length);
    expect([...PROJECT_ICON_NAMES].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual([...PROJECT_ICON_NAMES]);
    expect(PROJECT_ICON_NAMES.length).toBeGreaterThan(300);
  });

  it("covers Cursor's project seed icons", () => {
    for (const seed of ["code", "terminal", "bug", "git-branch", "brackets-curly", "folder", "globe", "rocket", "sparkle", "lightning", "smiley-happy", "board-kanban", "chat-bubbles", "envelope", "paperplane"]) {
      expect(filterProjectIconNames(seed).length).toBeGreaterThan(0);
    }
  });

  it("draws every catalog and legacy name from the icon library", () => {
    for (const [name] of PROJECT_ICON_CATALOG) expect(PROJECT_ICON_GLYPHS[name]?.length).toBeGreaterThan(0);
    for (const name of ["Code", "FolderCode", "Rocket", "Palette", "Smile"]) expect(PROJECT_ICON_GLYPHS[name]?.length).toBeGreaterThan(0);
    for (const shape of Object.values(PICKER_GLYPHS)) expect(shape.length).toBeGreaterThan(0);
  });
});

describe("icon search", () => {
  it("returns the whole catalog for an empty query", () => {
    expect(filterProjectIconNames("  ")).toEqual([...PROJECT_ICON_NAMES]);
  });

  it("matches every token against the name and its aliases", () => {
    expect(filterProjectIconNames("git branch")).toContain("git-branch");
    expect(filterProjectIconNames("warning")).toContain("alert");
    expect(filterProjectIconNames("person")).toContain("account");
    expect(filterProjectIconNames("git zzz")).toEqual([]);
  });

  it("puts a legacy current icon first so it stays selectable", () => {
    expect(filterProjectIconNames("", "Rocket")[0]).toBe("Rocket");
    expect(filterProjectIconNames("", "rocket")[0]).toBe(PROJECT_ICON_NAMES[0]);
  });

  it("resolves a typed name case-insensitively", () => {
    expect(findProjectIconName("ROCKET")).toBe("rocket");
    expect(findProjectIconName("foldercode")).toBe("FolderCode");
    expect(findProjectIconName("nope")).toBeNull();
  });
});

describe("picker layout", async () => {
  const { gridHeight, pickerColorOf } = await import("../src/project-icon-picker");

  it("sizes the grid like Cursor: 29px rows, capped at 322px", () => {
    expect(gridHeight(1)).toBe(29);
    expect(gridHeight(10)).toBe(29);
    expect(gridHeight(11)).toBe(58);
    expect(gridHeight(400)).toBe(322);
  });

  it("starts the colour row from the current glyph", () => {
    expect(pickerColorOf({ kind: "glyph", name: "rocket", color: "purple" })).toBe("purple");
    expect(pickerColorOf({ kind: "glyph", name: "Rocket", color: "violet" })).toBe("default");
    expect(pickerColorOf(null)).toBe("default");
  });
});
