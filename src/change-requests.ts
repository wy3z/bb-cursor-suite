import { experimental_useRpcKeyedQuery } from "@get-bb/plugin-sdk/app";
import {
  CHANGE_REQUESTS_PLUGIN,
  changeRequestsContract,
  OPEN_CHANGE_REQUEST_EVENT,
  rowProvider,
  type ChangeRequest,
  type ChangeRequestRow,
} from "@wy3z/bb-suite/change-requests";

export type GitLabRead =
  | { kind: "notGitLab" }
  | { kind: "gitlab"; changeRequest: ChangeRequest | null };

export function gitLabRead(row: ChangeRequestRow | undefined): GitLabRead {
  if (rowProvider(row) !== "gitlab") return { kind: "notGitLab" };
  return { kind: "gitlab", changeRequest: row?.outcome === "available" ? row.changeRequest : null };
}

export function useGitLabChangeRequest(environmentId: string | null): GitLabRead {
  const { data } = experimental_useRpcKeyedQuery({
    pluginId: CHANGE_REQUESTS_PLUGIN,
    contract: changeRequestsContract,
    method: "changeRequests",
    keys: environmentId === null ? [] : [environmentId],
  });
  return gitLabRead(environmentId === null ? undefined : data?.[environmentId]);
}

export function requestOpenChangeRequest(
  target: EventTarget,
  changeRequest: Pick<ChangeRequest, "identity" | "connection">,
  threadId: string | null,
): boolean {
  const detail = {
    url: changeRequest.identity.url,
    ...(changeRequest.connection ? { connection: changeRequest.connection } : {}),
    ...(threadId ? { threadId } : {}),
  };
  const event = new CustomEvent(OPEN_CHANGE_REQUEST_EVENT, { bubbles: true, cancelable: true, detail });
  return !target.dispatchEvent(event);
}
