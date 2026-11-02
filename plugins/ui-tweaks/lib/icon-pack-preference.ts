export const ICON_PACK_OPTIONS = [
  {
    id: "default",
    label: "BB Default",
    description: "BB's built-in icon set.",
  },
  {
    id: "solar",
    label: "Solar Linear",
    description: "Solar Icons (Linear) by 480 Design.",
  },
  {
    id: "lucide",
    label: "Lucide",
    description: "Lucide's outline icons.",
  },
] as const;

export type IconPack = (typeof ICON_PACK_OPTIONS)[number]["id"];

const ICON_PACK_IDS: ReadonlySet<string> = new Set(
  ICON_PACK_OPTIONS.map((option) => option.id),
);

export function isIconPack(value: unknown): value is IconPack {
  return typeof value === "string" && ICON_PACK_IDS.has(value);
}

export function parseIconPack(value: unknown): IconPack {
  return isIconPack(value) ? value : "default";
}
