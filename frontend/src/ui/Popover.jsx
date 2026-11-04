import { useEffect, useId, useRef, useState } from "react";
import { cn } from "../utils";

/**
 * A button that opens a panel anchored to it.
 *
 * The public header had three of these written by hand — the city picker, the
 * search panel and the account controls — and **none** of them handled Escape
 * or an outside click. Opening the city list and clicking anywhere else left
 * it hanging over the page until you clicked the trigger again.
 *
 * Doing it once here means every popover in the app dismisses the way people
 * expect, and the trigger/panel relationship is announced properly.
 */
export function Popover({
  label,
  // An id pointing at visible text that already names this control. Preferred
  // over `label` where such text exists: one string on screen and in the
  // accessibility tree, instead of two that drift.
  labelledBy,
  trigger,
  align = "start",
  width = "w-56",
  children,
  className,
  panelClassName,
  // DateField and TimeField already style their trigger as disabled, but
  // without this the panel still opened on click — a control that looks
  // unavailable and isn't.
  disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;

    const onKey = (event) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      // Focus goes back to the trigger, not to the top of the page.
      triggerRef.current?.focus();
    };
    const onPointer = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };

    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled || undefined}
        onClick={() => setOpen((prev) => !prev)}
      >
        {typeof trigger === "function" ? trigger({ open }) : trigger}
      </button>

      {open ? (
        <div
          id={id}
          className={cn(
            // Capping width alone was NOT enough -- reported with a second
            // screenshot. The search trigger sits near the header's right
            // edge on a phone (hamburger, search icon, create button and
            // avatar all crowd that side); align="end" anchors the panel's
            // RIGHT edge there and grows it LEFTWARD, so even a panel
            // correctly capped under 300px still started from a point near
            // the viewport's own right edge and ran off the LEFT side
            // entirely -- a narrower box in the wrong place is still off
            // screen. end-0/start-0 describe which edge to grow from, not
            // where on the viewport that edge actually sits once the
            // trigger itself is close to one side.
            //
            // Fixed with inset-inline-0 + mx-auto below sm:, the same
            // centring technique already used by TicketPass's QR perforation
            // and the pro dashboard's InfoTip (see both) -- NOT start-1/2 +
            // -translate-x-1/2, which was tried here first and reverted: a
            // negative translate-x is a PHYSICAL transform, so it does not
            // mirror under RTL and would pull the panel further off-centre
            // in Arabic rather than centring it. inset-inline-0 is a logical
            // property, so this has no horizontal transform to mirror at
            // all. Above sm: back to the original edge-anchored behaviour,
            // where every existing caller already has the room for it.
            "absolute top-[calc(100%+0.5rem)] z-50 max-w-[calc(100vw-2rem)] overflow-hidden rounded-panel border border-line/10 bg-card text-ink shadow-modal",
            "inset-inline-0 mx-auto sm:inset-inline-auto sm:mx-0",
            align === "end" ? "sm:end-0" : "sm:start-0",
            width,
            panelClassName,
          )}
        >
          {typeof children === "function" ? children({ close }) : children}
        </div>
      ) : null}
    </div>
  );
}

/** A row inside a Popover panel. */
export function PopoverItem({ as: As = "button", className, children, ...rest }) {
  return (
    <As
      className={cn(
        "flex w-full items-center gap-2.5 px-4 py-2.5 text-start text-sm font-semibold text-ink transition hover:bg-paper",
        // `disabled` already reaches the <button> through ...rest, but a
        // native disabled button still LOOKS identical to an enabled one
        // here -- the row has its own colours, so it needs saying twice.
        rest.disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
        className,
      )}
      {...(As === "button" ? { type: "button" } : null)}
      {...rest}
    >
      {children}
    </As>
  );
}
