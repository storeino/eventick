import { useEffect, useMemo, useState } from "react";
import { Info, Landmark, Lock, Percent, Ticket, Undo2, Wallet } from "lucide-react";
import { toast } from "sonner";
import { api, money } from "../../api";
import { useI18n } from "../../i18n";
import { useOrganisers } from "./useOrganisers";
import { Card, EmptyState, PageHead, SectionTitle, StatCard, StatSkeletons } from "./ui";
import { Button, Dropdown, Field, Input, PeriodPicker, RevenueBars, deltaPct, triggerControlClass } from "../../ui";
import { cn, eventText, intlLocaleTag } from "../../utils";
import { text } from "./copy";

/**
 * Finance — what came in, what Eventick took, and what is owed.
 *
 * Every figure here used to be computed in this file: the organiser picked a
 * plan from a row of buttons, `planCost()` ran in the browser, and nothing was
 * stored. So the commission changed when you clicked a different button, reset
 * on reload, and matched no charge anyone would ever make. Revenue was also
 * the sum of PAID orders' totals, which counted refunded money as earnings.
 *
 * Now the server owns all of it. The plan is read-only because an admin
 * assigns it, the fee was recorded on each order when it was paid, and revenue
 * is net of refunds. This screen only renders and explains.
 */

const RATE = (bps) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

