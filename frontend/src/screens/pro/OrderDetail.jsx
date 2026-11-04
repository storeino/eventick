import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, CreditCard, Receipt, Ticket as TicketIcon, User } from "lucide-react";
import { toast } from "sonner";
import { api, money } from "../../api";
import { useI18n } from "../../i18n";
import { eventText, longDate } from "../../utils";
import { Badge, Card, EmptyState, PageHead, Skeleton } from "./ui";
import { text } from "./copy";

/**
 * One order, in full.
 *
 * The list answers "which orders exist"; this answers "what happened to THIS
 * one" — the question an organiser is actually asked on the phone. It is a
 * page rather than a modal because it is reached from a link someone pastes
 * into a support thread, and a modal has no URL to paste.
 *
 * The audit trail is the half that distinguishes it from a bigger row: the
 * current status says a refund happened, the history says who issued it and
 * when, which is what a disputed charge turns on.
 */
export default function OrderDetail() {
  const { orderId } = useParams();
  const { locale } = useI18n();
  const t = text[locale];
  const [data, setData] = useState(null);
  const [missing, setMissing] = useState(false);

  const load = useCallback(() => {
    api
      .get(`/organiser/orders/${orderId}`)
      .then(setData)
      .catch((err) => {
        // 404 is a real answer ("no such order"), not a failure to report as
        // a toast that disappears — it gets its own empty state.
        if (err.status === 404) setMissing(true);
        else toast.error(err.message);
      });
  }, [orderId]);

  useEffect(load, [load]);

  if (missing) {
    return (
      <div>
        <BackLink t={t} />
        <EmptyState icon="🔎" title={t.orderNotFound} />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="grid gap-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const { order, event, promo, audit } = data;
  const tone =
    order.status === "PAID" ? "success" : order.status === "REFUNDED" ? "warn" : order.status === "CANCELLED" ? "danger" : "neutral";

  return (
    <div>
      <BackLink t={t} />

      <PageHead
        title={t.orderDetail}
        sub={`${eventText(event, "title", locale)} · ${longDate(event.startAt, locale)}`}
        actions={<Badge tone={tone}>{order.status}</Badge>}
      />

      {/* min-w-0 on both direct grid items: a grid item defaults to
          min-width: auto, so without it each column is held to its own
          content's min-content width instead of the grid track —
          overflowing the viewport on the single-column mobile layout. */}
      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="grid min-w-0 gap-4">
          <Card>
            <SectionTitle icon={<User className="size-4" />}>{t.buyerSection}</SectionTitle>
            <dl className="mt-3 grid gap-2.5 sm:grid-cols-2">
              <Row label={t.buyerNameLabel} value={order.holderName} />
              <Row label="Email" value={order.email} />
              {order.phone ? <Row label="Tel" value={order.phone} /> : null}
              <Row label={t.placedOn} value={longDate(order.createdAt, locale)} />
            </dl>
          </Card>

          <Card>
            <SectionTitle icon={<TicketIcon className="size-4" />}>
              {t.ticketsSection} ({order.tickets.length})
            </SectionTitle>
            <ul className="mt-3 grid gap-2.5">
              {order.tickets.map((ticket) => (
                <li
                  key={ticket.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-control bg-paper px-3.5 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{ticket.holderName}</p>
                    <p className="truncate text-xs text-muted">
                      {eventText(ticket, "tierName", locale)}
                      {ticket.seatRow ? ` · ${ticket.seatRow}-${ticket.seatNumber}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2.5">
                    <span className="font-mono text-xs text-muted">{ticket.ref}</span>
                    <Badge tone={ticket.status === "VALID" ? "success" : ticket.status === "USED" ? "neutral" : "danger"}>
                      {ticket.status}
                    </Badge>
                    <Link to={`/billet/${ticket.id}`} className="text-xs font-semibold text-primary underline">
                      {t.viewTicketLink}
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <SectionTitle icon={<Receipt className="size-4" />}>{t.historySection}</SectionTitle>
            {audit.length === 0 ? (
              <p className="mt-3 text-sm text-muted">{t.noHistory}</p>
            ) : (
              <ol className="mt-3 grid gap-2.5">
                {audit.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line/10 pb-2.5 last:border-0">
                    <span className="font-mono text-xs font-semibold">{row.action}</span>
                    <span className="text-xs text-muted">
                      {row.actorEmail} · {longDate(row.at, locale)}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>

        <Card className="h-fit min-w-0">
          <SectionTitle icon={<CreditCard className="size-4" />}>{t.paymentSection}</SectionTitle>
          <dl className="mt-3 grid gap-2">
            <Line label={t.subtotalLabel} value={`${money(order.subtotalCents)} MAD`} />
            {order.discountCents > 0 ? (
              <Line label={t.discountLabel} value={`−${money(order.discountCents)} MAD`} />
            ) : null}
            <Line label={t.totalLabel} value={`${money(order.totalCents)} MAD`} strong />
            {order.refundedCents > 0 ? (
              <Line label={t.refundedLabel} value={`${money(order.refundedCents)} MAD`} tone="warn" />
            ) : null}
          </dl>

          <div className="mt-4 grid gap-2 border-t border-line/10 pt-4 text-xs">
            {order.paymentRef ? <Row label={t.paymentRefLabel} value={order.paymentRef} mono /> : null}
            {order.cardLast4 ? (
              <Row label={t.cardLabel} value={`${order.cardBrand ?? ""} ···· ${order.cardLast4}`} />
            ) : null}
            {promo ? <Row label={t.promoUsed} value={promo.code} mono /> : null}
          </div>
        </Card>
      </div>
    </div>
  );
}

function BackLink({ t }) {
  return (
    <Link
      to="/pro/orders"
      className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-muted transition hover:text-primary"
    >
      <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />
      {t.backToOrders}
    </Link>
  );
}

function SectionTitle({ icon, children }) {
  return (
    <h2 className="flex items-center gap-2 font-display text-subhead font-bold">
      <span className="text-muted" aria-hidden>
        {icon}
      </span>
      {children}
    </h2>
  );
}

function Row({ label, value, mono = false }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className={`truncate text-sm font-semibold${mono ? " font-mono" : ""}`}>{value}</dd>
    </div>
  );
}

function Line({ label, value, strong = false, tone }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-sm text-muted">{label}</dt>
      <dd
        className={[
          "tabular-nums",
          strong ? "font-display text-subhead font-bold" : "text-sm font-semibold",
          tone === "warn" ? "text-warn" : "",
        ].join(" ")}
      >
        {value}
      </dd>
    </div>
  );
}
