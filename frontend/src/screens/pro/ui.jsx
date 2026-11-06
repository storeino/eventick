// Dashboard-specific primitives.
//
// The generic ones (Button, Modal, Badge, Card, EmptyState, Skeleton) now come
// from src/ui and are re-exported here under the names the pro screens already
// import. Keeping a second copy was how the buyer side and the dashboard ended
// up with different buttons and four incompatible modals.
//
// What stays below is genuinely dashboard-only: the data table, the stat card,
// and the table cell renderers.
import { useState } from "react";
import { ChevronLeft, ChevronRight, Info, Search, X } from "lucide-react";
import { cn } from "../../utils";
import { Badge, Button, Card, Dropdown, EmptyState, IconButton, Modal, Skeleton, triggerControlClass } from "../../ui";

export { Badge, Card, EmptyState, Modal, Skeleton };
/** Alias: the pro screens call it Btn. */
export const Btn = Button;
/** Alias: the pro screens call it IconBtn. `label` is required by IconButton,
 * which is what makes these announce themselves to a screen reader. */
export const IconBtn = IconButton;

export function PageHead({ title, sub, actions }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="font-display text-[26px] font-bold leading-tight tracking-tight">{title}</h1>
        {sub ? <p className="mt-0.5 text-sm text-muted">{sub}</p> : null}
      </div>
      {/* Below sm every action takes the full line.

          These children carry widths meant for the wide layout (w-56, a
          14rem min-width, a button sized to its label). Once the row wraps
          on a phone each one sat at that width on a line of its own with
          100-170px of dead space beside it.

          Done with a child selector rather than a class on each call site,
          so a new action is right by default. items-stretch would not do
          it: that stretches the CROSS axis, and a button on its own line
          keeps its content width. [&>*] also reaches the Btn, which
          carries shrink-0 and would otherwise never grow. */}
      {actions ? (
        <div className="flex w-full flex-wrap items-center gap-2.5 [&>*]:w-full sm:w-auto sm:[&>*]:w-auto">
          {actions}
        </div>
      ) : null}
    </div>
  );
}

