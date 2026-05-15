import { Button } from '../ui/Button';

export interface VaultModeOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

interface VaultModeSwitchProps<T extends string> {
  value: T;
  options: VaultModeOption<T>[];
  onChange: (value: T) => void;
  ariaLabel?: string;
}

export function VaultModeSwitch<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: VaultModeSwitchProps<T>) {
  return (
    <div
      className="rounded-lg border border-[var(--color-app-border)]/50 bg-[var(--color-app-surface)]/20 p-1"
      role="radiogroup"
      aria-label={ariaLabel || 'Vault mode'}
    >
      <div className="flex gap-2">
        {options.map((option) => (
          <Button
            key={option.value}
            type="button"
            size="sm"
            variant={value === option.value ? 'primary' : 'ghost'}
            className="flex-1"
            onClick={() => onChange(option.value)}
            disabled={option.disabled}
            role="radio"
            aria-checked={value === option.value}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
