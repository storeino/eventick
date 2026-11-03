import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Ban, Copy, ExternalLink, Eye, EyeOff, Mail, Pencil, SlidersHorizontal, Ticket, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { api, money } from "../../api";
import { useAuth } from "../../AuthContext";
import { categoryLabel, useI18n } from "../../i18n";
import { CATEGORIES, CITIES, eventText, longDate, totalCapacity, totalRemaining } from "../../utils";
import { useConfirm } from "./ConfirmContext";
import { useOrganisers } from "./useOrganisers";
import { Badge, Btn, EmptyState, FilterBar, IconBtn, Modal, PageHead } from "./ui";
import { text } from "./copy";
import { CheckOption, Dropdown, Field, Input, Notice, Textarea, triggerControlClass } from "../../ui";

export default function Events() {
  const { locale, t: tr } = useI18n();
  const t = text[locale];
  const navigate = useNavigate();
  const confirm = useConfirm();
  // Cancelling needs finance.refund, NOT events.manage: it moves money for
  // every buyer at once (see the route's own comment). This whole screen is
  // gated on events.manage, so without this check the action would be a
  // button that 403s for most of the people who can see it.
  const { can } = useAuth();
  const mayRefund = can("finance.refund");
  const { maySeeAllOrganisers, organisers } = useOrganisers();
  const [events, setEvents] = useState(null);
  const [orders, setOrders] = useState(null);
  const [query, setQuery] = useState("");
  const [city, setCity] = useState("");
  const [visibility, setVisibility] = useState("");
  const [organiserId, setOrganiserId] = useState("");
  const [edit, setEdit] = useState(null);
  const [titleFr, setTitleFr] = useState("");
  const [titleAr, setTitleAr] = useState("");
  const [editCity, setEditCity] = useState("Casablanca");
  // The rest of the listing. Everything a buyer reads and an organiser can
  // mistype -- none of it was correctable before, and an event with sales
  // cannot be deleted and rebuilt, so a typo in the venue was permanent.
  const [editCategory, setEditCategory] = useState("festivals");
  const [editVenueFr, setEditVenueFr] = useState("");
  // The SHAPE of the room, which decides how the public site plan is
  // drawn. Separate from the venue NAME beside it: "Grand Théâtre" does
  // not tell the page whether to draw rows facing a stage or a bowl.
  const [editVenueKind, setEditVenueKind] = useState("STAGE");
  const [editVenueAr, setEditVenueAr] = useState("");
  const [editAddress, setEditAddress] = useState("");
  const [editImage, setEditImage] = useState("");
  const [editBlurbFr, setEditBlurbFr] = useState("");
  const [editBlurbAr, setEditBlurbAr] = useState("");
  const [editAboutFr, setEditAboutFr] = useState("");
  const [editAboutAr, setEditAboutAr] = useState("");
  const [editAgeFr, setEditAgeFr] = useState("");
  const [editAgeAr, setEditAgeAr] = useState("");
  const [contact, setContact] = useState(null);
  const [audience, setAudience] = useState(null);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  // Calling an event off.
  const [cancelling, setCancelling] = useState(null);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelNotify, setCancelNotify] = useState(true);
  const [cancelBusy, setCancelBusy] = useState(false);
  // The per-event sales rules, editable after the event exists.
  const [rules, setRules] = useState(null);
  const [rulesMax, setRulesMax] = useState(10);
  const [rulesResale, setRulesResale] = useState(false);

  // The ?organiserId= suffix is only ever meaningful for an admin -- the
  // backend ignores it for anyone else (see requestedOrganiserId in
  // organiser.ts), so appending it unconditionally here is safe either way.
  const suffix = organiserId ? `?organiserId=${organiserId}` : "";

  const load = () => {
    api.get(`/organiser/events${suffix}`).then((data) => setEvents(data.events));
    api.get(`/organiser/orders/detailed${suffix}`).then((data) => setOrders(data.orders));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organiserId]);

  const rows = useMemo(() => {
    if (!events || !orders) return [];
    const needle = query.trim().toLowerCase();
    return events
      .map((event) => {
        const tickets = orders
          .flatMap((order) => order.tickets)
          .filter((ticket) => ticket.event.slug === event.slug && ticket.status !== "CANCELLED");
        return {
          event,
          issued: tickets.length,
          revenue: tickets.reduce((sum, ticket) => sum + ticket.priceCents, 0),
          left: totalRemaining(event),
          cap: totalCapacity(event),
          hidden: event.status === "HIDDEN",
          cancelled: Boolean(event.cancelledAt),
        };
      })
      .filter((row) => {
        if (city && row.event.city !== city) return false;
        if (visibility === "live" && row.hidden) return false;
        if (visibility === "hidden" && !row.hidden) return false;
        if (!needle) return true;
        return `${row.event.titleFr} ${row.event.titleAr} ${row.event.city}`.toLowerCase().includes(needle);
      })
      .sort((a, b) => b.issued - a.issued || a.event.start.localeCompare(b.event.start));
  }, [events, orders, query, city, visibility]);

  const cities = useMemo(() => [...new Set((events ?? []).map((event) => event.city))].sort(), [events]);

  const openEdit = (event) => {
    setEdit(event);
    // Both titles, each in its own field. Loading only the current locale's
    // and writing it to both overwrote the Arabic title with French text the
    // moment an organiser edited the city.
    setTitleFr(event.titleFr);
    setTitleAr(event.titleAr);
    setEditCity(event.city);
    setEditCategory(event.category ?? "festivals");
    setEditVenueFr(event.venueFr ?? "");
    setEditVenueKind(event.venueKind ?? "STAGE");
    setEditVenueAr(event.venueAr ?? "");
    setEditAddress(event.address ?? "");
    setEditImage(event.image ?? "");
    setEditBlurbFr(event.blurbFr ?? "");
    setEditBlurbAr(event.blurbAr ?? "");
    setEditAboutFr(event.aboutFr ?? "");
    setEditAboutAr(event.aboutAr ?? "");
    setEditAgeFr(event.ageFr ?? "");
    setEditAgeAr(event.ageAr ?? "");
  };

  const save = async (e) => {
    e.preventDefault();
    try {
      await api.patch(`/organiser/events/${edit.slug}`, {
        titleFr,
        titleAr,
        category: editCategory,
        city: editCity,
        venueFr: editVenueFr,
        venueKind: editVenueKind,
        venueAr: editVenueAr,
        address: editAddress,
        image: editImage,
        blurbFr: editBlurbFr,
        blurbAr: editBlurbAr,
        aboutFr: editAboutFr,
        aboutAr: editAboutAr,
        ageFr: editAgeFr,
        ageAr: editAgeAr,
      });
      setEdit(null);
      load();
      toast.success(t.saved);
    } catch (err) {
      // The widened form can be refused now -- a venue under two characters,
      // an address under three. Showing why beats closing the modal and
      // losing what was typed.
      toast.error(err.message);
    }
  };

  const openContact = async (event) => {
    setContact(event);
    setSubject("");
    setMessage("");
    setAudience(null);
    const data = await api.get(`/organiser/events/${event.slug}/audience`);
    setAudience(data.count);
  };

  const sendBroadcast = async (e) => {
    e.preventDefault();
    if (sending) return;
    setSending(true);
    try {
      const res = await api.post(`/organiser/events/${contact.slug}/broadcast`, { subject, message });
      // `sent` can be 0 while `recipients` is not, when no mail provider is
      // configured — say so rather than claiming a successful send.
      if (res.sent > 0) toast.success(t.sentOk.replace("{n}", String(res.sent)));
      else toast.warning(t.sentNone);
      setContact(null);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSending(false);
    }
  };

  const toggleHidden = async (slug, hidden) => {
    // Restoring a CANCELLED event is refused with a 409 -- its tickets are
    // already refunded and voided. The button is hidden for that case, so
    // this catch is the backstop rather than the message.
    try {
      await api.patch(`/organiser/events/${slug}/visibility`, { hidden });
      load();
      toast.success(t.saved);
    } catch (err) {
      toast.error(err.message);
    }
  };

  const removeEvent = async (event) => {
    const ok = await confirm({
      title: t.confirmTitle,
      message: t.confirmDeleteEvent,
      tone: "danger",
      confirmLabel: t.remove,
      cancelLabel: t.cancelBtn,
    });
    if (!ok) return;
    // An event anyone has ordered against cannot be deleted — the server
    // answers 409 and says to hide it instead. Uncaught, that rejected and
    // the success toast fired anyway, so the row stayed on screen under a
    // message claiming it was gone.
    try {
      await api.del(`/organiser/events/${event.slug}`);
      load();
      toast.success(t.removed);
    } catch (err) {
      toast.error(err.message);
    }
  };

  const openRules = (event) => {
    setRules(event);
    setRulesMax(event.maxPerBuyer ?? 10);
    setRulesResale(Boolean(event.allowResale));
  };

  const saveRules = async (e) => {
    e.preventDefault();
    try {
      await api.patch(`/organiser/events/${rules.slug}/settings`, {
        maxPerBuyer: rulesMax,
        allowResale: rulesResale,
      });
      setRules(null);
      load();
      toast.success(t.saved);
    } catch (err) {
      toast.error(err.message);
    }
  };

  const openCancel = (event) => {
    setCancelling(event);
    setCancelReason("");
    setCancelNotify(true);
  };

  const submitCancel = async (e) => {
    e.preventDefault();
    if (cancelBusy) return;
    // Asked separately from the form's own validation: this refunds every
    // buyer of the event and cannot be undone, so the organiser should have
    // to say yes to it twice.
    const ok = await confirm({
      title: t.cancelEvent,
      message: t.cancelEventIrreversible,
      tone: "danger",
      confirmLabel: t.cancelConfirmBtn,
      cancelLabel: t.cancelBtn,
    });
    if (!ok) return;
    setCancelBusy(true);
    try {
      const result = await api.post(`/organiser/events/${cancelling.slug}/cancel`, {
        reason: cancelReason,
        notify: cancelNotify,
      });
      setCancelling(null);
      load();
      /*
       * `ticketsVoided` counts only the tickets the final sweep still had to
       * cancel — and in the normal case refundOrder has already cancelled
       * every one of them, so it comes back 0. Reporting that number alone
       * read as "nothing happened" on the one screen where the organiser
       * most needs to know that it did. The figures that are true either
       * way are the orders refunded and the money returned.
       */
      toast.success(
        t.cancelDone
          .replace("{n}", String(result.refunded))
          .replace("{m}", money(result.refundedCents)),
      );
      // A partial failure is the case that actually needs the organiser's
      // attention, and a success toast alone would bury it.
      if (result.failed?.length > 0) {
        toast.warning(t.cancelPartial.replace("{n}", String(result.failed.length)), { duration: 10_000 });
      }
    } catch (err) {
      toast.error(err.message);
    } finally {
      setCancelBusy(false);
    }
  };

  const duplicate = (event) => {
    // No duplicate endpoint — prefill the organiser form, same effect as the
    // old client-side copy-with-new-slug.
    sessionStorage.setItem(
      "eventick-duplicate",
      JSON.stringify({
        titleFr: `${event.titleFr} · copie`,
        titleAr: `${event.titleAr} · نسخة`,
        city: event.city,
        venue: event.venueFr,
        about: event.aboutFr,
        price: (event.tiers[0]?.priceCents ?? 0) / 100,
        stock: event.tiers[0]?.capacity ?? 0,
        cover: event.image,
      }),
    );
    navigate("/organiser");
  };

  const exportGuests = (event) => {
    const lines = [["ref", "holder", "status", "tier", "price"]];
    for (const order of orders) {
      for (const ticket of order.tickets) {
        if (ticket.event.slug !== event.slug) continue;
        lines.push([ticket.ref, ticket.holderName, ticket.status, eventText(ticket, "tierName", locale), String(ticket.priceCents / 100)]);
      }
    }
    /*
     * Say something either way.
     *
     * This downloaded silently: on an event with no sales it produced a file
     * containing only the header row, which looks identical to a download
     * that failed. The button carries a people icon and reads "Attendees",
     * so a silent no-op is the one outcome that cannot be told apart from a
     * broken button.
     */
    if (lines.length === 1) {
      toast.warning(t.noAttendees);
      return;
    }
    const csv = lines.map((line) => line.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${event.slug}-participants.csv`;
    link.click();
    URL.revokeObjectURL(url);
    toast.success(t.attendeesExported.replace("{n}", String(lines.length - 1)));
  };

  const activeCount = [query, city, visibility].filter(Boolean).length;

  return (
    <div>
      <PageHead
        title={t.events}
        sub={events ? t.eventsSub.replace("{n}", String(events.length)) : undefined}
        actions={
          <Link
            to="/organiser"
            className="inline-flex h-11 items-center rounded-full bg-action px-4 text-sm font-semibold text-action-fg transition hover:bg-action-hover active:scale-[0.97]"
          >
            {t.create}
          </Link>
        }
      />

      {/* The organiser-scope control only exists for an admin -- an
          organiser's FilterBar is unchanged. Kept out of activeCount/reset
          deliberately: it's a viewing scope, not a content filter, so
          clearing filters shouldn't also silently kick an admin back to
          "all organisers". */}
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
            key: "city",
            label: t.allEvents,
            value: city,
            onChange: (e) => setCity(e.target.value),
            style: { width: 170 },
            options: [{ value: "", label: t.allEvents }, ...cities.map((name) => ({ value: name, label: name }))],
          },
          {
            key: "visibility",
            label: t.allStatus2,
            value: visibility,
            onChange: (e) => setVisibility(e.target.value),
            style: { width: 160 },
            options: [
              { value: "", label: t.allStatus2 },
              { value: "live", label: t.public },
              { value: "hidden", label: t.hidden },
            ],
          },
        ]}
        activeCount={activeCount}
        resetLabel={t.reset}
        onReset={() => {
          setQuery("");
          setCity("");
          setVisibility("");
        }}
      />

      {events && rows.length === 0 ? (
        <EmptyState icon="📅" title={activeCount ? t.noEventsFilter : t.noEventsYet} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((row) => (
            <EventRow
              key={row.event.slug}
              row={row}
              locale={locale}
              t={t}
              onEdit={() => openEdit(row.event)}
              onDuplicate={() => duplicate(row.event)}
              onGuests={() => exportGuests(row.event)}
              onContact={() => openContact(row.event)}
              onToggleHidden={() => toggleHidden(row.event.slug, !row.hidden)}
              onRemove={() => removeEvent(row.event)}
              onRules={() => openRules(row.event)}
              onCancel={mayRefund ? () => openCancel(row.event) : null}
            />
          ))}
        </div>
      )}

      <Modal
        open={Boolean(edit)}
        onClose={() => setEdit(null)}
        title={t.edit}
        sub={edit ? edit.slug : undefined}
        icon={<Pencil className="size-5" />}
        footer={
          <>
            <Btn variant="secondary" onClick={() => setEdit(null)}>
              {t.close}
            </Btn>
            <Btn type="submit" form="event-edit">
              {t.save}
            </Btn>
          </>
        }
      >
        <form id="event-edit" className="grid gap-4" onSubmit={save}>
          <Field label={t.titleFrLabel} required>
            {({ id, describedBy, invalid, required }) => (
              <Input
                id={id}
                describedBy={describedBy}
                invalid={invalid}
                required={required}
                value={titleFr}
                onChange={(e) => setTitleFr(e.target.value)}
                minLength={3}
              />
            )}
          </Field>
          <Field label={t.titleArLabel} required>
            {({ id, describedBy, invalid, required }) => (
              <Input
                id={id}
                describedBy={describedBy}
                invalid={invalid}
                required={required}
                dir="rtl"
                value={titleAr}
                onChange={(e) => setTitleAr(e.target.value)}
                minLength={3}
              />
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t.categoryLabel}>
              {({ id, describedBy, invalid }) => (
                <Dropdown
                  label={t.categoryLabel}
                  id={id}
                  describedBy={describedBy}
                  value={editCategory}
                  onChange={setEditCategory}
                  options={CATEGORIES.map((value) => ({ value, label: categoryLabel(value, tr) }))}
                  triggerClassName={triggerControlClass({ invalid })}
                />
              )}
            </Field>
            <Field label={t.cityLabel}>
              {({ id, describedBy, invalid }) => (
                <Dropdown
                  label={t.cityLabel}
                  id={id}
                  describedBy={describedBy}
                  value={editCity}
                  onChange={setEditCity}
                  options={CITIES.map((name) => ({ value: name, label: name }))}
                  triggerClassName={triggerControlClass({ invalid })}
                />
              )}
            </Field>
          </div>

          {/* The venue and address were unreachable after creation, so a
              misspelled hall or a wrong street was permanent on an event
              that had already sold — the two mistakes that actually strand
              someone at the door. */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t.venueFrLabel}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} describedBy={describedBy} invalid={invalid} value={editVenueFr} onChange={(e) => setEditVenueFr(e.target.value)} minLength={2} />
              )}
            </Field>
            <Field label={t.venueArLabel}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} describedBy={describedBy} invalid={invalid} dir="rtl" value={editVenueAr} onChange={(e) => setEditVenueAr(e.target.value)} minLength={2} />
              )}
            </Field>
          </div>
          <Field label={t.venueKindLabel} hint={t.venueKindHint}>
            {({ id, describedBy, invalid }) => (
              <Dropdown
                id={id}
                describedBy={describedBy}
                value={editVenueKind}
                onChange={setEditVenueKind}
                label={t.venueKindLabel}
                triggerClassName={triggerControlClass({ invalid })}
                options={[
                  { value: "STAGE", label: t.venueStage },
                  { value: "HALL", label: t.venueHall },
                  { value: "STADIUM", label: t.venueStadium },
                  { value: "COURSE", label: t.venueCourse },
                  { value: "EXPO", label: t.venueExpo },
                  { value: "OPEN_AIR", label: t.venueOpenAir },
                ]}
              />
            )}
          </Field>
          <Field label={t.addressLabel} hint={t.addressHint}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} describedBy={describedBy} invalid={invalid} value={editAddress} onChange={(e) => setEditAddress(e.target.value)} minLength={3} />
            )}
          </Field>

          <Field label={t.coverLabel} hint={t.coverHint}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} describedBy={describedBy} invalid={invalid} value={editImage} onChange={(e) => setEditImage(e.target.value)} />
            )}
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t.blurbFrLabel} hint={t.blurbHint}>
              {({ id, describedBy, invalid }) => (
                <Textarea id={id} describedBy={describedBy} invalid={invalid} rows={2} value={editBlurbFr} onChange={(e) => setEditBlurbFr(e.target.value)} />
              )}
            </Field>
            <Field label={t.blurbArLabel} hint={t.blurbHint}>
              {({ id, describedBy, invalid }) => (
                <Textarea id={id} describedBy={describedBy} invalid={invalid} dir="rtl" rows={2} value={editBlurbAr} onChange={(e) => setEditBlurbAr(e.target.value)} />
              )}
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t.aboutFrLabel}>
              {({ id, describedBy, invalid }) => (
                <Textarea id={id} describedBy={describedBy} invalid={invalid} rows={4} value={editAboutFr} onChange={(e) => setEditAboutFr(e.target.value)} />
              )}
            </Field>
            <Field label={t.aboutArLabel}>
              {({ id, describedBy, invalid }) => (
                <Textarea id={id} describedBy={describedBy} invalid={invalid} dir="rtl" rows={4} value={editAboutAr} onChange={(e) => setEditAboutAr(e.target.value)} />
              )}
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t.ageFrLabel} hint={t.ageHint}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} describedBy={describedBy} invalid={invalid} value={editAgeFr} onChange={(e) => setEditAgeFr(e.target.value)} />
              )}
            </Field>
            <Field label={t.ageArLabel} hint={t.ageHint}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} describedBy={describedBy} invalid={invalid} dir="rtl" value={editAgeAr} onChange={(e) => setEditAgeAr(e.target.value)} />
              )}
            </Field>
          </div>

          {/* Dates are absent on purpose: moving a date buyers have planned
              around has to tell them, and no route accepts one yet. */}
          <Notice tone="info">{t.editDatesNote}</Notice>
        </form>
      </Modal>

      <Modal
        open={Boolean(contact)}
        onClose={() => setContact(null)}
        wide
        title={t.contact}
        sub={
          contact
            ? audience === null
              ? locale === "ar"
                ? contact.titleAr
                : contact.titleFr
              : t.contactSub.replace("{n}", String(audience))
            : undefined
        }
        icon={<Mail className="size-5" />}
        footer={
          <>
            <Btn variant="secondary" onClick={() => setContact(null)}>
              {t.close}
            </Btn>
            <Btn type="submit" form="broadcast-form" disabled={sending || audience === 0}>
              {sending ? t.sending : t.send}
            </Btn>
          </>
        }
      >
        {audience === 0 ? (
          <EmptyState icon="📭" title={t.contactNone} />
        ) : (
          <form id="broadcast-form" className="grid gap-4" onSubmit={sendBroadcast}>
            <Field label={t.subject} required>
              {({ id, describedBy, invalid, required }) => (
                <Input
                  id={id}
                  describedBy={describedBy}
                  invalid={invalid}
                  required={required}
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  minLength={3}
                  maxLength={150}
                />
              )}
            </Field>
            <Field label={t.message} required>
              {({ id, describedBy, invalid }) => (
                <Textarea
                  id={id}
                  describedBy={describedBy}
                  invalid={invalid}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  minLength={10}
                  maxLength={5000}
                  required
                />
              )}
            </Field>
          </form>
        )}
      </Modal>

      <Modal
        open={Boolean(rules)}
        onClose={() => setRules(null)}
        title={t.eventSettings}
        sub={t.eventSettingsSub}
        icon={<SlidersHorizontal className="size-5" />}
        footer={
          <>
            <Btn variant="secondary" onClick={() => setRules(null)}>
              {t.close}
            </Btn>
            <Btn type="submit" form="event-rules">
              {t.save}
            </Btn>
          </>
        }
      >
        <form id="event-rules" className="grid gap-4" onSubmit={saveRules}>
          <Field label={t.maxPerBuyer} hint={t.maxPerBuyerHint}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                describedBy={describedBy}
                invalid={invalid}
                type="number"
                min={0}
                max={100}
                value={rulesMax}
                onChange={(e) => setRulesMax(Number(e.target.value))}
              />
            )}
          </Field>
          <div>
            <CheckOption label={t.allowResale} checked={rulesResale} onChange={setRulesResale} />
            <p className="px-2 text-xs text-muted">{t.allowResaleHint}</p>
          </div>
        </form>
      </Modal>

      <Modal
        open={Boolean(cancelling)}
        onClose={() => setCancelling(null)}
        title={t.cancelEvent}
        sub={cancelling ? (eventText(cancelling, "title", locale)) : undefined}
        icon={<Ban className="size-5" />}
        footer={
          <>
            <Btn variant="secondary" onClick={() => setCancelling(null)}>
              {t.close}
            </Btn>
            <Btn type="submit" form="event-cancel" variant="danger" disabled={cancelBusy}>
              {t.cancelConfirmBtn}
            </Btn>
          </>
        }
      >
        <form id="event-cancel" className="grid gap-4" onSubmit={submitCancel}>
          {/* Spelled out rather than left to the button's label: refunding
              every buyer and voiding every ticket is not what "cancel"
              implies on its own, and this is the last screen before it
              happens. */}
          <Notice tone="danger">{t.cancelEventWhat}</Notice>
          <Field label={t.cancelReasonLabel} hint={t.cancelReasonHint} required>
            {({ id, describedBy, invalid, required }) => (
              <Textarea
                id={id}
                describedBy={describedBy}
                invalid={invalid}
                required={required}
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                minLength={5}
                maxLength={500}
              />
            )}
          </Field>
          <CheckOption label={t.cancelNotify} checked={cancelNotify} onChange={setCancelNotify} />
        </form>
      </Modal>
    </div>
  );
}

/**
 * One event, in the organiser's own list.
 *
 * Rebuilt from a table row whose five actions were squeezed into a single
 * "w-px whitespace-nowrap" cell, same issue as Orders and Placements had.
 * The poster, issued/remaining/revenue stats and visibility badge sit in
 * their own rows here, and the jauge bar reuses Placements' colour logic
 * (success/accent/danger by remaining ratio) instead of StockCell's tight
 * table-cell layout.
 */
function EventRow({ row, locale, t, onEdit, onDuplicate, onGuests, onContact, onToggleHidden, onRemove, onRules, onCancel }) {
  const { event, issued, revenue, left, cap, hidden, cancelled } = row;
  const ratio = cap > 0 ? left / cap : 0;
  const tone = ratio <= 0 ? "out" : ratio < 0.2 ? "low" : "ok";
  const barColor = { ok: "bg-success", low: "bg-accent", out: "bg-danger/40" }[tone];
  const textColor = { ok: "text-success", low: "text-accent", out: "text-danger" }[tone];

  return (
    <article className="flex flex-col gap-4 rounded-card border border-line/10 bg-card p-5 shadow-card">
      <div className="flex items-start gap-3">
        <img src={event.image} alt="" className="size-14 shrink-0 rounded-control object-cover" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-display text-subhead font-bold">{eventText(event, "title", locale)}</h3>
          <p className="mt-0.5 truncate text-xs text-muted">
            {event.city} · {longDate(event.start, locale)}
          </p>
          {/* Only an admin's list can hold more than one organiser's events,
              and the server sends this field only to them — so its presence
              is the condition, not a role check repeated here. `null` means
              the owning account was deleted, which is worth saying out loud
              rather than leaving the card looking ownerless by accident. */}
          {event.organiser !== undefined ? (
            <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted">
              <Users className="size-3 shrink-0" aria-hidden />
              <span className="truncate">
                {event.organiser ? event.organiser.name || event.organiser.email : t.ownerGone}
              </span>
            </p>
          ) : null}
        </div>
        {/* Cancelled outranks hidden/public: the event being off sale for
            good is the fact that matters, and cancelEvent hides it too, so
            otherwise it would read as merely "Masqué". */}
        <Badge tone={cancelled ? "danger" : hidden ? "neutral" : "success"}>
          {cancelled ? t.alreadyCancelled : hidden ? t.hidden : t.public}
        </Badge>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wide text-muted">{t.issued}</p>
          <p className="mt-0.5 flex items-center gap-1.5 font-display text-heading font-bold tabular-nums">
            <Ticket className="size-4 text-muted" aria-hidden />
            {issued}
          </p>
        </div>
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wide text-muted">{t.revenue}</p>
          <p className="mt-0.5 font-display text-heading font-bold tabular-nums">
            {money(revenue)} <span className="text-xs font-semibold text-muted">MAD</span>
          </p>
        </div>
      </div>

      <div>
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <p className="text-[11px] font-bold uppercase tracking-wide text-muted">{t.left}</p>
          <p className="text-sm font-bold tabular-nums">
            <span className={textColor}>{left}</span>
            <span className="text-muted">/{cap}</span>
          </p>
        </div>
        <div
          className="h-2 overflow-hidden rounded-full bg-sunken"
          role="progressbar"
          aria-valuenow={cap > 0 ? Math.round((1 - ratio) * 100) : 0}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={t.left}
        >
          <div className={`h-full rounded-full transition-[width] ${barColor}`} style={{ width: `${Math.round((1 - ratio) * 100)}%` }} />
        </div>
      </div>

      <div className="flex flex-wrap justify-end gap-1.5 border-t border-line/10 pt-3.5">
        <IconBtn label={t.edit} onClick={onEdit}>
          <Pencil className="size-4" />
        </IconBtn>
        <IconBtn label={t.duplicate} onClick={onDuplicate}>
          <Copy className="size-4" />
        </IconBtn>
        <IconBtn label={t.guests} onClick={onGuests}>
          <Users className="size-4" />
        </IconBtn>
        <IconBtn label={t.contact} onClick={onContact}>
          <Mail className="size-4" />
        </IconBtn>
        <IconBtn label={t.eventSettings} onClick={onRules}>
          <SlidersHorizontal className="size-4" />
        </IconBtn>
        {/* A cancelled event can be hidden further but never restored — the
            server refuses it with a 409, because every ticket has already
            been refunded and voided. Offering an eye that only errors would
            be a button that lies. */}
        {!cancelled ? (
          <IconBtn label={hidden ? t.restore : t.hide} onClick={onToggleHidden}>
            {hidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
          </IconBtn>
        ) : null}
        {!hidden ? (
          <Link
            to={`/evenements/${event.slug}`}
            title={t.public}
            aria-label={t.public}
            className="inline-flex size-9 items-center justify-center rounded-control border border-line/15 bg-card text-muted transition hover:-translate-y-px hover:border-primary hover:bg-brume hover:text-primary"
          >
            <ExternalLink className="size-4" />
          </Link>
        ) : null}
        {/* Only for someone with finance.refund, and only once — a second
            cancellation has nothing left to refund or void. */}
        {onCancel && !cancelled ? (
          <IconBtn tone="danger" label={t.cancelEvent} onClick={onCancel}>
            <Ban className="size-4" />
          </IconBtn>
        ) : null}
        <IconBtn tone="danger" label={t.remove} onClick={onRemove}>
          <Trash2 className="size-4" />
        </IconBtn>
      </div>
    </article>
  );
}
