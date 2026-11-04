import { useI18n } from "../i18n";
import { cn, eventText, groupNumber } from "../utils";

/**
 * The site plan, drawn from the event's OWN zones.
 *
 * What was here before was three fixed shapes — a stage, a VIP wedge and a
 * lawn — rendered identically on every event in the catalogue. A marathon
 * was shown a VIP zone it has no concept of, a numbered theatre was shown a
 * lawn, and an event with two zones was still given three blocks. It
 * described one venue and was wrong about every other.
 *
 * Now each block is a real TicketTier: its name, its capacity, in the
 * arrangement the organiser chose with `venueKind`. If the plan is wrong,
 * the data is wrong, which is a problem somebody can actually fix.
 *
 * Deliberately NOT a seat map. A buyer picking a zone needs to know roughly
 * where it sits relative to the action; per-seat selection is a different
 * feature with a different checkout, and pretending otherwise with a picture
 * of numbered squares nobody can click would be worse than this.
 */

/**
 * Zones from closest-to-the-action outward.
 *
 * `planOrder` first, because the organiser is the only one who knows the
 * room. Price is the fallback, and it is a decent proxy that is wrong
 * exactly where it matters: a cheap side balcony near the stage, or a
 * premium rear lounge, both come out backwards under price alone.
 *
 * Zones WITH a position always sit ahead of zones without one — a half-
 * filled field should still read front-to-back, and a tier nobody placed
 * does not belong in front of one somebody did. Ties fall back to price, so
 * giving two zones the same number is a statement that they are side by
 * side rather than an accident.
 */
function ordered(tiers) {
  const pos = (tier) => (typeof tier.planOrder === "number" ? tier.planOrder : Number.POSITIVE_INFINITY);
  return [...tiers].sort((a, b) => pos(a) - pos(b) || b.priceCents - a.priceCents);
}

/**
 * How tall a zone should be drawn, from how many people it holds.
 *
 * Every zone used to be sized by its POSITION in the list, so on derby-casa
 * the 400-seat Loge latérale was drawn the same size as the 18 000-seat
 * Virage populaire — forty-five times the people, identical block. A plan
 * that gets the order right and the proportion wrong is misleading in a new
 * way rather than fixed.
 *
 * Square-rooted, not linear. Linear would make that same Virage 45× the
 * Loge, which is honest arithmetic and an unusable drawing: the small zone
 * collapses to a line of unreadable text. A square root keeps the big zone
 * visibly bigger while leaving the small one a block someone can click and
 * read — the same compression a cartogram uses, and for the same reason.
 *
 * Clamped at both ends so one enormous zone cannot squeeze the rest to
 * nothing, and a tiny one still has room for its name.
 */
function heights(tiers, { min = 44, max = 132 } = {}) {
  const roots = tiers.map((tier) => Math.sqrt(Math.max(1, tier.capacity ?? 1)));
  const lo = Math.min(...roots);
  const hi = Math.max(...roots);
  // All the same size: no information in the ratio, so don't invent any.
  if (!Number.isFinite(lo) || hi - lo < 0.0001) return tiers.map(() => (min + max) / 2);
  return roots.map((r) => Math.round(min + ((r - lo) / (hi - lo)) * (max - min)));
}

/**
 * How WIDE a zone should be drawn.
 *
 * Width used to come from the depth index alone -- each zone 15% wider than
 * the one in front -- which reads as perspective on a festival where the
 * zones really do widen going back. On a small room it inverted the truth:
 * a 2-person "Entrée" was drawn WIDER than a 40-seat zone, because it
 * happened to sit one step further back.
 *
 * Capacity now sets it, with the depth index kept as a small nudge so a
 * plan whose zones hold similar numbers still reads front-to-back rather
 * than as a stack of identical bars. Square-rooted for the same reason
 * heights are: linear makes the small zone a sliver of unreadable text.
 *
 * `base` is the narrowest a zone may be drawn and `span` how much the
 * largest adds, both as percentages of the plan's width.
 */
