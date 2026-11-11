import type { BbPluginApi } from "@get-bb/plugin-sdk";

export const NOTIFY_MODES = ["done-and-review", "review-only", "off"] as const;
export type NotifyMode = (typeof NOTIFY_MODES)[number];

export function notifyMode(value: unknown): NotifyMode {
  return NOTIFY_MODES.includes(value as NotifyMode) ? (value as NotifyMode) : "done-and-review";
}

export function defineSettings(bb: BbPluginApi) {
  return bb.settings.define({
    notify: {
      type: "select",
      label: "Project notifications",
      description:
        "What Projects sends you for boards that have a lead: a notification when a card reaches Done or For Review, For Review only, or nothing. Workers the lead spawned are muted either way; the lead's own questions still notify.",
      options: [...NOTIFY_MODES],
      experimental_optionLabels: { "done-and-review": "Done and For Review (default)", "review-only": "For Review only", off: "Off" },
      default: "done-and-review",
    },
    wakeEnabled: {
      type: "boolean",
      label: "Wake the outer loop by webhook",
      description: "Sends a wake-up (counts and ids only, never message text) when a project lead replies. Off by default. Turn on once your receiver is ready.",
      default: false,
    },
    wakeUrl: { type: "string", label: "Webhook URL", description: "Where the wake-up goes. Use https; plain http works only for a loopback test receiver.", secret: true },
    wakeHeaderName: { type: "string", label: "Auth header name", description: "Exactly as the receiver documents it. Leave empty if it needs none.", default: "" },
    wakeHeaderValue: { type: "string", label: "Auth header value", description: "Sent in the header above. Leave empty if the receiver needs none.", secret: true },
    wakeRemindMinutes: { type: "number", label: "Remind every (minutes)", description: "Wakes the receiver again while replies stay unacknowledged. 60 by default.", default: 60 },
  });
}

export type ProjectsSettings = ReturnType<typeof defineSettings>;
