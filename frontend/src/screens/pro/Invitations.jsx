import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ExternalLink, MailPlus, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import { useI18n } from "../../i18n";
import { eventText } from "../../utils";
import { useConfirm } from "./ConfirmContext";
import { EventSwitcher } from "./EventSwitcher";
import { Badge, Btn, DataTable, EmptyState, IconBtn, Modal, PageHead, PersonCell, Td, Th } from "./ui";
import { text } from "./copy";
import { useOrganisers } from "./useOrganisers";
import { Dropdown, Field, Input, Notice, triggerControlClass } from "../../ui";

/** The server refuses a batch larger than this, so the form stops first. */
const MAX_GUESTS = 100;

const blankGuest = () => ({ guestName: "", guestEmail: "", note: "" });

/**
 * Invitations — the comp tickets an organiser gives away.
 *
 * This is deliberately not a 100% promo code, which was the only way to do
 * it before. A promo code is a discount on a SALE: it lands in revenue, in
 * the commission and in the payout as a zero-value order, which makes the
 * finance screens lie about what was sold. A comp was never a sale, so it
 * gets its own concept end to end — and this is where that concept finally
 * becomes usable without curl.
 *
 * Scoped to one event because the API is: there is no cross-event
 * invitations endpoint, and fanning out one request per event (as Offers
 * does for the waitlist) would also throw away the zone picker's context.
 */
