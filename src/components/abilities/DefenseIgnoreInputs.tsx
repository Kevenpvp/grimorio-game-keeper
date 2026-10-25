import { Input } from "@/components/ui/input";
import { DEFENSE_IGNORE_FIELDS, type DefenseIgnore } from "@/lib/defense-ignore";

/** Four independent penetration values, shared by the catalog, hit categories
 * and the individual-target override inside the attack dialog. */
export function DefenseIgnoreInputs({
  value, onChange, disabled=false, title,
}: {
  value: DefenseIgnore;
  onChange: (next: DefenseIgnore) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <div className="space-y-2">
      {title && <p className="text-sm font-semibold text-gold">{title}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        {DEFENSE_IGNORE_FIELDS.map(({ key, label, max }) => (
          <label key={key} className="space-y-1 text-xs font-medium">
            {label}
            <Input
              type="number" min={0} max={max} step={1}
              disabled={disabled} value={value[key]}
              onChange={(event) => {
                const next = event.target.value.trim() ? Number(event.target.value) : 0;
                onChange({ ...value, [key]: Number.isFinite(next) ? Math.max(0,Math.min(max,Math.floor(next))) : 0 });
              }}
            />
          </label>
        ))}
      </div>
    </div>
  );
}
