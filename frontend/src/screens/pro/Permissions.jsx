import { useEffect, useState } from "react";
import { AlertTriangle, Check, Lock, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import { useAuth } from "../../AuthContext";
import { useI18n } from "../../i18n";
import { cn } from "../../utils";
import { Badge, Notice } from "../../ui";
import { useConfirm } from "./ConfirmContext";
import { PageHead } from "./ui";
import { text } from "./copy";

const ROLES = ["CUSTOMER", "ORGANISER", "ADMIN"];

// scope.any is the one permission that crosses the ownership boundary: every
// other capability still only reaches the holder's own events, while this one
// lets its holder act on anybody's. It is called out in the UI for the same
// reason the backend keeps it as a separate permission instead of folding it
// into the admin role -- granting it is a decision, not a detail.
const DANGEROUS = "scope.any";

/**
 * The permissions matrix: which capabilities each role holds.
 *
 * This is the screen the enum could never have. Before the Permission /
 * RolePermission tables existed, "what can an ORGANISER do" was a list of
 * `requireRole("ORGANISER", "ADMIN")` calls spread across the route files,
 * so the only way to answer the question was to read the backend, and the
 * only way to change the answer was to deploy.
 *
 * Toggles write straight through to the server and re-render from its
 * response rather than from local state. A grant that the backend refused --
 * the locked ADMIN/users.manage pair -- then cannot appear to have worked.
 */
export default function Permissions() {
  const { locale } = useI18n();
  const t = text[locale];
  const { user: me, refresh } = useAuth();
  const confirm = useConfirm();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = () => api.get("/auth/permissions").then(setData);

  useEffect(() => {
    load();
  }, []);

  const roleLabel = (value) =>
    value === "ADMIN" ? t.roleAdmin : value === "ORGANISER" ? t.roleOrganiser : t.roleCustomer;

  const toggle = async (role, perm, held) => {
    if (perm.locked && role === "ADMIN") {
      toast.error(t.permLocked);
      return;
    }

    // Only confirm on revoke and on granting scope.any. Asking twice for
    // every grant would train the admin to click through the one prompt that
    // actually matters.
    if (held) {
      const ok = await confirm({
        title: t.confirmPermTitle,
        message: t.confirmPermRevoke.replace("{perm}", perm.key).replace("{role}", roleLabel(role)),
        tone: "warn",
        confirmLabel: t.apply,
        cancelLabel: t.close,
      });
      if (!ok) return;
    } else if (perm.key === DANGEROUS) {
      const ok = await confirm({
        title: t.confirmPermTitle,
        message: t.permScopeWarn,
        tone: "warn",
        confirmLabel: t.apply,
        cancelLabel: t.close,
      });
      if (!ok) return;
    }

    const id = `${role}:${perm.key}`;
    setBusy(id);
    try {
      if (held) await api.del(`/auth/roles/${role}/permissions/${perm.key}`);
      else await api.post(`/auth/roles/${role}/permissions`, { permission: perm.key });
      await load();
      // The admin may have just changed their OWN role's powers, and every
      // guard in the SPA reads the permission list from /auth/me. Without
      // this the nav and the route guards keep the pre-change list until a
      // reload -- including, if they revoked something from themselves, a
      // link to a screen that now redirects.
      if (role === me?.role) await refresh();
      toast.success(held ? t.permRevoked : t.permGranted);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <PageHead title={t.permissions} sub={t.permissionsSub} />

      <Notice tone="info" icon={<ShieldAlert className="size-4" />} className="mb-5">
        {t.permLocked}
      </Notice>

      <div className="grid gap-3">
        {(data?.permissions ?? []).map((perm) => (
          <article
            key={perm.key}
            className="min-w-0 rounded-card border border-line/10 bg-card p-4 shadow-card sm:flex sm:items-center sm:gap-4"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                {/* break-all: "gate.checkin" is one token to a browser,
                    and on a narrow card it would otherwise set the floor. */}
                <code className="break-all font-mono text-sm font-extrabold text-ink">{perm.key}</code>
                {perm.key === DANGEROUS ? (
                  <Badge tone="warn" icon={<AlertTriangle className="size-3" />}>
                    {t.permScopeWarn}
                  </Badge>
                ) : null}
              </div>
              <p className="mt-1 text-sm text-muted">{perm.description}</p>
            </div>

            {/* No shrink-0 here: it contradicted the flex-wrap beside it.
                shrink-0 holds this group at its max-content width -- all
                three pills on one line, ~288px -- so it never wrapped, and
                the card could not be narrower than ~437px however small the
                screen got. Without it the group narrows and the pills wrap,
                which is what flex-wrap was there for. */}
            <div
              role="group"
              aria-label={`${perm.key} — ${t.roleField}`}
              className="mt-3 flex flex-wrap gap-2 sm:mt-0"
            >
              {ROLES.map((role) => {
                const held = (data?.roles?.[role] ?? []).includes(perm.key);
                const locked = perm.locked && role === "ADMIN";
                const id = `${role}:${perm.key}`;
                return (
                  <button
                    key={role}
                    type="button"
                    // aria-pressed, not a checkbox: this is a toggle whose
                    // label stays put while its state changes, which is what
                    // a screen reader announces correctly here.
                    aria-pressed={held}
                    disabled={locked || busy === id}
                    onClick={() => toggle(role, perm, held)}
                    title={locked ? t.permLocked : undefined}
                    className={cn(
                      "inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold transition",
                      "disabled:cursor-not-allowed disabled:opacity-60",
                      held
                        ? "border-primary bg-primary text-primary-fg hover:bg-primary-hover"
                        : "border-line/20 bg-card text-muted hover:border-primary/40 hover:text-ink",
                      busy === id && "opacity-50",
                    )}
                  >
                    {locked ? (
                      <Lock className="size-3.5 shrink-0" aria-hidden />
                    ) : held ? (
                      <Check className="size-3.5 shrink-0" strokeWidth={3} aria-hidden />
                    ) : null}
                    {roleLabel(role)}
                    {role === me?.role ? <span className="sr-only"> ({t.yourRole})</span> : null}
                  </button>
                );
              })}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
