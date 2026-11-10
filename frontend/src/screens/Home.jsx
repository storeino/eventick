import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Activity,
  Calendar,
  CreditCard,
  Flame,
  Headphones,
  MapPin,
  Music,
  QrCode,
  Repeat,
  RefreshCcw,
  Theater,
  Ticket,
  Trophy,
  Utensils,
  MoonStar,
} from "lucide-react";
import { QrMark } from "../components/QrMark";
import { Shell } from "../components/Shell";
import { EventCard } from "../components/EventCard";
import { useCatalog } from "../useCatalog";
import { useAuth } from "../AuthContext";
import { Button, Container, Dropdown, ErrorState, LoadingState } from "../ui";
import { categoryLabel, useI18n } from "../i18n";
import { addDays, CITIES, cn, dateKey, intlLocaleTag, monthBadge, todayKey } from "../utils";

// nightlife used to fill bg-stage (near-black) with text-stage-fg -- fine on
// the old light-page version of this rail, but once the section sits on the
// app's own dark paper background that tile nearly vanished into it. Danger
// (a warm red) reads clearly against both the light and dark page background,
// same as every other tile here.
const CATS = [
  { id: "festivals", icon: Music, tone: "bg-primary text-primary-fg" },
  { id: "humour", icon: Theater, tone: "bg-secondary text-secondary-fg" },
  { id: "sport", icon: Trophy, tone: "bg-accent text-accent-fg" },
  { id: "nightlife", icon: MoonStar, tone: "bg-danger text-danger-fg" },
  { id: "culture", icon: Utensils, tone: "bg-info text-info-fg" },
];

const TRENDS = [
  { label: "#Mawazine2027", query: "Mawazine" },
  { label: "#Gnaoua", query: "Gnaoua" },
  { label: "#DerbyCasa", query: "Derby" },
  { label: "#OasisFest", query: "Oasis" },
];

