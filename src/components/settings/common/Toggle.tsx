import { Switch } from '../../ui/Switch';

/** Compatibility row for existing settings consumers; rendering is owned by Switch. */
export function Toggle({
    label,
    description,
    checked,
    onChange,
    disabled = false,
}: {
    label: string;
    description: string;
    checked: boolean;
    onChange: (v: boolean) => void;
    disabled?: boolean;
}) {
    return <Switch label={label} description={description} checked={checked}
        onCheckedChange={onChange} disabled={disabled} aria-disabled={disabled} showLabel />;
}
