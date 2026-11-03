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
import { emailOk, phoneOk } from "../payment";
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
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
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

  // Prefill from the account, exactly as Checkout does — the buyer has
  // already told us who they are by signing in.
  useEffect(() => {
    if (!user) return;
    setName((prev) => prev || user.name || "");
    setEmail((prev) => prev || user.email || "");
  }, [user]);

  const eventTitle = listing
    ? (locale === "ar" ? listing.eventTitleAr : listing.eventTitleFr) || listing.eventTitleFr
    : "";
  const tierName = listing
    ? (locale === "ar" ? listing.tierNameAr : listing.tierNameFr) || listing.tierNameFr
    : "";

  const buy = async () => {
    if (busy) return;
    if (name.trim().length < 3) return toast.error(t("errName"));
    if (!emailOk(email)) return toast.error(t("errEmail"));
    if (!phoneOk(phone)) return toast.error(t("errPhone"));

    setBusy(true);
    try {
      const res = await api.post(`/resale/${token}/buy`, {
        holderName: name.trim(),
        email: email.trim(),
        phone: phone.trim(),
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
            {!authLoading && canUsePro ? (
              <p className="mt-5 rounded-control border border-line/15 bg-paper p-3 text-sm leading-relaxed text-muted">
                {t("staffNoBuy")}
              </p>
            ) : !authLoading && !user ? (
              <div className="mt-5">
                <p className="text-sm leading-relaxed text-muted">{t("resaleSignInNote")}</p>
                <Button
                  className="mt-3"
                  full
                  onClick={() =>
                    navigate(`/login?next=${encodeURIComponent(`/revente/${token}`)}`)
                  }
                >
                  {t("paySignIn")}
                </Button>
              </div>
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
                <Field label={t("fullName")} required>
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("fullName")} />
                </Field>
                <Field label={t("email")} required>
                  <Input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="nom@exemple.ma"
                  />
                </Field>
                <Field label={t("phone")} required>
                  <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="06 12 34 56 78" />
                </Field>
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
