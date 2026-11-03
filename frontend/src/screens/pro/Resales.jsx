import { useEffect, useMemo, useState } from "react";
import { Tag } from "lucide-react";
import { api, money } from "../../api";
import { useI18n } from "../../i18n";
import { Badge, DataTable, EmptyState, PageHead, PersonCell, StatCard, Td, Th } from "./ui";
import { text } from "./copy";
import { useOrganisers } from "./useOrganisers";
import { Dropdown } from "../../ui";
import { eventText, intlLocaleTag } from "../../utils";

const TONE = { LISTED: "warn", SOLD: "success", CANCELLED: "neutral" };

/**
 * Resale activity on this organiser's events.
 *
 * The setting to allow resale already existed, on each event's rules modal.
 * Its consequences did not: an organiser could switch it on and never learn
 * who was reselling, at what price, or whether anything sold.
 *
 * This is deliberately read-only. A resale is between two buyers at face
 * value — the organiser was paid when the seat was first sold, and the
 * money does not move again. The one lever they have is the switch on the
 * event itself, which is where it belongs; a button here would imply they
 * can intervene in someone else's sale.
 *
 * No buyer identity either. What an organiser needs to know is that a seat
 * changed hands; who holds it now is read off the ticket at the gate.
 */
export default function Resales() {
  const { locale } = useI18n();
  const t = text[locale];
  /*
   * Whose event each listing belongs to, shown to a caller whose list can
   * span more than one organiser. Keyed off the `scope.any` PERMISSION
   * rather than the ADMIN role, matching useOrganisers: a column gated on
   * the role would keep rendering for an admin whose scope.any was revoked,
   * and would hide from a non-admin who holds it.
   */
  const { maySeeAllOrganisers } = useOrganisers();
  const [rows, setRows] = useState(null);
  const [slug, setSlug] = useState("");
  const [events, setEvents] = useState([]);

  useEffect(() => {
    api
      .get("/organiser/resales")
      .then((d) => setRows(d.resales ?? []))
      .catch(() => setRows([]));
    api
      .get("/organiser/events")
      .then((d) => setEvents(d.events ?? []))
      .catch(() => setEvents([]));
  }, []);

  const shown = useMemo(() => {
    if (!rows) return [];
    return slug ? rows.filter((r) => r.eventSlug === slug) : rows;
  }, [rows, slug]);

  // Counted from what is on screen, so the figures answer the filter the
  // organiser is actually looking at rather than the whole account.
  const stats = useMemo(() => {
    const sold = shown.filter((r) => r.status === "SOLD");
    return {
      listed: shown.filter((r) => r.status === "LISTED").length,
      sold: sold.length,
      soldCents: sold.reduce((sum, r) => sum + r.priceCents, 0),
    };
  }, [shown]);

  return (
    <>
      <PageHead title={t.resalesTitle} sub={t.resalesSub} />

      {rows === null ? null : rows.length === 0 ? (
        <EmptyState
          icon={<Tag className="size-6" />}
          title={t.resalesEmpty}
          body={t.resalesEmptyBody}
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard icon={<Tag className="size-5" />} label={t.resalesOnSale} value={String(stats.listed)} />
            <StatCard icon={<Tag className="size-5" />} label={t.resalesSold} value={String(stats.sold)} />
            <StatCard
              accent
              icon={<Tag className="size-5" />}
              label={t.resalesSoldValue}
              value={`${money(stats.soldCents)} MAD`}
              sub={t.resalesSoldValueNote}
            />
          </div>

          {events.length > 1 ? (
            <div className="mt-5">
              <Dropdown
                value={slug}
                onChange={setSlug}
                label={t.eventCol}
                options={[
                  { value: "", label: t.allEvents },
                  ...events.map((e) => ({ value: e.slug, label: eventText(e, "title", locale) })),
                ]}
              />
            </div>
          ) : null}

          <div className="mt-4">
            <DataTable minWidth={maySeeAllOrganisers ? 1040 : 820}>
              <thead>
                <tr>
                  <Th>{t.eventCol}</Th>
                  {maySeeAllOrganisers ? <Th>{t.organiserCol}</Th> : null}
                  <Th>{t.compZone}</Th>
                  <Th className="w-px whitespace-nowrap">{t.ticketColumn}</Th>
                  <Th className="w-px whitespace-nowrap">{t.resalesPrice}</Th>
                  <Th className="w-px whitespace-nowrap">{t.resalesListedOn}</Th>
                  <Th className="w-px whitespace-nowrap text-end">{t.statusCol}</Th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id} className={r.status === "CANCELLED" ? "opacity-55" : undefined}>
                    <Td>{eventText({ titleFr: r.eventTitleFr, titleAr: r.eventTitleAr }, "title", locale)}</Td>
                    {maySeeAllOrganisers ? (
                      <Td>
                        {/* Null when the owner's account was deleted: said
                            out loud, because a blank cell here reads as a
                            loading bug rather than a fact. */}
                        {r.organiser ? (
                          <PersonCell name={r.organiser.name} sub={r.organiser.email} />
                        ) : (
                          <span className="text-xs text-muted">{t.ownerGone}</span>
                        )}
                      </Td>
                    ) : null}
                    <Td>
                      {eventText({ nameFr: r.tierNameFr, nameAr: r.tierNameAr }, "name", locale)}
                      {r.seatRow ? ` · ${r.seatRow}${r.seatNumber ?? ""}` : ""}
                    </Td>
                    <Td className="w-px whitespace-nowrap font-mono text-xs">{r.ticketRef}</Td>
                    <Td className="w-px whitespace-nowrap tabular-nums">{money(r.priceCents)} MAD</Td>
                    <Td className="w-px whitespace-nowrap text-xs text-muted">
                      {new Date(r.createdAt).toLocaleDateString(intlLocaleTag(locale), { dateStyle: "medium" })}
                    </Td>
                    <Td className="w-px whitespace-nowrap text-end">
                      <Badge tone={TONE[r.status] ?? "neutral"}>
                        {r.status === "SOLD" ? t.resalesStatusSold : r.status === "LISTED" ? t.resalesStatusListed : t.resalesStatusCancelled}
                      </Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </div>
        </>
      )}
    </>
  );
}
