import { Eye, EyeOff } from 'lucide-react';
import { Input } from '../ui/Input';

interface SecretFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  showSecret: boolean;
  onToggleShow: () => void;
  placeholder?: string;
  autoFocus?: boolean;
}

export function SecretField({
  label,
  value,
  onChange,
  showSecret,
  onToggleShow,
  placeholder,
  autoFocus,
}: SecretFieldProps) {
  return (
    <Input
      label={label}
      type={showSecret ? 'text' : 'password'}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      autoFocus={autoFocus}
      placeholder={placeholder}
      rightElement={(
        <button
          type="button"
          onClick={onToggleShow}
          aria-pressed={showSecret}
          aria-label={showSecret ? `Hide ${label}` : `Show ${label}`}
          className="p-1.5 -m-1.5 rounded text-app-muted hover:text-app-text transition-colors"
        >
          {showSecret ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      )}
    />
  );
}
