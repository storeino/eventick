# CMI test session — live and verified

> ✅ **A real payment completed end to end on 03/11/2026**, on
> `eventick.speedliv.com`, against merchant MTZON (600002996).
>
> | | |
> |---|---|
> | Card | `4000000000000010`, exp `12/2028`, CVV `000` |
> | CMI authorisation | `366954` · Visa `**** 0010` |
> | Amount | 850.00 MAD |
> | Result | order **PAID**, **2 tickets issued**, CMI TransId stored |
>
> Two things had to land together for this. Badr's change from
> `TranType: "Auth"` to **`preAuth`** (commit `c69a013`), which is the
> spelling the Storeino production gateway uses; and a card that CMI
> actually recognises — the standard test PAN above, not one from the
> MTZON kit.
>
> The `HOST based messaging problem (99)` that blocked every earlier attempt
> is gone. **Test cards are listed under "Buy a ticket in the browser" below.**

The admin's credentials are in. **No back-office step is needed**: the key
below is already set for this merchant, which is why it verifies.

> ⚠️ **Correction (02/11/2026).** An earlier version of this note said
> `600002996` was a *different* merchant from the MTZON account in the
> onboarding email. It is not. CMI's own payment page displays this merchant
> as **`MTZON (600002996)`**, so they are the same account — the `600001388`
> in the onboarding email is the one that does not match what we are using.
>
> This matters for the test cards: cards are provisioned per merchant, so
> cards issued for MTZON **should** work here. If they do not, the problem is
> the card's provisioning at CMI, not a merchant mismatch on our side.

---

## Live right now

| Piece | Value |
|---|---|
| Merchant id | `600002996` |
| Store key | `M1234567` |
| Gateway | `https://testpayment.cmi.co.ma/fim/est3Dgate` |
| Public callback | see `CMI_CALLBACK_URL` in `backend/.env` |
| Backend | `http://localhost:4100` — CMI mode, **not** mock |
| Frontend | `http://localhost:3100` |

**Verified end to end through the public tunnel — 19 checks, all passing:**

- the form is signed with `M1234567` and the hash recomputes independently
- amount `850.00` in MAD units, `TranType: Auth`, `currency: 504`
- an **unsigned** approval → refused
- an amount **tampered after signing** → refused
- a hash signed with the **wrong key** → refused
- after three forgery attempts: still `PENDING`, zero tickets
- a genuine approval → `ACTION=POSTAUTH`, order `PAID`, ticket issued, CMI's
  `TransId` stored, card metadata captured, commission recorded
- a **replay** → accepts the money, issues **no second ticket**
- a **decline** → refused, buyer can retry while the hold lasts

---

## Buy a ticket in the browser

1. Open **http://localhost:3100**
2. Pick an event → a tier → **Réserver**
3. Fill in Nom complet, E-mail, Téléphone (`0612345678` works) → submit
4. Click **"Payer … sur CMI"**

   *Not an auto-submit, on purpose: a page that jumps on its own looks like a
   hijack exactly when someone is about to type a card number.*

5. You land on **CMI's own 3-D Secure page** — their domain, their branding.
   Your card number never touches Eventick.
6. Pay with one of these. **Verified working against MTZON (600002996)** —
   the Visa is the one that completed the payment on 03/11/2026:

   | Card | Number | Expiry | CVV |
   |---|---|---|---|
   | **Visa** | `4000000000000010` | any future date | `000` |
   | Mastercard | `5453010000066100` | any future date | `000` |
   | Mastercard 3-DS | `5191630100004896` | any future date | `000` (auth code `123`) |

   Tick **"Confirmer l'acceptation des conditions générales"** — the form will
   not submit without it. Use an expiry well in the future: the dropdown
   defaults to a month that has already passed.

   These are the standard CMI test PANs, not cards from the MTZON integration
   kit (download auth `kitmtc` / `AK16M9`, if you ever need it). The kit was
   chased for days on the assumption its cards were the only ones provisioned
   for this merchant; they were not needed.
7. You return to `/confirmation/<order-id>` with your ticket.

### What to verify

| Where | What should be true |
|---|---|
| The CMI page | A different domain, their branding |
| After paying | Confirmation page, with a ticket |
| `/billets` | The ticket, with a QR |
| Pro → Réservations | The order reads **PAID** |
| Pro → Finance | Revenue up, and commission with it |

**The callback is what issues the ticket.** Landing on the confirmation page
with no ticket means the payment succeeded at CMI and the callback never
arrived — check the tunnel.

---

## Watching it land

```bash
tail -f "C:/Users/abdel/AppData/Local/Temp/claude/c--Users-abdel-OneDrive-Desktop-Storeino-Eventick/67468aa1-7949-4801-94d7-279aa4ed8da3/scratchpad/backend.log" | grep -i cmi
```

`CMI payment settled` — worked.
`CMI callback REJECTED — hash mismatch` — the key and `.env` disagree.

---

## If the tunnel dies

The quick tunnel has no uptime guarantee and takes a **new hostname every
restart** — it already died once during this session.

```bash
cd "C:/Users/abdel/AppData/Local/Temp/claude/c--Users-abdel-OneDrive-Desktop-Storeino-Eventick/67468aa1-7949-4801-94d7-279aa4ed8da3/scratchpad/tools"
./cloudflared.exe tunnel --url http://localhost:4100 --no-autoupdate --edge-ip-version 4
```

`--edge-ip-version 4` matters: without it, registration timed out here.

Put the new `https://…trycloudflare.com` URL in `CMI_CALLBACK_URL` in
`backend/.env` and **restart the backend** — `tsx watch` only watches `src/`.

---

## ⚠️ While CMI is live, most suites cannot pass

Expected, not a defect. `POST /orders/:id/pay` returns a **redirect form**
instead of settling, so anything that buys a ticket stops partway:

| Suite | In CMI mode |
|---|---|
| `test:live:cmi` | **passes** — it signs its own callbacks |
| `vitest` | **passes** — pure logic, no gateway |
| `orders`, `money`, `share`, `coverage`, `refund`, `ticketing`, `frontend` | stop at the first purchase |

Test CMI in the browser, then switch back to mock mode for the suites.

## Going back to mock mode

```bash
cd backend
cp .env.before-cmi .env   # saved before any CMI change
# then restart the backend
```
