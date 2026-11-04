import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { QrCode, RefreshCw, Ticket, Wallet } from "lucide-react";
import { api, money } from "../../api";
import { useI18n } from "../../i18n";
import { eventText, intlLocaleTag, longDate, todayKey } from "../../utils";
import { useRealtime } from "./useRealtime";
import { Badge, Card, EmptyState, PageHead, SectionTitle, StatCard, StatSkeletons } from "./ui";
import { useAuth } from "../../AuthContext";
import { cn } from "../../utils";
import { text } from "./copy";

export default function Overview() {
  const { locale } = useI18n();
  const t = text[locale];
  const { can } = useAuth();
  const canSeeEverything = can("scope.any");
  const [events, setEvents] = useState(null);
  const [orders, setOrders] = useState(null);
  const [stats, setStats] = useState(null);
  const [pulse, setPulse] = useState(false);

  const loadStats = useCallback(() => api.get("/organiser/stats").then(setStats).catch(() => {}), []);

  useEffect(() => {
    api.get("/organiser/events").then((data) => setEvents(data.events));
    api.get("/organiser/orders/detailed").then((data) => setOrders(data.orders));
    loadStats();
  }, [loadStats]);

  // A check-in or a sale moves the counters without a reload. The lists
  // themselves are refetched only on a sale, where a new row actually appears.
  const onRealtime = useCallback(
    (event) => {
      setPulse(true);
      setTimeout(() => setPulse(false), 1200);
      loadStats();
      if (event.type === "order") {
        api.get("/organiser/orders/detailed").then((data) => setOrders(data.orders)).catch(() => {});
      }
    },
    [loadStats],
  );
  useRealtime(onRealtime);

  const loading = !events || !orders || !stats;
  const today = todayKey();
  const upcoming = (events ?? []).filter((event) => event.end >= today).slice(0, 5);
  const recent = (orders ?? []).slice(0, 5);
  const gmv = stats?.gmvCents ?? 0;
  const ticketCount = stats?.tickets ?? 0;
  const inside = stats?.inside ?? 0;
  const scanRate = ticketCount > 0 ? Math.round((inside / ticketCount) * 100) : 0;

  return (
    <div>
      <PageHead
        title={t.overview}
        /* "Your activity" is true for an organiser and false for an admin,
           whose figures span every organiser on the platform. Keyed on
           scope.any rather than the ADMIN role, matching what the server
           actually widens the query on. */
        sub={canSeeEverything ? t.overviewSubAll : t.overviewSub}
        actions={
          <>
            {stats ? (
              <span className="flex items-center gap-2 text-xs text-muted">
                <RefreshCw className={cn("size-3.5", pulse && "animate-spin text-primary")} aria-hidden />
                {t.updatedAt.replace(
                  "{t}",
                  new Date(stats.generatedAt).toLocaleTimeString(intlLocaleTag(locale), {
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                )}
              </span>
            ) : null}
            {/* The one accent moment on this screen: a fresh sale or
                check-in flashes lime rather than the quiet success-green
                used everywhere else, so it is unmistakably "something just
                happened" rather than a routine status. */}
            <Badge tone={pulse ? "accent" : "neutral"}>{t.live}</Badge>
            <Link
              to="/organiser"
              className="inline-flex h-11 items-center rounded-control bg-action px-4 text-sm font-semibold text-action-fg transition hover:bg-action-hover active:scale-[0.97]"
            >
              {t.create}
            </Link>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {loading ? (
          <StatSkeletons count={3} />
        ) : (
          <>
            <StatCard
              accent
              icon={<Wallet className="size-5" />}
              label={t.gmv}
              info={t.tipGmv}
              value={`${money(gmv)} MAD`}
              sub={`${stats.orders} ${t.orders.toLowerCase()}`}
            />
            <StatCard
              icon={<Ticket className="size-5" />}
              label={t.tickets}
              info={t.tipTickets}
              value={String(ticketCount)}
              sub={`${events.length} ${t.events.toLowerCase()}`}
            />
            <StatCard
              icon={<QrCode className="size-5" />}
              label={t.inside}
              info={t.tipInside}
              value={`${inside}/${ticketCount}`}
              trend={{ dir: scanRate > 0 ? "up" : "flat", text: `${scanRate}%` }}
            />
          </>
        )}
      </div>

      <ol className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {t.loop.map((step, index) => (
          <li key={step} className="rounded-card border border-line/10 bg-card px-4 py-3 shadow-card">
            <span className="font-mono text-xs font-bold text-primary">0{index + 1}</span>
            <p className="text-sm font-semibold">{step}</p>
          </li>
        ))}
      </ol>

      <div className="mt-6 grid gap-4 lg:grid-cols-[1.6fr_1fr] lg:items-stretch">
        {/* min-w-0: a grid item's default min-width is auto, not 0 -- so
            without this, each Card is held to its content's min-content
            width (here, the widest row in its own list) instead of the
            grid track's width, and on a single-column mobile layout that
            pushed both cards past the viewport. */}
        <Card className="flex min-w-0 flex-col">
          <SectionTitle
            action={
              <Link to="/pro/events" className="text-sm font-semibold text-primary">
                {t.open}
              </Link>
            }
          >
            {t.upcoming}
          </SectionTitle>
          <ul className="grid gap-3">
            {upcoming.map((event) => (
              <li key={event.slug} className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <img src={event.image} alt="" className="size-10 shrink-0 rounded-control object-cover" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold">{eventText(event, "title", locale)}</p>
                    <p className="truncate text-xs text-muted">
                      {event.city} · {longDate(event.start, locale)}
                    </p>
                  </div>
                </div>
                <Link to={`/evenements/${event.slug}`} className="shrink-0 text-sm font-semibold text-primary">
                  {t.public}
                </Link>
              </li>
            ))}
            {events && upcoming.length === 0 ? (
              <li>
                <EmptyState icon="📅" title={t.noEventsYet} />
              </li>
            ) : null}
          </ul>
        </Card>

        <Card className="flex min-w-0 flex-col">
          <SectionTitle
            action={
              <Link to="/pro/orders" className="text-sm font-semibold text-primary">
                {t.open}
              </Link>
            }
          >
            {t.recent}
          </SectionTitle>
          <ul className="grid gap-3">
            {recent.map((order) => (
              <li key={order.id} className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-brume text-[13px] font-bold text-primary" aria-hidden>
                    {(order.holderName || "?").slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{order.holderName}</p>
                    <p className="truncate text-xs text-muted">
                      {order.tickets[0] ? (eventText(order.tickets[0].event, "title", locale)) : order.id}
                    </p>
                  </div>
                </div>
                <span className="shrink-0 text-sm font-extrabold tabular-nums">{money(order.totalCents)}</span>
              </li>
            ))}
            {orders && recent.length === 0 ? (
              <li>
                <EmptyState icon="🧾" title={t.noOrdersYet} />
              </li>
            ) : null}
          </ul>
        </Card>
      </div>
    </div>
  );
}
