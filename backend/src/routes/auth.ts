import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { signToken } from "../lib/jwt.js";
import { asyncHandler, HttpError, param } from "../lib/http.js";
import { authRateLimit } from "../middleware/rateLimit.js";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { ADMIN_CREATABLE_ROLES, isRole, PUBLIC_SIGNUP_ROLE, ROLES, type Role } from "../domain/auth.js";
import { isLockedGrant, isPermission, PERMISSION_KEYS, PERMISSIONS } from "../domain/permissions.js";
import { invalidatePermissionCache, permissionListForRole } from "../lib/permissions.js";
import { AUDIT_ACTIONS, recordAudit } from "../lib/audit.js";
import { planRemoval, removeUser } from "../lib/user-admin.js";
import { normaliseRib, ribOk } from "../domain/commission.js";
import { creditStatement } from "../lib/credit.js";
import { phoneOk } from "../lib/payment-sim.js";
import {
  completeReset,
  requestReset,
  resolveReset,
  RESET_TTL_MINUTES,
} from "../lib/password-reset.js";
import { MIN_PASSWORD_LENGTH } from "../lib/express-account.js";
import { sendEmail } from "../lib/email.js";
import { passwordResetHtml, passwordResetSubject } from "../lib/email-templates.js";

export const authRouter = Router();

const registerSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  /*
   * Required at sign-up, so it is asked once instead of at every checkout.
   *
   * It used to live only on the order, which meant a buyer with six orders
   * typed the same number six times while the account that owns all of them
   * knew nothing about it. Format is checked below rather than by zod: the
   * Moroccan rules (06/07 ten digits, or +212 with twelve) already live in
   * phoneOk, and a second expression of them here would be the one that
   * drifts.
   */
  phone: z.string(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/**
 * Everyone's own identity, as the SPA's AuthContext consumes it.
 *
 * `permissions` is a required argument rather than something resolved in
 * here, because this is called from four places and two of them (register,
 * login) never pass through `authenticate` and so have no resolved list in
 * hand. Making it explicit forces each call site to fetch it rather than
 * silently shipping a user object with the field missing — which the
 * frontend would read as "no permissions" and quietly hide every control.
 */
function publicUser(
  user: { id: string; name: string; email: string; phone?: string | null; role: string },
  permissions: string[],
) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    /*
     * Sent so the checkout knows whether it still has to ask.
     *
     * Null for accounts created before the column existed; those are asked
     * once more at their next purchase and it is saved from there. Without
     * this the client cannot tell "no number on file" from "not loaded",
     * and would show the field to everyone forever.
     */
    phone: user.phone ?? null,
    role: user.role,
    permissions,
  };
}

/** The caller's permission list, or [] for a role that somehow isn't valid. */
async function permissionsOf(user: { role: string }): Promise<string[]> {
  return isRole(user.role) ? permissionListForRole(user.role) : [];
}

// A separate shape from publicUser, not an extension of it: /auth/me is
// everyone's own identity and should stay a frozen, minimal contract, while
// the admin-only user list can carry counts (and later, more) an ordinary
// user has no business seeing about themselves or anyone else.
function adminUser(user: {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: Date;
  _count: { events: number; orders: number };
}) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
    eventCount: user._count.events,
    orderCount: user._count.orders,
  };
}

authRouter.post(
  "/register",
  authRateLimit,
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);
    // Checked with the same helper the checkout uses, so the two cannot
    // disagree about what a Moroccan number looks like.
    if (!phoneOk(body.phone)) throw new HttpError(400, "Invalid phone number");
    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) throw new HttpError(422, "An account with this email already exists");

    const passwordHash = await bcrypt.hash(body.password, 10);
    const user = await prisma.user.create({
      data: {
        name: body.name,
        email: body.email,
        phone: body.phone.trim(),
        passwordHash,
        role: PUBLIC_SIGNUP_ROLE,
      },
    });
    const token = signToken({ sub: user.id, role: user.role });
    res.status(201).json({ token, user: publicUser(user, await permissionsOf(user)) });
  }),
);

authRouter.post(
  "/login",
  authRateLimit,
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user) throw new HttpError(401, "Invalid email or password");

    const ok = await bcrypt.compare(body.password, user.passwordHash);
    if (!ok) throw new HttpError(401, "Invalid email or password");

    const token = signToken({ sub: user.id, role: user.role });
    res.json({ token, user: publicUser(user, await permissionsOf(user)) });
  }),
);

const forgotSchema = z.object({
  email: z.string().email(),
  locale: z.enum(["fr", "ar"]).optional(),
});

