import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowDownRight, ArrowUpRight, CalendarDays, Landmark, Minus, ReceiptText, Users as UsersIcon, Wallet } from "lucide-react";
import { toast } from "sonner";
import { api, money } from "../../api";
import { useI18n } from "../../i18n";
import { cn, eventText } from "../../utils";
import { Badge, Button, Dropdown, Field, Input, Modal, triggerControlClass } from "../../ui";
import { EmptyState, PageHead, SectionTitle, StatCard, StatSkeletons } from "./ui";
import { text } from "./copy";

/**
 * The platform console — the marketplace, not one organiser's events.
 *
 * An admin's Pilotage was an ORGANISER dashboard with bigger numbers: the
 * same encaissé / billets / entrées tiles, summed across everyone because
 * scope.any widens the query. That answers "how are my events doing", which
 * an admin does not have. It never answered how many organisers exist,
 * whether anyone is waiting for approval, how many have never sold anything,
 * or whether refunds are climbing.
 */
export default function Platform() {
  const { locale } = useI18n();
  const t = text[locale];
  const [stats, setStats] = useState(null);
  const [sellers, setSellers] = useState(null);
  const [plans, setPlans] = useState([]);
  const [payouts, setPayouts] = useState(null);
  /** The organiser a payout is being prepared for, or null. */
  const [running, setRunning] = useState(null);
  /*
   * How to rank the sellers.
   *
   * The list arrived sorted by lifetime revenue and could not be reordered,
   * so "who is waiting on money" and "who is refunding the most" were both
   * unanswerable without reading every row. Sorted in the browser: the rows
   * are already loaded, and a round trip per click would be slower for no
   * gain at the scale of one platform's organisers.
   */
  const [sortBy, setSortBy] = useState("revenue");
  /*
   * Which half of the marketplace is being looked at.
   *
   * This console pays two different people out of two different pots, and
   * they were stacked on one scrolling page: a CLIENT is owed a resale
   * refund the platform is holding, an ORGANISER is owed takings minus the
   * fee. The amounts look alike and the buttons are both "mark it sent",
   * so the one screen invited paying the wrong person from the wrong
   * ledger -- and the queue an admin opens this page for sat above a seller
   * table it has nothing to do with.
   *
   * Split by WHO IS PAID rather than by feature, because that is the
   * decision being made. Overview keeps the numbers that describe the
   * marketplace as a whole and belong to neither side.
   */
  const [tab, setTab] = useState("overview");
  /** Organisers asking to move onto a different plan. */
  const [planRequests, setPlanRequests] = useState([]);
  /*
   * Refunds decided but not yet SENT.
   *
   * CMI has no refund API, so refundOrder voids the tickets, records the
   * decision and emails the buyer — the money itself is moved by a person
   * in the CMI back office. Until now nothing listed what was outstanding,
   * so a buyer owed money depended on somebody remembering.
   */
  const [refunds, setRefunds] = useState({ refunds: [], totalCents: 0 });
  /** The refund being marked paid, and the reference being typed. */
  const [refundRow, setRefundRow] = useState(null);
  const [refundRef, setRefundRef] = useState("");

  const loadSellers = useCallback(() => {
    api
      .get("/platform/organisers")
      .then((data) => setSellers(data.organisers))
      .catch(() => setSellers([]));
  }, []);
  const loadPlanRequests = useCallback(() => {
    api
      .get("/platform/plan-requests")
      .then((data) => setPlanRequests(data.requests))
      .catch(() => setPlanRequests([]));
  }, []);
  const loadRefunds = useCallback(() => {
    api
      .get("/platform/refunds/pending")
      .then(setRefunds)
      .catch(() => setRefunds({ refunds: [], totalCents: 0 }));
  }, []);
  const loadPayouts = useCallback(() => {
    api
      .get("/platform/payouts")
      .then((data) => setPayouts(data.payouts))
      .catch(() => setPayouts([]));
  }, []);

  useEffect(() => {
    api.get("/platform/stats").then(setStats).catch(() => setStats(null));
    api.get("/platform/plans").then((data) => setPlans(data.plans)).catch(() => setPlans([]));
    loadSellers();
    loadPayouts();
    loadPlanRequests();
    loadRefunds();
  }, [loadSellers, loadPayouts, loadPlanRequests, loadRefunds]);

  /*
   * Decide one. Approving assigns the plan server-side, so the seller list is
   * reloaded too -- its rate column would otherwise still show the old plan.
   */
  const decidePlan = async (id, approve) => {
    try {
      await api.post(`/platform/plan-requests/${id}/decide`, { approve });
      toast.success(approve ? t.plPlanSaved : t.plDeclined);
      loadPlanRequests();
      loadSellers();
    } catch (err) {
      toast.error(err.message);
    }
  };

  /** Move an organiser onto a plan. Affects future orders only. */
  const assignPlan = async (sellerId, planKey) => {
    try {
      await api.patch(`/platform/organisers/${sellerId}/plan`, { planKey: planKey || null });
      toast.success(t.plPlanSaved);
      loadSellers();
    } catch (err) {
      toast.error(err.message);
    }
  };

  /*
   * Ranked by whichever question is being asked.
   *
   * Every comparison falls back to revenue, so rows that tie on the chosen
   * measure — and with "owed", most of them will be zero — keep a stable,
   * meaningful order instead of shuffling.
   */
  const sortedSellers = useMemo(() => {
    const rows = [...(sellers ?? [])];
    const byRevenue = (a, b) => b.grossCents - a.grossCents;
    const compare = {
      revenue: byRevenue,
      owed: (a, b) => (b.owedCents ?? 0) - (a.owedCents ?? 0) || byRevenue(a, b),
      refunds: (a, b) => (b.refundRateBp ?? 0) - (a.refundRateBp ?? 0) || byRevenue(a, b),
      events: (a, b) => b.events - a.events || byRevenue(a, b),
    }[sortBy];
    return rows.sort(compare ?? byRevenue);
  }, [sellers, sortBy]);

  const revenue = stats?.revenue;
  // Percentage change week on week. Guarded because the first week has no
  // previous week to compare against, and x/0 would render "Infinity%".
  const weekDelta =
    revenue && revenue.prevWeekCents > 0
      ? Math.round(((revenue.thisWeekCents - revenue.prevWeekCents) / revenue.prevWeekCents) * 100)
      : null;

  /*
   * Record that the money actually left.
   *
   * The reference is required by the server and asked for rather than
   * generated: it is the CMI or bank reference for the reversal, and the
   * only way anyone can later check the books against reality. A generated
   * one would look like proof and prove nothing.
   *
   * A Modal, not window.prompt — the native one cannot be translated,
   * announces the origin ("localhost:3100 says"), and is suppressed
   * outright by some browsers, which here would mean a refund silently
   * marked paid or silently not.
   */
  const submitRefundPaid = async (event) => {
    event.preventDefault();
    const reference = refundRef.trim();
    if (!refundRow || reference.length < 3) {
      toast.error(t.plRefundRefTooShort);
      return;
    }
    try {
      await api.post(`/platform/refunds/${refundRow.orderId}/paid`, { reference });
      toast.success(t.plRefundMarked);
      setRefundRow(null);
      loadRefunds();
    } catch (err) {
      toast.error(err.message);
    }
  };

  /* Counts on the tabs, so an admin can see there is something waiting
     without opening each one. Only outstanding WORK is counted -- the
     number of organisers is not a to-do, so Organisateurs counts what is
     actually queued there (payouts to action, plan requests to decide). */
  const clientTodo = refunds.refunds.length;
  const organiserTodo =
    (payouts ?? []).filter((row) => row.status === "PENDING").length + planRequests.length;

  const TABS = [
    ["overview", t.plTabOverview, 0],
    ["clients", t.plTabClients, clientTodo],
    ["organisers", t.plTabOrganisers, organiserTodo],
  ];

  return (
    <div>
      <PageHead title={t.platform} sub={t.platformSub} />

      {/* Pills rather than underlines, matching the account tabs on
          /billets -- this app has one tab idiom and a second one here
          would just be a second thing to learn. */}
      <div className="scroll-none mb-5 flex gap-2 overflow-x-auto" role="tablist">
        {TABS.map(([id, label, count]) => (
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
            {count > 0 ? (
              <span
                className={cn(
                  "ms-2 rounded-full px-2 py-0.5 text-xs font-bold",
                  // On the selected pill the badge sits on the action
                  // colour, where warn-bg would be invisible.
                  tab === id ? "bg-action-fg/20 text-action-fg" : "bg-warn-bg text-warn",
                )}
              >
                {count}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
      <>
      {!stats ? (
        <StatSkeletons count={4} />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              accent
              icon={<Wallet className="size-5" />}
              label={t.plGross}
              value={`${money(revenue.grossCents)} MAD`}
              sub={t.plGrossSub}
            />
            <StatCard
              icon={<ReceiptText className="size-5" />}
              label={t.plNet}
              value={`${money(revenue.netCents)} MAD`}
              // Basis points keep the API integer; a percent with one decimal
              // is what a person reads.
              sub={`${t.plRefundRate} ${(revenue.refundRateBp / 100).toFixed(1)}%`}
            />
            <StatCard
              icon={
                weekDelta === null ? (
                  <Minus className="size-5" />
                ) : weekDelta >= 0 ? (
                  <ArrowUpRight className="size-5" />
                ) : (
                  <ArrowDownRight className="size-5" />
                )
              }
              label={t.plWeek}
              value={`${money(revenue.thisWeekCents)} MAD`}
              sub={weekDelta === null ? t.plWeekFlat : weekDelta >= 0 ? t.plWeekUp : t.plWeekDown}
              trend={
                weekDelta === null
                  ? { dir: "flat", text: "—" }
                  : { dir: weekDelta >= 0 ? "up" : "down", text: `${weekDelta >= 0 ? "+" : ""}${weekDelta}%` }
              }
            />
            <StatCard
              icon={<UsersIcon className="size-5" />}
              label={t.plPeople}
              value={String(stats.users.total)}
              sub={`${stats.users.newThisWeek} ${t.plNewWeek}`}
            />
          </div>

          {/* The one number here that is a to-do rather than a metric, so it
              gets a link to the place it is cleared. */}
          {stats.pendingApplications > 0 ? (
            <Link
              to="/pro/users"
              className="mt-4 flex items-center justify-between gap-3 rounded-card border border-warn/30 bg-warn-bg px-4 py-3 text-warn transition hover:brightness-105"
            >
              <span className="text-sm font-bold">
                {stats.pendingApplications} {t.plPending}
              </span>
              <span className="text-sm font-semibold underline underline-offset-4">{t.plReview}</span>
            </Link>
          ) : null}

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Breakdown
              icon={<UsersIcon className="size-4" />}
              title={t.plPeople}
              rows={[
                [t.plCustomers, stats.users.customers],
                [t.plOrganisers, stats.users.organisers],
                [t.plAdmins, stats.users.admins],
              ]}
            />
            <Breakdown
              icon={<CalendarDays className="size-4" />}
              title={t.plCatalogue}
              rows={[
                [t.plPublished, stats.events.published],
                [t.plHidden, stats.events.hidden],
              ]}
            />
            <Breakdown
              icon={<ReceiptText className="size-4" />}
              title={t.plOrders}
              rows={[
                [t.plPaid, stats.orders.paid],
                [t.plRefunded, stats.orders.refunded],
                [t.plCancelled, stats.orders.cancelled],
              ]}
            />
          </div>
        </>
      )}
      </>
      ) : null}

      {/* ── CLIENTS: money the platform owes a ticket BUYER ──────────────
          A resale refund. The platform took the buyer's money and holds
          the seller's, so this is paid by bank transfer to the seller's
          own RIB -- nothing to do with an organiser's takings, which is
          why it is no longer stacked above the seller table. */}
      {tab === "clients" ? (
      <>
      {/* Money owed to buyers, which nothing else on this console shows.

          Always rendered, including when nothing is due. Hiding the whole
          section on an empty list meant "nobody is waiting for money" and
          "this console cannot show you that" looked identical — so someone
          looking for a resale seller's payout found no trace of the feature
          and assumed it did not exist. That is doubly true now it is a tab:
          an empty tab with no words in it reads as broken. */}
      <SectionTitle>{t.plRefundsDue}</SectionTitle>
      {refunds.refunds.length === 0 ? (
        <p className="-mt-2 mb-4 text-sm text-muted">{t.plRefundsNone}</p>
      ) : (
        <>
          <p className="-mt-2 mb-3 text-sm text-muted">
            {t.plRefundsDueSub} · <span className="font-bold text-ink">{money(refunds.totalCents)} MAD</span>
          </p>
          <div className="mb-4 grid gap-3">
            {refunds.refunds.map((row) => (
              <article
                key={row.orderId}
                className="flex min-w-0 flex-wrap items-center gap-4 rounded-card border border-danger/30 bg-danger-bg/30 p-4"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-bold">
                    {money(row.amountCents)} MAD · {row.buyerName}
                  </p>
                  <p className="truncate text-sm text-muted">
                    {row.buyerEmail} · {eventText(row, "eventTitle", locale)}
                  </p>
                  {/* The CMI transaction to reverse, which is what the person
                      doing it in the back office actually needs. */}
                  <p className="mt-1 break-all font-mono text-xs text-muted">
                    {row.gatewayRef ?? t.plRefundNoGatewayRef}
                  </p>
                  {/* Where to send it, when there is no card charge to
                      reverse. A resale payout is money the platform holds,
                      so it leaves by bank transfer -- and this row used to
                      show a name and an amount and no account number, which
                      is why "Mark as sent" could be pressed for a payment
                      nobody was able to make. */}
                  {row.gatewayRef ? null : row.bank ? (
                    /* break-all on the RIB: 24 digits is a single
                       unbreakable token ~173px wide, so min-w-0 above it
                       changes nothing -- the row simply cannot be narrower
                       than the number. Wrapping mid-number is fine here;
                       it is read in groups off the screen either way. */
                    <p className="mt-1 break-all font-mono text-xs text-ink">
                      {row.bank.holderName} · {row.bank.rib}
                      {row.bank.bank ? ` · ${row.bank.bank}` : ""}
                    </p>
                  ) : (
                    <p className="mt-1 text-xs font-semibold text-danger">
                      {row.isGuest ? t.plRefundGuestNoBank : t.plRefundNoBank}
                    </p>
                  )}
                </div>
                <Button
                  className="w-full shrink-0 sm:w-auto"
                  // Nothing to pay into means nothing to record. The server
                  // refuses this too; disabling it here just stops the click
                  // that can only end in an error.
                  disabled={!row.gatewayRef && !row.bank}
                  onClick={() => {
                    setRefundRow(row);
                    // Prefilled: the gateway reference is what the person in
                    // the back office reverses, so it is usually the answer.
                    setRefundRef(row.gatewayRef ?? "");
                  }}
                >
                  {t.plRefundMarkPaid}
                </Button>
              </article>
            ))}
          </div>
        </>
      )}

      {refundRow ? (
        <Modal
          open
          onClose={() => setRefundRow(null)}
          title={t.plRefundMarkPaid}
          size="sm"
          footer={
            <>
              <Button variant="secondary" onClick={() => setRefundRow(null)}>
                {t.cancelBtn}
              </Button>
              <Button type="submit" form="refund-paid-form" disabled={refundRef.trim().length < 3}>
                {t.plRefundMarkPaid}
              </Button>
            </>
          }
        >
          <form id="refund-paid-form" onSubmit={submitRefundPaid}>
            <p className="mb-3 text-sm text-muted">
              {money(refundRow.amountCents)} MAD · {refundRow.buyerName} · {refundRow.buyerEmail}
            </p>
            <Field label={t.plRefundRefPrompt}>
              {(props) => (
                <Input {...props} value={refundRef} onChange={(e) => setRefundRef(e.target.value)} autoFocus />
              )}
            </Field>
          </form>
        </Modal>
      ) : null}
      </>
      ) : null}

      {/* ── ORGANISATEURS: money the platform owes an event ORGANISER ────
          Their takings less the Eventick fee, paid against the RIB on
          their own Finance screen. A different pot and a different party
          from the refunds above, which is exactly why they are no longer
          on one page together. */}
      {tab === "organisers" ? (
      <>
      {/*
        Plan requests first: a to-do rather than a metric, the same reason
        the pending-applications banner sits where it does. Hidden entirely
        when the queue is empty — an admin does not need a heading telling
        them there is nothing to do, and the tab's own badge already says
        whether anything is waiting.
      */}
      {planRequests.length > 0 ? (
        <>
          <SectionTitle>{t.plPlanRequests}</SectionTitle>
          <div className="mb-4 grid gap-3">
            {planRequests.map((row) => (
              <article
                key={row.id}
                className="flex min-w-0 flex-wrap items-center gap-4 rounded-card border border-warn/30 bg-warn-bg/40 p-4"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-bold">{row.organiser.name}</p>
                  <p className="truncate text-sm text-muted">
                    {row.fromPlanLabel ?? "—"} → <span className="font-semibold text-ink">{row.planLabel}</span>
                    {typeof row.rateBps === "number"
                      ? ` · ${(row.rateBps / 100).toFixed(0)}%${
                          row.monthlyCents > 0 ? ` + ${money(row.monthlyCents)} MAD` : ""
                        }`
                      : ""}
                  </p>
                  {row.note ? <p className="mt-1 text-xs italic text-muted">“{row.note}”</p> : null}
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button variant="ghost" onClick={() => decidePlan(row.id, false)}>
                    {t.plDecline}
                  </Button>
                  <Button onClick={() => decidePlan(row.id, true)}>{t.plApprove}</Button>
                </div>
              </article>
            ))}
          </div>
        </>
      ) : null}

      <SectionTitle>{t.plWhoSells}</SectionTitle>
      <p className="-mt-2 mb-3 text-sm text-muted">{t.plWhoSellsSub}</p>

      {/* Ranking, so the list answers more than one question. Owed first in
          the options because "who do I pay today" is the one this page is
          opened for.

          Labelled, because unlabelled pills above a list read as FILTERS:
          "Refunds" was taken for "show me the refunds", and clicking it
          appeared to do nothing — it reorders organisers by refund rate,
          and money owed to buyers is its own section further up. */}
      <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.06em] text-muted">{t.plSortBy}</p>
      <div className="mb-3 inline-flex flex-wrap items-center gap-1 rounded-full bg-paper p-1 text-xs font-bold">
        {[
          ["revenue", t.plSortRevenue],
          ["owed", t.plSortOwed],
          ["refunds", t.plSortRefunds],
          ["events", t.plSortEvents],
        ].map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setSortBy(key)}
            aria-pressed={sortBy === key}
            className={cn(
              "rounded-full px-3 py-1.5 transition",
              sortBy === key ? "bg-card text-encre shadow-card" : "text-muted hover:text-encre",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {sellers && sellers.length === 0 ? (
        <EmptyState icon={<UsersIcon className="size-6" />} title={t.plNoSales} />
      ) : (
        <div className="grid gap-3">
          {sortedSellers.map((seller) => (
            <article
              key={seller.id}
              className="flex min-w-0 flex-wrap items-center gap-4 rounded-card border border-line/10 bg-card p-4 shadow-card"
            >
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-bold">
                  {seller.name}
                  {/* An ADMIN can appear here when they run house events —
                      see the route's comment. Saying so stops the row from
                      looking like a bug. */}
                  {seller.role === "ADMIN" ? <Badge tone="info">{t.roleAdmin}</Badge> : null}
                </p>
                <p className="truncate text-sm text-muted">{seller.email}</p>
              </div>

              <div className="flex shrink-0 items-center gap-4 text-xs text-muted">
                <span>
                  <span className="font-bold tabular-nums text-ink">{seller.events}</span> {t.plEventsCount}
                </span>
                <span>
                  <span className="font-bold tabular-nums text-ink">{seller.orders}</span> {t.plOrdersCount}
                </span>
              </div>

              {/* Commission plan. The organiser sees this read-only on their
                  own Finance screen — assigning it is an admin act, because
                  an organiser choosing their own rate is the bug being fixed. */}
              {/* Dropdown, not a native <select>: this row sits on the dark
                  card chrome, and the browser's own popup ignores the theme
                  entirely -- it opened as a plain light list with OS
                  highlight colours in the middle of a dark console. */}
              <span className="flex shrink-0 flex-col gap-1" style={{ width: 150 }}>
                <span id={`plan-label-${seller.id}`} className="text-[10px] font-bold uppercase tracking-wide text-muted">
                  {t.plPlan}
                </span>
                <Dropdown
                  // labelledBy rather than a <label>: the trigger is a
                  // button, which a <label> does not forward clicks to.
                  labelledBy={`plan-label-${seller.id}`}
                  label={t.plPlan}
                  value={seller.plan ?? ""}
                  onChange={(planKey) => assignPlan(seller.id, planKey)}
                  options={[
                    { value: "", label: t.plPlanDefault },
                    ...plans.map((plan) => ({
                      value: plan.key,
                      label: `${plan.label} · ${plan.rateBps / 100}%`,
                    })),
                  ]}
                  triggerClassName={triggerControlClass({ className: "h-10 text-sm" })}
                />
              </span>

              <p className="shrink-0 text-end">
                <span className="block font-display text-subhead font-bold tabular-nums">
                  {money(seller.grossCents)}
                </span>
                <span className="block text-[11px] font-semibold text-muted">
                  MAD · {t.fee} {money(seller.feeCents ?? 0)}
                  {/* The figure that separates "sells a lot" from "sells a lot
                      and keeps it". Hidden at zero, so a clean record shows as
                      nothing rather than a 0.0% nobody needs to read. */}
                  {seller.refundRateBp > 0
                    ? ` · ${t.plRefundRate} ${(seller.refundRateBp / 100).toFixed(1)}%`
                    : ""}
                </span>
              </p>

              {/* Owed right now — the figure this page exists to show.
                  Without it an admin had to open every organiser in turn to
                  find out who was waiting on money. Dimmed at zero so the
                  rows that need paying are the ones that stand out. */}
              <p className="shrink-0 text-end">
                <span
                  className={cn(
                    "block font-display text-subhead font-bold tabular-nums",
                    seller.owedCents > 0 ? "text-success" : "text-muted",
                  )}
                >
                  {money(seller.owedCents ?? 0)}
                </span>
                <span className="block text-[11px] font-semibold text-muted">
                  {t.plOwed}
                  {seller.owedOrders > 0 ? ` · ${seller.owedOrders}` : ""}
                </span>
              </p>

              {/* A payout with no bank details is refused by the server, so
                  the row says to chase rather than offering a button that
                  can only fail. */}
              {seller.owedCents > 0 && !seller.hasBankAccount ? (
                <Badge tone="warn" className="shrink-0">
                  {t.plNoBank}
                </Badge>
              ) : null}

              <Button
                variant="ghost"
                onClick={() => setRunning(seller)}
                className="shrink-0"
                // Also disabled with no RIB on file. The comment above
                // already said the row "says to chase rather than offering
                // a button that can only fail" -- but the badge was added
                // and the button left live, so it still offered it. runPayout
                // refuses an organiser with no account, so pressing it could
                // only ever produce an error.
                disabled={!seller.owedCents || !seller.hasBankAccount}
              >
                {t.plRunPayout}
              </Button>
            </article>
          ))}
        </div>
      )}

      <SectionTitle>{t.plPayouts}</SectionTitle>
      {payouts && payouts.length === 0 ? (
        <EmptyState icon={<Landmark className="size-6" />} title={t.plPayoutsNone} />
      ) : (
        <div className="grid gap-3">
          {(payouts ?? []).map((row) => (
            <PayoutAdminRow
              key={row.id}
              row={row}
              t={t}
              onChanged={() => {
                loadPayouts();
                loadSellers();
              }}
            />
          ))}
        </div>
      )}

      {running ? (
        <RunPayoutModal
          seller={running}
          t={t}
          onClose={() => setRunning(null)}
          onDone={() => {
            setRunning(null);
            loadPayouts();
            loadSellers();
          }}
        />
      ) : null}
      </>
      ) : null}
    </div>
  );
}

const PAYOUT_TONE = {
  PENDING: "bg-warn-bg text-warn",
  PAID: "bg-success-bg text-success",
  CANCELLED: "bg-sunken text-muted",
};

const PAYOUT_LABEL = (row, t) =>
  ({ PENDING: t.payoutPending, PAID: t.payoutPaid, CANCELLED: t.payoutCancelled })[row.status] ?? row.status;

/** One payout, with the bank details needed to action it. */
function PayoutAdminRow({ row, t, onChanged }) {
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);

  const markPaid = async () => {
    if (!reference.trim() || busy) return;
    setBusy(true);
    try {
      await api.post(`/platform/payouts/${row.id}/paid`, { reference: reference.trim() });
      toast.success(t.plPayoutPaid);
      onChanged();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    try {
      await api.post(`/platform/payouts/${row.id}/cancel`, { note: "" });
      toast.success(t.plCancelled);
      onChanged();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="rounded-card border border-line/10 bg-card p-4 shadow-card">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${PAYOUT_TONE[row.status]}`}>
          {PAYOUT_LABEL(row, t)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold">{row.organiserName}</p>
          <p className="truncate text-xs text-muted">
            {row.orders} {t.payoutOrders} · {t.gross} {money(row.grossCents)} − {t.fee} {money(row.feeCents)}
            {row.subscriptionCents > 0 ? ` − ${t.subscription} ${money(row.subscriptionCents)}` : ""}
            {row.reference ? ` · ${t.payoutRef} ${row.reference}` : ""}
          </p>
        </div>
        <p className="shrink-0 font-display text-subhead font-bold tabular-nums">{money(row.netCents)} MAD</p>
      </div>

      {/* The RIB shows only on a payout waiting to be sent — it is what the
          transfer is made from, and there is no reason to keep displaying a
          payment credential once the money has gone. */}
      {row.status === "PENDING" ? (
        <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-line/10 pt-3">
          {/* break-all: the RIB is a 24-digit unbreakable token, the
              same reason the refunds queue above needs it. */}
          <p className="me-auto break-all font-mono text-xs text-muted">
            {row.bank
              ? `${row.bank.holderName} · ${row.bank.rib}${row.bank.bank ? ` · ${row.bank.bank}` : ""}`
              : t.plNoBank}
          </p>
          <Input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder={t.plPayoutRef}
            style={{ width: 200 }}
          />
          <Button onClick={markPaid} disabled={busy || !reference.trim()}>
            {t.plMarkPaid}
          </Button>
          <Button variant="ghost" onClick={cancel} disabled={busy}>
            {t.plCancelPayout}
          </Button>
        </div>
      ) : null}
    </article>
  );
}

/** Pick a period and create the payout. */
function RunPayoutModal({ seller, t, onClose, onDone }) {
  const [earnings, setEarnings] = useState(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    /*
     * Defaults to the last twelve months, not "all time".
     *
     * A run only picks up orders not already in a payout, so a wide window is
     * safe for the ORDERS — but the plan subscription is billed per calendar
     * month, and a 2020 start meant offering to bill 120 of them. A year is
     * wide enough to sweep up anything outstanding in practice, and the dates
     * are editable for the rare case that is not true.
     */
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1));
    setTo(new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10));
    setFrom(from.toISOString().slice(0, 10));
    api.get(`/platform/organisers/${seller.id}/earnings`).then(setEarnings).catch(() => setEarnings(null));
  }, [seller.id]);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.post(`/platform/organisers/${seller.id}/payouts`, {
        periodStart: from,
        periodEnd: to,
      });
      toast.success(t.plPayoutDone.replace("{amount}", money(result.netCents)));
      onDone();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={t.plRunPayoutFor.replace("{name}", seller.name)}>
      <div className="grid gap-3">
        {earnings ? (
          <p className="text-sm">
            <span className="text-muted">{t.plOwed}: </span>
            <span className="font-bold tabular-nums">{money(earnings.pending.payableCents)} MAD</span>
            <span className="text-muted">
              {" "}
              ({earnings.unpaidOrders} {t.payoutOrders})
            </span>
            {/* Without a RIB there is nowhere to send it, and the server
                refuses the run — say so before they fill the dates in. */}
            {!earnings.bankAccount ? <span className="ms-2 font-semibold text-danger">· {t.plNoBank}</span> : null}
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t.plPeriodFrom}>
            {(props) => <Input {...props} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}
          </Field>
          <Field label={t.plPeriodTo}>
            {(props) => <Input {...props} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}
          </Field>
        </div>
        <Button onClick={submit} disabled={busy || !from || !to || !earnings?.bankAccount}>
          {t.plRunPayout}
        </Button>
      </div>
    </Modal>
  );
}

function Breakdown({ icon, title, rows }) {
  // min-w-0: always rendered as a grid item (see the lg:grid-cols-3 callers
  // above), and a grid item defaults to min-width: auto -- without this it
  // is held to its own content's min-content width instead of the track.
  return (
    <div className="min-w-0 rounded-card border border-line/10 bg-card p-4 shadow-card">
      <p className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.06em] text-muted">
        {icon}
        {title}
      </p>
      <dl className="mt-3 grid gap-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-3">
            <dt className="text-sm text-muted">{label}</dt>
            <dd className="font-display text-base font-bold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
