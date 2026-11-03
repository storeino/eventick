import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Download, ExternalLink, Trash2, Undo2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { api, money } from "../../api";
import { useI18n } from "../../i18n";
import { eventText, longDate } from "../../utils";
import { useConfirm } from "./ConfirmContext";
import { useOrganisers } from "./useOrganisers";
import { Badge, Btn, EmptyState, FilterBar, IconBtn, PageHead, Pager } from "./ui";
import { text } from "./copy";

const PAGE_SIZE_DEFAULT = 20;

/**
 * Orders — one card per ticket.
 *
 * Rebuilt from a table whose five actions (admit/undo, open, refund, cancel,
 * cancel-order, delete) were squeezed into one "w-px whitespace-nowrap"
 * column, so the row kept widening every time a new action was added. A
 * card gives the buyer, the event, the price and the status their own line
 * each, and the actions a full-width row at the bottom where a sixth one
 * would not force the table wider still.
 *
 * Same card language as Placements: filters and the export button stay in
 * FilterBar above the grid, same pager below it. Still one row per TICKET,
 * not per order — closer to what an organiser is actually looking for at
 * the door than a per-order view would be.
 */
export default function Orders() {
  const { locale } = useI18n();
  const t = text[locale];
  const confirm = useConfirm();
  const { maySeeAllOrganisers, organisers } = useOrganisers();
  const [orders, setOrders] = useState(null);
  const [query, setQuery] = useState("");
  const [eventSlug, setEventSlug] = useState("");
  const [status, setStatus] = useState("");
  const [organiserId, setOrganiserId] = useState("");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(PAGE_SIZE_DEFAULT);

  const load = () => {
    const suffix = organiserId ? `?organiserId=${organiserId}` : "";
    api.get(`/organiser/orders/detailed${suffix}`).then((data) => setOrders(data.orders));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organiserId]);

  useEffect(() => {
    setPage(1);
  }, [query, eventSlug, status, limit]);

  const events = useMemo(() => {
    const map = new Map();
    for (const order of orders ?? []) {
      for (const ticket of order.tickets) map.set(ticket.event.slug, eventText(ticket.event, "title", locale));
    }
    return [...map.entries()];
  }, [orders, locale]);

  const allRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = [];
    for (const order of orders ?? []) {
      for (const ticket of order.tickets) {
        if (eventSlug && ticket.event.slug !== eventSlug) continue;
        if (status && ticket.status !== status) continue;
        if (needle && !`${order.holderName} ${order.email} ${order.id} ${ticket.ref} ${ticket.event.titleFr} ${ticket.event.titleAr}`.toLowerCase().includes(needle))
          continue;
        rows.push({ order, ticket });
      }
    }
    return rows;
  }, [orders, query, eventSlug, status]);

  const pages = Math.max(1, Math.ceil(allRows.length / limit));
  const rows = allRows.slice((page - 1) * limit, page * limit);

  const label = (value) =>
    value === "VALID" ? t.valid : value === "USED" ? t.used : value === "CANCELLED" ? t.cancelled : t.transferred;
  const tone = (value) =>
    value === "USED" ? "info" : value === "CANCELLED" ? "danger" : value === "TRANSFERRED" ? "warn" : "success";

  const cancelOrder = async (order) => {
    const ok = await confirm({
      title: t.confirmTitle,
      message: t.confirmCancelOrder,
      tone: "warn",
      confirmLabel: t.cancelOrder,
      cancelLabel: t.cancelBtn,
    });
    if (!ok) return;
    await api.post(`/organiser/orders/${order.id}/cancel`, {});
    load();
    toast.success(t.cancelled);
  };

  const removeOrder = async (order) => {
    const ok = await confirm({
      title: t.confirmTitle,
      message: t.confirmDeleteOrder,
      tone: "danger",
      confirmLabel: t.remove,
      cancelLabel: t.cancelBtn,
    });
    if (!ok) return;
    await api.del(`/organiser/orders/${order.id}`);
    load();
    toast.success(t.removed);
  };

  /*
   * No refund action here any more. Tickets are final sale: the only refund
   * in the product is a cancelled event, which refunds every order at once
   * from the event's own ↺ action.
   *
   * An organiser who has reversed a charge in the CMI back office still has
   * /orders/:id/reconcile-refund to void the tickets and square the books,
   * and /orders/:id/cancel to void a seat without returning money.
   */

  const toggleAdmit = async (ticket) => {
    const next = ticket.status === "USED" ? "VALID" : "USED";
    await api.patch(`/organiser/tickets/${ticket.id}/status`, { status: next });
    load();
    toast.success(next === "USED" ? t.admitted : t.undone);
  };

  const exportCsv = () => {
    const lines = [["order", "ref", "event", "holder", "email", "status", "price"]];
    for (const { order, ticket } of allRows) {
      lines.push([order.id, ticket.ref, ticket.event.titleFr, order.holderName, order.email, ticket.status, String(ticket.priceCents / 100)]);
    }
    const csv = lines.map((line) => line.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "eventick-reservations.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  const activeCount = [query, eventSlug, status].filter(Boolean).length;

  return (
    <div>
      <PageHead title={t.orders} sub={orders ? t.ordersSub.replace("{n}", String(allRows.length)) : undefined} />

      <FilterBar
        search={{ value: query, onChange: setQuery, placeholder: t.search }}
        controls={[
          ...(maySeeAllOrganisers
            ? [
                {
                  key: "organiser",
                  label: t.allOrganisers,
                  value: organiserId,
                  onChange: (e) => setOrganiserId(e.target.value),
                  style: { width: 200 },
                  options: [
                    { value: "", label: t.allOrganisers },
                    ...organisers.map((o) => ({ value: o.id, label: o.name })),
                  ],
                },
              ]
            : []),
          {
            key: "event",
            label: t.allEvents,
            value: eventSlug,
            onChange: (e) => setEventSlug(e.target.value),
            style: { width: 200 },
            options: [{ value: "", label: t.allEvents }, ...events.map(([slug, title]) => ({ value: slug, label: title }))],
          },
          {
            key: "status",
            label: t.colStatus,
            value: status,
            onChange: (e) => setStatus(e.target.value),
            style: { width: 160 },
            options: [
              { value: "", label: t.allStatus },
              { value: "VALID", label: t.valid },
              { value: "USED", label: t.used },
              { value: "TRANSFERRED", label: t.transferred },
              { value: "CANCELLED", label: t.cancelled },
            ],
          },
        ]}
        activeCount={activeCount}
        resetLabel={t.reset}
        onReset={() => {
          setQuery("");
          setEventSlug("");
          setStatus("");
        }}
        actions={
          <Btn variant="secondary" size="sm" disabled={allRows.length === 0} onClick={exportCsv}>
            <Download className="size-4" />
            {t.export}
          </Btn>
        }
      />

      {orders && rows.length === 0 ? (
        <EmptyState icon="🧾" title={activeCount ? t.noOrdersFilter : t.noOrdersYet} />
      ) : (
        <div className="grid gap-3">
          {rows.map(({ order, ticket }) => (
            <OrderCard
              key={ticket.id}
              order={order}
              ticket={ticket}
              locale={locale}
              t={t}
              badgeTone={tone(ticket.status)}
              badgeLabel={label(ticket.status)}
              onToggleAdmit={() => toggleAdmit(ticket)}
              onCancelOrder={() => cancelOrder(order)}
              onRemoveOrder={() => removeOrder(order)}
            />
          ))}
        </div>
      )}

      <Pager
        page={page}
        pages={pages}
        onPage={setPage}
        limit={limit}
        onLimit={setLimit}
        labels={{ rows: t.rows, prev: t.prev, next: t.next }}
      />
    </div>
  );
}

/**
 * One ticket, in the buyer's order.
 *
 * The buyer/event live on one line at the top (the two facts that identify
 * the row), the price and status sit to the end of that same line on a wide
 * screen and wrap below it on a phone, and every action gets a labelled
 * button on its own row rather than five icon buttons fighting for the same
 * fixed-width table cell.
 */
function OrderCard({ order, ticket, locale, t, badgeTone, badgeLabel, onToggleAdmit, onCancelOrder, onRemoveOrder }) {
  const initial = (order.holderName || "?").trim().slice(0, 1).toUpperCase();

  return (
    <article className="rounded-card border border-line/10 bg-card p-4 shadow-card sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-control bg-brume text-[13px] font-bold text-primary"
            aria-hidden
          >
            {initial}
          </span>
          <div className="min-w-0">
            {/* The buyer's name is the way in: it is the thing an organiser
                looks at while reading a row, so making it the link avoids a
                sixth icon in an action row that already has five. */}
            <Link
              to={`/pro/orders/${order.id}`}
              className="block truncate text-sm font-bold transition hover:text-primary hover:underline"
            >
              {order.holderName}
            </Link>
            <p className="truncate text-xs text-muted">{order.email}</p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <span className="font-mono text-xs font-bold text-primary">{ticket.ref}</span>
          <Badge tone={badgeTone}>{badgeLabel}</Badge>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3 border-t border-line/10 pt-4">
        <img src={ticket.event.image} alt="" className="size-11 shrink-0 rounded-control object-cover" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold">{eventText(ticket.event, "title", locale)}</p>
          <p className="truncate text-xs text-muted">
            {longDate(ticket.event.start, locale)} · {eventText(ticket, "tierName", locale)}
          </p>
        </div>
        <p className="shrink-0 text-end">
          <span className="block font-display text-subhead font-bold tabular-nums">{money(ticket.priceCents)}</span>
          <span className="block text-[11px] font-semibold text-muted">MAD</span>
        </p>
      </div>

      <div className="mt-4 flex flex-wrap justify-end gap-1.5 border-t border-line/10 pt-3.5">
        {ticket.status === "VALID" || ticket.status === "USED" ? (
          <IconBtn label={ticket.status === "USED" ? t.undo : t.admit} onClick={onToggleAdmit}>
            {ticket.status === "USED" ? <Undo2 className="size-4" /> : <Check className="size-4" />}
          </IconBtn>
        ) : null}
        <Link
          to={`/billet/${ticket.id}`}
          title={t.open}
          aria-label={t.open}
          className="inline-flex size-9 items-center justify-center rounded-control border border-line/15 bg-card text-muted transition hover:-translate-y-px hover:border-primary hover:bg-brume hover:text-primary"
        >
          <ExternalLink className="size-4" />
        </Link>
        <IconBtn label={t.cancelOrder} onClick={onCancelOrder}>
          <XCircle className="size-4" />
        </IconBtn>
        <IconBtn tone="danger" label={t.remove} onClick={onRemoveOrder}>
          <Trash2 className="size-4" />
        </IconBtn>
      </div>
    </article>
  );
}
