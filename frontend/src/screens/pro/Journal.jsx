import { useCallback, useEffect, useState } from "react";
import { ScrollText, ShieldAlert } from "lucide-react";
import { api, money } from "../../api";
import { useI18n } from "../../i18n";
import { Btn, EmptyState, PageHead } from "./ui";
import { Dropdown, triggerControlClass } from "../../ui";
import { text } from "./copy";

/**
 * The journal — who did what, and when.
 *
 * Fourteen privileged routes could change a role, grant a permission, refund
 * money, assign a commission plan or send a payout, and none of them left a
 * record. "It just changed" is not an answer anyone can act on.
 *
 * Deliberately not a general activity feed. Only actions somebody should be
 * able to account for appear here; a log that records everything is one nobody
 * reads, and the value of each row is that it names a decision.
 */

/** Human label for an action key, falling back to the raw key. */
function labelFor(t, action) {
  // "order.refunded" -> "act_order_refunded", which is how the copy is keyed.
  return t[`act_${action.replace(/\./g, "_")}`] ?? action;
}

/**
 * The parts of `details` worth showing inline.
 *
 * Rendered per-action rather than dumped as JSON: the shape differs by action,
 * and a raw object is exactly the kind of thing nobody reads. Anything not
 * handled here simply does not show — the row still says who and what.
 */
function describe(t, event) {
  const d = event.details ?? {};
  switch (event.action) {
    case "user.role.changed":
      return `${d.from} → ${d.to}`;
    case "user.created":
      return d.role ?? null;
    case "role.permission.granted":
    case "role.permission.revoked":
      return d.permission ?? null;
    case "organiser.plan.assigned":
      return `${d.from ?? t.plPlanDefault} → ${d.to ?? t.plPlanDefault}`;
    case "order.refunded":
      return `${money(d.refundedCents ?? 0)} MAD${d.full ? "" : " ·"}`;
    case "order.refund.reconciled":
      return `${money(d.amountRefundedCents ?? 0)} MAD`;
    case "payout.created":
      return `${money(d.netCents ?? 0)} MAD · ${d.orders ?? 0} ${t.payoutOrders}`;
    case "payout.paid":
      return d.reference ?? null;
    case "bank_account.changed":
      // Last four only — the full RIB is a payment credential.
      return d.ribLast4 ? `**** ${d.ribLast4}` : null;
    case "organiser.application.decided":
      return d.status ?? null;
    default:
      return null;
  }
}

const PAGE = 50;

export default function Journal() {
  const { locale } = useI18n();
  const t = text[locale];
  const [events, setEvents] = useState(null);
  const [actions, setActions] = useState([]);
  const [action, setAction] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);

  const load = useCallback(
    (before) => {
      const params = new URLSearchParams({ limit: String(PAGE) });
      if (action) params.set("action", action);
      if (before) params.set("before", before);
      return api.get(`/platform/audit?${params.toString()}`);
    },
    [action],
  );

  useEffect(() => {
    setEvents(null);
    setExhausted(false);
    load()
      .then((data) => {
        setEvents(data.events);
        setActions(data.actions ?? []);
        setExhausted(data.events.length < PAGE);
      })
      .catch(() => setEvents([]));
  }, [load]);

  /** Keyset pagination on `at`: the journal only grows, so an offset would
   * skip or repeat rows as new ones land while someone is reading. */
  const more = async () => {
    if (loadingMore || !events?.length) return;
    setLoadingMore(true);
    try {
      const data = await load(events[events.length - 1].at);
      setEvents((prev) => [...prev, ...data.events]);
      if (data.events.length < PAGE) setExhausted(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const when = (iso) =>
    new Date(iso).toLocaleString(locale === "ar" ? "ar-MA" : locale === "en" ? "en-GB" : "fr-MA", {
      dateStyle: "medium",
      timeStyle: "short",
    });

  return (
    <div>
      <PageHead
        title={t.journal}
        sub={t.journalSub}
        actions={
          /* Dropdown, not a native <select>: the browser's popup ignores
             the app's theme and opens as a light list over dark chrome. */
          <span className="flex flex-col gap-1.5" style={{ width: 220 }}>
            <span id="journal-action-label" className="ps-0.5 text-[11px] font-bold uppercase tracking-wide text-muted">
              {t.journalAll}
            </span>
            <Dropdown
              labelledBy="journal-action-label"
              label={t.journalAll}
              value={action}
              onChange={setAction}
              options={[
                { value: "", label: t.journalAll },
                ...actions.map((key) => ({ value: key, label: labelFor(t, key) })),
              ]}
              triggerClassName={triggerControlClass({})}
            />
          </span>
        }
      />

      {events && events.length === 0 ? (
        <EmptyState icon={<ScrollText className="size-6" />} title={t.journalEmpty} />
      ) : (
        <div className="grid gap-2">
          {(events ?? []).map((event) => {
            const detail = describe(t, event);
            return (
              /* A stack on a phone, one row from sm up.

                  Four columns fighting over a 328px line is what broke
                  this. The subject carries flex-1 -- basis 0, so it takes
                  only what the other three leave -- and at phone width that
                  was about 30px, which turned a long email into a vertical
                  ladder of single characters. Wrapping is not the fix when
                  the box itself has collapsed; the columns have to stop
                  sharing a line. From sm they do share one again, and the
                 11rem label floor lines them into a column as before. */
              <article
                key={event.id}
                className="flex min-w-0 flex-col gap-1 rounded-card border border-line/10 bg-card px-4 py-3 shadow-card sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4 sm:gap-y-1"
              >
                <span className="text-sm font-bold sm:min-w-44">{labelFor(t, event.action)}</span>

                {/* break-words, not break-all: with a real column to sit in
                    this wraps at the punctuation in an address rather than
                    mid-word, and ordinary labels read normally. */}
                <span className="min-w-0 break-words text-sm text-muted sm:flex-1">
                  {event.subject.label ?? event.subject.id ?? "—"}
                  {detail ? <span className="ms-2 font-semibold text-ink">{detail}</span> : null}
                </span>

                {/* The actor, and whether their account still exists. Saying
                    so stops a detached row reading as a live account that
                    cannot be found. No shrink-0: a guest-share address is
                    40 characters with nothing to break on, and pinning it
                    set the floor for the whole row. */}
                <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted">
                  {t.journalBy}
                  <span className="break-words font-semibold text-ink">{event.actor.email}</span>
                  {event.actor.deleted ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide">
                      <ShieldAlert className="size-3" aria-hidden />
                      {t.journalDeletedActor}
                    </span>
                  ) : null}
                </span>

                <time className="shrink-0 text-xs tabular-nums text-muted" dateTime={event.at}>
                  {when(event.at)}
                </time>
              </article>
            );
          })}
        </div>
      )}

      {events?.length && !exhausted ? (
        <div className="mt-4 flex justify-center">
          <Btn variant="secondary" loading={loadingMore} onClick={more}>
            {t.journalMore}
          </Btn>
        </div>
      ) : null}
    </div>
  );
}
