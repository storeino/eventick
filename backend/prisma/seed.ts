// Seeds the real database from the original frontend's hardcoded catalog,
// frozen to JSON (see prisma/catalog-frozen.json) from the old TanStack app's
// src/lib/catalog.ts before that directory was removed — so the ported
// backend serves the exact same 16 demo events instead of hand-retyped data.
import { PrismaClient, type PromoKind } from "@prisma/client";
import bcrypt from "bcryptjs";
import catalogFrozen from "./catalog-frozen.json" with { type: "json" };
// The permission matrix lives in its own module so it can be applied to a
// database WITHOUT seeding demo events and accounts over it — see the note
// there. Imported rather than duplicated, so the two cannot drift.
import { seedPermissions } from "./seed-permissions.js";
// One definition of the demo passwords, shared with the reset script.
import { passwordFor } from "./reset-demo-passwords.js";

const EVENTS = catalogFrozen;

const prisma = new PrismaClient();

const madToCents = (mad: number) => Math.round(mad * 100);

const SEED_ADMIN_EMAIL = "admin@eventick.ma";
/*
 * Read from the same table reset-demo-passwords.ts writes, so a freshly
 * seeded database and a repaired one agree. They did not: the passwords
 * were changed on the shared database and these constants still held the
 * old ones, which works until someone points a live suite at that database
 * and every login 401s for no visible reason.
 */
const SEED_ADMIN_PASSWORD = passwordFor(SEED_ADMIN_EMAIL);

/** Demo accounts surfaced by the login screen's dev-only quick-login buttons.
 * Kept in sync with frontend/src/demoAccounts.js. */
const DEMO_ACCOUNTS = [
  {
    email: "organisateur@eventick.ma",
    password: passwordFor("organisateur@eventick.ma"),
    name: "Yasmine Organisatrice",
    role: "ORGANISER" as const,
  },
  {
    email: "client@eventick.ma",
    password: passwordFor("client@eventick.ma"),
    name: "Karim Client",
    role: "CUSTOMER" as const,
  },
];

/**
 * A reasonable venue shape for a seeded event.
 *
 * Category alone is not enough -- a sport event can be a stadium match or a
 * road race, and both exist in this catalogue -- so the two that category
 * gets wrong are matched by name first.
 */
/**
 * Whether a seeded event opts into resale.
 *
 * Not every organiser wants one. A gala dinner or a trade badge is tied to
 * the person who booked it; a sold-out derby or festival is exactly where a
 * secondary market stops seats going empty. Keyed off category rather than
 * set everywhere, so the seeded catalogue shows both answers.
 */
function allowResaleFor(event: { category: string }) {
  return ["concert", "festivals", "sport", "nightlife"].includes(event.category);
}

function venueKindFor(event: { slug: string; titleFr: string; category: string }) {
  const name = `${event.slug} ${event.titleFr}`;
  if (/derby|stade/i.test(name)) return "STADIUM" as const;
  if (/plage|beach|jardin|rempart|oasis/i.test(name)) return "OPEN_AIR" as const;
  const byCategory: Record<string, "STAGE" | "HALL" | "COURSE" | "EXPO"> = {
    concert: "STAGE",
    festivals: "STAGE",
    nightlife: "STAGE",
    culture: "HALL",
    humour: "HALL",
    sport: "COURSE",
    salons: "EXPO",
  };
  return byCategory[event.category] ?? "STAGE";
}

