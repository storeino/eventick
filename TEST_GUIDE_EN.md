# 🎟️ Eventick — hands-on test guide

**Twenty-six checks. Do them in any order.** Every step says exactly where to click and what you must see.

Checks **1–12** cover the buying, ticketing and admin surface. Checks **13–15**
cover the money side — commission, payouts and the audit journal. Checks
**16–19** cover what an organiser needs in the first week of running a real
event: a cap on how many one person may buy, sales windows, calling an event
off, and free tickets that are not a sale. Checks **20–22** cover who an
account is *for* (staff sell, customers buy), the detail pages a support call
needs, and the live image and email services. Checks **23–26** are the money and inventory work added
since: figures for a period rather than for all time, what a plan costs and
how an organiser asks for a different one, who is owed what, and where a
freed seat goes.

> 📅 30/10/2026 · Written by walking the running app at **http://localhost:3100**. The interface ships in **French**; every label in quotes below is the text actually on screen. Switch to English from the account menu if you prefer — the checks work the same.

> 🤖 **Checks 1–19 run automatically.** Walking them by hand takes about
> forty-five minutes, which meant nobody did it often enough to catch a
> regression. `npm run test:live:checks` (from `backend/`, in mock payment
> mode) asserts the same things through the same API the browser uses — 116
> assertions, self-cleaning. Run it before you start: if it is red, fix that
> first, because the manual pass will only find the same thing more slowly.
> It does **not** replace the manual pass — a human still has to look at the
> screens, which is what checks 11 and 12 are entirely about.
>
> ⚠️ **Checks 20–26 are manual only.** They were added after that suite.
> 22 can never have it (it talks to Bunny and Resend, and a suite that sends
> real email on every run is worse than no suite); the rest could. Parts of
> 23–26 are covered from underneath instead — `npm test` has 24 unit tests
> on the period windows, and `npm run test:live:money` checks the period
> figures, the plan arithmetic and the owed-versus-paid agreement. Nothing
> automated opens the screens, so treat these as the part most likely to
> regress unnoticed.

---

## 🚀 Before you start (5 minutes)

### 1. Start the app

```bash
# Terminal 1
cd backend
npm run dev

# Terminal 2
cd frontend
npm run dev
```

Open **http://localhost:3100**.

### 2. Check the API is alive

```bash
curl --url 'http://localhost:4100/api/events'
```

**✔️ You must see** a reply starting `{"events":[…`. If you get a connection error, the backend is down. If you see `{"events":[]}`, the database is not seeded — see *Start clean* below.

### 3. The three accounts

| Role | Email | Password |
|---|---|---|
| **Admin** | `admin@eventick.ma` | `eventick-admin-2026` |
| **Organiser** | `organisateur@eventick.ma` | `eventick-orga-2026` |
| **Customer** | `client@eventick.ma` | `eventick-client-2026` |

> ⚠️ **Only 10 sign-ins per 15 minutes**, for the whole machine. If you see *"Trop de tentatives"*, wait — or restart the backend, which resets the counter. **Tip:** use a different browser profile (or a private window) per role so you are not signing in and out constantly.

### 4. Paying

Payments run in **mock** mode — **no card is ever charged**. Checkout settles instantly and issues real tickets.

> **Switching on the real gateway (CMI).** Put `CMI_CLIENT_ID` and `CMI_STORE_KEY` in `backend/.env` and restart. Checkout then shows a *"Payer … sur CMI"* button that posts a signed form to CMI's own card page instead of settling on the spot.
>
> Two things to know before trying it:
>
> - The **store key is not emailed to you.** You set it yourself in the CMI back office under *Administration → Changer les clés du magasin*, and `CMI_STORE_KEY` must match it exactly — otherwise CMI refuses every payment with `INVALID_HASH`.
> - **CMI calls back from its own servers**, so it cannot reach `localhost`. Without a public callback URL the payment succeeds at CMI and **no ticket is ever issued**. Expose the API with a tunnel (ngrok, cloudflared) and set `CMI_CALLBACK_URL` to the public address.
>
> Test cards come with the CMI integration kit; they are not reproduced here.
>
> **The slow-buyer cases.** These are worth testing deliberately, because they
> cannot happen with an in-page card form and they are where money and tickets
> can come apart. The rule the server enforces is: *the buyer is charged only
> if they end up holding something.* `ACTION=POSTAUTH` is the reply that takes
> the money, so it is sent if and only if a ticket exists.
>
> | What you do | What should happen |
> |---|---|
> | Sit on CMI's page for over 15 minutes, then pay | Payment **refused**, nothing charged. The hold lapsed and the seats went back on sale. |
> | Pay, then let CMI retry the callback (or replay it) | Money accepted again, but **no second ticket** — the order already delivered. |
> | Hold the last seat, let the hold lapse, have someone else buy it, then pay | Payment **refused**. The tier is never oversold. |
> | Start buying a resold ticket, have the seller cancel the listing, then pay | Payment **refused**, the seller keeps their seat. |
>
> `npm run test:live:cmi` (from `backend/`, with CMI configured) checks all
> four automatically.

### 5. Commission and payouts

Money reaches Eventick's CMI account, not the organiser's, so the organiser's
share is transferred separately. Three screens are involved:

| Where | Who | What |
|---|---|---|
| **Admin → Plateforme** | admin | Assign each organiser a plan (Starter 5%, Pro 3% + 499/mo, Business 2% + 1 999/mo), and run payouts |
| | | The monthly part is withheld from the payout, once per calendar month that had sales |
| **Pro → Finance** | organiser | See net revenue, commission, what is owed — and enter their RIB |
| **Pro → Finance** | organiser | Their own payout history |

Worth testing deliberately, because each one protects money:

| What you do | What should happen |
|---|---|
| As the organiser, try to change your own plan | Not possible — the plan is read-only on Finance, and the API answers 403 |
| Sell a ticket, then have an admin move you to a cheaper plan | The commission already recorded **does not change**. Only later sales use the new rate |
| Refund half an order | Net revenue *and* commission both halve |
| Run a payout before entering a RIB | Refused — there is nowhere to send it |
| Run the same period twice | The second run finds nothing: an order belongs to one payout, ever |
| Mark a payout paid without a reference | Refused — the row could not be reconciled against a statement |
| Refund something *after* its payout was marked paid | The payout's total does not move; it is a record of money already sent |
| Resell a ticket | The platform takes its commission on the resale too, and the seller's ticket reads **transferred**, not refunded |
| Run a payout twice over one month | The subscription is charged **once**; only new orders add commission |
| Run a payout over a very wide period | Only months that actually had sales are charged a subscription — a dormant month is free |
| Cancel a pending payout | Its orders *and* its subscription months are released for a later run |

`npm run test:live:orders` (from `backend/`) walks the whole path — hold, pay,
settle, refund, resell, commission, subscription, payout — in 75 checks.
`npm run test:live:money` covers the commission and payout rules on their own.

### 6. The journal, and removing an account

**Admin → Journal** lists who did what. It is gated on `scope.any`, the same
as the rest of the platform console, because the rows describe money and
accounts across every organiser.

| What you do | What should happen |
|---|---|
| Change someone's role, grant a permission, refund an order, assign a plan, send a payout | Each appears in the Journal with your email, what changed (both ends) and when |
| Filter by action | Only that action's rows |
| Open the Journal as the organiser | Refused — it is admin-only |
| **Équipe →** remove a brand-new account | Deleted outright; the Journal still shows it existed and who removed it |
| Remove an account that has orders | **Anonymised**, not deleted — the dialog says so *before* you confirm. Orders and tickets survive; the old login stops working |
| Try to remove yourself, or another admin | Refused. One compromised admin cannot clear out the others |

`npm run test:live:audit` (from `backend/`) checks all of this in 46 checks,
including the one that matters most: a record survives the deletion of the
person who made it.

---

### 7. Start clean (when you need to)

The seed is **idempotent** — running it again does not duplicate anything, so
it is safe whenever the catalogue looks wrong:

```bash
cd backend
npm run db:deploy    # apply any migrations you do not have yet
npm run db:seed      # 16 events, 2 promo codes, the three accounts above
```

**✔️ You must see** `Seeded 16 events and 2 promo codes.`

The baseline is **16 events** (14 owned by the admin, 2 by the organiser),
**3 accounts** and the orders the seed creates. If you have been running the
automated suites, extra test accounts and events may be left behind; they are
harmless, but `npm run db:seed` will not remove them.

> 💡 `npm run db:studio` opens Prisma Studio if you want to look at the rows
> directly — useful for checking a commission or a payout by hand.

---

### 8. What the journal does and does not record

The journal answers *"who did this, and can they account for it?"* — so it
records money, permissions, account removals, and **overrides**. It
deliberately does not record ordinary editing: a log of every blurb change is
one nobody reads.

| Recorded | Not recorded |
|---|---|
| Refunds, payouts, bank-account changes | Creating or editing an event listing |
| Role and permission changes | Changing an event's visibility |
| Account deletion and anonymisation | Renaming a zone |
| Event cancellation, comps issued and revoked | Deleting an empty zone |
| **Re-admitting a spent ticket** (door or desk) | |
| **Changing a zone's price or capacity**, with how many had already sold | |
| **Cancelling or deleting an order**, with the amount | |
| **Assigning an event to an organiser**, and transferring it later | |

> 🎯 The four in bold were missing, and the omission was not a decision:
> there was no action name to record them under, so the most disputable things
> an organiser can do were the ones with no trail. A price change on a zone
> that had already sold returned a bare `200` with nothing written down.

> 💡 There is deliberately **no** `event.rescheduled`. An event's dates are
> fixed at creation — no route accepts a new one — so the action would
> describe something that cannot happen. If postponement is ever added, the
> journal entry goes in with it.

## 🧭 Where things are

**Public site** — Explorer · event pages · checkout · your tickets
**Dashboard** (`/pro`) — the sidebar is grouped under small grey headings. Paths below are written as **group → item → button**.

| Group | Items | Who sees it |
|---|---|---|
| **PILOTAGE** | Pilotage · Réservations | organiser + admin |
| **CATALOGUE** | Événements · Placements · Invitations · Offres | organiser + admin |
| **OPÉRATIONS** | Porte | organiser + admin |
| **FINANCES** | Finance | organiser + admin |
| **ADMINISTRATION** | Plateforme · Équipe · Permissions · Journal | **admin only** |

**Account menu** (top right, both areas) — **"Mon compte"** · theme · language · sign out. For staff that page is identity and profile only; for a customer it also holds their tickets, history and saved events. *(Check 20.)*

> 💡 The group headings are labels, not buttons — click the item under them.
> 💡 **The sidebar is permission-driven.** An item you cannot use does not appear at all. That is check 9.

### What already exists

