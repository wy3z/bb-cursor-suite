import { PICKER_GLYPHS, PROJECT_ICON_GLYPHS } from "./project-icon-glyphs";
import { PICKER_GLYPH_PREFIX, type CompactGlyph, type CompactGlyphElement, type ProjectIconShape } from "./project-icon";

const INHERITED: Readonly<Record<string, string | number>> = { stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round" };

export function compactGlyph(shape: ProjectIconShape): CompactGlyph {
  return shape.map(([tag, attrs]): CompactGlyphElement => {
    const own: Record<string, string | number> = {};
    for (const [name, value] of Object.entries(attrs)) {
      if (name === "key" || name === "strokeWidth" || INHERITED[name] === value) continue;
      own[name] = value;
    }
    if (!("stroke" in attrs)) own.stroke = "none";
    else {
      if (!("strokeLinecap" in attrs)) own.strokeLinecap = "butt";
      if (!("strokeLinejoin" in attrs)) own.strokeLinejoin = "miter";
    }
    const keys = Object.keys(own);
    return tag === "path" && keys.length === 1 && keys[0] === "d" ? String(own.d) : [tag, own];
  });
}

const ALL: Record<string, ProjectIconShape> = {
  ...PROJECT_ICON_GLYPHS,
  ...Object.fromEntries(Object.entries(PICKER_GLYPHS).map(([name, shape]) => [`${PICKER_GLYPH_PREFIX}${name}`, shape])),
};
const compacted = new Map<string, CompactGlyph>();

function glyphOf(name: string): CompactGlyph | undefined {
  if (!Object.hasOwn(ALL, name)) return undefined;
  let glyph = compacted.get(name);
  if (glyph === undefined) {
    glyph = compactGlyph(ALL[name]!);
    compacted.set(name, glyph);
  }
  return glyph;
}

export function serveProjectIconGlyphs({ names }: { names: string[] | null }): { glyphs: Record<string, CompactGlyph> } {
  const glyphs: Record<string, CompactGlyph> = {};
  for (const name of names ?? Object.keys(ALL)) {
    const glyph = glyphOf(name);
    if (glyph !== undefined) glyphs[name] = glyph;
  }
  return { glyphs };
}
