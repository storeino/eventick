import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Lock } from "lucide-react";
import { toast } from "sonner";
import { Shell } from "../components/Shell";
import CmiRedirect from "./CmiRedirect";
import { api, money } from "../api";
import { useCart } from "../CartContext";
import { useAuth } from "../AuthContext";
import { useI18n } from "../i18n";
import { Button, Card, Container, Countdown, Field, Input, LoadingState, Notice } from "../ui";
import { emailOk, phoneOk } from "../payment";
import { cn, eventText } from "../utils";

export default function Checkout() {
  const { locale, t, tf } = useI18n();
  const { cart, clear } = useCart();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [event, setEvent] = useState(null);
  const filled = useRef(false);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [errors, setErrors] = useState({});
  const [promo, setPromo] = useState("");
  const [promoOn, setPromoOn] = useState("");
  const [discountCents, setDiscountCents] = useState(0);

  const [payment, setPayment] = useState(null);
  const [busy, setBusy] = useState(false);

  // True from the moment payment succeeds. Without it, the guard below fires
  // on the way out: paying calls clear(), cart becomes null, this effect
  // re-runs and sends the buyer to /explorer — overriding the navigate to
  // /confirmation that had just been issued. They paid and landed on the
  // catalogue with no ticket in sight.
  const paid = useRef(false);

  useEffect(() => {
    if (paid.current) return;
    if (!cart) {
      navigate("/explorer");
      return;
    }
    /*
     * Buying requires an account, and this screen is reachable by URL.
     *
     * In practice a cart only exists after a hold, which already requires a
     * session — so a signed-out visitor here has no cart and is sent to the
     * catalogue by the line above. This is the explicit check rather than the
     * one that happens to fall out of that chain: a signed-out buyer who
     * still has a stale cart in local storage would otherwise fill the form
     * and be refused at /pay.
     *
     * `loading` is waited on so the redirect does not fire during the
     * auth-context hydration that happens on every page load.
     */
    if (!authLoading && !user) {
      navigate(`/login?next=${encodeURIComponent("/paiement")}`, { replace: true });
      return;
    }
    api.get(`/events/${cart.eventSlug}`).then((data) => setEvent(data.event));
  }, [cart, navigate, user, authLoading]);

  useEffect(() => {
    if (filled.current || !user) return;
    filled.current = true;
    setName(user.name ?? "");
    setEmail(user.email ?? "");
  }, [user]);

  // The countdown is the server hold created when they pressed Book.
  const holdUntil = cart?.holdUntil ?? null;

  /** The hold lapsed while they were on this page: the seats are gone, so
   * send them back to pick again rather than leaving a dead form. Fired once
   * by <Countdown>, which owns the clock. */
  const onHoldExpired = useCallback(() => {
    clear();
    toast.error(t("holdExpired"));
    navigate("/explorer");
  }, [clear, navigate, t]);

  // True once the buyer is on their way to CMI. Leaving for the gateway fires
  // `pagehide` exactly like abandoning the page does, so without this the
  // release handler below would cancel the very seats they are about to pay
  // for — and they would come back from a successful payment to find the
  // order gone.
  const leaving = useRef(false);
  const onLeaveForGateway = useCallback(() => {
    leaving.current = true;
  }, []);

  // A buyer who leaves before paying shouldn't sit on seats for 15 minutes.
  const heldId = cart?.orderId ?? null;
  const settled = Boolean(payment?.settled);
  useEffect(() => {
    if (!heldId || settled) return;
    // Must be api.del, not sendBeacon: sendBeacon only ever issues POST, so
    // it 404s against this DELETE route — and since it returns true on
    // *queueing* rather than on a 2xx, an `||` fallback never runs. That bug
    // meant abandoned carts held their seats for the full 15 minutes.
    const release = () => {
      if (leaving.current) return;
      api.del(`/orders/hold/${heldId}`, { keepalive: true }).catch(() => {});
    };
    window.addEventListener("pagehide", release);
    return () => window.removeEventListener("pagehide", release);
  }, [heldId, settled]);

  /*
   * A declined payment comes back as a REDIRECT, not a callback: CMI sends the
   * buyer to failUrl (/paiement?echec=1), so the only trace of the failure is
   * in the URL when this page loads again. Without reading it the buyer would
   * return to a silent, apparently-fine form and have no idea the card was
   * refused.
   *
   * The parameter is stripped afterwards so a refresh does not re-announce a
   * failure they have already seen.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("echec")) return;
    toast.error(t("payDeclined"));
    params.delete("echec");
    params.delete("commande");
    const query = params.toString();
    window.history.replaceState({}, "", window.location.pathname + (query ? `?${query}` : ""));
  }, [t]);

  if (!cart || !event) {
    return (
      <Shell>
        <Container size="form" className="py-10">
          <LoadingState label={t("loadingEvents")} rows={2} />
        </Container>
      </Shell>
    );
  }

  const lines = cart.lines
    .map((line) => {
      const tier = event.tiers.find((item) => item.id === line.tierId);
      if (!tier) return null;
      const qty = Math.min(line.qty, tier.remaining);
      return qty > 0 ? { tier, qty } : null;
    })
    .filter(Boolean);

  if (lines.length === 0) {
    return (
      <Shell>
        <Container size="narrow" className="py-20 text-center">
          <h1 className="font-display text-title font-extrabold">{t("emptyPay")}</h1>
          <Button className="mt-6" onClick={() => navigate("/explorer")}>
            {t("backEvents")}
          </Button>
        </Container>
      </Shell>
    );
  }

  const total = lines.reduce((sum, line) => sum + line.qty * line.tier.priceCents, 0);
  const due = total - discountCents;

  const applyPromo = async (e) => {
    e.preventDefault();
    try {
      const result = await api.get(`/events/${event.slug}/quote-promo?code=${encodeURIComponent(promo)}&subtotalCents=${total}`);
      if (!result.valid) {
        setPromoOn("");
        setDiscountCents(0);
        toast.error(t("promoBad"));
        return;
      }
      setPromoOn(promo.trim());
      setDiscountCents(result.discountCents);
      toast.success(t("promoOk"));
    } catch {
      toast.error(t("promoBad"));
    }
  };

  /**
   * Step 1 — hand the buyer's details to the order that is ALREADY holding
   * these seats, then ask for a payment intent.
   *
   * The reservation happened on the event page, before this form was shown,
   * so there is nothing here that can fail for want of stock.
   */
  const reserve = async (e) => {
    e.preventDefault();
    if (busy) return;
    const next = {};
    if (name.trim().length < 3) next.name = t("errName");
    if (!emailOk(email)) next.email = t("errEmail");
    if (!phoneOk(phone)) next.phone = t("errPhone");
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    // Read the id BEFORE clearing: `cart` is the thing clear() empties, so
    // building the confirmation URL from it afterwards is a race against the
    // state update.
    const orderId = cart.orderId;
    try {
      const pay = await api.post(`/orders/${orderId}/pay`, {
        holderName: name.trim(),
        email: email.trim(),
        phone: phone.trim(),
        locale,
      });
      setPayment(pay);

      // Mock mode settles immediately — there is no gateway to redirect to.
      if (pay.mode === "mock" && pay.settled) {
        // Order matters: mark it paid first, so the guard effect above does
        // not treat the emptied cart as "no cart, send them to /explorer".
        paid.current = true;
        clear();
        navigate(`/confirmation/${orderId}`, { replace: true });
      }
    } catch (err) {
      setPayment(null);
      // 410 = the hold lapsed while they were filling the form. Send them
      // back to pick again rather than leaving them on a dead page.
      if (err.status === 410) {
        clear();
        toast.error(t("holdExpired"));
        navigate(`/evenements/${cart.eventSlug}`);
        return;
      }
      toast.error(err.message || t("reserveFail"));
    } finally {
      setBusy(false);
    }
  };

  const cmiReady = payment?.mode === "cmi" && payment.action && payment.fields;

  return (
    <Shell>
      <Container className="py-8">
        {/*
          The countdown comes FIRST, full width, above both columns.
          It used to sit mid-column between a stepper and a form, styled the
          same as the mock-mode notice beside it - equal weight for the one
          thing on this page that is actually running out.
        */}
        <Countdown
          until={holdUntil}
          label={t("holdNote")}
          expiredLabel={t("holdExpired")}
          onExpire={onHoldExpired}
          className="mb-6"
        />

        <div className="grid gap-6 lg:grid-cols-[1fr_22rem] lg:items-start">
          <div className="min-w-0">
            <h1 className="font-display text-title font-extrabold">{t("payTitle")}</h1>

            {/* Progress. aria-current marks the live step for a screen reader
                rather than relying on the colour change alone. A connecting
                line between numbered circles instead of a row of disjointed
                pills -- the old treatment read as three unrelated buttons,
                not a journey with a start and an end. */}
            <ol className="mt-5 flex items-center text-xs font-bold">
              {[
                { n: 1, label: t("stepInfo"), done: Boolean(payment), active: !payment },
                { n: 2, label: t("stepPay"), done: false, active: Boolean(payment) },
                { n: 3, label: t("stepDone"), done: false, active: false },
              ].map((step, i, all) => (
                <li key={step.n} className={cn("flex items-center", i < all.length - 1 && "flex-1")}>
                  <span aria-current={step.active ? "step" : undefined} className="flex shrink-0 items-center gap-2">
                    <span
                      className={cn(
                        "flex size-7 shrink-0 items-center justify-center rounded-full",
                        step.active
                          ? "bg-action text-action-fg"
                          : step.done
                            ? "bg-success text-success-fg"
                            : "bg-paper text-muted",
                      )}
                    >
                      {step.done ? <Check className="size-3.5" aria-hidden /> : step.n}
                    </span>
                    <span className={step.active || step.done ? "text-ink" : "text-muted"}>{step.label}</span>
                  </span>
                  {i < all.length - 1 ? (
                    <span className={cn("mx-3 h-px flex-1", all[i + 1].active || all[i + 1].done || step.done ? "bg-success" : "bg-line/15")} aria-hidden />
                  ) : null}
                </li>
              ))}
            </ol>

            {payment?.mode === "mock" ? (
              <Notice tone="info" className="mt-4">
                {t("mockMode")}
              </Notice>
            ) : null}

            {!payment ? (
              <Card className="mt-5">
                <h2 className="font-display text-heading font-extrabold">{t("buyer")}</h2>
                <form className="mt-4 grid gap-4 md:grid-cols-2" onSubmit={reserve} noValidate>
                  <Field label={t("fullName")} error={errors.name} required>
                    {(props) => <Input {...props} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />}
                  </Field>
                  <Field label={t("email")} error={errors.email} required>
                    {(props) => (
                      <Input {...props} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
                    )}
                  </Field>
                  <Field label={t("phone")} error={errors.phone} required className="md:col-span-2">
                    {(props) => (
                      <Input
                        {...props}
                        type="tel"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        autoComplete="tel"
                        placeholder="06 12 34 56 78"
                      />
                    )}
                  </Field>

                  <div className="md:col-span-2">
                    <Button type="submit" full size="lg" loading={busy}>
                      {busy ? t("reserving") : t("stepPay")}
                    </Button>
                    <p className="mt-3 flex items-center justify-center gap-2 text-center text-xs text-muted">
                      <Lock className="size-3.5 shrink-0" aria-hidden />
                      {t("cardSecure")}
                    </p>
                  </div>
                </form>
              </Card>
            ) : (
              <Card className="mt-5">
                <h2 className="font-display text-heading font-extrabold">{t("payMethod")}</h2>
                <div className="mt-4">
                  {cmiReady ? (
                    <CmiRedirect
                      action={payment.action}
                      fields={payment.fields}
                      dueCents={due}
                      onLeave={onLeaveForGateway}
                    />
                  ) : (
                    <p className="text-sm text-muted">{t("processing")}</p>
                  )}
                </div>
              </Card>
            )}
          </div>

          {/* Order summary. The total is the largest thing on the page after
              the countdown, because those are the two facts that matter. */}
          <aside className="lg:sticky lg:top-24">
            {/* Deliberately always dark, regardless of app theme — stage,
                not card/paper. Was bg-encre/text-foam, which coincidentally
                worked in the old charte because light-mode encre and
                dark-mode foam were both near-black; both are theme-reactive
                now, so in dark mode this rendered as a near-white card with
                dark text sitting inside an otherwise-dark page. */}
            <Card pad={false} className="overflow-hidden bg-stage text-stage-fg">
              <img src={event.image} alt="" className="h-28 w-full object-cover" />
              <div className="p-5">
                <h2 className="font-display text-subhead font-extrabold">{eventText(event, "title", locale)}</h2>
                <p className="mt-0.5 text-sm text-stage-muted">{event.city}</p>

                <ul className="mt-4 grid gap-2 border-t border-stage-fg/15 pt-4 text-sm">
                  {lines.map((line) => (
                    <li key={line.tier.id} className="flex min-w-0 justify-between gap-3">
                      <span className="min-w-0">
                        <span className="font-semibold tabular-nums">{line.qty}x</span>{" "}
                        {eventText(line.tier, "name", locale)}
                      </span>
                      <span className="shrink-0 tabular-nums">{money(line.qty * line.tier.priceCents)}</span>
                    </li>
                  ))}
                </ul>

                {!payment ? (
                  <form className="mt-4 flex gap-2 border-t border-stage-fg/15 pt-4" onSubmit={applyPromo}>
                    <Input
                      tone="stage"
                      value={promo}
                      onChange={(e) => setPromo(e.target.value)}
                      placeholder={t("promo")}
                      aria-label={t("promo")}
                      className="min-w-0 flex-1 font-mono text-sm uppercase"
                    />
                    <Button variant="inverse" type="submit">
                      {t("promoApply")}
                    </Button>
                  </form>
                ) : null}

                {discountCents > 0 ? (
                  <p className="mt-3 flex justify-between gap-3 text-sm font-semibold text-accent">
                    <span>
                      {t("discount")} {promoOn ? `- ${promoOn}` : ""}
                    </span>
                    <span className="tabular-nums">-{money(discountCents)}</span>
                  </p>
                ) : null}

                <div className="mt-4 border-t border-stage-fg/15 pt-4">
                  <p className="text-sm text-stage-muted">{t("total")}</p>
                  <p className="font-display text-display font-extrabold leading-none tabular-nums">
                    {money(due)} <span className="text-heading font-bold text-stage-muted">MAD</span>
                  </p>
                </div>
              </div>
            </Card>
          </aside>
        </div>
      </Container>
    </Shell>
  );
}

