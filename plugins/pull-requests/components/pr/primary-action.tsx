import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { MERGE_METHOD_LABEL, MERGE_METHOD_MENU_LABEL, MERGE_SETTINGS_UNKNOWN, mergeChoices, type MergeMethod, type MergeSettings } from "@/lib/merge-method";

export interface PrimaryActionOption {
  key: string;
  label: string;
  run: () => void;
}

export interface PrimaryAction {
  key: string;
  label: string;
  busyLabel: string;
  disabled?: boolean;
  title?: string;
  run: () => void;
  menuLabel?: string;
  menu?: PrimaryActionOption[];
}

export function mergeAction(
  settings: MergeSettings | null | undefined,
  merge: (method: MergeMethod) => void,
  blocked: string | undefined,
): PrimaryAction {
  const choices = mergeChoices(settings);
  return {
    key: "merge",
    label: MERGE_METHOD_LABEL[choices.primary],
    busyLabel: "Merging…",
    disabled: blocked !== undefined,
    title: blocked ?? (choices.known ? undefined : MERGE_SETTINGS_UNKNOWN),
    run: () => merge(choices.primary),
    menuLabel: "Other merge methods",
    menu: choices.others.map((method) => ({ key: method, label: MERGE_METHOD_MENU_LABEL[method], run: () => merge(method) })),
  };
}

export function PrimaryActionButton({ action, busy }: { action: PrimaryAction; busy: string | null }) {
  const disabled = busy !== null || action.disabled === true;
  const menu = action.menu ?? [];
  return (
    <span className="flex shrink-0 items-center" title={action.title}>
      <Button size="sm" className={cn("h-8 text-xs", menu.length > 0 && "rounded-r-none")} disabled={disabled} onClick={action.run}>
        {busy === action.key ? action.busyLabel : action.label}
      </Button>
      {menu.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              className="h-8 w-8 rounded-l-none border-l border-background/25 px-0"
              disabled={disabled}
              aria-label={action.menuLabel ?? "More options"}
            >
              <Icon name="ChevronDown" className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {menu.map((option) => (
              <DropdownMenuItem key={option.key} disabled={disabled} onSelect={option.run}>
                <Icon name="GitMerge" className="size-3.5" />
                {option.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </span>
  );
}
