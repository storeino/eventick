import { Check, ChevronDown } from "lucide-react";
import { Popover, PopoverItem } from "./Popover.jsx";
import { cn } from "../utils.js";

/**
 * A custom single-select dropdown, for anywhere a native <select> would
 * open the browser's own unstyled popup list — which ignores the app's
 * theme entirely (shows as a plain light list even in dark mode, with OS
 * default highlight colours) and was the one control on the Home hero's
 * search card that broke the custom dark styling the moment it opened.
 *
 * Built on the shared Popover primitive, so it gets Escape/outside-click
 * dismissal and proper aria-haspopup/aria-expanded for free — same
 * foundation EventSwitcher (the /pro dashboard's event picker) already
 * uses. Options are a plain {value, label} array, not <option> children,
 * so the trigger can render a label lookup without re-parsing JSX.
 *
 * Native <select> is still the right choice for an ordinary form field
 * inside a plain white card (see ui/Field.jsx's Select) — reach for this
 * one specifically when the surrounding UI has its own custom chrome that
 * a native popup would visually clash with.
 */
export function Dropdown({
  value,
  onChange,
  options,
  placeholder,
  label,
  /** Id of visible text naming this control; see Popover. */
  labelledBy,
  // Accepted so this can sit inside a <Field> like any other control. The
  // render prop hands down an id and a describedby; without these they were
  // silently dropped, leaving the label pointing at nothing and the error
  // text unannounced.
  id,
  describedBy,
  // A whole control that cannot be changed (the row for your own account in
  // the user list). Forwarded to Popover, which already refuses to open a
  // disabled trigger.
  disabled = false,
  triggerClassName,
  panelClassName,
  align = "start",
  width = "w-full",
  // Opt-in, forwarded straight to Popover -- see its own comment on
  // mobileSheet for why this exists. Defaults to false, so every
  // existing Dropdown caller is unaffected unless it asks for this.
  mobileSheet = false,
}) {
  const current = options.find((option) => option.value === value);

  return (
    <Popover
      label={label ?? placeholder}
      labelledBy={labelledBy}
      align={align}
      mobileSheet={mobileSheet}
      width={width}
      disabled={disabled}
      // Popover's own <button> has no width class, so it shrinks to content
      // by default -- fine for an icon trigger, wrong here where the whole
      // field width (icon + label column) needs to be one clickable target.
      className="block w-full [&>button]:block [&>button]:w-full"
      panelClassName={panelClassName}
      trigger={({ open }) => (
        <span
          id={id}
          aria-describedby={describedBy}
          className={cn("flex w-full items-center justify-between gap-2 text-start", triggerClassName)}
        >
          <span className={cn("truncate", !current && "text-muted")}>{current ? current.label : placeholder}</span>
          <ChevronDown className={cn("size-4 shrink-0 text-muted transition", open && "rotate-180")} aria-hidden />
        </span>
      )}
    >
      {({ close }) => (
        <div className="scroll-thin max-h-72 overflow-y-auto py-1.5">
          {options.map((option) => (
            <PopoverItem
              key={option.value}
              // `option.disabled` exists for a value the list must DISPLAY but
              // must not let you pick -- an existing ADMIN in the role picker,
              // which has to render its own current value or the trigger would
              // read blank, while nobody may be promoted into it from there.
              disabled={option.disabled}
              onClick={() => {
                if (option.disabled) return;
                onChange(option.value);
                close();
              }}
              className="justify-between"
            >
              <span className="truncate">{option.label}</span>
              {option.value === value ? <Check className="size-4 shrink-0 text-primary" aria-hidden /> : null}
            </PopoverItem>
          ))}
        </div>
      )}
    </Popover>
  );
}
