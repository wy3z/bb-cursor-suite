import { useEffect, useMemo, useState } from "react";
import { experimental_useSidebarThreads as useSidebarThreads } from "@get-bb/plugin-sdk/app";
import { buildSettledSection, flattenShelf } from "./forest";
import { ACTIVITY_SETTLED_KEY, archivedNewestFirst, settledMembers, threadsPerGroupPage } from "./sidebar-view";
import { SectionDivider } from "./SectionDivider";
import { Drawer } from "./Drawer";
import { ShowMoreButton } from "./ShowMoreButton";
import { ShelfList, type TreeContext } from "./ThreadTree";

const ARCHIVED_LIFECYCLES = ["archived"] as const;
const SETTLED_SECTION_ID = "activity-settled";
const NOTE = "cs-row-note py-2 text-xs text-[color:var(--bbs-text-secondary)]";

export function SettledSection({ ctx }: { ctx: TreeContext }) {
  const open = ctx.expandedActivity.has(ACTIVITY_SETTLED_KEY);
  return (
    <div className="mt-2">
      <SectionDivider
        label="Settled"
        open={open}
        onToggle={() => ctx.onToggleActivity(ACTIVITY_SETTLED_KEY)}
        shelfKey={ACTIVITY_SETTLED_KEY}
      />
      <Drawer open={open}>{open ? <ArchivedThreads ctx={ctx} /> : null}</Drawer>
    </div>
  );
}

function ArchivedThreads({ ctx }: { ctx: TreeContext }) {
  const { threads, experimental_archived: archive } = useSidebarThreads({
    experimental_lifecycles: ARCHIVED_LIFECYCLES,
  });
  const pageSize = threadsPerGroupPage(ctx.view.threadsPerGroup);
  const [pages, setPages] = useState(1);
  const [lastPageSize, setLastPageSize] = useState(pageSize);
  if (lastPageSize !== pageSize) {
    setLastPageSize(pageSize);
    setPages(1);
  }
  const projectFilter = ctx.view.projectFilter;
  const { section, families } = useMemo(() => {
    const pooled = buildSettledSection(settledMembers(threads, projectFilter), SETTLED_SECTION_ID, archivedNewestFirst);
    const chunks: string[][] = [];
    for (const row of flattenShelf(pooled, "settled")) {
      if (row.depth === 0 || chunks.length === 0) chunks.push([row.thread.id]);
      else chunks[chunks.length - 1]!.push(row.thread.id);
    }
    return { section: pooled, families: chunks };
  }, [threads, projectFilter]);
  const limit = pages * pageSize;
  const keepIds = useMemo(() => new Set(families.slice(0, limit).flat()), [families, limit]);
  const settledCtx = useMemo<TreeContext>(
    () => ({
      ...ctx,
      canDragThreads: false,
      onThreadDragStart: () => undefined,
      onThreadDragPickUp: () => undefined,
    }),
    [ctx],
  );
  const needsMore = archive !== null && families.length < limit && archive.hasNextPage;
  const fetching = archive?.isFetchingNextPage ?? false;
  const fetchFailed = archive?.isFetchNextPageError ?? false;
  useEffect(() => {
    if (archive === null || !needsMore || fetching || fetchFailed) return;
    void archive.fetchNextPage();
  }, [archive, needsMore, fetching, fetchFailed]);

  if (archive?.status === "error") return <p className={NOTE}>Couldn't load archived threads.</p>;
  if (families.length === 0) {
    return (
      <p className={NOTE}>
        {archive === null || archive.status === "loading" || archive.hasNextPage
          ? "Loading archived threads…"
          : "No archived threads"}
      </p>
    );
  }
  const hidden = Math.max(0, families.length - limit);
  const more = hidden > 0 ? hidden : archive?.hasNextPage && !fetching ? pageSize : 0;
  return (
    <>
      <ShelfList section={section} shelf="settled" ctx={settledCtx} keepIds={keepIds} grouped={false} />
      <ShowMoreButton
        hiddenConversations={more}
        pageSize={pageSize}
        onShowMore={() => setPages((current) => current + 1)}
      />
    </>
  );
}
