# DOOAA API (`dooaa-server`)

The backend for **DOOAA.NG** — the marketplace (`dooaa-client`) and the management console (`dooaa-admin`).

- **NestJS 12** · TypeScript · **MongoDB** (Mongoose 9)
- **Socket.IO** realtime on `/realtime` (chat, typing, presence, live notifications)
- **nodemailer** for transactional email, **Termii** for SMS/WhatsApp codes
- **Paystack** executes every money movement (charges, refunds, seller payouts) — DOOAA never holds or moves money itself
- **Cloudinary** for uploads (images, videos with poster frames, private KYC documents)

---

## Run it

```bash
npm install
cp .env.development.example .env      # fill in Cloudinary keys (or STORAGE_DRIVER=local offline)
npm run start:dev                      # http://localhost:4000/api/v1  ·  docs at /docs
npm run seed                           # superadmin + demo buyer/seller/listings
```

Production:

```bash
cp .env.example .env                   # fill every value marked REQUIRED IN PRODUCTION
npm ci && npm run build
npm run seed:prod                      # creates the first console superadmin (needs SEED_SUPERADMIN_PASSWORD)
npm run start:prod                     # node dist/main
```

The server refuses to boot in production when a required secret is missing (database, JWT secrets, Paystack, Cloudinary, SMTP, Termii).