export function SectionTitle({ children, action }) {
  return (
    <div className="mb-4 mt-8 flex items-center justify-between gap-3">
      {/* min-w-0 + truncate: the heading sits on one line beside an action
          link, and without a floor it held the whole card open at the
          title's own width on a phone. */}
      <h2 className="min-w-0 truncate font-display text-[22px] font-bold tracking-tight">{children}</h2>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}


/** A hover/focus tooltip for a stat label whose meaning is not obvious at a
 * glance. Positioned with inset-inline + margin:auto rather than
 * `start-1/2 -translate-x-1/2`: a negative translate-x does not mirror under
 * RTL, so that approach drifted off-centre in Arabic. */
export function InfoTip({ text }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-label={text}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="inline-flex size-4 items-center justify-center rounded-full text-muted transition hover:text-primary"
      >
        <Info className="size-3.5" />
      </button>
      {open ? (
        <span className="absolute bottom-full z-50 mb-1.5 inset-inline-0 mx-auto w-56 rounded-control bg-stage px-3 py-2 text-xs font-medium normal-case tracking-normal text-stage-fg shadow-pop">
          {text}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The dashboard's headline metric tile.
 *
 * Shape v2: the left accent bar is gone — every tile had one, so by the third
 * card it stopped reading as a signal and just became a stripe. In its place,
 * a flat icon tile (square, not circular, filled solid rather than tinted)
 * marks the category, and `accent` now distinguishes the one metric meant to
 * draw the eye (e.g. gross sales) by giving IT the lime fill, leaving the
 * others a quiet neutral tile — closer to how a Linear/Vercel dashboard uses
 * one bright moment per screen instead of six faint ones.
 */
export function StatCard({ icon, label, value, sub, trend, accent, info }) {
  return (
    <div className="rounded-card border border-line/10 bg-card p-5 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1 text-[11px] font-bold uppercase tracking-[0.06em] text-muted">
            {label}
            {info ? <InfoTip text={info} /> : null}
          </p>
          <p className="mt-1.5 font-display text-2xl font-bold tracking-tight tabular-nums">{value}</p>
        </div>
        {icon ? (
          <div
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-control",
              accent ? "bg-accent text-accent-fg" : "bg-sunken text-muted",
            )}
            aria-hidden
          >
            {icon}
          </div>
        ) : null}
      </div>
      {sub || trend ? (
        <div className="mt-3 flex items-center justify-between gap-2.5 border-t border-line/10 pt-3">
          {sub ? <span className="truncate text-xs text-muted">{sub}</span> : <span />}
          {trend ? (
            <span
              className={cn(
                "shrink-0 rounded-control px-2 py-0.5 text-xs font-bold",
                trend.dir === "up" && "bg-success-bg text-success",
                trend.dir === "down" && "bg-danger-bg text-danger",
                trend.dir === "flat" && "bg-sunken text-muted",
              )}
            >
              {trend.text}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}







/** Filter toolbar: search + labelled controls + active-count reset. */
/** The search box FilterBar renders when given a `search` prop. Removed
 * once as a "dead export" because nothing outside this file called it
 * directly -- missing that FilterBar calls it internally, which would have
 * thrown the same ReferenceError InfoTip did, on Events and Orders, the
 * moment either filter bar rendered with a search prop. */
export function SearchInput({ value, onChange, placeholder, onSubmit }) {
  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit?.();
      }}
      className="relative flex h-11 w-full min-w-0 basis-full items-center gap-2.5 rounded-full border border-line/20 bg-card px-4 transition focus-within:border-primary focus-within:ring-[3px] focus-within:ring-primary/15 sm:w-auto sm:flex-1 sm:basis-auto sm:max-w-sm"
    >
      <Search className="size-4 shrink-0 text-primary" aria-hidden />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 border-none bg-transparent text-sm outline-none"
      />
      {value ? (
        <button type="button" onClick={() => onChange("")} aria-label="clear" className="shrink-0 rounded text-muted transition hover:text-ink">
          <X className="size-4" />
        </button>
      ) : null}
    </form>
  );
}

export function FilterBar({ search, controls = [], activeCount = 0, onReset, resetLabel, actions }) {
  return (
    <div className="mb-4 rounded-card border border-line/10 bg-card p-4 shadow-card">
      <div className="flex flex-wrap items-end gap-2.5">
        {search ? <SearchInput {...search} /> : null}
        {/* Dropdown, not a native <select>: the browser's own popup ignores
            the app's theme completely -- it opened as a plain light list with
            OS highlight colours over this dark dashboard, which is the one
            place a filter bar is read at a glance. Callers still pass an
            event-shaped onChange, so the adapter below keeps every existing
            `(e) => setX(e.target.value)` working unchanged. */}
        {controls.map((control) => (
          /* Full width on a phone, the caller's width from sm up.
             control.style is a fixed pixel width (170-200px). Once the row
             wraps -- which it does on any phone, since two controls alone
             exceed ~296px -- each one sat at that width on a line of its
             own, leaving 90-140px of dead space beside it and a column of
             ragged pills. The fixed width is really a cap for the wide
             layout, so it only applies once there is a row to share. */
          <div key={control.key} className="flex min-w-0 basis-full flex-col gap-1.5 sm:basis-auto">
            {/* A <label> can no longer wrap this -- the trigger is a button,
                not a form control, so the implicit association is gone.
                aria-labelledby points at the visible text instead, which
                keeps the announced name and the name on screen the SAME
                string rather than two copies that can drift apart. */}
            <span
              id={`filter-${control.key}`}
              className="ps-0.5 text-[11px] font-bold uppercase tracking-wide text-muted"
            >
              {control.label}
            </span>
            <div className="w-full sm:w-[var(--filter-w)]" style={{ "--filter-w": `${control.style?.width ?? 180}px` }}>
              <Dropdown
                value={control.value}
                onChange={(value) => control.onChange({ target: { value } })}
                options={control.options}
                labelledBy={`filter-${control.key}`}
                placeholder={control.label}
                triggerClassName={triggerControlClass({ className: "h-11" })}
              />
            </div>
          </div>
        ))}
        {activeCount > 0 && onReset ? (
          <button
            type="button"
            onClick={onReset}
            className="h-11 rounded-control border border-dashed border-line/30 px-3.5 text-[13px] font-bold text-muted transition hover:border-solid hover:border-danger hover:text-danger"
          >
            {resetLabel} ({activeCount})
          </button>
        ) : null}
        {actions ? <div className="ms-auto flex items-end gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

export function DataTable({ minWidth = 760, children }) {
  return (
    <div className="overflow-x-auto rounded-card border border-line/10 bg-card shadow-card">
      <table className="w-full border-collapse" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}

export function Th({ children, className }) {
  return (
    <th
      scope="col"
      className={cn("border-b border-line/10 bg-paper px-3.5 py-3 text-center text-xs font-bold uppercase tracking-wide text-muted", className)}
    >
      {children}
    </th>
  );
}

export function Td({ children, className }) {
  return <td className={cn("border-b border-line/10 px-3 py-3 align-middle", className)}>{children}</td>;
}


/** Initial-avatar + truncating name, for person columns. */
export function PersonCell({ name, sub }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-brume text-[13px] font-extrabold text-primary" aria-hidden>
        {(name || "?").slice(0, 1).toUpperCase()}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13.5px] font-semibold" title={name}>
          {name}
        </span>
        {sub ? (
          <span className="block truncate text-xs text-muted" title={sub}>
            {sub}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** Thumb + title over muted subline, for event columns. */
export function EntityCell({ image, title, sub }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {image ? (
        <img src={image} alt="" className="size-9 shrink-0 rounded-control object-cover" />
      ) : (
        <span className="size-9 shrink-0 rounded-control bg-brume" aria-hidden />
      )}
      <span className="min-w-0">
        <span className="block truncate text-sm font-bold" title={title}>
          {title}
        </span>
        {sub ? (
          <span className="block truncate text-xs text-muted" title={sub}>
            {sub}
          </span>
        ) : null}
      </span>
    </div>
  );
}

export function MoneyCell({ children, unit }) {
  return (
    <span className="inline-flex flex-col items-start gap-0.5 leading-tight">
      <span className="text-[15px] font-extrabold tracking-tight tabular-nums">{children}</span>
      {unit ? <span className="rounded-full bg-brume px-1.5 text-[11px] font-bold text-primary">{unit}</span> : null}
    </span>
  );
}

export function CountChip({ icon, children }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-line/15 bg-paper px-2.5 py-0.5 text-xs font-bold text-muted">
      {icon}
      {children}
    </span>
  );
}

/** Count over a colour-coded fill bar, for remaining-stock columns. */
export function StockCell({ left, total }) {
  const ratio = total > 0 ? left / total : 0;
  const tone = ratio <= 0 ? "out" : ratio < 0.2 ? "low" : "ok";
  // "Stock is fine" is a STATUS, not a brand moment -- it used bg-primary/
  // text-primary, which meant every healthy row in every table glowed brand
  // pink, the one colour meant to stay reserved for the logo and actions.
  // Success-green is what a healthy number should read as.
  const colors = { ok: "bg-success", low: "bg-accent", out: "bg-danger/40" };
  const text = { ok: "text-success", low: "text-accent", out: "text-danger" };
  return (
    <span className="inline-flex min-w-[68px] flex-col gap-1">
      <span className="leading-none">
        <span className={cn("text-sm font-extrabold tabular-nums", text[tone])}>{left}</span>
        <span className="text-[11px] font-semibold text-muted">/{total}</span>
      </span>
      <span className="h-1.5 overflow-hidden rounded-full bg-line/10">
        <span className={cn("block h-full rounded-full transition-[width]", colors[tone])} style={{ width: `${Math.round(ratio * 100)}%` }} />
      </span>
    </span>
  );
}



export function StatSkeletons({ count = 3 }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-card border border-line/10 bg-card p-5 shadow-card">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="mt-2.5 h-7 w-28" />
        </div>
      ))}
    </>
  );
}

export function Pager({ page, pages, onPage, limit, onLimit, labels }) {
  if (pages <= 1 && !onLimit) return null;
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
      {onLimit ? (
        <div className="flex items-center gap-2 text-xs text-muted">
          <span id="pager-rows">{labels.rows}</span>
          <span className="inline-block w-20">
            <Dropdown
              value={String(limit)}
              onChange={(value) => onLimit(Number(value))}
              options={[10, 20, 50, 100].map((n) => ({ value: String(n), label: String(n) }))}
              labelledBy="pager-rows"
              triggerClassName={triggerControlClass({ className: "h-9 px-2 text-sm" })}
            />
          </span>
        </div>
      ) : (
        <span />
      )}
      {pages > 1 ? (
        <div className="ms-auto flex items-center gap-4">
          <Btn
            variant="secondary"
            size="sm"
            disabled={page <= 1}
            onClick={() => onPage(Math.max(1, page - 1))}
            icon={<ChevronLeft className="size-4 rtl:rotate-180" />}
          >
            {labels.prev}
          </Btn>
          <span className="min-w-[90px] text-center text-xs text-muted">
            {page} / {pages}
          </span>
          <Btn
            variant="secondary"
            size="sm"
            disabled={page >= pages}
            onClick={() => onPage(Math.min(pages, page + 1))}
            iconEnd={<ChevronRight className="size-4 rtl:rotate-180" />}
          >
            {labels.next}
          </Btn>
        </div>
      ) : null}
    </div>
  );
}

