import { useId, type MouseEvent, type ReactNode } from "react";

export const DEVICE_ONLY = "This device only.";

export type SettingsPlacement = "inline" | "below";

export interface SettingsRowIds {
  labelId: string;
  descriptionId: string | undefined;
}

export function SettingsCard({ children }: { children: ReactNode }) {
  return <div className="bbs-settings-card">{children}</div>;
}

export function SettingsRow({
  label,
  description,
  placement = "inline",
  pinned = false,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  placement?: SettingsPlacement;
  pinned?: boolean;
  children?: ReactNode | ((ids: SettingsRowIds) => ReactNode);
}) {
  const id = useId();
  const ids: SettingsRowIds = {
    labelId: `${id}-label`,
    descriptionId: description ? `${id}-description` : undefined,
  };
  const control = typeof children === "function" ? children(ids) : children;
  return (
    <div className="bbs-settings-row">
      <div
        className="bbs-settings-row__body"
        data-placement={placement}
        data-pinned={pinned ? "" : undefined}
        data-described={description ? "" : undefined}
      >
        <div className="bbs-settings-row__text">
          <p className="bbs-settings-row__label" id={ids.labelId}>
            {label}
          </p>
          {description ? (
            <p className="bbs-settings-row__description" id={ids.descriptionId}>
              {description}
            </p>
          ) : null}
        </div>
        {control === undefined || control === null ? null : (
          <div className="bbs-settings-row__control">{control}</div>
        )}
      </div>
    </div>
  );
}

export function SettingsSwitch({
  checked,
  onCheckedChange,
  disabled = false,
  "aria-label": ariaLabel,
  "aria-labelledby": labelledBy,
  "aria-describedby": describedBy,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}) {
  const state = checked ? "checked" : "unchecked";
  return (
    <button
      type="button"
      role="switch"
      className="bbs-settings-switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      data-state={state}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
    >
      <span aria-hidden="true" className="bbs-settings-switch__thumb" data-state={state} />
    </button>
  );
}

export function SettingsToggleRow({
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
}: {
  label: string;
  description?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <SettingsRow label={label} description={description} pinned>
      {({ labelId, descriptionId }) => (
        <SettingsSwitch
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={disabled}
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
        />
      )}
    </SettingsRow>
  );
}

export interface SettingsOption<Value extends string> {
  value: Value;
  label: string;
}

export function SettingsSelect<Value extends string>({
  value,
  options,
  onChange,
  disabled,
  "aria-labelledby": labelledBy,
  "aria-describedby": describedBy,
}: {
  value: Value;
  options: readonly SettingsOption<Value>[];
  onChange: (value: Value) => void;
  disabled?: boolean;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}) {
  return (
    <select
      className="bbs-settings-select"
      value={value}
      disabled={disabled}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onChange={(event) => {
        const next = options.find((option) => option.value === event.currentTarget.value);
        if (next) onChange(next.value);
      }}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function SettingsSelectRow<Value extends string>({
  label,
  description,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  description?: ReactNode;
  value: Value;
  options: readonly SettingsOption<Value>[];
  onChange: (value: Value) => void;
  disabled?: boolean;
}) {
  return (
    <SettingsRow label={label} description={description}>
      {({ labelId, descriptionId }) => (
        <SettingsSelect
          value={value}
          options={options}
          onChange={onChange}
          disabled={disabled}
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
        />
      )}
    </SettingsRow>
  );
}

export function SettingsButton({
  children,
  onClick,
  disabled,
  "aria-describedby": describedBy,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  "aria-describedby"?: string;
}) {
  return (
    <button
      type="button"
      className="bbs-settings-button"
      disabled={disabled}
      aria-describedby={describedBy}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function openAppPath(path: string): void {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
}

export function SettingsLinkButton({
  href,
  children,
  "aria-describedby": describedBy,
}: {
  href: string;
  children: ReactNode;
  "aria-describedby"?: string;
}) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openAppPath(href);
  };
  return (
    <a className="bbs-settings-button" href={href} aria-describedby={describedBy} onClick={onClick}>
      {children}
    </a>
  );
}