authRouter.post(
  "/forgot-password",
  /*
   * Rate limited like the other credential routes. Without it this is a
   * free mail cannon: one request per address per second, sent from us, to
   * anyone an attacker names.
   */
  authRateLimit,
  asyncHandler(async (req, res) => {
    const body = forgotSchema.parse(req.body);
    const issued = await requestReset(body.email);

    /*
     * The SAME answer whether or not that address has an account.
     *
     * Saying "no account with that email" here would turn this route into a
     * membership oracle: anyone could test a list of addresses against the
     * customer base and learn who buys tickets, which is not ours to
     * disclose. The buyer who did mistype their address finds out from the
     * email that never arrives, which costs them a minute and costs everyone
     * else their privacy back.
     *
     * requestReset also returns null for an account with no password set.
     * That buyer is not locked out -- the checkout lets them choose one in
     * place -- so a reset email would be a slower road to the same door.
     */
    if (issued) {
      const user = await prisma.user.findUnique({
        where: { email: body.email.trim().toLowerCase() },
        select: { name: true, email: true },
      });
      if (user) {
        const locale = body.locale ?? "fr";
        await sendEmail({
          to: user.email,
          subject: passwordResetSubject({ locale, name: user.name, token: issued.token, ttlMinutes: RESET_TTL_MINUTES }),
          html: passwordResetHtml({ locale, name: user.name, token: issued.token, ttlMinutes: RESET_TTL_MINUTES }),
        });
      }
    }

    res.json({ sent: true, ttlMinutes: RESET_TTL_MINUTES });
  }),
);

/**
 * Is this link still good?
 *
 * The reset page asks on load, so someone holding an expired link is told
 * so before typing a new password into a form that cannot submit.
 */
authRouter.get(
  "/reset-password/:token",
  authRateLimit,
  asyncHandler(async (req, res) => {
    const { target } = await resolveReset(param(req, "token"));
    // The address only, so the page can say whose account this is. No id,
    // no role, nothing the holder of a leaked link could act on elsewhere.
    res.json({ email: target.email, name: target.name, minPasswordLength: MIN_PASSWORD_LENGTH });
  }),
);

const resetSchema = z.object({
  password: z.string().min(MIN_PASSWORD_LENGTH),
});

authRouter.post(
  "/reset-password/:token",
  authRateLimit,
  asyncHandler(async (req, res) => {
    const body = resetSchema.parse(req.body);
    const target = await completeReset(param(req, "token"), body.password);

    /*
     * Signed in on success, rather than sent to the login page to type the
     * password they chose ten seconds ago. They proved the address by
     * opening the link and have just set the credential; asking for it
     * again proves nothing and is one more place to lose them.
     */
    const user = await prisma.user.findUniqueOrThrow({ where: { id: target.userId } });
    const token = signToken({ sub: user.id, role: user.role });
    res.json({ token, user: publicUser(user, await permissionsOf(user)) });
  }),
);

authRouter.get(
  "/me",
  authenticate,
  asyncHandler(async (req, res) => {
    res.json({ user: publicUser(req.user!, await permissionsOf(req.user!)) });
  }),
);

/*
 * What a person may change about themselves.
 *
 * Name AND phone: the profile editor offered only the name, so a buyer who
 * changed their number had nowhere to say so and the stale one went to CMI
 * with every purchase.
 *
 * Email is deliberately NOT here. It is the login identifier and the
 * address every ticket and refund notice is sent to, so changing it is an
 * account-recovery flow with a confirmation step, not a text field — and a
 * silent change would let someone who borrowed a session lock the owner out
 * of their own account.
 *
 * Both optional, so a client can send either alone without having to echo
 * back the value it is not changing.
 */
const updateMeSchema = z
  .object({
    name: z.string().min(2).optional(),
    phone: z.string().optional(),
  })
  /*
   * strict(), so an unknown key is a 400 rather than silently dropped.
   *
   * Sending { email } used to return 200 with nothing changed, which reads
   * as success — a client could believe the address had been updated and
   * tell the user so. Refusing says plainly that this is not the route for
   * it. (Changing an email is an account-recovery flow with a confirmation
   * step; see the note above.)
   */
  .strict();

authRouter.patch(
  "/me",
  authenticate,
  asyncHandler(async (req, res) => {
    const body = updateMeSchema.parse(req.body);
    // Checked with the same helper sign-up and checkout use, so the three
    // cannot disagree about what a Moroccan number looks like.
    if (body.phone !== undefined && !phoneOk(body.phone)) {
      throw new HttpError(400, "Invalid phone number");
    }
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      // Only what was sent: a PATCH that wrote undefined over an unsent
      // field would blank the number every time somebody renamed themselves.
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.phone !== undefined ? { phone: body.phone.trim() } : {}),
      },
    });
    res.json({ user: publicUser(user, await permissionsOf(user)) });
  }),
);

