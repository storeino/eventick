/**
 * What a zone's `planOrder` MEANS, per venue kind.
 *
 * The field was a bare number with the hint "0 = nearest the stage". That
 * is true for a stage and a hall, and wrong everywhere else: in a stadium
 * 1 and 2 are the LEFT and RIGHT sides, not "second and third row back",
 * and a stadium has no stage at all. The same integer meant something
 * different in six arrangements and the form said so in none of them, so
 * filling it in was guesswork confirmed only by looking at the preview.
 *
 * The stored value is still an integer — this is a vocabulary for choosing
 * one, not a new column. Which keeps the ordering logic in VenuePlan
 * unchanged: it sorts by planOrder and falls back to price.
 *
 * Shared between the picker and the zone card so a slot cannot be named
 * one thing in the dropdown and another on the card.
 */

/*
 * Only STADIUM maps positions to named PLACES — its plan renders
 * [near, side1, side2, ...far] into fixed geometry. The other five stack in
 * order, so their slots describe depth rather than compass points, and
 * saying "left" there would invent a side the drawing does not have.
 */
const SLOTS = {
  STADIUM: [
    { value: 0, key: "slotMainStand" },
    { value: 1, key: "slotLeftSide" },
    { value: 2, key: "slotRightSide" },
    { value: 3, key: "slotOpposite" },
  ],
  STAGE: [
    { value: 0, key: "slotFront" },
    { value: 1, key: "slotMiddle" },
    { value: 2, key: "slotBack" },
  ],
  HALL: [
    { value: 0, key: "slotFrontRows" },
    { value: 1, key: "slotMidRows" },
    { value: 2, key: "slotRearRows" },
  ],
  COURSE: [
    { value: 0, key: "slotFirstWave" },
    { value: 1, key: "slotSecondWave" },
    { value: 2, key: "slotThirdWave" },
  ],
  EXPO: [
    { value: 0, key: "slotNearEntrance" },
    { value: 1, key: "slotMidFloor" },
    { value: 2, key: "slotFarFloor" },
  ],
  OPEN_AIR: [
    { value: 0, key: "slotNearest" },
    { value: 1, key: "slotMiddleGround" },
    { value: 2, key: "slotFurthest" },
  ],
};

/** The named slots for a venue kind, falling back to the stage vocabulary. */
export function slotsFor(venueKind) {
  return SLOTS[venueKind] ?? SLOTS.STAGE;
}

/**
 * What to call a position that has one.
 *
 * Returns null when there is no name for it — an empty value (order me by
 * price) or a number past the named slots. A stadium with six zones really
 * does stack the extras, and inventing "fifth side" for them would describe
 * a drawing that does not exist.
 */
export function slotLabel(venueKind, planOrder, t) {
  if (typeof planOrder !== "number") return null;
  const slot = slotsFor(venueKind).find((s) => s.value === planOrder);
  return slot ? t[slot.key] : null;
}
