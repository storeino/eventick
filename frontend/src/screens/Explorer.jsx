import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Calendar, Flame, MapPin, SearchX, SlidersHorizontal, Ticket } from "lucide-react";
import { Shell } from "../components/Shell";
import { EventCard } from "../components/EventCard";
import { useCatalog } from "../useCatalog";
import { Badge, Button, Card, CheckOption, Container, Dropdown, EmptyState, ErrorState, LoadingState, Modal, RadioOption, RangeField } from "../ui";
import { categoryLabel, useI18n } from "../i18n";
import { CATEGORIES, CITIES, addDays, dateKey, minPriceCents, overlaps, todayKey, weekendRange } from "../utils";

const PAGE_SIZE = 6;

export default function Explorer() {
  const { t, tf } = useI18n();
  const [params, setParams] = useSearchParams();
  const { events, loading, error, reload } = useCatalog();
  const [mobileFilters, setMobileFilters] = useState(false);
  const today = todayKey();

  const search = {
    q: params.get("q") ?? "",
    ville: params.get("ville") ?? "",
    cat: params.get("cat") ?? "",
    quand: params.get("quand") ?? "",
    tri: params.get("tri") ?? "popular",
    max: Number(params.get("max") ?? 2500) || 2500,
    page: Math.max(1, Number(params.get("page") ?? 1) || 1),
    vip: params.get("vip") === "1" ? "1" : "",
    instant: params.get("instant") === "1" ? "1" : "",
    seated: params.get("seated") === "1" ? "1" : "",
  };

  const setSearch = (partial) => {
    const next = { ...search, page: 1, ...partial };
    const sp = new URLSearchParams();
    if (next.q) sp.set("q", next.q);
    if (next.ville) sp.set("ville", next.ville);
    if (next.cat) sp.set("cat", next.cat);
    if (next.quand) sp.set("quand", next.quand);
    if (next.tri && next.tri !== "popular") sp.set("tri", next.tri);
    if (next.max && next.max !== 2500) sp.set("max", String(next.max));
    if (next.page && next.page !== 1) sp.set("page", String(next.page));
    if (next.vip) sp.set("vip", "1");
    if (next.instant) sp.set("instant", "1");
    if (next.seated) sp.set("seated", "1");
    setParams(sp);
  };

  const live = useMemo(() => events.filter((event) => dateKey(event.end) >= today), [events, today]);

  const filtered = useMemo(() => {
    const weekend = weekendRange(today);
    const q = search.q.trim().toLowerCase();
    let list = live.filter((event) => {
      if (search.ville && event.city !== search.ville) return false;
      if (search.cat && event.category !== search.cat) return false;
      if (q && !`${event.titleFr} ${event.titleAr} ${event.city} ${event.venueFr} ${event.blurbFr}`.toLowerCase().includes(q)) {
        return false;
      }
      if (minPriceCents(event) / 100 > search.max) return false;
      if (search.vip === "1" && !event.tiers.some((tier) => tier.perks?.includes("lounge") || tier.priceCents >= 70000)) return false;
      if (search.seated === "1" && !event.tiers.some((tier) => tier.numbered)) return false;
      if (search.instant === "1" && !event.instant) return false;
      const start = dateKey(event.start);
      const end = dateKey(event.end);
      if (search.quand === "today" && !overlaps(start, end, today, today)) return false;
      if (search.quand === "tomorrow") {
        const tomorrow = addDays(today, 1);
        if (!overlaps(start, end, tomorrow, tomorrow)) return false;
      }
      if (search.quand === "weekend" && !overlaps(start, end, weekend.start, weekend.end)) return false;
      if (search.quand === "month" && !start.startsWith(today.slice(0, 7)) && !end.startsWith(today.slice(0, 7))) {
        return false;
      }
      if (search.quand === "summer" && !overlaps(start, end, "2027-06-01", "2027-08-31")) return false;
      return true;
    });
    list = [...list].sort((a, b) => compare(a, b, search.tri));
    return list;
  }, [live, search, today]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(search.page, pages);
  const slice = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const weekEnd = addDays(today, 7);
  const thisWeek = live.filter((event) => overlaps(dateKey(event.start), dateKey(event.end), today, weekEnd)).length;
  const almost = live.filter((event) => event.tiers.some((tier) => tier.remaining < 200)).length;

  const filters = (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        {/* Hidden in the modal, which supplies its own title. */}
        <h2 className="font-display text-subhead font-bold max-lg:sr-only">{t("filters")}</h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSearch({ ville: "", cat: "", quand: "", max: 2500, vip: "", instant: "", seated: "", q: "" })}
        >
          {t("reset")}
        </Button>
      </div>
      <fieldset>
        <legend className="text-sm font-semibold">{t("cityIn")}</legend>
        <div className="mt-2 space-y-0.5">
          <RadioOption
            name="ville"
            checked={!search.ville}
            label={t("allCitiesF")}
            count={live.length}
            onChange={() => setSearch({ ville: "" })}
          />
          {CITIES.map((city) => (
            <RadioOption
              key={city}
              name="ville"
              checked={search.ville === city}
              label={city}
              count={live.filter((event) => event.city === city).length}
              onChange={() => setSearch({ ville: city })}
            />
          ))}
        </div>
      </fieldset>
      <div>
        <p className="text-sm font-semibold">{t("when")}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {[
            ["today", t("today")],
            ["tomorrow", t("tomorrow")],
            ["weekend", t("thisWeekend")],
            ["month", t("thisMonth")],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`h-11 rounded-full px-3.5 text-sm font-semibold transition ${
                search.quand === id ? "bg-action text-action-fg" : "bg-paper text-ink hover:bg-brume"
              }`}
              onClick={() => setSearch({ quand: search.quand === id ? "" : id })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <RangeField
        label={t("maxPrice")}
        value={search.max}
        valueLabel={search.max >= 2500 ? "2 500+" : String(search.max)}
        min={0}
        max={2500}
        step={50}
        minLabel={t("free")}
        maxLabel="2 500+"
        onChange={(max) => setSearch({ max })}
      />
      <div className="space-y-0.5 text-sm">
        <CheckOption label={t("eticket")} checked={search.instant === "1"} onChange={(on) => setSearch({ instant: on ? "1" : "" })} />
        <CheckOption label={t("seated")} checked={search.seated === "1"} onChange={(on) => setSearch({ seated: on ? "1" : "" })} />
        <CheckOption label={t("vipAccess")} checked={search.vip === "1"} onChange={(on) => setSearch({ vip: on ? "1" : "" })} />
      </div>
      <div className="rounded-card bg-brume p-3.5 text-sm text-primary">
        <p className="font-bold">{t("guarantee")}</p>
        <p className="mt-0.5 leading-relaxed opacity-90">{t("guaranteeBody")}</p>
      </div>
    </div>
  );

  // Loading, failure and "no matches" are three different things. The old
  // screen rendered the same dashed "no results" box for all of them, so a
  // dead backend read as an over-filtered search.
  if (loading) {
    return (
      <Shell>
        <Container className="py-10">
          <LoadingState label={t("loadingEvents")} rows={4} />
        </Container>
      </Shell>
    );
  }

  if (error) {
    return (
      <Shell>
        <Container className="py-10">
          <ErrorState title={t("catalogErrorTitle")} body={t("catalogErrorBody")} onRetry={reload} retryLabel={t("retry")} />
        </Container>
      </Shell>
    );
  }

  return (
    <Shell>
      {/* A compact dark band instead of the page just starting on bare
          paper -- not the full-viewport poster treatment Home's hero gets,
          but enough to give this page its own identity instead of reading
          as a plain content list from the very first pixel. "Cette semaine"
          used to be a dangling, disconnected text line below the stat card;
          it is now the fourth stat in the same row instead of an orphaned
          fragment. */}
      <section className="relative overflow-hidden bg-stage text-stage-fg">
        <div className="absolute inset-0 bg-linear-to-br from-primary/20 via-transparent to-secondary/20" aria-hidden />
        <div className="relative mx-auto max-w-7xl px-4 py-10 md:px-8 md:py-14">
          <p className="inline-flex items-center gap-2 rounded-full bg-stage-fg/10 px-3 py-1 text-xs font-bold">
            <span className="size-2 rounded-full bg-danger" />
            {t("liveKicker")}
          </p>
          <h1 className="mt-3 font-display text-4xl font-extrabold leading-tight md:text-hero">
            {t("exploreA")} <span className="text-accent">{t("exploreB")}</span>
          </h1>
          <p className="mt-2 max-w-xl text-stage-muted">{t("exploreSub")}</p>

          {/* Icon per stat + real dividers (divide-x), not just grid gaps --
              same pattern as Home's hero stats. The old row was four bare
              numbers with a lot of empty horizontal space between them and
              nothing to anchor the eye. */}
          <dl className="mt-6 grid grid-cols-2 divide-y divide-stage-fg/10 rounded-panel border border-stage-fg/10 bg-stage-fg/5 sm:grid-cols-4 sm:divide-x sm:divide-y-0 rtl:sm:divide-x-reverse">
            <Stat icon={<Calendar className="size-4" />} value={String(live.length)} label={t("eventsWord")} />
            <Stat icon={<MapPin className="size-4" />} value={String(new Set(live.map((event) => event.city)).size)} label={t("activeCities")} />
            <Stat icon={<Ticket className="size-4" />} value={String(thisWeek)} label={t("thisWeek")} />
            <Stat icon={<Flame className="size-4" />} value={String(almost)} label={t("almost")} accent />
          </dl>
        </div>
      </section>

      <div className="mx-auto max-w-7xl px-4 py-8 md:px-8">
        <div className="scroll-none flex gap-2 overflow-x-auto pb-1">
          <Chip active={!search.cat} onClick={() => setSearch({ cat: "" })}>
            {t("allGenres")}
          </Chip>
          {CATEGORIES.map((id) => (
            <Chip key={id} active={search.cat === id} onClick={() => setSearch({ cat: search.cat === id ? "" : id })}>
              {categoryLabel(id, t)}
            </Chip>
          ))}
        </div>
        <div className="mt-6 grid gap-6 lg:grid-cols-[16rem_1fr]">
          {/* h-fit + sticky, not a stretched full-height box -- the sidebar
              used to end wherever its own content stopped while the grid
              row (set by the results column) kept going, leaving a tall
              gap of bare page background below it. Sticky means the filter
              panel now follows the scroll instead of just sitting in dead
              space once the results column runs past it. */}
          <aside className="hidden h-fit rounded-card border border-line/10 bg-card p-4 shadow-card lg:sticky lg:top-20 lg:block">
            {filters}
          </aside>
          <div>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted">{tf("showing", { n: slice.length, total: filtered.length })}</p>
              <div className="flex items-center gap-2">
                <Button variant="secondary" className="lg:hidden" icon={<SlidersHorizontal className="size-4" />} onClick={() => setMobileFilters(true)}>
                  {t("openFilters")}
                </Button>
                <div className="flex items-center gap-2 text-sm">
                  <span className="shrink-0 text-muted">{t("sort")}</span>
                  {/* Custom Dropdown (ui/Dropdown.jsx), not a native <select>
                      -- a native popup ignores the app's theme entirely and
                      breaks into the browser's own unstyled list the moment
                      it opens, same bug already fixed on Home's search
                      card. */}
                  <Dropdown
                    value={search.tri}
                    onChange={(tri) => setSearch({ tri, page: search.page })}
                    width="w-56"
                    mobileSheet
                    label={t("sort")}
                    triggerClassName="h-11 rounded-control border border-line/15 bg-card px-3.5 text-sm font-semibold"
                    options={[
                      { value: "popular", label: t("popular") },
                      { value: "date", label: t("dateSoon") },
                      { value: "priceAsc", label: t("priceAsc") },
                      { value: "priceDesc", label: t("priceDesc") },
                    ]}
                  />
                </div>
              </div>
            </div>
            {slice.length === 0 ? (
              <Card>
                <EmptyState
                  icon={<SearchX className="size-6" />}
                  title={t("noResults")}
                  body={t("noResultsBody")}
                  action={
                    <Button
                      variant="secondary"
                      onClick={() =>
                        setSearch({ ville: "", cat: "", quand: "", max: 2500, vip: "", instant: "", seated: "", q: "" })
                      }
                    >
                      {t("reset")}
                    </Button>
                  }
                />
              </Card>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {slice.map((event) => (
                  <EventCard key={event.slug} event={event} />
                ))}
              </div>
            )}
            <div className="mt-6 flex items-center justify-center gap-2">
              <button
                type="button"
                className="size-11 rounded-full border border-line/15 disabled:opacity-40"
                disabled={page <= 1}
                onClick={() => setSearch({ page: page - 1 })}
              >
                ‹
              </button>
              <span className="text-sm">{tf("pageOf", { p: page, t: pages })}</span>
              <button
                type="button"
                className="size-11 rounded-full bg-action text-action-fg disabled:opacity-40"
                disabled={page >= pages}
                onClick={() => setSearch({ page: page + 1 })}
              >
                ›
              </button>
            </div>
          </div>
        </div>
      </div>
      {/* Was a bare div with no role, no Escape and no focus handling, so a
          keyboard user tabbed straight through it into the page behind. */}
      <Modal
        open={mobileFilters}
        onClose={() => setMobileFilters(false)}
        title={t("filters")}
        footer={
          <Button full onClick={() => setMobileFilters(false)}>
            {t("apply")}
          </Button>
        }
      >
        {filters}
      </Modal>
    </Shell>
  );
}

function compare(a, b, tri) {
  if (tri === "date") return a.start.localeCompare(b.start);
  if (tri === "priceAsc") return minPriceCents(a) - minPriceCents(b);
  if (tri === "priceDesc") return minPriceCents(b) - minPriceCents(a);
  return b.popularity - a.popularity;
}

function Stat({ icon, value, label, accent = false }) {
  // Rendered inside the always-dark header band (bg-stage), same pattern as
  // Home's HeroStat -- stage-fg text, not encre/ink, which would flip
  // light-on-light depending on app theme since the band itself never
  // flips. "Almost sold out" gets the lime accent as its one highlight
  // moment, not danger red -- danger's light-mode value (tuned for a
  // theme-reactive background) fails contrast against the fixed-dark
  // stage, same bug class caught elsewhere this session; accent has the
  // identical hex in both themes, which is exactly what a fixed-dark
  // surface needs.
  return (
    <div className="flex items-center gap-3 p-4 sm:p-5">
      <span className={`flex size-9 shrink-0 items-center justify-center rounded-control bg-stage-fg/10 ${accent ? "text-accent" : "text-stage-muted"}`}>
        {icon}
      </span>
      <div className="min-w-0">
        <dt className={`font-display text-2xl font-extrabold tabular-nums md:text-3xl ${accent ? "text-accent" : ""}`}>{value}</dt>
        <dd className="mt-0.5 truncate text-xs font-semibold text-stage-muted">{label}</dd>
      </div>
    </div>
  );
}

function Chip({ active, children, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-11 shrink-0 rounded-full px-4 text-sm font-semibold ${active ? "bg-action text-action-fg" : "border border-line/15 bg-card text-ink"}`}
    >
      {children}
    </button>
  );
}

