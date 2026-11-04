import { useCallback, useEffect, useState } from "react";
import { LayoutGrid, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, money } from "../../api";
import { useI18n } from "../../i18n";
import { useConfirm } from "./ConfirmContext";
import { EventSwitcher } from "./EventSwitcher";
import { Badge, Btn, EmptyState, IconBtn, Modal, PageHead } from "./ui";
import { text } from "./copy";
import { CheckOption, Dropdown, Field, Input, SalesWindow, salesWindowAt, splitSalesWindow, triggerControlClass } from "../../ui";
import { useOrganisers } from "./useOrganisers";
import { eventText, longDate } from "../../utils";

const BLANK = {
  nameFr: "",
  nameAr: "",
  zoneFr: "",
  zoneAr: "",
  gateFr: "",
  gateAr: "",
  priceCents: 10000,
  capacity: 100,
  numbered: false,
  seatsPerRow: 12,
  // Whether this tier is a PLACE, and where it sits on the plan.
  spatial: true,
  planOrder: "",
  // The sales window, held as date+time pairs because the pickers are
  // separate controls. Empty date = no bound on that side.
  openDate: "",
  openTime: "09:00",
  closeDate: "",
  closeTime: "23:59",
};

/**
 * Is this zone on sale right now, and if not, why not?
 *
 * The same question the backend's salesState answers — reimplemented here
 * rather than fetched, because it is a pure comparison of two timestamps
 * against the clock and a round trip to learn it would be absurd. The window
 * is stored UTC-naive, so the comparison is done on the raw ISO strings.
 */
function saleState(tier, nowIso) {
  if (tier.salesStartAt && nowIso < tier.salesStartAt) return { open: false, reason: "not_yet", at: tier.salesStartAt };
  if (tier.salesEndAt && nowIso >= tier.salesEndAt) return { open: false, reason: "closed", at: tier.salesEndAt };
  return { open: true };
}

/**
 * Placements — the seating zones of an event.
 *
 * Rebuilt from a plain HTML table into a card grid: a zone has a name, a
 * price, a jauge bar and an action pair, which a table forced into five
 * cramped cells with almost no breathing room. A tile gives each of those
 * its own visual weight — the jauge bar in particular reads as a bar now,
 * not a thin hairline squeezed under two numbers — and the grid reflows
 * naturally on a phone instead of forcing a table to scroll sideways.
 *
 * Tiers used to be fixed at creation, so a wrong price or a missing zone
 * meant deleting the event. This edits them in place, with the guards that
 * protect anyone already holding a ticket: capacity never drops below what's
 * sold, and a tier with sales can't be deleted.
 */