export default function Finance() {
  const { locale } = useI18n();
  const t = text[locale];
  const { maySeeAllOrganisers, organisers } = useOrganisers();
  const [orders, setOrders] = useState(null);
  const [finance, setFinance] = useState(null);
  const [payouts, setPayouts] = useState(null);
  const [organiserId, setOrganiserId] = useState("");
  /*
   * Defaults to this month, not all time.
   *
   * Lifetime is the figure you check once; "how is this month going" is the
   * one someone opens a dashboard for. The lifetime totals are still on the
   * screen -- the payout card carries them -- so nothing is hidden by this.
   */
  const [period, setPeriod] = useState("month");
  /** In flight, so the button cannot be pressed twice. */
  const [planBusy, setPlanBusy] = useState(false);
  /*
   * Which question is being asked.
   *
   * One scroll answered three unrelated ones -- how are sales going, where
   * does my money go and when did it arrive, and what am I being charged --
   * with the bank form wedged between the plan and the payout list. The
   * RIB in particular is the thing an organiser comes here to fix after
   * being told a payout cannot be sent, and it was the hardest thing on the
   * page to find.
   *
   * Split by question, not by data source: "Versements" holds the account
   * AND the history, because "where is my money" is one question even
   * though it reads from two endpoints.
   */
  const [tab, setTab] = useState("revenue");

  useEffect(() => {
    const params = new URLSearchParams();
    if (organiserId) params.set("organiserId", organiserId);
    const suffix = params.toString() ? `?${params}` : "";
    setFinance(null);
    setPayouts(null);
    api.get(`/organiser/orders/detailed${suffix}`).then((data) => setOrders(data.orders));
    // The period only narrows the money figures, so only this call carries
    // it: the order table and the payout list are not period-scoped.
    api.get(`/organiser/finance${suffix}${suffix ? "&" : "?"}period=${period}`).then(setFinance);
    api.get(`/organiser/payouts${suffix}`).then((data) => setPayouts(data.payouts));
  }, [organiserId, period]);

  // Per-event rows stay client-side: this is a breakdown of orders already
  // fetched for the table, not a money figure anyone is charged on.
  const byEvent = useMemo(() => {
    const map = new Map();
    for (const order of orders ?? []) {
      for (const ticket of order.tickets) {
        if (ticket.status === "CANCELLED") continue;
        const current = map.get(ticket.event.slug) ?? {
          slug: ticket.event.slug,
          title: eventText(ticket.event, "title", locale),
          image: ticket.event.image,
          city: ticket.event.city,
          gross: 0,
          tickets: 0,
        };
        current.gross += ticket.priceCents;
        current.tickets += 1;
        map.set(ticket.event.slug, current);
      }
    }
    return [...map.values()].sort((a, b) => b.gross - a.gross);
  }, [orders, locale]);

  const lifetime = finance?.lifetime;
  const pending = finance?.pending;
  /*
   * The figures for the chosen period.
   *
   * Falls back to `lifetime` while the response is in flight, so switching
   * period re-renders with the old numbers rather than flashing zeros — and
   * on an older server that does not send `period` at all, the screen still
   * works and simply shows lifetime.
   */
  const span = finance?.period ?? lifetime;

  const periodLabels = {
    ariaLabel: t.periodLabel,
    today: t.periodToday,
    week: t.periodWeek,
    month: t.periodMonth,
    lastMonth: t.periodLastMonth,
    year: t.periodYear,
    all: t.periodAll,
  };

  /*
   * A direction, not just a number.
   *
   * deltaPct returns null where a percentage would mislead — no previous
   * period, or a previous period of zero, where "up ∞%" is a first sale
   * rather than a trend. Returning undefined then leaves the card with no
   * trend chip at all, which is the honest rendering.
   */
  /** A request waiting on an admin, or null. */
  const requested = finance?.planRequest ?? null;

  /*
   * Ask for a plan, or withdraw the ask.
   *
   * Both reload finance rather than patching state locally: the server
   * decides whether a request was accepted (one open at a time, not the plan
   * you are already on), so re-reading is the only way the screen is sure to
   * match it.
   */
  const reloadFinance = () =>
    api.get(`/organiser/finance?period=${period}`).then(setFinance).catch(() => {});

  const requestPlan = async (planKey) => {
    if (planBusy) return;
    setPlanBusy(true);
    try {
      await api.post("/organiser/plan-request", { planKey });
      await reloadFinance();
      toast.success(t.planRequestSent);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setPlanBusy(false);
    }
  };

  const withdrawPlan = async () => {
    if (planBusy) return;
    setPlanBusy(true);
    try {
      await api.del("/organiser/plan-request");
      await reloadFinance();
      toast.success(t.planRequestWithdrawn);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setPlanBusy(false);
    }
  };

  const trendFor = (current, previous) => {
    const pct = deltaPct(current, previous);
    if (pct === null) return undefined;
    return { dir: pct > 0 ? "up" : pct < 0 ? "down" : "flat", text: `${pct > 0 ? "+" : ""}${pct}%` };
  };

  return (
    <div>
      <PageHead
        title={t.finance}
        sub={t.financeSub}
        actions={
          maySeeAllOrganisers ? (
            /* Dropdown, not a native <select>: the browser's popup ignores
               the app's theme and opens as a light list over dark chrome. */
            <span className="flex flex-col gap-1.5" style={{ width: 200 }}>
              <span id="fin-organiser-label" className="ps-0.5 text-[11px] font-bold uppercase tracking-wide text-muted">
                {t.allOrganisers}
              </span>
              <Dropdown
                labelledBy="fin-organiser-label"
                label={t.allOrganisers}
                value={organiserId}
                onChange={setOrganiserId}
                options={[
                  { value: "", label: t.allOrganisers },
                  ...organisers.map((o) => ({ value: o.id, label: o.name })),
                ]}
                triggerClassName={triggerControlClass({})}
              />
            </span>
          ) : null
        }
      />

      {/* Pills, matching /pro/platform and /billets rather than adding a
          third tab idiom to the app. */}
      <div className="scroll-none mb-5 flex gap-2 overflow-x-auto" role="tablist">
        {[
          ["revenue", t.finTabRevenue, 0],
          // A missing RIB is the one thing here that BLOCKS money, so it is
          // the one thing the tabs flag. Only for the organiser's own page:
          // an admin reading someone else's finances is not the person who
          // can fix it, and readOnly already hides the form from them.
          ["payouts", t.finTabPayouts, !organiserId && finance && !finance.bankAccount ? 1 : 0],
          ["plan", t.finTabPlan, 0],
        ].map(([id, label, flag]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={cn(
              "h-11 shrink-0 rounded-full px-4 text-sm font-semibold transition",
              tab === id ? "bg-action text-action-fg" : "bg-card text-ink hover:bg-brume",
            )}
            onClick={() => setTab(id)}
          >
            {label}
            {flag ? (
              <span
                className={cn(
                  "ms-2 rounded-full px-2 py-0.5 text-xs font-bold",
                  tab === id ? "bg-action-fg/20 text-action-fg" : "bg-warn-bg text-warn",
                )}
              >
                !
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {/* ── REVENUS: how are sales going ───────────────────────────────── */}
      {tab === "revenue" ? (
      <>
      {/* Inside the tab, not above it: the period narrows the revenue
          figures only -- the payout list and the plan are not scoped by it,
          so a picker floating over all three would claim otherwise. */}
      <PeriodPicker value={period} onChange={setPeriod} labels={periodLabels} className="mb-4" />

      {/*
        The four figures that matter, in the order they happen: money in,
        refunds out, our cut, their share.

        The first three follow the PERIOD; the fourth does not. "To be paid
        out" is settled against every outstanding order, so narrowing it to a
        month would show a figure that is not what the next transfer pays —
        its sub-line says "all time" so the mismatch is stated rather than
        left to be noticed.
      */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {!lifetime ? (
          <StatSkeletons count={4} />
        ) : (
          <>
            <StatCard
              accent
              icon={<Wallet className="size-5" />}
              label={t.netRevenue}
              value={`${money(span.netRevenueCents)} MAD`}
              sub={`${t.gross} ${money(span.grossCents)} MAD`}
              trend={trendFor(span.netRevenueCents, span.previous?.netRevenueCents)}
            />
            <StatCard
              icon={<Undo2 className="size-5" />}
              label={t.refundedLabel}
              value={`${money(span.refundedCents)} MAD`}
              sub={span.orders > 0 ? t.ordersInPeriod.replace("{n}", String(span.orders)) : undefined}
            />
            <StatCard
              icon={<Percent className="size-5" />}
              label={t.fee}
              value={`${money(span.feeCents)} MAD`}
              sub={finance.plan ? `${finance.plan.label} · ${RATE(finance.plan.rateBps)}` : undefined}
            />
            <StatCard
              icon={<Landmark className="size-5" />}
              label={t.payable}
              value={`${money(pending?.payableCents ?? 0)} MAD`}
              sub={`${t.allTime} · ${t.paidOut} ${money(finance.paidOutCents)} MAD`}
            />
          </>
        )}
      </div>

      {/* Hidden for "all time", which has no start to bucket from. */}
      {finance?.period?.series?.length ? (
        <Card className="mt-4">
          <p className="text-[11px] font-bold uppercase tracking-wide text-muted">{t.revenueOverTime}</p>
          <RevenueBars
            className="mt-3"
            series={finance.period.series}
            labels={{ empty: t.noSalesInPeriod, chartAlt: t.revenueOverTime }}
            formatAmount={(cents) => `${money(cents)} MAD`}
            formatDate={(iso) =>
              new Date(iso).toLocaleDateString(intlLocaleTag(locale), { day: "numeric", month: "short" })
            }
          />
        </Card>
      ) : null}

      <SectionTitle>{t.perEvent}</SectionTitle>
      {orders && byEvent.length === 0 ? (
        <EmptyState icon="💰" title={t.empty} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {byEvent.map((row) => (
            <article key={row.slug} className="flex min-w-0 items-center gap-3 rounded-card border border-line/10 bg-card p-4 shadow-card">
              <img src={row.image} alt="" className="size-12 shrink-0 rounded-control object-cover" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold">{row.title}</p>
                <p className="truncate text-xs text-muted">{row.city}</p>
                <p className="mt-1 flex items-center gap-1 text-xs font-semibold text-muted">
                  <Ticket className="size-3.5" aria-hidden />
                  {row.tickets}
                </p>
              </div>
              <p className="shrink-0 text-end">
                <span className="block font-display text-subhead font-bold tabular-nums">{money(row.gross)}</span>
                <span className="block text-[11px] font-semibold text-muted">MAD</span>
              </p>
            </article>
          ))}
        </div>
      )}
      </>
      ) : null}

      {/* ── FORMULE: what am I being charged ───────────────────────────── */}
      {tab === "plan" ? (
      <>
      {/* Plan — read-only. It used to be three buttons that changed the fee
          on screen and nothing in the world. */}
      <SectionTitle>{t.plan}</SectionTitle>
      {finance?.plan ? (
        <Card>
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-full bg-brume px-3 py-1.5 text-sm font-bold text-primary">
              <Lock className="size-3.5 shrink-0" aria-hidden />
              {finance.plan.label}
            </span>
            <span className="text-sm font-semibold tabular-nums">
              {RATE(finance.plan.rateBps)}
              {finance.plan.monthlyCents > 0
                ? ` + ${t.subscriptionMonthly.replace("{amount}", money(finance.plan.monthlyCents))}`
                : ""}
            </span>
            <span className="text-xs text-muted">{finance.plan.assigned ? t.planAssigned : t.planDefault}</span>
          </div>

          {/* The fixed monthly part used to be printed on the plan and never
              charged, which made Pro cheaper than Starter at every volume. It
              is withheld from the payout now, so the card says where it goes
              and how much has actually been taken. */}
          {finance.subscription?.monthlyCents > 0 ? (
            <p className="mt-3 text-xs text-muted">
              <span className="font-semibold text-ink">{t.subscription}:</span> {t.subscriptionOnPayout}
              {finance.subscription.billedMonths > 0
                ? ` · ${t.subscriptionBilled
                    .replace("{amount}", money(finance.subscription.billedCents))
                    .replace("{n}", String(finance.subscription.billedMonths))}`
                : ""}
            </p>
          ) : (
            <p className="mt-3 text-xs text-muted">{t.subscriptionNone}</p>
          )}

          <p className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-muted">
            <Info className="mt-px size-3.5 shrink-0" aria-hidden />
            {t.planNote}
          </p>

          {/*
            The nudge, and only when their own figures justify it.

            Nobody is asked to choose a plan at signup — the tiers differ by
            break-even volume and a new organiser cannot know which side they
            are on. This is the same question asked once the answer is in
            their own books, measured over the last CLOSED month so a
            part-month's sales are never weighed against a whole month's fee.

            It works downwards too: an organiser whose volume fell is told
            they have outgrown a plan in the other direction.
          */}
          {finance.planAdvice && !organiserId ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-control border border-success/30 bg-success-bg/40 px-3 py-2.5">
              <p className="text-xs leading-relaxed">
                {t.planAdvice
                  .replace("{plan}", finance.planAdvice.planLabel)
                  .replace("{saves}", money(finance.planAdvice.savesCents))
                  .replace("{volume}", money(finance.planAdvice.basedOnCents))}
              </p>
              <Button
                variant="ghost"
                onClick={() => requestPlan(finance.planAdvice.planKey)}
                disabled={planBusy}
                className="shrink-0"
              >
                {t.planRequest}
              </Button>
            </div>
          ) : null}

          {/*
            What the other tiers cost.
            An organiser was shown their own rate and nothing else, so someone
            on Starter's 5% had no way to learn that Pro charges 3% — the
            cheaper plans existed, nobody was on one, and there was no moment
            at which anyone would find out. Changing plan stays an admin
            action; this is only what makes it worth asking about.
          */}
          {(finance.plans ?? []).length > 1 ? (
            <div className="mt-4 border-t border-line/10 pt-3">
              <p className="text-[11px] font-bold uppercase tracking-wide text-muted">{t.planCompare}</p>
              <ul className="mt-2 grid gap-1.5">
                {finance.plans.map((row) => (
                  <li
                    key={row.key}
                    className={cn(
                      "flex flex-wrap items-center justify-between gap-2 rounded-control px-2.5 py-1.5 text-sm",
                      row.current ? "bg-brume font-bold text-primary" : "text-muted",
                    )}
                  >
                    <span>
                      {row.label}
                      {row.current ? ` · ${t.planCurrent}` : ""}
                    </span>
                    <span className="flex items-center gap-3">
                      <span className="tabular-nums">
                        {RATE(row.rateBps)}
                        {row.monthlyCents > 0
                          ? ` + ${t.subscriptionMonthly.replace("{amount}", money(row.monthlyCents))}`
                          : ""}
                      </span>
                      {/*
                        Asking is the only action available: an organiser who
                        could switch themselves would take 2% and never pay
                        the subscription that buys it, since the monthly fee
                        is withheld from payouts and someone with no payouts
                        pays nothing.

                        Hidden on the current plan, hidden for an admin
                        viewing someone else's books through the filter
                        (the request would be recorded against the ADMIN),
                        and replaced by its own state once asked.
                      */}
                      {!row.current && !organiserId ? (
                        requested?.planKey === row.key ? (
                          <button
                            type="button"
                            onClick={withdrawPlan}
                            className="shrink-0 text-xs font-bold text-muted underline decoration-dotted underline-offset-4 hover:text-danger"
                          >
                            {t.planRequested} · {t.planWithdraw}
                          </button>
                        ) : requested ? null : (
                          <Button variant="ghost" onClick={() => requestPlan(row.key)} disabled={planBusy}>
                            {t.planRequest}
                          </Button>
                        )
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs leading-relaxed text-muted">{t.planCompareNote}</p>
            </div>
          ) : null}
        </Card>
      ) : null}

      </>
      ) : null}

      {/* ── VERSEMENTS: where does my money go, and when did it arrive ───
          The account and the history together: two endpoints, one
          question. The RIB form leads, because an organiser sent here by
          "no bank details on file" is here to fill it in. */}
      {tab === "payouts" ? (
      <>
      <BankPanel t={t} current={finance?.bankAccount ?? null} readOnly={Boolean(organiserId)} />

      <SectionTitle>{t.payoutsTitle}</SectionTitle>
      {payouts && payouts.length === 0 ? (
        <EmptyState icon="🏦" title={t.payoutsEmpty} />
      ) : (
        <div className="grid gap-3">
          {(payouts ?? []).map((row) => (
            <PayoutRow key={row.id} row={row} t={t} locale={locale} />
          ))}
        </div>
      )}
      </>
      ) : null}
    </div>
  );
}

const STATUS_TONE = {
  PENDING: "bg-warn-bg text-warn",
  PAID: "bg-success-bg text-success",
  CANCELLED: "bg-sunken text-muted",
};

function PayoutRow({ row, t, locale }) {
  const label = { PENDING: t.payoutPending, PAID: t.payoutPaid, CANCELLED: t.payoutCancelled }[row.status] ?? row.status;
  // Through intlLocaleTag, not a hand-written conditional: every place that
  // wrote one of those out sent English to a French formatter at least once.
  const fmt = (iso) => new Date(iso).toLocaleDateString(intlLocaleTag(locale));

  return (
    <article className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-card border border-line/10 bg-card p-4 shadow-card">
      <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide", STATUS_TONE[row.status])}>
        {label}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold tabular-nums">
          {money(row.netCents)} MAD
          <span className="ms-2 text-xs font-semibold text-muted">
            ({t.gross} {money(row.grossCents)} − {t.fee} {money(row.feeCents)}
            {/* Shown only when non-zero: a month already billed by an earlier
                run deducts nothing, and a 0.00 line would read as a mistake. */}
            {row.subscriptionCents > 0 ? ` − ${t.subscription} ${money(row.subscriptionCents)}` : ""})
          </span>
        </p>
        <p className="mt-0.5 text-xs text-muted">
          {t.payoutPeriod} {fmt(row.periodStart)} → {fmt(row.periodEnd)} · {row.orders} {t.payoutOrders}
          {row.subscriptionMonths?.length ? ` · ${row.subscriptionMonths.map((m) => m.month).join(", ")}` : ""}
          {row.reference ? ` · ${t.payoutRef} ${row.reference}` : ""}
        </p>
        {/* Only an admin looking at every organiser gets this field, and
            there "4 132,50 MAD" alone does not say who received it. */}
        {row.organiser ? (
          <p className="mt-0.5 text-xs font-semibold text-muted">{row.organiser.name}</p>
        ) : null}
      </div>
    </article>
  );
}

/**
 * Bank details.
 *
 * The organiser owns this — it is their account, and an admin retyping
 * someone else's RIB is a worse place for a typo. Read-only when an admin is
 * viewing another organiser through the ?organiserId= switch, because saving
 * would silently write the admin's own details.
 */
function BankPanel({ t, current, readOnly }) {
  const [holderName, setHolderName] = useState("");
  const [rib, setRib] = useState("");
  const [bank, setBank] = useState("");
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const onFile = saved ?? current;

  /*
   * Load what is on file into the form.
   *
   * The fields sat empty even with an account saved, so correcting a
   * misspelled holder name or adding the bank meant retyping everything from
   * the summary line above — and leaving a field blank would have saved it
   * blank.
   *
   * The RIB is deliberately NOT prefilled: the server returns only its last
   * four digits, because a screen showing earnings has no reason to hand back
   * a full payment credential. So it is the one field that must be retyped,
   * and the hint below says so rather than leaving it looking broken.
   */
  useEffect(() => {
    setHolderName(current?.holderName ?? "");
    setBank(current?.bank ?? "");
  }, [current?.holderName, current?.bank]);

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    const digits = rib.replace(/[\s-]/g, "");
    if (!/^\d{24}$/.test(digits)) {
      setError(t.bankBadRib);
      return;
    }
    setError("");
    setBusy(true);
    try {
      const result = await api.put("/organiser/bank-account", { holderName: holderName.trim(), rib: digits, bank: bank.trim() });
      setSaved(result);
      setRib("");
      toast.success(t.bankSaved);
    } catch (err) {
      toast.error(err.message || t.bankBadRib);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SectionTitle>{t.account}</SectionTitle>
      <Card>
        <p className="text-sm font-bold">{t.bankTitle}</p>
        <p className="mt-1 text-xs text-muted">{t.bankSub}</p>

        <p className="mt-3 text-sm">
          {onFile ? (
            <span className="font-semibold text-success">
              {t.bankOnFile} · {onFile.holderName} · **** {onFile.ribLast4}
              {onFile.bank ? ` · ${onFile.bank}` : ""}
            </span>
          ) : (
            <span className="font-semibold text-danger">{t.bankMissing}</span>
          )}
        </p>

        {readOnly ? null : (
          <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label={t.bankHolder} required>
              {(props) => <Input {...props} value={holderName} onChange={(e) => setHolderName(e.target.value)} autoComplete="name" />}
            </Field>
            <Field label={t.bankName}>
              {(props) => <Input {...props} value={bank} onChange={(e) => setBank(e.target.value)} placeholder="CIH, Attijariwafa…" />}
            </Field>
            <Field
              label={t.bankRib}
              error={error}
              required
              className="sm:col-span-2"
              // Only when something is already saved: on a first setup there
              // is nothing to re-enter and the hint would be noise.
              hint={onFile ? t.bankRibRetype : undefined}
            >
              {(props) => (
                <Input
                  {...props}
                  value={rib}
                  onChange={(e) => setRib(e.target.value)}
                  inputMode="numeric"
                  placeholder="1234 5678 9012 3456 7890 1234"
                  // The RIB is a payment credential: keep it out of the
                  // browser's autofill store and off password managers.
                  autoComplete="off"
                />
              )}
            </Field>
            <div className="sm:col-span-2">
              <Button type="submit" disabled={busy || holderName.trim().length < 3 || !rib}>
                {t.bankSave}
              </Button>
            </div>
          </form>
        )}
      </Card>
    </>
  );
}
