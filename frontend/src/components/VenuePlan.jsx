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
  return (
    <>
      <div
        className="mx-auto flex h-10 w-[55%] items-center justify-center rounded-t-[999px] bg-ink text-xs font-bold uppercase tracking-wide text-paper"
        style={{ clipPath: "ellipse(50% 100% at 50% 100%)" }}
      >
        {t("stage")}
      </div>
      {zones.map((tier, i) => {
        // Each zone is wider than the one in front of it, which is what makes
        // the drawing read as depth rather than a stack of bars.
        const width = Math.min(100, 62 + i * (zones.length > 3 ? 10 : 15));
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
              height: `${Math.max(44, 44 + i * 10)}px`,
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
            style={{ height: `${Math.max(44, 40 + i * 8)}px` }}
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
  const [first, ...rest] = zones;
  return (
    <div className="grid gap-1.5">
      {first ? (
        <Zone tier={first} locale={locale} t={t} onPick={onPick} picked={picked === first.id} fill={FILLS[0]} className="rounded-t-card" style={{ height: "44px" }} />
      ) : null}
      <div className="flex items-stretch gap-1.5">
        {rest[0] ? (
          <Zone tier={rest[0]} locale={locale} t={t} onPick={onPick} picked={picked === rest[0].id} fill={FILLS[1]} className="w-[22%] rounded-s-card [writing-mode:vertical-rl] rotate-180" />
        ) : null}
        <div className="flex flex-1 items-center justify-center rounded-card border-2 border-dashed border-line/30 bg-paper py-10 text-xs font-bold uppercase tracking-wide text-muted">
          {t("venuePitch")}
        </div>
        {rest[1] ? (
          <Zone tier={rest[1]} locale={locale} t={t} onPick={onPick} picked={picked === rest[1].id} fill={FILLS[2]} className="w-[22%] rounded-e-card [writing-mode:vertical-rl]" />
        ) : null}
      </div>
      {rest.slice(2).map((tier, i) => (
        <Zone key={tier.id} tier={tier} locale={locale} t={t} onPick={onPick} picked={picked === tier.id} fill={FILLS[(i + 3) % FILLS.length]} className="rounded-b-card" style={{ height: "44px" }} />
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
            style={{ height: "44px", width: `${Math.min(100, 55 + i * 15)}%` }}
          />
        ))}
      </div>
    </div>
  );
}

/** EXPO — halls walked through, so equal blocks on a floor rather than a bowl. */
function ExpoPlan({ tiers, locale, t, onPick, picked }) {
  const zones = ordered(tiers);
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
            style={{ height: "64px" }}
          />
        ))}
      </div>
    </>
  );
}

/** OPEN_AIR — open ground, no fixed front: soft blobs rather than a bowl. */
function OpenAirPlan({ tiers, locale, t, onPick, picked }) {
  const zones = ordered(tiers);
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
          style={{ height: "60px", width: `${Math.min(100, 70 + i * 12)}%` }}
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