**16 events** across Casablanca, Rabat, Marrakech, Tanger, Agadir, Essaouira, Fès and Dakhla — **all owned by the organiser account**. (They used to be admin-owned, which modelled defect #26 as if it were the design: `organiserId` is what decides who the payout pays.)
**Promo codes:** `SAFRAN15` (−15 %) and `CASA50` (−50 MAD)
**Commission plans:** Starter 5 % · Pro 3 % + 499 MAD/month · Business 2 % + 1 999 MAD/month — Starter is the default
**Rules:** seats are held **15 minutes** · tickets are **final sale** (resale is the exit, not a refund) · one buyer may hold **10 tickets** per event · resale is **off** until the organiser turns it on

> 💡 The last two are per-event defaults an organiser can change — Pro →
> **Événements** → the sliders icon. Checks 16 and 18 cover them.

---

# 🎫 CHECK 1 — Buy a ticket with no account at all

> **The task:** a visitor can browse, pay and get a working QR without ever creating an account. A signup wall in front of the Pay button is the single biggest conversion loss on a ticketing site.

### Step 1 — Browse as a stranger

1. Open a **private window** at http://localhost:3100 — do not sign in.
2. Click **"Explorer"** in the header.
3. Click any event card.

### Step 2 — Reserve

4. On the event page, pick a ticket tier and press **+** once.
5. Click the booking button.

**✔️ You must see** the checkout page, with a **countdown** running at the top.

> 🎯 The seat is claimed *now*, before you type anything. You should never fill in a whole form and only then be told the tickets are gone.

### Step 3 — Pay

6. Fill in **Nom**, **E-mail** and **Téléphone** (any plausible values — `0612345678` works).
7. Click the pay button.

**✔️ You must see** the confirmation page: a green check, **"Paiement accepté"**, the amount, and one ticket card per seat with a **QR code** and a green **"Valide à l'entrée"** badge.

### Step 4 — The ticket really works

8. Click **"Afficher le pass d'accès"** on a ticket.

**✔️ You must see** the ticket page with a large QR, the event, the zone and gate, and the holder's name.

9. Click the **download icon** (top right of that page).

**✔️ You must see** a PDF download. Open it: dark header, `Eventick.ma` wordmark, QR, and a reference like `ET-2027-…`.

> 🎯 **This is the whole check.** You never created an account. You have a real ticket, a real QR and a printable PDF.

🧹 **Clean up:** nothing. This is a normal sale.

✅ **Check 1 done.**

---
---

# 🔒 CHECK 2 — The link is the key, and it has limits

> **The task:** a guest's only credential is the link they were given. That is enough to *use* the ticket. It is deliberately **not** enough to refund the money or give the seat away — links get forwarded, screenshotted and left in group chats.

### Step 1 — Keep the link from check 1

1. Copy the confirmation URL from check 1. It looks like
   `http://localhost:3100/confirmation/cmv…`

### Step 2 — Open it somewhere else

2. Open a **second private window** and paste the URL.

**✔️ You must see "Commande introuvable"** if you copied the URL *without*
its `?k=…`, and the order *with* it. Both are correct — the question is only
whether the token came along.

| What you pasted | What you must see |
|---|---|
| The path alone, `…/confirmation/cmv…` | **"Commande introuvable"** — this window never had the token |
| The full URL including `?k=…` | The order and its tickets |

> 💡 The first case is the point: **the link without the token is worthless.**
> The order id is not a credential, which is exactly the bug this check
> exists to keep fixed.

### Step 3 — Try to act on the ticket without the token

3. In the window where the ticket *does* open, click **"Afficher le pass d'accès"**.
4. Scroll to **"Gérer ce billet"**.

**✔️ You must see** a panel offering **"Corriger le nom"** — and a box explaining that an account is needed to resell or give the ticket away.

**✔️ You must NOT see** **"Revendre ce billet"** or **"Offrir ce billet"** while signed out.

> 🎯 **This is the whole check.** A forwarded link can show a ticket. It cannot spend your money or hand away your seat.

### Step 4 — Prove it at the API level (optional)

```bash
# Replace TICKET_ID with the real id from your /billet/… URL
curl -s -w "\n  HTTP %{http_code}\n" \
  -X POST 'http://localhost:4100/api/resale/listings' \
  -H 'content-type: application/json' \
  -d '{"ticketId":"TICKET_ID"}'
```

**✔️ You must see** `{"error":"This order is not yours"}` and **HTTP 403**.

> ⚠️ If you get **404**, the id is wrong — a ticket that does not exist is a genuine 404, and that is not the check. Copy the id from the address bar of a real ticket page.

### Step 5 — The whole boundary, in one table

Every row below was verified against the API with a real guest token — the
`?k=…` value from the confirmation URL, sent as the `x-order-token` header.

| What the holder of a link tries | Result |
|---|---|
| `GET /api/tickets/:id` with **no** token | **403** — a link is required |
| `GET /api/tickets/:id` **with** the token | **200** — they can see their ticket |
| `PATCH /api/tickets/:id/holder` with the token | **200** — they may fix a misspelled name |
| `POST /api/resale/listings` with the token | **403** *"Create an account to manage this ticket"* |
| `POST /api/tickets/:id/transfer` with the token | **401/403** — giving the seat away needs an account |

> 🎯 Read that bottom half again. The token is enough to **use** a ticket and
> to **correct a typo**. It is deliberately not enough to move money or hand
> the seat to someone else, because links get forwarded and screenshotted.

✅ **Check 2 done.**

---
---

# 👤 CHECK 3 — Claim a guest order into an account

> **The task:** "create an account" must not be a dead end. Registering alone does not attach the tickets you already bought — claiming does.

> ℹ️ **Starting here?** This check needs a guest order. Either keep the one
> from check 1, or make a fresh one: buy a ticket in a private window without
> signing in, and keep the confirmation URL *including* its `?k=…`.

### Step 1 — Register with the buyer's email

1. On the ticket page, click the button in the claim box.
2. If you are signed out, you land on **"Se connecter"**. Create an account — use **any** email.

### Step 2 — Claim

3. Go back to the ticket page and click the claim button again.

**✔️ You must see** a success toast, and the management panel now shows **"Revendre ce billet"** and **"Offrir ce billet"**.

### Step 3 — The order is now yours

4. Click **"Voir mes billets"** in the header (or go to `/billets`).

**✔️ You must see** the order you bought as a guest, now listed in your account.

> 🎯 Before claiming, that list was empty — registering alone does not adopt past orders.

### Step 4 — Nobody else can take it

5. Sign out, register a **second** account, and try to claim the same order.

**✔️ You must see** it refused: *"Cette commande appartient déjà à un autre compte."*

> 🎯 Two people can hold the same link. The first to claim it is the one the refund will go to.

✅ **Check 3 done.**

---
---

# 🎁 CHECK 4 — Give a ticket away

> **The task:** sharing hands the seat to someone else safely. Nothing moves until they claim it, and until then you can pull it back. The recipient gets a **new** ticket; yours stops working.

> ℹ️ **Starting here?** You need a ticket you **own** — a claimed order, not
> a guest link. Check 3 produces one; or buy as a guest, register, and claim.
> A link-only holder cannot share, which is check 2.

### Step 1 — Create the link

1. Signed in, open a ticket → **"Gérer ce billet"** → **"Offrir ce billet"**.
2. Optionally type a message.
3. Click the create button.

**✔️ You must see** a toast saying the link was copied.

### Step 2 — Claim it as someone else

4. Paste the link in a **private window**. It looks like `/billet-offert/…`.

**✔️ You must see** the offer: who sent it, the event, the seat.

5. Type a name and claim it.

**✔️ You must see** a QR straight away — the recipient has no account and needs none.

### Step 3 — The sender's ticket is dead

6. Back in your own window, reload the original ticket.

**✔️ You must see** the ticket is no longer valid — its QR will not admit anyone.

> 🎯 **This is the point.** Emailing a PDF leaves two working QRs for one
> seat. This leaves exactly one.

> 💡 Its status is **`TRANSFERRED`**, not `CANCELLED`. The distinction is
> deliberate and verified: a holder who looks at an old ticket can be told
> "you gave this away" rather than the ambiguous "this was cancelled", which
> is also what support needs to answer *"where did my ticket go?"*.

7. Open the share link a **second** time.

**✔️ You must see it refused.** One link, one seat, one claim.

### Step 4 — Revoking (do this on a fresh ticket)

7. Create a share link on another ticket, then click the revoke button **before** anyone claims it.
8. Open the link.

**✔️ You must see** it refused — the offer is gone, and your ticket still works.

✅ **Check 4 done.**

---
---

# 🚪 CHECK 5 — The gate: a QR scans exactly once

> **The task:** the door must admit a valid ticket and refuse the same ticket twice — that is the whole anti-fraud story.

### Step 1 — Open the gate

1. Sign in as **organiser** (or admin).
2. Sidebar → **OPÉRATIONS** → **Porte**.

### Step 2 — Admit a ticket

3. Take a ticket reference from a ticket page — it looks like `ET-2027-ABC123`.
4. Type it into the manual field and submit.

**✔️ You must see** a green result: the ticket is admitted, with the holder's name.

### Step 3 — Try it again

5. Submit the **same** reference a second time.

**✔️ You must see** it refused, saying the ticket is already in.

> 🎯 **This is the whole check.** One ticket, one entry.

### Step 4 — A made-up reference

6. Type `ET-2027-NOPE99` and submit.

**✔️ You must see** a clear "no such ticket" result, not a crash.

### Step 5 — Typing a reference and photographing one are not the same thing

This is the part most worth understanding, and it is invisible from the screen.

A **typed** reference is a deliberate staff override — it works, because a
phone screen sometimes will not scan. A **camera** scan must carry the
ticket's own signature. So the same string behaves differently depending on
where it came from:

```bash
# Typed by staff: accepted.
curl -s -X POST 'http://localhost:4100/api/gate/check-in' \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer ORGANISER_TOKEN' \
  -d '{"ref":"ET-2027-ABC123","source":"manual"}'

# The SAME reference presented as a camera scan: refused.
curl -s -X POST 'http://localhost:4100/api/gate/check-in' \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer ORGANISER_TOKEN' \
  -d '{"ref":"ET-2027-ABC123","source":"camera"}'
```

**✔️ The second must fail with 400** and *"Unsigned QR code — scan the
ticket's own code, or enter the reference manually"*.

> 🎯 **Why it matters:** a photograph of a reference, or a reference read out
> over the phone, is not a ticket. `source` defaults to the strict `camera`
> case, so an older client cannot weaken the rule by omitting it.

### Step 6 — The gate belongs to its own event

7. Signed in as a **customer**, try the same check-in through the API.

**✔️ You must see 403.** `gate.checkin` is a real capability, and an
organiser scanning another organiser's ticket gets *"This ticket is for
another organiser's event"* — checked **before** the ticket is spent, so a
refusal leaves it untouched.

### Step 7 — Undo a wrong scan, at the door

The wrong person steps forward and you scan them. This is the commonest
mistake at a gate, so the fix is on the gate screen.

8. Admit a ticket, then click **"Annuler cette entrée"** under the verdict.
9. Confirm the dialog.

**✔️ You must see** the verdict clear, the entry disappear from *"Scans
récents"*, and the ticket admit again on the next scan.

> 🎯 The capability already existed as `PATCH /organiser/tickets/:id/status`
> on the Orders desk — but that needs the ticket's internal **id**, and the
> person holding the problem is at the door with only a printed reference. So
> it was real and unreachable from where it was needed.

10. Press it again on a ticket that was **not** checked in, via the API:

```bash
curl -s -w "\n  HTTP %{http_code}\n" -X POST \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer ORGANISER_TOKEN' \
  -d '{"ref":"ET-2027-ABC123"}' \
  'http://localhost:4100/api/gate/undo'
```

**✔️ 409** — *"This ticket is valid, not checked in"*. Only a **USED** ticket
can be un-used: a CANCELLED one is a refund and a TRANSFERRED one is a
hand-off, and reviving either would hand back a seat that has been paid out
or given away.

> 💡 The link is hidden while the gate is **offline**. An undo cannot be
> queued the way a scan can — the server has to agree — and one that silently
> did nothing would be worse than none.

> ⚠️ Every undo is journalled, with the previous status and the time of the
> admission it reversed. Re-admitting a spent ticket is the override most
> likely to be asked about afterwards, so check 10 can find it.

✅ **Check 5 done.**

---
---

# 📅 CHECK 6 — Publish an event

> **The task:** an organiser can put a date on sale in one form, and it appears in the public catalogue immediately.

### Step 1 — Open the form

1. Signed in as **organiser**, click **"Créer un événement"** in the header.

> 👑 **Signed in as an ADMIN?** You will see one extra field the organiser
> never gets: **"Organisateur propriétaire"**. Pick an organiser — the form
> will not submit without one.
>
> This is not bureaucracy. `organiserId` decides **who gets paid**: the payout
> recipient, the plan whose rate prices the commission, and the bank account
> the transfer reaches. Creation used to copy it from whoever was signed in,
> so an admin setting an event up on an organiser's behalf quietly became its
> payee — and no field existed to correct it afterwards. Fifteen of the
> sixteen seeded events were admin-owned for exactly that reason.

**✔️ You must see** the form split into **five** named sections, in this order:
**L'essentiel**, **Quand et où**, **Billets et tarifs**, **Règles de vente**,
**Visuel et description**.

> 💡 **Règles de vente** is the newest one — the per-buyer cap, the resale
> switch and the sales windows. Check 16 covers what it does.

### Step 2 — Use the shortcut (optional)

2. In the **"Gagner du temps"** card at the top, click the example-filling link.

**✔️ You must see** several fields fill themselves in.

### Step 3 — Check the date and time pickers

3. Click the **Date** field.

**✔️ You must see** a calendar that matches the app's theme — **not** the browser's grey-and-blue one. Weeks start on **Monday**.

4. Click the **Heure** field.

**✔️ You must see** two columns, **24-hour**, with no AM/PM.

> 🎯 These are the app's own controls. The browser's versions ignored the dark theme entirely and showed `12/20/2026` with an AM/PM column.

### Step 4 — Publish

5. Fill in at least **Nom de l'événement**, **Lieu**, a date, a price and a capacity.
6. Click **"Publier sur l'agenda"**.

**✔️ You must see** a success toast, and the event appears in the **"Vos événements"** column on the right.

7. Open **"Explorer"** in a new tab.

**✔️ You must see** your event in the public catalogue.

🧹 **Clean up:** delete it from **CATALOGUE → Événements** if you like. An event with sales cannot be deleted — hide it instead, which is deliberate.

### Step 5 — Who the event belongs to is a money question

Run these as an **admin**:

```bash
# No organiser named: refused.
curl -s -w "\n  HTTP %{http_code}\n" -X POST \
  -H 'content-type: application/json' -H 'authorization: Bearer ADMIN_TOKEN' \
  -d '{"slug":"unowned-test", …}' \
  'http://localhost:4100/api/organiser/events'
```

**✔️ 400** — *"Choose which organiser this event belongs to"*. An admin may
create an event for someone, never own one.

| What you try | Result |
|---|---|
| Admin creates with `organiserId` of a real organiser | **201**, and that organiser owns it |
| Admin creates with no `organiserId` | **400** — defaulting to themselves is the bug this prevents |
| Admin names a **customer** | **400** *"That account is not an organiser"* — nobody could be paid |
| Admin names **another admin** | **400** — that would reinstate the problem by hand |
| Admin names an id that does not exist | **404** |
| An **organiser** creates one, no field | **201**, they own it — unchanged |
| An **organiser** names someone else | **403** *"You can only create events for yourself"* |

### Step 6 — Handing an event over, and when you cannot

8. As an **admin**, `PATCH /organiser/events/SLUG` with `{"organiserId":"…"}`
   on an event that has sold **nothing**.

**✔️ 200.** The owner changes, and the transfer is journalled.

9. Sell one ticket on it, then try the same reassignment.

**✔️ 409** — *"Cannot reassign: 1 paid order(s) have already settled to the
current organiser"*.

> 🎯 The platform fee is recorded **at settlement** against the owner's plan
> and never recomputed. Moving the event afterwards would leave past payouts
> describing an owner it no longer has, and credit the new owner for sales
> they did not make. A genuine mistake has to be fixed before anything sells.

> 💡 An **organiser** gets 403 on this field at any time — they can edit their
> event's content, never give it away. Re-stating the owner it already has is
> not treated as a change, so an unrelated content edit never trips the 409.

✅ **Check 6 done.**

---
---

# 💸 CHECK 7 — Refunds, and who is allowed to make them

> **The task:** refunding moves money, so it is its own capability — separate from merely seeing the money.

### Step 1 — Refund an order

1. Signed in as **organiser**, sidebar → **PILOTAGE** → **Réservations**.
2. Find a paid order and refund it.

**✔️ You must see** the order marked refunded and its tickets voided.

### Step 2 — Try to refund it twice

3. Refund the same order again.

**✔️ You must see** it refused.

### Step 3 — The capability is real (admin)

4. Sign in as **admin** → **ADMINISTRATION** → **Permissions**.
5. Find **`finance.refund`** and switch it **off** for **Organisateur**.
6. In another window, as the organiser, try to refund an order.

**✔️ You must see** it refused.

7. Switch **`finance.view`** off too.

**✔️ You must see** **Finance** disappear from the organiser's sidebar entirely.

> 🎯 **This is the whole check.** These toggles used to do nothing — the organiser kept reading revenue and issuing refunds regardless.

### Step 4 — Figures for ONE event, not the whole account

An organiser running two shows has to be able to tell how each one did.

```bash
# Everything this organiser sells
curl -s -H 'authorization: Bearer ORGANISER_TOKEN' \
  'http://localhost:4100/api/organiser/stats'

# One show only
curl -s -H 'authorization: Bearer ORGANISER_TOKEN' \
  'http://localhost:4100/api/organiser/stats?eventSlug=YOUR_SLUG'
```

**✔️ The filtered figures must be smaller**, and the response says what it
covers: `"eventSlug"` and `"events"`. Unfiltered, `eventSlug` is `null`.

> 🎯 `inside` is the attendance count, so this is also how you get a
> per-event scan rate rather than a platform-wide one.

> ⚠️ Now name a slug belonging to a **different** organiser.
>
> **✔️ You must see `"events": 0`** and zeroed figures — not a 403, and
> never their revenue. The filter is applied *inside* the ownership scope, so
> an unowned slug reads as an event with no sales rather than as a way to
> read someone else's numbers. An unknown slug behaves identically.

### Step 5 — The server agrees, not just the screen

Hiding a button is not access control. With `finance.refund` **off**, call the
refund endpoint directly as the organiser:

```bash
curl -s -w "\n  HTTP %{http_code}\n" -X POST \
  -H 'authorization: Bearer ORGANISER_TOKEN' \
  'http://localhost:4100/api/organiser/orders/ORDER_ID/refund'
```

**✔️ You must see HTTP 403.** A customer's token gets 403 too, with the
permission on or off.

🧹 **Clean up:** switch both permissions back on.

✅ **Check 7 done.**

---
---

# 🙋 CHECK 8 — Becoming an organiser

> **The task:** a customer can ask to sell tickets, and an admin decides. Before this, the biggest button on the site went nowhere for them.

### Step 1 — Ask

1. Sign in as the **customer** (`client@eventick.ma`).
2. Click **"Créer un événement"** in the header.

**✔️ You must see** the page **"Vendez vos billets sur Eventick"** — *not* a silent bounce back to the homepage.

3. Fill in the form and click **"Envoyer ma demande"**.

**✔️ You must see** the status change to *"Demande en cours d'examen"*.

### Step 2 — One request at a time

4. Reload and try to submit again.

**✔️ You must see** the pending status, not a second form.

### Step 3 — Decide, as admin

5. In another window, sign in as **admin** → **ADMINISTRATION** → **Équipe**.

**✔️ You must see** a **"Demandes d'organisateur"** panel with a count badge, showing who asked, their phone and their pitch.

6. Click **"Approuver"**.

### Step 4 — The promotion is immediate

7. Back in the customer's window, reload.

**✔️ You must see** they are now an organiser — the dashboard opens, no re-login needed.

> 🎯 Permissions resolve on every request, so the change reaches the session they already have.

### Step 5 — Declining (optional)

8. Repeat with a second account and click **"Refuser"**, with a reason.

**✔️ You must see** the applicant shown the reason, still a customer, and able to apply again.

🧹 **Clean up:** demote the test account from **Équipe** if you like.

✅ **Check 8 done.**

---
---

# 🛡️ CHECK 9 — The sidebar only shows what you may use

> **The task:** a menu must never promise something the server refuses. Hiding an item is not security — but showing a dead one is a bug.

### Step 1 — Compare the two sidebars

1. Sign in as **organiser**. Note the sidebar.
2. Sign in as **admin** in another window.

**✔️ You must see** the admin has an extra **ADMINISTRATION** group: **Plateforme**, **Équipe**, **Permissions**. The organiser has none of it.

### Step 2 — Typing the URL directly

3. As the **organiser**, type `http://localhost:3100/pro/users` in the address bar.

**✔️ You must see** you are redirected away — not a screen full of failed requests.

### Step 3 — The server refuses, not just the sidebar

Signed in as the **organiser**, call the admin-only endpoints directly:

```bash
for p in platform/stats platform/audit platform/users; do
  curl -s -o /dev/null -w "$p -> %{http_code}\n" \
    -H 'authorization: Bearer ORGANISER_TOKEN' \
    "http://localhost:4100/api/$p"
done
```

**✔️ All three must answer 403.**

> 🎯 A hidden nav item is a convenience; the 403 is the actual boundary. If
> the sidebar ever hides something the server still allows, that is the bug
> this step exists to find.

### Step 4 — Flip a capability live

4. As **admin** → **Permissions**, switch **`promo.manage`** **off** for Organisateur.
5. Reload the organiser's window.

**✔️ You must see** **Offres** gone from their sidebar.

6. Switch it back on and reload.

**✔️ You must see** it return.

🧹 **Clean up:** make sure `promo.manage` is back on.

✅ **Check 9 done.**

---
---

# 🏛️ CHECK 10 — The admin's platform console

> **The task:** an admin runs a marketplace, not one organiser's events. Their dashboard used to be an organiser's with bigger numbers.

### Step 1 — Open it

1. Signed in as **admin**, sidebar → **ADMINISTRATION** → **Plateforme**.

**✔️ You must see** figures no organiser screen gives you:

| Tile | What it answers |
|---|---|
| **Volume encaissé** | everything sold, refunds included |
| **Net après remboursements** | with a refund rate |
| **7 derniers jours** | with the week-on-week move |
| **Comptes** | total, and how many joined this week |

### Step 2 — The breakdowns

**✔️ You must see** three panels: accounts by role, catalogue by status, orders by status.

### Step 3 — Who is actually selling

**✔️ You must see** a **"Qui vend"** list, ranked by volume, **including anyone at zero** — that is the useful part.

> 💡 The **admin account** may appear in this list. That is correct: it owns the 14 seeded events. The row shows its role so it explains itself.

### Step 4 — It reconciles

2. Compare the **Volume encaissé** tile with the sum of the "Qui vend" rows.

**✔️ You must see** they match.

### Step 5 — It is admin-only

```bash
curl -s -o /dev/null -w "%{http_code}\n" 'http://localhost:4100/api/platform/stats'
```

**✔️ You must see** `401`. Signed in as an organiser it is `403`.

✅ **Check 10 done.**

---
---

# 🌍 CHECK 11 — Three languages, and Arabic mirrors

> **The task:** the interface is French, English and Arabic, and Arabic flips the whole layout right-to-left.

### Step 1 — Switch language

1. Anywhere in `/pro`, open the **account menu** (top right).
2. Under **LANGUE**, click **EN**.

**✔️ You must see** the interface in English — sidebar, titles, buttons.

3. Click **عربي**.

**✔️ You must see** Arabic **and** the layout mirrored: sidebar on the right, text right-aligned, arrows pointing the other way.

### Step 2 — Numbers and dates follow the language too

This is where localisation usually breaks, because it looks finished.

3. With the language on **English**, read the **"Places disponibles"** figure
   in the hero.

**✔️ It must group with a comma** — `139,927` — not a dot. In French it is
`139 927` (a space), in Arabic `139.927`.

> 🎯 It read `139.939` in all three languages, because English fell through
> to a French formatter. To an English reader a dot is a decimal point, so
> the site appeared to sell a fraction of a seat.

4. Still in English, look at the **e-ticket preview** card.

**✔️ The month must read `JUL`**, not `JUIL`. Arabic shows `يوليوز`.

> 🎯 That date was a hardcoded string in the markup, so no amount of fixing
> the formatter could translate it. Both of these regress silently — nothing
> errors, the text is just quietly wrong — which is why they are steps now.

### Step 3 — The public site too

4. Go to the public site and switch language there.

**✔️ You must see** event titles change language — they are stored in both.

> ⚠️ **Two deliberate exceptions.** The **ticket PDF** is French-only: the PDF engine has no Arabic text shaping, so Arabic would come out disconnected and reversed. Some **server error messages** are French — the interface is translated, server strings are not.

✅ **Check 11 done.**

---
---

# 🌓 CHECK 12 — Dark and light, and no stray browser chrome

> **The task:** every control belongs to the app. Native browser widgets ignore the theme and are the one thing that breaks the illusion.

### Step 1 — Switch theme

1. Account menu → **"Passer en clair"**.

**✔️ You must see** the whole dashboard flip to light, including cards, the sidebar and the charts.

2. Switch back to dark.

### Step 2 — Open every kind of dropdown

3. On the event form (`/organiser`), open **Catégorie**.

**✔️ You must see** a themed list with a check mark on the current item — **not** a white system list with a blue highlight.

4. Open the **Date** and **Heure** fields.

**✔️ You must see** the app's own calendar and time columns.

5. In `/pro` → **Offres**, open the **new promo** modal and its dropdowns.

**✔️ You must see** the same themed list on a dark modal.

> 🎯 **This is the whole check.** If you see a grey-and-blue system popup anywhere, that is a bug — report where.

### Step 3 — The sidebar at a short window

6. Resize the browser to roughly **800 px** tall.

**✔️ You must see** the full nav without scrolling. Shorter than that it scrolls, with a **thin themed scrollbar** — not the browser's thick grey one.

✅ **Check 12 done.**

---
---

# 💰 CHECK 13 — Commission is the server's, not the browser's

**Why this check exists.** The Finance screen used to let the organiser pick
their own commission plan from a row of buttons, compute the fee in the
browser, and store nothing. The number changed when you clicked a different
button and reset on reload. It matched no charge anyone would ever make.

### Step 1 — Look, but do not touch

Sign in as **organisateur@eventick.ma** → **FINANCES → Finance**.

- The plan is shown with a **padlock** and reads *"Offre attribuée par
  Eventick"* (or *"Offre par défaut"* if none is assigned). There is **no way
  to change it** — that is the point.
- Four figures across the top: **Recettes nettes**, **Remboursé**,
  **Commission Eventick**, **À reverser**.

### Step 2 — Assign a plan, as admin

Sign in as **admin@eventick.ma** → **ADMINISTRATION → Plateforme**. Each
organiser row has an **Offre** dropdown. Put the demo organiser on **Pro ·
3%**.

The response says, in effect, *"applies to orders settled from now on"*.

### Step 3 — Sell something, then check the fee

As a buyer, purchase a ticket from one of that organiser's events. Back on
**Finance**, the commission has grown by **3% of what you just spent**.

### Step 4 — The important part: history does not move

As admin, change the organiser to **Starter · 5%**. Return to **Finance**.

> ✅ The commission figure **does not change**. The fee was recorded on each
> order at the moment it was paid, so moving someone to a different rate
> cannot rewrite what they already owed. Only *later* sales use the new rate.

If that number moved, the fee is being recomputed on read — which is the bug
this design exists to prevent.

### Step 5 — A refund takes its commission with it

Refund half an order (**Réservations** → the order → refund half).

> ✅ **Recettes nettes** drops by the refund **and** the commission drops in
> proportion. An organiser must not pay a fee on a sale the buyer got their
> money back for.

---

# 🏦 CHECK 14 — Payouts: what is owed, and sending it

**Why this check exists.** Money reaches Eventick's CMI account, not the
organiser's, so their share has to be transferred separately. The dashboard
used to show a "Reversement" step that calculated nothing and recorded
nothing.

### Step 1 — Try to run a payout with no bank details

As admin → **Plateforme** → an organiser row → **Préparer un reversement**.

> ✅ Refused: *"no bank details on file"*. A pending payout nobody can
> actually send is worse than none — it reads as money already on its way.

### Step 2 — Add the RIB, as the organiser

**Finance → Coordonnées bancaires**. Try `123` first.

> ✅ *"Le RIB marocain comporte exactement 24 chiffres."*

Now enter 24 digits — spacing is fine, paste `1234 5678 9012 3456 7890 1234`.

> ✅ Saved, and only the **last four** come back (`**** 1234`). The full RIB is
> a payment credential; the earnings screen has no need for it.

### Step 3 — Run it

As admin → **Préparer un reversement**. The dialog shows **what is owed** and
how many orders. Dates default to the **last twelve months**.

> ✅ Created. The row reads `net = gross − commission − subscription`.

**On the subscription:** Pro is "3% + 499/month". The monthly part is withheld
here, once per calendar month **that had sales**. A dormant month is free.

### Step 4 — The guards

| What you do | What should happen |
|---|---|
| Run the same period again | *"Nothing to pay out"* — an order belongs to one payout, ever |
| Mark it paid with no reference | Refused — the row could not be reconciled against a bank statement |
| Mark it paid, then try again | Refused: already paid, and the first reference survives |
| Try to cancel a **sent** payout | Refused — a transfer that has gone cannot be un-sent by editing a row |
| Cancel a **pending** payout, then re-run | Works: its orders *and* its subscription months are released |
| Refund something already paid out | The payout's total **does not move** — it records money already sent |

### Step 5 — A month too quiet to cover its fee

If a month's revenue is less than the monthly subscription (say 194 MAD
against 499), the payout is **still created**: the fee takes what is there,
nothing is transferred, and the record exists.

