import type { ComposerDraftReplacement, ComposerDraftSnapshot, ComposerMention } from "@get-bb/plugin-sdk/app";

export interface ModePill {
  pluginId: string;
  provider: string;
  id: string;
  label: string;
  icon: string;
}

type PluginMention = Extract<ComposerMention, { kind: "plugin" }>;

export function isModePill(mention: ComposerMention, pluginId: string, provider: string): mention is PluginMention {
  return mention.kind === "plugin" && mention.pluginId === pluginId && mention.provider === provider;
}

function withoutPills(draft: ComposerDraftSnapshot, pluginId: string, provider: string): { text: string; mentions: ComposerMention[] } {
  const pills = draft.mentions.filter((mention) => isModePill(mention, pluginId, provider)).sort((left, right) => right.from - left.from);
  let text = draft.text;
  let mentions = draft.mentions.filter((mention) => !isModePill(mention, pluginId, provider));
  for (const pill of pills) {
    const end = text[pill.to] === " " ? pill.to + 1 : pill.to;
    const removed = end - pill.from;
    text = text.slice(0, pill.from) + text.slice(end);
    mentions = mentions.map((mention) =>
      mention.from >= end ? { ...mention, from: mention.from - removed, to: mention.to - removed } : mention,
    );
  }
  return { text, mentions };
}

export function hasContent(draft: { text: string; mentions: readonly ComposerMention[] }, attachments: number): boolean {
  return draft.text.trim().length > 0 || draft.mentions.length > 0 || attachments > 0;
}

export function syncModePill(
  draft: ComposerDraftSnapshot,
  pill: ModePill | null,
  pluginId: string,
  provider: string,
): ComposerDraftReplacement | null {
  const existing = draft.mentions.filter((mention) => isModePill(mention, pluginId, provider));
  const rest = withoutPills(draft, pluginId, provider);
  const wanted = pill !== null && hasContent(rest, draft.attachments.length);
  if (!wanted) return existing.length === 0 ? null : rest;
  const only = existing.length === 1 ? existing[0]! : null;
  if (only !== null && only.from === 0 && only.id === pill.id && only.label === pill.label && only.icon === pill.icon) return null;
  const text = pill.label;
  const shift = text.length + 1;
  return {
    text: `${text} ${rest.text}`,
    mentions: [
      { kind: "plugin", pluginId: pill.pluginId, provider: pill.provider, id: pill.id, label: pill.label, icon: pill.icon, from: 0, to: text.length },
      ...rest.mentions.map((mention) => ({ ...mention, from: mention.from + shift, to: mention.to + shift })),
    ],
  };
}