function widths(tiers, { base = 52, span = 46, nudge = 4 } = {}) {
  const roots = tiers.map((tier) => Math.sqrt(Math.max(1, tier.capacity ?? 1)));
  const lo = Math.min(...roots);
  const hi = Math.max(...roots);
  const flat = !Number.isFinite(lo) || hi - lo < 0.0001;
  return tiers.map((_, i) => {
    // All one size: fall back to pure depth, which is the only signal left.
    const share = flat ? i / Math.max(1, tiers.length - 1) : (roots[i] - lo) / (hi - lo);
    return Math.round(Math.min(100, base + share * span + i * nudge));
  });
}

/** The palette, cycled. Index 0 is the dearest zone, so it reads as "best". */
const FILLS = ["bg-primary text-primary-fg", "bg-accent text-accent-fg", "bg-brume-deep text-ink", "bg-info text-info-fg", "bg-secondary text-secondary-fg"];
const DOTS = ["bg-primary", "bg-accent", "bg-brume-deep", "bg-info", "bg-secondary"];

/** A zone with nothing left. `remaining` is absent on some payloads, and
 * "unknown" must not read as "sold out". */
function isGone(tier) {
  return typeof tier.remaining === "number" && tier.remaining <= 0;
}

function Zone({ tier, locale, t, className, style, fill, onPick, picked }) {
  const gone = isGone(tier);
  /*
   * A zone you can still buy is a button; one that is gone is not.
   *
   * It does NOT add to the basket. A diagram that quietly drops a ticket in
   * your cart is a surprising thing to click, and the quantity still has to
   * be chosen. It scrolls to that zone's row and marks it, which is what
   * someone pointing at a picture is actually asking for: "that one — where
   * is it in the list".
   */
  const pickable = Boolean(onPick) && !gone;
  const Tag = pickable ? "button" : "div";
  return (
    <Tag
      type={pickable ? "button" : undefined}
      onClick={pickable ? () => onPick(tier.id) : undefined}
      aria-label={pickable ? `${eventText(tier, "name", locale)} — ${t("planPick")}` : undefined}
      className={cn(
        "flex min-h-11 w-full flex-col items-center justify-center px-3 text-center text-sm font-bold",
        fill,
        pickable && "cursor-pointer transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
        picked && "ring-2 ring-ink ring-offset-2",
        // Drained of colour and dimmed, so a glance at the plan answers
        // "what can I actually buy" before reading a single zone name.
        // Not hidden: the zone still exists, and a buyer looking for it
        // should find it struck through rather than missing.
        gone && "opacity-45 saturate-0",
        className,
      )}
      style={style}
    >
      <span className="line-clamp-2">{eventText(tier, "name", locale)}</span>
      {/* Said in words as well as colour: dimming alone fails for anyone
          with a colour deficiency, and fails everyone on a bright screen. */}
      {gone ? <span className="text-[10px] font-extrabold uppercase tracking-wide">{t("soldOut")}</span> : null}
    </Tag>
  );
}

/**
 * STAGE — everything faces one front. The original arrangement, kept for
 * concerts and festivals, but now with the event's real zones: dearest
 * nearest the stage, each block widening as it moves back.
 */
function StagePlan({ tiers, locale, t, onPick, picked }) {
  const zones = ordered(tiers);
  const tall = heights(zones);
  const wide = widths(zones);
  return (
    <>
      <div
        className="mx-auto flex h-10 w-[55%] items-center justify-center rounded-t-[999px] bg-ink text-xs font-bold uppercase tracking-wide text-paper"
        style={{ clipPath: "ellipse(50% 100% at 50% 100%)" }}
      >
        {t("stage")}
      </div>
      {zones.map((tier, i) => {
        // Both axes are capacity now. The inset keeps the trapezoid shape
        // that makes the block read as a zone rather than a bar.
        const width = wide[i];
        const inset = Math.max(0, 8 - i * 3);
        return (
          <Zone
            key={tier.id}
            tier={tier}
            locale={locale}
            t={t} onPick={onPick} picked={picked === tier.id}
            fill={FILLS[i % FILLS.length]}
            className="mx-auto mt-2"
            style={{
              width: `${width}%`,
              clipPath: `polygon(${inset}% 0, ${100 - inset}% 0, 100% 100%, 0 100%)`,
              height: `${tall[i]}px`,
            }}
          />
        );
      })}
    </>
  );
}

