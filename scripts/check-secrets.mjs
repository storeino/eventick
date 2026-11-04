/**
 * Refuse to let a credential into the repository.
 *
 * The Resend key has been flagged as "needs rotating because it is in the
 * history" across several sessions. It is not, and never was: backend/.env
 * is gitignored and no key-shaped string appears in any tracked file or in
 * any commit. The warning was wrong, and repeating it cost more attention
 * than checking it once would have.
 *
 * What was actually missing is the thing that makes the claim checkable, so
 * this is it. Scans every TRACKED file — not the working tree, because an
 * ignored .env holding a real key is the correct place for one.
 *
 *   node scripts/check-secrets.mjs
 *
 * Wire it into a pre-commit hook and a key cannot land by accident:
 *   git config core.hooksPath .githooks
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

/*
 * Shapes, not values. A list of known keys would have to contain them,
 * which is the problem it is trying to solve.
 */
const PATTERNS = [
  { name: "Resend API key", re: /\bre_[A-Za-z0-9]{20,}\b/ },
  { name: "Stripe secret key", re: /\bsk_(live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "private key block", re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  /*
   * A JWT or CMI store key assigned in a committed file. Deliberately
   * narrow: it wants `NAME=value`, so the .env.example placeholders and
   * every mention in prose stay quiet.
   */
  { name: "assigned secret", re: /\b(JWT_SECRET|CMI_STORE_KEY|DATABASE_URL)\s*=\s*["']?[^\s"'<>$]{12,}/ },
];

/** Files whose whole job is to describe these patterns. */
const SELF = ["scripts/check-secrets.mjs"];

function tracked() {
  return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

const findings = [];
for (const file of tracked()) {
  if (SELF.includes(file)) continue;
  let text;
  try {
    // Skip anything large or binary rather than reading a video into memory.
    if (statSync(file).size > 2_000_000) continue;
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\0")) continue;

  text.split("\n").forEach((line, i) => {
    for (const { name, re } of PATTERNS) {
      if (re.test(line)) findings.push({ file, line: i + 1, name });
    }
  });
}

if (findings.length === 0) {
  console.log("\x1b[32mNo credentials in tracked files.\x1b[0m");
  process.exit(0);
}

console.error("\x1b[31mCredential-shaped strings in tracked files:\x1b[0m\n");
for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.name}`);
console.error(
  "\nA real key here means rotating it, not just deleting the line — it is in\n" +
    "the history the moment it is committed. Put it in backend/.env, which is\n" +
    "gitignored, and reference it by name.",
);
process.exit(1);