/*
 * Where to send this person's money.
 *
 * Any signed-in user, not only an organiser. A resale seller is a CUSTOMER:
 * the platform holds their money rather than CMI holding a card charge it
 * can reverse, so paying them out is a bank transfer and needs an account.
 * Without this the admin's refund queue listed a name and an amount and no
 * way to pay it.
 *
 * The organiser form at PUT /organiser/bank-account still exists and writes
 * the same row; it is the same account either way, so a user who is later
 * made an organiser keeps the details they already gave.
 */
const bankSchema = z.object({
  holderName: z.string().min(3),
  /** Validated by ribOk below, so the error names the real problem. */
  rib: z.string(),
  bank: z.string().optional(),
});

authRouter.get(
  "/me/bank",
  authenticate,
  asyncHandler(async (req, res) => {
    const account = await prisma.bankAccount.findUnique({
      where: { userId: req.user!.id },
      select: { holderName: true, rib: true, bank: true, updatedAt: true },
    });
    res.json({
      bank: account
        ? {
            holderName: account.holderName,
            // Last four only. The full RIB is a payment credential; echoing
            // it into every page load buys nothing, since whoever set it
            // typed it themselves.
            ribLast4: account.rib.slice(-4),
            bank: account.bank,
            updatedAt: account.updatedAt.toISOString(),
          }
        : null,
    });
  }),
);

authRouter.put(
  "/me/bank",
  authenticate,
  asyncHandler(async (req, res) => {
    const body = bankSchema.parse(req.body);
    const rib = normaliseRib(body.rib);
    if (!ribOk(rib)) throw new HttpError(400, "A Moroccan RIB is exactly 24 digits");

    const saved = await prisma.bankAccount.upsert({
      where: { userId: req.user!.id },
      create: {
        userId: req.user!.id,
        holderName: body.holderName.trim(),
        rib,
        bank: body.bank?.trim() || null,
      },
      update: { holderName: body.holderName.trim(), rib, bank: body.bank?.trim() || null },
      select: { holderName: true, rib: true, bank: true, updatedAt: true },
    });

    // Changing where money goes is the move an attacker makes after taking
    // an account, so it is recorded -- last four digits only, never the RIB.
    recordAudit(req, {
      action: AUDIT_ACTIONS.BANK_ACCOUNT_CHANGED,
      subjectType: "user",
      subjectId: req.user!.id,
      subjectLabel: req.user!.email,
      details: { holderName: saved.holderName, ribLast4: saved.rib.slice(-4), bank: saved.bank },
    });

    res.json({
      bank: {
        holderName: saved.holderName,
        ribLast4: saved.rib.slice(-4),
        bank: saved.bank,
        updatedAt: saved.updatedAt.toISOString(),
      },
    });
  }),
);

const listUsersSchema = z.object({
  q: z.string().trim().optional(),
  role: z.enum(ROLES).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/**
 * Admin-only directory, backing the /pro/users screen. Full list, no
 * server-side pagination — every other pro screen pages client-side against
 * a fully-fetched list (see ui.jsx's Pager), so a second pagination
 * convention here would be the odd one out. The `limit` cap just guards
 * against this becoming the one unbounded response in the app; raise it (or
 * add real pagination) if the user table ever outgrows it.
 */
authRouter.get(
  "/users",
  authenticate,
  requirePermission("users.manage"),
  asyncHandler(async (req, res) => {
    const query = listUsersSchema.parse(req.query);
    const needle = query.q?.trim();
    const users = await prisma.user.findMany({
      where: {
        ...(query.role ? { role: query.role } : null),
        ...(needle
          ? { OR: [{ name: { contains: needle, mode: "insensitive" } }, { email: { contains: needle, mode: "insensitive" } }] }
          : null),
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        _count: { select: { events: true, orders: true } },
      },
      orderBy: { createdAt: "desc" },
      take: query.limit ?? 500,
    });
    res.json({ users: users.map(adminUser) });
  }),
);

const promoteSchema = z.object({ role: z.enum(ADMIN_CREATABLE_ROLES) });

/**
 * The only way a user ever becomes an ORGANISER: an existing admin promotes
 * them. Public registration always creates CUSTOMER (see PUBLIC_SIGNUP_ROLE
 * above) so self-service signup can't grant organiser access to /pro.
 *
 * ADMIN is not a reachable target here, same restriction and same reasoning
 * as POST /users above — minting a new admin, by promotion or by creation,
 * stays exclusive to the seed/CLI, so a single compromised admin account
 * cannot cascade into creating or appointing more of itself. A role that is
 * already ADMIN is unaffected: this only constrains the role being SET, so
 * demoting an admin down to ORGANISER or CUSTOMER still works exactly as
 * before — only promotion TO admin is closed off.
 */
authRouter.patch(
  "/users/:id/role",
  authenticate,
  requirePermission("users.manage"),
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    const body = promoteSchema.parse(req.body);

    // An admin cannot change their own role, in either direction. This is
    // the one guard that matters: as long as an admin can never demote
    // themselves, the platform can never end up with zero admins (you must
    // already be ADMIN to reach this route at all), so there is no need to
    // separately count remaining admins before a demotion.
    if (id === req.user!.id) throw new HttpError(422, "You cannot change your own role");

    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "User not found");

    const user = await prisma.user.update({ where: { id }, data: { role: body.role } });
    // A role change hands out or removes capability, so it has to be
    // attributable afterwards.
    recordAudit(req, {
      action: AUDIT_ACTIONS.USER_ROLE_CHANGED,
      subjectType: "user",
      subjectId: user.id,
      subjectLabel: user.email,
      details: { from: existing.role, to: user.role },
    });
    res.json({ user: publicUser(user, await permissionsOf(user)) });
  }),
);

const createUserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(ADMIN_CREATABLE_ROLES),
});

/**
 * Create a user with a chosen role, directly.
 *
 * Deliberately NOT a variant of /register: that route is public and must
 * always produce a CUSTOMER (PUBLIC_SIGNUP_ROLE), or self-service signup
 * would be a way to mint organisers. This one is admin-only and takes an
 * explicit role — but ADMIN is not one of the choices. The database seed
 * stays the only way an admin account comes into being; this endpoint
 * widens who can create ORGANISER/CUSTOMER accounts, not who can create
 * ADMIN ones. Letting any admin mint another admin would mean a single
 * compromised admin account could cascade into as many more as it wanted.
 *
 * ADMIN_CREATABLE_ROLES is the enforcement, not a UI convention to trust:
 * zod rejects "ADMIN" here before this handler ever sees it, independent of
 * whatever the frontend's role picker happens to offer.
 *
 * Mirrors /register's hardening: same bcrypt cost, same 8-character
 * minimum, same duplicate-email 422.
 */
authRouter.post(
  "/users",
  authenticate,
  requirePermission("users.manage"),
  asyncHandler(async (req, res) => {
    const body = createUserSchema.parse(req.body);

    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) throw new HttpError(422, "An account with this email already exists");

    const passwordHash = await bcrypt.hash(body.password, 10);
    const user = await prisma.user.create({
      data: { name: body.name, email: body.email, passwordHash, role: body.role },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        _count: { select: { events: true, orders: true } },
      },
    });
    recordAudit(req, {
      action: AUDIT_ACTIONS.USER_CREATED,
      subjectType: "user",
      subjectId: user.id,
      subjectLabel: user.email,
      // Never the password, obviously — but the ROLE is the part worth
      // keeping: an account created as ORGANISER can sell tickets.
      details: { role: user.role, name: user.name },
    });
    res.status(201).json({ user: adminUser(user) });
  }),
);

// ─────────────────────────────────────── role → permission grants ──

/**
 * The permission catalogue plus who currently holds what.
 *
 * Reads the grants from the database rather than from DEFAULT_ROLE_
 * PERMISSIONS, because the defaults are only a seed — once an admin edits a
 * grant, the database is the authority and the constant is stale.
 */
authRouter.get(
  "/permissions",
  authenticate,
  requirePermission("users.manage"),
  asyncHandler(async (_req, res) => {
    const grants = await prisma.rolePermission.findMany({ select: { role: true, permissionKey: true } });

    const byRole: Record<string, string[]> = {};
    for (const role of ROLES) byRole[role] = [];
    for (const grant of grants) byRole[grant.role]?.push(grant.permissionKey);
    for (const role of ROLES) byRole[role].sort();

    res.json({
      permissions: PERMISSION_KEYS.map((key) => ({
        key,
        description: PERMISSIONS[key],
        locked: isLockedGrant("ADMIN", key),
      })),
      roles: byRole,
    });
  }),
);

function roleParam(req: Parameters<typeof param>[0]): Role {
  const value = param(req, "role");
  if (!isRole(value)) throw new HttpError(404, "Unknown role");
  return value;
}

const grantSchema = z.object({ permission: z.string() });