/**
 * HALL — a seated room facing a stage. Rows rather than wedges, because the
 * thing a buyer is choosing between is how far back they sit.
 */
function HallPlan({ tiers, locale, t, onPick, picked }) {
  const zones = ordered(tiers);
  // A hall's rows are its capacity: a 60-seat box should not look like the
  // 900-seat stalls beneath it.
  const tall = heights(zones, { min: 40, max: 110 });
  return (
    <>
      <div className="mx-auto flex h-9 w-[70%] items-center justify-center rounded-t-card bg-ink text-xs font-bold uppercase tracking-wide text-paper">
        {t("stage")}
      </div>
      <div className="mt-3 grid gap-1.5">
        {zones.map((tier, i) => (
          <Zone
            key={tier.id}
            tier={tier}
            locale={locale}
            t={t} onPick={onPick} picked={picked === tier.id}
            fill={FILLS[i % FILLS.length]}
            className="rounded-control"
            style={{ height: `${tall[i]}px` }}
          />
        ))}
      </div>
    </>
  );
}

/**
 * STADIUM — tiers wrapping a pitch. The pitch is the centre, and zones ring
 * it, which is the one arrangement where "front" means nothing.
 */
function StadiumPlan({ tiers, locale, t, onPick, picked }) {
  const zones = ordered(tiers);
  /*
   * The stands RING the pitch, so the four sides are taken in order and the
   * pitch sits in the middle.
   *
   * The previous version gave each side `w-[22%]` against a `flex-1` pitch,
   * so with three zones the two sides ate the width and the pitch was left a
   * narrow sliver with its own label clipped — a stadium drawn as two blocks
   * either side of a corridor. The pitch is now a fixed share of the middle
   * row and the sides split what is left, which keeps it dominant however
   * many zones there are.
   *
   * Depth is capacity: an 18 000-seat end is drawn thicker than a 400-seat
   * box, which is the whole point of sizing by how many people fit.
   */
  const [near, side1, side2, ...far] = zones;
  const deep = heights(zones, { min: 34, max: 76 });
  const depthOf = (tier) => deep[zones.indexOf(tier)];

  return (
    <div className="grid gap-1.5">
      {near ? (
        <Zone
          tier={near}
          locale={locale}
          t={t}
          onPick={onPick}
          picked={picked === near.id}
          fill={FILLS[0]}
          className="rounded-t-card"
          style={{ height: `${depthOf(near)}px` }}
        />
      ) : null}

      <div className="flex items-stretch gap-1.5" style={{ minHeight: "132px" }}>
        {side1 ? (
          <Zone
            tier={side1}
            locale={locale}
            t={t}
            onPick={onPick}
            picked={picked === side1.id}
            fill={FILLS[1]}
            className="rounded-s-card [writing-mode:vertical-rl] rotate-180"
            style={{ width: `${depthOf(side1)}px` }}
          />
        ) : null}

        {/* The pitch keeps the middle. Written across rather than down so
            the word fits however narrow the stands get. */}
        <div className="flex flex-1 items-center justify-center rounded-card border-2 border-dashed border-line/30 bg-paper text-xs font-bold uppercase tracking-wide text-muted">
          {t("venuePitch")}
        </div>

        {side2 ? (
          <Zone
            tier={side2}
            locale={locale}
            t={t}
            onPick={onPick}
            picked={picked === side2.id}
            fill={FILLS[2]}
            className="rounded-e-card [writing-mode:vertical-rl]"
            style={{ width: `${depthOf(side2)}px` }}
          />
        ) : null}
      </div>

      {/* A fourth zone closes the ring; a fifth onwards stacks behind it. */}
      {far.map((tier, i) => (
        <Zone
          key={tier.id}
          tier={tier}
          locale={locale}
          t={t}
          onPick={onPick}
          picked={picked === tier.id}
          fill={FILLS[(i + 3) % FILLS.length]}
          className={cn(i === far.length - 1 && "rounded-b-card")}
          style={{ height: `${depthOf(tier)}px` }}
        />
      ))}
    </div>
  );
}

