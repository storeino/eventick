import { useEffect, useRef, useState } from "react";
import { CreditCard, ExternalLink, Lock, ShieldCheck } from "lucide-react";
import { money } from "../api";
import { useI18n } from "../i18n";
import { Button } from "../ui";

/**
 * Hand-off to CMI.
 *
 * CMI is a redirect gateway, not an embeddable one: the card is typed on CMI's
 * own 3-D Secure page, which is why there is no card field here and why the
 * number never reaches Eventick. All this screen does is POST a signed form to
 * CMI and get out of the way.
 *
 * It must be a real form POST rather than a fetch: CMI replies with its own
 * payment page, so the browser has to navigate there, and the fields are
 * signed server-side (the `hash`) so nothing here can alter the amount.
 *
 * The submit is NOT automatic. An auto-submitting page flashes and jumps,
 * which looks like a hijack at the exact moment someone is about to type a
 * card number — and if CMI is slow or down, an invisible auto-post leaves a
 * blank screen with nothing to retry. So the hand-off is one deliberate
 * click, with the amount and destination stated first.
 */
export default function CmiRedirect({ action, fields, dueCents, onLeave }) {
  const { t, tf } = useI18n();
  const formRef = useRef(null);
  const [going, setGoing] = useState(false);

  // If the browser restores this page from history after the buyer comes back
  // (bfcache), re-enable the button instead of leaving it stuck on "going".
  useEffect(() => {
    const onRestore = (event) => {
      if (event.persisted) setGoing(false);
    };
    window.addEventListener("pageshow", onRestore);
    return () => window.removeEventListener("pageshow", onRestore);
  }, []);

  const submit = (event) => {
    event.preventDefault();
    if (going) return;
    setGoing(true);
    // Tell the page we are leaving on purpose, so it does not release the
    // seats we are about to pay for.
    onLeave?.();
    formRef.current?.submit();
  };

  return (
    <form ref={formRef} method="post" action={action} onSubmit={submit}>
      {/* Signed server-side: the hash covers every one of these, so editing
          an amount here makes CMI reject the payment outright. */}
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}

      {/* The reassurance panel. `brume` is the brand tint, so this reads as
          part of Eventick rather than a browser warning — the point is that
          leaving for CMI is the normal, safe path, not an interruption. */}
      <div className="rounded-panel border border-primary/15 bg-brume/50 p-4">
        <p className="flex items-center gap-2 text-sm font-bold">
          <ShieldCheck className="size-4.5 shrink-0 text-primary" aria-hidden />
          {t("cmiTitle")}
        </p>
        <p className="mt-2 text-xs leading-relaxed text-muted">{t("cmiExplain")}</p>
      </div>

      {/* The amount, stated once and large.

          This is the last screen before the buyer's money leaves, and it used
          to show the total only inside the button's own label. Saying it on
          its own line first means the figure they confirm is the figure they
          read, not something they have to parse out of a sentence. */}
      <div className="mt-4 flex items-baseline justify-between gap-3 rounded-panel border border-line/15 bg-paper px-4 py-3.5">
        <span className="flex items-center gap-2 text-sm font-semibold text-muted">
          <CreditCard className="size-4 shrink-0" aria-hidden />
          {t("total")}
        </span>
        <span className="font-display text-xl font-extrabold tabular-nums">{money(dueCents)} MAD</span>
      </div>

      {/*
        The shared Button, not a hand-rolled one.

        This was `bg-safran text-encre` — tokens the v3 charte deleted. An
        undefined Tailwind colour emits no CSS at all, so the one button on
        the one screen where money changes hands rendered as bare text on the
        page background: no fill, no pill, nothing to aim at. It looked like a
        caption, and a buyer reported exactly that. Using Button means it
        cannot drift from the rest of the site again, and it brings the
        44px-plus target and the loading state with it.
      */}
      <Button
        type="submit"
        full
        size="lg"
        loading={going}
        icon={going ? null : <ExternalLink className="size-4" aria-hidden />}
        className="mt-4"
      >
        {going ? t("cmiGoing") : tf("cmiPayNow", { total: `${money(dueCents)} MAD` })}
      </Button>

      <p className="mt-3 flex items-center justify-center gap-2 text-center text-xs text-muted">
        <Lock className="size-3 shrink-0" aria-hidden />
        {t("cardSecure")}
      </p>
    </form>
  );
}
