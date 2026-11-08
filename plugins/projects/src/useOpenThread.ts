import { useCallback, useMemo } from "react";
import { experimental_useRpcQuery, experimental_useSidebarThreads, useBbContext, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { projectsContract } from "./meta";
import { applyOpenPlan, conversationHidden, findLead, planThreadOpen } from "./thread-tabs";

export function useOpenThread(): (threadId: string, options?: { split?: boolean }) => void {
  const { threadId: current } = useBbContext();
  const navigate = useBbNavigate();
  const { threads } = experimental_useSidebarThreads();
  const leads = experimental_useRpcQuery({ contract: projectsContract, method: "listLeads", input: {} });
  const byId = useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads]);
  const leadIds = useMemo(() => new Set((leads.data?.leads ?? []).map((lead) => lead.threadId)), [leads.data]);

  return useCallback(
    (target: string, options?: { split?: boolean }) => {
      const leadId = findLead(target, byId, leadIds);
      const plan = planThreadOpen({
        target,
        current,
        leadId,
        split: options?.split ?? false,
        conversationHidden: leadId !== null && current === leadId && conversationHidden(),
      });
      applyOpenPlan(plan, navigate);
    },
    [byId, current, leadIds, navigate],
  );
}