/**
 * COURSE — a route, not a room. Zones are waves or distances, so they sit on
 * a line from start to finish rather than in a seating bowl.
 */
function CoursePlan({ tiers, locale, t, onPick, picked }) {
  /*
   * planOrder first, as everywhere, then CHEAPEST first rather than dearest:
   * on a course the zones are usually distances, and the short one starts
   * nearest the front. That inversion is why this does not just call
   * ordered().
   */
  const pos = (tier) => (typeof tier.planOrder === "number" ? tier.planOrder : Number.POSITIVE_INFINITY);
  const zones = [...tiers].sort((a, b) => pos(a) - pos(b) || a.priceCents - b.priceCents);
  const tall = heights(zones, { min: 40, max: 84 });
  const wide = widths(zones, { base: 48, span: 44, nudge: 6 });
  return (
    <div className="py-2">
      <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wide text-muted">
        <span>{t("venueStart")}</span>
        <span>{t("venueFinish")}</span>
      </div>
      <div className="relative mt-2 h-1.5 rounded-full bg-line/20">
        <span className="absolute inset-y-0 start-0 w-2 rounded-full bg-ink" aria-hidden />
        <span className="absolute inset-y-0 end-0 w-2 rounded-full bg-ink" aria-hidden />
      </div>
      <div className="mt-3 grid gap-1.5">
        {zones.map((tier, i) => (
          <Zone
            key={tier.id}
            tier={tier}
            locale={locale}
            t={t} onPick={onPick} picked={picked === tier.id}
            fill={FILLS[i % FILLS.length]}
            className="rounded-full"
            style={{ height: `${tall[i]}px`, width: `${wide[i]}%` }}
          />
        ))}
      </div>
    </div>
  );
}

/** EXPO — halls walked through, so equal blocks on a floor rather than a bowl. */
function ExpoPlan({ tiers, locale, t, onPick, picked }) {
  const zones = ordered(tiers);
  const tall = heights(zones, { min: 52, max: 104 });
  return (
    <>
      <div className="mx-auto mb-3 flex h-8 w-[40%] items-center justify-center rounded-card bg-ink text-[11px] font-bold uppercase tracking-wide text-paper">
        {t("venueEntrance")}
      </div>
      <div className={cn("grid gap-1.5", zones.length > 2 ? "grid-cols-2" : "grid-cols-1")}>
        {zones.map((tier, i) => (
          <Zone
            key={tier.id}
            tier={tier}
            locale={locale}
            t={t} onPick={onPick} picked={picked === tier.id}
            fill={FILLS[i % FILLS.length]}
            className="rounded-control"
            style={{ height: `${tall[i]}px` }}
          />
        ))}
      </div>
    </>
  );
}

/** OPEN_AIR — open ground, no fixed front: soft blobs rather than a bowl. */
function OpenAirPlan({ tiers, locale, t, onPick, picked }) {
  const zones = ordered(tiers);
  const tall = heights(zones, { min: 48, max: 110 });
  const wide = widths(zones, { base: 56, span: 42, nudge: 3 });
  return (
    <div className="grid gap-2">
      {zones.map((tier, i) => (
        <Zone
          key={tier.id}
          tier={tier}
          locale={locale}
          t={t} onPick={onPick} picked={picked === tier.id}
          fill={FILLS[i % FILLS.length]}
          className="mx-auto rounded-[40%_60%_55%_45%/55%_45%_60%_40%]"
          style={{ height: `${tall[i]}px`, width: `${wide[i]}%` }}
        />
      ))}
    </div>
  );
}

