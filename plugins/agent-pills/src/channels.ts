/** Channel names shared by the backend and the app. */
export const AGENT_PILLS_CHANNEL = "agent-pills:thread-updated";

export const COMPOSER_ATTRIBUTE = "data-bb-agent-pills-composer";

export const PILLS_PREFERENCE_KEY = "bb-plugin-agent-pills.pills.v1";
export const PILLS_PREFERENCE_EVENT = "bb:agent-pills-pills-change";
export const PILLS_ATTRIBUTE = "data-bb-agent-pills-pills";

/** Per-thread model-fallback dismissals (thread id -> dismissed sourceSeq). */
export const FALLBACK_DISMISS_KEY = "bb-plugin-agent-pills.fallback-dismissed.v1";
export const FALLBACK_DISMISS_EVENT = "bb:agent-pills-fallback-dismissed";

/** Set on <html> while BB's own queue box is shown for editing. */
export const SHOW_QUEUE_ATTRIBUTE = "data-bb-agent-pills-show-queue";
