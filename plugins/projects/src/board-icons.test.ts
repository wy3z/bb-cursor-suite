import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../server";
import { fakeBb } from "../test/fake-bb";
import { BoardIconError, ICON_PREFIX, boardIconFor, createBoardIcons, iconArgument, pngToIcon } from "./board-icons";

const PNG_URL = "data:image/png;base64,iVBORw0KGgo=";

function png(width = 64, height = 64): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function memoryKv() {
  const map = new Map<string, unknown>();
  return {
    map,
    kv: {
      get: async <T>(key: string) => map.get(key) as T | undefined,
      set: async (key: string, value: unknown) => void map.set(key, value),
      delete: async (key: string) => void map.delete(key),
      list: async (prefix = "") => [...map.keys()].filter((key) => key.startsWith(prefix)),
    },
  };
}

describe("board icon storage", () => {
  it("stores, lists and clears an icon per tracker project", async () => {
    const { kv, map } = memoryKv();
    const changed: string[] = [];
    const icons = createBoardIcons(kv, (projectId) => changed.push(projectId));
    expect(await icons.get("proj_abc")).toBeNull();
    expect(await icons.set("proj_abc", "glyph:rocket:blue")).toBe("glyph:rocket:blue");
    await icons.set("proj_other", "emoji:🧪");
    expect(map.get(`${ICON_PREFIX}proj_abc`)).toBe("glyph:rocket:blue");
    expect(await icons.list()).toEqual([
      { projectId: "proj_abc", icon: "glyph:rocket:blue" },
      { projectId: "proj_other", icon: "emoji:🧪" },
    ]);
    await icons.set("proj_abc", null);
    expect(await icons.get("proj_abc")).toBeNull();
    expect(changed).toEqual(["proj_abc", "proj_other", "proj_abc"]);
  });

  it("normalises legacy values and refuses junk without writing", async () => {
    const { kv, map } = memoryKv();
    const icons = createBoardIcons(kv, () => undefined);
    expect(await icons.set("proj_abc", "monogram:px:teal")).toBe("monogram:PX:teal");
    await expect(icons.set("proj_abc", "glyph:nope:blue")).rejects.toBeInstanceOf(BoardIconError);
    await expect(icons.set("proj_abc", `data:image/png;base64,${"A".repeat(300 * 1024)}`)).rejects.toBeInstanceOf(BoardIconError);
    expect(map.get(`${ICON_PREFIX}proj_abc`)).toBe("monogram:PX:teal");
  });

  it("skips stored values it can no longer parse", async () => {
    const { kv, map } = memoryKv();
    map.set(`${ICON_PREFIX}proj_bad`, "glyph:retired:blue");
    map.set(`${ICON_PREFIX}proj_ok`, PNG_URL);
    const icons = createBoardIcons(kv, () => undefined);
    expect(await icons.list()).toEqual([{ projectId: "proj_ok", icon: PNG_URL }]);
    expect(await icons.get("proj_bad")).toBeNull();
  });
});

describe("icon arguments", () => {
  it("turns a glyph name into a coloured stored value", () => {
    expect(iconArgument("Rocket", undefined)).toEqual({ kind: "value", icon: "glyph:rocket:default" });
    expect(iconArgument("git-branch", "green")).toEqual({ kind: "value", icon: "glyph:git-branch:green" });
  });

  it("accepts stored values as they are", () => {
    expect(iconArgument("glyph:rocket:brand", undefined)).toEqual({ kind: "value", icon: "glyph:rocket:brand" });
    expect(iconArgument("emoji:🚀", undefined)).toEqual({ kind: "value", icon: "emoji:🚀" });
    expect(iconArgument(PNG_URL, undefined)).toEqual({ kind: "value", icon: PNG_URL });
  });

  it("treats a .png or a path as a file", () => {
    expect(iconArgument("logo.png", undefined)).toEqual({ kind: "file", path: "logo.png" });
    expect(iconArgument("./art/logo", undefined)).toEqual({ kind: "file", path: "./art/logo" });
  });

  it("explains bad input", () => {
    expect(() => iconArgument("rocketship", undefined)).toThrow("Unknown icon");
    expect(() => iconArgument("rocket", "chartreuse")).toThrow("Unknown colour");
    expect(() => iconArgument("emoji:🚀", "blue")).toThrow("--color only applies");
    expect(() => iconArgument("glyph:rocket:nope", undefined)).toThrow("Unrecognised icon value");
  });

  it("encodes a PNG the board can store", () => {
    expect(pngToIcon(png())).toMatch(/^data:image\/png;base64,/);
    expect(() => pngToIcon(new Uint8Array(32))).toThrow("not a PNG");
    expect(() => pngToIcon(png(4096, 64))).toThrow("4096x64");
  });
});