const PLANS = {
  STAGE: StagePlan,
  HALL: HallPlan,
  STADIUM: StadiumPlan,
  COURSE: CoursePlan,
  EXPO: ExpoPlan,
  OPEN_AIR: OpenAirPlan,
};

export function VenuePlan({ event, onPick, picked }) {
  const { locale, t } = useI18n();
  const all = event.tiers ?? [];

  /*
   * Only tiers that are PLACES get drawn.
   *
   * "Pass journée" and "Pass 3 jours" admit you to the same ground on
   * different days; "Semi-marathon" and "Marathon 42 km" are distances;
   * "Badge visiteur" is a credential. Drawing those as stacked zones told a
   * buyer the three-day pass stands nearer the stage than the day pass,
   * which is invented geography — and it was wrong on six of sixteen events.
   *
   * They are not hidden: they are listed under the plan as admission types,
   * which is what they actually are.
   */
  const tiers = all.filter((tier) => tier.spatial !== false);
  const other = all.filter((tier) => tier.spatial === false);

  // Nothing honest to draw with no places. The admission list still has
  // something to say, so the section is not empty.
  if (tiers.length === 0 && other.length === 0) return null;

  const Plan = PLANS[event.venueKind] ?? StagePlan;
  const legend = ordered(tiers);

  return (
    <>
      {tiers.length > 0 ? (
        <div className="mx-auto mt-5 max-w-lg rounded-card bg-paper p-5">
          <Plan tiers={tiers} locale={locale} t={t} onPick={onPick} picked={picked} />

          {/*
            The rest of the ground.

            Mawazine's VIP wedge holds 4 000 of 62 000, so a plan showing
            only the drawn zones showed 6% of the audience and boxed the
            other 58 000 away in a list underneath. These tickets are not
            somewhere else — they are the whole site, which is exactly what
            a band under the named zones says. Still not a zone: no colour
            of its own, no click, dashed like the pitch, because it is
            ground rather than a seat you choose.
          */}
          {other.length > 0 ? (
            <div className="mt-2 flex min-h-11 items-center justify-center rounded-card border-2 border-dashed border-line/30 px-3 text-center text-xs font-bold uppercase tracking-wide text-muted">
              {t("planGeneralGround")} · {groupNumber(other.reduce((sum, tier) => sum + tier.capacity, 0))}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* The legend carries capacity, which the blocks cannot: a zone's
          drawn size is its position in the room, not how many fit in it. */}
      <div className="mt-4 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs font-semibold text-muted">
        {legend.map((tier, i) => (
          <span key={tier.id} className={cn("inline-flex items-center gap-1.5", isGone(tier) && "opacity-55")}>
            <span className={cn("size-2.5 rounded-full", DOTS[i % DOTS.length], isGone(tier) && "saturate-0")} aria-hidden />
            <span className={cn(isGone(tier) && "line-through")}>{eventText(tier, "name", locale)}</span>
            <span className="font-normal tabular-nums">
              · {isGone(tier) ? t("soldOut") : groupNumber(tier.capacity)}
            </span>
          </span>
        ))}
      </div>

      {/* Tiers that are not places. Said plainly rather than drawn, because
          a picture of them would be a picture of something that does not
          exist. */}
      {other.length > 0 ? (
        <div className="mx-auto mt-4 max-w-lg rounded-control border border-line/15 bg-paper p-3.5">
          <p className="text-xs font-bold uppercase tracking-wide text-muted">{t("planAdmissions")}</p>
          <ul className="mt-2 grid gap-1.5">
            {other.map((tier) => (
              <li key={tier.id} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 font-semibold">{eventText(tier, "name", locale)}</span>
                <span className="shrink-0 tabular-nums text-muted">{groupNumber(tier.capacity)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs leading-relaxed text-muted">{t("planAdmissionsNote")}</p>
        </div>
      ) : null}

      <p className="mt-3 text-center text-xs text-muted">
        {t("capacity")} · {groupNumber(all.reduce((sum, tier) => sum + tier.capacity, 0))}
      </p>
    </>
  );
}
