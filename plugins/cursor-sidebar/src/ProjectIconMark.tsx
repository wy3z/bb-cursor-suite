import { experimental_Icon as HostIcon } from "@get-bb/plugin-sdk/app";
import { ProjectIconGlyph } from "@wy3z/bb-suite/project-icon/picker";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { ProjectIcon } from "./project-icons";
import { projectIconColorClassName } from "./project-icons";
import { ProjectMonogram } from "./ProjectMonogram";

export const BOARD_FALLBACK = "board";
export const BOARD_HOST_ICON = "bb-projects:project";

export function ProjectIconMark({
  icon,
  fallback,
  className,
  mutedClassName,
}: {
  icon: ProjectIcon | null;
  fallback: IconName | typeof BOARD_FALLBACK;
  className: string;
  mutedClassName?: string | undefined;
}) {
  if (icon?.kind === "image") {
    return (
      <img
        src={icon.src}
        alt=""
        aria-hidden="true"
        draggable={false}
        className={cn("shrink-0 object-contain", className)}
      />
    );
  }

  if (icon?.kind === "emoji") {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex shrink-0 items-center justify-center leading-none [container-type:size]",
          className,
        )}
      >
        <span className="text-[length:80cqh] leading-none">{icon.emoji}</span>
      </span>
    );
  }

  if (icon?.kind === "monogram") {
    return <ProjectMonogram text={icon.text} color={icon.color} className={className} />;
  }

  if (icon?.kind === "glyph") {
    return (
      <ProjectIconGlyph
        name={icon.name}
        strokeWidth={2}
        className={cn(
          "shrink-0",
          className,
          icon.color !== undefined ? projectIconColorClassName(icon.color) : mutedClassName,
        )}
      />
    );
  }

  if (fallback === BOARD_FALLBACK) {
    return (
      <span aria-hidden="true" className={cn("inline-flex shrink-0 items-center justify-center", className, mutedClassName)}>
        <HostIcon name={BOARD_HOST_ICON as "Layers"} className="size-full" />
      </span>
    );
  }

  return (
    <Icon
      name={fallback}
      aria-hidden="true"
      strokeWidth={2}
      className={cn("shrink-0", className, mutedClassName)}
    />
  );
}
