import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Calendar, Clock, Heart, MapPin, Minus, ParkingCircle, Plus, QrCode, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Shell } from "../components/Shell";
import { EventCard } from "../components/EventCard";
import { api, money, rememberOrderKey } from "../api";
import { useAuth } from "../AuthContext";
import { useCart } from "../CartContext";
import { useFavorites } from "../FavoritesContext";
import { useCatalog } from "../useCatalog";
import { categoryLabel, useI18n } from "../i18n";
import { Badge, Button, Card, Container, ErrorState, Input, LoadingState } from "../ui";
import { cn, dateRange, eventText, groupNumber, intlLocaleTag, mapsUrl, minPriceCents, totalCapacity, totalRemaining } from "../utils";

const MAX_QTY_PER_TIER = 8;

export default function EventDetail() {
  const { slug } = useParams();
  const { locale, t, tf } = useI18n();
  const navigate = useNavigate();
  const { setCart } = useCart();
  const { favorites, toggle } = useFavorites();
  const { events, bySlug, loading, error, reload } = useCatalog();
  const event = bySlug(slug);
  const [qty, setQty] = useState({});
  // Staff sell rather than buy. The server refuses their purchase outright
  // (refuseStaffPurchase on /orders/hold), so without this they would fill a
  // basket, press Pay and collect a 403 toast -- a wall at the last step
  // instead of an explanation at the first.
  const { canUsePro, user, loading: authLoading } = useAuth();
  const [waitEmail, setWaitEmail] = useState("");
  const [waitBusy, setWaitBusy] = useState(false);
  const [booking, setBooking] = useState(false);
  // Live remaining counts, refreshed after a failed booking so the buyer sees
  // the real numbers rather than the ones the page loaded with.
  const [remaining, setRemaining] = useState(null);
  /*
   * Seats fans are reselling on this event.
   *
   * The server returns these ONLY for zones that have sold out, so this stays
   * empty on a show with seats still on sale -- a resale sits at face value,
   * and putting one beside the organiser's own inventory would take a sale he
   * would have made anyway.
   */
  const [resales, setResales] = useState([]);

  useEffect(() => {
    if (!slug) return;
    let alive = true;
    api
      .get(`/events/${slug}/resales`)
      .then((d) => alive && setResales(d.resales ?? []))
      // Never break the page over this: resales are an extra, and the event
      // reads perfectly well without them.
      .catch(() => alive && setResales([]));
    return () => {
      alive = false;
    };
  }, [slug]);

  /** Seats left per tier: the live figure once we've refreshed, else the one
   * the catalogue was loaded with. */
  const leftFor = (tier) => remaining?.[tier.id] ?? tier.remaining;

  const lines = useMemo(() => {
    if (!event) return [];
    return event.tiers
      .map((tier) => ({ tier, qty: qty[tier.id] ?? 0, left: remaining?.[tier.id] ?? tier.remaining }))
      .filter((line) => line.qty > 0);
  }, [event, qty, remaining]);

  // Three distinct states. The old code rendered an empty 320px box while
  // loading and the same box on failure, so a dead backend looked like a slow
  // one and neither offered a way out.
  if (loading) {
    return (
      <Shell>
        <Container className="py-10">
          <LoadingState label={t("loadingEvents")} rows={3} />
        </Container>
      </Shell>
    );
  }

  if (error) {
    return (
      <Shell>
        <Container className="py-10">
          <ErrorState
            title={t("catalogErrorTitle")}
            body={t("catalogErrorBody")}
            onRetry={reload}
            retryLabel={t("retry")}
          />
        </Container>
      </Shell>
    );
  }

  if (!event) {
    return (
      <Shell>
        <Container size="narrow" className="py-20 text-center">
          <h1 className="font-display text-title font-extrabold">{t("notFound")}</h1>
          <p className="mt-2 text-muted">{t("notFoundBody")}</p>
          <Button className="mt-6" onClick={() => navigate("/explorer")}>
            {t("backEvents")}
          </Button>
        </Container>
      </Shell>
    );
  }

  const total = lines.reduce((sum, line) => sum + line.qty * line.tier.priceCents, 0);
  const count = lines.reduce((sum, line) => sum + line.qty, 0);
  // Two bugs, not one. First: `item.end >= event.start` compared every
  // candidate's end date against the VIEWED event's own start date, not
  // today's date -- so viewing anything dated mid-2027 (Mawazine, Gnaoua)
  // filtered out literally every 2026 event in the catalog, leaving at
  // most the other 2027 listing. Second, the same "strict same-category
  // match can be too thin" issue fixed on Home's side column: even with
  // the date bug fixed, a category can still have only one other live
  // event. Same category is preferred (sorted first) but topped up with
  // other live events, nearest date first, rather than leaving the grid
  // (sized for 3 cards) short.
  const todayIso = new Date().toISOString();
  const isLive = (item) => item.slug !== event.slug && item.end >= todayIso;
  const sameCat = events.filter((item) => isLive(item) && item.category === event.category);
  const otherCat = events.filter((item) => isLive(item) && item.category !== event.category).sort((a, b) => a.start.localeCompare(b.start));
  const related = [...sameCat, ...otherCat].slice(0, 3);
  const title = eventText(event, "title", locale);
  const venue = eventText(event, "venue", locale);
  const soldOut = totalRemaining(event) === 0;
  const isSaved = favorites.includes(event.slug);

  const change = (id, left, delta) => {
    setQty((current) => {
      const next = Math.max(0, Math.min(left, MAX_QTY_PER_TIER, (current[id] ?? 0) + delta));
      return { ...current, [id]: next };
    });
  };

  /**
   * Reserve the seats NOW, before the buyer fills anything in.
   *
   * The reservation used to happen when the checkout form was submitted, so a
   * buyer could type their whole name, email and phone and only then be told
   * the tickets had gone. Claiming the seat on this click means the form is
   * only ever shown for tickets they already hold.
   */
  const checkout = async () => {
    if (!count) {
      toast.error(t("emptyCart"));
      return;
    }
    /*
     * Buying needs an account. The server enforces it (authenticate on
     * /orders/hold); this sends people to sign in FIRST rather than letting
     * them pick seats, press Book and collect a 401.
     *
     * `?next=` brings them back to this event, so signing in costs them the
     * click and not the basket. Login only honours same-site paths, so this
     * cannot be turned into an open redirect.
     *
     * `authLoading` is checked first: a click landing during the auth
     * hydration that runs on every page load would otherwise read `user` as
     * null and send a signed-in buyer to the login page.
     */
    if (authLoading) return;
    if (!user) {
      /*
       * The CURRENT url, query string included, not a rebuilt path.
       *
       * A waitlist offer arrives as /evenements/<slug>?claim=<token> and that
       * token is the seat being held for this person. Rebuilding the path
       * from the slug alone would drop it, so signing in would cost them the
       * offer -- and the 30-minute window keeps running while they do it.
       */
      const here = `${window.location.pathname}${window.location.search}`;
      navigate(`/login?next=${encodeURIComponent(here)}`);
      return;
    }
    if (booking) return;
    setBooking(true);
    try {
      const hold = await api.post("/orders/hold", {
        eventSlug: event.slug,
        lines: lines.map((line) => ({ tierId: line.tier.id, qty: line.qty })),
      });
      // This response is the only time the server hands over the order's
      // access token. A guest has no session, so losing it here would mean
      // losing the ticket — api.js attaches it to every later call from this
      // store, and it also rides in the confirmation URL for other devices.
      rememberOrderKey(hold.order.id, hold.accessToken);
      setCart({
        eventSlug: event.slug,
        lines: lines.map((line) => ({ tierId: line.tier.id, qty: line.qty })),
        orderId: hold.order.id,
        holdUntil: hold.holdUntil,
      });
      navigate("/paiement");
    } catch (err) {
      // 409 means someone else took them between the page loading and this
      // click — tell them here, where they've lost nothing but a tap.
      toast.error(err.status === 409 ? t("oversell") : err.message || t("reserveFail"));
      api
        .get(`/orders/availability/${event.slug}`)
        .then((data) => setRemaining(data.remaining))
        .catch(() => {});
      setQty({});
    } finally {
      setBooking(false);
    }
  };

  const joinWaitlist = async (e) => {
    e.preventDefault();
    if (waitBusy) return;
    setWaitBusy(true);
    try {
      await api.post(`/events/${event.slug}/waitlist`, { email: waitEmail.trim() });
      toast.success(t("waitOk"));
      setWaitEmail("");
    } catch (err) {
      toast.error(err.status === 409 ? t("waitDup") : err.message);
    } finally {
      setWaitBusy(false);
    }
  };

  return (
    <Shell overlay>
      {/* Deliberately always dark, so the photo stays legible regardless of
          app theme — see the note on --et-stage in styles.css.

          The photo now renders at full opacity. It was 0.7 over a flat
          `bg-stage`, which is a wash across the whole frame: the picture an
          organiser chose came out as a grey smudge.

          What is left is a BOTTOM-ONLY scrim, and it is not decoration —
          the title, the blurb and the date chips sit directly on the image,
          so with nothing behind them a bright patch of sky or a floodlight
          makes white text unreadable. Opaque at the very bottom where the
          text is densest, gone by 60% of the height, so the top two-fifths
          of the photo are untouched. */}
      <section className="relative -mt-16 overflow-hidden bg-stage pt-16 text-stage-fg">
        <img src={event.image} alt="" className="absolute inset-0 h-full w-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-t from-stage via-stage/45 via-60% to-transparent" />
        <div className="relative mx-auto max-w-7xl px-4 py-12 md:px-8 md:py-16">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-primary px-3 py-1 text-xs font-bold uppercase tracking-wide text-primary-fg">
              {categoryLabel(event.category, t)}
            </span>
            <span className="rounded-full bg-stage-fg/15 px-3 py-1 text-xs font-bold">{t("official")}</span>
            {event.badge === "last" || event.badge === "hot" ? (
              <span className="rounded-full bg-danger px-3 py-1 text-xs font-bold">{t("limited")}</span>
            ) : null}
          </div>
          <h1 className="mt-4 max-w-4xl font-display text-4xl font-extrabold leading-none md:text-hero">{title}</h1>
          <p className="mt-4 max-w-2xl text-stage-muted">{eventText(event, "about", locale)}</p>
          {/* Pill chips instead of loose icon-plus-text pairs floating in a
              row -- matches the trust-row/stat-chip language used
              everywhere else in the app rather than being the one part of
              the hero with no surface of its own. */}
          <div className="mt-6 flex flex-wrap gap-2 text-sm">
            <span className="inline-flex items-center gap-2 rounded-full bg-stage-fg/10 px-3.5 py-2">
              <Calendar className="size-4 text-accent" />
              {dateRange(event.start, event.end, locale)}
            </span>
            <span className="inline-flex items-center gap-2 rounded-full bg-stage-fg/10 px-3.5 py-2">
              <Clock className="size-4 text-accent" />
              {t("doors")} {new Date(event.doors).toLocaleTimeString(intlLocaleTag(locale), { hour: "2-digit", minute: "2-digit" })}
            </span>
            <span className="inline-flex items-center gap-2 rounded-full bg-stage-fg/10 px-3.5 py-2">
              <MapPin className="size-4 text-accent" />
              {venue}, {event.city}
            </span>
          </div>

          {/* A quick price/capacity anchor right in the hero -- previously
              the price was invisible until scrolling down to the tier
              picker, so there was nothing here to help someone decide
              whether to keep reading before committing to the scroll. */}
          <div className="mt-6 flex flex-wrap items-center gap-6 border-t border-stage-fg/10 pt-6">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-stage-muted">{t("from")}</p>
              <p className="font-display text-2xl font-extrabold tabular-nums">
                {money(minPriceCents(event))} <span className="text-sm font-bold text-stage-muted">MAD</span>
              </p>
            </div>
            <div className="h-10 w-px bg-stage-fg/10" aria-hidden />
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-stage-muted">{t("capacity")}</p>
              <p className="font-display text-2xl font-extrabold tabular-nums">{groupNumber(totalCapacity(event))}</p>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <a href="#billets" className="inline-flex h-12 items-center rounded-full bg-action px-5 text-sm font-semibold text-action-fg transition hover:bg-action-hover">
              {t("choose")}
            </a>
            <a href={mapsUrl(event)} target="_blank" rel="noreferrer" className="inline-flex h-12 items-center rounded-full border border-stage-fg/30 px-5 text-sm font-semibold">
              {t("directions")}
            </a>
            <button
              type="button"
              className="inline-flex size-12 items-center justify-center rounded-full border border-stage-fg/30"
              aria-label={t("saved")}
              onClick={() => {
                toggle(event.slug);
                toast.success(isSaved ? t("savedOk") : t("savedAdd"));
              }}
            >
              <Heart className={isSaved ? "size-5 fill-accent text-accent" : "size-5"} />
            </button>
          </div>
        </div>
      </section>

      <div id="billets" className="mx-auto grid max-w-7xl gap-6 px-4 py-10 md:px-8 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-8">
          <Card pad={false} className="overflow-hidden">
            <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line/10 p-5">
              <div className="min-w-0">
                <h2 className="font-display text-heading font-extrabold">{t("select")}</h2>
                <p className="mt-0.5 text-sm text-muted">{t("officialSale")}</p>
              </div>
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary">
                <ShieldCheck className="size-4 shrink-0" aria-hidden />
                {t("accessOk")}
              </span>
            </div>

            {/* A divided list read as one continuous block, with the
                "recommended" tier only a faint tint apart from the rest --
                each tier is now its own bordered card with real spacing
                between them, and the recommended one gets a solid left
                accent stripe instead of a low-contrast background tint, so
                it reads as a deliberately different product rather than a
                slightly-different shade of the same row. */}
            <ul className="grid gap-3 p-5">
              {event.tiers.map((tier) => {
                const left = leftFor(tier);
                const value = qty[tier.id] ?? 0;
                const gone = left === 0;
                // "Only n left" is only true when it IS few. The old card
                // showed it under 80 seats, which on a 20 000-seat festival
                // was manufactured urgency.
                const scarce = !gone && left <= 10;

                return (
                  <li
                    key={tier.id}
                    className={cn(
                      "rounded-card border p-5 transition",
                      tier.recommended ? "border-primary/40 bg-brume/40 ring-1 ring-primary/20" : "border-line/10 bg-card",
                      value > 0 && !tier.recommended && "border-primary/30 bg-brume/30",
                      gone && "opacity-55",
                    )}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap gap-1.5">
                          {tier.recommended ? <Badge tone="primary">{t("recommended")}</Badge> : null}
                          {tier.saveCents ? (
                            <Badge tone="accent">{tf("savePct", { n: Math.round((tier.saveCents / tier.priceCents) * 100) })}</Badge>
                          ) : null}
                          {scarce ? <Badge tone="danger">{tf("seatsLeft", { n: left })}</Badge> : null}
                          {gone ? <Badge tone="neutral">{t("soldOut")}</Badge> : null}
                        </div>

                        <h3 className="mt-2 font-display text-subhead font-bold">
                          {eventText(tier, "name", locale)}
                        </h3>
                        <p className="mt-1 max-w-xl text-sm leading-relaxed text-muted">
                          {eventText(tier, "blurb", locale)}
                        </p>
                        <p className="mt-2 font-mono text-xs text-primary">
                          {eventText(tier, "zone", locale)} · {eventText(tier, "gate", locale)}
                        </p>
                      </div>

                      <div className="flex shrink-0 flex-col items-end gap-2.5">
                        <p className="font-display text-heading font-extrabold tabular-nums">
                          {money(tier.priceCents)} <span className="text-sm font-bold text-muted">MAD</span>
                        </p>
                        <div className="inline-flex items-center rounded-full border border-line/15 bg-card">
                          <button
                            type="button"
                            className="inline-flex size-11 items-center justify-center rounded-s-full text-muted transition hover:bg-paper hover:text-ink disabled:opacity-35"
                            aria-label={t("remove")}
                            disabled={value === 0}
                            onClick={() => change(tier.id, left, -1)}
                          >
                            <Minus className="size-4" aria-hidden />
                          </button>
                          <span
                            className="w-8 text-center font-display font-extrabold tabular-nums"
                            aria-live="polite"
                            aria-label={tf("ticketsChosen", { n: value })}
                          >
                            {value}
                          </span>
                          <button
                            type="button"
                            className="inline-flex size-11 items-center justify-center rounded-e-full text-muted transition hover:bg-paper hover:text-ink disabled:opacity-35"
                            aria-label={t("add")}
                            disabled={value >= Math.min(MAX_QTY_PER_TIER, left)}
                            onClick={() => change(tier.id, left, 1)}
                          >
                            <Plus className="size-4" aria-hidden />
                          </button>
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>

          {event.lineup?.length ? (
            <section>
              <h2 className="font-display text-2xl font-extrabold">{t("lineup")}</h2>
              <p className="text-sm text-muted">{t("programming")}</p>
              <div className="mt-4 grid gap-3 md:grid-cols-3">
                {event.lineup.map((item) => (
                  <article key={item.name} className="overflow-hidden rounded-card border border-line/10 bg-card shadow-card">
                    <img src={item.image} alt="" className="h-32 w-full object-cover" />
                    <div className="p-3">
                      <p className="font-mono text-xs text-primary">
                        {new Date(item.day).getUTCDate()} · {item.time}
                      </p>
                      <h3 className="font-display font-bold">{item.name}</h3>
                      <p className="text-sm text-muted">{eventText(item, "genre", locale)}</p>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          {/* Three flat solid-colour bars, stacked with no shape logic
              connecting them -- redrawn as an actual stage-and-zones
              illustration: a curved stage element up front, zones widening
              as they get further from it (the way a real crowd fans out),
              each one tagged with its own colour-coded legend dot instead
              of relying on the fill colour alone to say "this is a
              different zone". */}
          <section className="rounded-card border border-line/10 bg-card p-4 shadow-card md:p-6">
            <h2 className="font-display text-2xl font-extrabold">{t("plan")}</h2>
            <p className="text-sm text-muted">{venue}</p>
            <div className="mx-auto mt-5 max-w-lg rounded-card bg-paper p-5">
              <div
                className="mx-auto flex h-12 w-[55%] items-center justify-center rounded-t-[999px] bg-primary text-xs font-bold uppercase tracking-wide text-primary-fg"
                style={{ clipPath: "ellipse(50% 100% at 50% 100%)" }}
              >
                {t("stage")}
              </div>
              <div className="mx-auto mt-3 flex h-16 w-[75%] items-center justify-center bg-accent text-sm font-bold text-accent-fg [clip-path:polygon(8%_0,92%_0,100%_100%,0_100%)]">
                {t("vipZone")}
              </div>
              <div className="mx-auto -mt-px flex h-24 w-full items-center justify-center bg-brume-deep text-sm font-bold text-ink [clip-path:polygon(4%_0,96%_0,100%_100%,0_100%)]">
                {t("lawn")}
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs font-semibold text-muted">
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2.5 rounded-full bg-primary" aria-hidden />
                {t("stage")}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2.5 rounded-full bg-accent" aria-hidden />
                {t("vipZone")}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2.5 rounded-full bg-brume-deep" aria-hidden />
                {t("lawn")}
              </span>
            </div>
            <p className="mt-3 text-center text-xs text-muted">
              {t("capacity")} · {groupNumber(event.tiers.reduce((sum, tier) => sum + tier.capacity, 0))}
            </p>
          </section>

          <section>
            <h2 className="font-display text-2xl font-extrabold">{t("practical")}</h2>
            {/* Each card gets its own icon chip, same colour-coded language
                used for the trust row and category tiles -- four identical
                title+body blocks were only distinguishable by reading the
                title text; now they're scannable at a glance. */}
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <Info
                tone="bg-primary text-primary-fg"
                icon={<MapPin className="size-5" />}
                title={t("access")}
                body={`${venue}, ${event.address}. ${t("accessBody")}`}
              />
              <Info tone="bg-secondary text-secondary-fg" icon={<ParkingCircle className="size-5" />} title={t("parking")} body={t("parkingBody")} />
              <Info tone="bg-accent text-accent-fg" icon={<ShieldCheck className="size-5" />} title={t("age")} body={eventText(event, "age", locale)} />
              <Info tone="bg-info text-info-fg" icon={<QrCode className="size-5" />} title={t("fraud")} body={t("fraudBody")} />
            </div>
          </section>
        </div>

        <aside className="h-fit lg:sticky lg:top-24">
          {/* Deliberately always dark — see the note on --et-stage. */}
          <Card className="bg-stage text-stage-fg" pad={false}>
            <div className="border-b border-stage-fg/10 p-5">
              <p className="text-[11px] font-bold uppercase tracking-wide text-stage-muted">{t("recap")}</p>
              <h2 className="mt-0.5 font-display text-subhead font-extrabold">{t("cart")}</h2>
            </div>

            <div className="p-5">
              {lines.length === 0 ? (
                <p className="text-sm text-stage-muted">{t("emptyCart")}</p>
              ) : (
                <ul className="grid gap-3 text-sm">
                  {lines.map((line) => (
                    <li key={line.tier.id} className="flex items-center justify-between gap-3">
                      <span className="flex min-w-0 items-center gap-2">
                        {/* A colour dot tying each line back to its tier --
                            the cart used to be plain text with nothing
                            connecting a line item to the card it came from
                            above. */}
                        <span className={cn("size-2 shrink-0 rounded-full", line.tier.recommended ? "bg-primary" : "bg-accent")} aria-hidden />
                        <span className="min-w-0 truncate">
                          <span className="font-semibold tabular-nums">{line.qty}×</span>{" "}
                          {eventText(line.tier, "name", locale)}
                        </span>
                      </span>
                      <span className="shrink-0 font-semibold tabular-nums">{money(line.qty * line.tier.priceCents)}</span>
                    </li>
                  ))}
                </ul>
              )}

              <dl className="mt-4 grid gap-1.5 border-t border-stage-fg/15 pt-4 text-sm">
                <Row label={t("fees")} value={t("feesFree")} />
                <Row label={t("vat")} value={t("included")} />
              </dl>

              {/* The total is the biggest thing in the panel — it is what
                  the buyer is deciding about. A tinted panel instead of
                  plain inline text gives it a surface of its own, like the
                  rest of the page's numbers (hero stats, tier prices)
                  already have. */}
              <div className="mt-4 rounded-control border border-primary/20 bg-primary/10 p-4">
                <p className="text-sm text-stage-muted">{t("total")}</p>
                <p className="font-display text-display font-extrabold leading-none tabular-nums">
                  {money(total)} <span className="text-heading font-bold text-stage-muted">MAD</span>
                </p>
              </div>

              {canUsePro ? (
                <p className="mt-4 rounded-control border border-stage-fg/20 bg-stage-fg/10 p-3 text-sm leading-relaxed text-stage-muted">
                  {t("staffNoBuy")}
                </p>
              ) : (
                <Button
                  full
                  size="lg"
                  className="mt-4"
                  disabled={!count}
                  loading={booking}
                  onClick={checkout}
                >
                  {/* Says where the click actually leads. A button reading
                      "continue to payment" that opens a login page reads as a
                      fault, even though signing in is the intended step. */}
                  {user || authLoading ? t("pay") : t("paySignIn")}
                </Button>
              )}

              {/*
                Seats fans are reselling, ABOVE the waitlist.
                A seat available now beats joining a queue for one that may
                never come free, so offering the queue first would bury the
                better answer. Absent entirely when there is nothing on sale.
              */}
              {soldOut && resales.length > 0 ? (
                <div className="mt-5 border-t border-stage-fg/15 pt-5">
                  <p className="text-sm font-bold">{t("resaleHereTitle")}</p>
                  <p className="mt-1 text-xs leading-relaxed text-stage-muted">
                    {t("resaleHereBody").replace("{n}", String(resales.length))}
                  </p>
                  <Button
                    variant="inverse"
                    full
                    className="mt-3"
                    onClick={() => navigate(`/revente/${resales[0].token}`)}
                  >
                    {t("resaleHereCta").replace("{n}", money(resales[0].priceCents))}
                  </Button>
                </div>
              ) : null}

              {soldOut ? (
                <form className="mt-5 grid gap-2 border-t border-stage-fg/15 pt-5" onSubmit={joinWaitlist}>
                  <p className="text-sm font-bold">{t("waitTitle")}</p>
                  <p className="text-xs leading-relaxed text-stage-muted">{t("waitBody")}</p>
                  <Input
                    tone="stage"
                    className="text-sm"
                    type="email"
                    required
                    value={waitEmail}
                    onChange={(e) => setWaitEmail(e.target.value)}
                    placeholder={t("email")}
                    aria-label={t("email")}
                  />
                  <Button variant="inverse" full type="submit" loading={waitBusy}>
                    {t("waitJoin")}
                  </Button>
                </form>
              ) : null}

              <div className="mt-5 border-t border-stage-fg/15 pt-4">
                <p className="text-xs text-stage-muted">{t("helpBook")}</p>
                <a
                  className="mt-1 inline-block text-sm font-semibold text-accent underline-offset-2 hover:underline"
                  href="https://wa.me/212537001122"
                  target="_blank"
                  rel="noreferrer"
                >
                  +212 5 37 00 11 22
                </a>
              </div>
            </div>
          </Card>
        </aside>
      </div>

      {/* Phone action bar. The count used to render as a bare number under
          the price — just "3", with no unit — so it read as a stray figure. */}
      {count > 0 && !canUsePro ? (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line/10 bg-card/95 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-md lg:hidden">
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-display text-subhead font-extrabold tabular-nums">{money(total)} MAD</p>
              <p className="text-xs text-muted">{tf("ticketsChosen", { n: count })}</p>
            </div>
            <Button size="lg" loading={booking} onClick={checkout}>
              {t("pay")}
            </Button>
          </div>
        </div>
      ) : null}

      {/* A tinted band instead of sitting on bare page background -- same
          "give the page's closing content section its own surface"
          treatment already used for the practical-info/trust-row areas
          elsewhere, rather than this being the one section left floating
          directly on the page. */}
      <section className="mt-8 border-t border-line/10 bg-brume/30 py-10">
        <div className="mx-auto max-w-7xl px-4 md:px-8">
          <h2 className="font-display text-2xl font-extrabold">{t("alsoSub")}</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            {related.map((item) => (
              <EventCard key={item.slug} event={item} />
            ))}
          </div>
        </div>
      </section>
    </Shell>
  );
}

function Row({ label, value }) {
  // Used only inside the always-dark checkout summary card (bg-stage).
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-stage-muted">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Info({ tone, icon, title, body }) {
  return (
    <article className="flex gap-3.5 rounded-card border border-line/10 bg-card p-4 shadow-card">
      <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-control", tone)} aria-hidden>
        {icon}
      </span>
      <div className="min-w-0">
        <h3 className="font-display font-bold">{title}</h3>
        <p className="mt-1 text-sm text-muted">{body}</p>
      </div>
    </article>
  );
}
