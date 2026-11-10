import { forwardRef } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "../utils";

/**
 * The one button.
 *
 * Before this existed the buyer screens hand-wrote 69 distinct button class
 * strings — three different heights, two different disabled opacities, and a
 * primary action that was Safran on Checkout but Lagon on the event page, so
 * nobody could learn what "the go colour" was.
 *
 * `variant` is the only way to express intent. `primary` is NOT a brand
 * colour fill here — per the v3 reference it is a near-black pill (near-white
 * in dark mode) via the dedicated `--color-action` tokens, with pink reserved
 * for the brand itself (logo, active nav, links, badges). A button never
 * carries the brand colour as its own background; `brand` exists for the rare
 * exception that genuinely wants it (a hero "get the app" style moment), and
 * even then it is used sparingly on purpose.
 */

const VARIANTS = {
  primary: "bg-action text-action-fg hover:bg-action-hover shadow-sm border border-line/10",
  secondary: "border border-line/20 bg-card text-ink hover:bg-paper",
  ghost: "text-primary hover:bg-brume",
  danger: "bg-danger text-danger-fg hover:brightness-110",
  brand: "bg-primary text-primary-fg hover:bg-primary-hover shadow-sm",
  // For a button sitting on a deliberately-dark surface (a bg-stage panel,
  // a photographic hero) regardless of app theme — stage-fg, not foam, which
  // flips with the theme and would turn this invisible-on-dark in dark mode.
  inverse: "bg-stage-fg/15 text-stage-fg backdrop-blur-sm hover:bg-stage-fg/25 border border-stage-fg/25",
  /*
   * The PRIMARY action on one of those dark surfaces.
   *
   * `primary` cannot be used there. It fills with --color-action, which is
   * near-white in dark mode and near-BLACK in light mode — and a stage panel
   * is #141418 in both. So in light mode the main call to action was a black
   * pill on a black card: present, clickable, and invisible.
   *
   * `inverse` is the quiet version of the same idea, a translucent wash for
   * a secondary control on a photo. A primary CTA needs the weight of a
   * solid fill, so this is the opaque one: stage-fg (#ffffff in BOTH themes)
   * with stage ink on top, which cannot flip into its own background.
   */
  inversePrimary: "bg-stage-fg text-stage hover:bg-stage-fg/90 shadow-sm border border-stage-fg",
};

const SIZES = {
  // 44px floor on sm so every control still clears the touch target.
  sm: "h-9 min-h-11 px-3.5 text-[13px] sm:min-h-9",
  md: "h-11 px-5 text-sm",
  lg: "h-13 px-6 text-[15px]",
};

export const Button = forwardRef(function Button(
  {
    variant = "primary",
    size = "md",
    loading = false,
    icon = null,
    iconEnd = null,
    full = false,
    className,
    type = "button",
    disabled,
    children,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      // A loading button must not be pressable twice, so loading implies
      // disabled rather than relying on every call site to pass both.
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-2 rounded-full font-semibold",
        "transition-[background-color,border-color,color,transform,box-shadow] duration-150",
        "active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100",
        VARIANTS[variant],
        SIZES[size],
        full && "w-full",
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
      ) : icon ? (
        <span className="shrink-0" aria-hidden>
          {icon}
        </span>
      ) : null}
      {children ? <span className="truncate">{children}</span> : null}
      {iconEnd && !loading ? (
        <span className="shrink-0" aria-hidden>
          {iconEnd}
        </span>
      ) : null}
    </button>
  );
});

/**
 * A square icon-only button. `label` is required and becomes the accessible
 * name — an icon button with no label is invisible to a screen reader, which
 * is how the old ad-hoc ones shipped.
 */
export const IconButton = forwardRef(function IconButton(
  { label, tone = "neutral", size = "md", className, type = "button", children, ...rest },
  ref,
) {
  const tones = {
    neutral: "text-muted hover:bg-brume hover:text-primary",
    danger: "text-muted hover:bg-danger-bg hover:text-danger",
    // Same reasoning as Button's inverse variant: for a fixed-dark surface,
    // not the theme-reactive foam/encre.
    inverse: "text-stage-fg/80 hover:bg-stage-fg/15 hover:text-stage-fg",
  };
  const sizes = { sm: "size-9", md: "size-11", lg: "size-12" };

  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-control transition duration-150",
        "active:scale-95 disabled:cursor-not-allowed disabled:opacity-50",
        tones[tone],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});