export default function Placements() {
  const { locale } = useI18n();
  const t = text[locale];
  const confirm = useConfirm();
  const [events, setEvents] = useState([]);
  const [slug, setSlug] = useState("");
  /**
   * An admin owns no events, so "which event" is not a question they can
   * answer on its own -- every event on the platform belongs to someone, and
   * a zone inherits that owner's payout, plan rate and bank account (see
   * resolveOwner in routes/organiser.ts). So for a caller with scope.any the
   * organiser is a REQUIRED first step, not a filter: nothing loads until one
   * is chosen. An organiser holds exactly one scope -- their own -- so for
   * them this control does not exist and the event picker is step one.
   */
  const { maySeeAllOrganisers, organisers } = useOrganisers();
  const [organiserId, setOrganiserId] = useState("");
  const [tiers, setTiers] = useState(null);
  /*
   * The shape of the room, which arranges the zones below.
   *
   * It lived on the event EDIT form, beside the venue's name — which put
   * the three fields that make up the site plan on two different screens,
   * and the odd one out behind an unlabelled pencil icon. The name is part
   * of the listing; the SHAPE is how these zones are drawn, so it belongs
   * with them.
   */
  const [venueKind, setVenueKind] = useState("STAGE");
  const [savingKind, setSavingKind] = useState(false);
  const [editing, setEditing] = useState(null); // tier object, or "new"
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Nothing to show an admin until they say whose events they mean.
    if (maySeeAllOrganisers && !organiserId) {
      setEvents([]);
      setSlug("");
      return;
    }
    const suffix = organiserId ? `?organiserId=${encodeURIComponent(organiserId)}` : "";
    api
      .get(`/organiser/events${suffix}`)
      .then((data) => {
        setEvents(data.events);
        // Switching organiser must not keep the previous one's event
        // selected -- that would load a slug this organiser does not own.
        setSlug(data.events.length ? data.events[0].slug : "");
      })
      .catch(() => {});
  }, [maySeeAllOrganisers, organiserId]);

  const load = useCallback(() => {
    if (!slug) return;
    api
      .get(`/organiser/events/${slug}/tiers`)
      .then((data) => setTiers(data.tiers))
      .catch((err) => toast.error(err.message));
  }, [slug]);

  useEffect(() => {
    setTiers(null);
    load();
  }, [load]);

  // Read off the events list already in state rather than re-fetching: the
  // switcher above has the event, and it carries venueKind.
  useEffect(() => {
    const current = events.find((e) => e.slug === slug);
    setVenueKind(current?.venueKind ?? "STAGE");
  }, [events, slug]);

  const saveVenueKind = async (next) => {
    const previous = venueKind;
    // Optimistic: the picker should not sit on the old value while the
    // request is in flight. Rolled back if the server refuses.
    setVenueKind(next);
    setSavingKind(true);
    try {
      await api.patch(`/organiser/events/${slug}`, { venueKind: next });
      toast.success(t.saved);
    } catch (err) {
      setVenueKind(previous);
      toast.error(err.message);
    } finally {
      setSavingKind(false);
    }
  };

  const openNew = () => {
    setForm(BLANK);
    setEditing("new");
  };

  const openEdit = (tier) => {
    const opens = splitSalesWindow(tier.salesStartAt, "09:00");
    const closes = splitSalesWindow(tier.salesEndAt, "23:59");
    setForm({
      nameFr: tier.nameFr,
      nameAr: tier.nameAr,
      zoneFr: tier.zoneFr,
      zoneAr: tier.zoneAr,
      gateFr: tier.gateFr,
      gateAr: tier.gateAr,
      priceCents: tier.priceCents,
      capacity: tier.capacity,
      numbered: tier.numbered,
      seatsPerRow: tier.seatsPerRow ?? 12,
      spatial: tier.spatial !== false,
      // Held as a string so the input can be emptied; sent as null.
      planOrder: typeof tier.planOrder === "number" ? String(tier.planOrder) : "",
      openDate: opens.date,
      openTime: opens.time,
      closeDate: closes.date,
      closeTime: closes.time,
    });
    setEditing(tier);
  };

  const save = async (e) => {
    e.preventDefault();
    if (busy) return;
    // Named here rather than left to the server, which cannot say which of
    // the two bounds the organiser got wrong.
    if (form.openDate && form.closeDate && `${form.openDate}T${form.openTime}` >= `${form.closeDate}T${form.closeTime}`) {
      toast.error(t.salesWindowInverted);
      return;
    }
    setBusy(true);
    try {
      // The four picker fields are a UI shape; the API takes two timestamps.
      // Zod would strip the extras silently, but sending them anyway invites
      // a future `.strict()` to start rejecting saves from this screen.
      const { openDate, openTime, closeDate, closeTime, ...rest } = form;
      const payload = {
        ...rest,
        salesStartAt: salesWindowAt(openDate, openTime),
        salesEndAt: salesWindowAt(closeDate, closeTime),
        // Empty means "no opinion", which the plan reads as "order me by
        // price" -- so it has to reach the server as null, not as 0 (which
        // would mean "nearest the stage") or as "" (which is not a number).
        planOrder: rest.planOrder === "" ? null : Number(rest.planOrder),
      };
      if (editing === "new") {
        await api.post(`/organiser/events/${slug}/tiers`, { ...payload, blurbFr: form.nameFr, blurbAr: form.nameAr });
      } else {
        await api.patch(`/organiser/tiers/${editing.id}`, payload);
      }
      setEditing(null);
      load();
      toast.success(t.saved);
    } catch (err) {
      // The server refuses a capacity below what's sold; show its number.
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (tier) => {
    const ok = await confirm({
      title: t.confirmTitle,
      message: `${t.remove} — ${eventText(tier, "name", locale)}`,
      tone: "danger",
      confirmLabel: t.remove,
      cancelLabel: t.cancelBtn,
    });
    if (!ok) return;
    try {
      await api.del(`/organiser/tiers/${tier.id}`);
      load();
      toast.success(t.removed);
    } catch (err) {
      toast.error(err.message);
    }
  };

  const field = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  /*
   * One timestamp for the whole render, so every zone is judged against the
   * same instant — and taken fresh each time the tiers are reloaded, which
   * is what the organiser does after changing a window.
   *
   * The stored window is UTC-naive wall-clock, so "now" has to be expressed
   * the same way to compare: toISOString() is UTC, which is the convention
   * the rest of the app stores event times in.
   */
  const nowIso = new Date().toISOString();

  return (
    <div>
      <PageHead
        title={t.placements}
        sub={t.placementsSub}
        actions={
          <>
            {/* Step 1, admins only. Placed BEFORE the event picker because it
                gates it: until an organiser is named there are no events to
                choose between. */}
            {maySeeAllOrganisers ? (
              <span className="inline-block w-56">
                <Dropdown
                  value={organiserId}
                  onChange={setOrganiserId}
                  options={organisers.map((o) => ({ value: o.id, label: o.name || o.email }))}
                  placeholder={t.pickOrganiser}
                  label={t.pickOrganiser}
                  triggerClassName={triggerControlClass({ className: "h-11" })}
                />
              </span>
            ) : null}
            {/* Step 2. Hidden rather than disabled while step 1 is unanswered:
                an empty picker invites a click that can do nothing. */}
            {!maySeeAllOrganisers || organiserId ? (
              <EventSwitcher
                events={events}
                value={slug}
                onChange={setSlug}
                locale={locale}
                labels={{ pick: t.pickEvent, search: t.searchEvents, noMatch: t.noNavResults }}
              />
            ) : null}
            <Btn onClick={openNew} disabled={!slug}>
              <Plus className="size-4" />
              {t.addZone}
            </Btn>
          </>
        }
      />

      {maySeeAllOrganisers && !organiserId ? (
        <EmptyState icon="👤" title={t.pickOrganiserFirst} body={t.pickOrganiserBody} />
      ) : !slug ? (
        // Two different "nothing selected" cases: an admin who picked an
        // organiser with no events needs to hear THAT, not "pick an event"
        // over a picker with nothing in it.
        <EmptyState
          icon="🎫"
          title={maySeeAllOrganisers && events.length === 0 ? t.organiserNoEvents : t.selectEventFirst}
        />
      ) : tiers && tiers.length === 0 ? (
        <EmptyState icon="🎪" title={t.noTiers} />
      ) : (
        <>
          {/* How the zones below are arranged on the public site plan. Above
              them because it decides what they look like. */}
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-card border border-line/10 bg-card p-4">
            <span className="min-w-0">
              <span className="block text-sm font-bold">{t.venueKindLabel}</span>
              <span className="block text-xs text-muted">{t.venueKindHint}</span>
            </span>
            <span className="ms-auto inline-block w-64">
              <Dropdown
                value={venueKind}
                onChange={saveVenueKind}
                label={t.venueKindLabel}
                disabled={savingKind}
                triggerClassName={triggerControlClass({ className: "h-11" })}
                options={[
                  { value: "STAGE", label: t.venueStage },
                  { value: "HALL", label: t.venueHall },
                  { value: "STADIUM", label: t.venueStadium },
                  { value: "COURSE", label: t.venueCourse },
                  { value: "EXPO", label: t.venueExpo },
                  { value: "OPEN_AIR", label: t.venueOpenAir },
                ]}
              />
            </span>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {(tiers ?? []).map((tier) => (
            <ZoneCard
              key={tier.id}
              tier={tier}
              locale={locale}
              t={t}
              nowIso={nowIso}
              onEdit={() => openEdit(tier)}
              onRemove={() => remove(tier)}
            />
            ))}
          </div>
        </>
      )}

      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        wide
        title={editing === "new" ? t.addZone : t.editZone}
        icon={<LayoutGrid className="size-5" />}
        footer={
          <>
            <Btn variant="secondary" onClick={() => setEditing(null)}>
              {t.close}
            </Btn>
            <Btn type="submit" form="tier-form" disabled={busy}>
              {t.save}
            </Btn>
          </>
        }
      >
        <form id="tier-form" className="grid gap-4 sm:grid-cols-2" onSubmit={save}>
          {/* The Arabic halves carry dir="rtl" so the text reads the right
              way round while the form itself stays in the page direction. */}
          <Field label={`${t.zoneName} (FR)`} required>
            {({ id, describedBy, invalid }) => (
              <Input id={id} describedBy={describedBy} invalid={invalid} value={form.nameFr} onChange={(e) => field("nameFr", e.target.value)} required minLength={1} />
            )}
          </Field>
          <Field label={`${t.zoneName} (AR)`} required>
            {({ id, describedBy, invalid }) => (
              <Input id={id} describedBy={describedBy} invalid={invalid} dir="rtl" value={form.nameAr} onChange={(e) => field("nameAr", e.target.value)} required minLength={1} />
            )}
          </Field>
          <Field label={`${t.zone} (FR)`} required>
            {({ id, describedBy, invalid }) => (
              <Input id={id} describedBy={describedBy} invalid={invalid} value={form.zoneFr} onChange={(e) => field("zoneFr", e.target.value)} required />
            )}
          </Field>
          <Field label={`${t.zone} (AR)`} required>
            {({ id, describedBy, invalid }) => (
              <Input id={id} describedBy={describedBy} invalid={invalid} dir="rtl" value={form.zoneAr} onChange={(e) => field("zoneAr", e.target.value)} required />
            )}
          </Field>
          <Field label={`${t.gateCol} (FR)`} required>
            {({ id, describedBy, invalid }) => (
              <Input id={id} describedBy={describedBy} invalid={invalid} value={form.gateFr} onChange={(e) => field("gateFr", e.target.value)} required />
            )}
          </Field>
          <Field label={`${t.gateCol} (AR)`} required>
            {({ id, describedBy, invalid }) => (
              <Input id={id} describedBy={describedBy} invalid={invalid} dir="rtl" value={form.gateAr} onChange={(e) => field("gateAr", e.target.value)} required />
            )}
          </Field>
          <Field label={`${t.price} (MAD)`}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                describedBy={describedBy}
                invalid={invalid}
                type="number"
                min={0}
                step="0.01"
                value={form.priceCents / 100}
                onChange={(e) => field("priceCents", Math.round(Number(e.target.value) * 100))}
              />
            )}
          </Field>
          {/* The sold-tickets floor was a loose <span> under the input, which
              a screen reader never tied to it. As Field's `hint` it is wired
              to aria-describedby, so it is read with the field. */}
          <Field
            label={t.capacityCol}
            hint={editing && editing !== "new" && editing.sold > 0 ? t.capacityLocked.replace("{n}", String(editing.sold)) : undefined}
          >
            {({ id, describedBy, invalid }) => (
              <Input id={id} describedBy={describedBy} invalid={invalid} type="number" min={1} value={form.capacity} onChange={(e) => field("capacity", Number(e.target.value))} />
            )}
          </Field>
          <div className="sm:col-span-2">
            <CheckOption label={t.numbered} checked={form.numbered} onChange={(checked) => field("numbered", checked)} />
          </div>

          {/* Where this tier sits on the public site plan — or whether it
              belongs there at all. A pass and a balcony are both tiers; only
              one of them is somewhere to stand. */}
          <div className="sm:col-span-2">
            <CheckOption label={t.tierSpatial} checked={form.spatial} onChange={(checked) => field("spatial", checked)} />
            <p className="px-2 text-xs text-muted">{t.tierSpatialHint}</p>
          </div>
          {form.spatial ? (
            <Field label={t.tierPlanOrder} hint={t.tierPlanOrderHint}>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  describedBy={describedBy}
                  invalid={invalid}
                  type="number"
                  min={0}
                  max={99}
                  placeholder={t.tierPlanOrderAuto}
                  value={form.planOrder}
                  onChange={(e) => field("planOrder", e.target.value)}
                />
              )}
            </Field>
          ) : null}
          {form.numbered ? (
            <Field label={t.seatsPerRow}>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  describedBy={describedBy}
                  invalid={invalid}
                  type="number"
                  min={1}
                  max={100}
                  value={form.seatsPerRow}
                  onChange={(e) => field("seatsPerRow", Number(e.target.value))}
                />
              )}
            </Field>
          ) : null}
          <div className="sm:col-span-2">
            <SalesWindow
              title={t.salesWindow}
              hint={t.salesWindowHint}
              locale={locale}
              labels={{ opens: t.salesOpensAt, closes: t.salesClosesAt, reset: t.reset }}
              openDate={form.openDate}
              openTime={form.openTime}
              closeDate={form.closeDate}
              closeTime={form.closeTime}
              onOpenDate={(v) => field("openDate", v)}
              onOpenTime={(v) => field("openTime", v)}
              onCloseDate={(v) => field("closeDate", v)}
              onCloseTime={(v) => field("closeTime", v)}
            />
          </div>
        </form>
      </Modal>
    </div>
  );
}