> ⚠️ The shortfall is **not** carried forward as debt. That is a deliberate
> limit, not an oversight — see *Still open*.

---

# 📜 CHECK 15 — The journal, and removing an account

**Why this check exists.** Fourteen privileged routes could change a role,
grant a permission, refund money, assign a plan or send a payout, and none of
them left a record. *"It just changed"* is not an answer anyone can act on.

### Step 1 — Do something privileged

As admin, do any two of: change someone's role · grant a permission · refund
an order · assign a plan · send a payout.

### Step 2 — Read the journal

**ADMINISTRATION → Journal**.

> ✅ Each action appears with **your email**, **what changed — both ends**
> (`CUSTOMER → ORGANISER`, not just the result), and when.

Filter by action with the dropdown. Open the same screen as the **organiser**:

> ✅ Refused. The rows describe money and accounts across every organiser, so
> it is admin-only.

### Step 3 — Remove a fresh account

**Équipe** → create a throwaway account → remove it with the **bin** icon.

> ✅ The dialog says it will be **deleted permanently**. Afterwards the account
> is gone — but the **Journal still shows it existed and who removed it**.

That is the whole point: a cascade would have erased exactly the record worth
keeping.

### Step 4 — Remove an account that has bought something

Try to remove a customer **with orders**.

> ✅ The dialog says it will be **anonymised, not deleted**, because its
> payment history has to be kept.

Afterwards:

- The name reads *"Compte supprimé"*, the email is an opaque non-address.
- **The orders and tickets still exist** — the organiser was paid for them.
- The old credentials **no longer work**.

### Step 5 — The guards

| What you try | What should happen |
|---|---|
| Remove **your own** account | Refused — the platform can never reach zero admins |
| Remove **another admin** | Refused — one compromised admin must not clear out the rest |
| Remove anyone, as the organiser | Refused — `users.manage` only |

---

# 🗓️ CHECK 16 — Sales rules: who may buy, how many, and from when

> **The task:** an organiser needs three things a ticketing page cannot do without — a cap so one person cannot clear the tier, a date the sale opens, and a date it closes. All three existed in the API for a while with no way to set them; this is the screen that closes that gap.

### Step 1 — Set them while publishing

Header → **"Créer un événement"**. Fill the form as in check 6, then scroll to the new group **"Règles de vente"**.

| Field | Put in | What it means |
|---|---|---|
| **"Billets max par acheteur"** | `2` | Across *all* that buyer's orders, not per order. `0` means no limit |
| **"Autoriser la revente entre acheteurs"** | leave **unticked** | Resale is off unless asked for — that is check 18 |
| **"Fenêtre de vente"** → "Ouverture des ventes" | leave **empty** | Empty means on sale from publication |
| **"Fenêtre de vente"** → "Clôture des ventes" | leave **empty** | Empty means on sale until the event |

