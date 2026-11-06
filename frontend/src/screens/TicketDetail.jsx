import { useCallback, useEffect, useState } from "react";
import { Copy, Download, Pencil, Printer, Share2, Tag, Ticket as TicketIcon, UserPlus } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import CmiRedirect from "./CmiRedirect";
import { QrMark } from "../components/QrMark";
import { Shell } from "../components/Shell";
import { toast } from "sonner";
import { Meta, seatLabel } from "../components/TicketPass";
import { api, downloadFile, money, rememberTicketKey, tokenForTicket } from "../api";
import { useI18n } from "../i18n";
import { useAuth } from "../AuthContext";
import { Badge, Button, Card, Container, ErrorState, Field, IconButton, Input, Modal } from "../ui";
import { cn, eventText, intlLocaleTag } from "../utils";

const STATUS_TONE = { VALID: "success", USED: "neutral", CANCELLED: "danger", TRANSFERRED: "warn" };

export default function TicketDetail() {
  const { ticketId } = useParams();
  const { locale, t } = useI18n();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [options, setOptions] = useState(null);
  const [busy, setBusy] = useState(false);
  const [shareMessage, setShareMessage] = useState("");
  const [renaming, setRenaming] = useState(null);
  const [confirmZone, setConfirmZone] = useState(null);
  /* The upgrade being paid for: the chosen zone, then the CMI form once the
     server has created the order and reserved the seat. */
  const [upgrade, setUpgrade] = useState(null);
  const [upgradeCmi, setUpgradeCmi] = useState(null);
  const [payName, setPayName] = useState("");
  const [payEmail, setPayEmail] = useState("");
  const [payPhone, setPayPhone] = useState("");

  const load = useCallback(() => {
    // A share recipient opening this link on another device has their token
    // only in the URL, so adopt it before the first fetch. api.js attaches it
    // to every call from here on.
    const fromUrl = new URLSearchParams(window.location.search).get("k");
    if (fromUrl) rememberTicketKey(ticketId, fromUrl);

    api
      .get(`/tickets/${ticketId}`)
      .then(setData)
      .catch((err) => setError(err.message));
    // What the holder may actually do — drives which controls appear, so the
    // page never offers an action the server will reject.
    api
      .get(`/tickets/${ticketId}/options`)
      .then(setOptions)
      .catch(() => setOptions(null));
  }, [ticketId]);

  useEffect(load, [load]);

  // Attach this guest order to the signed-in account, which is what unlocks
  // reselling and giving the ticket away. The order token is the proof -- it
  // is what the buyer demonstrably holds.
  const claimOrder = async () => {
    if (busy || !options?.orderId) return;
    setBusy(true);
    try {
      await api.post(`/orders/${options.orderId}/claim`, {}, { orderToken: tokenForTicket(ticketId) });
      toast.success(t("claimOrderDone"));
      load();
    } catch (err) {
      toast.error(err.status === 409 ? t("claimTaken") : err.message);
    } finally {
      setBusy(false);
    }
  };

  /*
   * List this ticket for resale.
   *
   * This is how a holder who cannot attend gets their money back, and since
   * tickets became final sale it is the ONLY way: cancelling the seat
   * returns nothing. The price is not asked for — the server always lists at
   * face value, so there is no field to get wrong and no scalping to police.
   *
   * What comes back is a token. That link IS the sale: whoever opens it can
   * buy the seat, and the seller is paid when they do.
   */
  const listForResale = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.post("/resale/listings", { ticketId }, { orderToken: tokenForTicket(ticketId) });
      toast.success(t("resaleListed"));
      // Straight to the clipboard: a link nobody can see is a listing that
      // never sells, and the panel below shows it again on reload anyway.
      await copyResale(res.token);
      load();
    } catch (err) {
      /*
       * Listing is refused when there is no account to pay the seller into.
       * The server says why; a message alone still leaves them hunting for
       * the form, so this offers the way there. The money half of a resale
       * is the half that fails silently, which is why the check happens at
       * listing time and not when the payout is already owed.
       */
      if (err.status === 409 && /bank details/i.test(err.message ?? "")) {
        toast.error(err.message, {
          action: { label: t("cbSave"), onClick: () => navigate("/billets") },
        });
      } else {
        toast.error(err.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const cancelListing = async (id) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.del(`/resale/listings/${id}`);
      toast.success(t("resaleCancelled"));
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  /*
   * Moving zone. A downgrade is irreversible and refunds nothing, so the
   * amount being given up has to be stated and agreed BEFORE it happens --
   * the list previously said only "no extra charge", which is true and reads
   * as "free" to someone about to lose the difference.
   *
   * The agreement is a real dialog rather than window.confirm: that one
   * cannot be styled or translated, announces the origin ("localhost:3100
   * says"), and some mobile browsers suppress it outright -- which here would
   * have moved the ticket and forfeited the money with no prompt shown at
   * all. Every other consequential action on this page already uses Modal.
   */
  const changeZone = async (tierId, forfeitCents = 0) => {
    if (busy) return;
    if (forfeitCents > 0) {
      setConfirmZone({ tierId, forfeitCents });
      return;
    }
    await applyZone(tierId);
  };

  const applyZone = async (tierId) => {
    if (busy) return;
    setConfirmZone(null);
    setBusy(true);
    try {
      await api.post(`/tickets/${ticketId}/exchange`, { tierId });
      toast.success(t("zoneChanged"));
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  /*
   * Upgrading into a dearer zone, which costs the difference.
   *
   * Deliberately NOT part of changeZone: that one answers immediately,
   * while this creates an order, reserves the seat and hands the buyer to
   * CMI. The seat is held from the moment the server answers, so leaving
   * this dialog without paying should release it rather than let it sit for
   * the full 15 minutes -- see closeUpgrade.
   */
  /* Open the pay-the-difference dialog, prefilled from the order so most
     buyers only have to press the button. */
  const openUpgrade = (zone) => {
    if (busy) return;
    setPayName(data?.ticket?.holderName ?? user?.name ?? "");
    setPayEmail(user?.email ?? "");
    setPayPhone("");
    setUpgradeCmi(null);
    setUpgrade({ tierId: zone.tierId, dueCents: zone.dueCents, name: eventText(zone, "name", locale) });
  };

  const startUpgrade = async (event) => {
    event.preventDefault();
    if (busy || !upgrade) return;
    setBusy(true);
    try {
      const res = await api.post(`/tickets/${ticketId}/upgrade`, {
        tierId: upgrade.tierId,
        holderName: payName.trim(),
        email: payEmail.trim(),
        phone: payPhone.trim(),
        locale,
      });
      if (res.mode === "mock") {
        // No gateway configured: the server settled it outright.
        setUpgrade(null);
        toast.success(t("zoneChanged"));
        load();
        return;
      }
      setUpgradeCmi({ ...res, upgradeId: res.upgradeId });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  /*
   * Backing out. If an order was already created, its line is holding a seat
   * in the target zone, so tell the server to let it go -- otherwise a
   * browsed-away dialog keeps a dear seat off sale for fifteen minutes.
   */
  const closeUpgrade = () => {
    const pending = upgradeCmi?.upgradeId;
    setUpgrade(null);
    setUpgradeCmi(null);
    if (pending) {
      api.post(`/tickets/upgrades/${pending}/abandon`, {}).catch(() => {});
    }
  };

  const submitName = async (event) => {
    event.preventDefault();
    const next = (renaming ?? "").trim();
    if (next.length < 2 || busy) return;
    setBusy(true);
    try {
      await api.patch(`/tickets/${ticketId}/holder`, { holderName: next });
      toast.success(t("nameFixed"));
      setRenaming(null);
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  // Giving the ticket away. The link is created here but nothing moves until
  // the recipient claims it, so until then this ticket keeps working and the
  // share can be pulled back.
  const shareUrl = (token) => `${window.location.origin}/billet-offert/${token}`;

  // A listing's link is the sale: whoever opens it can buy the seat.
  const resaleUrl = (token) => `${window.location.origin}/revente/${token}`;

  const copyResale = async (token) => {
    try {
      await navigator.clipboard.writeText(resaleUrl(token));
      toast.success(t("resaleCopied"));
    } catch {
      // Same fallback as copyShare: the clipboard needs a secure context and
      // can be blocked outright, and showing the link beats silence.
      window.prompt(t("resaleLink"), resaleUrl(token));
    }
  };

  const createShare = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // POST /share takes the ticket id in the BODY, which api.js's own
      // path-based lookup can never see — this is the one request on this
      // page where the token has to be supplied explicitly.
      const share = await api.post(
        "/share",
        { ticketId, message: shareMessage.trim() || undefined },
        { orderToken: tokenForTicket(ticketId) },
      );
      setShareMessage("");
      // Offer the link straight away — copying is the whole point of creating it.
      await copyShare(share.token);
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const copyShare = async (token) => {
    try {
      await navigator.clipboard.writeText(shareUrl(token));
      toast.success(t("shareCopied"));
    } catch {
      // Clipboard access needs a secure context and can be blocked outright;
      // showing the link is a worse UX than copying but better than silence.
      window.prompt(t("shareLink"), shareUrl(token));
    }
  };

  const revokeShare = async (shareId) => {
    if (busy) return;
    setBusy(true);
    try {
      // /share/:id's :id is the SHARE's id, not the ticket's — there is no
      // path segment here for api.js to read a ticket token from either.
      await api.del(`/share/${shareId}`, { orderToken: tokenForTicket(ticketId) });
      toast.success(t("shareRevoked"));
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <Shell>
        <Container size="narrow" className="py-16">
          <ErrorState title={t("ticketNotFound")} body={t("ticketNotFoundBody")} />
          <div className="mt-6 flex justify-center">
            <Link
              to="/billets"
              className="inline-flex h-12 items-center rounded-full bg-action px-5 text-sm font-semibold text-action-fg transition hover:bg-action-hover"
            >
              {t("seeTickets")}
            </Link>
          </div>
        </Container>
      </Shell>
    );
  }

  if (!data) {
    return (
      <Shell>
        <Container size="form" className="py-8">
          <div className="h-11 w-32 animate-pulse rounded-control bg-card" />
          <div className="mt-4 h-96 animate-pulse rounded-card bg-card" />
          <div className="mt-4 h-40 animate-pulse rounded-card bg-card" />
        </Container>
      </Shell>
    );
  }

  const { ticket, event, tier, order } = data;
  const title = eventText(event, "title", locale);
  const venue = eventText(event, "venue", locale);
  const zone = eventText(tier, "zone", locale);
  const gate = eventText(tier, "gate", locale);
  const tierName = eventText(tier, "name", locale);
  const seat = seatLabel(ticket, locale);
  const statusLabel =
    ticket.status === "VALID"
      ? t("validEntry")
      : ticket.status === "USED"
        ? t("used")
        : ticket.status === "TRANSFERRED"
          ? t("transferred")
          : t("cancelled");

  return (
    <Shell>
      <Container size="form" className="py-6 md:py-8">
        <div className="no-print flex items-center justify-between">
          <Link to="/billets" className="text-sm font-semibold text-primary hover:underline">
            {t("back")}
          </Link>
          <div className="flex gap-2">
            <IconButton
              label={t("download")}
              onClick={() => downloadFile(`/tickets/${ticketId}/pdf`, `${ticket.ref}.pdf`).catch((err) => toast.error(err.message))}
            >
              <Download className="size-4.5" />
            </IconButton>
            <IconButton label={t("print")} onClick={() => window.print()}>
              <Printer className="size-4.5" />
            </IconButton>
          </div>
        </div>

        {/* The ticket itself, in the same stub/QR split TicketPass uses on
            every list — this is just the single-ticket, full-detail version
            of the same object, not a different design for the same thing. */}
        <article className="mt-4 overflow-hidden rounded-card border border-line/10 bg-card shadow-pop">
          {event.image ? (
            <div className="relative h-44 w-full md:h-52">
              <img src={event.image} alt="" className="h-full w-full object-cover" />
              <div className="absolute inset-0 bg-linear-to-t from-stage/75 via-stage/5 to-transparent" />
              <div className="absolute inset-x-5 bottom-4 flex items-center justify-between gap-2">
                <Badge tone="primary">{tierName}</Badge>
                <span className="font-mono text-xs font-semibold text-stage-fg">{ticket.ref}</span>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 border-b border-line/10 px-5 py-4 md:px-6">
              <Badge tone="primary">{tierName}</Badge>
              <span className="font-mono text-xs text-muted">{ticket.ref}</span>
            </div>
          )}

          <div className="grid lg:grid-cols-[1fr_17rem]">
            <div className="min-w-0 p-5 md:p-6">
              <p className="text-sm font-semibold text-primary">
                {new Date(event.start).toLocaleDateString(intlLocaleTag(locale), {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}
              </p>
              <h1 className="mt-1 font-display text-title font-extrabold">{title}</h1>

              <dl className="mt-5 grid gap-2.5 sm:grid-cols-2">
                <Meta label={t("venue")} value={venue} hint={gate} />
                <Meta label={t("zone")} value={zone} hint={seat ?? t("freeSeat")} />
                <Meta label={t("holderOf")} value={ticket.holderName} />
                <Meta label={t("paidPrice")} value={`${money(order.totalCents)} MAD`} />
              </dl>
            </div>

            {/*
              Same perforated-stub treatment as TicketPass, at the scale this
              page deserves: this is the one screen a buyer actually holds up
              at the gate, so the QR gets the most room it can get rather than
              competing with everything else in a 208px card.
            */}
            <div className="relative flex flex-col items-center justify-center gap-3 border-t border-dashed border-line/25 bg-brume/40 p-5 lg:border-s lg:border-t-0">
              <span
                className="absolute -top-2.5 inset-inline-0 mx-auto size-5 rounded-full bg-paper lg:inset-inline-auto lg:top-0 lg:-mt-2.5 lg:-ms-2.5 lg:start-0"
                aria-hidden
              />
              <span
                className="absolute -bottom-2.5 inset-inline-0 mx-auto size-5 rounded-full bg-paper lg:inset-inline-auto lg:bottom-0 lg:-mb-2.5 lg:-ms-2.5 lg:start-0"
                aria-hidden
              />
              <Badge tone={STATUS_TONE[ticket.status] ?? "neutral"}>{statusLabel}</Badge>
              <div className="rounded-control bg-white p-3 shadow-card">
                <QrMark value={data.qrPayload} className="size-52" />
              </div>
              <p className="max-w-52 text-center text-xs leading-relaxed text-muted">{t("brightness")}</p>
            </div>
          </div>
        </article>

        {/* Invoice, as a real Card with aligned figures instead of loose
            flex rows — the total gets its own weight at the bottom, same
            pattern as Confirmation's amount line. */}
        <Card className="mt-4">
          <h2 className="font-display text-lg font-bold">{t("invoice")}</h2>
          <dl className="mt-3 grid gap-2 text-sm">
            <Row label={t("subtotal")} value={`${money(order.subtotalCents)} MAD`} />
            <Row label={t("fees")} value={t("feesFree")} />
            <Row label={t("vat")} value={t("included")} />
          </dl>
          <div className="mt-3 flex items-baseline justify-between border-t border-line/10 pt-3">
            <span className="font-display text-lg font-bold">{t("totalDebited")}</span>
            <span className="font-display text-xl font-extrabold tabular-nums">{money(order.totalCents)} MAD</span>
          </div>
          <p className="mt-3 font-mono text-xs text-muted">
            {order.paymentRef} · {order.cardBank} ···· {order.cardLast4}
          </p>
        </Card>

        {/* Only offered while the ticket is still a live entitlement. */}
        {options && ticket.status === "VALID" ? (
          <Card className="no-print mt-4">
            <h2 className="font-display text-lg font-bold">{t("manageTicket")}</h2>

            {/* Nothing here is destructive any more, so nothing is in danger
                colour. The cancel button used to sit beside these and was the
                only one that could lose the holder money — it is gone, and
                resale below is what someone who cannot attend wants instead. */}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                icon={<Pencil className="size-4" />}
                onClick={() => setRenaming(data?.ticket?.holderName ?? "")}
                disabled={busy}
              >
                {t("fixName")}
              </Button>
            </div>

            {/*
              Resale — the only way a holder recovers their money.
              Tickets are final sale: cancelling above returns the seat but
              not the price, so for someone who simply cannot attend this is
              the answer. Stated plainly next to the cancel button, because
              otherwise they take the one that pays nothing.

              Three states, and the panel is absent entirely in a fourth
              (the organiser has not enabled resale) rather than showing a
              button that could only fail.
            */}
            {options.resale ? (
              <div className="mt-4 rounded-control border border-line/15 bg-paper p-3">
                <p className="text-sm font-bold">{t("resaleLive")}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  {t("resaleLiveNote").replace("{n}", money(options.resale.priceCents))}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Copy className="size-4" />}
                    onClick={() => copyResale(options.resale.token)}
                    disabled={busy}
                  >
                    {t("resaleCopy")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => cancelListing(options.resale.id)}
                    disabled={busy}
                  >
                    {t("resaleWithdraw")}
                  </Button>
                </div>
              </div>
            ) : options.resellable ? (
              <div className="mt-4 rounded-control border border-line/15 bg-paper p-3">
                <p className="text-sm font-bold">{t("resaleTitle")}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  {t("resaleNote").replace("{n}", money(options.facePriceCents ?? 0))}
                </p>
                <Button
                  className="mt-3"
                  variant="secondary"
                  size="sm"
                  icon={<Tag className="size-4" />}
                  onClick={listForResale}
                  disabled={busy}
                >
                  {t("resaleList")}
                </Button>
              </div>
            ) : null}

            {/*
              A guest reached this page with their confirmation link, which is
              all they need to show the QR at the gate — but not enough to
              refund the money or hand the seat to someone else, since that
              link travels. Rather than render buttons that are now certain to
              403, offer the one step that unlocks them.
            */}
            {!options.viaSession ? (
              <div className="mt-4 rounded-control border border-line/15 bg-paper p-4">
                <p className="flex items-center gap-2 text-sm font-bold">
                  <UserPlus className="size-4 text-primary" />
                  {t("claimOrderTitle")}
                </p>
                <p className="mt-1.5 text-xs leading-relaxed text-muted">{t("claimBody")}</p>
                <Button
                  variant="primary"
                  size="sm"
                  className="mt-3"
                  loading={busy}
                  onClick={user ? claimOrder : () => navigate("/login")}
                >
                  {user ? t("claimSignedIn") : t("claimCta")}
                </Button>
              </div>
            ) : null}

            {options.exchange?.length ? (
              <>
                <h3 className="mt-5 flex items-center gap-2 text-sm font-bold">
                  <TicketIcon className="size-4 text-muted" />
                  {t("changeZone")}
                </h3>
                <ul className="mt-2 grid gap-2">
                  {options.exchange.map((z) => (
                    <li
                      key={z.tierId}
                      className={cn(
                        "flex items-center justify-between gap-3 rounded-control bg-paper px-3.5 py-2.5",
                        z.soldOut && "opacity-60",
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold">{eventText(z, "name", locale)}</span>
                        <span
                          className={cn(
                            "block text-xs",
                            z.forfeitCents > 0 ? "font-semibold text-warn" : "text-muted",
                          )}
                        >
                          {z.dueCents > 0
                            ? t("zoneExtra").replace("{n}", money(z.dueCents))
                            : z.forfeitCents > 0
                              ? t("zoneForfeit").replace("{n}", money(z.forfeitCents))
                              : t("zoneSame")}
                        </span>
                      </span>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          z.dueCents > 0
                            ? openUpgrade(z)
                            : changeZone(z.tierId, z.forfeitCents ?? 0)
                        }
                        // Upgrading now works: it opens a payment dialog
                        // rather than moving the seat, so only a full zone
                        // and an in-flight request disable it.
                        disabled={busy || z.soldOut || !options.viaSession}
                      >
                        {z.soldOut
                          ? t("zoneSoldOut")
                          : z.dueCents > 0
                            ? t("zoneUpgrade")
                            : t("changeZone")}
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {/* Give it away. An open link is shown back rather than offering
                a second "share" button the server would refuse. */}
            {/* Giving the ticket away disposes of the seat, so it needs an
                account for the same reason cancelling does. Hidden entirely
                for a guest -- the claim prompt above is the path to it. */}
            {!options.viaSession ? null : options.share ? (
              <>
                <h3 className="mt-5 flex items-center gap-2 text-sm font-bold">
                  <Share2 className="size-4 text-muted" />
                  {t("shareTicket")}
                </h3>
                <p className="mt-1 text-xs text-muted">{t("shareOpen")}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button variant="primary" size="sm" onClick={() => copyShare(options.share.token)} disabled={busy}>
                    {t("shareCopy")}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => revokeShare(options.share.id)} disabled={busy}>
                    {t("shareRevoke")}
                  </Button>
                </div>
              </>
            ) : options.shareable ? (
              <>
                <h3 className="mt-5 flex items-center gap-2 text-sm font-bold">
                  <Share2 className="size-4 text-muted" />
                  {t("shareTicket")}
                </h3>
                <p className="mt-1 text-xs text-muted">{t("shareTicketHint")}</p>
                <Field label={t("shareMessage")} className="mt-2">
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      describedBy={describedBy}
                      invalid={invalid}
                      value={shareMessage}
                      onChange={(event) => setShareMessage(event.target.value)}
                      maxLength={280}
                      placeholder={t("shareMessagePlaceholder")}
                    />
                  )}
                </Field>
                <Button variant="primary" size="sm" className="mt-3" onClick={createShare} disabled={busy}>
                  {t("shareCreate")}
                </Button>
                <p className="mt-2 text-xs text-muted">{t("shareNote")}</p>
              </>
            ) : null}
          </Card>
        ) : null}
      </Container>

      {/*
        Paying to move up a zone.
        Two states in one dialog: the contact form, then CMI's hand-off once
        the server has created the order and reserved the seat. Closing it
        releases that seat rather than leaving it held.
      */}
      <Modal
        open={upgrade !== null}
        onClose={closeUpgrade}
        title={t("zoneUpgrade")}
        size="sm"
        footer={
          upgradeCmi ? null : (
            <>
              <Button variant="secondary" onClick={closeUpgrade}>
                {t("cancel")}
              </Button>
              <Button
                type="submit"
                form="upgrade-form"
                loading={busy}
                disabled={payName.trim().length < 3 || !payEmail.trim() || !payPhone.trim()}
              >
                {t("zoneUpgradeCta").replace("{n}", money(upgrade?.dueCents ?? 0))}
              </Button>
            </>
          )
        }
      >
        <div className="rounded-control border border-primary/20 bg-primary/10 p-3.5">
          <p className="text-sm text-muted">{t("zoneUpgradeTo").replace("{z}", upgrade?.name ?? "")}</p>
          <p className="font-display text-heading font-extrabold leading-none tabular-nums">
            {money(upgrade?.dueCents ?? 0)} <span className="text-sm font-bold text-muted">MAD</span>
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted">{t("zoneUpgradeNote")}</p>
        </div>

        {upgradeCmi ? (
          <div className="mt-4">
            <CmiRedirect
              action={upgradeCmi.action}
              fields={upgradeCmi.fields}
              dueCents={upgrade?.dueCents ?? 0}
              // Leaving on purpose: do NOT release the seat we are paying for.
              onLeave={() => setUpgradeCmi((c) => ({ ...c, upgradeId: null }))}
            />
          </div>
        ) : (
          <form id="upgrade-form" className="mt-4 grid gap-3" onSubmit={startUpgrade}>
            <Field label={t("fullName")} required>
              {(props) => <Input {...props} value={payName} onChange={(e) => setPayName(e.target.value)} autoComplete="name" />}
            </Field>
            <Field label={t("email")} required>
              {(props) => <Input {...props} type="email" value={payEmail} onChange={(e) => setPayEmail(e.target.value)} autoComplete="email" />}
            </Field>
            <Field label={t("phone")} required>
              {(props) => <Input {...props} value={payPhone} onChange={(e) => setPayPhone(e.target.value)} autoComplete="tel" />}
            </Field>
          </form>
        )}
      </Modal>

      {/* Agreeing to a forfeit. Danger-coloured because, unlike everything
          else on this page, confirming it loses the holder money. */}
      <Modal
        open={confirmZone !== null}
        onClose={() => setConfirmZone(null)}
        title={t("changeZone")}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmZone(null)}>
              {t("cancel")}
            </Button>
            <Button variant="danger" loading={busy} onClick={() => applyZone(confirmZone.tierId)}>
              {t("zoneForfeitConfirmCta").replace("{n}", money(confirmZone?.forfeitCents ?? 0))}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-muted">
          {t("zoneForfeitConfirm").replace("{n}", money(confirmZone?.forfeitCents ?? 0))}
        </p>
      </Modal>

      <Modal
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        title={t("fixName")}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setRenaming(null)}>
              {t("cancel")}
            </Button>
            <Button type="submit" form="rename-form" loading={busy} disabled={(renaming ?? "").trim().length < 2}>
              {t("saveProfile")}
            </Button>
          </>
        }
      >
        <form id="rename-form" onSubmit={submitName}>
          <Field label={t("holderOf")} required>
            {(props) => <Input {...props} value={renaming ?? ""} onChange={(e) => setRenaming(e.target.value)} autoComplete="name" />}
          </Field>
        </form>
      </Modal>
    </Shell>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
