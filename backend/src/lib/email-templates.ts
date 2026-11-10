/**
 * Transactional email bodies, in the charte's colours. Inline styles only —
 * mail clients strip <style> blocks and have no CSS variables.
 */

const LAGON = "#0B7A75";
const SAFRAN = "#FFB400";
const ENCRE = "#14172F";
const MUTED = "#3E4948";
const PAPER = "#F4F6FA";

export type Locale = "fr" | "ar";

function money(cents: number): string {
  return new Intl.NumberFormat("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
}

function shell(locale: Locale, body: string): string {
  const dir = locale === "ar" ? "rtl" : "ltr";
  return `<!doctype html><html dir="${dir}"><body style="margin:0;padding:24px;background:${PAPER};font-family:'Helvetica Neue',Arial,sans-serif;color:${ENCRE};">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;">
    <div style="padding:20px 24px;border-bottom:1px solid #e8ecf5;">
      <span style="font-size:20px;font-weight:800;color:${ENCRE};">eventick<span style="color:${SAFRAN};">.ma</span></span>
    </div>
    <div style="padding:24px;">${body}</div>
    <div style="padding:16px 24px;background:${PAPER};font-size:12px;color:${MUTED};">
      ${locale === "ar" ? "منصة تذاكر — الأسعار بالدرهم المغربي." : "Billetterie Eventick — prix en MAD."}
    </div>
  </div>
</body></html>`;
}

export interface OrderEmailTicket {
  ref: string;
  tierName: string;
  holderName: string;
  priceCents: number;
}

export interface OrderEmailInput {
  locale: Locale;
  holderName: string;
  eventTitle: string;
  eventCity: string;
  eventStart: Date;
  orderId: string;
  totalCents: number;
  tickets: OrderEmailTicket[];
  /*
   * The order's access token, so the email can carry a link that works.
   *
   * This matters most for an account created AT checkout: it has no
   * password yet, so this link is how the buyer reaches their tickets until
   * they set one. Optional, because a confirmation for an order whose token
   * is unknown is still worth sending — it simply has no button.
   */
  accessToken?: string | null;
}

/** Where this deployment lives, for links inside an email. */
function siteUrl(): string {
  return process.env.SITE_URL?.replace(/\/+$/, "") || "https://eventick.ma";
}

export function orderConfirmationSubject(input: OrderEmailInput): string {
  return input.locale === "ar" ? `تذاكرك — ${input.eventTitle}` : `Vos billets — ${input.eventTitle}`;
}

export function orderConfirmationHtml(input: OrderEmailInput): string {
  const { locale } = input;
  const ar = locale === "ar";
  const date = new Intl.DateTimeFormat(ar ? "ar-MA" : "fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(input.eventStart);

  const rows = input.tickets
    .map(
      (ticket) => `<tr>
        <td style="padding:10px 0;border-bottom:1px solid #e8ecf5;">
          <div style="font-weight:700;">${escapeHtml(ticket.tierName)}</div>
          <div style="font-size:12px;color:${MUTED};">${escapeHtml(ticket.holderName)}</div>
          <div style="font-family:monospace;font-size:12px;color:${LAGON};">${escapeHtml(ticket.ref)}</div>
        </td>
        <td style="padding:10px 0;border-bottom:1px solid #e8ecf5;text-align:${ar ? "left" : "right"};font-weight:700;white-space:nowrap;">
          ${money(ticket.priceCents)} MAD
        </td>
      </tr>`,
    )
    .join("");

  return shell(
    locale,
    `<h1 style="margin:0 0 8px;font-size:22px;">${ar ? "تم تأكيد الأداء" : "Paiement confirmé"}</h1>
     <p style="margin:0 0 20px;color:${MUTED};font-size:14px;">
       ${ar ? `مرحباً ${escapeHtml(input.holderName)}، تذاكرك جاهزة ومرفقة بصيغة PDF.` : `Bonjour ${escapeHtml(input.holderName)}, vos billets sont prêts et joints en PDF.`}
     </p>
     <div style="padding:16px;background:${PAPER};border-radius:10px;margin-bottom:20px;">
       <div style="font-size:18px;font-weight:800;">${escapeHtml(input.eventTitle)}</div>
       <div style="color:${MUTED};font-size:14px;">${escapeHtml(input.eventCity)} · ${date}</div>
     </div>
     <table style="width:100%;border-collapse:collapse;">${rows}</table>
     <table style="width:100%;margin-top:12px;">
       <tr>
         <td style="font-weight:800;font-size:16px;">${ar ? "المجموع" : "Total"}</td>
         <td style="text-align:${ar ? "left" : "right"};font-weight:800;font-size:16px;">${money(input.totalCents)} MAD</td>
       </tr>
     </table>
     ${
       /*
        * The way back to these tickets, for someone with no password.
        *
        * An account created at checkout cannot be signed into yet, so this
        * link IS their access: it carries the order's own token, which is
        * what authorises reading it. Omitted when no token was passed
        * rather than rendering a button that leads to a sign-in wall.
        */
       input.accessToken
         ? `<p style="margin:20px 0 0;">
              <a href="${siteUrl()}/confirmation/${encodeURIComponent(input.orderId)}?k=${encodeURIComponent(input.accessToken)}"
                 style="display:inline-block;padding:12px 20px;background:${LAGON};color:#ffffff;border-radius:999px;font-weight:700;text-decoration:none;">
                ${ar ? "عرض تذاكري" : "Voir mes billets"}
              </a>
            </p>`
         : ""
     }
     <p style="margin:20px 0 0;font-size:12px;color:${MUTED};">
       ${ar ? "أظهر رمز QR عند الدخول." : "Présentez le QR code à l'entrée."}
       ${ar ? "رقم الطلب" : "Commande"} <span style="font-family:monospace;">${escapeHtml(input.orderId)}</span>
     </p>`,
  );
}

export interface BroadcastInput {
  locale: Locale;
  eventTitle: string;
  subject: string;
  message: string;
}

export function broadcastHtml(input: BroadcastInput): string {
  const ar = input.locale === "ar";
  return shell(
    input.locale,
    `<div style="font-size:12px;color:${MUTED};margin-bottom:6px;">
       ${ar ? "رسالة من منظم" : "Message de l'organisateur"} · ${escapeHtml(input.eventTitle)}
     </div>
     <h1 style="margin:0 0 16px;font-size:20px;">${escapeHtml(input.subject)}</h1>
     <div style="font-size:14px;line-height:1.6;white-space:pre-wrap;">${escapeHtml(input.message)}</div>`,
  );
}

export interface RefundInput {
  locale: Locale;
  holderName: string;
  eventTitle: string;
  amountCents: number;
  orderId: string;
}

/*
 * Two refund emails, not one, because there are two different moments and
 * only the second one is true.
 *
 * CMI has no refund API: refundOrder() records the decision and voids the
 * tickets, but the money is reversed by hand in the CMI back office,
 * possibly days later and possibly not at all if nobody actions the
 * pending-refunds queue. The single email this replaces fired at the
 * decision and said "recrédité sur votre carte" — telling someone their
 * money had arrived when nothing had moved. A seller who then checked
 * their bank found nothing, and the only way to learn the truth was to
 * email support.
 *
 * So: `refundInitiated*` at the decision, `refundSent*` when an admin
 * marks it paid with a bank reference. The reference is in the second one
 * because it is what the recipient quotes back if the money never lands.
 */
export function refundSubject(input: RefundInput): string {
  return input.locale === "ar"
    ? `جاري الاسترجاع — ${input.eventTitle}`
    : `Remboursement en cours — ${input.eventTitle}`;
}

export function refundHtml(input: RefundInput): string {
  const ar = input.locale === "ar";
  return shell(
    input.locale,
    `<h1 style="margin:0 0 8px;font-size:22px;">${ar ? "جاري الاسترجاع" : "Remboursement en cours"}</h1>
     <p style="margin:0 0 20px;color:${MUTED};font-size:14px;">
       ${ar ? `مرحباً ${escapeHtml(input.holderName)}،` : `Bonjour ${escapeHtml(input.holderName)},`}
       ${
         ar
           ? "سجّلنا استرجاع المبلغ التالي. سنرسل لك تأكيداً آخر بمجرد تحويله فعلياً:"
           : "nous avons enregistré le remboursement du montant suivant. Vous recevrez une seconde confirmation dès qu'il aura été envoyé :"
       }
     </p>
     <div style="padding:16px;background:${PAPER};border-radius:10px;text-align:center;">
       <div style="font-size:26px;font-weight:800;color:${LAGON};">${money(input.amountCents)} MAD</div>
       <div style="color:${MUTED};font-size:14px;margin-top:4px;">${escapeHtml(input.eventTitle)}</div>
     </div>
     <p style="margin:20px 0 0;font-size:12px;color:${MUTED};">
       ${
         ar
           ? "يمكنك متابعة الحالة في صفحة تذاكرك."
           : "Vous pouvez suivre l'état du remboursement depuis vos billets."
       }
       ${ar ? "رقم الطلب" : "Commande"} <span style="font-family:monospace;">${escapeHtml(input.orderId)}</span>
     </p>`,
  );
}

export interface RefundSentInput extends RefundInput {
  /** The CMI or bank reference for the reversal, so the recipient can chase it. */
  reference: string;
}

export function refundSentSubject(input: RefundSentInput): string {
  return input.locale === "ar"
    ? `تم إرسال الاسترجاع — ${input.eventTitle}`
    : `Remboursement envoyé — ${input.eventTitle}`;
}

export function refundSentHtml(input: RefundSentInput): string {
  const ar = input.locale === "ar";
  return shell(
    input.locale,
    `<h1 style="margin:0 0 8px;font-size:22px;">${ar ? "تم إرسال الاسترجاع" : "Remboursement envoyé"}</h1>
     <p style="margin:0 0 20px;color:${MUTED};font-size:14px;">
       ${ar ? `مرحباً ${escapeHtml(input.holderName)}،` : `Bonjour ${escapeHtml(input.holderName)},`}
       ${ar ? "تم تحويل المبلغ التالي:" : "le montant suivant vous a été envoyé :"}
     </p>
     <div style="padding:16px;background:${PAPER};border-radius:10px;text-align:center;">
       <div style="font-size:26px;font-weight:800;color:${LAGON};">${money(input.amountCents)} MAD</div>
       <div style="color:${MUTED};font-size:14px;margin-top:4px;">${escapeHtml(input.eventTitle)}</div>
     </div>
     <p style="margin:20px 0 0;font-size:12px;color:${MUTED};">
       ${ar ? "قد يستغرق ظهور المبلغ بضعة أيام." : "Le délai d'apparition dépend de votre banque (quelques jours)."}
       ${ar ? "مرجع التحويل" : "Référence"} <span style="font-family:monospace;">${escapeHtml(input.reference)}</span>
       · ${ar ? "رقم الطلب" : "Commande"} <span style="font-family:monospace;">${escapeHtml(input.orderId)}</span>
     </p>`,
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export interface WaitlistOfferInput {
  locale: Locale;
  eventTitle: string;
  tierName: string;
  minutes: number;
  claimUrl: string;
}

export function waitlistOfferSubject(input: WaitlistOfferInput): string {
  return input.locale === "ar"
    ? `مقعد متاح — ${input.eventTitle}`
    : `Une place s'est libérée — ${input.eventTitle}`;
}

export function waitlistOfferHtml(input: WaitlistOfferInput): string {
  const ar = input.locale === "ar";
  return shell(
    input.locale,
    `<h1 style="margin:0 0 8px;font-size:22px;">${ar ? "مقعد محجوز لك" : "Une place vous est réservée"}</h1>
     <p style="margin:0 0 20px;color:${MUTED};font-size:14px;">
       ${ar
         ? `تحرّر مقعد في <strong>${escapeHtml(input.eventTitle)}</strong> (${escapeHtml(input.tierName)}). إنه محجوز لك وحدك لمدة ${input.minutes} دقيقة.`
         : `Une place s'est libérée pour <strong>${escapeHtml(input.eventTitle)}</strong> (${escapeHtml(input.tierName)}). Elle vous est réservée pendant ${input.minutes} minutes.`}
     </p>
     <p style="text-align:center;margin:0 0 20px;">
       <a href="${escapeHtml(input.claimUrl)}"
          style="display:inline-block;padding:14px 28px;background:${SAFRAN};color:${ENCRE};border-radius:999px;font-weight:800;text-decoration:none;">
         ${ar ? "احجز مقعدي" : "Réserver ma place"}
       </a>
     </p>
     <p style="margin:0;font-size:12px;color:${MUTED};">
       ${ar
         ? "بعد انقضاء المهلة يُعرض المقعد على الشخص التالي في القائمة."
         : "Passé ce délai, la place est proposée à la personne suivante sur la liste."}
     </p>`,
  );
}