**✔️ You must see** the time pickers beside each date **greyed out and unclickable** until you pick a date. A time with no date would be a bound that is silently never sent, so the control refuses to pretend otherwise.

Pick an opening date now. **✔️ The time picker beside it becomes usable**, and a **"Réinitialiser"** link appears to clear the window again.

Tick **"Ajouter un tarif VIP"**. **✔️ A second "Fenêtre de vente VIP" appears** — the VIP tier gets its own window, because a VIP drop rarely opens when general sale does.

### Step 2 — An impossible window is refused

First notice you cannot create one by accident: pick an opening date, then open the closing picker. **✔️ Every day before the opening is greyed out and unclickable.**

So reach it the other way round — set the **closing** first, then move the **opening** to a later date. (Or set both to the same day and put the opening time after the closing time.) Press **"Publier sur l'agenda"**.

**✔️ You must see** *"La clôture doit être après l'ouverture."* and **no event is created**.

> This is checked in the browser as well as on the server on purpose. The server's message cannot say *which* window is wrong, and with a base tier and a VIP tier open at once that leaves you guessing.

Fix the dates and publish.

### Step 3 — Change the rules after the event exists

Pro → **CATALOGUE** → **Événements**. On your event's card, press the **sliders icon** (tooltip **"Règles de vente"**).

**✔️ The modal opens on the event's current values** — not on defaults. Change **"Billets max par acheteur"** to `1`, set **"Annulation possible jusqu'à (heures avant)"** to `24`, and **"Enregistrer"**.

Reopen it. **✔️ Both values are still there.**

> 💡 This was the real gap: the rules could be set at creation and then never changed again.

### Step 4 — The cap actually bites, and it spans ORDERS

Set the cap to **2**, then:

5. Try to buy **3** at once.

**✔️ Refused** (HTTP 409), naming the limit.

6. Buy exactly **2**. **✔️ Allowed.**
7. Come back as the **same buyer** and try to buy **1** more.

**✔️ Refused** — and this is the whole point of the field.

> 🎯 A per-ORDER limit is nearly useless: one email could buy 8, three times
> over, and take 24 seats of a high-demand show. This counts every ticket
> that buyer already holds for the event, across every order they have
> placed. Verified end to end: 3 → 409, then 2 → allowed, then +1 → 409.

---

# 🚫 CHECK 17 — Calling an event off

> **The task:** an event gets cancelled. Every buyer must get their money back, every ticket must stop working, and the organiser must be told what actually happened — in one action, not four hundred.

> ⚠️ **Do this on an event you created**, not a seeded one. It refunds every buyer and cannot be undone.

### Step 1 — Sell something first

Buy a ticket or two on your test event (check 1). A cancellation with nothing to refund proves nothing.

### Step 2 — Find the action

Pro → **CATALOGUE** → **Événements** → your event's card → the **🚫 icon** (tooltip **"Annuler l'événement"**).

**✔️ If you are signed in as the organiser you see it.** It needs `finance.refund`, not `events.manage` — refunding every buyer at once is a bigger act than editing a listing, so someone trusted with the catalogue is not automatically trusted with this.

> To prove the gate: Pro → **ADMINISTRATION** → **Permissions**, turn **`finance.refund`** off for ORGANISER, reload **Événements**. **✔️ The icon is gone.** Turn it back on.

### Step 3 — Read what it says before agreeing

Press the icon.

**✔️ You must see** a modal spelling out the consequences in red:

> *"L'événement sort de la vente immédiatement. Chaque commande payée est remboursée, tous les billets sont annulés — y compris les invitations — et la liste d'attente est clôturée."*

Type a reason under 5 characters and submit. **✔️ Refused** — the reason is sent to buyers, so it cannot be empty or a keystroke.

Type a real reason: `Artiste malade, report impossible.` Leave **"Prévenir les acheteurs par e-mail"** ticked. Press **"Annuler l'événement"**.

**✔️ A second confirmation appears** — *"Cette action est irréversible."* Two deliberate yeses, because "cancel" on its own does not imply refunding every buyer.

> 💡 Press **Escape** on that confirmation. **✔️ The confirmation closes and the modal behind it stays open** — nothing is cancelled. Escape backs out; it never performs the action.

### Step 4 — What you are told

**✔️ You must see** a toast naming **how many orders were refunded and how much money went back** — for example *"1 commande(s) remboursée(s), 200,00 MAD rendus. Billets annulés."*

> It deliberately does **not** quote a ticket count. The server's `ticketsVoided` counts only the final sweep, and the refund has normally cancelled every ticket already — so that number is `0` in the ordinary case and reads as "nothing happened" on the one screen where you most need to know that it did.

If any refund failed, **✔️ a second orange warning** says how many need doing by hand, and stays on screen ten seconds. Those orders are still `PAID` in **Réservations**, so you can find and finish them.

### Step 5 — Everything is really off

| Where you look | What you must see |
|---|---|
| The event's card in **Événements** | A red **"Annulé"** badge, and the 🚫 icon **gone** — there is nothing left to cancel |
| The event on the public site | **404.** It is off sale, not merely hidden |
| Trying to buy it anyway, via the API | **410 Gone** — *"This event has been cancelled"* |
| Clicking the **restore** eye on the dashboard | **409.** It cannot be put back on sale |
| Cancelling it a second time | **409**, even after hiding it |

> 🎯 The last two were real bugs, and the same one twice: cancellation was
> inferred from the event's STATUS instead of from `cancelledAt`. Restore
> wrote `PUBLISHED` over `CANCELLED`, so an event whose tickets had all been
> refunded and voided went back into the catalogue and sold again — verified
> end to end. Hiding a cancelled event then moved its status to `HIDDEN`,
> which let it be cancelled a second time and refund everyone twice.
> Cancellation is something that happened, not a display state.
| **Réservations** | The order reads **REFUNDED**, full amount returned |
| The buyer's ticket page | The ticket is **CANCELLED** — it will not scan |
| Pro → **OPÉRATIONS** → **Porte**, scanning that ref | Refused |

---

# 🎁 CHECK 18 — Invitations: free tickets that are not a sale

> **The task:** give a journalist, a sponsor or the band's family a seat. Until now the only way was a 100 % promo code — and that is wrong in a way that matters: a promo code is a *discount on a sale*, so it lands in revenue, in the commission and in the payout as a zero-value order. A comp was never a sale.

### Step 1 — Open the panel

Pro → **CATALOGUE** → **Invitations** (new item, between *Placements* and *Offres*).

**✔️ You must see** the subtitle *"Billets offerts — jamais une vente, jamais une remise."* and an event switcher, because invitations belong to one event at a time.

### Step 2 — Issue a couple

Press **"Offrir des billets"**.

**✔️ The zone dropdown shows how many seats are left** in each — *"Carré · 12 restant"* — because a comp consumes capacity exactly as a sale does.

Fill the first guest: **"Nom de l'invité"** `Nadia Benali`, **"E-mail (optionnel)"** your own address. Press **"Ajouter un invité"** and fill a second with a name only, no email.

> A guest row left blank is dropped rather than sent — adding a row and not filling it in is a normal thing to do, and the server would reject the whole batch over it.

Press **"Offrir des billets"**.

**✔️ You must see** *"2 invitation(s) émise(s)."* and both guests in the table, each with a **ticket reference**. The one with an email shows **"Envoyé"**; the one without shows **"Non envoyé"** — pass that person the reference yourself.

Try a one-character name. **✔️ Refused** with *"Chaque nom doit faire au moins 2 caractères."*

### Step 3 — The part that matters: it is not revenue

| Where you look | What you must see |
|---|---|
| Pro → **CATALOGUE** → **Placements**, that zone | **2 fewer seats remaining** — capacity is consumed |
| Pro → **FINANCES** → **Finance** | Revenue **unchanged**, commission **unchanged** |
| Pro → **Réservations** | The comp orders exist at **0,00 MAD** |

> 💡 That is the whole reason invitations are their own concept rather than a promo code.

### Step 4 — The zone cannot be overbooked

Issue more invitations than the zone has seats left.

**✔️ Refused**, naming how many are actually left. Capacity is re-checked inside the transaction, so two people giving seats away at once cannot oversell between them.

### Step 5 — Revoking

Press the **🗑 icon** on a guest's row → confirm.

**✔️ You must see** *"Invitation annulée."* — and the guest **still on the list**, dimmed, with a red **"Annulée"** badge instead of a reference. The revoke icon is gone from that row.

> That is deliberate. *"Issued, then revoked"* is something an organiser wants to see; a row that vanishes looks like it never happened.

**✔️ Back in Placements, the seat has returned** to the pool.

### Step 6 — Giving seats away is a capability

Signed in as a **customer**, call the invitations endpoint directly:

```bash
curl -s -w "\n  HTTP %{http_code}\n" -X POST \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer CUSTOMER_TOKEN' \
  -d '{"tierId":"TIER_ID","guests":[{"guestName":"Pas Permis"}]}' \
  'http://localhost:4100/api/organiser/events/SLUG/invitations'
```

**✔️ You must see 403.** Free seats cost the organiser real capacity, so
issuing them needs `events.manage` — the screen being hidden is not the
protection.

### Step 7 — It is all in the journal

Pro → **ADMINISTRATION** → **Journal** (as admin).

**✔️ You must see** rows reading **"Invitations émises"** and **"Invitation annulée"**, with who did it. Free seats given away is exactly the kind of thing somebody asks about three months later.

---

# 🕒 CHECK 19 — A zone that is not on sale says so

> **The task:** a zone that refuses to sell is the most confusing thing an organiser can look at. If a sales window is holding it back, the screen should say which window and when.

### Step 1 — Put a window on an existing zone

Pro → **CATALOGUE** → **Placements**. Pick an event, then **✏️** on a zone.

Scroll to **"Fenêtre de vente"**. Set **"Ouverture des ventes"** to a date **next week** and save.

**✔️ The zone's card now carries an orange badge** reading **"Ouvre le …"** with that date.

### Step 2 — The other two states

| Set the window to | Badge you must see | Colour |
|---|---|---|
| Opens next week | **"Ouvre le …"** | orange |
| Opened yesterday, closes next week | **"En vente"** | green |
| Closed yesterday | **"Ventes closes"** | red |
| No dates at all | **no badge** | — |

> 💡 The badge appears **only when a window actually constrains the zone**. Marking every unconstrained zone "En vente" would be noise; the signal worth having is the one that is *not* selling, and why.

### Step 3 — Clearing a window

Reopen the zone, press **"Réinitialiser"** under the window, save.

**✔️ The badge is gone** and the zone sells normally again.

### Step 4 — The same guard as the event form

Set a closing date **before** the opening date and save.

**✔️ Refused** with *"La clôture doit être après l'ouverture."*

Now the subtler one: leave the closing date alone and move only the **opening** to after it. **✔️ Still refused** — the server checks the window you would *end up with*, not just the field you touched, so you cannot invert a window one field at a time.

### Step 5 — The buyer is refused by the SERVER, not by the drawing

Open the event on the public site while a zone is outside its window, and try
to buy it.

**✔️ The hold is refused with HTTP 409** and a message naming the date:

```
{"error":"Sales for this zone open on 2027-12-01T09:00:00.000Z"}
```

> 🎯 The dashboard badge is a courtesy for the organiser. **This** is the
> rule. A window that only existed in the dashboard would let anyone buy by
> calling the API directly, which is the failure this step rules out.

### Step 6 — A window cannot be inverted one field at a time

6. On a zone that already has a **closing** date, set the **opening** date to
   after it and save.

**✔️ Refused** with *"La clôture doit être après l'ouverture."*

> 💡 The server checks the window you would **end up with**, not just the
> field you touched. Without that, an organiser could invert a live window in
> two saves and take the zone off sale without ever seeing an error — and
> find out from an empty sales report.

---

# 🧑‍💼 CHECK 20 — Staff sell, customers buy

An organiser and an admin run ticketing; they are not shoppers. That is a
product rule, so it is enforced on the **server** — hiding a button would only
hide the evidence, since `POST /orders/hold` is callable directly.

### Step 1 — The account page knows who you are

1. Sign in as **organisateur@eventick.ma** and open the account menu → **"Mon compte"**.

**✔️ You see** your name, email and **"Modifier le profil"** — and nothing else.
No ticket tabs, no "Billets prêts / Dépenses" figures, no saved events, no
"Dernière transaction".

2. Sign in as **client@eventick.ma** and open the same page.

**✔️ You see** the full buyer view: *"Mes billets actifs"*, *"Historique"*,
*"Enregistrés"*, the two stat tiles and the last transaction.

> 💡 The label used to say *"Mes billets"* for everyone. The page was always an
> **account** page — its i18n key is literally `account`, and it holds the
> profile editor — but the French string narrowed it to tickets, which is why
> it read as misplaced in an organiser's menu. The gate is the `events.manage`
> **capability**, not the role name, so an organiser who loses that grant
> correctly falls back to the buyer view.

### Step 2 — Staff cannot reach checkout

3. Still as the organiser, open any event page and pick a zone.

**✔️ Where "Payer" would be** you get a short explanation instead:
*"Ce compte gère la billetterie et ne peut pas acheter de billets. Utilisez un
compte personnel pour réserver."* On a phone, the sticky bottom bar does not
appear at all.

### Step 3 — And the server refuses too

```bash
# As an organiser or admin token:
curl -s -X POST http://localhost:4100/api/orders/hold \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"eventSlug":"<slug>","lines":[{"tierId":"<id>","qty":1}]}'
```

**✔️ 403** — *"This account manages ticketing and cannot buy tickets."*

The same guard sits on `POST /orders/:id/pay` and on `POST /resale/:token/buy`.
Three doors, one rule.

**✔️ A customer and a signed-out guest both still get 201.** That is the part
worth checking: guest checkout has no session, so a careless guard would have
blocked the most common path of all.

> 💡 Why `/pay` as well as `/hold`? A customer can hold seats, be approved as
> an organiser while the hold is live, and come back to pay. The role has to be
> re-checked at the step that actually takes money.
>
> 💡 **Not** blocked: claiming a gifted ticket. Receiving is not buying, and
> stopping it would mean a friend cannot send an organiser a ticket to an
> unrelated concert.

### Step 4 — An invitation cannot change its own zone

4. Open a **comp** ticket's page (any ticket issued from **Invitations**).