/** One zone. Price and the jauge bar get a full row each rather than being
 * squeezed into fixed-width table cells, so the bar actually reads as a bar. */
function ZoneCard({ tier, locale, t, nowIso, onEdit, onRemove }) {
  const sale = saleState(tier, nowIso);
  const left = tier.remaining;
  const total = tier.capacity;
  const ratio = total > 0 ? left / total : 0;
  const tone = ratio <= 0 ? "out" : ratio < 0.2 ? "low" : "ok";
  const barColor = { ok: "bg-success", low: "bg-accent", out: "bg-danger/40" }[tone];
  const textColor = { ok: "text-success", low: "text-accent", out: "text-danger" }[tone];

  return (
    <article className="flex flex-col gap-4 rounded-card border border-line/10 bg-card p-5 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-display text-subhead font-bold">{eventText(tier, "name", locale)}</h3>
          <p className="mt-0.5 truncate text-xs text-muted">
            {eventText(tier, "zone", locale)} · {t.gateCol} {eventText(tier, "gate", locale)}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <IconBtn label={t.edit} size="sm" onClick={onEdit}>
            <Pencil className="size-4" />
          </IconBtn>
          <IconBtn tone="danger" size="sm" label={t.remove} onClick={onRemove} disabled={tier.sold > 0}>
            <Trash2 className="size-4" />
          </IconBtn>
        </div>
      </div>

      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wide text-muted">{t.price}</p>
          <p className="mt-0.5 font-display text-heading font-bold tabular-nums">
            {money(tier.priceCents)} <span className="text-xs font-semibold text-muted">MAD</span>
          </p>
        </div>
        {tier.numbered ? (
          <Badge tone="info">
            {t.numbered} · {tier.seatsPerRow ?? 12}/{t.seatsPerRow.toLowerCase()}
          </Badge>
        ) : (
          <Badge tone="neutral">{t.freeSeating}</Badge>
        )}
      </div>

      {/* Only shown when a window actually constrains the zone. Printing "En
          vente" on every unconstrained zone would be noise — the useful
          signal is the one that is NOT selling, and why. */}
      {tier.salesStartAt || tier.salesEndAt ? (
        <div>
          {sale.open ? (
            <Badge tone="success">{t.onSale}</Badge>
          ) : (
            <Badge tone={sale.reason === "closed" ? "danger" : "warn"}>
              {sale.reason === "closed" ? t.salesClosed : t.notYetOnSale.replace("{d}", longDate(sale.at, locale))}
            </Badge>
          )}
        </div>
      ) : null}

      <div>
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <p className="text-[11px] font-bold uppercase tracking-wide text-muted">{t.capacityCol}</p>
          <p className="text-sm font-bold tabular-nums">
            <span className={textColor}>{left}</span>
            <span className="text-muted">/{total}</span>
          </p>
        </div>
        <div
          className="h-2 overflow-hidden rounded-full bg-sunken"
          role="progressbar"
          aria-valuenow={total > 0 ? Math.round((1 - ratio) * 100) : 0}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={t.capacityCol}
        >
          <div className={`h-full rounded-full transition-[width] ${barColor}`} style={{ width: `${Math.round((1 - ratio) * 100)}%` }} />
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-line/10 pt-3 text-xs">
        <span className="text-muted">{t.soldCol}</span>
        <span className="font-bold tabular-nums">{tier.sold}</span>
      </div>
    </article>
  );
}