authRouter.post(
  "/roles/:role/permissions",
  authenticate,
  requirePermission("users.manage"),
  asyncHandler(async (req, res) => {
    const role = roleParam(req);
    const { permission } = grantSchema.parse(req.body);
    if (!isPermission(permission)) throw new HttpError(404, "Unknown permission");

    await prisma.rolePermission.upsert({
      where: { role_permissionKey: { role, permissionKey: permission } },
      update: {},
      create: { role, permissionKey: permission },
    });
    // The cache is keyed by role and read on nearly every request; without
    // this the grant would take up to its TTL to appear, which looks like a
    // bug to whoever just clicked the toggle.
    invalidatePermissionCache(role);

    recordAudit(req, {
      action: AUDIT_ACTIONS.ROLE_PERMISSION_GRANTED,
      subjectType: "role",
      subjectId: role,
      subjectLabel: role,
      details: { permission },
    });

    res.json({ role, permissions: await permissionListForRole(role) });
  }),
);

authRouter.delete(
  "/roles/:role/permissions/:permission",
  authenticate,
  requirePermission("users.manage"),
  asyncHandler(async (req, res) => {
    const role = roleParam(req);
    const permission = param(req, "permission");
    if (!isPermission(permission)) throw new HttpError(404, "Unknown permission");

    // The anti-lockout invariant. Stripping users.manage from ADMIN would
    // lock every admin out of user and permission management permanently —
    // including out of the screen needed to undo it — and re-seeding would
    // not restore it on an existing install. This is the deliberate
    // exception to "a role's powers are data".
    if (isLockedGrant(role, permission)) {
      throw new HttpError(422, "This permission cannot be removed from this role");
    }

    await prisma.rolePermission.deleteMany({ where: { role, permissionKey: permission } });
    invalidatePermissionCache(role);

    // Revoking affects every account holding that role, immediately — the
    // one change most likely to be asked about later.
    recordAudit(req, {
      action: AUDIT_ACTIONS.ROLE_PERMISSION_REVOKED,
      subjectType: "role",
      subjectId: role,
      subjectLabel: role,
      details: { permission },
    });

    res.json({ role, permissions: await permissionListForRole(role) });
  }),
);

/**
 * What removing this account would actually do.
 *
 * Read-only, so a confirmation dialog can say "this will be anonymised, not
 * deleted, because there are 3 payouts" before the click rather than after.
 */
authRouter.get(
  "/users/:id/removal",
  authenticate,
  requirePermission("users.manage"),
  asyncHandler(async (req, res) => {
    res.json(await planRemoval(param(req, "id")));
  }),
);

/**
 * Remove an account.
 *
 * Deletes it outright when nothing depends on it, and anonymises it when
 * money history does — see lib/user-admin.ts for why that is two outcomes
 * rather than a choice.
 *
 * The self-deletion guard mirrors the one on /users/:id/role: as long as an
 * admin can never remove themselves, the platform can never reach zero
 * admins, so there is no separate count to maintain. It also rules out the
 * obvious accident.
 */
authRouter.delete(
  "/users/:id",
  authenticate,
  requirePermission("users.manage"),
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    if (id === req.user!.id) throw new HttpError(422, "You cannot remove your own account");

    const target = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true, role: true } });
    if (!target) throw new HttpError(404, "User not found");
    // Same reasoning as ADMIN_CREATABLE_ROLES on user creation: an admin
    // must not be able to remove another admin, or one compromised account
    // could clear out every other administrator.
    if (target.role === "ADMIN") throw new HttpError(403, "An admin account cannot be removed here");

    const result = await removeUser(id);

    // Recorded BEFORE the response, and with the old email as the label —
    // the row is the only remaining trace of who this was.
    recordAudit(req, {
      action: result.mode === "deleted" ? AUDIT_ACTIONS.USER_DELETED : AUDIT_ACTIONS.USER_ANONYMISED,
      subjectType: "user",
      subjectId: id,
      subjectLabel: result.email,
      details: { mode: result.mode, role: target.role },
    });

    res.json({ ok: true, mode: result.mode });
  }),
);


// ─── Store credit ────────────────────────────────────────────────────────

/**
 * GET /auth/me/credit — the holder's balance and every movement behind it.
 *
 * The statement, not just the number. A balance with no history cannot
 * answer "where did this come from", which is the first thing someone asks
 * about money that appeared in their account — and the entries are the
 * authoritative thing anyway: the balance is their sum.
 */
authRouter.get(
  "/me/credit",
  authenticate,
  asyncHandler(async (req, res) => {
    res.json(await creditStatement(req.user!.id));
  }),
);
