import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  resolveLocalMarkdownImagePath,
  rewriteMarkdownImageSrcs,
} from "./markdown-images.js";

describe("markdown local image paths", () => {
  it("resolves a relative image from the markdown file directory", () => {
    expect(
      resolveLocalMarkdownImagePath({
        markdownPath: "README.md",
        rootPath: "/workspace",
        src: "docs/screenshots/files.png",
      }),
    ).toBe("/workspace/docs/screenshots/files.png");
    expect(
      resolveLocalMarkdownImagePath({
        markdownPath: "docs/guide.md",
        rootPath: "/workspace/",
        src: "./shot.png",
      }),
    ).toBe("/workspace/docs/shot.png");
  });

  it("keeps contained absolute host paths and rejects escapes", () => {
    expect(
      resolveLocalMarkdownImagePath({
        markdownPath: "README.md",
        rootPath: "/workspace",
        src: "/workspace/docs/files.png",
      }),
    ).toBe("/workspace/docs/files.png");
    expect(
      resolveLocalMarkdownImagePath({
        markdownPath: "docs/guide.md",
        rootPath: "/workspace",
        src: "../../etc/passwd",
      }),
    ).toBeNull();
    expect(
      resolveLocalMarkdownImagePath({
        markdownPath: "README.md",
        rootPath: "/workspace",
        src: "https://example.test/a.png",
      }),
    ).toBeNull();
  });

  it("rewrites markdown image destinations to absolute host paths", () => {
    expect(
      rewriteMarkdownImageSrcs({
        content:
          "See ![FileTree pane](docs/screenshots/files.png) and ![also](./logo.png).",
        markdownPath: "README.md",
        rootPath: "/workspace",
      }),
    ).toBe(
      "See ![FileTree pane](/workspace/docs/screenshots/files.png) and ![also](/workspace/logo.png).",
    );
  });

  it("does not rewrite images inside fenced or inline code", () => {
    const content =
      "![ok](pic.png)\n\n```md\n![no](pic.png)\n```\n\nUse `![no](pic.png)` in docs.\n";
    expect(
      rewriteMarkdownImageSrcs({
        content,
        markdownPath: "README.md",
        rootPath: "/workspace",
      }),
    ).toBe(
      "![ok](/workspace/pic.png)\n\n```md\n![no](pic.png)\n```\n\nUse `![no](pic.png)` in docs.\n",
    );
  });

  it("leaves an absolute screenshot URL untouched", () => {
    const content =
      "![Files](https://raw.githubusercontent.com/wy3z/bb-cursor-suite/main/docs/media/filetree-tree.png)";
    expect(
      rewriteMarkdownImageSrcs({
        content,
        markdownPath: "README.md",
        rootPath: "/workspace",
      }),
    ).toBe(content);
  });


});
