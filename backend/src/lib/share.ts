import { randomBytes } from "node:crypto";
import { prisma } from "./prisma.js";
import { HttpError } from "./http.js";
import { makeTicketRef } from "../domain/ticketRef.js";

/**
 * Sharing — give your ticket to someone else, free.
 *
 * Mechanically this is resale minus the payment: the recipient opens a link,
 * enters their name, and gets a NEW ticket with a fresh QR while the sender's
 * is voided. No seat is created or released, so inventory is untouched.
 *
 * The claim step is the point. Simply emailing a PDF means one typo sends the
 * ticket to a stranger with no way back, and the sender's QR keeps working, so
 * two people arrive holding the same seat. Here nothing changes until someone
 * claims, and until then the sender can revoke.
 *
 * This replaces the old /tickets/:id/transfer, which marked the ticket
 * TRANSFERRED — a status the gate refuses — and never issued a replacement,
 * so transferring destroyed the ticket and gave the recipient nothing.
 */

/** A share link lives until claimed, revoked, or the event starts. There is
 * no fixed expiry: an unclaimed link going dead would strand a ticket whose
 * owner has already moved on. */
function stillOfferable(share: { status: string }, startAt: Date): boolean {
  return share.status === "OPEN" && startAt.getTime() > Date.now();
}

export async function shareTicket(ticketId: string, senderId: string | null, message?: string) {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: { order: { include: { event: true } }, resale: true, shares: true },
  });
  if (!ticket) throw new HttpError(404, "Ticket not found");
  if (ticket.status !== "VALID") throw new HttpError(409, "Only a valid ticket can be shared");
  if (ticket.order.event.startAt.getTime() < Date.now()) {
    throw new HttpError(409, "This event has already started");
  }
  // A ticket can be on sale or being given away, not both — otherwise a buyer
  // could pay for a seat that was handed to someone else a second earlier.
  if (ticket.resale?.status === "LISTED") {
    throw new HttpError(409, "This ticket is listed for resale — cancel the listing first");
  }

  const open = ticket.shares.find((share) => share.status === "OPEN");
  if (open) throw new HttpError(409, "This ticket already has an open share link");

  return prisma.ticketShare.create({
    data: {
      ticketId,
      senderId,
      message: message?.trim() || null,
      token: randomBytes(24).toString("base64url"),
    },
  });
}

/** Withdraw an unclaimed share. Guarded so it cannot race a claim in flight. */
export async function revokeShare(shareId: string): Promise<void> {
  const claimed = await prisma.ticketShare.updateMany({
    where: { id: shareId, status: "OPEN" },
    data: { status: "REVOKED", revokedAt: new Date(), token: null },
  });
  if (claimed.count === 0) throw new HttpError(409, "This share link is no longer open");
}

/** A share a recipient can still claim, or null. */
export async function resolveShare(token: string) {
  const share = await prisma.ticketShare.findUnique({
    where: { token },
    include: { ticket: { include: { tier: true, order: { include: { event: true } } } }, sender: true },
  });
  if (!share) return null;
  if (!stillOfferable(share, share.ticket.order.event.startAt)) return null;
  // The ticket may have been used, cancelled or resold since the link was made.
  if (share.ticket.status !== "VALID") return null;
  return share;
}

/**
 * Claim a shared ticket: void the sender's, issue the recipient's.
 *
 * The share row is claimed with a guarded update BEFORE anything else, so two
 * people opening the same link at once cannot both win — the loser is told it
 * has gone rather than receiving a ticket that duplicates a seat.
 */
export async function claimShare(
  token: string,
  holderName: string,
  claimantId: string | null,
): Promise<{ ticketId: string; ref: string }> {
  const share = await resolveShare(token);
  if (!share) throw new HttpError(410, "This share link is no longer valid");

  // Clearing the token in the same statement makes the link single-use even
  // if two requests resolved it simultaneously a moment ago.
  const won = await prisma.ticketShare.updateMany({
    where: { id: share.id, status: "OPEN" },
    data: {
      status: "CLAIMED",
      claimedAt: new Date(),
      claimedName: holderName.trim(),
      token: null,
    },
  });
  if (won.count === 0) throw new HttpError(410, "This ticket has already been claimed");

  return prisma.$transaction(async (tx) => {
    // The sender's QR stops admitting the moment the recipient's exists.
    await tx.ticket.update({ where: { id: share.ticketId }, data: { status: "TRANSFERRED" } });

    // The replacement hangs off the SAME order: no money moved, so there is
    // no new order to attach it to, and the seat stays counted exactly once.
    // `replacesRef` is the audit trail from the old QR to the new one.
    const replacement = await tx.ticket.create({
      data: {
        ref: makeTicketRef(share.ticket.order.event.startAt.getFullYear()),
        orderId: share.ticket.orderId,
        tierId: share.ticket.tierId,
        holderName: holderName.trim(),
        seatRow: share.ticket.seatRow,
        seatNumber: share.ticket.seatNumber,
        replacesRef: share.ticket.ref,
        /*
         * Who actually holds it now.
         *
         * `claimantId` was accepted by this function and then dropped on the
         * floor, so nothing recorded that the ticket had changed hands. The
         * replacement sits on the sender's order — deliberately, since no
         * money moved — and "my tickets" lists every ticket on your orders,
         * so the sender kept seeing a live ticket they had given away.
         *
         * Null for a guest claim: there is no account to point at, and they
         * reach the ticket through its own accessToken instead.
         */
        holderId: claimantId,
        /*
         * True even when claimantId is null.
         *
         * A guest claim has no account to point at, so holderId stays null —
         * which is also what an ordinary unclaimed ticket looks like. Without
         * this flag the sender's list could not tell the two apart and went
         * on showing a ticket a guest had already claimed.
         */
        gifted: true,
      },
    });

    await tx.ticketShare.update({
      where: { id: share.id },
      data: { newTicketId: replacement.id },
    });

    return { ticketId: replacement.id, ref: replacement.ref };
  });
}