**Paystack setup:** in the dashboard set the webhook URL to `{APP_URL}/api/v1/payments/webhooks/paystack` and disable "OTP for transfers" so seller payouts can be automated.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run start:dev` | Watch mode |
| `npm run build` / `start:prod` | Compile to `dist/` and run it |
| `npm run seed` / `seed:prod` | Idempotent seed (superadmin; demo data with `SEED_DEMO=true`, refused in production) |
| `npm test` | All tests (unit + e2e) |
| `npm run test:unit` / `test:e2e` | One project |
| `npm run test:cov` | Coverage |
| `npm run typecheck` | `tsc --noEmit` |

The e2e suite boots the real app against an in-memory MongoDB (one database per test file), with email, SMS, storage and payments switched to in-memory/sandbox drivers. Nothing leaves the machine.

## Conventions

- Every response is `{ ok: true, data }` or `{ ok: false, error, code, details? }` — the `ApiResult<T>` shape both apps already use. `error` is user-facing copy; `code` is stable for branching (`TOKEN_EXPIRED`, `INSUFFICIENT_STOCK`, `OTP_INVALID`, …).
- Lists are pages: `{ rows, total, page, pageCount, pageSize, from, to }` (the console's "Showing 1 to 7 of 32").
- Money is Naira with at most two decimals, calculated in integer kobo internally.
- Enums are lowercase/kebab (`out-of-stock`, `slightly-used`); the apps map them to their labels.
- Dates are ISO strings in UTC; anything shown as a day or a clock (`04:15pm`) is computed in Lagos time.

## Auth

| Who | Header | Refresh |
| --- | --- | --- |
| Marketplace users | `Authorization: Bearer <access>` | `POST /auth/refresh` (body `refreshToken` or the `dooaa_rt` httpOnly cookie) |
| Console staff | `Authorization: Bearer <access>` (separate secret/audience) | `POST /admin/auth/refresh` (`dooaa_admin_rt` cookie) |

Access tokens last 15 minutes. Refresh tokens rotate on every use; replaying an old one revokes the whole sign-in. A ban or closure ends every session immediately; a suspension keeps the user signed in but limits them to their profile, sign-out and support. Passwords are bcrypt; OTPs are hashed, expire, have an attempt budget and a resend cooldown.

**Google / Facebook sign-in.** The client links to `GET /auth/oauth/:provider/start?next=/path`. The API redirects to the provider with a signed state bound to an httpOnly nonce cookie (blocks login CSRF). The provider then returns to `/auth/oauth/:provider/callback`, which redirects to the client's `/auth/callback?code=…`. The client trades that one-time, two-minute code with `POST /auth/oauth/exchange` for the usual `{ user, tokens }` plus `isNewUser` (send them to the role step) and `next`. Failures land on `/sign-in?error=CODE` (`OAUTH_CANCELLED`, `OAUTH_EMAIL_REQUIRED`, `OAUTH_EMAIL_UNVERIFIED`, `OAUTH_STATE_INVALID`, `OAUTH_FAILED`, `OAUTH_UNAVAILABLE`, `ACCOUNT_BANNED`, `ACCOUNT_CLOSED`). A provider identity links to an existing account by verified email. If that account's email was never verified, the provider's proof wins: the old password and sessions are revoked. Accounts created this way have no usable password until the owner sets one through "Forgot password".

## The money flow (third-party only)

1. **Checkout** (`POST /checkout` for the cart, `POST /checkout/escrow` for Buy-via-Escrow) reserves stock atomically, creates one order per seller (`awaiting-payment`) and asks the provider to start a charge. The response carries the provider's hosted `authorizationUrl` (and `accessCode`/`publicKey` for the Paystack popup).
2. **Payment** is confirmed only by the provider — the signed webhook or `POST /payments/:reference/verify` (both re-verify with Paystack, check amount and currency, and are idempotent). Orders then become `pending` with the escrow **funded**; the seller's earning is recorded as pending.
3. **Fulfilment**: seller confirms → ships (carrier + tracking) → buyer marks received (or seller marks a meetup handover delivered) → inspection window → buyer releases with an emailed/SMS code, or it auto-releases when the window closes.
4. **Refunds** (cancellation, dispute ruling, console) are executed by the provider's refund API; the order shows `refundStatus` until the provider confirms.
5. **Payouts**: released earnings become available; `POST /seller/payouts` (password re-confirmed) asks Paystack to transfer to the seller's bank (registered as a transfer recipient after the bank confirms the account name). Concurrent withdrawals can never overdraw (guarded atomic kobo updates).

`PAYMENT_PROVIDER=sandbox` replaces Paystack in development with the same flow and a hosted test page at `/api/v1/payments/sandbox/checkout/:reference`.

## Realtime (`/realtime`)

Connect with `io(API_ORIGIN + '/realtime', { auth: { token: accessToken } })` (user or staff token).

| Server → app | Payload |
| --- | --- |
| `message:new` | `{ conversationId, message }` |
| `message:updated` | `{ conversationId, message }` (meetup accepted/declined) |
| `conversation:updated` | the inbox row (preview, unread, escrow, offer) |
| `conversation:read` | `{ conversationId, readerId, at }` |
| `typing` | `{ conversationId, userId, name, typing }` |
| `notification:new` | a bell row |
| `order:updated` | `{ orderId, status, phase }` |
| `presence` (staff) | `{ id, kind, online }` |
| `dispute:message`, `dispute:updated` (staff) | dispute pane refreshes |

| App → server (acknowledged `{ ok, data \| error, code }`) | Body |
| --- | --- |
| `conversation:join` / `conversation:leave` | `{ conversationId }` |
| `typing` | `{ conversationId, typing }` |
| `message:send` | `{ conversationId, kind?, body?, mediaUrl? }` |
| `conversation:read` | `{ conversationId }` |
| `presence:query` | `{ ids }` |

## Uploads

- `POST /media` (multipart `file` + `purpose`) uploads through the API; the bytes are sniffed (a renamed script is rejected).
- `POST /media/uploads` → signed fields to upload straight to Cloudinary from the browser (large videos never touch the API) → `POST /media/uploads/confirm` registers it after Cloudinary confirms the format and size.
- Purpose `kyc` files are private: only reachable through 15-minute signed links.

## API map (`/api/v1`)

Full, interactive reference: **`/docs`** (Swagger; JSON at `/docs/json`).

- **Auth** `/auth/*` — sign-up, sign-in, refresh, sign-out(-all), OTP send/verify, forgot/reset password, verify password, role, me; social sign-in `/auth/oauth/providers`, `/auth/oauth/:provider/start|callback`, `/auth/oauth/exchange`
- **Account** `/me`, `/me/summary`, `/me/avatar`, `/me/notification-preferences`, `/me/password(/code)`, `/me/close`, `/me/payment-accounts`, `/me/verification`
- **Catalog** `/categories`, `/catalog/home`, `/products`, `/products/suggest`, `/products/:id`, `/products/:id/reviews`, `/sellers/:id/products`, `/sellers/:id/reviews`
- **Shopping** `/wishlist`, `/cart/*`, `/checkout`, `/checkout/escrow(/:productId/quote)`, `/payments/*`
- **Orders** `/orders` (list, recent, detail, cancel, request-cancellation, received, release code/release, reorder, review, dispute)
- **Seller** `/seller/summary`, `/seller/products/*`, `/seller/orders/*`, `/seller/earnings`, `/seller/payouts`, `/seller/reviews`, `/seller/analytics`
- **Messages** `/conversations/*`, `/offers/:id/(accept|decline|counter|withdraw)`, meetups
- **Disputes** `/disputes`, `/disputes/:id(/respond)`
- **Other** `/notifications/*`, `/content/:slug`, `/support/tickets`, `/analytics/visit`, `/settings/public`, `/health`
- **Console** `/admin/auth/*`, `/admin/dashboard/*`, `/admin/buyers`, `/admin/sellers`, `/admin/users/:id/status`, `/admin/verifications/*`, `/admin/listings/*`, `/admin/categories`, `/admin/escrows/*`, `/admin/payouts/*`, `/admin/disputes/*`, `/admin/content/*`, `/admin/settings/*`, `/admin/staff/*`, `/admin/audit`, `/admin/notifications/*`, `/admin/coupons`, `/admin/reviews/:id`, `/admin/support/tickets`, `/admin/media`, `/admin/system/jobs/run`

## Layout

```
src/
  bootstrap.ts            shared app setup (prefix, security, CORS, pipes, envelope, sockets)
  config/                 typed env config + production checks
  common/                 envelope, errors, auth decorators, domain vocabulary, money/date utils
  database/               index bootstrap, counters
  modules/
    auth, users, staff, otp, mail, sms, media, settings, audit
    categories, products, wishlist, cart, coupons
    payments (paystack + sandbox providers), orders (checkout, escrow, lifecycle), wallet (earnings, payouts)
    conversations, realtime, notifications, reviews, verification, disputes
    content, analytics, admin-users, support, jobs, account
  seed/                   idempotent seed (+ demo data)
test/                     e2e suites and helpers
```

## Deployment notes

- One process serves HTTP and WebSocket on `PORT`. Behind a proxy, enable WebSocket upgrades.
- Running several instances: everything that moves state is an atomic conditional update, so jobs and webhooks are safe to run concurrently. Socket.IO rooms are per-instance; add the Socket.IO Redis adapter if you scale out horizontally.
- Indexes are built on boot (including the catalog's text index) before the server starts serving.
