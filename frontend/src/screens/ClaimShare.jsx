import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { CalendarDays, Check, Gift, Link2Off, QrCode, Ticket, UserRound } from "lucide-react";
import { Shell } from "../components/Shell";
import { QrMark } from "../components/QrMark";
import { toast } from "sonner";
import { api, rememberTicketKey } from "../api";
import { Badge, Button, Container, Field, Input, Skeleton } from "../ui";
import { useI18n } from "../i18n";
import { eventText, intlLocaleTag } from "../utils";

/**
 * Claim a shared ticket.
 *
 * No account needed: the token in the URL is the credential, the same rule the
 * guest confirmation and PDF links use. Once claimed, the ticket id becomes
 * the recipient's capability — so this page points them at it immediately
 * rather than leaving them with a QR they can never find again.
 *
 * The recipient arrives from a message, on a phone, knowing nothing about
 * Eventick — so the page leads with the gift and the event, not with a form.
 * The offer is drawn as a ticket stub (the perforated shape from TicketPass)
 * on the fixed-dark `stage` surface, which is what makes the claim read as
 * "someone handed you something" rather than as another checkout step.
 */
export default function ClaimShare() {
  const { token } = useParams();
  const { locale, t } = useI18n();
  const [offer, setOffer] = useState(null);
  const [error, setError] = useState(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [claimed, setClaimed] = useState(null);

  useEffect(() => {
    api
      .get(`/share/${token}`)
      .then(setOffer)
      .catch((err) => setError(err.status === 410 ? t("claimGone") : err.message));
  }, [token, t]);

  const accept = async (event) => {
    event.preventDefault();
    if (busy || name.trim().length < 3) return;
    setBusy(true);
    try {
      const result = await api.post(`/share/${token}/claim`, { holderName: name.trim() });
      // The claimed ticket sits on the SENDER's order, so this token is the
      // recipient's only proof of it -- and it is returned exactly once.
      rememberTicketKey(result.ticketId, result.accessToken);
      setClaimed(result);
      toast.success(t("claimDone"));
    } catch (err) {
      // 410 means someone else got there first, or the sender pulled it.
      toast.error(err.status === 410 ? t("claimGone") : err.message);
      if (err.status === 410) setError(t("claimGone"));
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <Shell>
        <Container size="narrow" className="py-16">
          <div className="flex flex-col items-center text-center">
            <span
              className="inline-flex size-14 items-center justify-center rounded-card bg-danger-bg text-danger"
              aria-hidden
            >
              <Link2Off className="size-6" />
            </span>
            <h1 className="mt-4 font-display text-title font-bold">{t("claimGoneTitle")}</h1>
            <p className="mt-2 max-w-sm text-sm text-muted">{error}</p>
            <Link
              to="/explorer"
              className="mt-6 inline-flex h-11 items-center justify-center rounded-full border border-line/20 bg-card px-5 text-sm font-semibold text-ink transition hover:bg-paper"
            >
              {t("explore")}
            </Link>
          </div>
        </Container>
      </Shell>
    );
  }

  if (claimed) {
    return (
      <Shell>
        <Container size="narrow" className="py-12 md:py-16">
          <div className="flex flex-col items-center text-center">
            <span
              className="inline-flex size-14 items-center justify-center rounded-card bg-success-bg text-success"
              aria-hidden
            >
              <Check className="size-7" strokeWidth={3} />
            </span>
            <h1 className="mt-4 font-display text-title font-black">{t("claimDone")}</h1>
            <p className="mt-2 text-sm text-muted">{t("claimDoneSub")}</p>
          </div>

          <div className="mt-8 overflow-hidden rounded-card border border-line/10 bg-card shadow-card">
            <div className="flex flex-col items-center gap-4 bg-brume/40 p-6">
              <Badge tone="success">{t("validEntry")}</Badge>
              <div className="rounded-control bg-white p-3 shadow-card">
                <QrMark value={claimed.qrPayload} />
              </div>
              <p className="font-mono text-xs tracking-[0.2em] text-muted">
                {t("ref")} {claimed.ref}
              </p>
            </div>

            <div className="border-t border-dashed border-line/25 p-5">
              <p className="text-center text-sm text-muted">{t("claimKeepLink")}</p>
              <Link
                to={`/billet/${claimed.ticketId}?k=${encodeURIComponent(claimed.accessToken ?? "")}`}
                className="mt-4 inline-flex h-13 w-full items-center justify-center gap-2 rounded-full border border-line/10 bg-action px-6 text-[15px] font-semibold text-action-fg shadow-sm transition hover:bg-action-hover active:scale-[0.98]"
              >
                <Ticket className="size-4" aria-hidden />
                {t("viewTicket")}
              </Link>
            </div>
          </div>
        </Container>
      </Shell>
    );
  }

  if (!offer) {
    return (
      <Shell>
        <Container size="narrow" className="py-12 md:py-16">
          <span className="sr-only" role="status" aria-live="polite">
            {t("claimLoading")}
          </span>
          <div className="grid gap-4" aria-hidden>
            <Skeleton className="mx-auto h-7 w-48" />
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-13 w-full" />
          </div>
        </Container>
      </Shell>
    );
  }

  const title = eventText(offer, "eventTitle", locale);
  const tierName = eventText(offer, "tierName", locale);
  const seat = offer.seatRow ? `${offer.seatRow}${offer.seatNumber}` : null;
  const start = new Date(offer.eventStart);
  const intl = intlLocaleTag(locale);
  const dateLabel = start.toLocaleDateString(intl, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const timeLabel = start.toLocaleTimeString(intl, { hour: "2-digit", minute: "2-digit" });

  return (
    <Shell>
      <Container size="narrow" className="py-10 md:py-14">
        <header className="text-center">
          <Badge tone="primary" icon={<Gift className="size-3.5" />}>
            {t("claimGift")}
          </Badge>
          <h1 className="mt-4 font-display text-title font-black md:text-display">{t("claimTitle")}</h1>
          <p className="mt-2 text-sm text-muted">{t("claimFrom").replace("{n}", offer.senderName)}</p>
        </header>

        {/*
          The offer, as a ticket stub: a photographic panel over a perforated
          rule, matching TicketPass. `stage` rather than `encre` because this
          panel must stay dark in both themes — the image gradient and the
          white text over it are built for a dark surface either way.
        */}
        <section className="mt-8 overflow-hidden rounded-card border border-line/10 bg-stage text-stage-fg shadow-pop">
          <div className="relative">
            {offer.eventImage ? (
              <>
                <img src={offer.eventImage} alt="" className="h-48 w-full object-cover md:h-60" />
                <div
                  className="absolute inset-0 bg-linear-to-t from-stage via-stage/35 via-55% to-transparent"
                  aria-hidden
                />
              </>
            ) : (
              <div className="h-24 w-full bg-linear-to-br from-primary/40 to-secondary/40" aria-hidden />
            )}

            <div className="absolute inset-x-0 bottom-0 p-5 md:p-6">
              <p className="flex items-center gap-1.5 text-sm font-semibold">
                <CalendarDays className="size-4 shrink-0" aria-hidden />
                <span className="truncate">
                  {dateLabel} · {timeLabel}
                </span>
              </p>
              <h2 className="mt-1 font-display text-heading font-extrabold md:text-title">{title}</h2>
            </div>
          </div>

          <div className="relative border-t border-dashed border-stage-fg/25 p-5 md:p-6">
            {/*
              Perforation notches. Positioned with inset-inline + a logical
              margin, not a negative translate-x — that does not mirror under
              RTL, the same trap TicketPass documents.
            */}
            <span className="absolute -top-2.5 start-0 -ms-2.5 size-5 rounded-full bg-paper" aria-hidden />
            <span className="absolute -top-2.5 end-0 -me-2.5 size-5 rounded-full bg-paper" aria-hidden />

            <div className="flex flex-wrap items-center gap-2.5">
              <Badge tone="accent" icon={<Ticket className="size-3.5" />}>
                {tierName}
              </Badge>
              <span className="text-sm text-stage-muted">{seat ?? t("freeSeat")}</span>
            </div>

            {offer.message ? (
              <blockquote className="mt-4 border-s-2 border-primary ps-3.5 text-[15px] italic leading-relaxed">
                “{offer.message}”
              </blockquote>
            ) : null}
          </div>
        </section>

        <p className="mt-6 text-center text-sm leading-relaxed text-muted">{t("claimIntro")}</p>

        <ul className="mt-4 flex flex-wrap justify-center gap-2">
          {[t("claimFree"), t("claimNoAccount"), t("claimOneOnly")].map((item) => (
            <li
              key={item}
              className="inline-flex items-center gap-1.5 rounded-full bg-sunken px-3 py-1.5 text-xs font-semibold text-muted"
            >
              <Check className="size-3.5 shrink-0 text-success" aria-hidden />
              {item}
            </li>
          ))}
        </ul>

        <form onSubmit={accept} className="mt-8">
          <Field label={t("claimYourName")} hint={t("claimNameHint")} required>
            {({ id, describedBy, required }) => (
              <Input
                id={id}
                describedBy={describedBy}
                required={required}
                value={name}
                onChange={(event) => setName(event.target.value)}
                minLength={3}
                autoComplete="name"
                autoFocus
              />
            )}
          </Field>

          <Button
            type="submit"
            full
            size="lg"
            className="mt-5"
            loading={busy}
            disabled={name.trim().length < 3}
            icon={<Gift className="size-4" />}
          >
            {t("claimAccept")}
          </Button>
        </form>

        <section className="mt-8 rounded-card border border-line/10 bg-card p-5 shadow-card">
          <h3 className="text-[11px] font-bold uppercase tracking-[0.06em] text-muted">{t("claimStepsTitle")}</h3>
          <ol className="mt-3 grid gap-3">
            {[
              { icon: <QrCode className="size-4" />, body: t("claimStep1") },
              { icon: <UserRound className="size-4" />, body: t("claimStep2") },
            ].map((step, index) => (
              <li key={index} className="flex items-start gap-3">
                <span
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-brume text-primary"
                  aria-hidden
                >
                  {step.icon}
                </span>
                <p className="pt-1 text-sm text-muted">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>
      </Container>
    </Shell>
  );
}