**✔️ There is no "Changer de zone" panel at all.** `GET /tickets/:id/options`
returns an empty exchange list for a comp, so the UI has nothing to draw.

5. Try it directly:

```bash
curl -s -X POST "http://localhost:4100/api/tickets/<ID>/exchange?k=<TOKEN>" \
  -H 'content-type: application/json' -d '{"tierId":"<other-zone>"}'
```

**✔️ 403** — *"An invitation cannot be moved to another zone. Ask the organiser."*

> 💡 A comp is a seat the organiser **chose** to give. Letting the guest move it
> makes them the one deciding what was given away — and since a comp was never
> a sale, there is no price paid to measure the change against.

### Step 5 — A downgrade now says what it costs

6. On a **paid** ticket in an expensive zone, look at **"Changer de zone"**.

**✔️ The cheaper zone reads** *"Vous perdez 700,00 MAD — aucun remboursement"*
in amber — not *"Sans supplément"*.

7. Click it.

**✔️ A confirmation first:** *"Passer à cette zone vous fait perdre 700,00 MAD.
Ce montant n'est pas remboursé. Continuer ?"* Cancel, and the ticket does not
move.

> 💡 The no-refund rule is **deliberate** and was not changed: refunding the
> difference would let someone buy the dearest seat and downgrade purely to
> extract cash. What was wrong was the wording. *"Sans supplément"* is true —
> there is no extra charge — and reads as *"this is free"* to someone about to
> forfeit 700 MAD. The fix is disclosure, not money movement.

---

# 🔎 CHECK 21 — Detail pages: the answer to a support call

A list says *which* orders exist. It cannot say *what happened to this one*,
which is the question an organiser is actually asked on the phone.

### Step 1 — Open an order

1. Pro → **Réservations**. Click a **buyer's name**.

**✔️ You land on** `/pro/orders/<id>` — a real URL you can paste into a support
thread, which is why this is a page and not a modal.

**✔️ Four sections:** *Acheteur* (name, email, phone, date), *Billets* (every
ticket with its reference, status and a link to the pass), *Paiement*
(subtotal, discount, total, refunded, card, payment reference, promo code), and
*Historique*.

### Step 2 — The history is the point

2. Cancel or refund that order, then reload the page.

**✔️ The history gains a row:** the action, who did it and when —
e.g. `order.cancelled · organisateur@eventick.ma · 30 octobre 2026`.

> 💡 The status tells you a refund happened. The history tells you **who issued
> it and when**, which is what a disputed charge turns on. This is why the page
> needed its own endpoint rather than filtering the list client-side:
> `/orders/detailed` returns every order on the event — downloading the whole
> book to read one page — and carries no audit trail at all.

### Step 3 — It is not a way around the permission

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  http://localhost:4100/api/organiser/orders/<ID>                      # 401
curl -s -o /dev/null -w "%{http_code}\n" -H "authorization: Bearer $CUSTOMER" \
  http://localhost:4100/api/organiser/orders/<ID>                      # 403
curl -s -o /dev/null -w "%{http_code}\n" -H "authorization: Bearer $ADMIN" \
  http://localhost:4100/api/organiser/orders/<ID>                      # 200
curl -s -o /dev/null -w "%{http_code}\n" -H "authorization: Bearer $ADMIN" \
  http://localhost:4100/api/organiser/orders/nonsense                  # 404
```

**✔️ 401 · 403 · 200 · 404.** An organiser also gets **403** on another
organiser's order — ownership is checked before anything is read.

### Step 4 — Invitations link to the guest's own ticket

3. Pro → **Invitations**, pick an event with comps issued.

**✔️ The third column is headed "Billet"** — it used to say *"Porte"* (Gate),
which it has never held. The cell shows the ticket reference.

4. Click a reference.

**✔️ It opens the guest's ticket** in a new tab, carrying **their** access
token — so when someone says *"the link you emailed me doesn't work"*, you are
looking at exactly what they are looking at, not a different view of the same
ticket.

**✔️ Revoked rows show a red "Annulée"** instead of a link. A cancelled ticket
has nothing to open.

### Step 5 — An admin must say whose event

5. As **admin**, open Pro → **Placements** (and again → **Invitations**).

**✔️ Before anything loads:** *"Choisissez d'abord un organisateur"*, with no
event picker and the action button disabled.

6. Pick an organiser.

**✔️ The event picker appears**, their events load, the button enables. Switch
to an organiser with no events and you get *"Cet organisateur n'a aucun
événement."* — not an empty picker.

7. As **organisateur@eventick.ma**, open the same two pages.

**✔️ No organiser picker at all.** An organiser has one scope — their own — so
the event picker is step one.

> 💡 Elsewhere (Réservations, Événements, Finance) the organiser dropdown is an
> optional *filter*: "all organisers" is a sensible default for **reading**.
> Here it is a required **first step**, because adding a zone or issuing a comp
> is a *write* that inherits an owner — and `event.organiserId` decides who the
> payout pays, at which plan's rate, into which bank account. The server already
> insists a caller with `scope.any` names an owner; the UI now matches that
> instead of letting an admin discover it by hitting an error.

---

# 🖼️ CHECK 22 — Images on a CDN, email that actually sends

Both are live services, so this check costs real (tiny) resources. It is the
one check with no automated version — a suite that sends real email on every
run is worse than no suite.

### Step 1 — Upload a poster

1. Pro → **Événements** → edit any event → upload an image.

**✔️ The URL that comes back** starts with `https://storeno.b-cdn.net/events/`,
not `/uploads/`. Open it directly: the image loads from the CDN.

```bash
curl -s -X POST http://localhost:4100/api/uploads/image \
  -H "authorization: Bearer $TOKEN" -F "file=@poster.jpg;type=image/jpeg"
# -> {"url":"https://storeno.b-cdn.net/events/1793368756164-….jpg"}
```

> 💡 With no `BUNNY_STORAGE_KEY` the route falls back to local disk. That is
> not a nicety: it keeps the upload flow exercisable offline and in tests, and
> it means losing the CDN credentials degrades the app rather than breaking
> event creation outright. The existing security is unchanged — magic-byte
> sniffing, a MIME allowlist and random filenames.

### Step 2 — Issue an invitation to an address you can read

2. Pro → **Invitations** → **"Offrir des billets"** → one guest, your own email.

**✔️ The row shows "Envoyé"** — eventually. The email is sent *after* the
response returns, so the badge may read *"Non envoyé"* for a second or two.
Reload and it flips.

**✔️ The email arrives** from `Eventick <contact@storeino.com>` with:
- a **"Voir mon billet"** button → the live ticket page, QR and all
- the ticket reference
- a **"Télécharger le PDF"** link

3. Open that button's link in a private window — no account, no session.

**✔️ The guest's pass renders**: QR, *"Valide à l'entrée"*, their name, zone and
gate.

> 💡 This is the fix for a real dead end. A comp sits on an order the guest does
> not own, so they had **no credential for their own ticket** — the email could
> only quote a reference number, and even if they found the URL they would have
> got a 403. Comps now carry the same per-ticket token a gifted ticket gets,
> scoped to that one seat so it never unlocks the rest of the order.
>
> 💡 The PDF route had the same gap in reverse: it only ever checked the
> **order's** token, so a guest holding a valid ticket credential could see
> their pass on screen but got 403 downloading it — the one format they would
> actually take to the door. Shared/gifted tickets were affected identically.

### Step 3 — "Envoyé" means sent

**✔️ Remove `RESEND_API_KEY` from `backend/.env`, restart, issue another comp.**
The new row reads **"Non envoyé"** and stays that way.

> 💡 It used to say *"Envoyé"* regardless. `sendEmail` never throws — it returns
> `false` when the send is rejected or when no key is configured — and the code
> did `.then(() => markAsSent())`, which runs either way. Every guest showed as
> emailed on an installation that had never sent a single message. Put the key
> back before carrying on.

⚠️ **Before inviting real guests:** `PUBLIC_APP_URL` and `PUBLIC_API_URL` in
`backend/.env` still point at `localhost`. The links in the email are built
from them, so they work for you and for nobody else.

---


---
---

# ⏱️ CHECK 23 — Money figures for a period, not only forever

Every figure on Finance used to be LIFETIME: net revenue, refunds,
commission, per-event takings. That answers "how have we done ever", which
nobody asks twice, and left "how did October go" unanswerable.

### Step 1 — Narrow the period

1. Pro → **FINANCES → Finance**.

**✔️ You must see** a row of buttons above the figures: **Aujourd'hui ·
Cette semaine · Ce mois · Mois dernier · Cette année · Tout**. It opens on
**Ce mois**.

2. Click through them.

**✔️ The first three cards change**; the fourth does not.

| Card | Follows the period? |
|---|---|
| Recettes nettes | yes |
| Remboursé | yes |
| Commission Eventick | yes |
| **À reverser** | **no — and its sub-line says "Depuis le début"** |

> 🎯 A payout settles every outstanding order, not one month's worth. If "à
> reverser" narrowed with the period it would show a figure that is not what
> the next transfer pays — so it stays whole and says so, rather than leaving
> the mismatch to be noticed.

### Step 2 — The comparison, where it informs

**✔️ A card shows "+12%" style chips** when the previous period had sales,
and **no chip at all** when it had none.

> 🎯 "Up ∞%" from zero is a first sale, not a trend. A percentage that cannot
> inform is not shown.

> 💡 A PARTIAL month is compared against the SAME span of the previous one —
> eight days of October against the first eight days of September. Comparing
> it against all of September would read as a collapse every month until the
> 30th.

### Step 3 — The chart

**✔️ Under the cards, a bar per day** (per week beyond ten weeks — a year of
365 bars is unreadable). **"Tout" shows no chart**, having no start to count
from.

```bash
curl -s "http://localhost:4100/api/organiser/finance?period=month" \
  -H "authorization: Bearer ORGANISER_TOKEN" | jq '.period | {key, orders, grossCents, series: (.series|length)}'
```

**✔️ The bars sum to the period's gross.** The suite asserts this, so the
chart and the headline cannot drift apart.

### Step 4 — A stale bookmark does not 400

```bash
curl -s "http://localhost:4100/api/organiser/finance?period=decade" \
  -H "authorization: Bearer ORGANISER_TOKEN" | jq -r .period.key
# -> all
```

**✔️ An unknown period falls back to all time.** A bookmark from a renamed
period should show the dashboard, not an error.

> 💡 Morocco is UTC+1, so a local day starts at 23:00 UTC the day before. An
> evening sale belongs to the day it was made. Twenty-four unit tests cover
> that, the 31st-of-the-month case and the year boundary — `npm test`.

✅ **Check 23 done.**

---
---

# 🏷️ CHECK 24 — Plans: what they cost, and asking for a different one

A plan is pure pricing — a commission rate and a monthly fee, nothing gated.
Starter 5%, Pro 3% + 499/month, Business 2% + 1 999/month. An organiser could
see their own rate and nothing else, so nobody on the 5% default ever learned
the cheaper tiers existed.

### Step 1 — All three are visible

1. Pro → **Finance** → scroll to **Offre**.

**✔️ You must see** the current plan with a padlock, then **"Les autres
offres"** listing all three with their rates, the current one marked.

> 🎯 Only Eventick assigns a plan. An organiser setting their own rate was the
> original bug: the plan used to be three buttons that changed the displayed
> fee and nothing in the world.

> 💡 An **admin** reading someone else's books through the organiser filter
> sees the comparison but no **Demander** button — the request would be
> recorded against the admin's own account, not the organiser they are
> looking at.

### Step 2 — Ask for one

2. Click **Demander** beside Pro.

**✔️ The button becomes "Demandé · annuler".** The plan has NOT changed.

3. Look at the third plan.

**✔️ Its "Demander" button is gone.** One open request at a time, so the
UI offers no way to stack a second. The API refuses it too — **409** — which
is what matters, the hidden button being only a courtesy:

```bash
curl -s -X POST http://localhost:4100/api/organiser/plan-request \
  -H "authorization: Bearer ORGANISER_TOKEN" -H "content-type: application/json" \
  -d '{"planKey":"business"}' | jq -r .error
# -> You already have a plan request waiting for a decision
```

4. Ask for the plan you are already on.

**✔️ Refused — 409.** Compared against the plan you are EFFECTIVELY on:
`planId` is null for anyone nobody has assigned, and they are charged the
default, so the raw column would let someone on the default request the
default.

### Step 3 — An admin decides

5. Sign in as **admin** → **ADMINISTRATION → Plateforme**.

**✔️ A "Demandes d'offre" block appears above the seller list**, carrying the
rate — "wants Pro" means nothing without knowing Pro is 3% + 499.

6. Click **Accepter**.

**✔️ The organiser is moved**, their Finance screen shows the new rate, and
the queue empties. Deciding it twice is refused (409).

> 🎯 Approving performs the assignment itself. A queue that only marks things
> decided, relying on someone remembering a second step, is how an approved
> request never takes effect.

> 💡 It is journalled under the same action as a direct assignment, with the
> request id attached. A journal that split them by route would hide half the
> plan changes from anyone reading for "who moved onto Pro".

### Step 4 — The nudge, when the figures justify it

**✔️ Once a full month has passed with real volume**, the plan card says
which plan would have cost less, with the saving and the volume behind it.

| Volume last month | What it says |
|---|---|
| 10 250 MAD | nothing — Starter is already cheapest |
| 49 450 MAD | *"move to Pro, saves 490,00 MAD"* |
| 0 MAD | **nothing** |

> 🎯 That last row is the one worth understanding. Arithmetically an organiser
> on Business who sold nothing "saves" the whole 1 999 by dropping to Starter
> — true, and a terrible thing to tell someone still setting up. It fired for
> exactly that case in the live suite before the guard went in.

> 💡 It works DOWNWARDS too: an organiser whose volume fell is told they have
> outgrown a plan in the other direction. Advice that only ever sells upgrades
> is marketing.

✅ **Check 24 done.**

---
---

# 🏦 CHECK 25 — Who is owed what, and paying them

The admin page that lists everyone who sells showed lifetime revenue and
nothing about what was still OWED — so "who do I pay today" meant opening
each organiser in turn.

### Step 1 — The figure that answers the question

1. Admin → **Plateforme** → **"Qui vend"**.

**✔️ Each row carries "à reverser"** beside lifetime revenue, in green when
there is money waiting and grey at zero, plus the order count.

**✔️ A row with money owed and no RIB shows a "Pas de RIB" badge** — that one
needs chasing, not paying, because the payout would be refused.

2. Rank the list: **Recettes · À reverser · Remboursements · Événements**.

