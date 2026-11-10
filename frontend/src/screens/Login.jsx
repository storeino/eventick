import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Eye, EyeOff, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Shell } from "../components/Shell";
import { api } from "../api";
import { useAuth } from "../AuthContext";
import { useI18n } from "../i18n";
import { emailOk, phoneOk } from "../payment";
import { cn } from "../utils";
import { DEMO_ACCOUNTS } from "../demoAccounts";
import { Field, Input } from "../ui";

const SHOW_DEMO_ACCOUNTS = process.env.NODE_ENV !== "production";

export default function Login() {
  const { locale, t } = useI18n();
  const navigate = useNavigate();
  const { user, loading, login, register } = useAuth();
  const [mode, setMode] = useState("in");
  const [name, setName] = useState("");
  /* Collected at sign-up so it is asked once, instead of at every checkout.
     It used to live only on the order, which meant a buyer with six orders
     typed the same number six times. */
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  // Two kinds of error, because they have two different homes. `fieldErrors`
  // is what the user typed wrong, and belongs ON the input so a screen reader
  // reads it when focus lands there. `error` is what the SERVER refused —
  // wrong password, email already taken — which belongs to the form as a
  // whole, because no single input is at fault.
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState(null);

  const clearErrors = () => {
    setFieldErrors({});
    setError(null);
  };

  /*
   * "Forgot password?", which did not exist.
   *
   * There was no route, no email and no link anywhere, so an account whose
   * password had been forgotten was simply gone -- and at the checkout that
   * wall arrived with a seat hold counting down.
   */
  const [forgotBusy, setForgotBusy] = useState(false);
  const askForReset = async () => {
    if (forgotBusy) return;
    const address = email.trim();
    if (!emailOk(address)) {
      setFieldErrors({ email: t("errEmail") });
      return;
    }
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

  /*
   * Where to go after signing in.
   *
   * `?next=` exists because the only thing that sends people here — the
   * Protected guard on /pro — redirected with no way back, so someone who
   * clicked "sign in to the dashboard" signed in and landed on the homepage
   * wondering what happened.
   *
   * Only a same-site PATH is honoured. The value comes from the URL, so
   * following it blindly would make this an open redirect, which is a
   * phishing primitive on a site that takes card payments. Rejecting "//"
   * matters as much as requiring "/": "//evil.test" is protocol-relative
   * and would leave the site.
   */
  const [params] = useSearchParams();
  const requested = params.get("next") ?? "";
  const afterLogin = requested.startsWith("/") && !requested.startsWith("//") ? requested : "/";

  useEffect(() => {
    if (!loading && user) navigate(afterLogin, { replace: true });
  }, [loading, user, navigate, afterLogin]);

  function authErrorMessage(err) {
    if (err?.status === 401) return t("loginFail");
    if (err?.status === 422) return t("emailInUse");
    return t("authError");
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (busy) return;
    const cleanEmail = email.trim().toLowerCase();

    // All of them, not just the first: returning on the earliest failure
    // makes the user submit three times to discover three problems.
    const next = {};
    if (!emailOk(cleanEmail)) next.email = t("errEmail");
    if (password.length < 8) next.password = t("passwordHint");
    if (mode === "up" && name.trim().length < 2) next.name = t("errName");
    if (mode === "up" && !phoneOk(phone)) next.phone = t("errPhone");
    if (Object.keys(next).length) {
      setFieldErrors(next);
      setError(null);
      return;
    }

    setBusy(true);
    clearErrors();
    try {
      if (mode === "up") {
        await register(name.trim(), cleanEmail, password, phone.trim());
        toast.success(t("accountCreated"));
      } else {
        await login(cleanEmail, password);
        toast.success(t("welcomeBack"));
      }
      navigate(afterLogin, { replace: true });
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function quickLogin(account) {
    if (busy) return;
    setBusy(true);
    clearErrors();
    try {
      await login(account.email, account.password);
      toast.success(t("welcomeBack"));
      navigate(afterLogin, { replace: true });
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!loading && user) return null;

  return (
    <Shell>
      <div className="mx-auto w-full max-w-5xl px-4 py-10 md:px-8 md:py-14">
        <div className="grid overflow-hidden rounded-3xl border border-line/10 bg-card shadow-pop md:grid-cols-[1fr_1.1fr]">
          {/* Deliberately always dark, to split visually from the form panel
              beside it regardless of app theme. */}
          <aside className="hidden flex-col justify-between gap-8 bg-stage p-10 text-stage-fg md:flex">
            <Link to="/" className="font-display text-xl font-extrabold tracking-tight">
              Eventick<span className="text-accent">.ma</span>
            </Link>
            <div>
              <p className="font-display text-display font-extrabold">{mode === "in" ? t("loginTitle") : t("signupTitle")}</p>
              <p className="mt-3 max-w-sm text-sm leading-relaxed text-stage-muted">{mode === "in" ? t("loginSub") : t("signupSub")}</p>
            </div>
            <p className="flex items-center gap-2 text-xs font-semibold text-stage-muted">
              <ShieldCheck className="size-4 shrink-0 text-accent" />
              {t("loginTrust")}
            </p>
          </aside>
          <div className="p-6 sm:p-8 md:p-10">
            <Link to="/" className="inline-flex items-center gap-2 text-sm font-semibold text-muted hover:text-ink">
              <ArrowLeft className="size-4 rtl:rotate-180" />
              {t("back")}
            </Link>
            <div className="mt-4 md:hidden">
              <h1 className="font-display text-2xl font-extrabold">{mode === "in" ? t("loginTitle") : t("signupTitle")}</h1>
              <p className="mt-1 text-sm text-muted">{mode === "in" ? t("loginSub") : t("signupSub")}</p>
            </div>
            <div className="mt-6 grid grid-cols-2 gap-1 rounded-full bg-paper p-1 text-sm font-bold">
              {["in", "up"].map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={mode === value}
                  disabled={busy}
                  onClick={() => {
                    setMode(value);
                    clearErrors();
                  }}
                  className={cn("h-11 rounded-full transition disabled:opacity-50", mode === value ? "bg-card text-ink shadow-card" : "text-muted hover:text-ink")}
                >
                  {value === "in" ? t("signIn") : t("signUp")}
                </button>
              ))}
            </div>
            <form className="mt-6 grid gap-4" onSubmit={onSubmit}>
              {mode === "up" ? (
                <Field label={t("fullName")} error={fieldErrors.name}>
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      describedBy={describedBy}
                      invalid={invalid}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      autoComplete="name"
                      placeholder="Yasmine El Fassi"
                    />
                  )}
                </Field>
              ) : null}
              {/* Required at sign-up: the checkout then has it already, and
                  a buyer is not asked for the same number on every
                  purchase. */}
              {mode === "up" ? (
                <Field label={t("phone")} error={fieldErrors.phone} hint={t("signupPhoneHint")}>
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      describedBy={describedBy}
                      invalid={invalid}
                      type="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      autoComplete="tel"
                      placeholder="06 12 34 56 78"
                    />
                  )}
                </Field>
              ) : null}
              <Field label={t("email")} error={fieldErrors.email}>
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    describedBy={describedBy}
                    invalid={invalid}
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    placeholder={t("emailPh")}
                  />
                )}
              </Field>
              {/* The 8-character rule only applies when signing up — on
                  sign-in the password is whatever it already is, so showing
                  the hint there would read as a new requirement. */}
              <Field
                label={t("password")}
                error={fieldErrors.password}
                hint={mode === "up" ? t("passwordHint") : undefined}
              >
                {({ id, describedBy, invalid }) => (
                  <span className="relative block">
                    <Input
                      id={id}
                      describedBy={describedBy}
                      invalid={invalid}
                      className="pe-12"
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete={mode === "up" ? "new-password" : "current-password"}
                    />
                    <button
                      type="button"
                      aria-label={showPassword ? t("hidePwd") : t("showPwd")}
                      onClick={() => setShowPassword((value) => !value)}
                      className="absolute end-2 top-1/2 inline-flex size-9 -translate-y-1/2 items-center justify-center rounded-full text-muted hover:text-ink"
                    >
                      {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </span>
                )}
              </Field>
              {/* Signing IN only. On the sign-up tab there is no account
                  yet, so a reset link would be an answer to a question
                  nobody asked. */}
              {mode === "in" ? (
                <button
                  type="button"
                  onClick={askForReset}
                  disabled={forgotBusy}
                  className="-mt-1 text-start text-xs font-semibold text-muted underline underline-offset-2 hover:text-ink disabled:opacity-50"
                >
                  {forgotBusy ? t("forgotSending") : t("forgotPassword")}
                </button>
              ) : null}
              {error ? (
                <p role="alert" className="rounded-card bg-danger/10 px-4 py-3 text-sm font-semibold text-danger">
                  {error}
                </p>
              ) : null}
              {/* Was bg-primary (pink) — the actual submit action, so it
                  follows the same rule as every other CTA: the near-black/
                  near-white action pill, not the brand colour. */}
              <button type="submit" disabled={busy} className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-action text-sm font-semibold text-action-fg transition hover:bg-action-hover disabled:opacity-50">
                {busy ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {mode === "in" ? t("waitConn") : t("waitCreate")}
                  </>
                ) : mode === "in" ? (
                  t("signIn")
                ) : (
                  t("signUp")
                )}
              </button>
            </form>
            <p className="mt-4 text-center text-sm text-muted">
              {mode === "in" ? t("noAccount") : t("haveAccount")}{" "}
              <button
                type="button"
                onClick={() => {
                  setMode(mode === "in" ? "up" : "in");
                  clearErrors();
                }}
                className="font-bold text-primary underline-offset-4 hover:underline"
              >
                {mode === "in" ? t("signUp") : t("signIn")}
              </button>
            </p>
            {SHOW_DEMO_ACCOUNTS ? (
              <div className="mt-6">
                <p className="flex items-center gap-3 text-center text-xs font-semibold text-muted">
                  <span className="h-px flex-1 bg-line/15" />
                  {t("demoAccounts")}
                  <span className="h-px flex-1 bg-line/15" />
                </p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {DEMO_ACCOUNTS.map((account) => (
                    <button
                      key={account.id}
                      type="button"
                      disabled={busy}
                      onClick={() => quickLogin(account)}
                      className="rounded-control border border-line/15 px-3 py-2.5 text-start transition hover:border-primary/40 hover:bg-paper disabled:opacity-50"
                    >
                      <span className="block text-sm font-bold text-encre">{locale === "ar" ? account.labelAr : account.labelFr}</span>
                      <span className="block text-xs text-muted">{locale === "ar" ? account.roleAr : account.roleFr}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <p className="mt-6 flex items-center justify-center gap-2 text-center text-xs text-muted md:hidden">
              <ShieldCheck className="size-4 shrink-0 text-primary" />
              {t("loginTrust")}
            </p>
          </div>
        </div>
      </div>
    </Shell>
  );
}
