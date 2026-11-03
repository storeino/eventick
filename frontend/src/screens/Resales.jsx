import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { CalendarDays, MapPin, SearchX, Tag, Ticket } from "lucide-react";
import { Shell } from "../components/Shell";
import { api, money } from "../api";
import { Badge, Button, Card, Container, Dropdown, EmptyState, ErrorState, LoadingState } from "../ui";
import { useI18n } from "../i18n";
import { useAuth } from "../AuthContext";
import { eventText, intlLocaleTag } from "../utils";

/**
 * Every seat being resold, in one place.
 *
 * A listing used to be reachable only by its own link, which made a resale
 * work like a gift: fine for a friend, useless for a stranger. Someone who
 * found a show sold out had no way to discover that a seat existed, so the
 * seller's ticket went unsold and the buyer went away.
 *
 * Only SOLD-OUT zones appear here, which is the whole design rather than a
 * detail. A resale sits at face value, so listing one beside seats the
 * organiser can still sell just takes a sale he would have made anyway —
 * the platform competing with its own inventory. Where a zone has sold out
 * it is the opposite: this is the only thing between a buyer and a dead end.
 */
export default function Resales() {
  const { locale, t } = useI18n();
  const navigate = useNavigate();
  // Staff cannot buy a resold seat (refuseStaffPurchase), so every
  // listing below would lead them to a 403. The menu entry is hidden
  // from them; this is for the one who types the URL.
  const { canUsePro } = useAuth();
  const [params, setParams] = useSearchParams();
  const [resales, setResales] = useState(null);
  const [error, setError] = useState(null);

  const city = params.get("ville") ?? "";

  const load = () => {
    setError(null);
    api
      .get("/events/resales/all")
      .then((d) => setResales(d.resales ?? []))
      .catch((err) => setError(err.message));
  };

  useEffect(load, []);

  // Cities that actually have something on sale — offering a filter that
  // can only ever return nothing is worse than offering none.
  const cities = useMemo(() => {
    if (!resales) return [];
    return [...new Set(resales.map((r) => r.event.city))].sort();
  }, [resales]);

  const shown = useMemo(() => {
    if (!resales) return [];
    return city ? resales.filter((r) => r.event.city === city) : resales;
  }, [resales, city]);

  const setCity = (next) => {
    const sp = new URLSearchParams();
    if (next) sp.set("ville", next);
    setParams(sp, { replace: true });
  };

  return (
    <Shell>
      <Container className="py-8 md:py-12">
        <Badge tone="accent" className="gap-1.5">
          <Tag className="size-3.5" />
          {t("resaleBadge")}
        </Badge>

        <h1 className="mt-3 font-display text-display font-extrabold leading-tight">{t("resaleMarketTitle")}</h1>
        <p className="mt-2 max-w-[62ch] text-sm leading-relaxed text-muted">{t("resaleMarketIntro")}</p>

        {canUsePro ? (
          <p className="mt-5 rounded-control border border-line/15 bg-paper p-3 text-sm leading-relaxed text-muted">
            {t("staffNoBuy")}
          </p>
        ) : null}

        {error ? (
          <ErrorState className="mt-8" body={error} onRetry={load} />
        ) : !resales ? (
          <LoadingState className="mt-8" />
        ) : resales.length === 0 ? (
          /* Not an error state: an empty secondary market is the normal
             case, and most of the time it means nothing is sold out. */
          <EmptyState
            className="mt-8"
            icon={<SearchX className="size-6" />}
            title={t("resaleMarketEmpty")}
            body={t("resaleMarketEmptyNote")}
            action={
              <Button variant="secondary" onClick={() => navigate("/explorer")}>
                {t("browseEvents")}
              </Button>
            }
          />
        ) : (
          <>
            {cities.length > 1 ? (
              <div className="mt-6 flex items-center gap-3">
                <Dropdown
                  value={city}
                  onChange={setCity}
                  label={t("city")}
                  options={[{ value: "", label: t("allCities") }, ...cities.map((c) => ({ value: c, label: c }))]}
                />
                <span className="text-xs text-muted">
                  {t("resaleMarketCount").replace("{n}", String(shown.length))}
                </span>
              </div>
            ) : (
              <p className="mt-6 text-xs text-muted">
                {t("resaleMarketCount").replace("{n}", String(shown.length))}
              </p>
            )}

            <ul className="mt-4 grid gap-3">
              {shown.map((r) => (
                <li key={r.id}>
                  <Card className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-4">
                      {/* Decorative: the title beside it already names the
                          event, so alt text would only repeat it. */}
                      <img
                        src={r.event.image}
                        alt=""
                        className="hidden size-16 shrink-0 rounded-control object-cover sm:block"
                        loading="lazy"
                      />
                      <div className="min-w-0">
                        <Link
                          to={`/evenements/${r.event.slug}`}
                          className="block truncate font-display text-base font-bold hover:underline"
                        >
                          {eventText(r.event, "title", locale)}
                        </Link>
                        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
                          <CalendarDays className="size-3.5 shrink-0" />
                          {new Date(r.event.start).toLocaleString(intlLocaleTag(locale), {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })}
                        </p>
                        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                          <MapPin className="size-3.5 shrink-0" />
                          {r.event.city} · {eventText(r.event, "venue", locale)}
                        </p>
                        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                          <Ticket className="size-3.5 shrink-0" />
                          {eventText(r, "tierName", locale)}
                          {r.seatRow ? ` · ${r.seatRow}${r.seatNumber ?? ""}` : ""}
                        </p>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center justify-between gap-4 sm:flex-col sm:items-end sm:gap-2">
                      <div className="text-right">
                        <p className="font-display text-heading font-extrabold leading-none tabular-nums">
                          {money(r.priceCents)}{" "}
                          <span className="text-sm font-bold text-muted">MAD</span>
                        </p>
                        <p className="mt-0.5 text-[11px] text-muted">{t("resaleFaceValue")}</p>
                      </div>
                      <Link
                        to={`/revente/${r.token}`}
                        className="inline-flex h-10 items-center justify-center rounded-full bg-primary px-4 text-sm font-semibold text-on-primary"
                      >
                        {t("resaleMarketBuy")}
                      </Link>
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          </>
        )}
      </Container>
    </Shell>
  );
}
