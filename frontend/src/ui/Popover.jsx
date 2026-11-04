import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  /*
   * Opt-in only, defaulting to false so every existing caller (city
   * picker, account menu, EventSwitcher, every Dropdown -- Dropdown is
   * built on this same primitive) keeps its exact current behaviour.
   *
   * The header's search panel (width="w-96") sits near the header's
   * right edge on a phone, and no amount of fixing the panel's own CSS
   * solved it cleanly: capping max-width left it correctly sized but
   * still anchored off screen from an edge-adjacent trigger; centring it
   * with inset-inline-0 + mx-auto centred the PANEL but, because
   * position: absolute still counts toward its scrolling ancestor's
   * overflow even when nothing visually clips it, a panel extending past
   * both sides of a tiny trigger-sized containing block inflated the
   * whole PAGE's horizontal scroll range -- the second screenshot showed
   * the entire header clipped on both edges, not just the popover.
   *
   * position: fixed does not have that problem -- a fixed element is
   * removed from flow against the viewport itself, so it cannot widen
   * anything it is not a descendant of in the box model sense. True on
   * mobileSheet renders the panel through a portal as a bottom sheet
   * instead -- the same shape Modal.jsx already uses (fixed inset-0,
   * flex items-end sm:items-center) -- rather than trying to out-clever
   * one trigger's position with more absolute-positioning math.
   */
  mobileSheet = false,
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  // The mobile sheet is portaled OUT of rootRef's subtree (to
  // document.body), so the outside-click listener below cannot tell a
  // click inside it from a click on the real page behind it just by
  // checking rootRef -- without this, tapping the search input itself
  // would read as "outside" and close the sheet before anything could
  // be typed into it.
  const sheetRef = useRef(null);
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
      const inRoot = rootRef.current?.contains(event.target);
      const inSheet = sheetRef.current?.contains(event.target);
      if (!inRoot && !inSheet) setOpen(false);
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

      {open && mobileSheet ? (
        // The mobile sheet. Portaled past the header's own backdrop-blur
        // ancestor for the same reason the drawer was -- see SiteHeader's
        // own comment on that fix -- and fixed rather than absolute so it
        // cannot inflate the PAGE's scroll width the way a wide centred
        // absolute panel did (see the long comment on mobileSheet above).
        // sm:hidden: above that breakpoint the normal anchored panel
        // below takes over, where there is room for it near the trigger.
        createPortal(
          <div
            className="fixed inset-0 z-[70] flex items-start justify-center bg-stage/50 p-4 pt-20 backdrop-blur-[2px] sm:hidden"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) close();
            }}
            role="presentation"
          >
            <div
              ref={sheetRef}
              className="w-full max-w-[28rem] overflow-hidden rounded-panel border border-line/10 bg-card text-ink shadow-modal"
            >
              {typeof children === "function" ? children({ close }) : children}
            </div>
          </div>,
          document.body,
        )
      ) : null}

      {open ? (
        <div
          id={id}
          className={cn(
            "absolute top-[calc(100%+0.5rem)] z-50 overflow-hidden rounded-panel border border-line/10 bg-card text-ink shadow-modal",
            align === "end" ? "end-0" : "start-0",
            width,
            panelClassName,
            // The mobile sheet above already covers this panel's job
            // below sm:, so this one stays out of the way there instead
            // of both being mounted and visible at once.
            mobileSheet && "hidden sm:block",
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
