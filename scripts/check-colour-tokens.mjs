/**
 * Refuse a Tailwind colour class that names a token the theme does not have.
 *
 * Tailwind emits NOTHING for an undefined colour. `bg-safran` is not an
 * error, not a warning, not a fallback — the declaration simply never
 * reaches the stylesheet, and the element renders with no background at all.
 * Nothing in the build, the types or eslint can see it.
 *
 * That is how the CMI payment screen shipped broken. The v3 charte dropped
 * the old charte's names (safran, lagon, corail), every screen was updated
 * except this one, and the single button on the one page where money changes
 * hands lost its fill and its height. It read as a caption, and it stayed
 * that way until a buyer said the payment step "has no UI at all".
 *
 *   node scripts/check-colour-tokens.mjs
 *
 * Wire it into the pre-commit hook beside check-secrets.mjs and a deleted
 * colour cannot quietly blank an element again.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FRONTEND = new URL("../frontend/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const CSS = join(FRONTEND, "src/app/styles.css");
const SRC = join(FRONTEND, "src");

/** Every `--<family>-<name>` the theme defines, grouped by family. */
function themeTokens() {
  const css = readFileSync(CSS, "utf8");
  const byFamily = new Map();
  for (const m of css.matchAll(/^\s*--([a-z]+)-([a-z0-9-]+?)\s*:/gim)) {
    const [, family, name] = m;
    // `--text-hero--line-height` declares no new name of its own.
    if (name.includes("--")) continue;
    if (!byFamily.has(family)) byFamily.set(family, new Set());
    byFamily.get(family).add(name);
  }
  return byFamily;
}

/*
 * Only prefixes whose value is ALWAYS a colour.
 *
 * Deliberately excludes the ambiguous ones. `text-` also takes font sizes
 * (text-title), `border-` takes sides and widths (border-b, border-2),
 * `shadow-` takes named shadows (shadow-pop), `to-`/`from-` collide with
 * ordinary prose in class-adjacent strings. Checking those needs the full
 * utility grammar; checking these needs only a name, and these are where the
 * bug actually bit — a background and a text colour that silently vanished.
 *
 * `text-` IS covered, but only against the union of colour AND text-size
 * tokens, since both are legal there. See TEXT_FAMILIES.
 */
const COLOUR_ONLY = ["bg", "fill", "stroke", "caret", "accent"];
/** Families a `text-*` class may legitimately name. */
const TEXT_FAMILIES = ["color", "text"];
/** Tailwind's own names, legal everywhere alongside the theme's. */
const BUILT_IN = new Set([
  "inherit", "current", "transparent", "black", "white", "none", "auto",
  "slate", "gray", "zinc", "neutral", "stone", "red", "orange", "amber",
  "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue",
  "indigo", "violet", "purple", "fuchsia", "pink", "rose",
  // text-* utilities that are neither a colour nor a theme size.
  "xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl",
  "left", "center", "right", "justify", "start", "end", "wrap", "nowrap",
  "balance", "pretty", "ellipsis", "clip",
  // bg-* utilities that are not colours.
  "cover", "contain", "fixed", "local", "scroll", "bottom", "top", "center",
  "repeat", "no-repeat", "origin", "gradient", "blend",
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(jsx?|tsx?)$/.test(entry)) out.push(full);
  }
  return out;
}

const tokens = themeTokens();
const colours = tokens.get("color") ?? new Set();
if (colours.size === 0) {
  console.error(`No --color-* tokens found in ${CSS} — has the theme moved?`);
  process.exit(1);
}
const textNames = new Set([...TEXT_FAMILIES.flatMap((f) => [...(tokens.get(f) ?? [])])]);

/** Names legal for a given prefix. */
function allowed(prefix) {
  return prefix === "text" ? textNames : colours;
}

const PATTERN = new RegExp(
  `\\b(?:[a-z-]+:)*(${[...COLOUR_ONLY, "text"].join("|")})-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)`,
  "g",
);

const findings = [];
for (const file of walk(SRC)) {
  let inBlock = false;
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      /*
       * Skip comments, including the inside of a block comment.
       *
       * Prose says things like "text-only boxes", and the notes explaining
       * THIS bug necessarily quote the dead class names — so without this
       * the fix reports itself. Line-position alone was not enough: the
       * offenders were CONTINUATION lines inside a block comment, which
       * start with neither `//` nor `/*`.
       */
      const trimmed = line.trim();
      const wasInBlock = inBlock;
      if (inBlock) {
        if (line.includes("*/")) inBlock = false;
      } else if (/\/\*/.test(line) && !line.includes("*/")) {
        inBlock = true;
      }
      if (wasInBlock || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
        return;
      }
      for (const m of line.matchAll(PATTERN)) {
        const [whole, prefix, raw] = m;
        const name = raw.split("/")[0]; // drop an opacity suffix: bg-brume/40
        // bg-linear-to-br / bg-gradient-to-t name a DIRECTION, not a colour;
        // the colours come from the separate from-/via-/to- utilities.
        if (prefix === "bg" && /^(linear|gradient|radial|conic)\b/.test(name)) continue;
        if (BUILT_IN.has(name) || allowed(prefix).has(name)) continue;
        // A compound token (stage-fg) may match with its tail trimmed; accept
        // any prefix of the name that the theme defines.
        const parts = name.split("-");
        if (parts.some((_, k) => allowed(prefix).has(parts.slice(0, k + 1).join("-")))) continue;
        findings.push({ file: file.slice(FRONTEND.length), line: i + 1, cls: whole });
      }
    });
}

if (findings.length === 0) {
  console.log("\x1b[32mEvery colour class names a token the theme defines.\x1b[0m");
  process.exit(0);
}

console.error("\x1b[31mColour classes naming tokens the theme does not define:\x1b[0m\n");
for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.cls}`);
console.error(
  "\nTailwind emits no CSS for an undefined colour, so each of these renders\n" +
    "with NOTHING applied. Either the token was renamed (check --color-* in\n" +
    "src/app/styles.css) or the class is a typo. If a name above is a\n" +
    "legitimate non-colour utility, add it to BUILT_IN in this script.",
);
process.exit(1);