export default function Home() {
  const { locale, t } = useI18n();
  const navigate = useNavigate();
  const { events, loading, error, reload } = useCatalog();
  const { canUsePro } = useAuth();
  const [cat, setCat] = useState("");
  const [quand, setQuand] = useState("");
  const [ville, setVille] = useState("");

  const today = todayKey();
  const live = useMemo(() => events.filter((event) => dateKey(event.end) >= today), [events, today]);
  const cityCount = useMemo(() => new Set(live.map((event) => event.city)).size, [live]);
  const feature = live.find((event) => event.slug === "mawazine-2027") ?? live[0];
  // Used to be two hardcoded slugs, so the side column silently dropped to
  // one card (or zero) whenever one of those two specific events wasn't in
  // `live` -- the exact gap reported against a real screenshot. Derived from
  // the catalog instead: the next 3 upcoming events after the feature, by
  // start date, so the column is never short a card just because a named
  // slug happened not to match today.
  const side = [...live]
    .filter((event) => event.slug !== feature?.slug)
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, 3);
  const imminent = [...live]
    .filter((event) => dateKey(event.start) <= addDays(today, 21))
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, 3);

  const submitSearch = (event) => {
    event.preventDefault();
    const params = new URLSearchParams();
    if (cat) params.set("cat", cat);
    if (quand) params.set("quand", quand);
    if (ville) params.set("ville", ville);
    navigate(`/explorer?${params.toString()}`);
  };

  // The grids below are driven by the catalog. Without these the page
  // rendered its whole marketing frame around empty rails while loading, and
  // did the same on failure with nothing to retry.
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

  const seatsAvailable = live.reduce((sum, event) => sum + event.tiers.reduce((n, tier) => n + tier.remaining, 0), 0);

  // The e-ticket preview is a mock-up, but its date still has to speak
  // the reader's language: it was a hardcoded "28 JUIL" that stayed
  // French in English and Arabic. A fixed instant, formatted properly.
  const previewStamp = monthBadge("2027-07-28T21:00:00Z", locale);

  return (
    <Shell overlay>
      {/* Deliberately always dark, like the reference's hero band — see the
          note on --et-stage in styles.css. Full-viewport height instead of a
          content-hugging band: this is the one moment on the page meant to
          feel like a poster, not a card, so the headline gets room the rest
          of the page deliberately doesn't give anything else. */}
      {/* No overflow-hidden here on purpose -- the background image below is
          already pixel-matched to the section via inset-0 + h-full w-full,
          so clipping was never load-bearing, and it was clipping the search
          card's custom Dropdown panels (position: absolute) at the section
          edge, cutting their tops off instead of letting them float over
          the hero like any other popover in the app. */}
      {/* Height. Measured in a real browser at six viewport sizes, because
          reading the class name is what hid this for two rounds.

          `min-h` is a FLOOR: once the kicker, headline, subtitle, search
          card and trends row exceeded it, the section grew past it and the
          number meant nothing — it measured 830px in an 804px viewport. So
          the padding, the type scale and the headline's wrap width came
          down too, and the events moved ABOVE the category rail, which by
          itself sat 452px between the hero and the first date.

          Now the first event is at 860px, inside a 900px viewport. A 13"
          laptop (800px) and phones still need a short scroll — on a phone
          the search card stacks to four rows and the hero genuinely needs
          the height — but the hero no longer fills the screen on its own at
          any size, which was the actual complaint. max-h stops it from
          regressing to that on a short window. */}
      {/* Offset by the header's MEASURED height, not a hardcoded 4rem.
          EventTicker renders inside the sticky header and is conditional,
          so the header is 64px or 100px depending on the data — with a
          fixed -mt-16/pt-16 the hero's kicker and headline rode up under
          the bar whenever the ticker was showing. See --site-header-h. */}
      {/*
        No max-height.

        It used to carry max-h-[92vh], to keep the first event card near the
        fold. But a max-height on a flex column does not shrink the content
        inside it -- it just stops the box growing, and everything past the
        ceiling spills out. On a short or narrow viewport the headline wraps
        to three lines and the trend pills to two rows, which is ~95px more
        than 92vh of a 640px-tall window: the stats row and the heading of
        the section below were drawn on top of each other.

        min-height still does the job the cap was really for. It holds the
        hero open on a tall desktop screen so it reads as a full stage, and
        on a small screen the section is now free to be as tall as its own
        contents, which is the only height at which nothing overlaps.
      */}
      <section
        className="relative flex min-h-[min(62vh,38rem)] flex-col bg-stage text-stage-fg"
        style={{ marginTop: "calc(var(--site-header-h) * -1)", paddingTop: "var(--site-header-h)" }}
      >
        {/*
          The photo was opacity-45 beneath a gradient that ran to a solid
          `from-stage` at the bottom, so it was dimmed twice and the venue
          was barely readable.

          Now it carries its own brightness/saturate instead of being faded
          into the background colour, and the scrim is directional: strong
          down the leading edge where the headline and search card sit,
          clearing toward the opposite top corner so the crowd and the stage
          actually read. Two layers rather than one, because the text needs a
          guaranteed contrast floor that a single diagonal cannot give.
        */}
        <img
          src="/events/mawazine.jpg"
          alt=""
          className="absolute inset-0 h-full w-full object-cover object-center saturate-[1.15]"
        />
        {/* Was opacity-75 AND brightness-[0.78] on top of two scrims -- four
            dimming layers over one photo, which is why the crowd and the
            Koutoubia came out as a grey wash. The photo now renders at full
            brightness and only the scrims remain, because only the scrims
            are doing work the text depends on. */}
        <div className="absolute inset-0 bg-linear-to-t from-stage via-stage/30 via-55% to-transparent" />
        {/* Mirrored explicitly for Arabic. Tailwind has no logical gradient
            direction — it only emits `to right`/`to left` and friends, so
            `bg-linear-to-e` compiles to nothing at all — and `rtl:` wins
            here because it adds a selector rather than a second utility on
            the same specificity. */}
        <div className="absolute inset-0 bg-linear-to-r from-stage/80 via-stage/25 via-45% to-transparent rtl:bg-linear-to-l" />
        <div className="relative mx-auto flex w-full max-w-7xl flex-1 flex-col justify-center px-4 py-8 md:px-8 md:py-10">
          <div className="max-w-5xl">
            <p className="inline-flex items-center gap-2 rounded-full bg-stage-fg/10 px-3 py-1 text-xs font-semibold">
              <span className="size-2 rounded-full bg-accent" />
              {t("kicker")}
            </p>
            <p className="mt-3 text-sm font-semibold text-accent">{t("secureMad")}</p>
            {/* text-hero is the biggest headline size used anywhere on the
                site (EventDetail, Explorer use it too), so this still reads
                as the page's visual climax without pushing the subtitle and
                search card below the fold the way a larger size did. */}
            <h1 className="mt-3 font-display text-4xl font-extrabold leading-none tracking-tight sm:text-5xl lg:text-6xl">
              {t("heroA")} <span className="text-accent">{t("heroB")}</span> {t("heroC")}
            </h1>
            <p className="mt-4 max-w-xl text-base text-stage-muted lg:text-lg">{t("heroSub")}</p>
          </div>

          <form className="mt-7 w-full" onSubmit={submitSearch}>
            {/* The search card used to be a plain white rectangle of three
                bare <select> elements -- functional, but it looked like any
                admin form, not the one thing on the page meant to invite a
                click. A glow ring, icon-prefixed fields with real dividers
                between them, and a floating pill-shaped submit give it the
                weight the rest of the hero already earned. */}
            <div className="relative rounded-panel bg-linear-to-br from-primary via-secondary to-accent p-[1.5px] shadow-pop">
              <div className="flex flex-col divide-y divide-line/10 rounded-[calc(var(--radius-panel)-1.5px)] bg-card text-ink md:flex-row md:divide-x md:divide-y-0">
                <SearchField icon={<Music className="size-4" />} label={t("fieldType")}>
                  <Dropdown
                    value={cat}
                    onChange={setCat}
                    placeholder={t("allUniverses")}
                    width="w-64"
                    triggerClassName="text-sm font-bold"
                    options={[
                      { value: "", label: t("allUniverses") },
                      ...CATS.map((item) => ({ value: item.id, label: categoryLabel(item.id, t) })),
                    ]}
                  />
                </SearchField>
                <SearchField icon={<Calendar className="size-4" />} label={t("fieldPeriod")}>
                  <Dropdown
                    value={quand}
                    onChange={setQuand}
                    placeholder={t("anyTime")}
                    width="w-56"
                    triggerClassName="text-sm font-bold"
                    options={[
                      { value: "", label: t("anyTime") },
                      { value: "weekend", label: t("thisWeekend") },
                      { value: "month", label: t("thisMonth") },
                      { value: "summer", label: t("summer") },
                    ]}
                  />
                </SearchField>
                <SearchField icon={<MapPin className="size-4" />} label={t("fieldCity")}>
                  <Dropdown
                    value={ville}
                    onChange={setVille}
                    placeholder={t("allMorocco")}
                    width="w-56"
                    triggerClassName="text-sm font-bold"
                    options={[{ value: "", label: t("allMorocco") }, ...CITIES.map((city) => ({ value: city, label: city }))]}
                  />
                </SearchField>
                <div className="flex items-center p-2.5 md:ps-0">
                  <Button size="lg" type="submit" className="w-full md:w-auto">
                    {t("find")}
                  </Button>
                </div>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-2 text-sm">
              <span className="inline-flex items-center gap-1.5 font-semibold text-stage-muted">
                <Flame className="size-3.5 text-accent" aria-hidden />
                {t("trends")} :
              </span>
              {TRENDS.map((trend) => (
                <button
                  key={trend.label}
                  type="button"
                  onClick={() => navigate(`/explorer?q=${encodeURIComponent(trend.query)}`)}
                  className="rounded-full border border-stage-fg/20 bg-stage-fg/10 px-3 py-1.5 text-xs font-bold text-stage-fg transition hover:border-accent hover:bg-accent hover:text-accent-fg"
                >
                  {trend.label}
                </button>
              ))}
            </div>
          </form>
        </div>

        {/* Stats, folded into the hero's own footer instead of a separate
            flat band right after it — one less "card after card" beat,
            and the numbers read as proof sitting under the headline rather
            than a standalone section with nothing else going on. Each stat
            now carries its own icon and a real divider between items
            (border, not just a grid gap) instead of three bare numbers
            floating in a lot of empty space. */}
        {/* pb-16, not the py-7 this used to carry on both sides. The section
            below the hero has its own background, so its top edge lands
            directly under this row -- at an even 28px the numbers sat right
            on that seam and the two surfaces read as one band split by a
            colour change rather than as two sections. 64px here, and the
            same again below the seam, is what separates them. */}
        <dl className="relative mx-auto grid w-full max-w-7xl grid-cols-3 divide-x divide-stage-fg/10 border-t border-stage-fg/10 px-4 py-7 md:px-8 rtl:divide-x-reverse">
          <HeroStat icon={<Calendar className="size-5" />} value={live.length} label={t("eventsWord")} />
          <HeroStat icon={<MapPin className="size-5" />} value={cityCount} label={t("activeCities")} />
          <HeroStat
            icon={<Ticket className="size-5" />}
            value={seatsAvailable.toLocaleString(intlLocaleTag(locale))}
            label={t("seatsAvailable")}
          />
        </dl>
      </section>

      {/*
        Breathing room between the hero and whatever section follows it.

        It lives OUT HERE, as its own element, rather than as padding on
        the stats row above. That began as a workaround for the hero's
        max-h-[92vh] -- padding added inside the cap was absorbed by it, so
        pb-7 -> pb-10 -> pb-16 on the dl all rendered identically. The cap
        is gone now (see the note on the section), but the spacer stays its
        own element: it is a gap between two sections, so it belongs
        between them rather than hidden inside one of their paddings.

        bg-stage so it continues the hero's own surface rather than showing
        the page background through the gap, which would just move the seam
        up by 48px instead of removing it.
      */}
      <div aria-hidden className="h-12 bg-stage" />

      {/* Events first, then the category rail.

          Shrinking the hero was not enough on its own: with the hero at
          819px of a 900px viewport, the first event still sat at y=1288
          because this rail (452px) came between them. A visitor had to
          scroll past two screens to see a single date. The rail is a
          navigation aid; the events are the product, so they go first. */}
      {feature ? (
        // Brume tint instead of the plain paper background every other
        // section sits on — one deliberate break in the rhythm at the
        // page's real centrepiece, instead of white-card, white-card,
        // white-card all the way down.
        // A smaller h2 here, because this section's own header was costing
        // ~150px before the first card, which is what kept the events just
        // under the fold (966px against a 900px viewport) even after the
        // hero shrank and moved above the rail.
        // pt-10 rather than the original pt-7. The real separation from the
        // hero is the spacer above, not this value -- see the note on it --
        // but a tinted band still wants a little more above its kicker than
        // the ~28px that was tuned when it sat on plain paper.
        <section className="bg-brume/40 pb-14 pt-10">
          <div className="mx-auto max-w-7xl px-4 md:px-8">
            <p className="font-mono text-xs font-bold tracking-widest text-primary">{t("majorKicker")}</p>
            <h2 className="mt-1 font-display text-3xl font-extrabold text-encre md:text-4xl">{t("majorTitle")}</h2>
            {/* items-start, not the CSS grid default of stretch -- keeps the
                side column at its own natural height if the catalog ever
                has fewer than 3 upcoming events to fill it, rather than a
                short column being stretched into a card-sized empty void. */}
            <div className="mt-5 grid items-start gap-4 lg:grid-cols-[1.4fr_0.8fr]">
              <EventCard event={feature} variant="feature" />
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
                {side.map((event) => (
                  <EventCard key={event.slug} event={event} variant="compact" />
                ))}
              </div>
            </div>
          </div>
        </section>
      ) : null}

      <section className="mx-auto max-w-7xl px-4 py-12 md:px-8">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="font-display text-3xl font-extrabold">{t("byCat")}</h2>
            <p className="text-muted">{t("byCatSub")}</p>
          </div>
          <Button variant="ghost" className="shrink-0" onClick={() => navigate("/explorer")}>
            {t("seeAll")}
          </Button>
        </div>
        {/* Solid colour tiles instead of identical white cards with a small
            icon chip -- each category gets its own block of colour, so the
            rail reads as five distinct destinations rather than five copies
            of the same card with different text. The icon now sits in its
            own translucent chip rather than floating loose on the fill, and
            a soft diagonal highlight gives the flat colour some depth
            instead of reading as a plain swatch. */}
        <div className="mt-6 grid snap-x snap-mandatory auto-cols-[72%] grid-flow-col gap-3 overflow-x-auto pb-2 sm:auto-cols-[45%] lg:auto-cols-auto lg:grid-flow-row lg:grid-cols-5 lg:overflow-visible lg:pb-0">
          {CATS.map((item) => {
            const count = live.filter((event) => event.category === item.id).length;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => navigate(`/explorer?cat=${item.id}`)}
                className={`${item.tone} group relative overflow-hidden rounded-card p-4 text-start shadow-card transition snap-start hover:-translate-y-0.5 hover:shadow-pop`}
              >
                <span className="pointer-events-none absolute inset-0 bg-linear-to-br from-white/15 via-transparent to-black/10" aria-hidden />
                <span className="relative flex size-11 items-center justify-center rounded-control bg-white/20 backdrop-blur-sm">
                  <Icon className="size-5" />
                </span>
                <p className="relative mt-4 font-display text-lg font-bold">{categoryLabel(item.id, t)}</p>
                <p className="relative mt-0.5 text-sm opacity-80">{t("eventsCount").replace("{n}", String(count))}</p>
              </button>
            );
          })}
        </div>
      </section>

      {/* A near-black band for the urgency section -- "happening soon"
          reads as a ticker/alert moment, not another paper-background list,
          and it is the one place besides the hero and the promo band that
          goes dark, so the page now alternates light/tint/dark/light/dark
          instead of staying on paper from the fold down. */}
      <section className="bg-stage py-14 text-stage-fg">
        <div className="mx-auto max-w-7xl px-4 md:px-8">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="font-mono text-xs font-bold tracking-widest text-accent">{t("weekendTitle")}</p>
              <h2 className="font-display text-3xl font-extrabold">{t("weekendSub")}</h2>
            </div>
            <Button variant="inverse" onClick={() => navigate("/explorer?quand=month")}>
              {t("allCities")}
            </Button>
          </div>
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            {imminent.map((event) => (
              <EventCard key={event.slug} event={event} variant="weekend" />
            ))}
          </div>
          <div className="mt-6 text-center">
            <Button variant="inverse" size="lg" onClick={() => navigate("/explorer")}>
              {t("exploreMore")}
            </Button>
          </div>
        </div>
      </section>

      <section className="border-b border-line/10 bg-brume/30 py-14">
        <div className="mx-auto max-w-7xl px-4 md:px-8">
          <p className="text-center font-mono text-xs font-bold tracking-widest text-primary">{t("calmKicker")}</p>
          <h2 className="mt-2 text-center font-display text-3xl font-extrabold">{t("calmTitle")}</h2>
          {/* Three real cards instead of a loosely bordered row -- the old
              icon chip was bg-card on a bg-brume/30 section, two near-
              identical darks in dark mode, so it nearly vanished (same bug
              as the category rail's nightlife tile). Each perk now gets its
              own coloured icon chip and a card surface instead of floating
              in a lot of empty space between thin dividers. */}
          <div className="mx-auto mt-8 grid max-w-5xl gap-4 sm:grid-cols-3">
            <Trust tone="bg-primary text-primary-fg" icon={<QrCode className="size-5" />} title={t("perkQr")} body={t("perkQrBody")} />
            <Trust tone="bg-secondary text-secondary-fg" icon={<RefreshCcw className="size-5" />} title={t("perkRefund")} body={t("perkRefundBody")} />
            <Trust tone="bg-accent text-accent-fg" icon={<Headphones className="size-5" />} title={t("perkLocal")} body={t("perkLocalBody")} />
          </div>
        </div>
      </section>

      {/* This wrapper carried pb-4 and no top padding at all, so the dark
          Pro panel began immediately under the tinted section above it --
          two filled surfaces touching, with the colour change landing
          part-way through the previous section's last card.

          pt-24 to match what sits BELOW the panel, which is not pb-4 alone:
          this is the last section on the page, so the gap under it is
          pb-4 (16px) plus the footer's own mt-20 (80px) = 96px. pt-24 is
          that same 96px, so the panel now has equal air above and below
          instead of 48 against 96.

          On the wrapper rather than the panel inside it, since the panel is
          the thing being separated. Nothing caps the height here, unlike
          the hero, so padding does what it says. */}
      <section className="mx-auto max-w-7xl px-4 pb-4 pt-24 md:px-8">
        {/* Deliberately always dark, to set off the light ticket-preview
            card beside it regardless of app theme. A radial glow instead of
            a flat fill gives the band some depth to match the hero and the
            search card, rather than being the one remaining flat-colour
            rectangle on the page. */}
        {/* items-stretch (the grid default), not items-center -- the right
            column needs its grid cell to actually be the full row height so
            its own flex wrapper can centre the ticket card inside that real
            height, rather than the cell shrink-wrapping to the card's own
            (shorter) content size. */}
        {/* pt noticeably bigger than pb (not matching numbers) -- Space
            Grotesk's own glyph metrics sit text closer to the top of its
            line box than the bottom, so equal CSS padding still rendered
            visibly tighter above the kicker than below the buttons. This
            compensates by eye against a real screenshot, not just by
            matching numbers that look equal in the markup. */}
        <div className="relative grid items-stretch gap-8 overflow-hidden rounded-panel bg-stage px-5 pb-10 pt-14 text-stage-fg md:px-8 md:pb-12 md:pt-16 lg:grid-cols-2 lg:pb-14 lg:pt-18">
          <div
            className="pointer-events-none absolute -inset-e-24 -top-24 size-96 rounded-full bg-accent/15 blur-3xl"
            aria-hidden
          />
          <div
            className="pointer-events-none absolute -bottom-32 -inset-s-16 size-96 rounded-full bg-primary/15 blur-3xl"
            aria-hidden
          />

          <div className="relative">
            <p className="text-sm font-semibold text-accent">{t("orgKicker")}</p>
            <h2 className="mt-2 font-display text-3xl font-extrabold md:text-display">{t("orgTitle")}</h2>
            <p className="mt-3 max-w-xl text-stage-muted">{t("orgBody")}</p>
            <div className="mt-6 grid grid-cols-3 gap-3">
              {/* Three invented numbers (+250K / 99.8% / 48H) stood here with
                  nothing behind them. These are real capabilities instead of
                  metrics no one measured -- each now with its own icon so
                  they read as three distinct features, not three identical
                  text-only boxes. */}
              <Stat icon={<Activity className="size-4" />} value="100%" label={t("statLive")} />
              <Stat icon={<CreditCard className="size-4" />} value="CMI" label={t("statPay")} />
              <Stat icon={<Repeat className="size-4" />} value="✓" label={t("statResale")} />
            </div>
            <div className="mt-6 flex flex-wrap gap-3">
              {/* inversePrimary: this band is bg-stage, dark in BOTH themes,
                  so the theme-reactive primary fill turns near-black on
                  near-black in light mode. Its sibling below already uses
                  the quiet inverse for the same reason. */}
              <Button
                variant="inversePrimary"
                size="lg"
                onClick={() => navigate(canUsePro ? "/organiser" : "/devenir-organisateur")}
              >
                {t("createFree")}
              </Button>
              {/* The label follows the destination. This said "Démo
                  organisateur" and sent everyone to /pro, which is gated —
                  so a signed-out visitor landed on /login with no return
                  path and no demo. Promising a demo and delivering a sign-in
                  form is worse than asking for the sign-in up front. */}
              <Button
                variant="inverse"
                size="lg"
                onClick={() => navigate(canUsePro ? "/pro" : `/login?next=${encodeURIComponent("/pro")}`)}
              >
                {canUsePro ? t("openDashboard") : t("signInToPro")}
              </Button>
            </div>
          </div>

          {/* The grid cell is made to stretch (self-stretch) and then flex-
              centers the card inside itself -- that guarantees the card's
              visual centre lands on the cell's actual midpoint, instead of
              depending on the grid row's own auto height (set by the taller
              text column) and items-center's centering within that track,
              which reads correctly in principle but didn't look centered
              against the panel's padding in the reported screenshot. */}
          <div className="relative flex h-full items-center justify-center self-stretch">
            <div className="w-full max-w-md rounded-card bg-card p-4 text-ink shadow-modal transition duration-300 lg:rotate-1 lg:hover:rotate-0">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-muted">{t("previewKicker")}</p>
                <span className="rounded-full bg-success px-2 py-1 text-xs font-bold text-success-fg">{t("valid")}</span>
              </div>
              <img src="/events/electro.jpg" alt="" className="mt-3 h-36 w-full rounded-control object-cover" />
              <h3 className="mt-3 font-display text-xl font-extrabold">Casablanca Summer Beats</h3>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                <div>
                  <dt className="text-xs text-muted">{t("dates")}</dt>
                  {/* Was the literal string "28 JUIL · 21:00", so the whole
                      preview stayed French after switching to English or
                      Arabic — a hardcoded month abbreviation cannot be
                      translated. Formatted from a real date instead, which
                      is also what every other date on the site does. */}
                  <dd className="font-semibold">
                    {previewStamp.day} {previewStamp.month} · 21:00
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">{t("zoneAccess")}</dt>
                  <dd className="font-semibold">VIP · {t("previewGate")}</dd>
                </div>
              </dl>
              <div className="mt-3 flex items-center justify-between border-t border-dashed border-line/20 pt-3">
                <p className="font-mono text-xs">MA-2026-TICK-9082</p>
                <QrMark value="EVENTICK|MA-2026-TICK-9082|preview" className="size-16" />
              </div>
            </div>
          </div>
        </div>
      </section>
    </Shell>
  );
}

