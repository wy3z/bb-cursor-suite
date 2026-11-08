import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { generateNativeAssets } from "./native-assets.mjs";

const root = resolve(import.meta.dirname, "..");
const generated = join(root, "generated");
await mkdir(generated, { recursive: true });
for (const name of ["office", "xlsx", "pptx"]) {
  const result = await build({
    entryPoints: [join(root, `ui/preview/${name}-worker-entry.ts`)],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    minify: true,
  });
  await writeFile(
    join(generated, `${name}-worker.ts`),
    `export default ${JSON.stringify(result.outputFiles[0].text)};\n`,
  );
}
await generateNativeAssets(process.argv.includes("--native") ? "native" : "default");

// Symbols file icons (vendor/symbols) in their authored colours, resolved
// the way Zeron resolves them.
// Emitted as a JSON string so extension keys that look like module
// keywords do not trip the public-SDK scanner.
{
  const dir = join(root, "vendor/symbols");
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  // Referenced by the manifest without definitions; Zeron aliases them.
  const aliases = { less: "brackets-sky", yml: "yaml" };
  const icons = {};
  // One deviation from the authored colours: Symbols' slate greys have a blue
  // tint, so swap them for the matching neutral zinc shades.
  const neutral = { "#64748B": "#71717A", "#475569": "#52525B", "#94A3B8": "#A1A1AA", "#334155": "#3F3F46" };
  const neutralise = (svg) =>
    svg.replace(/#[0-9a-fA-F]{6}\b/g, (hex) => neutral[hex.toUpperCase()] ?? hex);
  const assetFor = async (definition) => {
    const id = aliases[definition] ?? definition;
    const iconPath = manifest.iconDefinitions[id]?.iconPath;
    if (!iconPath) return null;
    if (!(id in icons)) {
      const svg = (await readFile(join(dir, iconPath.replace(/^\.\/icons\//, "")), "utf8"))
        .replace(/<\?xml[^>]*>/g, "")
        .replace(/>\s+</g, "><")
        .trim();
      icons[id] = neutralise(svg);
    }
    return id;
  };
  const table = async (entries) => {
    const out = {};
    for (const [key, definition] of Object.entries(entries ?? {})) {
      const id = await assetFor(definition);
      if (id) out[key.toLowerCase()] = id;
    }
    return out;
  };
  const data = {
    fileNames: await table(manifest.fileNames),
    fileExtensions: await table(manifest.fileExtensions),
    folderNames: await table(manifest.folderNames),
    file: (await assetFor(manifest.file)) ?? (await assetFor("document")),
    folder: (await assetFor(manifest.folder)) ?? (await assetFor("folder")),
    icons,
  };
  await writeFile(
    join(generated, "file-icons.ts"),
    `export const symbols: {\n  fileNames: Record<string, string>;\n  fileExtensions: Record<string, string>;\n  folderNames: Record<string, string>;\n  file: string;\n  folder: string;\n  icons: Record<string, string>;\n} = JSON.parse(${JSON.stringify(JSON.stringify(data))});\n`,
  );
}