async function main() {
  await seedPermissions(prisma);

  // The only user the app has no other way to create: every ORGANISER/ADMIN
  // account after this one is granted via PATCH /api/auth/users/:id/role by
  // an existing admin (see routes/auth.ts). Without this seed row, that
  // endpoint is unreachable and /organiser + /pro stay locked forever.
  const admin = await prisma.user.upsert({
    where: { email: SEED_ADMIN_EMAIL },
    update: {},
    create: {
      email: SEED_ADMIN_EMAIL,
      name: "Admin Eventick",
      passwordHash: await bcrypt.hash(SEED_ADMIN_PASSWORD, 10),
      role: "ADMIN",
    },
  });

  for (const event of EVENTS as any[]) {
    await prisma.event.upsert({
      where: { slug: event.slug },
      update: {},
      create: {
        slug: event.slug,
        organiserId: admin.id,
        status: "PUBLISHED",
        titleFr: event.titleFr,
        titleAr: event.titleAr,
        category: event.category,
        city: event.city,
        venueFr: event.venueFr,
        venueAr: event.venueAr,
        // A starting shape per category, so a fresh database is not
        // sixteen events all claiming to be the same room. The
        // organiser changes it per event; this is only a default.
        venueKind: venueKindFor(event),
        // Resale stays OPT-IN -- selling someone else's seat on is the
        // organiser's call, which is why the column defaults to false. The
        // seed turns it on where a secondary market is normal, so the
        // feature is visible on a fresh database without changing the rule.
        allowResale: allowResaleFor(event),
        address: event.address,
        startAt: new Date(`${event.start}T${event.time ?? "00:00"}:00`),
        endAt: new Date(`${event.end}T23:59:59`),
        doorsAt: new Date(`${event.start}T${event.doors ?? event.time ?? "00:00"}:00`),
        image: event.image,
        badge: event.badge ?? null,
        blurbFr: event.blurbFr,
        blurbAr: event.blurbAr,
        aboutFr: event.aboutFr,
        aboutAr: event.aboutAr,
        ageFr: event.ageFr,
        ageAr: event.ageAr,
        popularity: event.popularity,
        instant: event.instant,
        tiers: {
          create: (event.tiers ?? []).map((tier: any) => ({
            nameFr: tier.nameFr,
            nameAr: tier.nameAr,
            blurbFr: tier.blurbFr,
            blurbAr: tier.blurbAr,
            priceCents: madToCents(tier.price),
            capacity: tier.capacity,
            numbered: Boolean(tier.numbered),
            recommended: Boolean(tier.recommended),
            saveCents: tier.save ? madToCents(tier.save) : null,
            perks: tier.perks ?? [],
            zoneFr: tier.zoneFr,
            zoneAr: tier.zoneAr,
            gateFr: tier.gateFr,
            gateAr: tier.gateAr,
          })),
        },
        lineup: {
          create: (event.lineup ?? []).map((item: any) => ({
            day: new Date(`${item.day}T${item.time}:00`),
            time: item.time,
            name: item.name,
            genreFr: item.genreFr,
            genreAr: item.genreAr,
            image: item.image,
          })),
        },
      },
    });
  }

  const demoUsers = [];
  for (const account of DEMO_ACCOUNTS) {
    demoUsers.push(
      await prisma.user.upsert({
        where: { email: account.email },
        update: {},
        create: {
          email: account.email,
          name: account.name,
          passwordHash: await bcrypt.hash(account.password, 10),
          role: account.role,
        },
      }),
    );
  }

  /*
   * Every event ends up owned by the demo ORGANISER, not the admin.
   *
   * The admin above is only a placeholder: events are created before the demo
   * accounts exist, and organiserId is required at that point. Leaving them
   * there used to make fourteen of the sixteen seeded events admin-owned,
   * which modelled the platform wrong in a way that mattered — organiserId
   * decides who a payout pays, at which plan's rate, into which bank
   * account. An admin owning an event means the platform pays itself.
   *
   * An admin now has to NAME an organiser when creating an event (see
   * resolveOwner in routes/organiser.ts), so a seed that produced events the
   * API itself would refuse to create was also a seed nobody could trust as
   * an example.
   */
  const demoOrganiser = demoUsers.find((user) => user.role === "ORGANISER");
  if (demoOrganiser) {
    const rehomed = await prisma.event.updateMany({
      where: { organiserId: admin.id },
      data: { organiserId: demoOrganiser.id },
    });
    if (rehomed.count > 0) {
      console.log(`Handed ${rehomed.count} event(s) to ${demoOrganiser.email}.`);
    }

    /*
     * Bank details for the demo organiser.
     *
     * Not decoration: runPayout REFUSES an organiser with no account on file,
     * so without this the whole money half of the dashboard is unreachable on
     * a fresh database — you cannot prepare a payout, and the Finance screen
     * shows a red "no RIB" where the demo is supposed to show a working one.
     *
     * The RIB is a made-up 24-digit string that satisfies ribOk() and belongs
     * to no real account. `update` on conflict rather than skip, so a re-seed
     * restores it if someone has edited it while clicking around.
     */
    await prisma.bankAccount.upsert({
      where: { organiserId: demoOrganiser.id },
      update: { holderName: "Yasmine Organisatrice", rib: "011519000012345678901234", bank: "Attijariwafa Bank" },
      create: {
        organiserId: demoOrganiser.id,
        holderName: "Yasmine Organisatrice",
        rib: "011519000012345678901234",
        bank: "Attijariwafa Bank",
      },
    });
    console.log(`Bank details set for ${demoOrganiser.email}.`);
  }

  const promos: { code: string; kind: PromoKind; value: number; eventSlug: string | null; maxUses: number }[] = [
    { code: "SAFRAN15", kind: "PERCENT", value: 15, eventSlug: null, maxUses: 200 },
    { code: "CASA50", kind: "AMOUNT", value: madToCents(50), eventSlug: "oasis-2026", maxUses: 40 },
  ];

  for (const promo of promos) {
    const event = promo.eventSlug ? await prisma.event.findUnique({ where: { slug: promo.eventSlug } }) : null;
    await prisma.promoCode.upsert({
      where: { code: promo.code },
      update: {},
      create: { code: promo.code, kind: promo.kind, value: promo.value, eventId: event?.id ?? null, maxUses: promo.maxUses },
    });
  }

  console.log(`Seeded ${(EVENTS as any[]).length} events and ${promos.length} promo codes.`);
  console.log(`Admin login: ${SEED_ADMIN_EMAIL} / ${SEED_ADMIN_PASSWORD} — change this password before deploying.`);
  for (const account of DEMO_ACCOUNTS) {
    console.log(`${account.role} login: ${account.email} / ${account.password}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
