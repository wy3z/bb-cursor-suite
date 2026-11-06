import { useEffect, useRef, useState } from "react";
import { experimental_Icon as Icon, useRpc } from "@get-bb/plugin-sdk/app";
import { agentPillsRpcContract, type GitActionResult } from "./rpc";
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

function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : "";
}

export function CommitBar({
  environmentId,
  uncommitted,
  untracked,
}: {
  environmentId: string;
  uncommitted: boolean;
  untracked: number;
}) {
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const needsMessage = untracked > 0 && !includeUntracked;
  const rpc = useRpc<typeof agentPillsRpcContract>();
  const [message, setMessage] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const textRef = useRef<HTMLTextAreaElement>(null);
  const busy = phase.kind === "busy";

  useEffect(() => {
    const text = textRef.current;
    if (!text) return;
    text.style.height = "auto";
    text.style.height = `${Math.min(text.scrollHeight, 96)}px`;
  }, [message, uncommitted]);

  const fail = (result: GitActionResult | null, fallback: string) =>
    setPhase({ kind: "error", text: result?.error ?? fallback });

  const runAction = async (action: Action) => {
    if (busy) return;
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
    <div className="bb-agent-pills__commit" data-busy={busy || undefined}>
      {uncommitted ? (
        <textarea
          ref={textRef}
          className="bb-agent-pills__commit-message"
          rows={1}
          value={message}
          disabled={busy}
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
            disabled={busy}
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
              disabled={busy}
              title="Commit (Ctrl+Enter)"
              onClick={() => void runAction("commit")}
            >
              <Icon name="Check" />
              Commit
            </button>
            <button
              type="button"
              className="bb-agent-pills__commit-button"
              disabled={busy}
              title="Commit and push (Ctrl+Shift+Enter)"
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
            disabled={busy}
            onClick={() => void runAction("push")}
          >
            <Icon name="ArrowUp" />
            Push
          </button>
        )}
        <button
          type="button"
          className="bb-agent-pills__commit-button"
          disabled={busy}
          title={uncommitted ? "Commit, push and open a pull request" : "Push and open a pull request"}
          onClick={() => void runAction("pr")}
        >
          <Icon name="GitPullRequest" />
          Create PR
        </button>
      </div>
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
