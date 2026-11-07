import type { ReactElement, ReactNode } from "react";
import { HoverCard, HoverCardFacts, HoverCardStatus, HoverCardTitle, type HoverFact } from "./HoverCard";

export interface ThreadHoverFact extends HoverFact {
  text: string;
  detail?: string | null;
}

export function ThreadHoverCard({
  disabled,
  title,
  status,
  facts,
  extra,
  children,
}: {
  disabled: boolean;
  title: string;
  status: ReactNode;
  facts: readonly ThreadHoverFact[];
  extra?: ReactNode;
  children: ReactElement;
}) {
  return (
    <HoverCard
      disabled={disabled}
      focusSelector="[data-thread-focus-id]"
      className="cs-thread-hover"
      content={
        <>
          <HoverCardTitle>{title}</HoverCardTitle>
          <HoverCardStatus>{status}</HoverCardStatus>
          <HoverCardFacts facts={facts} />
          {extra}
        </>
      }
    >
      {children}
    </HoverCard>
  );
}
