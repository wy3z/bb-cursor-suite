import { useEffect, useRef, useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { GitActionResult } from "@wy3z/bb-suite/contracts";
import { NEEDS_PULL_REQUESTS, type PluginAvailability } from "@wy3z/bb-suite/plugin-availability";
import { useGitActions } from "./git-client";
import { Orb } from "./pills/primitives";

type Action = "commit" | "commit-push" | "push" | "pr";

type Phase =
  | { kind: "idle" }
  | { kind: "busy"; action: Action }
  | { kind: "done"; text: string; url?: string }
  | { kind: "error"; text: string };

const BUSY_LABEL: Record<Action, string> = {
  commit: "Committing",
  "commit-push": "Committing and pushing",
  push: "Pushing",
  pr: "Creating pull request",
};

const UNAVAILABLE_NOTE = `${NEEDS_PULL_REQUESTS}: install or enable it to commit and push here`;

function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : "";
}

export function CommitBar({
  environmentId,
  uncommitted,
  untracked,
  gitActions,
}: {
  environmentId: string;
  uncommitted: boolean;
  untracked: number;
  gitActions: PluginAvailability;
}) {
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const needsMessage = untracked > 0 && !includeUntracked;
  const rpc = useGitActions();
  const [message, setMessage] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const textRef = useRef<HTMLTextAreaElement>(null);
  const busy = phase.kind === "busy";
  const blocked = busy || gitActions !== "available";
  const hint = (title: string) => (gitActions === "unavailable" ? NEEDS_PULL_REQUESTS : title);

  useEffect(() => {
    const text = textRef.current;
    if (!text) return;
    text.style.height = "auto";
    text.style.height = `${Math.min(text.scrollHeight, 96)}px`;
  }, [message, uncommitted]);

  const fail = (result: GitActionResult | null, fallback: string) =>
    setPhase({ kind: "error", text: result?.error ?? fallback });

  const runAction = async (action: Action) => {
    if (blocked) return;
    setPhase({ kind: "busy", action });
    try {
      if (action === "push") {
        const result = await rpc.call("gitPush", { environmentId });
        if (!result.ok) return fail(result, "Push failed");
        setPhase({ kind: "done", text: `Pushed ${result.branch ?? ""}`.trim() });
        return;
      }
      let committed: GitActionResult | null = null;
      if (uncommitted) {
        committed = await rpc.call("gitCommit", { environmentId, message, push: action === "commit-push", includeUntracked });
        if (!committed.ok) return fail(committed, "Commit failed");
        setMessage("");
      }
      if (action === "pr") {
        const result = await rpc.call("gitCreatePullRequest", { environmentId });
        if (!result.ok) return fail(result, "Couldn't create the pull request");
        const number = result.url?.match(/\/pull\/(\d+)/)?.[1];
        setPhase({
          kind: "done",
          text: `${result.existed ? "Pull request already open" : "Opened pull request"}${number ? ` #${number}` : ""}`,
          url: result.url,
        });
        return;
      }
      const verb = action === "commit-push" ? "Committed and pushed" : "Committed";
      setPhase({ kind: "done", text: `${verb} ${shortSha(committed?.sha)} ${committed?.subject ?? ""}`.trim() });
    } catch (error) {
      setPhase({ kind: "error", text: error instanceof Error ? error.message : "Something went wrong" });
    }
  };

  return (
    <div className="bb-agent-pills__commit" data-busy={busy || undefined} data-unavailable={gitActions === "unavailable" || undefined}>
      {uncommitted ? (
        <textarea
          ref={textRef}
          className="bb-agent-pills__commit-message"
          rows={1}
          value={message}
          disabled={blocked}
          placeholder={needsMessage ? "Commit message (required while untracked files are left out)" : "Commit message (empty to generate)"}
          aria-label="Commit message"
          onChange={(event) => setMessage(event.currentTarget.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void runAction(event.shiftKey ? "commit-push" : "commit");
            }
          }}
        />
      ) : null}
      {uncommitted && untracked > 0 ? (
        <label className="bb-agent-pills__commit-untracked">
          <input
            type="checkbox"
            checked={includeUntracked}
            disabled={blocked}
            onChange={(event) => setIncludeUntracked(event.currentTarget.checked)}
          />
          <span>
            Include {untracked} untracked {untracked === 1 ? "file" : "files"}
          </span>
        </label>
      ) : null}
      <div className="bb-agent-pills__commit-actions">
        {uncommitted ? (
          <>
            <button
              type="button"
              className="bb-agent-pills__commit-button"
              data-variant="primary"
              disabled={blocked}
              title={hint("Commit (Ctrl+Enter)")}
              onClick={() => void runAction("commit")}
            >
              <Icon name="Check" />
              Commit
            </button>
            <button
              type="button"
              className="bb-agent-pills__commit-button"
              disabled={blocked}
              title={hint("Commit and push (Ctrl+Shift+Enter)")}
              onClick={() => void runAction("commit-push")}
            >
              <Icon name="ArrowUp" />
              Commit & Push
            </button>
          </>
        ) : (
          <button
            type="button"
            className="bb-agent-pills__commit-button"
            data-variant="primary"
            disabled={blocked}
            title={hint("Push")}
            onClick={() => void runAction("push")}
          >
            <Icon name="ArrowUp" />
            Push
          </button>
        )}
        <button
          type="button"
          className="bb-agent-pills__commit-button"
          disabled={blocked}
          title={hint(uncommitted ? "Commit, push and open a pull request" : "Push and open a pull request")}
          onClick={() => void runAction("pr")}
        >
          <Icon name="GitPullRequest" />
          Create PR
        </button>
      </div>
      {gitActions === "unavailable" ? (
        <div className="bb-agent-pills__commit-status" data-kind="unavailable" role="note">
          <span className="bb-agent-pills__commit-text" title={UNAVAILABLE_NOTE}>
            {UNAVAILABLE_NOTE}
          </span>
        </div>
      ) : null}
      {phase.kind !== "idle" ? (
        <div className="bb-agent-pills__commit-status" data-kind={phase.kind} key={phase.kind === "busy" ? phase.action : phase.text} role="status">
          {phase.kind === "busy" ? (
            <>
              <Orb />
              <span className="bb-agent-pills__tray-description" data-shimmer="">
                {BUSY_LABEL[phase.action]}…
              </span>
            </>
          ) : phase.kind === "done" ? (
            <>
              <span className="bb-agent-pills__commit-icon" data-tone="good">
                <Icon name="CircleCheck" />
              </span>
              {phase.url ? (
                <a className="bb-agent-pills__commit-link" href={phase.url} target="_blank" rel="noreferrer" title={phase.url}>
                  {phase.text}
                </a>
              ) : (
                <span className="bb-agent-pills__commit-text" title={phase.text}>
                  {phase.text}
                </span>
              )}
            </>
          ) : (
            <>
              <span className="bb-agent-pills__commit-icon" data-tone="bad">
                <Icon name="X" />
              </span>
              <span className="bb-agent-pills__commit-text" title={phase.text}>
                {phase.text}
              </span>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
