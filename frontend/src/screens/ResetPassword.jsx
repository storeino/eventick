import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Loader2, Lock } from "lucide-react";
import { toast } from "sonner";
import { Shell } from "../components/Shell";
import { api } from "../api";
import { useAuth } from "../AuthContext";
import { useI18n } from "../i18n";
import { Button, Card, Container, Field, Input, LoadingState, Notice } from "../ui";
import { MIN_PASSWORD } from "../payment";

/**
 * Choosing a new password from an emailed link.
 *
 * Opened in its own tab from the checkout, so the seat hold on the original
 * tab keeps running while this happens: the buyer resets here, returns to
 * the tab they left, and pays. That is the whole reason this does not
 * navigate the checkout away.
 */
export default function ResetPassword() {
  const { token } = useParams();
  const { t } = useI18n();
  const { adoptSession } = useAuth();
  const navigate = useNavigate();

  /* The link is checked on load, so someone holding a stale one is told
     before typing a password into a form that cannot submit. */
  const [checking, setChecking] = useState(true);
  const [target, setTarget] = useState(null);
  const [dead, setDead] = useState(false);

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get(`/auth/reset-password/${encodeURIComponent(token)}`)
      .then((data) => {
        if (!cancelled) setTarget(data);
      })
      .catch(() => {
        if (!cancelled) setDead(true);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const next = {};
    if (password.length < MIN_PASSWORD) next.password = t("errPasswordShort");
    /* Confirmed, because there is no "wrong password" feedback loop to catch
       a typo here: whatever is typed becomes the credential, and the next
       sign-in would simply fail with nothing to explain why. */
    else if (password !== confirm) next.confirm = t("errPasswordMatch");
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    try {
      const data = await api.post(`/auth/reset-password/${encodeURIComponent(token)}`, { password });
      /* Signed in on success rather than sent to the login page to type the
         password chosen ten seconds ago. */
      adoptSession(data.token, data.user);
      toast.success(t("resetDone"));
      navigate("/billets", { replace: true });
    } catch (err) {
      if (err.data?.resetLinkInvalid) {
        setDead(true);
        return;
      }
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (checking) {
    return (
      <Shell>
        <Container className="py-16">
          <LoadingState />
        </Container>
      </Shell>
    );
  }

  if (dead || !target) {
    return (
      <Shell>
        <Container className="max-w-md py-16">
          <Card>
            <h1 className="font-display text-heading font-extrabold">{t("resetTitle")}</h1>
            <Notice tone="danger" className="mt-4">
              {t("resetExpired")}
            </Notice>
            <Button className="mt-4" full onClick={() => navigate("/login")}>
              {t("resetAskAgain")}
            </Button>
          </Card>
        </Container>
      </Shell>
    );
  }

  return (
    <Shell>
      <Container className="max-w-md py-16">
        <Card>
          <h1 className="font-display text-heading font-extrabold">{t("resetTitle")}</h1>
          {/* Whose account this is. The link was emailed to one address, and
              showing it confirms they are resetting the account they meant
              -- someone with two addresses would otherwise be guessing. */}
          <p className="mt-1 text-sm text-muted">{target.email}</p>

          <form className="mt-5 grid gap-4" onSubmit={submit} noValidate>
            <Field label={t("choosePassword")} error={errors.password} hint={t("choosePasswordHint")} required>
              {(props) => (
                <Input
                  {...props}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  minLength={MIN_PASSWORD}
                />
              )}
            </Field>
            <Field label={t("confirmPassword")} error={errors.confirm} required>
              {(props) => (
                <Input
                  {...props}
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                />
              )}
            </Field>
            <Button type="submit" full size="lg" loading={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : t("resetSubmit")}
            </Button>
          </form>

          <p className="mt-4 flex items-center justify-center gap-2 text-center text-xs text-muted">
            <Lock className="size-3.5 shrink-0" aria-hidden />
            {t("resetOnce")}
          </p>
        </Card>
      </Container>
    </Shell>
  );
}
