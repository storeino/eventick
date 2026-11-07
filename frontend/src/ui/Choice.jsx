import { Check as CheckIcon } from "lucide-react";
import { cn } from "../utils.js";

/**
 * Custom radio and checkbox rows for filter lists — a bare <input
 * type="radio"/"checkbox"> renders as a tiny OS-default control with almost
 * no visual weight (confirmed against a real screenshot of Explorer's city
 * filter: barely-there circles, no hover state, no sense of the row being
 * clickable beyond the input itself). These give the whole row a hit target
 * and draw the indicator themselves, with the native input kept but visually
 * hidden (sr-only) so keyboard/screen-reader behaviour is unchanged.
 */
export function RadioOption({ checked, label, count, onChange, name }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-2 rounded-control px-2 py-2 text-sm transition hover:bg-paper">
      <span className="flex items-center gap-2.5">
        <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
          <input type="radio" name={name} checked={checked} onChange={onChange} className="peer sr-only" />
          <span
            className={cn(
              "size-4 rounded-full border-2 transition",
              checked ? "border-primary" : "border-line/30 peer-hover:border-primary/50",
            )}
            aria-hidden
          />
          {checked ? <span className="absolute size-2 rounded-full bg-primary" aria-hidden /> : null}
        </span>
        <span className={checked ? "font-semibold text-ink" : "text-ink"}>{label}</span>
      </span>
      {count !== undefined ? <span className="text-xs text-muted tabular-nums">{count}</span> : null}
    </label>
  );
}

export function CheckOption({ label, checked, onChange, ariaLabel }) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 rounded-control px-2 py-2 text-sm transition hover:bg-paper">
      <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          className="peer sr-only"
          /* For a box in a list, where the row is the visible label and
             there is no text to tie to. */
          aria-label={!label && ariaLabel ? ariaLabel : undefined}
        />
        <span
          className={cn(
            "flex size-4 items-center justify-center rounded-[5px] border-2 transition",
            checked ? "border-primary bg-primary" : "border-line/30 bg-transparent peer-hover:border-primary/50",
          )}
          aria-hidden
        >
          {checked ? <CheckIcon className="size-3 text-primary-fg" strokeWidth={3} /> : null}
        </span>
      </span>
      {label ? (
        <span className={checked ? "font-semibold text-ink" : "text-ink"}>{label}</span>
      ) : null}
    </label>
  );
}
