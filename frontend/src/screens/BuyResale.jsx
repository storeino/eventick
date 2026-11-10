import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { CalendarDays, Link2Off, Tag, Ticket } from "lucide-react";
import { toast } from "sonner";
import { Shell } from "../components/Shell";
import CmiRedirect from "./CmiRedirect";
import { api, money } from "../api";
import { useAuth } from "../AuthContext";
import { Badge, Button, Container, Field, Input, Skeleton } from "../ui";
import { useI18n } from "../i18n";
import { emailOk, phoneOk, MIN_PASSWORD } from "../payment";
import { intlLocaleTag } from "../utils";

/**
 * Buy a ticket somebody is reselling.
 *
 * The seller could not attend. Tickets are final sale, so reselling is how
 * they get their money back — and this page is the other half of that: the
 * link they shared, opened by whoever is buying.
 *
 * It is a PURCHASE, not a claim. The gift flow next door (ClaimShare) hands a
 * seat over for nothing and needs no account; this one moves money, so it
 * needs a signed-in buyer like any other sale, and it goes through the same
 * CMI redirect the checkout does.
 *
 * The seat is one that already exists, not fresh inventory: no OrderLine is
 * created, so the tier's remaining count is untouched and the seat stays
 * counted exactly once.
 */
export default function BuyResale() {
  const { token } = useParams();
  const { locale, t } = useI18n();
  const navigate = useNavigate();
  // Staff sell rather than buy: refuseStaffPurchase rejects an ORGANISER
  // or ADMIN at /resale/:token/buy, so without this they would fill in
  // three fields, press pay and collect a 403 -- a wall at the last step
  // instead of an explanation at the first. Same rule as EventDetail.
  const { user, canUsePro, loading: authLoading } = useAuth();

  const [listing, setListing] = useState(null);
  const [error, setError] = useState(null);
  /*
   * Name and email are the ACCOUNT's, not fields.
   *
   * Buying a resold seat requires a session (authenticate on the route), so
   * by the time this form renders the server already knows who this is. Two
   * empty boxes asking for a name and an address it holds were busywork,
   * and worse: they were editable, so the ticket could be issued in a name
   * the account never claimed and the confirmation sent somewhere the
   * buyer does not read.
   *
   * Phone is still asked. It is not on the user record, and CMI wants it
   * with the card payment.
   */
  const [phone, setPhone] = useState("");
  /* A visitor types their own details, and they become the account. Blank
     for a signed-in buyer, whose session the server reads instead. */
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [guestPassword, setGuestPassword] = useState("");
  /* An account with no password yet, from an earlier express checkout.
     Distinct from needsPassword: that one proves an identity, this one
     creates a credential. See Checkout.jsx, which has the same pair. */
  const [settingPassword, setSettingPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cmi, setCmi] = useState(null);

  useEffect(() => {
    api
      .get(`/resale/${token}`)
      .then(setListing)
      /*
       * 410 is the expected ending, not a fault: a listing is single-use, so
       * the second person to open a link that has already sold gets this.
       * Saying "no longer available" is the honest answer; the raw message
       * would read as a broken page.
       */
      .catch((err) => setError(err.status === 410 ? t("resaleGone") : err.message));
  }, [token, t]);


  const eventTitle = listing
    ? (locale === "ar" ? listing.eventTitleAr : listing.eventTitleFr) || listing.eventTitleFr
    : "";
  const tierName = listing
    ? (locale === "ar" ? listing.tierNameAr : listing.tierNameFr) || listing.tierNameFr
    : "";

  /*
   * Ask for a reset link without leaving the checkout.
   *
   * The seats are held for fifteen minutes, so sending the buyer away to
   * their inbox is how a sale is lost: they come back to an expired hold
   * and start again, if they come back. The request fires from here and the
   * reset page opens in ANOTHER tab, leaving this one -- and its countdown,
   * and everything typed into it -- exactly where it was.
   */
  const [forgotBusy, setForgotBusy] = useState(false);
  const askForReset = async () => {
    if (forgotBusy) return;
    const address = (user?.email ?? guestEmail).trim();
    if (!emailOk(address)) return toast.error(t("errEmail"));
    setForgotBusy(true);
    try {
      await api.post("/auth/forgot-password", { email: address, locale: locale === "ar" ? "ar" : "fr" });
      /* The same message whether or not that address has an account: the
         server deliberately will not say, and neither should this. */
      toast.success(t("forgotSent"), { duration: 8000 });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setForgotBusy(false);
    }
  };

  const buy = async () => {
    if (busy) return;
    /* Only when the field was shown. An account that already has a number
       submits nothing and the server falls back to it -- demanding a valid
       value for a hidden field would make the button do nothing with no
       visible reason why. */
    if (!user?.phone && !phoneOk(phone)) return toast.error(t("errPhone"));
    if (!user) {
      if (guestName.trim().length < 3) return toast.error(t("errName"));
      if (!emailOk(guestEmail)) return toast.error(t("errEmail"));
      if (needsPassword && !guestPassword) return toast.error(t("errPassword"));
      if (settingPassword && guestPassword.length < MIN_PASSWORD) {
        return toast.error(
          guestPassword.length < 1 ? t("errChoosePassword") : t("errPasswordShort"),
        );
      }
    }

    setBusy(true);
    try {
      const res = await api.post(`/resale/${token}/buy`, {
        /* For a signed-in buyer the server reads the session and ignores
           these; for a visitor they are the account about to be created. */
        holderName: (user?.name ?? guestName).trim(),
        email: (user?.email ?? guestEmail).trim(),
        /* Omitted when the field was not shown: the server reads the
           account instead. Sending "" would fail its check. */
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        ...(needsPassword && guestPassword ? { password: guestPassword } : {}),
        /* Set, not checked -- a different key for a different operation. */
        ...(settingPassword && guestPassword ? { newPassword: guestPassword } : {}),
        locale,
      });

      if (res.mode === "cmi") {
        // Same hand-off as the checkout: CMI's own card page, never ours.
        setCmi({ action: res.action, fields: res.fields });
        return;
      }

      /*
       * Mock mode settles on the spot. No access token to remember: buying
       * requires an account, so the order carries the buyer's customerId and
       * their session is what opens the confirmation.
       */
      toast.success(t("resaleBought"));
      navigate(res.orderId ? `/confirmation/${res.orderId}` : "/billets");
    } catch (err) {
      /* The email belongs to an account: grow a password field in place
         rather than redirecting, which would lose the form they filled. */
      if (err.data?.emailTaken) {
        setNeedsPassword(true);
        setSettingPassword(false);
        toast.error(t("errPasswordNeeded"));
        setBusy(false);
        return;
      }
      /* No password on the account yet: they choose one here. This used to
         show the server's "use the link in your ticket email" and stop --
         advice with nowhere to follow it, since no reset route exists. */
      if (err.data?.needsPasswordSetup) {
        setSettingPassword(true);
        setNeedsPassword(false);
        /* Cleared: what they typed was a guess at a password that does not
           exist, and keeping it under a "choose one" label would make the
           guess real. */
        setGuestPassword("");
        toast.error(t("errChoosePassword"));
        setBusy(false);
        return;
      }
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <Shell>
        <Container className="py-12">
          <div className="mx-auto max-w-md rounded-panel border border-line/15 bg-card p-8 text-center">
            <Link2Off className="mx-auto size-10 text-muted" />
            <h1 className="mt-4 font-display text-2xl font-extrabold">{t("resaleGoneTitle")}</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted">{error}</p>
            <Button className="mt-5" onClick={() => navigate("/explorer")}>
              {t("browseEvents")}
            </Button>
          </div>
        </Container>
      </Shell>
    );
  }

  if (!listing) {
    return (
      <Shell>
        <Container className="py-12">
          <Skeleton className="mx-auto h-64 max-w-md" />
        </Container>
      </Shell>
    );
  }

  return (
    <Shell>
      <Container className="py-10">
        <div className="mx-auto max-w-md">
          <div className="rounded-panel border border-line/15 bg-card p-6">
            <Badge tone="info">
              <Tag className="size-3.5" />
              {t("resaleBadge")}
            </Badge>

            <h1 className="mt-3 font-display text-2xl font-extrabold leading-tight">{eventTitle}</h1>

            <p className="mt-2 flex items-center gap-2 text-sm text-muted">
              <CalendarDays className="size-4 shrink-0" />
              {new Date(listing.eventStart).toLocaleString(intlLocaleTag(locale), {
                dateStyle: "long",
                timeStyle: "short",
              })}
            </p>
            <p className="mt-1 flex items-center gap-2 text-sm text-muted">
              <Ticket className="size-4 shrink-0" />
              {tierName}
              {listing.seatRow ? ` · ${listing.seatRow}${listing.seatNumber ?? ""}` : ""}
            </p>

            {/* Face value, and said so: a resale here is never marked up, and
                a buyer who knows that does not have to wonder. */}
            <div className="mt-4 rounded-control border border-primary/20 bg-primary/10 p-4">
              <p className="text-sm text-muted">{t("resalePrice")}</p>
              <p className="font-display text-display font-extrabold leading-none tabular-nums">
                {money(listing.priceCents)} <span className="text-heading font-bold text-muted">MAD</span>
              </p>
              <p className="mt-1 text-xs text-muted">{t("resaleFaceValue")}</p>
            </div>

            {/*
              Buying needs an account, the same rule as every other purchase.
              Checked before the form rather than after it, so nobody fills in
              three fields and is then sent to sign in. `authLoading` is waited
              on so the prompt does not flash during hydration.
            */}
            {/* Your own listing. The server refuses it (409) because buying
                your own seat credits you the face value you just paid --
                a loop that prints balance and charges the organiser
                commission on a sale that moved a seat to nobody. Said here
                so the button is not offered at all, rather than failing
                after the buyer has filled the form. */}
            {!authLoading && listing.isOwn ? (
              <div className="mt-5 rounded-control border border-line/15 bg-paper p-3">
                <p className="text-sm leading-relaxed text-muted">{t("resaleOwnListing")}</p>
                <Button className="mt-3" variant="secondary" full onClick={() => navigate("/billets")}>
                  {t("resaleOwnListingCta")}
                </Button>
              </div>
            ) : !authLoading && canUsePro ? (
              <p className="mt-5 rounded-control border border-line/15 bg-paper p-3 text-sm leading-relaxed text-muted">
                {t("staffNoBuy")}
              </p>
            ) : cmi ? (
              <div className="mt-5">
                <CmiRedirect
                  action={cmi.action}
                  fields={cmi.fields}
                  dueCents={listing.priceCents}
                  onLeave={() => setBusy(false)}
                />
              </div>
            ) : (
              <div className="mt-5 grid gap-3">
                {/* Who this seat is for, stated rather than asked. The
                    account is already signed in, so these are facts, not
                    questions -- and leaving them editable let a buyer put
                    someone else's name on a ticket their own account owns. */}
                {/* Signed in: stated. A visitor types them, and they become
                    the account — the same path the ordinary checkout takes,
                    because buying a resold seat is still buying and a wall
                    on only one of the two doors is not a rule. */}
                {user ? (
                  <div className="rounded-control border border-line/10 bg-paper px-3 py-2.5">
                    <p className="text-xs text-muted">{t("resaleBuyerIs")}</p>
                    <p className="mt-0.5 truncate font-semibold text-ink">{user?.name}</p>
                    <p className="truncate text-sm text-muted">{user?.email}</p>
                  </div>
                ) : (
                  <>
                    <Field label={t("fullName")} required>
                      <Input
                        value={guestName}
                        onChange={(e) => setGuestName(e.target.value)}
                        autoComplete="name"
                      />
                    </Field>
                    <Field label={t("email")} required>
                      <Input
                        type="email"
                        value={guestEmail}
                        onChange={(e) => {
                          setGuestEmail(e.target.value);
                          /* A different address makes the password question
                             moot: it was about the previous one. */
                          if (needsPassword || settingPassword) {
                            setNeedsPassword(false);
                            setSettingPassword(false);
                            setGuestPassword("");
                          }
                        }}
                        autoComplete="email"
                        placeholder="nom@exemple.ma"
                      />
                    </Field>
                    {needsPassword || settingPassword ? (
                      <Field
                        label={settingPassword ? t("choosePassword") : t("password")}
                        required
                        hint={settingPassword ? t("choosePasswordHint") : t("passwordForExisting")}
                      >
                        <Input
                          type="password"
                          value={guestPassword}
                          onChange={(e) => setGuestPassword(e.target.value)}
                          /* new-password where one is being chosen, so the
                             browser offers to save rather than to fill. */
                          autoComplete={settingPassword ? "new-password" : "current-password"}
                          minLength={settingPassword ? MIN_PASSWORD : undefined}
                        />
                        {/* Only where a password is being ENTERED. Offering a
                            reset to someone choosing their first one would be
                            an invitation to a round trip they do not need. */}
                        {needsPassword ? (
                          <button
                            type="button"
                            onClick={askForReset}
                            disabled={forgotBusy}
                            className="mt-2 text-start text-xs font-semibold text-muted underline underline-offset-2 hover:text-ink disabled:opacity-50"
                          >
                            {forgotBusy ? t("forgotSending") : t("forgotPassword")}
                          </button>
                        ) : null}
                      </Field>
                    ) : null}
                  </>
                )}
                {/* Asked ONLY when the account has no number.
                    It is collected at sign-up now, so this is empty for
                    almost nobody: accounts created before the column
                    existed have nothing to reuse, and they are asked here
                    once. What they type is saved to the account, so the
                    field does not come back on their next purchase.

                    The ordinary checkout has done this since User.phone was
                    added; this page kept asking everyone, every time, which
                    is exactly the re-typing that change set out to end. */}
                {user && user.phone ? null : (
                  <Field label={t("phone")} required hint={t("resalePhoneHint")}>
                    <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="06 12 34 56 78" />
                  </Field>
                )}
                <Button full size="lg" loading={busy} onClick={buy}>
                  {t("resaleBuy")}
                </Button>
              </div>
            )}
          </div>

          <p className="mt-3 text-center text-xs leading-relaxed text-muted">{t("resaleBuyerNote")}</p>
        </div>
      </Container>
    </Shell>
  );
}