export default function Invitations() {
  const { locale } = useI18n();
  const t = text[locale];
  const confirm = useConfirm();
  const [events, setEvents] = useState([]);
  const [slug, setSlug] = useState("");
  /**
   * Same required first step as Placements, for the same reason: issuing a
   * comp is a WRITE against somebody's event. It consumes that organiser's
   * capacity and mints a real ticket on their inventory, so "which event"
   * cannot be answered until "whose" is. An admin owns no events, so a flat
   * all-events list here is a list of other people's stock with nothing
   * saying so.
   */
  const { maySeeAllOrganisers, organisers } = useOrganisers();
  const [organiserId, setOrganiserId] = useState("");
  const [invitations, setInvitations] = useState(null);
  const [tiers, setTiers] = useState([]);
  const [open, setOpen] = useState(false);
  const [tierId, setTierId] = useState("");
  const [guests, setGuests] = useState([blankGuest()]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
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
        // Reset rather than keep: the previous organiser's slug is not one
        // this organiser owns.
        setSlug(data.events.length ? data.events[0].slug : "");
      })
      .catch(() => {});
  }, [maySeeAllOrganisers, organiserId]);

  const load = useCallback(() => {
    if (!slug) return;
    api
      .get(`/organiser/events/${slug}/invitations`)
      .then((data) => setInvitations(data.invitations))
      .catch((err) => toast.error(err.message));
    // The zone picker needs `remaining`, since a comp consumes capacity just
    // as a sale does and an organiser should see what is left before giving
    // seats away.
    api
      .get(`/organiser/events/${slug}/tiers`)
      .then((data) => setTiers(data.tiers))
      .catch(() => {});
  }, [slug]);

  useEffect(() => {
    setInvitations(null);
    // Clear the zones too, not just the rows. `load` returns early when
    // there is no slug, so without this the PREVIOUS event's tiers survive
    // -- and "Issue comps" is enabled on tiers.length, so it stayed clickable
    // over zones belonging to an event no longer selected. Reachable now
    // that switching organiser can empty the selection.
    setTiers([]);
    load();
  }, [load]);

  const tierLabel = (tier) =>
    `${eventText(tier, "name", locale)} · ${tier.remaining} ${t.left.toLowerCase()}`;

  const openForm = () => {
    setTierId(tiers[0]?.id ?? "");
    setGuests([blankGuest()]);
    setOpen(true);
  };

  const setGuest = (index, key, value) =>
    setGuests((list) => list.map((guest, i) => (i === index ? { ...guest, [key]: value } : guest)));

  const addGuest = () => setGuests((list) => (list.length >= MAX_GUESTS ? list : [...list, blankGuest()]));
  const dropGuest = (index) => setGuests((list) => (list.length === 1 ? list : list.filter((_, i) => i !== index)));

  const issue = async (e) => {
    e.preventDefault();
    if (busy) return;
    // Rows left blank are dropped rather than sent: adding a row and then
    // not filling it in is a normal thing to do, and the server would 400
    // the whole batch over it.
    const filled = guests.filter((guest) => guest.guestName.trim().length > 0);
    if (filled.length === 0) return;
    // The server requires 2 characters per name; say which rule was broken
    // rather than passing its zod message through.
    if (filled.some((guest) => guest.guestName.trim().length < 2)) {
      toast.error(t.guestNameTooShort);
      return;
    }
    setBusy(true);
    try {
      const res = await api.post(`/organiser/events/${slug}/invitations`, {
        tierId,
        guests: filled.map((guest) => ({
          guestName: guest.guestName.trim(),
          // Omitted entirely when blank — the schema wants a valid email or
          // nothing, and "" is neither.
          ...(guest.guestEmail.trim() ? { guestEmail: guest.guestEmail.trim() } : {}),
          ...(guest.note.trim() ? { note: guest.note.trim() } : {}),
        })),
      });
      setOpen(false);
      load();
      toast.success(t.compsIssued.replace("{n}", String(res.issued?.length ?? filled.length)));
    } catch (err) {
      // Capacity is re-checked inside the transaction, so "only N seat(s)
      // left in this zone" arrives here and is worth showing verbatim.
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (invitation) => {
    const ok = await confirm({
      title: t.revokeComp,
      message: t.confirmRevokeComp.replace("{name}", invitation.guestName),
      tone: "danger",
      confirmLabel: t.revokeComp,
      cancelLabel: t.cancelBtn,
    });
    if (!ok) return;
    try {
      await api.del(`/organiser/invitations/${invitation.id}`);
      load();
      toast.success(t.compRevoked);
    } catch (err) {
      toast.error(err.message);
    }
  };

  const rows = invitations ?? [];

  return (
    <div>
      <PageHead
        title={t.invitations}
        sub={t.invitationsSub}
        actions={
          <>
            {/* Step 1, admins only -- it gates the event picker beside it. */}
            {maySeeAllOrganisers ? (
              <span className="block w-full sm:inline-block sm:w-56">
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
            {!maySeeAllOrganisers || organiserId ? (
              <EventSwitcher
                events={events}
                value={slug}
                onChange={setSlug}
                locale={locale}
                labels={{ pick: t.pickEvent, search: t.searchEvents, noMatch: t.noNavResults }}
              />
            ) : null}
            <Btn onClick={openForm} disabled={!slug || tiers.length === 0} icon={<MailPlus className="size-4" />}>
              {t.issueComps}
            </Btn>
          </>
        }
      />

      {maySeeAllOrganisers && !organiserId ? (
        <EmptyState icon="👤" title={t.pickOrganiserFirst} body={t.pickOrganiserBodyComp} />
      ) : !slug ? (
        <EmptyState
          icon="🎟️"
          title={maySeeAllOrganisers && events.length === 0 ? t.organiserNoEvents : t.selectEventFirst}
        />
      ) : invitations && rows.length === 0 ? (
        <EmptyState icon="🎁" title={t.noInvitations} />
      ) : (
        <DataTable minWidth={820}>
          <thead>
            <tr>
              <Th>{t.guestName}</Th>
              <Th>{t.compZone}</Th>
              {/* Was t.gateCol ("Porte"/"Gate") -- this cell has never held
                  a gate, it holds the ticket reference. Invisible while the
                  table was empty, wrong the moment it had rows. */}
              <Th>{t.ticketColumn}</Th>
              <Th>{t.compEmailed}</Th>
              <Th>{t.invitedBy}</Th>
              <Th className="text-end">{t.remove}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((invitation) => (
              <tr key={invitation.id} className={invitation.revoked ? "opacity-55" : undefined}>
                <Td>
                  <PersonCell name={invitation.guestName} sub={invitation.guestEmail ?? invitation.note ?? undefined} />
                </Td>
                <Td>{eventText(invitation, "tierName", locale)}</Td>
                <Td>
                  {/* A revoked invitation stays on the list by design — the
                      backend keeps it so "issued, then revoked" is visible
                      rather than silently gone. */}
                  {invitation.revoked ? (
                    <Badge tone="danger">{t.cancelled}</Badge>
                  ) : invitation.ticketId ? (
                    // Opens the guest's OWN page, carrying their token -- so
                    // "the link you emailed me doesn't work" can be answered
                    // by looking at the same thing they are looking at,
                    // rather than at a different view of the same ticket.
                    <Link
                      to={`/billet/${invitation.ticketId}?k=${encodeURIComponent(invitation.accessToken ?? "")}`}
                      target="_blank"
                      rel="noreferrer"
                      title={t.openGuestTicket}
                      className="inline-flex items-center gap-1.5 font-mono text-xs text-primary transition hover:underline"
                    >
                      {invitation.ref ?? "—"}
                      <ExternalLink className="size-3.5 shrink-0" aria-hidden />
                    </Link>
                  ) : (
                    <span className="font-mono text-xs">{invitation.ref ?? "—"}</span>
                  )}
                </Td>
                <Td>
                  {invitation.sentAt ? (
                    <Badge tone="success">{t.compEmailed}</Badge>
                  ) : (
                    <Badge tone="neutral">{t.compNotEmailed}</Badge>
                  )}
                </Td>
                <Td className="text-xs text-muted">{invitation.issuedBy ?? "—"}</Td>
                <Td className="text-end">
                  {invitation.revoked ? null : (
                    <IconBtn tone="danger" size="sm" label={t.revokeComp} onClick={() => revoke(invitation)}>
                      <Trash2 className="size-4" />
                    </IconBtn>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t.issueComps}
        sub={t.issueCompsSub}
        icon={<MailPlus className="size-5" />}
        footer={
          <>
            <Btn variant="secondary" onClick={() => setOpen(false)}>
              {t.close}
            </Btn>
            <Btn type="submit" form="comps-form" disabled={busy}>
              {t.issueComps}
            </Btn>
          </>
        }
      >
        <form id="comps-form" className="grid gap-4" onSubmit={issue}>
          <Notice tone="info">{t.compZoneHint}</Notice>

          <Field label={t.compZone} required>
            {({ id, describedBy, invalid }) => (
              <Dropdown
                label={t.compZone}
                id={id}
                describedBy={describedBy}
                value={tierId}
                onChange={setTierId}
                options={tiers.map((tier) => ({ value: tier.id, label: tierLabel(tier) }))}
                triggerClassName={triggerControlClass({ invalid })}
              />
            )}
          </Field>

          <div className="grid gap-3">
            {guests.map((guest, index) => (
              <div key={index} className="rounded-control border border-line/10 bg-paper/60 p-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t.guestName} required>
                    {({ id, describedBy, invalid, required }) => (
                      <Input
                        id={id}
                        describedBy={describedBy}
                        invalid={invalid}
                        required={required && index === 0}
                        minLength={2}
                        value={guest.guestName}
                        onChange={(e) => setGuest(index, "guestName", e.target.value)}
                      />
                    )}
                  </Field>
                  <Field label={t.guestEmail} hint={index === 0 ? t.guestEmailHint : undefined}>
                    {({ id, describedBy, invalid }) => (
                      <Input
                        id={id}
                        describedBy={describedBy}
                        invalid={invalid}
                        type="email"
                        value={guest.guestEmail}
                        onChange={(e) => setGuest(index, "guestEmail", e.target.value)}
                      />
                    )}
                  </Field>
                  <Field label={t.guestNote} className="sm:col-span-2">
                    {({ id, describedBy, invalid }) => (
                      <Input
                        id={id}
                        describedBy={describedBy}
                        invalid={invalid}
                        value={guest.note}
                        onChange={(e) => setGuest(index, "note", e.target.value)}
                      />
                    )}
                  </Field>
                </div>
                {guests.length > 1 ? (
                  <div className="mt-2 flex justify-end">
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-xs font-semibold text-danger hover:underline"
                      onClick={() => dropGuest(index)}
                    >
                      <X className="size-3.5" />
                      {t.removeGuest}
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between gap-3">
            <Btn type="button" variant="secondary" onClick={addGuest} disabled={guests.length >= MAX_GUESTS} icon={<Plus className="size-4" />}>
              {t.addGuest}
            </Btn>
            {guests.length >= MAX_GUESTS ? <p className="text-xs text-muted">{t.compsMax}</p> : null}
          </div>
        </form>
      </Modal>
    </div>
  );
}
