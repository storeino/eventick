import { useEffect, useMemo, useState } from "react";
import { Check, RefreshCw, ShieldCheck, Trash2, UserPlus, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import { useAuth } from "../../AuthContext";
import { useI18n } from "../../i18n";
import { longDate } from "../../utils";
import { useConfirm } from "./ConfirmContext";
import { Badge, Btn, EmptyState, FilterBar, IconBtn, InfoTip, PageHead, Pager, PersonCell } from "./ui";
import { Dropdown, Field, Input, Modal, triggerControlClass } from "../../ui";
import { text } from "./copy";

const PAGE_SIZE_DEFAULT = 20;

/**
 * The roles this screen may ASSIGN — deliberately not every role that
 * exists. ADMIN is absent and the server enforces it (see
 * ADMIN_CREATABLE_ROLES in backend/src/domain/auth.ts): an admin account can
 * only come from the seed, so a single compromised admin cannot mint or
 * appoint more of itself. Offering the option here anyway would just produce
 * a 400 from the schema with no useful explanation. Existing admins still
 * show up in the list and the filter, and demoting one works — only
 * reaching ADMIN is closed.
 */
const ASSIGNABLE_ROLES = ["CUSTOMER", "ORGANISER"];

/**
 * A readable throwaway password for the account the admin is creating.
 *
 * The admin has to read this out or paste it into a message, so it avoids
 * the characters that get misread when retyped (O/0, l/1, I). It is a
 * first password, not a secret to keep: the backend hashes it with the
 * same bcrypt cost as a self-registered one, and the holder can change it.
 */
function suggestPassword() {
  const alphabet = "abcdefghijkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint32Array(14);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (n) => alphabet[n % alphabet.length]).join("");
}

/**
 * Administration — the users directory, ADMIN-only (both at the route via
 * Protected and here as a defence-in-depth 403 if that guard were ever
 * dropped).
 *
 * This is the actual fix for "every role sees the same pages": ADMIN and
 * ORGANISER were functionally identical everywhere except the one backend
 * endpoint (PATCH /auth/users/:id/role) this screen finally gives a UI to.
 * Role changes go through the same confirm-dialog pattern as every other
 * destructive-ish action in /pro (Orders' cancel/refund), and the caller's
 * own row is disabled rather than left to fail server-side — the backend
 * guard against self-demotion still exists, this just means nobody hits it
 * by accident.
 */
export default function Users() {
  const { locale, tf } = useI18n();
  const t = text[locale];
  const { user: me } = useAuth();
  const confirm = useConfirm();
  const [users, setUsers] = useState(null);
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(PAGE_SIZE_DEFAULT);
  const [busyId, setBusyId] = useState(null);

  // Pending organiser applications. Lives on this screen because deciding
  // one promotes a user, which is what the directory below is for —
  // splitting it onto its own route would separate the decision from the
  // list it changes.
  const [applications, setApplications] = useState([]);
  const [declining, setDeclining] = useState(null);
  const [declineNote, setDeclineNote] = useState("");

  // Create-user form. Kept in this screen rather than on its own route: it
  // is one POST, and landing back on the directory with the new row visible
  // is the confirmation that it worked.
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState({});

  const openCreate = () => {
    setForm({ name: "", email: "", password: suggestPassword(), role: "ORGANISER" });
    setErrors({});
    setOpen(true);
  };
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const load = () =>
    Promise.all([
      api.get("/auth/users").then((data) => setUsers(data.users)),
      api
        .get("/organiser-applications?status=PENDING")
        .then((data) => setApplications(data.applications))
        .catch(() => setApplications([])),
    ]);

  const decide = async (application, approve, note) => {
    setBusyId(application.id);
    try {
      await api.post(`/organiser-applications/${application.id}/decide`, { approve, note });
      await load();
      toast.success(approve ? t.appsApproved : t.appsDeclined);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyId(null);
      setDeclining(null);
      setDeclineNote("");
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    setPage(1);
  }, [query, role, limit]);

  const roleLabel = (value) => (value === "ADMIN" ? t.roleAdmin : value === "ORGANISER" ? t.roleOrganiser : t.roleCustomer);
  const roleTone = (value) => (value === "ADMIN" ? "info" : value === "ORGANISER" ? "success" : "neutral");

  const allRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (users ?? []).filter((u) => {
      if (role && u.role !== role) return false;
      if (!needle) return true;
      return `${u.name} ${u.email}`.toLowerCase().includes(needle);
    });
  }, [users, query, role]);

  const pages = Math.max(1, Math.ceil(allRows.length / limit));
  const rows = allRows.slice((page - 1) * limit, page * limit);
  const activeCount = [query, role].filter(Boolean).length;

  /**
   * Remove an account.
   *
   * Two outcomes, and the server decides which: delete when nothing depends
   * on the account, anonymise when money history does. The plan is fetched
   * FIRST so the confirmation can say which one applies and why — finding out
   * afterwards that a "delete" only anonymised would be a bad surprise.
   */
  const remove = async (target) => {
    let plan;
    try {
      plan = await api.get(`/auth/users/${target.id}/removal`);
    } catch (err) {
      toast.error(err.message);
      return;
    }

    const ok = await confirm({
      title: t.removeTitle.replace("{name}", target.name),
      message: plan.mode === "deleted" ? t.removeDeleted : t.removeAnonymised,
      tone: "danger",
      confirmLabel: t.removeAccount,
      cancelLabel: t.close,
    });
    if (!ok) return;

    setBusyId(target.id);
    try {
      const result = await api.del(`/auth/users/${target.id}`);
      toast.success(result.mode === "deleted" ? t.removeDone : t.removeAnonDone);
      await load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const changeRole = async (target, nextRole) => {
    const ok = await confirm({
      title: t.confirmRoleChangeTitle,
      message: `${roleLabel(nextRole)} ${t.confirmRoleChange.replace("{name}", target.name)}`,
      tone: "warn",
      confirmLabel: t.changeRole,
      cancelLabel: t.close,
    });
    if (!ok) return;

    setBusyId(target.id);
    try {
      await api.patch(`/auth/users/${target.id}/role`, { role: nextRole });
      await load();
      toast.success(t.roleChanged);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyId(null);
    }
  };

  // Validated here as well as server-side so the message lands on the field
  // rather than arriving as a toast that does not say which input is wrong.
  const submit = async (e) => {
    e.preventDefault();
    const next = {};
    if (!form.name.trim()) next.name = t.required;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) next.email = t.invalidEmail;
    if (form.password.length < 8) next.password = t.passwordHint;
    setErrors(next);
    if (Object.keys(next).length) return;

    setSaving(true);
    try {
      await api.post("/auth/users", { ...form, name: form.name.trim(), email: form.email.trim() });
      await load();
      setOpen(false);
      toast.success(t.userCreated);
    } catch (err) {
      // 422 is the duplicate-email case, which belongs on the email field.
      if (err.status === 422) setErrors({ email: err.message });
      else toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const roleHint = (value) =>
    value === "ADMIN" ? t.roleHintAdmin : value === "ORGANISER" ? t.roleHintOrganiser : t.roleHintCustomer;

  return (
    <div>
      <PageHead
        title={t.team}
        sub={t.teamSub}
        actions={
          <Btn icon={<UserPlus className="size-4" />} onClick={openCreate}>
            {t.newUser}
          </Btn>
        }
      />

      {/* Only rendered when there is something to decide: an empty queue
          is the normal state, and a permanently-visible empty panel would
          push the directory down for nothing. */}
      {applications.length > 0 ? (
        <section className="mb-6">
          <div className="mb-3">
            <h2 className="font-display text-lg font-bold">
              {t.appsTitle}
              <Badge tone="warn" className="ms-2 align-middle">
                {applications.length}
              </Badge>
            </h2>
            <p className="mt-0.5 text-sm text-muted">{t.appsSub}</p>
          </div>

          <div className="grid gap-3">
            {applications.map((application) => (
              <article
                key={application.id}
                className="rounded-card border border-line/10 bg-card p-4 shadow-card"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-display text-base font-bold">{application.displayName}</p>
                    <p className="break-words text-sm text-muted">
                      {application.applicant.name} · {application.applicant.email}
                    </p>
                  </div>
                  <Badge tone="warn">{t.appsPending}</Badge>
                </div>

                <dl className="mt-3 grid gap-2 sm:grid-cols-[10rem_1fr]">
                  <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{t.appsPhone}</dt>
                  <dd className="text-sm">{application.phone}</dd>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{t.appsPitch}</dt>
                  <dd className="text-sm leading-relaxed">{application.pitch}</dd>
                </dl>

                <div className="mt-4 flex flex-wrap gap-2">
                  <Btn
                    size="sm"
                    icon={<Check className="size-4" />}
                    disabled={busyId === application.id}
                    onClick={() => decide(application, true)}
                  >
                    {t.appsApprove}
                  </Btn>
                  <Btn
                    variant="secondary"
                    size="sm"
                    icon={<X className="size-4" />}
                    disabled={busyId === application.id}
                    onClick={() => setDeclining(application)}
                  >
                    {t.appsDecline}
                  </Btn>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <FilterBar
        search={{ value: query, onChange: setQuery, placeholder: t.search }}
        controls={[
          {
            key: "role",
            label: t.allRoles,
            value: role,
            onChange: (e) => setRole(e.target.value),
            style: { width: 170 },
            options: [
              { value: "", label: t.allRoles },
              { value: "CUSTOMER", label: t.roleCustomer },
              { value: "ORGANISER", label: t.roleOrganiser },
              { value: "ADMIN", label: t.roleAdmin },
            ],
          },
        ]}
        activeCount={activeCount}
        resetLabel={t.reset}
        onReset={() => {
          setQuery("");
          setRole("");
        }}
      />

      {users && rows.length === 0 ? (
        <EmptyState icon={<ShieldCheck className="size-6" />} title={activeCount ? t.noUsersFilter : t.noUsersYet} />
      ) : (
        <div className="grid gap-3">
          {rows.map((u) => {
            const isSelf = u.id === me?.id;
            return (
              <article key={u.id} className="flex flex-wrap items-center gap-4 rounded-card border border-line/10 bg-card p-4 shadow-card">
                <div className="min-w-0 flex-1">
                  <PersonCell name={u.name} sub={u.email} />
                </div>

                <div className="flex shrink-0 items-center gap-4 text-xs text-muted">
                  <span>
                    {t.eventsCount} <span className="font-bold tabular-nums text-ink">{u.eventCount}</span>
                  </span>
                  <span>
                    {t.ordersCount} <span className="font-bold tabular-nums text-ink">{u.orderCount}</span>
                  </span>
                  <span>
                    {t.joined} {longDate(u.createdAt, locale)}
                  </span>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone={roleTone(u.role)}>{roleLabel(u.role)}</Badge>
                  <span className="inline-block w-36" title={isSelf ? t.cannotChangeOwnRole : t.changeRole}>
                    <Dropdown
                      value={u.role}
                      disabled={isSelf || busyId === u.id}
                      onChange={(value) => changeRole(u, value)}
                      // Named per row: in a list, a bare "change role" on
                      // every trigger gives a screen reader no way to tell
                      // which person is about to be changed.
                      label={`${t.changeRole} — ${u.name ?? u.email}`}
                      options={[
                        // An existing ADMIN still needs its own option
                        // present, or the trigger would render blank against
                        // a value it cannot show. Disabled, so the row reads
                        // correctly and can be demoted, while nobody can be
                        // promoted INTO admin from here.
                        ...(u.role === "ADMIN" ? [{ value: "ADMIN", label: roleLabel("ADMIN"), disabled: true }] : []),
                        ...ASSIGNABLE_ROLES.map((value) => ({ value, label: roleLabel(value) })),
                      ]}
                      triggerClassName={triggerControlClass({
                        disabled: isSelf || busyId === u.id,
                        className: "h-10 px-2.5 text-sm",
                      })}
                    />
                  </span>
                  {isSelf ? <InfoTip text={t.cannotChangeOwnRole} /> : null}

                  {/* Hidden for yourself and for another admin, matching the
                      server's own guards — a button that always 403s is worse
                      than no button. */}
                  {isSelf || u.role === "ADMIN" ? (
                    <InfoTip text={isSelf ? t.removeCannotSelf : t.removeCannotAdmin} />
                  ) : (
                    <IconBtn
                      label={t.removeAccount}
                      title={t.removeAccount}
                      tone="danger"
                      disabled={busyId === u.id}
                      onClick={() => remove(u)}
                    >
                      <Trash2 className="size-4" />
                    </IconBtn>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <Pager page={page} pages={pages} onPage={setPage} limit={limit} onLimit={setLimit} labels={{ rows: t.rows, prev: t.prev, next: t.next }} />

      {/* Declining is the one that needs words: the applicant sees this
          note on their own page, so refusing with no reason would leave
          them with nothing to act on. */}
      <Modal
        open={declining !== null}
        onClose={() => setDeclining(null)}
        title={t.appsDeclineTitle}
        size="sm"
        footer={
          <>
            <Btn variant="secondary" onClick={() => setDeclining(null)}>
              {t.close}
            </Btn>
            <Btn
              variant="danger"
              loading={busyId === declining?.id}
              onClick={() => decide(declining, false, declineNote.trim() || undefined)}
            >
              {t.appsDecline}
            </Btn>
          </>
        }
      >
        <Field label={t.appsDeclineNote}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              describedBy={describedBy}
              invalid={invalid}
              value={declineNote}
              onChange={(e) => setDeclineNote(e.target.value)}
              maxLength={500}
            />
          )}
        </Field>
      </Modal>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t.newUser}
        sub={t.newUserSub}
        icon={<UserPlus className="size-5" />}
        footer={
          <>
            <Btn variant="secondary" onClick={() => setOpen(false)}>
              {t.close}
            </Btn>
            <Btn type="submit" form="user-form" loading={saving}>
              {t.createUser}
            </Btn>
          </>
        }
      >
        {form ? (
          <form id="user-form" className="grid gap-4" onSubmit={submit}>
            <Field label={t.fullName} required error={errors.name}>
              {({ id, describedBy, invalid, required }) => (
                <Input
                  id={id}
                  describedBy={describedBy}
                  invalid={invalid}
                  required={required}
                  value={form.name}
                  onChange={set("name")}
                  autoComplete="off"
                />
              )}
            </Field>

            <Field label={t.email} required error={errors.email}>
              {({ id, describedBy, invalid, required }) => (
                <Input
                  id={id}
                  describedBy={describedBy}
                  invalid={invalid}
                  required={required}
                  type="email"
                  value={form.email}
                  onChange={set("email")}
                  autoComplete="off"
                />
              )}
            </Field>

            <Field label={t.password} required error={errors.password} hint={t.passwordHint}>
              {({ id, describedBy, invalid, required }) => (
                <div className="flex items-center gap-2">
                  {/* Shown in clear text on purpose: the admin has to pass it
                      on, and a masked field they cannot read is only a hazard
                      here -- there is no secret of their own to shoulder-surf. */}
                  <Input
                    id={id}
                    describedBy={describedBy}
                    invalid={invalid}
                    required={required}
                    className="font-mono"
                    value={form.password}
                    onChange={set("password")}
                    autoComplete="off"
                  />
                  <Btn
                    variant="secondary"
                    icon={<RefreshCw className="size-4" />}
                    onClick={() => setForm((f) => ({ ...f, password: suggestPassword() }))}
                  >
                    {t.generate}
                  </Btn>
                </div>
              )}
            </Field>

            <Field label={t.roleField} required hint={roleHint(form.role)}>
              {({ id, describedBy, required }) => (
                <Dropdown
                  label={t.roleField}
                  id={id}
                  describedBy={describedBy}
                  value={form.role}
                  onChange={(value) => setForm((f) => ({ ...f, role: value }))}
                  options={ASSIGNABLE_ROLES.map((value) => ({ value, label: roleLabel(value) }))}
                  triggerClassName={triggerControlClass({})}
                />
              )}
            </Field>
          </form>
        ) : null}
      </Modal>
    </div>
  );
}