> 🎯 Ranking on revenue alone flatters whoever refunds the most, which is what
> the refund-rate column is for.

### Step 2 — It agrees with what is actually transferred

3. **Préparer un reversement** on a row with money owed.

**✔️ The net in the modal equals the "à reverser" in the list, to the cent.**
Both go through the same calculation against the same filter — settled, not a
comp, not already in a payout. The suite asserts they match rather than merely
resemble each other.

### Step 3 — An unfiltered admin sees the platform

4. Still as admin, open **Finance** with the organiser filter on **"Tous les
   organisateurs"**.

**✔️ Real figures, and every payout.** Not zeros.

> 🎯 This used to fall back to `req.user.id` — the admin's own id. An admin
> owns no events, so the screen showed 0,00 revenue and "aucun reversement"
> directly above a list of real orders, because the order table was already
> platform-wide. The two halves of the screen disagreed.

**✔️ Each payout row names who was paid.** An organiser reading their own list
does not get that field — repeating their own name on every row is noise.

### Step 4 — Bank details belong to the organiser

**✔️ The form prefills the holder and bank, and leaves the RIB empty**, with a
line saying why: the server returns only the last four digits, so the full
number must be re-entered.

> 🎯 An admin cannot type someone else's RIB. It is their account, and an admin
> retyping it is a worse place for a typo. The panel is read-only when an admin
> views another organiser through the filter.

✅ **Check 25 done.**

---
---

# 📬 CHECK 26 — A freed seat goes to the queue, not the public

A sold-out event is a dead end. The waitlist recycles seats that come free —
refunds, cancellations, abandoned checkouts, and seats an organiser ADDS.

### Step 1 — Join a sold-out event

1. Open a sold-out event as a stranger.

**✔️ No buy button — a waitlist form.** Join with any address.
Asking twice returns **409** — nobody can stack the queue.

2. Pro → **CATALOGUE → Offres**.

**✔️ The entry reads "En attente".**

### Step 2 — Free a seat by REFUNDING

3. **Réservations** → refund an order for that event → refresh **Offres**.

**✔️ The oldest entry flips to "Place réservée"** with an expiry 30 minutes
out, and an email goes out. Nobody pressed anything.

### Step 3 — Free a seat by ADDING one

4. Pro → **Placements** → raise that tier's capacity by 1 → save.

**✔️ The next person in the queue is offered it too.**

> 🎯 This was a real bug. Raising capacity put the new seats straight into the
> public catalogue, so anyone refreshing the page bought what the queue had
> been waiting for — the opposite of what a queue is for. Verified before the
> fix: capacity 2 → 4 with two people waiting left both WAITING and put two
> seats on public sale.

> 💡 Only an INCREASE offers. A decrease frees nothing, and re-offering on
> every save would mail the queue each time someone fixed a typo in a zone
> name.

### Step 4 — The hold is real inventory

5. While an offer is outstanding, try to buy that seat as someone else.

**✔️ 409 "Not enough tickets remaining".** An offered seat is subtracted from
public availability, so it cannot be bought out from under the person holding
it.

### Step 5 — Lapsing passes it on

The window is **30 minutes**; a sweeper runs every **5 minutes** inside the
server, expires stale offers and re-offers the seat to the next person.

```bash
cd backend && npx tsx ../scripts/demo-waitlist.mjs
```

**✔️ That script walks the whole cycle** — sells out a throwaway event, queues
three people, refunds one buyer, shows the automatic offer, proves nobody else
can take it, then backdates the offer and sweeps so the lapse is visible
without waiting half an hour. It deletes the event afterwards.

> ⚠️ **With no `RESEND_API_KEY` the waitlist silently does nothing useful.**
> The offer is still made and the seat still held, but the email is written to
> the log and dropped — so nobody learns they were offered a seat and every
> offer lapses. `.\payment-mode.ps1` reports whether email is live.

> 💡 A CANCELLED event offers nothing. `offerFreedSeats()` returns early
> unless the event is PUBLISHED, so calling an event off does not spray offers
> at a waitlist for a show that is not happening.

✅ **Check 26 done.**

---

# ⬆️ CHECK 27 — Moving zone: one way is free, the other costs money

"Changer de zone" goes both ways, and they are not symmetrical.

**Down** is immediate and refunds nothing — you give up the difference.
**Up** owes the difference, so it takes a card payment before the seat moves.

Tickets are final sale (check 2), so the downgrade really does keep your
money. That is the point of the warning you are about to see.

### Step 1 — Set up a ticket with somewhere to go

1. Pro → **Placements** → pick any event and give it **three** zones at
   different prices, e.g. Balcon **100**, Gradin **200**, Fosse **500**.
2. Sign in as a customer and buy **one Gradin** ticket.
3. Open it: **/billets** → the ticket → **"Gérer ce billet"**.

**✔️ You must see** a **"Changer de zone"** list with the other two zones,
each priced relative to the one you hold:

| Zone | What it says | Button |
|---|---|---|
| Balcon (cheaper) | **"Vous perdez 100,00 MAD — aucun remboursement"** in amber | Changer de zone |
| Fosse (dearer) | **"+300,00 MAD"** | **Surclasser** |

> 💡 The zone you already hold is not listed. Neither is any zone on a
> **comp** — an invitation is the organiser's to move, not the guest's.

### Step 2 — Going down: the forfeit is stated, not hidden

4. Press **Changer de zone** on **Balcon**.

**✔️ A dialog appears** — the app's own, not the browser's:

> **Changer de zone**
> Cette zone est moins chère que la vôtre. Vous perdez la différence, soit
> 100,00 MAD, qui ne vous sera pas remboursée. Le changement est définitif.
> `[ Annuler ]` `[ Changer et perdre 100,00 MAD ]`

5. Press **Annuler**. Nothing happens. Press it again and confirm.

**✔️ The ticket is now Balcon**, and **Pro → Réservations still shows the
order at 200,00 MAD**, not 100. No refund — that is the rule, stated before
you agreed to it.

> 🎯 This was a real bug twice over. The list used to say *"Sans
> supplément"* — true, and read as *"free"* by someone about to lose 700 MAD.
> Then the warning that replaced it was a raw `window.confirm`, which says
> **"localhost:3100 says"**, cannot be translated, and is suppressed outright
> by some mobile browsers — which would have moved the seat and taken the
> money with no prompt shown at all.

### Step 3 — Going up: it asks for the difference

6. Buy another **Gradin** ticket, open it, and press **Surclasser** on Fosse.

**✔️ A dialog appears** showing **300,00 MAD** — the difference, not the
500 the zone costs — and asks for name, email and phone.

7. Submit it.

**✔️ In mock mode** the upgrade completes at once and the ticket reads
**Fosse**. **With CMI configured** you get the hand-off button instead:
**"Payer 300,00 MAD"**, and the seat moves only once the gateway confirms.

**✔️ Pro → Réservations now shows TWO orders**: the original at 200,00 MAD,
untouched, and a second at 300,00 MAD for the upgrade.

> 💡 Why two orders rather than editing the first? Rewriting a settled order
> to make the sum come out right would falsify what was actually charged —
> and a payout is computed per order, from `total − refunded`. Two honest
> records beat one edited one.

### Step 4 — The seat is held while you are at the gateway

This is the part that matters, and it is invisible unless you look for it.

> ⚠️ **This step needs CMI configured.** In mock mode the upgrade settles the
> instant you submit, so there is no "away at the gateway" moment to observe —
> the dialog never pauses on a hand-off button. Run `.\payment-mode.ps1` to
> see which mode you are in.

8. Give Fosse a capacity of **2**. Upgrade one ticket into it (step 3), then
   start a second upgrade and **stop at the "Payer" button** — do not press it.
9. In another browser, open that event's page as a stranger.

**✔️ Fosse shows 0 remaining**, not 1. The seat you are about to pay for is
already subtracted from public availability.

10. Close the dialog without paying.

**✔️ Fosse returns to 1 remaining.** Backing out releases it immediately
rather than leaving it off sale for the 15-minute hold.

> 💡 Abandon the tab instead of closing the dialog and the seat still comes
> back — just later. The hold lapses after 15 minutes and the sweeper cancels
> the order on its next pass, the same path an abandoned cart takes.

> 🎯 Why this exists: CMI is a **redirect** gateway, so you are away on its
> page for as long as 3-D Secure takes. Without the hold, the last seat could
> sell while you were paying for it — and **CMI has no refund API**, so
> getting that money back means someone reversing it by hand in the back
> office.

### Step 5 — A full zone refuses, before any money

11. Fill Fosse completely, then try to upgrade another ticket into it.

**✔️ The button reads "Complet" and is disabled.** Forced through the API it
returns **409**, and nothing is charged.

```bash
# Nothing is offered that cannot be delivered.
curl -s "http://localhost:4100/api/tickets/TICKET_ID/options" \
  -H "Authorization: Bearer TOKEN" | jq '.exchange'
# -> each zone carries dueCents, forfeitCents and soldOut
```

### Step 6 — What is not an upgrade

12. Try to "upgrade" to a **cheaper** zone through the API.

**✔️ 400.** A downgrade owes nothing, so it must not be routed through a
payment flow that would charge 0 and still open a card page. `/exchange` does
those; `/upgrade` refuses them.

| Attempt | Result |
|---|---|
| `POST /tickets/:id/upgrade` to a cheaper zone | **400** — use /exchange |
| … to a zone at the same price | **400** |
| … to the zone it is already in | **400** |
| … by another signed-in user | **403** |
| … with the order link but no account | **401** |
| … on a ticket already scanned at the gate | **409** |

> 💡 The order link proves you *hold* a ticket, not that you may *spend* on
> it — the same rule as resale and giving a ticket away (check 2).

### Step 7 — Prove the gateway path end to end

The browser cannot show you what happens when a payment arrives late. This
can:

```bash
cd backend && npm run test:live:upgrade     # 30 checks, mock mode
```

With `CMI_CLIENT_ID` and `CMI_STORE_KEY` set, the gateway suite signs its own
callbacks — no tunnel, no real card:

```bash
cd backend && npm run test:live:cmi
```

**✔️ Its "Paying to move up a zone" section proves the money only moves when
the seat does:** the seat is reserved mid-payment, POSTAUTH moves the ticket
without minting a second one, a replayed callback takes the money again
without moving it twice — and when the zone fills while the buyer is paying,
the reply is **FAILURE**, the buyer keeps their original seat, the order is
not left looking PAID, and the organiser is not billed commission for a sale
that never happened.

✅ **Check 27 done.**

---
# ✅ Tick them off

| # | Check | Where to go | Done |
|---|---|---|---|
| 1 | **Buy with no account** | Public site → Explorer → checkout | ☐ |
| 2 | **The link's limits** | Ticket page → "Gérer ce billet" | ☐ |
| 3 | **Claim a guest order** | Ticket page → claim box → `/billets` | ☐ |
| 4 | **Give a ticket away** | Ticket page → "Offrir ce billet" | ☐ |
| 5 | **Gate scans once** | Pro → OPÉRATIONS → **Porte** | ☐ |
| 6 | **Publish an event** | Header → "Créer un événement" | ☐ |
| 7 | **Refunds and capability** | Pro → **Réservations** · **Permissions** | ☐ |
| 8 | **Become an organiser** | Header → "Créer un événement" as customer | ☐ |
| 9 | **Permission-driven sidebar** | Pro → ADMINISTRATION → **Permissions** | ☐ |
| 10 | **Platform console** | Pro → ADMINISTRATION → **Plateforme** | ☐ |
| 11 | **Three languages + RTL** | Account menu → **LANGUE** | ☐ |
| 12 | **Theme and no browser chrome** | Account menu → **"Passer en clair"** | ☐ |
| 13 | **Commission is server-side** | Pro → FINANCES → **Finance** | ☐ |
| 14 | **Payouts and the subscription** | Pro → ADMINISTRATION → **Plateforme** | ☐ |
| 15 | **Journal and account removal** | Pro → ADMINISTRATION → **Journal** · **Équipe** | ☐ |
| 16 | **Sales rules: cap and windows** | "Créer un événement" → **"Règles de vente"** | ☐ |
| 17 | **Calling an event off** | Pro → **Événements** → 🚫 icon | ☐ |
| 18 | **Invitations are not a sale** | Pro → CATALOGUE → **Invitations** | ☐ |
| 19 | **A closed zone says so** | Pro → CATALOGUE → **Placements** | ☐ |
| 20 | **Staff sell, customers buy** | Account menu → **"Mon compte"** · any event page | ☐ |
| 21 | **Detail pages** | Pro → **Réservations** → a buyer's name | ☐ |
| 22 | **CDN images + real email** | Pro → **Événements** (upload) · **Invitations** | ☐ |
| 23 | **Money by period** | Pro → FINANCES → **Finance** → period buttons | ☐ |
| 24 | **Plans and asking for one** | Pro → **Finance** → **Offre** · admin **Plateforme** | ☐ |
| 25 | **Who is owed what** | Pro → ADMINISTRATION → **Plateforme** → **Qui vend** | ☐ |
| 26 | **Freed seats go to the queue** | Pro → CATALOGUE → **Offres** · **Placements** | ☐ |
| 27 | **Moving zone, up and down** | Ticket page → **Changer de zone** / **Surclasser** | ☐ |

---

# 🤖 What the automated testing covers

Every check above runs against the live app before each release.

Last full run: **every suite green, zero failures**, against fresh servers and
a seeded database.

| Suite | Command | What it proves | Result |
|---|---|---|---|
| **`live-all-checks`** | **`npm run test:live:checks`** | **checks 1–19 in this guide, end to end** (20–22 are manual) | **116 / 116** |
| `vitest` | `npm test` | commission, pricing, inventory, ticket refs, the CMI hash | **123 / 123** |
| `live-api-test` | `npm run test:live` | the API surface end to end | **123 / 123** |
| `live-authz-test` | `npm run test:live:authz` | who may reach what, across roles | **54 / 54** |
| `live-guest-authz-test` | `npm run test:live:guest` | the boundary around a guest's link | **38 / 38** |
| `live-organiser-authz-test` | `npm run test:live:organiser` | each organiser capability is really enforced | **16 / 16** |
| `live-coverage-test` | `npm run test:live:coverage` | the routes the other suites do not reach | **77 / 77** |
| `live-orders-payments-test` | `npm run test:live:orders` | hold → pay → settle → refund → resell → commission → payout | **79 / 79** |
| `live-audit-test` | `npm run test:live:audit` | the journal, and the two ways an account is removed | **46 / 46** |
| `live-money-test` | `npm run test:live:money` | commission and payout rules on their own | all pass |
| `live-cmi-payment-test` | `npm run test:live:cmi` | the gateway: forged, tampered and late callbacks, and paying to move zone | all pass ¹ |
| `live-upgrade-test` | `npm run test:live:upgrade` | paying the difference to move into a dearer zone — check 27 | **30 / 30** |
| `live-share-test` | `npm run test:live:share` | giving a ticket away, and revoking the link | all pass |
| `live-refund-webhook-test` | `npm run test:live:refund` | a back-office refund voids the tickets | all pass |
| `live-sweeper-test` | `npm run test:live:sweeper` | lapsed holds release their seats | all pass |
| `live-ticketing-test` | `npm run test:live:ticketing` | the buyer cap, sales windows, cancellation and comps — checks 16–19 | **32 / 32** |
| `live-frontend-test` | `npm test` *(in `frontend/`)* | every API call the UI makes, through the Next.js proxy | **183 / 183** |

