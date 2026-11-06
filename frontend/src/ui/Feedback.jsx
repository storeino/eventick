import { AlertTriangle, Inbox, RefreshCw } from "lucide-react";
import { Button } from "./Button";
import { cn } from "../utils";

/**
 * The four states every data surface has.
 *
 * `useCatalog` used to return `events ?? []` and swallow fetch failures into
 * `[]` as well, so "still loading", "nothing here" and "the request failed"
 * all rendered as the same empty grid. These make the three distinguishable,
 * and `DataState` makes choosing between them a single call rather than a
 * conditional ladder each screen writes differently.
 */

export function Skeleton({ className }) {
  return <div className={cn("animate-pulse rounded-control bg-mist/25", className)} aria-hidden />;
}

/** A skeleton that announces itself, for a whole region that is still loading. */
export function LoadingState({ label, rows = 3, className }) {
  return (
    <div className={cn("grid gap-3", className)} role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-24 w-full" />
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, body, action, className }) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-14 text-center", className)}>
      <span className="inline-flex size-14 items-center justify-center rounded-card bg-brume text-primary" aria-hidden>
        {icon ?? <Inbox className="size-6" />}
      </span>
      <p className="mt-4 font-display text-subhead font-bold">{title}</p>
      {body ? <p className="mt-1.5 max-w-sm text-sm text-muted">{body}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

/**
 * A failure the user can act on. Distinct from empty on purpose: "no events
 * match your filters" and "we could not reach the server" need different
 * words and different buttons.
 */
export function ErrorState({ title, body, onRetry, retryLabel, className }) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-14 text-center", className)} role="alert">
      <span className="inline-flex size-14 items-center justify-center rounded-card bg-danger-bg text-danger" aria-hidden>
        <AlertTriangle className="size-6" />
      </span>
      <p className="mt-4 font-display text-subhead font-bold">{title}</p>
      {body ? <p className="mt-1.5 max-w-sm text-sm text-muted">{body}</p> : null}
      {onRetry ? (
        <Button variant="secondary" className="mt-5" icon={<RefreshCw className="size-4" />} onClick={onRetry}>
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Picks the right state for a data region.
 *
 * Order matters: error beats loading (a retry must be reachable even if a
 * refetch is in flight), and loading beats empty (so a slow fetch never
 * flashes "nothing found" first — the bug this replaces).
 */
export function DataState({ loading, error, empty, loadingState, errorState, emptyState, children }) {
  if (error) return errorState;
  if (loading) return loadingState;
  if (empty) return emptyState;
  return children;
}

const TONES = {
  neutral: "bg-paper text-muted",
  primary: "bg-brume text-primary",
  success: "bg-success-bg text-success",
  warn: "bg-warn-bg text-warn",
  danger: "bg-danger-bg text-danger",
  info: "bg-info-bg text-info",
  // Solid fill, not a tint: the accent lime is already high-luminance, so a
  // soft 20%-opacity wash nearly disappeared on both a white card and a
  // near-black one. This is the one tone meant to interrupt — a live pulse,
  // a scarcity badge — so it gets full strength.
  accent: "bg-accent text-accent-fg",
};

export function Badge({ tone = "neutral", icon, children, className, wrap = false }) {
  return (
    <span
      className={cn(
        // whitespace-nowrap by default: a badge is a short status label,
        // never a sentence. Without it "On sale" broke across two lines in
        // a narrow table column and the pill wrapped around them, which
        // reads as a squashed button rather than a status.
        //
        // `wrap` is the exception, for the rare badge that carries a whole
        // sentence (the scope.any warning on /pro/permissions is 410px in
        // English, 515px in French -- it cannot fit a phone on one line and
        // ran out of its card). It REPLACES the nowrap rather than adding
        // an override beside it: cn() is a plain join, not tailwind-merge,
        // so passing whitespace-normal in className would leave both on the
        // element and let stylesheet order pick the winner.
        //
        // items-start with it, so the icon sits on the first line instead
        // of floating beside the middle of a three-line sentence.
        wrap ? "inline-flex items-start gap-1.5 whitespace-normal text-start" : "inline-flex items-center gap-1.5 whitespace-nowrap",
        "rounded-full px-2.5 py-1 text-xs font-bold",
        TONES[tone],
        className,
      )}
    >
      {icon ? (
        <span className="shrink-0" aria-hidden>
          {icon}
        </span>
      ) : null}
      {children}
    </span>
  );
}

/**
 * An inline message. `tone` carries meaning, but the icon and the words carry
 * it too — colour alone fails for the ~8% of men with a colour deficiency,
 * and fails everyone in bright sunlight at a venue door.
 */
export function Notice({ tone = "info", icon, title, children, className }) {
  return (
    <div className={cn("flex items-start gap-3 rounded-control px-4 py-3", TONES[tone], className)}>
      {icon ? (
        <span className="mt-0.5 shrink-0" aria-hidden>
          {icon}
        </span>
      ) : null}
      <div className="min-w-0 text-sm">
        {title ? <p className="font-bold">{title}</p> : null}
        {children ? <div className={cn(title && "mt-0.5", "opacity-90")}>{children}</div> : null}
      </div>
    </div>
  );
}
