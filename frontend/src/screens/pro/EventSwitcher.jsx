import { useMemo, useState } from "react";
import { Calendar, Check, ChevronDown, Search } from "lucide-react";
import { Input, Popover, PopoverItem } from "../../ui";
import { cn, eventText, intlLocaleTag } from "../../utils";

/**
 * The "which event am I looking at" control for Placements, and any other
 * screen that scopes its content to one event at a time.
 *
 * Was a bare native <select> — functional, but with no thumbnail, no way to
 * search past a handful of events, and no visual weight at all next to the
 * page's other controls. This is a proper panel: the trigger shows the
 * current event's poster, the panel is searchable and shows every event's
 * poster and date, matching the card language used elsewhere in the
 * dashboard rather than reading as a leftover form control.
 */
export function EventSwitcher({ events, value, onChange, locale, labels }) {
  const [query, setQuery] = useState("");

  const current = events.find((event) => event.slug === value);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return events;
    return events.filter((event) =>
      `${event.titleFr} ${event.titleAr} ${event.city}`.toLowerCase().includes(needle),
    );
  }, [events, query]);

  const title = (event) => (eventText(event, "title", locale));

  return (
    <Popover
      label={labels.pick}
      align="end"
      width="w-80"
      trigger={({ open }) => (
        /* min-w only from sm. Below it this was a 224px floor the
           trigger could not shrink past, so on a phone it kept that width
           on its own wrapped line instead of filling it. */
        <span className="flex h-11 w-full items-center gap-2.5 rounded-control border border-line/15 bg-card ps-2 pe-3 text-start transition hover:border-primary/40 sm:min-w-[14rem]">
          {current?.image ? (
            <img src={current.image} alt="" className="size-7 shrink-0 rounded-[6px] object-cover" />
          ) : (
            <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-[6px] bg-sunken text-muted" aria-hidden>
              <Calendar className="size-3.5" />
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">{current ? title(current) : labels.pick}</span>
          </span>
          <ChevronDown className={cn("size-4 shrink-0 text-muted transition", open && "rotate-180")} aria-hidden />
        </span>
      )}
    >
      {({ close }) => (
        <>
          <div className="border-b border-line/10 p-2.5">
            <div className="relative">
              <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
              <Input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={labels.search}
                aria-label={labels.search}
                className="h-10 bg-paper ps-9 pe-3 text-sm"
              />
            </div>
          </div>

          <div className="scroll-thin max-h-80 overflow-y-auto py-1.5">
            {filtered.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted">{labels.noMatch}</p>
            ) : (
              filtered.map((event) => (
                <PopoverItem
                  key={event.slug}
                  onClick={() => {
                    onChange(event.slug);
                    close();
                  }}
                  className="gap-3"
                >
                  <img src={event.image} alt="" className="size-10 shrink-0 rounded-control object-cover" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{title(event)}</span>
                    <span className="block truncate text-xs text-muted">
                      {event.city} · {new Date(event.start).toLocaleDateString(intlLocaleTag(locale), { day: "numeric", month: "short" })}
                    </span>
                  </span>
                  {event.slug === value ? <Check className="size-4 shrink-0 text-primary" aria-hidden /> : null}
                </PopoverItem>
              ))
            )}
          </div>
        </>
      )}
    </Popover>
  );
}
