import type { ReactNode } from "react";

export interface SortOption<T extends string> {
  key: T;
  label: string;
  icon: ReactNode;
}

/**
 * Icon-only sort buttons in one rounded group, the same bar SongYUE2 uses: an optional action first
 * (separated by a divider), then one button per order. Each button explains itself on hover and the
 * chosen order is filled in.
 */
export function SortBar<T extends string>({
  options,
  value,
  onChange,
  leading,
  label = "정렬",
  compact = false,
}: {
  options: Array<SortOption<T>>;
  value: T;
  onChange: (key: T) => void;
  /** An action shown before the sort buttons, e.g. a refresh button. */
  leading?: ReactNode;
  label?: string;
  compact?: boolean;
}) {
  return (
    <span className={`sortbar${compact ? " compact" : ""}`} role="group" aria-label={label}>
      {leading}
      {leading && <i className="sortbar-sep" aria-hidden="true" />}
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          className={value === option.key ? "active" : ""}
          aria-label={option.label}
          aria-pressed={value === option.key}
          title={option.label}
          onClick={() => onChange(option.key)}
        >
          {option.icon}
        </button>
      ))}
    </span>
  );
}