¹ Skips cleanly unless `CMI_CLIENT_ID`/`CMI_STORE_KEY` are set — the callback is
signature-verified, so there is nothing to test without a key.

```bash
# Everything, with both servers up. From backend/:
npm test                     # unit
npm run test:live            && npm run test:live:authz \
  && npm run test:live:organiser && npm run test:live:guest \
  && npm run test:live:coverage  && npm run test:live:share \
  && npm run test:live:sweeper   && npm run test:live:refund \
  && npm run test:live:money     && npm run test:live:orders \
  && npm run test:live:audit     && npm run test:live:ticketing \
  && npm run test:live:checks

# And from frontend/:
npm test
```

> ⚠️ **Two rate limiters will fail a long run, and it is not a real defect.**
> Sign-in is 10 per 15 minutes and organiser broadcast is 6 per hour; both are
> held **in memory, per process**, so running every suite back to back exhausts
> them and you see `429` where you expected `400` or `403`. **Restarting the
> backend clears both** — or raise `AUTH_RATE_LIMIT_MAX` and
> `BROADCAST_RATE_LIMIT_MAX` in `backend/.env` for the duration.

> 💡 **Suites clean up after themselves, including when they fail.** The money
> and orders suites purge their own leftovers at startup as well as at the end.
> That matters: a payout correctly sweeps up *every* unpaid order in its
> period, so one crashed run used to leave an order behind that made the *next*
> run fail for an unrelated reason.

### Defects these checks caught, and that are now fixed

1. **A guest could cancel, resell or give away any ticket** they had the id for — no token, no account. *(Check 2.)*
2. **The "Offrir ce billet" button silently failed** for guests: the frontend never sent the credential it had. *(Check 4.)*
3. **`finance.view` and `finance.refund` were enforced nowhere.** The toggles existed and did nothing — revenue stayed readable and refunds possible with both off. *(Check 7.)*
4. **Paying bounced the buyer to the catalogue** instead of the confirmation page, so a successful purchase looked like a failure. *(Check 1.)*
5. **"Créer un événement" was a dead end** for customers — a silent redirect to the homepage. *(Check 8.)*
6. **Any admin could mint another admin**, by creation or promotion. Now only the seed can. *(Check 9.)*
7. **The order id was treated as a credential**, exposing the buyer's name, email and phone to anyone with the link. *(Check 2.)*
8. **The commission was a browser calculation.** The organiser chose their own plan, `planCost()` ran client-side, and nothing was stored — so the fee changed on a click and reset on reload. *(Check 13.)*
9. **Revenue counted refunded money as earnings,** and charged commission on it. A fully refunded order vanished from the figure; a partially refunded one stayed at full value. *(Check 13.)*
10. **A resale earned the platform nothing.** Both resale settlement paths bypassed the one place commission was recorded, so Eventick brokered the sale, moved the seat, refunded the seller and took 0.00 MAD. *(Check 14.)*
11. **A quiet month refused its own payout.** 485 MAD of revenue against a 499 MAD subscription produced *"nothing to transfer"*, so over a 14 MAD shortfall the organiser got neither the money nor a record. *(Check 14, step 5.)*
12. **A CMI payment arriving after the hold lapsed** either took the money and issued nothing, or issued a ticket for a seat already resold. *(Covered by `live-cmi-payment-test`.)*
13. **Nothing recorded who did what.** Role changes, permission grants, refunds, plan assignments and payouts all happened silently. *(Check 15.)*
14. **A declined CMI payment could never be retried.** The gateway reference was the bare order id, so CMI refused the second attempt as an "ongoing transaction" and the buyer was stuck. Each attempt now carries its own suffix. *(Covered by `live-cmi-payment-test`.)*
15. **Five capabilities existed only in the API.** The buyer cap, resale switch, sales windows, event cancellation and comp tickets were all reachable by `curl` and by nothing else — an organiser had to accept the defaults forever. *(Checks 16–19.)*
16. **A zone could be created with a sales window that never opens.** `POST /tiers` accepted a window closing before it opened — a 201 and a zone that could never sell — while `PATCH` on the same field correctly refused it. *(Check 19, step 4.)*
17. **The sales-rules modal showed `undefined` as its labels.** The four copy keys went into the buyer-side dictionary instead of the dashboard one. A missing key is not a build error, so it rendered the word "undefined" in all three languages. *(Check 16, step 3.)*
18. **Escape closed the modal underneath a confirm dialog.** Cancelling an event is the only place that raises a confirmation from inside an open modal; both listened for Escape, and the modal answered first — leaving the confirmation floating over nothing. Escape could never *perform* the cancellation. *(Check 17, step 3.)*
19. **English numbers used a French separator.** The seat total read `139.939` in every language; to an English reader the dot is a decimal point, so the site appeared to sell a fraction of a seat. `locale === "ar" ? "ar-MA" : "fr-FR"` had been written out by hand in **eleven** places, every one routing English to a French formatter. *(Check 11, step 2.)*
20. **The e-ticket preview date was a hardcoded string.** `"28 JUIL · 21:00"` sat in the markup, so it stayed French in English and Arabic no matter what the formatter did. *(Check 11, step 2.)*
21. **"Démo organisateur" opened a sign-in form.** The button promised a demo and navigated to a gated route, so a signed-out visitor landed on `/login` with no demo and no way back. `?next=` is now honoured — restricted to same-site paths, because following a URL-supplied redirect blindly is a phishing primitive on a site that takes card payments.
22. **`POST /tiers` accepted a sales window that never opens.** Creating a zone skipped the inverted-window check that `PATCH` enforced, so a 201 could produce a zone that could never sell. *(Check 19, step 6.)*
23. **Fourteen of the twenty organiser write routes recorded nothing.** The audit vocabulary covered money, users and permissions and had no action for a price change, a capacity change or a door override — so the three most disputable things an organiser can do were the three with no trail. Re-admitting a spent ticket, repricing a zone that had already sold, and cancelling or deleting an order are now journalled; ordinary editing still is not. *(Section 8, and check 5 step 7.)*
24. **Undoing a wrong scan was only possible on the Orders desk.** It needed the ticket's internal id, which nobody has at a gate — the reference is what is printed on the ticket. `POST /gate/undo` now takes a reference, refuses anything that is not actually checked in, and records who reversed what. *(Check 5, step 7.)*
25. **Revenue could only be read for the whole account.** `/organiser/stats` summed every event an organiser owned and offered no way to narrow it, so someone running two shows could not tell how either had done. *(Check 7, step 4.)*
26. **An admin creating an event became its payee.** `organiserId` was copied from whoever was signed in, and `organiserId` is what decides who the payout pays, at which plan's rate, into which bank account — so an admin helping an organiser set up a show silently pointed the money at the platform. Neither the create nor the update schema accepted the field, so it could not be corrected afterwards: a `PATCH` carrying `organiserId` returned 200 and changed nothing. Fifteen of the sixteen seeded events were admin-owned, which modelled the mistake as if it were the design. An admin must now name an organiser, the target is checked to be one, and the seed hands every event to a real organiser. *(Check 6, steps 6–7.)*
27. **A cancelled event could be put back on sale, and refunded twice.** The dashboard's hide/restore eye wrote `status: PUBLISHED` unconditionally, overwriting `CANCELLED` — so cancelling an event, refunding every buyer and voiding every ticket, then clicking restore, returned it to the public catalogue and a fresh order went through end to end. Checkout never looked at `cancelledAt`; it refused these only by accident, via the status check. The double-cancel guard had the same flaw: hiding a cancelled event moved its status to `HIDDEN`, after which it could be cancelled again and refund buyers who had already been refunded. *(Check 17.)*
28. **Four cross-organiser 403 checks were asserting nothing.** They used a seeded event on the assumption that the demo organiser owned only some of them; once the seed was corrected the "foreign" event was the caller's own, and the suite was quietly comparing 200 against 200. It now creates an event owned by a second organiser. *(`live-api-test`.)*
29. **Typing one letter into any modal form lost focus.** Every call site passes `onClose={() => setOpen(false)}` — a new function each render — and the modal's focus-management effect listed `onClose` as a dependency. So each keystroke re-ran the effect, whose last act is `focus()` on the first focusable element: the close button. One character in, focus gone, second character dropped. It affected **every form in the app** behind a modal — issuing comps, adding a zone, editing an event, changing a role. Fixed in `Modal` with a ref rather than asking twenty call sites to remember `useCallback`. *(Check 18, and any modal.)*
30. **An invited guest could not reach their own ticket.** A comp sits on an order the guest does not own, so they had no credential for it: the email could only quote a reference number, and the ticket URL would have returned 403 even if they found it. Comps now carry the same per-ticket token a gifted ticket gets, and the email leads with a **"Voir mon billet"** button. *(Check 22, step 2.)*
31. **The ticket PDF refused a valid ticket credential.** `/tickets/:id/pdf` authorised against the **order's** token only, so a share recipient or an invited guest could see their pass on screen but got 403 downloading it — the one format they would take to the door. It now accepts a per-ticket token, which also fixes PDF downloads for every gifted ticket. *(Check 22, step 2.)*
32. **Every invitation showed "Envoyé" on an installation that had never sent an email.** `sendEmail` returns `false` rather than throwing — on a rejected send, or with no `RESEND_API_KEY` at all — and the code did `.then(() => markAsSent())`, which runs either way. The result was a guest list claiming everyone had been emailed when nothing had left the building. *(Check 22, step 3.)*
33. **A guest could silently forfeit money by changing zone.** Moving to a cheaper zone refunds nothing — deliberately, since refunding the difference would let someone buy the dearest seat and downgrade purely to extract cash. But the UI labelled it *"Sans supplément"* ("no extra charge"), which is true and reads as *"free"* to someone about to lose 700 MAD. The amount is now stated in amber and confirmed before the move. *(Check 20, step 5.)*
34. **An invited guest could downgrade the seat they were given.** Exchange was open to comp tickets, so a guest could move a 1.100 MAD invitation into a 400 MAD zone — deciding for the organiser what had been given away, with no price paid to measure the change against. Comps are now refused at the engine and offered no zones by the API. *(Check 20, step 4.)*
35. **Staff could buy tickets.** Nothing in the order routes consulted the caller's role, so an organiser could hold seats on a rival's sold-out event and an admin — who can see every order — could buy into an event they moderate. Blocked server-side on `/orders/hold`, `/orders/:id/pay` and `/resale/:token/buy`; guest checkout is deliberately untouched, since no session means no role. *(Check 20, step 3.)*
36. **An admin was shown a buyer's dashboard with nothing in it.** `/billets` offered ticket tabs, a "2026 spending" figure and a saved-events wishlist to accounts that sell rather than buy — a permanent `0 MAD` next to a permanent `0` tickets, which reads as broken rather than empty. Staff now get the identity page and the profile editor, which is the one thing on it they need. *(Check 20, step 1.)*
37. **An admin could add a zone or issue a comp without knowing whose event it was.** Placements and Invitations listed every event on the platform in one flat picker. Both are *writes* that inherit an owner — and `event.organiserId` decides who the payout pays, at which rate, into which bank account. The server already insisted a caller with `scope.any` name an owner; the UI let them discover that by hitting an error. Both pages now require the organiser first. *(Check 21, step 5.)*
38. **An order had no detail page at all.** Eleven dashboard sections, zero `:id` routes. A support call — *"my payment failed"*, *"I need a refund"* — had to be answered from a table row and a modal, with no way to see the payment reference, the per-ticket status and the audit trail together, and no URL to paste into a thread. `GET /organiser/orders/:id` and `/pro/orders/:id` now exist. *(Check 21.)*
39. **The invitations table labelled its reference column "Porte" (Gate).** It has never held a gate; it holds the ticket reference. Invisible while the table was empty, wrong the moment it had rows — which is exactly why it survived until real data went in. *(Check 21, step 4.)*
40. **A native `<select>` opened the browser's own popup over the dark dashboard.** The organiser filter on Réservations — and the rows-per-page, role and manifest pickers — rendered as a plain light list with OS highlight colours, ignoring the app's theme entirely the moment they opened. All four now use the shared `Dropdown`. `Dropdown` gained per-option `disabled` for the role picker, which must *display* an existing ADMIN without letting anyone pick it. *(Checks 7, 12.)*
41. **Replacing those selects broke their labels, invisibly.** A `<label>` wrapping a `<button>` trigger gives no implicit association, so the visible text and the accessible name became two strings that could drift. Fixed with `aria-labelledby` pointing at the text already on screen. The role picker also announced a bare *"change role"* on every row with no indication of **whose** — it now names the person.

---

# ❓ If something looks odd

