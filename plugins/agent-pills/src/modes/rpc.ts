import { z } from "zod";
import { PROJECT_ICON_GLYPHS_METHOD } from "@wy3z/bb-suite/contracts";
import { MODE_COLORS } from "./model";

const idSchema = z.string().trim().min(1).max(200);

export const modeRefSchema = z.object({
  skillId: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(200),
});

const modeOptionSchema = modeRefSchema.extend({
  description: z.string().nullable(),
  path: z.string(),
  scope: z.string(),
  icon: z.string(),
  color: z.enum(MODE_COLORS),
  styled: z.boolean(),
  mode: z.boolean(),
});

export type ModeOption = z.infer<typeof modeOptionSchema>;

const threadModeStateSchema = z.object({
  committed: modeRefSchema.nullable(),
  draft: modeRefSchema.nullable(),
  rev: z.number().int().min(0),
  notice: z.string().nullable(),
});

export type ThreadModeState = z.infer<typeof threadModeStateSchema>;

export const modeRpcMethods = {
  listModes: {
    input: z.object({
      projectId: idSchema,
      environmentId: idSchema.nullable(),
      providerId: idSchema.nullable(),
      excludeUserSkills: z.boolean().default(false),
    }),
    output: z.object({ modes: z.array(modeOptionSchema) }),
  },
  threadMode: {
    input: z.object({ threadId: idSchema }),
    output: z.object({
      state: threadModeStateSchema,
      projectId: z.string().nullable(),
      environmentId: z.string().nullable(),
      providerId: z.string().nullable(),
    }),
  },
  setThreadMode: {
    input: z.object({ threadId: idSchema, mode: modeRefSchema.nullable(), rev: z.number().int().min(0) }),
    output: z.object({ ok: z.boolean(), state: threadModeStateSchema }),
  },
  clearModeNotice: {
    input: z.object({ threadId: idSchema }),
    output: z.object({ ok: z.boolean() }),
  },
  iconGlyphs: PROJECT_ICON_GLYPHS_METHOD,
};
