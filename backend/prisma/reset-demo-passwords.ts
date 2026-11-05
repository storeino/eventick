/**
 * Set the three demo accounts to short, memorable passwords.
 *
 * These are demo logins on a demo catalogue — the site says so in its own
 * banner, no real seat is for sale, and the point of them is that anyone
 * reviewing the project can switch between the three roles without being
 * handed a password manager. So they are deliberately simple.
 *
 * Deliberately NOT the seed's job. seed.ts upserts with `update: {}`, so it
 * never touches an account that already exists — which is correct (it must
 * not reset a password someone changed), but it also means the seed cannot
 * fix a password that is already wrong. This can, and only this.
 *
 *   npm run db:demo-passwords
 *
 * It uses the DATABASE_URL already in the environment, so point that at
 * another database to update that one instead.
 *
 * If this project ever carries real buyers' data, delete this file and give
 * the accounts real passwords: anything here is public by construction.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

/*
 * Short on purpose; see the note above. Eight characters minimum, because
 * that is what registerSchema enforces (`password: z.string().min(8)`) —
 * writing the hash directly here bypasses that check, so a 7-character
 * demo password would work at the login form while being impossible to
 * set through the API, which is the kind of inconsistency that wastes an
 * afternoon later.
 */
export const DEMO_PASSWORDS: Array<[string, string]> = [
  ["admin@eventick.ma", "admin123"],
  ["organisateur@eventick.ma", "orga1234"],
  ["client@eventick.ma", "client123"],
];

/** The demo password for an account, so seed.ts never holds its own copy. */
export function passwordFor(email: string): string {
  const hit = DEMO_PASSWORDS.find(([address]) => address === email);
  if (!hit) throw new Error(`no demo password defined for ${email}`);
  return hit[1];
}

export async function resetDemoPasswords(prisma: PrismaClient): Promise<string[]> {
  const done: string[] = [];
  for (const [email, password] of DEMO_PASSWORDS) {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!user) {
      console.warn(`  SKIP  ${email} — no such account on this database`);
      continue;
    }
    await prisma.user.update({
      where: { email },
      data: { passwordHash: await bcrypt.hash(password, 10) },
    });
    done.push(email);
  }
  return done;
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("reset-demo-passwords.ts")) {
  const prisma = new PrismaClient();
  resetDemoPasswords(prisma)
    .then(async (done) => {
      console.log(`\nupdated ${done.length} of ${DEMO_PASSWORDS.length} account(s):`);
      for (const [email, password] of DEMO_PASSWORDS) {
        if (done.includes(email)) console.log(`  ${email.padEnd(28)} ${password}`);
      }
      await prisma.$disconnect();
    })
    .catch(async (err) => {
      console.error(err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