describe("bb projects icon", () => {
  function boot() {
    const fake = fakeBb();
    plugin(fake.bb as never);
    return fake;
  }

  it("shows the default, sets a glyph, shows it, then clears it", async () => {
    const fake = boot();
    expect((await fake.run(["icon", "ABC"])).stdout).toBe("ABC: board glyph (default)\n");
    const set = await fake.run(["icon", "ABC", "rocket", "--color", "purple", "--json"]);
    expect(set.exitCode).toBe(0);
    expect(set.json()).toEqual({ project: "ABC", icon: "glyph:rocket:purple", kind: "glyph" });
    expect(fake.kv.get(`${ICON_PREFIX}proj_abc`)).toBe("glyph:rocket:purple");
    expect((await fake.run(["icon", "abc"])).stdout).toBe("ABC: glyph rocket (purple)\n");
    expect((await fake.run(["icon", "ABC", "--clear"])).stdout).toBe("ABC: board glyph (default)\n");
    expect(fake.kv.has(`${ICON_PREFIX}proj_abc`)).toBe(false);
  });

  it("reads a PNG relative to the caller", async () => {
    const fake = boot();
    const dir = mkdtempSync(join(tmpdir(), "bbp-icon-"));
    writeFileSync(join(dir, "logo.png"), png());
    const result = await fake.run(["icon", "ABC", join(dir, "logo.png")]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ABC: uploaded image\n");
    expect(String(fake.kv.get(`${ICON_PREFIX}proj_abc`))).toMatch(/^data:image\/png;base64,/);
  });

  it("lists glyph names and refuses bad input", async () => {
    const fake = boot();
    const listed = await fake.run(["icon", "--list"]);
    expect(listed.stdout?.split("\n")).toContain("rocket");
    expect((await fake.run(["icon"])).exitCode).not.toBe(0);
    expect((await fake.run(["icon", "ABC", "rocketship"])).exitCode).not.toBe(0);
    expect((await fake.run(["icon", "ABC", "rocket", "--clear"])).exitCode).not.toBe(0);
    expect((await fake.run(["icon", "NOPE", "rocket"])).exitCode).not.toBe(0);
    expect(fake.kv.has(`${ICON_PREFIX}proj_abc`)).toBe(false);
  });

  it("serves the same store over RPC", async () => {
    const fake = boot();
    const rpc = fake.rpc() as unknown as {
      listIcons: (input: object) => Promise<{ icons: { projectId: string; icon: string }[] }>;
      setIcon: (input: { projectId: string; icon: string | null }) => Promise<{ icons: { projectId: string; icon: string }[] }>;
    };
    expect(await rpc.listIcons({})).toEqual({ icons: [] });
    expect(await rpc.setIcon({ projectId: "proj_other", icon: "glyph:Rocket:violet" })).toEqual({ icons: [{ projectId: "proj_other", icon: "glyph:Rocket:violet" }] });
    await expect(rpc.setIcon({ projectId: "proj_other", icon: "glyph:nope:blue" })).rejects.toThrow("Unrecognised icon value");
    expect((await fake.run(["icon", "OTHER"])).stdout).toBe("OTHER: glyph Rocket (violet)\n");
    expect(await rpc.setIcon({ projectId: "proj_other", icon: null })).toEqual({ icons: [] });
  });
});

describe("board icon fallback", () => {
  it("is the board's own icon or nothing, never the linked BB project's", () => {
    const rows = new Map([["proj_abc", "glyph:rocket:blue"], ["proj_linked_bb", "glyph:folder:red"]]);
    expect(boardIconFor(rows, "proj_abc")).toEqual({ kind: "glyph", name: "rocket", color: "blue" });
    expect(boardIconFor(rows, "proj_other")).toBeNull();
    expect(boardIconFor(rows, null)).toBeNull();
    expect(boardIconFor(new Map([["proj_abc", "glyph:retired:blue"]]), "proj_abc")).toBeNull();
  });

  it("no longer reads Cursor Sidebar, so Projects works on its own", () => {
    const sources = [join(import.meta.dir, "..", "app.tsx"), join(import.meta.dir, "..", "server.ts"), ...readdirSync(import.meta.dir).filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".test.ts")).map((file) => join(import.meta.dir, file))];
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      expect(text.includes("cursor-sidebar") || text.includes("listProjectIcons")).toBe(false);
    }
  });
});