| What you see | Why |
|---|---|
| **"Trop de tentatives"** on sign-in | 10 sign-ins / 15 min for the whole machine. Wait, or restart the backend. |
| Event names stay in French on the public site | They are database records with both languages — switch the interface to see Arabic |
| Some error messages appear in French | Server messages are not translated; the interface is |
| The ticket PDF is French even in Arabic | Deliberate — the PDF engine cannot shape Arabic text |
| A confirmation link shows nothing in another browser | Correct. The token is the credential; without it there is no access |
| **"Revendre ce billet"** is missing | You are not signed in, or the organiser has not enabled resale. That is check 2 |
| An event cannot be deleted | It has orders. Hide it instead — the history is real |
| The admin appears in "Qui vend" | Correct — it owns the 14 seeded events. The row shows its role |
| A floating **"N"** on the left edge | The Next.js dev indicator. Dev-only, never in production |
| **"Ce billet est déjà entré"** at the gate | Correct — one ticket, one entry |
| Seats "disappear" mid-test | Holds last 15 minutes. An abandoned checkout releases them |
| The plan on **Finance** has a padlock and cannot be changed | Correct. An admin assigns it — an organiser choosing their own rate was the bug |
| Changing a plan does not change the commission shown | Correct, and the point. The fee was recorded when each order was paid; only later sales use the new rate |
| A payout deducted **499 MAD** you were not expecting | The plan's monthly subscription, withheld once per calendar month that had sales. Starter is 0 |
| A second payout for the same month deducts **nothing** | Correct — the subscription is charged once per month, however many runs cover it |
| A payout nets **0.00** but still exists | That month's revenue did not cover its subscription. The fee took what was there; the record exists so the month is not billed twice |
| **"no bank details on file"** when running a payout | The organiser has not entered a RIB. A payout nobody can send reads as money already on its way |
| Only `**** 1234` comes back after saving a RIB | Deliberate. The full RIB is a payment credential; the screen showing earnings does not need it |
| A removed account still appears in the **Journal** | Correct, and the reason the journal exists — the record outlives the account |
| Removing an account says **"anonymised"**, not deleted | It has orders. They must survive, so the row stays with its personal data stripped |
| **429** instead of 400/403 while running the test suites | A rate limiter, not a defect. See the warning under *What the automated testing covers* |
| `test:live:checks` says *"Payments are in cmi mode, not mock"* | Correct, and it refuses to run rather than fail eight checks confusingly. `.\payment-mode.ps1 mock`, then **restart the backend** |
| `test:live:checks` says *"the seeded catalogue is intact — 0 events"* | Something deleted the catalogue. Run `npm run db:seed`. That assertion exists because a stray query once emptied it silently |
| A typed ticket reference works at the gate but the same string fails from a scanner | Correct. A typed ref is a staff override (`source: manual`); a camera scan must carry the ticket's signature. See check 5, step 5 |
| A zone shows **"Ouvre le …"** or **"Ventes closes"** | Its sales window is holding it back. The badge only appears when a window actually constrains the zone |
| A zone with no sales window shows **no badge at all** | Correct. Marking every unconstrained zone "En vente" would be noise — the useful signal is the one *not* selling |
| The time picker beside a sales date is **greyed out** | Pick the date first. A time with no date would be a bound that is silently never sent |
| **"Annuler l'événement"** (🚫) is missing from an event card | Either you lack `finance.refund`, or the event is already cancelled — there is nothing left to refund |
| Cancelling says **"Billets annulés"** without a number | Deliberate. The server's ticket count only covers the final sweep, and the refund has normally voided them already — so it reads `0` when everything worked |
| A **revoked invitation is still on the list** | Correct, and the point. "Issued, then revoked" is what the organiser needs to see; a row that vanishes looks like it never happened |
| An invitation consumed a seat | Correct. A comp takes capacity exactly like a sale — it just never becomes revenue |
| Revenue did **not** move after issuing invitations | Correct, and the whole reason comps are not a 100 % promo code |
| **"Publier"** refuses with *"La clôture doit être après l'ouverture"* | One of your sales windows closes before it opens. The base tier and the VIP tier have separate windows |
| An invitation row reads **"Non envoyé"** right after issuing | The email is sent after the response returns. Reload — it flips to "Envoyé". If it stays, the send genuinely failed (check `RESEND_API_KEY`) |
| An uploaded poster URL starts with **`/uploads/`** | Bunny is not configured, so the route fell back to local disk. Check `BUNNY_STORAGE_KEY` in `backend/.env` and restart |
| The organiser sees **no "Payer" button** on an event | Correct — staff sell, they do not buy. See check 20 |
| A comp ticket has **no "Changer de zone"** panel | Correct. An invitation is the organiser's choice to make, not the guest's |
| **Placements / Invitations look empty** as admin | Pick an organiser first. Both are writes that inherit an owner, so the page will not guess one |
| The event picker defaults to an event with **no data** | It picks the first event in the list, not the busiest. Switch events from the picker |

---

# ⚠️ Still open (not failures of the checks above)

Two kinds of thing are listed here, and the difference matters. **Deliberate
limits** are decisions with a reason — leave them alone unless the reason
changes. **Actual gaps** are work not done yet.

### Deliberate limits

- **Payments default to simulated.** With no `CMI_CLIENT_ID`/`CMI_STORE_KEY` no card is charged. Switch with `.\payment-mode.ps1 cmi` (or `mock`) from the project root — it comments the four `CMI_*` lines in place rather than swapping `.env` files, which is what used to drop the Resend and Bunny keys silently on every mode change. The CMI integration itself is complete — signed redirect, hash-verified callback, replay-safe settlement — but it needs real merchant credentials to exercise, and production refuses to boot without them.
- **Email and images are live services, not simulations.** `RESEND_API_KEY` sends real mail from `contact@storeino.com`; `BUNNY_STORAGE_KEY` puts real files on a CDN. Both degrade rather than break when unset — email drops to log-only, uploads fall back to local disk — which is how the flows stay exercisable offline. *(Check 22.)*
- **Refunds do not move money.** CMI has no refund API: `/organiser/orders/:id/refund` records the refund, voids the tickets and emails the buyer, but someone must then reverse the transaction by hand in the CMI back office. Use `/organiser/orders/:id/reconcile-refund` to sync the books after a reversal made there, since CMI notifies us of nothing.
- **A refused late payment leaves the order PENDING, not CANCELLED.** When the seats are gone the server declines the money and stops; the sweeper tidies the order up on its next pass (within five minutes). Nothing is charged in the meantime, but the order looks unpaid rather than explicitly failed until then.
- **Commission and subscription are withheld, not invoiced.** Both are real and computed server-side — the percentage is written onto each order when it settles, the monthly fee is charged per calendar month that had sales — but Eventick never issues an invoice or takes a card. Both are collected by being deducted from the payout, so an organiser with no payout due is never charged.
- **An organiser cannot change their own plan; they can only ask.** The rate
  decides what Eventick keeps, so letting the person it is charged to set it
  is not a plan at all. `POST /organiser/plan-request` queues the ask and an
  admin accepts or declines it on **Plateforme**; approving performs the
  assignment itself, so there is no second step to forget. *(Check 24.)*
- **Plan advice needs a month of evidence.** The nudge on the plan card
  compares last month's volume against all three plans, and says nothing at
  zero volume — arithmetically an organiser on Business who sold nothing
  "saves" the whole monthly fee by dropping to Starter, which is true and a
  terrible thing to tell someone still setting up. *(Check 24, step 4.)*
- **"À reverser" ignores the period filter, deliberately.** A payout settles
  every outstanding order, not one month's worth, so narrowing it with the
  period would show a figure that is not what the next transfer pays. The
  card says "Depuis le début" rather than leaving the mismatch to be
  noticed. *(Check 23, step 1.)*
- **A dormant month is not billed, and no debt accrues.** If a month's sales do not cover the plan's monthly fee, the shortfall is simply not collected rather than carried forward. Charging it would mean a debt model, which is a bigger decision than the payout run should make.
- **Payouts are a ledger, not a bank integration.** A run calculates what is owed and records the transfer, but nobody sends money automatically: an admin makes the transfer in their bank and pastes the reference back in. There is no bank API.
- **The journal records decisions, not everything.** Role changes, permission grants, refunds, plan assignments, payouts and account removal are recorded. Ordinary reads and CRUD are deliberately not: a log of everything is one nobody reads.
- **An account with money history is anonymised, not deleted.** Its orders, tickets and payouts have to survive — the organiser was paid for them — so the row stays with its personal data stripped. A true erasure would mean rewriting financial records.

### Actual gaps

- **The demo accounts use public passwords.** They are printed in this guide and in the seed. Change them before anything is deployed.
- **`PUBLIC_APP_URL` and `PUBLIC_API_URL` still point at `localhost` — and the server now refuses to start that way in production.** Both are baked into things that travel: the "Voir mon billet" button in an invitation email, the PDF link beside it, and the CMI redirects a buyer lands on after paying. `assertPublicUrls()` runs at boot alongside the payment and JWT guards and rejects localhost, a non-https host, or an ephemeral tunnel (`trycloudflare`, `ngrok`, …) in `CMI_CALLBACK_URL`. That last one is the worst of the set: CMI's callback is the only thing that issues a ticket, so a dead tunnel means a charged card and no ticket, with no error anywhere in this app. Development is untouched — localhost is correct there, and failing would make the app unrunnable for what it is for.
- **Checks 20–26 have no automated coverage of the screens.** They were added after `test:live:checks`. The logic underneath 23–26 is covered — 24 unit tests on the period windows, and `test:live:money` on the period figures, the plan arithmetic and the owed-versus-paid agreement — but nothing opens the pages. 22 can never be automated: it talks to Bunny and Resend, and a suite that uploads files and sends real email on every run is worse than no suite — it would need stubs, which is a different piece of work.
- **Invitation emails carry a reference and a link, not a QR image.** The guest clicks through to their pass or downloads the PDF. Fine for a phone; it does assume the guest can open a link at the door, which a printed-ticket culture may not.
- **The "Envoyé" badge does not refresh itself.** The email is sent after the response returns, so a freshly issued row shows "Non envoyé" until you reload. Harmless, and it looks like a bug the first time.
- **Upgrading a zone is still impossible.** `/tickets/:id/exchange` returns **402** with the amount owed, because no flow collects the difference. So "Changer de zone" today only ever moves a buyer *down*. Either build the upgrade payment or hide upgrade options — right now the UI disables them, which is honest but unexplained. *(Check 20, step 5.)*
- **`NEXT_PUBLIC_SITE_URL` must be the real domain — and a production build now fails without it.** It drives every canonical URL, `og:url` and sitemap entry. Left at its default, the sitemap advertises localhost to Google and the canonicals point somewhere unreachable: the site looks finished while being worse than before, and nothing surfaces it until someone wonders why indexing never started. `siteUrl()` throws during `next build` when the value is missing or contains `localhost`, so the failure lands at the moment it is cheapest to fix. Set it in `frontend/.env.local`, then submit `https://<domain>/sitemap.xml` in Search Console (still manual — it needs domain ownership).
- **Event structured data is built, and switched off.** `Event.seoIndexable` defaults to **false**, so no event carries schema.org `Event` markup until someone marks it real. All 16 seeded events are false, which is why the demo catalogue emits none. Flip it per event once an event is genuinely bookable — markup describing an unbookable event risks a penalty against the whole domain, not merely a missing rich result. (`WebSite`/`Organization` markup is unconditional: it makes no claim about any event.)
  - That flag is also what drives the demo-catalogue notice: while **no** event is marked real, every public page carries a banner saying the events and prices are examples. Publish one real event and the banner disappears by itself.
- **Three languages, three URLs.** `/fr/` and `/ar/` are real indexable routes with reciprocal `hreflang` (plus `x-default` on the unprefixed URL), declared both in each page's head and in `sitemap.xml`. An Arabic event page is genuinely Arabic before anyone clicks it: the title and description are built from the event's own `titleAr`/`venueAr`/`aboutAr` columns, not translated chrome around French text. Arriving on `/ar/` sets the language from the URL rather than from `localStorage`, so a crawler — or anyone opening a shared link — gets what was advertised.
  - **English deliberately has no route.** There are no English event columns, so an indexable `/en/` would serve French text under an hreflang promising English. `/en` returns 404 on purpose; the account menu still switches the interface to English, it just has no crawlable URL. Add `"en"` to `INDEXABLE_LOCALES` in `frontend/src/lib/locales.ts` in the same change that adds English event copy — and to `LOCALE_PREFIXES` in `backend/src/lib/cmi.ts`, or a buyer who paid in English returns to a 404 holding a charged card.
  - **The payment return path is wired.** `cmiUrls()` now prefixes `okUrl`/`failUrl` for `fr` and `ar`, so a buyer who paid in Arabic lands on the Arabic confirmation page. Still unexercised end to end against real money, for the same reason as everything else CMI.
- **City and category landing pages exist, for the cities and categories that earn one.** `/billets-ville/<city>` and `/billets-categorie/<category>` are real server-rendered pages with their own title, description, canonical and an HTML list of the actual events — unlike `?ville=`/`?cat=`, which a crawler cannot distinguish. A page is built only while it lists **2 or more** sellable events and 404s otherwise, so none of them is a near-empty doorway page. Today that is 3 cities (Rabat, Marrakech, Casablanca) and 4 categories; the rest appear by themselves as the catalogue grows. Raise `MIN_EVENTS` in `frontend/src/lib/landing.ts` if you want a stricter bar.
- **The waitlist is useless without `RESEND_API_KEY`.** The offer is still
  made and the seat still held for 30 minutes, but the email is written to
  the log and dropped — so nobody learns they were offered a seat and every
  offer lapses. The queue looks like it is working from the dashboard while
  achieving nothing. *(Check 26.)*
- **Nobody is told their plan request was decided.** Neither approval nor
  refusal sends an email. A refusal can even carry a note — the admin may
  type one and it is stored on the request — but nothing shows it to the
  organiser, who sees only that their ask disappeared. The note is written
  and never read, which is worse than not offering the field.
  *(Check 24, step 3.)*
- **Nothing purges the journal.** It only grows. Fine for now; it needs a retention policy before it is years old.
- **No bank integration.** A payout records what is owed and who sent it, but an admin makes the transfer by hand — see *Payouts are a ledger* above.
- **CMI now settles end to end on the TEST gateway, never yet with real money.** A payment completed on 03/11/2026 against merchant MTZON (600002996): CMI authorisation `366954`, Visa `**** 0010`, 850.00 MAD, order **PAID** and **two tickets issued**. The `HOST based messaging problem (99)` that blocked every earlier attempt needed two things — `TranType: preAuth` rather than `Auth` (the spelling Storeino's production gateway uses), and the standard CMI test PAN `4000000000000010` rather than a card from the MTZON kit. What is still untested is the PRODUCTION gateway, which is a different host and different credentials.
- **A sales window is wall-clock, read as UTC.** The window you type is stored exactly as typed and compared the same way, which keeps it consistent with the event's own start time. Morocco is UTC+1, so a window typed as `00:00` is not midnight local. Fine while both are naive; it needs real timezone handling before selling across timezones.
- **No UI shows a buyer *why* a zone is unavailable.** The dashboard says "Ouvre le …" and the server refuses the purchase, but the public event page does not yet explain that a tier opens later — it simply cannot be bought. *(Check 19, step 5.)*

Only the items under **Actual gaps** need work before going live. The
deliberate limits are documented here so nobody mistakes them for bugs — and
so a future change that wants to revisit one knows what it is arguing with.
