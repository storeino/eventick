/**
 * The permission catalogue and the per-role grants, on their own.
 *
 * A role name grants nothing by itself: lib/permissions.ts resolves every
 * capability from the `role_permissions` table, and a role with no rows
 * resolves to `[]`. The frontend hides a control it has no permission for,
 * so an ADMIN on a database with an empty matrix logs in successfully and
 * is shown the customer's site — correct role, no powers. That is exactly
 * what happened on the shared dev database: the three accounts were right,
 * `role_permissions` was empty, and the admin looked like a client.
 *
 * `prisma/seed.ts` already wrote this table, but only as part of seeding
 * everything else — demo events, demo accounts, promo codes. On a database
 * that already has real data, running the full seed to repair permissions
 * is not an option. So the matrix lives here, and seed.ts imports it.
 *
 * Repair any database without touching its data:
 *   npm run db:permissions
 *
 * It uses the DATABASE_URL already in the environment, so point that at
 * another database to repair that one instead.
 */
import { PrismaClient } from "@prisma/client";

export const PERMISSION_CATALOG: Array<[string, string]> = [
  ["events.manage", "Create, edit, hide and delete events, and manage their ticket tiers"],
  ["orders.manage", "View orders, admit and re-issue tickets, cancel and delete orders"],
  ["gate.checkin", "Check tickets in at the door and download the offline manifest"],
  ["finance.view", "View revenue, payout and platform-fee figures"],
  ["finance.refund", "Refund an order, in full or in part"],
  ["promo.manage", "Create, edit and delete promotional codes"],
  ["uploads.create", "Upload event images"],
  ["users.manage", "List users and change their roles"],
  ["scope.any", "Act on any organiser's data, not only your own"],
];

export const ROLE_GRANTS: Record<"CUSTOMER" | "ORGANISER" | "ADMIN", string[]> = {
  CUSTOMER: [],
  ORGANISER: [
    "events.manage",
    "orders.manage",
    "gate.checkin",
    "finance.view",
    "finance.refund",
    "promo.manage",
    "uploads.create",
  ],
  ADMIN: [
    "events.manage",
    "orders.manage",
    "gate.checkin",
    "finance.view",
    "finance.refund",
    "promo.manage",
    "uploads.create",
    "users.manage",
    "scope.any",
  ],
};

/**
 * Write the catalogue and the grants.
 *
 * The deleteMany is deliberate: `update: {}` alone would leave a capability
 * removed from ROLE_GRANTS sitting in the database forever, and for
 * permissions that is a security property rather than harmless staleness —
 * a revoked power would never actually be revoked.
 *
 * The flip side is that this resets any grant an admin changed through the
 * UI back to these defaults. That is the intended trade, and it doubles as
 * the recovery path when someone revokes too much.
 */
export async function seedPermissions(prisma: PrismaClient): Promise<void> {
  for (const [key, description] of PERMISSION_CATALOG) {
    await prisma.permission.upsert({
      where: { key },
      update: { description },
      create: { key, description },
    });
  }

  for (const [role, keys] of Object.entries(ROLE_GRANTS) as Array<
    ["CUSTOMER" | "ORGANISER" | "ADMIN", string[]]
  >) {
    await prisma.rolePermission.deleteMany({ where: { role, permissionKey: { notIn: keys } } });
    for (const permissionKey of keys) {
      await prisma.rolePermission.upsert({
        where: { role_permissionKey: { role, permissionKey } },
        update: {},
        create: { role, permissionKey },
      });
    }
  }
}

/*
 * Run directly: repair this database's matrix and report what it now holds.
 *
 * Gated on the filename rather than an import.meta/argv comparison, which
 * is awkward to get right across Windows paths and tsx's loader. seed.ts
 * imports the function above and never matches this.
 */
if (process.argv[1]?.replace(/\\/g, "/").endsWith("seed-permissions.ts")) {
  const prisma = new PrismaClient();
  seedPermissions(prisma)
    .then(async () => {
      const rows = await prisma.rolePermission.groupBy({ by: ["role"], _count: true });
      console.log("role permissions now configured:");
      for (const r of rows.sort((a, b) => a.role.localeCompare(b.role))) {
        console.log(`  ${r.role.padEnd(10)} ${r._count}`);
      }
      if (!rows.some((r) => r.role === "ADMIN")) {
        console.error("\nADMIN still has no permissions — that should not happen.");
        process.exitCode = 1;
      }
      await prisma.$disconnect();
    })
    .catch(async (err) => {
      console.error(err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
