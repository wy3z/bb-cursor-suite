import { describe, expect, it } from "bun:test";
import {
  PROJECT_ICON_CATALOG,
  PROJECT_ICON_COLORS,
  PROJECT_ICON_NAMES,
  PROJECT_ICON_MAX_LENGTH,
  PROJECT_ICON_PNG_MAX_BYTES,
  checkPngBytes,
  pngDataUrlProblem,
  filterProjectIconNames,
  findProjectIconName,
  isPngDataUrl,
  parseProjectIcon,
  serializeProjectIcon,
  type ProjectIcon,
} from "../src/project-icon";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PICKER_GLYPHS, PROJECT_ICON_GLYPHS } from "../src/project-icon-glyphs";
import { compactGlyph, serveProjectIconGlyphs } from "../src/project-icon-glyph-server";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

function png(width: number, height: number, size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
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
    expect(checkPngBytes(png(256, 256))).toBeNull();
    expect(checkPngBytes(new Uint8Array(64))).toBe("That file is not a PNG.");
    const noHeader = png(64, 64);
    noHeader[12] = 0;
    expect(checkPngBytes(noHeader)).toBe("That file is not a PNG.");
    expect(checkPngBytes(png(257, 64))).toContain("257x64");
    expect(checkPngBytes(png(64, 64, 49 * 1024))).toContain("49KB");
  });

  it("decodes a PNG data URL and applies the same caps as a file", () => {
    const encode = (bytes: Uint8Array) => `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
    expect(pngDataUrlProblem(encode(png(64, 64)))).toBeNull();
    expect(pngDataUrlProblem("data:image/png;base64,AAAA")).toBe("That file is not a PNG.");
    expect(pngDataUrlProblem(PNG)).toBe("That file is not a PNG.");
    expect(pngDataUrlProblem(encode(png(512, 64)))).toContain("512x64");
    expect(pngDataUrlProblem(encode(png(64, 64, PROJECT_ICON_PNG_MAX_BYTES)))).toBeNull();
    expect(pngDataUrlProblem(encode(png(64, 64, PROJECT_ICON_PNG_MAX_BYTES + 1)))).toContain("48KB");
    expect(encode(png(64, 64, PROJECT_ICON_PNG_MAX_BYTES)).length).toBeLessThanOrEqual(PROJECT_ICON_MAX_LENGTH);
    expect(pngDataUrlProblem("data:image/jpeg;base64,AAAA")).toContain("not a PNG data URL");
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
  const { gridHeight, nextGridIndex, pickerColorOf } = await import("../src/project-icon-picker");

  it("walks the icon grid with arrow keys, ten to a row", () => {
    expect(nextGridIndex("ArrowRight", 0, 25)).toBe(1);
    expect(nextGridIndex("ArrowRight", 24, 25)).toBe(24);
    expect(nextGridIndex("ArrowLeft", 0, 25)).toBe(0);
    expect(nextGridIndex("ArrowDown", 3, 25)).toBe(13);
    expect(nextGridIndex("ArrowDown", 18, 25)).toBe(18);
    expect(nextGridIndex("ArrowUp", 13, 25)).toBe(3);
    expect(nextGridIndex("ArrowUp", 3, 25)).toBeNull();
    expect(nextGridIndex("Home", 13, 25)).toBe(0);
    expect(nextGridIndex("End", 0, 25)).toBe(24);
    expect(nextGridIndex("ArrowRight", 0, 0)).toBeNull();
  });

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

describe("glyphs served over RPC", () => {
  it("serves the whole table or only the names asked for", () => {
    const all = serveProjectIconGlyphs({ names: null }).glyphs;
    for (const name of PROJECT_ICON_NAMES) expect(all[name]?.length).toBeGreaterThan(0);
    for (const name of ["@none", "@upload", "@check"]) expect(all[name]?.length).toBeGreaterThan(0);
    expect(Object.keys(serveProjectIconGlyphs({ names: ["rocket", "Rocket", "nope", "constructor"] }).glyphs)).toEqual(["rocket", "Rocket"]);
  });

  it("drops attributes the svg already sets, keeping the ones that differ", () => {
    expect(compactGlyph([["path", { d: "M1 1", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: 1.5, key: "0" }]])).toEqual(["M1 1"]);
    expect(compactGlyph([["path", { d: "M2 2", stroke: "currentColor", strokeLinecap: "square", strokeWidth: 1.5, key: "0" }]])).toEqual([["path", { d: "M2 2", strokeLinecap: "square", strokeLinejoin: "miter" }]]);
    expect(compactGlyph([["circle", { cx: 12, cy: 12, r: 2, fill: "currentColor", key: "1" }]])).toEqual([["circle", { cx: 12, cy: 12, r: 2, fill: "currentColor", stroke: "none" }]]);
  });

  it("is much smaller than the raw shapes", () => {
    const raw = JSON.stringify({ ...PROJECT_ICON_GLYPHS, ...PICKER_GLYPHS }).length;
    const compact = JSON.stringify(serveProjectIconGlyphs({ names: null }).glyphs).length;
    expect(compact).toBeLessThan(raw * 0.75);
  });
});

describe("colour contrast", () => {
  const css = readFileSync(join(import.meta.dir, "..", "project-icon.css"), "utf8");
  const luminance = (hex: string) => {
    const [r, g, b] = (hex.match(/\w\w/g) ?? []).map((part) => parseInt(part, 16) / 255).map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const ratio = (a: string, b: string) => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high! + 0.05) / (low! + 0.05);
  };

  it("keeps every picker colour at 3:1 or better on white, with a dark override", () => {
    for (const { id } of PROJECT_ICON_COLORS) {
      if (id === "default") continue;
      const light = new RegExp(`^\\.bbs-pi-${id} \\{ --bbs-pi-fg: (#[0-9a-f]{6}); \\}`, "m").exec(css)?.[1];
      const dark = new RegExp(`^html\\.dark \\.bbs-pi-${id} \\{ --bbs-pi-fg: (#[0-9a-f]{6}); \\}`, "m").exec(css)?.[1];
      expect(light).toBeDefined();
      expect(dark).toBeDefined();
      expect(ratio(light!, "#ffffff")).toBeGreaterThanOrEqual(3);
      expect(ratio(dark!, "#1e1e1e")).toBeGreaterThanOrEqual(3);
    }
  });
});
