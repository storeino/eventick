import { useEffect, useState } from "react";
import { Mail, Plus, Tags, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, money } from "../../api";
import { useI18n } from "../../i18n";
import { useAuth } from "../../AuthContext";
import { useConfirm } from "./ConfirmContext";
import { Badge, Btn, EmptyState, IconBtn, Modal, PageHead, SectionTitle } from "./ui";
import { text } from "./copy";
import { Dropdown, Field, Input, triggerControlClass } from "../../ui";
import { eventText, intlLocaleTag } from "../../utils";

const WAITLIST_TONE = { WAITING: "neutral", OFFERED: "warn", CLAIMED: "success", EXPIRED: "danger" };

function waitlistLabel(t, status) {
  if (status === "OFFERED") return t.wlOffered;
  if (status === "CLAIMED") return t.wlClaimed;
  if (status === "EXPIRED") return t.wlExpired;
  return t.wlWaiting;
}

export default function Offers() {
  const { locale } = useI18n();
  const { can } = useAuth();
  const t = text[locale];
  const confirm = useConfirm();
  const [events, setEvents] = useState(null);
  const [promos, setPromos] = useState(null);
  const [waitlist, setWaitlist] = useState([]);
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [kind, setKind] = useState("PERCENT");
  const [value, setValue] = useState(10);
  const [eventSlug, setEventSlug] = useState("");
  const [maxUses, setMaxUses] = useState(100);

  const load = () => {
    api.get("/organiser/events").then((data) => setEvents(data.events));
    api.get("/promo").then((data) => setPromos(data.promos));
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (!events) return;
    Promise.all(
      events.map((event) =>
        api
          .get(`/organiser/events/${event.slug}/waitlist`)
          .then((data) => data.entries.map((entry) => ({ ...entry, slug: event.slug, title: eventText(event, "title", locale) }))),
      ),
    ).then((lists) => setWaitlist(lists.flat()));
  }, [events, locale]);

  const submit = async (e) => {
    e.preventDefault();
    if (code.trim().length < 3 || value <= 0 || maxUses < 1) return;
    await api.post("/promo", { code: code.trim(), kind, value, eventSlug: eventSlug || undefined, maxUses });
    setCode("");
    setOpen(false);
    load();
    toast.success(t.saved);
  };

  const bump = async (promo) => {
    await api.patch(`/promo/${promo.id}`, { maxUses: promo.maxUses + 50 });
    load();
    toast.success(t.saved);
  };

  const remove = async (promo) => {
    const ok = await confirm({
      title: t.confirmTitle,
      message: t.confirmDeletePromo,
      tone: "danger",
      confirmLabel: t.remove,
      cancelLabel: t.cancelBtn,
    });
    if (!ok) return;
    await api.del(`/promo/${promo.id}`);
    load();
    toast.success(t.removed);
  };

  return (
    <div>
      <PageHead
        title={t.offers}
        sub={t.offersSub}
        actions={
          <Btn onClick={() => setOpen(true)}>
            <Plus className="size-4" />
            {t.addPromo}
          </Btn>
        }
      />

      {promos && promos.length === 0 ? (
        <EmptyState icon="🏷️" title={t.noPromosYet} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {(promos ?? []).map((promo) => {
            const exhausted = promo.uses >= promo.maxUses;
            return (
              <article key={promo.id} className="flex flex-col gap-3 rounded-card border border-line/10 bg-card p-4 shadow-card">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-mono text-sm font-extrabold">{promo.code}</span>
                  <Badge tone="info">{promo.kind === "PERCENT" ? `${promo.value}%` : `${money(promo.value)} MAD`}</Badge>
                </div>
                {/* The server sends the event name with the promo now. It
                    used to be looked up by eventId against a list that
                    carries only slugs, so the lookup always missed and the
                    card printed a raw cuid where the name belongs. */}
                <p className="truncate text-sm text-muted">
                  {promo.eventId ? eventText(promo, "eventTitle", locale) || promo.eventSlug : t.allDates}
                </p>
                <div className="flex items-center justify-between gap-2 border-t border-line/10 pt-3">
                  <Badge tone={exhausted ? "danger" : "neutral"}>
                    {promo.uses}/{promo.maxUses}
                  </Badge>
                  <div className="flex gap-1.5">
                    <Btn variant="secondary" size="sm" onClick={() => bump(promo)}>
                      +50
                    </Btn>
                    <IconBtn tone="danger" label={t.remove} onClick={() => remove(promo)}>
                      <Trash2 className="size-4" />
                    </IconBtn>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <SectionTitle>{t.waitlist}</SectionTitle>
      {waitlist.length === 0 ? (
        <EmptyState icon="📬" title={t.noWaitlist} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {waitlist.map((item, i) => (
            <article key={`${item.slug}-${item.email}-${i}`} className="flex min-w-0 flex-col gap-2.5 rounded-card border border-line/10 bg-card p-4 shadow-card">
              <div className="flex items-start gap-2.5">
                <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-control bg-brume text-primary" aria-hidden>
                  <Mail className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold">{item.email}</p>
                  <p className="truncate text-xs text-muted">{item.title}</p>
                </div>
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-line/10 pt-2.5 text-xs">
                <Badge tone={WAITLIST_TONE[item.status] ?? "neutral"}>{waitlistLabel(t, item.status)}</Badge>
                <span className="text-muted">{item.createdAt.slice(0, 10)}</span>
              </div>
              {item.status === "OFFERED" && item.claimExpiresAt ? (
                <span className="text-[11px] text-muted">
                  {t.wlExpires} {new Date(item.claimExpiresAt).toLocaleTimeString(intlLocaleTag(locale), { hour: "2-digit", minute: "2-digit" })}
                </span>
              ) : null}
            </article>
          ))}
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t.addPromo}
        icon={<Tags className="size-5" />}
        footer={
          <>
            <Btn variant="secondary" onClick={() => setOpen(false)}>
              {t.close}
            </Btn>
            <Btn type="submit" form="promo-form">
              {t.save}
            </Btn>
          </>
        }
      >
        <form id="promo-form" className="grid gap-4 sm:grid-cols-2" onSubmit={submit}>
          <Field label={t.code} required className="sm:col-span-2">
            {({ id, describedBy, invalid, required }) => (
              <Input
                id={id}
                describedBy={describedBy}
                invalid={invalid}
                required={required}
                className="font-mono"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="SAFRAN15"
              />
            )}
          </Field>
          <Field label={t.kind}>
            {({ id, describedBy, invalid }) => (
              <Dropdown
                label={t.kind}
                id={id}
                describedBy={describedBy}
                value={kind}
                onChange={setKind}
                options={[
                  { value: "PERCENT", label: t.percent },
                  { value: "AMOUNT", label: t.amount },
                ]}
                triggerClassName={triggerControlClass({ invalid })}
              />
            )}
          </Field>
          <Field label={kind === "PERCENT" ? t.percent : t.amount}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                describedBy={describedBy}
                invalid={invalid}
                type="number"
                min={1}
                value={value}
                onChange={(e) => setValue(Number(e.target.value))}
              />
            )}
          </Field>
          {/* Leaving this on "all dates" asks for a platform-wide code, which
              the server only grants with scope.any — so say that here rather
              than letting a plain organiser find out from a 403. */}
          <Field label={t.allEvents} hint={!eventSlug && !can("scope.any") ? t.globalPromoAdminOnly : undefined}>
            {({ id, describedBy, invalid }) => (
              <Dropdown
                label={t.allEvents}
                id={id}
                describedBy={describedBy}
                value={eventSlug}
                onChange={setEventSlug}
                options={[
                  { value: "", label: t.allDates },
                  ...(events ?? []).map((event) => ({
                    value: event.slug,
                    label: eventText(event, "title", locale),
                  })),
                ]}
                triggerClassName={triggerControlClass({ invalid })}
              />
            )}
          </Field>
          <Field label={t.maxUses}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                describedBy={describedBy}
                invalid={invalid}
                type="number"
                min={1}
                value={maxUses}
                onChange={(e) => setMaxUses(Number(e.target.value))}
              />
            )}
          </Field>
        </form>
      </Modal>
    </div>
  );
}
