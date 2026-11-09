import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Heart, History, Search, Send, Ticket as TicketIcon } from "lucide-react";
import { toast } from "sonner";
import { TicketPass, toTicketPassProps } from "../components/TicketPass";
import { EventCard } from "../components/EventCard";
import { Shell } from "../components/Shell";
import { Protected } from "../components/Protected";
import { api, money } from "../api";
import { useAuth } from "../AuthContext";
import { useFavorites } from "../FavoritesContext";
import { useCatalog } from "../useCatalog";
import { Button, EmptyState, Field, Input, Modal } from "../ui";
import { useI18n } from "../i18n";
import { cn, daysUntil, eventText, longDate, todayKey } from "../utils";

/**
 * Where a customer's resale money goes.
 *
 * A refund onto a card needs nothing from the buyer -- CMI reverses the
 * charge it made. Reselling is the other case: the platform holds the
 * seller's money, so paying them is a bank transfer, and nothing used to
 * ask for an account to transfer to. The admin's refund queue showed a
 * name and an amount and no RIB, which made its "Mark as sent" button a
 * claim nobody could act on.
 *
 * Deliberately on the buyer's own page rather than buried in settings: it
 * is the same screen that shows them a pending payout, so the answer to
 * "where is my money" sits next to the question.
 */
function ClientBankCard({ onFile, setOnFile }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [holderName, setHolderName] = useState("");
  const [bank, setBank] = useState("");
  const [rib, setRib] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Prefill from what is saved, so correcting a misspelled holder name does
  // not mean retyping it. The RIB is NOT prefilled -- the server returns
  // only its last four digits, and the hint below says so.
  useEffect(() => {
    setHolderName(onFile?.holderName ?? "");
    setBank(onFile?.bank ?? "");
  }, [onFile?.holderName, onFile?.bank]);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const digits = rib.replace(/[\s-]/g, "");
    if (!/^\d{24}$/.test(digits)) {
      setError(t("cbBadRib"));
      return;
    }
    setError("");
    setBusy(true);
    try {
      const data = await api.put("/auth/me/bank", { holderName: holderName.trim(), rib: digits, bank: bank.trim() });
      setOnFile(data.bank);
      setRib("");
      setOpen(false);
      toast.success(t("cbSaved"));
    } catch (err) {
      toast.error(err.message || t("cbBadRib"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="rounded-card border border-line/10 bg-card p-4 shadow-card">
      <h2 className="font-display text-xl font-bold">{t("cbTitle")}</h2>
      <p className="mt-1 text-xs text-muted">{t("cbSub")}</p>

      <p className="mt-3 text-sm">
        {onFile ? (
          <span className="font-semibold text-success">
            {t("cbOnFile")} · {onFile.holderName} · **** {onFile.ribLast4}
            {onFile.bank ? ` · ${onFile.bank}` : ""}
          </span>
        ) : (
          <span className="font-semibold text-danger">{t("cbMissing")}</span>
        )}
      </p>

      {open ? (
        <form onSubmit={submit} className="mt-4 grid gap-3">
          <Field label={t("cbHolder")} required>
            {(props) => <Input {...props} value={holderName} onChange={(e) => setHolderName(e.target.value)} autoComplete="name" />}
          </Field>
          <Field label={t("cbBank")}>
            {(props) => <Input {...props} value={bank} onChange={(e) => setBank(e.target.value)} placeholder="CIH, Attijariwafa…" />}
          </Field>
          <Field label={t("cbRib")} error={error} required hint={onFile ? t("cbRibRetype") : undefined}>
            {(props) => (
              <Input
                {...props}
                value={rib}
                onChange={(e) => setRib(e.target.value)}
                inputMode="numeric"
                placeholder="1234 5678 9012 3456 7890 1234"
                // A payment credential: keep it out of autofill stores.
                autoComplete="off"
              />
            )}
          </Field>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || holderName.trim().length < 3 || !rib} className="flex-1">
              {t("cbSave")}
            </Button>
            <button
              type="button"
              className="h-11 rounded-full border border-line/20 bg-card px-4 text-sm font-semibold transition hover:bg-paper"
              onClick={() => setOpen(false)}
            >
              {t("cancel")}
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="mt-3 text-sm font-semibold text-primary" onClick={() => setOpen(true)}>
          {onFile ? t("edit") : t("cbSave")}
        </button>
      )}
    </article>
  );
}

function BilletsInner() {
  const { locale, t, tf } = useI18n();
  const navigate = useNavigate();
  const { user, refresh, canUsePro } = useAuth();
  const { favorites } = useFavorites();
  const { events } = useCatalog();
  const [orders, setOrders] = useState(null);
  const [tab, setTab] = useState("active");
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(user?.name ?? "");
  const [transferId, setTransferId] = useState(null);
  /* Whether this person has somewhere to be paid. Held here rather than in
     ClientBankCard because the history rows need the same answer: a payout
     that is waiting on a missing RIB is waiting on the reader, and saying
     only "on its way" would be telling them to sit and wait for something
     that cannot move until they act. null = not loaded yet. */
  const [bankOnFile, setBankOnFile] = useState(null);
  /* Separate from bankOnFile, which is null both before the fetch answers
     and when there is genuinely no account: without this the "add your RIB"
     warning flashes on every load before the answer arrives. */
  const [bankLoaded, setBankLoaded] = useState(false);
  /* Store credit: the balance and the movements behind it.
     The statement, not just a number -- "where did this come from" is the
     first thing anyone asks about money that appeared in their account. */
  const [credit, setCredit] = useState({ balanceCents: 0, entries: [] });
  const [friend, setFriend] = useState("");
  const [busy, setBusy] = useState(false);

  const loadOrders = () => api.get("/orders").then((data) => setOrders(data.orders));

  useEffect(() => {
    loadOrders();
    api
      .get("/auth/me/bank")
      .then((data) => setBankOnFile(data.bank))
      // A failure must not blank the page; "no RIB" is also the safe thing
      // to show, since it prompts rather than reassures.
      .catch(() => setBankOnFile(null))
      .finally(() => setBankLoaded(true));
    api
      .get("/auth/me/credit")
      // Zero is the safe fallback: showing a stale or invented balance would
      // be worse than showing none, since it is spendable money.
      .catch(() => ({ balanceCents: 0, entries: [] }))
      .then(setCredit);
  }, []);

  const today = todayKey();
  const flat = useMemo(() => orders?.flatMap((order) => order.tickets.map((ticket) => ({ ticket, order }))) ?? [], [orders]);
  const active = flat
    .filter((item) => item.ticket.status === "VALID" && item.ticket.event.end >= today)
    .sort((a, b) => a.ticket.event.start.localeCompare(b.ticket.event.start));
  const past = flat.filter((item) => item.ticket.status !== "VALID" || item.ticket.event.end < today);
  const next = active[0]?.ticket;
  const days = next ? daysUntil(next.event.start, today) : null;
  const latest = orders ? [...orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] : null;
  const savedEvents = favorites.map((slug) => events.find((event) => event.slug === slug)).filter(Boolean);
  const initials = (user?.name ?? "?")
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  const nextLabel = days == null ? "" : days <= 0 ? t("nextToday") : days === 1 ? t("nextTomorrow") : tf("nextIn", { n: days });

  const saveName = async (e) => {
    e.preventDefault();
    if (busy || nameDraft.trim().length < 2) return;
    setBusy(true);
    try {
      await api.patch("/auth/me", { name: nameDraft.trim() });
      await refresh?.();
      setEditingName(false);
      toast.success(t("profileSaved"));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const submitTransfer = async (e) => {
    e.preventDefault();
    if (busy || friend.trim().length < 3 || !transferId) return;
    setBusy(true);
    try {
      await api.post(`/tickets/${transferId}/transfer`, { holderName: friend.trim() });
      await loadOrders();
      setTransferId(null);
      setFriend("");
      toast.success(t("transferOk"));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = () => {
    const header = ["title", "date", "ref", "price", "status"];
    const rows = past.map(({ ticket }) => [
      eventText(ticket.event, "title", locale),
      ticket.event.start,
      ticket.ref,
      String(ticket.priceCents / 100),
      ticket.status,
    ]);
    const csv = [header, ...rows].map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "eventick-releve.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  if (!orders) {
    return (
      <Shell>
        <div className="mx-auto h-80 max-w-3xl animate-pulse px-4 py-10" />
      </Shell>
    );
  }

  return (
    <Shell>
      {/* Deliberately always dark — see the note on --et-stage in styles.css. */}
      <section className="bg-stage text-stage-fg">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-4 py-8 md:px-8">
          <span className="inline-flex size-16 items-center justify-center rounded-full bg-primary font-display text-xl font-extrabold text-primary-fg">{initials}</span>
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-3xl font-extrabold">{user?.name}</h1>
            <p className="text-sm text-stage-muted">{user?.email}</p>
          </div>
          {/* Buyer stats only. "Dépenses 2026" is a question staff never
              ask of this page -- for an organiser or admin it is a permanent
              0 MAD next to a permanent 0 tickets, which reads as a broken
              dashboard rather than an empty one. Their equivalent figures
              (sold, checked in, revenue) live in /pro, scoped per event. */}
          {canUsePro ? null : (
            <div className="grid grid-cols-2 gap-2">
              <Mini value={String(active.length)} label={t("ready")} />
              <Mini value={orders.length ? `${money(orders.reduce((s, o) => s + o.totalCents, 0))} MAD` : "0 MAD"} label={t("spend")} />
            </div>
          )}
        </div>
      </section>
      <div className="mx-auto max-w-7xl px-4 py-6 md:px-8">
        {/* Every tab here is a buyer surface: active and past read the
            caller's own orders, saved reads the shopping wishlist. Staff
            sell rather than buy, so for them this page is an identity page
            and nothing else -- the whole bar goes, not a subset of it.

            Hidden, not disabled: a tab that can never hold anything is not
            a state the user can get out of, so there is nothing to disable. */}
        {canUsePro ? null : (
        <div className="scroll-none flex gap-2 overflow-x-auto">
          {[
            ["active", t("tabActive")],
            ["past", t("tabPast")],
            ["saved", t("tabSaved")],
            ["credit", t("tabCredit")],
            ["bank", t("tabBank")],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-current={tab === id ? "true" : undefined}
              className={`h-11 shrink-0 rounded-full px-4 text-sm font-semibold transition ${
                tab === id ? "bg-action text-action-fg" : "bg-card text-ink hover:bg-brume"
              }`}
              onClick={() => setTab(id)}
            >
              {label}
              {id === "active" ? ` (${active.length})` : ""}
              {id === "saved" ? ` (${savedEvents.length})` : ""}
              {/* The amount, on the tab itself. A balance behind an unopened
                  tab is money the buyer does not know they have. */}
              {id === "credit" && credit.balanceCents > 0 ? (
                <span
                  className={cn(
                    "ms-2 rounded-full px-2 py-0.5 text-xs font-bold",
                    tab === id ? "bg-action-fg/20 text-action-fg" : "bg-success-bg text-success",
                  )}
                >
                  {money(credit.balanceCents)}
                </span>
              ) : null}
              {/* No RIB is the one thing here that stops money arriving, so
                  the tab says so rather than waiting to be opened. Only once
                  the fetch has answered: bankOnFile is null both before the
                  answer and when there is genuinely no account, so without
                  bankLoaded this flashes on every page load. */}
              {id === "bank" && bankLoaded && !bankOnFile ? (
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
        )}

        {!canUsePro && tab === "active" ? (
          <div className="mt-6 space-y-4">
            {next ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-card bg-brume px-4 py-3">
                <p className="font-semibold text-primary">{nextLabel}</p>
                <Link to={`/billet/${next.id}`} className="inline-flex h-11 items-center rounded-full bg-action px-4 text-sm font-semibold text-action-fg transition hover:bg-action-hover">
                  {t("showPass")}
                </Link>
              </div>
            ) : (
              // A plain line of text used to be the whole empty state --
              // no way to act on it. Someone with zero tickets is exactly
              // who should be pointed at the catalogue, not left reading
              // "the season is open" with nothing to click.
              <EmptyState
                icon={<TicketIcon className="size-6" />}
                title={t("noActive")}
                action={
                  <Button icon={<Search className="size-4" />} onClick={() => navigate("/explorer")}>
                    {t("exploreMore")}
                  </Button>
                }
              />
            )}
            {active[0] ? <TicketPass {...toTicketPassProps(active[0].ticket)} /> : null}
            {active.length > 1 ? (
              <>
                <h2 className="font-display text-xl font-bold">{t("other")}</h2>
                <div className="grid gap-3 md:grid-cols-2">
                  {active.slice(1).map(({ ticket }) => (
                    <SmallTicket key={ticket.id} ticket={ticket} locale={locale} t={t} onTransfer={() => setTransferId(ticket.id)} />
                  ))}
                </div>
              </>
            ) : null}
          </div>
        ) : null}

        {!canUsePro && tab === "past" ? (
          <div className="mt-6 overflow-x-auto rounded-card border border-line/10 bg-card">
            <div className="flex flex-wrap items-center justify-between gap-3 p-4">
              <h2 className="font-display text-xl font-bold">{t("historyTitle")}</h2>
              <button type="button" className="h-11 shrink-0 rounded-full border border-line/20 bg-card px-4 text-sm font-semibold transition hover:bg-paper" onClick={exportCsv}>
                {t("exportCsv")}
              </button>
            </div>
            {/* Headers over zero rows read as a broken table -- the whole
                table (headers included) only renders once there's at least
                one row; the empty state gets the same EmptyState treatment
                as the other two tabs instead of a bare line of text. */}
            {past.length === 0 ? (
              <EmptyState icon={<History className="size-6" />} title={t("noPast")} />
            ) : (
            <table className="w-full min-w-[40rem] text-start text-sm">
              <thead className="text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 text-start">{t("colEvent")}</th>
                  <th className="px-4 py-2 text-start">{t("colDate")}</th>
                  <th className="px-4 py-2 text-start">{t("colRef")}</th>
                  <th className="px-4 py-2 text-start">{t("colPrice")}</th>
                  <th className="px-4 py-2 text-start">{t("colStatus")}</th>
                </tr>
              </thead>
              <tbody>
                {past.map(({ ticket, order }) => (
                  <tr key={ticket.id} className="border-t border-line/10">
                    <td className="px-4 py-3">
                      <p className="font-semibold">{eventText(ticket.event, "title", locale)}</p>
                      <p className="text-muted">{ticket.event.city}</p>
                    </td>
                    <td className="px-4 py-3">{longDate(ticket.event.start, locale)}</td>
                    <td className="px-4 py-3 font-mono text-xs">{ticket.ref}</td>
                    <td className="px-4 py-3">{money(ticket.priceCents)} MAD</td>
                    <td className="px-4 py-3">
                      {ticket.status === "TRANSFERRED" ? t("transferred") : ticket.status === "CANCELLED" ? t("cancelled") : t("used")}
                      {/* What happened to the money, for a seat that was
                          resold or refunded. refundedAt is only the decision:
                          CMI has no refund API, so the transfer is made by
                          hand afterwards and refundPaidAt is when it actually
                          went out. Saying "remboursé" at the decision is what
                          sent sellers to their bank to find nothing there. */}
                      {order.refundedCents > 0 ? (
                        <>
                          <p className={`mt-1 text-xs ${order.refundPaidAt ? "text-success" : "text-muted"}`}>
                            {(order.refundPaidAt ? t("payoutSent") : t("payoutPending")).replace(
                              "{n}",
                              money(order.refundedCents),
                            )}
                          </p>
                          {/* A payout still waiting, with no account to pay
                              into, is waiting on the reader -- so say so
                              instead of leaving them to wait for a transfer
                              that cannot be made. Only once the fetch has
                              answered (null means not loaded), and never
                              after the money has gone out. */}
                          {!order.refundPaidAt && bankOnFile === null && bankLoaded ? (
                            <p className="mt-1 text-xs font-semibold text-danger">{t("payoutNoBank")}</p>
                          ) : null}
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            )}
          </div>
        ) : null}

        {!canUsePro && tab === "saved" ? (
          <div className="mt-6">
            <p className="text-sm text-muted">{t("alertsOn")}</p>
            {savedEvents.length === 0 ? (
              <EmptyState
                icon={<Heart className="size-6" />}
                title={t("noSaved")}
                action={
                  <Button icon={<Search className="size-4" />} onClick={() => navigate("/explorer")}>
                    {t("exploreMore")}
                  </Button>
                }
              />
            ) : null}
            <div className="mt-4 grid gap-4 md:grid-cols-3">
              {savedEvents.map((event) => (
                <EventCard key={event.slug} event={event} />
              ))}
            </div>
          </div>
        ) : null}

        {/* Its own tab rather than a third card in the grid below.
            It was sharing a row with a purchase receipt and a name field,
            which put the account that money is PAID INTO next to two things
            that are only read -- and it is the longest thing on the page
            once the form is open. Staff do not resell, so they never see
            it: an organiser's payout account lives on Finance. */}
        {/* ── Store credit ───────────────────────────────────────────────
            The statement, not just a total. The balance IS the sum of these
            rows -- it is not stored anywhere -- so showing the number alone
            would hide the only thing that can explain it. */}
        {!canUsePro && tab === "credit" ? (
          <div className="mt-6 max-w-xl">
            <div className="rounded-card border border-line/10 bg-card p-5 shadow-card">
              <p className="text-sm text-muted">{t("creditBalance")}</p>
              <p className="mt-1 text-3xl font-black text-ink">
                {money(credit.balanceCents)} <span className="text-lg font-bold">MAD</span>
              </p>
              <p className="mt-2 text-sm text-muted">{t("creditHowItWorks")}</p>
              {credit.balanceCents > 0 ? (
                <Button className="mt-4 w-full sm:w-auto" onClick={() => navigate("/explorer")}>
                  {t("creditSpend")}
                </Button>
              ) : null}
            </div>

            {credit.entries.length > 0 ? (
              <div className="mt-4 grid gap-2">
                {credit.entries.map((entry) => (
                  <article
                    key={entry.id}
                    className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 rounded-card border border-line/10 bg-card px-4 py-3"
                  >
                    <span className="min-w-0 flex-1 break-words text-sm">{entry.label}</span>
                    <span className="shrink-0 text-xs text-muted">{longDate(entry.createdAt, locale)}</span>
                    {/* The sign carries the meaning, so it is shown rather
                        than left for the reader to infer from a colour. */}
                    <span
                      className={cn(
                        "shrink-0 font-bold tabular-nums",
                        entry.amountCents < 0 ? "text-muted" : "text-success",
                      )}
                    >
                      {entry.amountCents < 0 ? "−" : "+"}
                      {money(Math.abs(entry.amountCents))}
                    </span>
                  </article>
                ))}
              </div>
            ) : (
              <p className="mt-4 text-sm text-muted">{t("creditEmpty")}</p>
            )}
          </div>
        ) : null}

        {!canUsePro && tab === "bank" ? (
          <div className="mt-6 max-w-xl">
            <ClientBankCard onFile={bankOnFile} setOnFile={setBankOnFile} />
          </div>
        ) : null}

        {/* Two cards for a buyer (receipt + profile), one for staff: the
            last transaction is a purchase receipt, so for an account that
            never buys it is a card that exists only to say "nothing here".
            These sit below every tab because they describe the ACCOUNT
            rather than any one view of it; the payout account used to be
            here too and is now its own tab, being a form rather than a
            read-only summary. */}
        <section className={`mt-8 grid gap-4 ${canUsePro ? "" : "lg:grid-cols-2"}`}>
          {canUsePro ? null : (
          <article className="rounded-card border border-line/10 bg-card p-4 shadow-card">
            <h2 className="font-display text-xl font-bold">{t("lastTx")}</h2>
            {latest ? (
              <>
                <p className="mt-2 text-sm text-muted">{latest.paymentRef}</p>
                <p className="mt-3 flex justify-between">
                  <span>{latest.tickets[0] ? (eventText(latest.tickets[0].event, "title", locale)) : t("tickets")}</span>
                  <span>{money(latest.subtotalCents)} MAD</span>
                </p>
                <p className="flex justify-between text-sm">
                  <span>{t("serviceFee")}</span>
                  <span>{t("feesFree")}</span>
                </p>
                <p className="mt-2 flex justify-between font-display text-2xl font-extrabold">
                  <span>{t("totalDebited")}</span>
                  <span>{money(latest.totalCents)} MAD</span>
                </p>
              </>
            ) : (
              // noTx ("no transactions at all") is a different fact than
              // noPast ("no past/ended events yet") -- this card is about
              // the latest ORDER, not about tickets whose event has ended,
              // and conflating the two previously meant someone with 3
              // active orders could see "no history" copy here too.
              <p className="mt-2 text-sm text-muted">{t("noTx")}</p>
            )}
          </article>
          )}
          <article className="rounded-card border border-line/10 bg-card p-4 shadow-card">
            <h2 className="font-display text-xl font-bold">{t("edit")}</h2>
            {editingName ? (
              <form className="mt-3 grid gap-2" onSubmit={saveName}>
                {/* Was unlabelled: a screen reader announced only "edit text",
                    with no indication of what it edits. */}
                <Field label={t("fullName")} required>
                  {(props) => <Input {...props} value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} autoComplete="name" />}
                </Field>
                <div className="flex gap-2">
                  <button type="submit" disabled={busy} className="h-11 flex-1 rounded-full bg-action text-sm font-semibold text-action-fg transition hover:bg-action-hover disabled:opacity-50">
                    {t("saveProfile")}
                  </button>
                  <button type="button" className="h-11 rounded-full border border-line/20 bg-card px-4 text-sm font-semibold transition hover:bg-paper" onClick={() => setEditingName(false)}>
                    {t("cancel")}
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                className="mt-3 text-sm font-semibold text-primary"
                onClick={() => {
                  setNameDraft(user?.name ?? "");
                  setEditingName(true);
                }}
              >
                {t("edit")} — {user?.name}
              </button>
            )}
          </article>
        </section>
      </div>

      <Modal
        open={Boolean(transferId)}
        onClose={() => setTransferId(null)}
        title={t("transferTitle")}
        icon={<Send className="size-5" />}
        footer={
          <>
            <Button variant="secondary" onClick={() => setTransferId(null)}>
              {t("cancel")}
            </Button>
            <Button type="submit" form="transfer-form" loading={busy}>
              {t("sendTicket")}
            </Button>
          </>
        }
      >
        <form id="transfer-form" onSubmit={submitTransfer}>
          <Field label={t("friendName")} required>
            {(props) => <Input {...props} value={friend} onChange={(e) => setFriend(e.target.value)} autoComplete="name" />}
          </Field>
        </form>
      </Modal>
    </Shell>
  );
}

function Mini({ value, label }) {
  return (
    <div className="rounded-card bg-stage-fg/10 px-3 py-2 text-center">
      <p className="font-display text-lg font-extrabold tabular-nums">{value}</p>
      <p className="text-xs text-stage-muted">{label}</p>
    </div>
  );
}

function SmallTicket({ ticket, locale, t, onTransfer }) {
  return (
    /* min-w-0 on the article itself, not only on the inner column.
       This card is a grid item (see the md:grid-cols-2 above), and a grid
       item's default min-width is auto, not 0 -- so the track was held to
       the card's min-content width, which is the two buttons side by side
       plus the image. That is ~406px, wider than a 360-390px phone, so the
       card ran past the screen edge instead of shrinking. */
    <article className="flex min-w-0 gap-3 rounded-card border border-line/10 bg-card p-3 shadow-card">
      <img src={ticket.event.image} alt="" className="size-20 shrink-0 rounded-control object-cover" />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate font-display font-bold">{eventText(ticket.event, "title", locale)}</h3>
            {/* Date and price were missing entirely -- the main TicketPass
                above shows both, so these secondary cards read thinner than
                they needed to by comparison, with nothing but a title and
                city to go on. */}
            <p className="text-sm text-muted">
              {longDate(ticket.event.start, locale)} · {ticket.event.city}
            </p>
          </div>
          <p className="shrink-0 font-display text-sm font-extrabold tabular-nums">{money(ticket.priceCents)} MAD</p>
        </div>
        {/* flex-wrap, so the two buttons stack rather than forcing the card
            wider than the viewport. "Transfer to a friend" alone is ~168px;
            the pair plus the thumbnail cannot fit a phone on one line. */}
        <div className="mt-2 flex flex-wrap gap-2">
          <Link to={`/billet/${ticket.id}`} className="inline-flex h-10 items-center rounded-full bg-action px-3.5 text-sm font-semibold text-action-fg transition hover:bg-action-hover">
            {t("seeQr")}
          </Link>
          <button type="button" className="h-10 rounded-full border border-line/20 bg-card px-3.5 text-sm font-semibold transition hover:bg-paper" onClick={onTransfer}>
            {t("transfer")}
          </button>
        </div>
      </div>
    </article>
  );
}

export default function Billets() {
  return (
    <Protected>
      <BilletsInner />
    </Protected>
  );
}