/** One icon-prefixed field inside the hero search card, wrapping a custom
 * Dropdown (see ui/Dropdown.jsx) instead of a native <select> -- a native
 * select's popup list ignores the app's theme entirely and broke the dark
 * card the moment it opened. The chevron lives inside Dropdown's own
 * trigger now, not duplicated here. */
function SearchField({ icon, label, children }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5 px-4 py-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-brume text-primary">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] font-semibold text-muted">{label}</span>
        {children}
      </span>
    </div>
  );
}

function HeroStat({ icon, value, label }) {
  // The hero's own stat row — not a tile, so it still reads as a caption to
  // the poster rather than another card, but an icon chip and bigger type
  // give each number the weight the surrounding empty space was asking for.
  return (
    /* Stacked on a phone, side by side from sm up.
       Three columns across a 360px screen leaves ~109px each, and the
       widest stat (a 44px icon chip, a gap, and "133,294" over "Seats
       available") needs ~147px beside each other -- so the label truncated
       to "Seats ..." on every phone. Stacking gives the text the whole
       column instead of what is left after the icon. */
    <div className="flex flex-col items-start gap-1.5 px-2 first:ps-0 last:pe-0 sm:flex-row sm:items-center sm:gap-4 sm:px-4">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-stage-fg/10 text-accent sm:size-11">{icon}</span>
      <div className="min-w-0">
        <dd className="font-display text-xl font-extrabold tabular-nums sm:text-3xl md:text-4xl">{value}</dd>
        {/* No truncate: with the full column width there is room to wrap,
            and a wrapped label is readable where a clipped one is not. */}
        <dt className="mt-0.5 text-xs font-semibold text-stage-muted sm:text-sm">{label}</dt>
      </div>
    </div>
  );
}

function Stat({ icon, value, label }) {
  // Rendered inside the always-dark organiser promo band (bg-stage).
  return (
    <div className="rounded-control bg-stage-fg/10 p-3">
      <span className="text-accent">{icon}</span>
      <p className="mt-1.5 font-display text-2xl font-extrabold text-accent">{value}</p>
      <p className="text-xs text-stage-muted">{label}</p>
    </div>
  );
}

function Trust({ tone, icon, title, body }) {
  return (
    <article className="flex gap-4 rounded-card border border-line/10 bg-card p-5 shadow-card sm:flex-col sm:text-center">
      <span className={cn("inline-flex size-12 shrink-0 items-center justify-center rounded-control sm:mx-auto", tone)}>{icon}</span>
      <div className="sm:mt-3">
        <h3 className="font-display text-lg font-bold">{title}</h3>
        <p className="mt-1 text-sm text-muted">{body}</p>
      </div>
    </article>
  );
}
