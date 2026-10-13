# server/kit — sign in with Google, a shop, and Stripe webhooks

A small backend for an app's website, served on the site's own origin under `api/`. It signs
people in with Google, sells what the app's catalogue lists through Stripe Checkout, and grants
a purchase only when Stripe's signed webhook says it was paid.

It is **off until you give it keys.** With no variables set (and on GitHub Pages, where no
function runs) `GET api/config` reports nothing configured, every other `api/` route is a 404,
and the page draws no Sign-in or Buy control. The app looks and behaves as it does today.

The same files are copied byte for byte into every repository that carries them. Do not edit a
repository's copy: change the canonical copy and copy it everywhere.

## Files

| File | What it is |
| --- | --- |
| `crypto.js` | base64url, hex, random ids, SHA-256, HMAC-SHA256, constant-time comparison |
| `http.js` | the router, JSON responses with the API headers, the capped body reader, cookies, the CSRF gate |
| `google.js` | OpenID Connect: authorize URL, code exchange (PKCE), ID-token verification against Google's keys |
| `stripe.js` | prices, Checkout and Customer Portal sessions, webhook signature check, event parsing |
| `store.js` | the `Store` interface (`get`, `put` with a TTL, `delete`; JSON values) and an in-memory store |
| `app.js` | `createApp(...)` → `handle(request) → Response`: sessions, users, entitlements and the routes |
| `cloudflare.js` | the Cloudflare Pages Functions entry (`pagesHandler`) and the KV store |
| `node.js` | the `node:http` adapter (`serve`), bound to 127.0.0.1, and the file store |
| `*.d.ts` | the declarations of each module, generated from its JSDoc, so a TypeScript app with `allowJs` off (notenote, tvsham's server, collectcollect) imports the kit with its types and no compiler setting changed. Never edited by hand: the canonical copy's workbench regenerates them and fails when they differ |
| `selftest.mjs` | `node --test server/kit/selftest.mjs`: every guard, against fake Google and fake Stripe |
| `package.json` | `{ "type": "module" }` only, so Node and TypeScript read these files as ES modules in a repository whose own package.json has no `type` |

Plain ES modules with JSDoc types and `// @ts-check`, no dependencies. Outside `node.js` and
the self-test the only host globals used are `fetch`, `Request`, `Response`, `URL`,
`crypto.subtle`, `crypto.getRandomValues`, `TextEncoder`, `TextDecoder`, `ReadableStream`,
`AbortSignal` (the 10-second limit on every call to Google and Stripe) and, in `cloudflare.js`
alone, `console` (the Functions log). Each is reached as `globalThis.<name>`, so the files lint
under a configuration that declares no environment.

## Configuration

Environment variables only: never in the repository, never sent to the page.

| Variable | Meaning | Checked as |
| --- | --- | --- |
| `APP_URL` | The site's public base URL **with** trailing slash: `https://chess.example.com/` or `https://example.com/chess/`. Every absolute URL the kit writes (the OAuth `redirect_uri`, Checkout's `success_url`/`cancel_url`, the portal's `return_url`) and the origin the CSRF gate expects come from this, never from `Host` or `X-Forwarded-*`. | canonical `https:` URL ending in `/`, no query, fragment or credentials; `http:` only for `localhost`/`127.0.0.1` |
| `SESSION_SECRET` | Signs the short-lived sign-in cookie. Make one with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. | base64url, at least 32 bytes |
| `GOOGLE_CLIENT_ID` | A Google OAuth client of type **Web application** whose authorised redirect URI is `APP_URL` + `api/auth/google/callback`. | `….apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | That client's secret. | 10–200 printable characters |
| `STRIPE_SECRET_KEY` | Prefer a restricted key (`rk_…`) with: Checkout Sessions write, Prices read, Customer portal write, Customers write. `sk_test_`/`rk_test_` is test mode, `sk_live_`/`rk_live_` live; a webhook whose `livemode` does not match is refused. | `sk_` or `rk_`, then `live_` or `test_` |
| `STRIPE_WEBHOOK_SECRET` | The signing secret (`whsec_…`) of the endpoint `APP_URL` + `api/webhooks/stripe`. | `whsec_…` |
| `STRIPE_PRICE_<PRODUCT>` | One Stripe Price id per catalogue product: product `pro` → `STRIPE_PRICE_PRO`, `pack-furniture` → `STRIPE_PRICE_PACK_FURNITURE`. A product without one is not sold. | `price_…` |
| `KIT_STORE` | Cloudflare only: the KV namespace **binding** (not a variable) the kit keeps its records in. | has `get`, `put`, `delete` |
| `KIT_DATA_DIR` | Node only: the directory the file store writes to. Outside the web root, writable by the service alone (the kit creates it 0700, files 0600). | required by `serve()` |
| `KIT_PORT`, `KIT_HOST` | Node only: where `serve()` listens. Default `8788` on `127.0.0.1`. | |

**What turns on.** Sign-in needs `APP_URL`, `SESSION_SECRET`, both Google values and a store.
The shop needs sign-in, the Stripe key, the webhook secret and a price for at least one product:
nothing is sold that cannot be granted. A partial configuration logs **one** warning naming
what is missing or malformed (never a value) and reports the feature off. A price that is
inactive, has no fixed amount (pay what you want, tiered), or does not fit its product (a
subscription needs a recurring price, a one-time product a one-time one) is logged, and that
product is neither listed nor sold. A price lookup that fails (Stripe unreachable) lists the
product without a price and is tried again after a minute.

## The catalogue

Each app passes its catalogue in; `createApp` checks it and throws on a malformed one (that is
a programming error, not input). `server/catalogue.js`, for example:

```js
export default {
  app: 'chesscheatser', // ^[a-z][a-z0-9-]{0,31}$: names the cookies, tags every payment
  name: 'Two Kings Chess',
  products: [
    {
      id: 'pro', // ^[a-z][a-z0-9-]{0,31}$; its price is STRIPE_PRICE_PRO
      name: 'Pro',
      description: 'Every board and piece set.',
      mode: 'payment', // 'payment' (once) or 'subscription'
      grants: 'pro', // the entitlement id `api/me` reports once it is paid for
    },
  ],
};
```

Several products may grant the same entitlement. Unknown fields are refused, so a typo
(`grant:`) fails at start-up rather than selling something that grants nothing.

## Hosting

**One origin per app is a security boundary.** The CSRF gate (below) tells a request from this
origin from one sent by another site, and the session cookie, a `__Host-` cookie and so
`Path=/`, goes with every request to the origin. So every page on the origin can act as the
signed-in visitor through `api/`: read their email (`GET me`), start a checkout, open the
Customer Portal (`POST portal` answers with a link that manages their billing: invoices, billing
address, payment method, cancellation) and delete the account. On an origin shared with other
sites (`https://example.com/chess/` beside another app at `https://example.com/other/`), each of
them can do all of that. Deploy under a sub-path only when every page on the origin is this
app's own, and treat third-party code the app runs on its pages (plugins, for one) as able to do
the same.

### Cloudflare Pages (the reference host)

One Pages project per app, each on its own origin. In the repository, `functions/api/[[path]].js`:

```js
import { pagesHandler } from '../../server/kit/cloudflare.js';
import catalogue from '../../server/catalogue.js';
export const onRequest = pagesHandler(catalogue);
```

In the build output, `_routes.json`, so static files never invoke the function:

```json
{"version":1,"include":["/api/*"],"exclude":[]}
```

Then, in the project's settings: the KV namespace bound as `KIT_STORE`, the variables above as
**encrypted** environment variables (Production and Preview separately; Preview with test keys),
and a custom domain. `APP_URL` is that domain. Every key the kit writes starts with the
catalogue's `app`, and every purchase record also with the Stripe mode it was written under
(`live` or `test`), so one namespace can be shared by two apps, or by Preview and Production,
without one reading the other's records, and the test purchases made before going live are never
read under the live key. Deleting an account is the one thing that crosses modes: it deletes the
visitor's records in both, so on a namespace Preview and Production share, a live subscription
that will charge again refuses Delete account on Preview as well (see Deleting an account). One
namespace per project is still the simplest to reason about.

**KV's daily allowance.** On the Workers Free plan KV allows 100,000 reads, 1,000 writes and
1,000 deletes a day, for the whole account: every app on it shares them (Cloudflare's KV pricing
page). Measured through the kit: a sign-in costs 1 read and 2 writes (2 reads, 2 writes and a
delete when the browser still holds a session), `GET me` 2 reads plus one per purchase the
visitor has made, `POST checkout` 3 reads (plus one per purchase) and 1 write, a paid
`checkout.session.completed` 3 reads and 3 writes, a refund 2 reads and 2 writes, an event the
kit ignores 1 read, sign-out 2 reads and 2 deletes. A few hundred sign-ins a day across all the
apps fit; past the allowance that kind of operation fails until 00:00 UTC, so a sign-in ends at
`?signin=failed` and a webhook is a 500 (Stripe retries, so a grant arrives late rather than
never). Move the account to Workers Paid before the shop goes live.

What Cloudflare's documentation says about the site's own host files (read from
`cloudflare/cloudflare-docs`, `src/content/docs/pages/`):

- `_headers` is **not** applied to responses a Function generates, even when the URL matches a
  rule (`configuration/headers.mdx`). The kit therefore sets its own headers on every response
  (below), and the site's policy stays on the static files.
- `_redirects` is **not** applied to requests a Function serves, even when the route matches
  (`configuration/redirects.mdx`): a site-wide rule cannot swallow `api/`. The same page lists
  rewrites with another status code (`/* /404.html 404`) as **unsupported** on Pages; Pages'
  own Not Found behaviour serves the nearest `404.html` (`configuration/serving-pages.mdx`), so
  a static path that does not exist still gets the site's 404 page.
- With a `functions/` directory every request invokes the Function unless `_routes.json`
  excludes it (`functions/routing.mdx`); Pages generates one if none is present, but the one
  above is explicit and limits invocations to `/api/*`. A path under `api/` that the kit does
  not know is the kit's JSON 404.

A site under a sub-path (`https://example.com/chess/`), on an origin whose every page is this
app's own (see the start of Hosting), moves the entry to `functions/chess/api/[[path]].js` and
the route to `/chess/api/*`; `APP_URL` carries the path.

### Self-hosted (Node behind nginx)

A start script per app, for example `server/start.mjs`:

```js
import { serve } from './kit/node.js';
import catalogue from './catalogue.js';
const { url } = await serve({ catalogue }); // KIT_DATA_DIR, KIT_PORT, KIT_HOST and the variables above from the environment
console.log(`api listening on ${url}`);
```

It listens on 127.0.0.1:8788 and keeps its records as one file per key under `KIT_DATA_DIR`
(the file name is the key's SHA-256, so no part of a key ever reaches the file system as a
path; each write goes to a temporary file that is flushed to the disk and renamed into place,
and the directory is flushed after it, so a webhook answered 200 survives a power cut). Run it
under a service manager as its own user, and **one process per data directory**: the kit
serialises each record's read-modify-write within its process only, so two processes on one
directory (two instances, or a new one started before the old one stopped) can lose each
other's updates. Restart by stopping the old process first. In the site's `deploy/nginx.conf`,
inside the HTTPS `server` block:

```nginx
# The app's API, on the same origin. ^~ wins over the regex locations that refuse dotfiles
# and repository files; proxy_pass has no URI, so the path reaches the kit unchanged.
location ^~ /api/ {
    proxy_pass http://127.0.0.1:8788;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    client_max_body_size 1m;
    proxy_read_timeout 30s;
    # One add_header here means none of the server block's is inherited, so the API's own
    # headers go out alone. Repeat the server block's Strict-Transport-Security line exactly:
    # this is the one every site's deploy/nginx.conf sends.
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
}
```

For a site under a sub-path (on an origin whose every page is this app's own, see the start of
Hosting) the location is `/chess/api/`. The kit sends its own API headers.
nginx gives a location the `server` block's `add_header` lines only when the location declares
none of its own; inherited here, they would be sent beside the kit's, and a browser reads the
last of two `Referrer-Policy` values (the site's `strict-origin-when-cross-origin` over the
kit's `no-referrer`, on the redirect to Google too) and the site's `Cache-Control` and policy
beside the kit's. The one `add_header` in the block above is what stops that. The kit never
reads `X-Forwarded-*`: it builds every URL from `APP_URL`, and rate limits key on the signed-in
user, which a client cannot choose.

A site whose own tests hold that no location adds a header (the rule that keeps a location from
dropping the server block's headers) takes this location as the one stated exception rather
than dropping the rule: the test allows exactly `location ^~ /api/`, holds that its one
`add_header` is the server block's Strict-Transport-Security line as written there, and still
refuses an `add_header` in every other location. A test that works out what nginx answers each
path with learns `^~` (the longest matching prefix wins over every regular expression when it
carries `^~`) and expects what is under `api/` to be proxied, neither served from the folder
nor refused.

**Apache:** `.htaccess` cannot proxy (`mod_proxy` is server configuration). In the virtual
host: `ProxyPass "/api/" "http://127.0.0.1:8788/api/"` with `mod_proxy` and `mod_proxy_http`.

### GitHub Pages, Netlify (static)

No functions run, so everything stays off and the page draws nothing. (Netlify Functions would
need `@netlify/blobs` for a store; not added.)

## Routes (under `APP_URL` + `api/`)

| Route | Does |
| --- | --- |
| `GET config` | `{ auth: { google }, shop: { products: [{ id, name, description, mode, price? }] } }`; `price` is `{ unit_amount, currency, interval?, interval_count? }` from Stripe, cached in memory for an hour (a failed lookup lists the product without it and is retried after a minute; a price Stripe answers with that is not usable leaves the product out). `Cache-Control: public, max-age=60`. |
| `GET auth/google/start?return=<path>` | 302 to Google (`response_type=code`, `scope=openid email`, `state`, `nonce`, PKCE S256, `redirect_uri` from `APP_URL`). State, nonce, verifier and return path travel in the `__Host-<app>-oauth` cookie (HttpOnly, Secure, SameSite=Lax, Path=/, 10 minutes), HMAC-signed with `SESSION_SECRET` and bound to its own expiry. A `return` that is not a path under the site becomes the site's root. |
| `GET auth/google/callback` | Checks the cookie, `state` (constant time) and the absence of `error`; exchanges the code (10 s limit); verifies the ID token (RS256 only, Google's keys, `iss`, `aud`, `azp`, `exp`/`iat` with 60 s skew, `nonce`). Mints a **new** session, clears the oauth cookie, sends the browser to the return path. Any failure: clears the cookie and sends the browser to `APP_URL?signin=failed`; nothing from Google is shown or logged. |
| `POST auth/logout` | Ends the session and clears its cookie. 204. |
| `GET me` | `{ user: { email? } \| null, entitlements: [ids] }`, `Cache-Control: no-store`. |
| `DELETE me` | Deletes every session of the user, the user records and the purchase records that point at them, in both Stripe modes (see Deleting an account). 204. 409 `{ error: 'subscription_active' }` while a subscription of theirs will charge again, in either mode: the visitor cancels it first. |
| `POST checkout` | `{ product }`. 401 signed out; 404 for a product not in the catalogue, not priced, or whose price is not usable; 409 when its entitlement is already held; 429 past 10 per user per hour; 502 when Stripe fails. Otherwise `{ url }`, a Stripe Checkout address; the session expires after an hour. |
| `POST portal` | `{ url }` of a Customer Portal session returning to `APP_URL`, for the Stripe customer of the first of the user's subscriptions that will still charge them, else the customer the user record keeps; 404 when the user has no Stripe customer yet. |
| `POST webhooks/stripe` | Stripe's webhook (below). |

Everything else under `api/` is a JSON 404; a known route with another method is a 405 with
`Allow`. Every response carries `Content-Type: application/json; charset=utf-8` (none on 204
and 302), `Cache-Control: no-store` (except `config`), `X-Content-Type-Options: nosniff`,
`Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'`,
`Referrer-Policy: no-referrer` and `Cross-Origin-Resource-Policy: same-origin`.

**CSRF.** Every POST and DELETE except the webhook must carry `Origin` equal to `APP_URL`'s
origin (no `Origin` is refused, 403). `POST checkout`, the one route that reads a body, must
say `Content-Type: application/json`; on the others a `Content-Type`, when sent, must be
`application/json` too (415). An HTML form always sends one of the three form types, so it
gets past neither. Same-origin `fetch` sends `Origin` on POST and DELETE by itself. The session
cookie's SameSite=Lax is a second line. Starting a sign-in is a GET: the state check at the
callback is what stops login CSRF. The gate tells this origin from another, not this app from
another page on the same origin: see "One origin per app is a security boundary" under Hosting.

## For the page

- On load (web build only), `GET api/config` relative to the page's base URL. A 404, a network
  error, a body that is not JSON, or `auth.google: false` with no products: the feature does
  not exist. Draw nothing, store nothing, retry nothing.
- Sign in: a top-level navigation to `api/auth/google/start?return=<current path and query>`.
  `?signin=failed` on return: say "Sign-in didn't complete." once, then remove the query with
  `history.replaceState`.
- Prices: `unit_amount` is in the currency's smallest unit as Stripe counts it: divide by 100
  for most currencies (cents for EUR and USD), by 1 for Stripe's zero-decimal currencies (JPY,
  KRW and the others on its list), so 499 JPY is ¥499, not ¥4.99, and by 1000 for its
  three-decimal ones (BHD, JOD, KWD, OMR, TND); then format with `Intl.NumberFormat`. The amount
  is in the Price's own currency: if Adaptive Pricing is on in the Stripe dashboard, Checkout may
  show the visitor a converted amount.
- Buy: `fetch('api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ product }) })`,
  then navigate to the returned `url` only if it starts with `https://checkout.stripe.com/`.
  After `?purchase=success`, poll `api/me` up to five times over fifteen seconds.
- Sign out, Manage subscription, Delete account: `POST api/auth/logout`, `POST api/portal`,
  `DELETE api/me`, with no body (or `{}` as JSON). A 409 `subscription_active` from Delete
  account means a subscription will charge again: say so, and offer Manage subscription (cancel
  there; at the end of the period is enough), then Delete account again. Manage subscription
  opens a subscription that will still charge, so a visitor who bought two before the first
  payment showed reaches the second the next time.
- Show server data as text, never as HTML. A cached copy of `me` may make the first frame right
  but never unlocks what the server has not reported. A client-side unlock gates a cosmetic: it
  is not protection, and the docs should say so.

## Webhooks

`POST api/webhooks/stripe` reads the raw body through the capped reader (512 KiB, with or
without `Content-Length`) before anything parses it; checks `Stripe-Signature` (a numeric `t`
within 300 s of now either way, and at least one `v1` equal, in constant time, to
HMAC-SHA256(`STRIPE_WEBHOOK_SECRET`, `t + "." + body`)), 400 with no detail otherwise; refuses
a `livemode` that does not match the key; answers an event id it has already processed with 200
and does nothing again; then:

- `checkout.session.completed` and `checkout.session.async_payment_succeeded`, when
  `payment_status` is `paid` or `no_payment_required`: grant `metadata.product` to
  `metadata.user`, only when `metadata.app` is this app, the product is in the catalogue, the
  user key has the right shape, `client_reference_id` agrees and the session's mode is the
  product's. The payment intent (or subscription) and the customer are recorded. An unpaid
  session waits for `async_payment_succeeded`; `async_payment_failed` does nothing.
- `charge.refunded` (the whole amount) and `charge.dispute.created`: revoke what that payment
  intent granted, even when the product is no longer in the catalogue. A reversal that arrives
  before the purchase is remembered, and the purchase then never grants. A dispute revokes when
  it is opened, inquiries included, and nothing restores it: a dispute the seller wins, an
  inquiry that closes, or a refund that fails leaves the entitlement revoked until the owner
  grants it again by hand (or the visitor buys again). This covers one-time purchases only: the
  payments of a subscription are made by Stripe's invoices, which the kit does not record, so a
  refunded or disputed subscription payment revokes nothing. Cancel that subscription in the
  dashboard; its `customer.subscription.deleted` revokes.
- `customer.subscription.updated` / `.deleted`: grant while `status` is `active` or
  `trialing`, revoke otherwise. An event older than the last one applied to that subscription
  is ignored, and one from the same second that would grant does not undo one that revoked.
  Once `canceled` or `incomplete_expired`, a subscription is final: no later event about it
  changes anything. A subscription grants its own product's entitlement whatever Price it is
  on, so leave plan switching off in the Customer Portal, or offer it only between Prices of
  one product; a grandfathered Price keeps working.

An entitlement holds while any purchase behind it holds: two payments for one product (two
Buy tabs both paid), or a subscription and a one-time product granting one entitlement, each
count, and refunding one leaves the other. Every other event type is acknowledged with 200. The
event is marked processed (30 days) only after it was applied; a store failure is a 500, so
Stripe retries. A completion whose session mode is not the product's (a `setup` session, say)
grants nothing.

The webhook trusts `metadata` because the kit wrote it when it created the session and Stripe
signed the event that carries it back; it trusts nothing the page sent at checkout beyond the
product id it checked against the catalogue. `metadata.app` matters when several apps share one
Stripe account: every endpoint receives every event of the types it subscribes to, and without
it a "supporter" bought in one app would unlock "supporter" in all of them.

## What is stored

Every key starts with the catalogue's `app` (`<app>:`); the purchase records, and what is
counted against them, with the Stripe mode as well (`<app>:<mode>:`, `live` or `test`, from
the key; `live` when no key is set).

| Key | Value |
| --- | --- |
| `<app>:session:<sha256>` | `{ user, email?, expires }`, 30 days. The cookie holds 32 random bytes; the store only their SHA-256, so a leaked store is not a login. The email is kept here alone, and only when Google says it is verified. |
| `<app>:sessions:google:<sub>` | `{ <sha256>: expires }`, the user's sessions (at most 20), so account deletion ends them all. Signing in and out write this and the session record, nothing else. |
| `<app>:<mode>:user:google:<sub>` | `{ refs: [record names], customer? }`: the user's purchase records and their Stripe customer in that mode. The user is Google's `sub`, never the email. Written by the webhook and by account deletion alone. |
| `<app>:<mode>:payment:<payment_intent>` | `{ user, product, grants, revoked? }` (a free checkout is recorded under its session id) |
| `<app>:<mode>:subscription:<id>` | `{ user, product, grants, customer?, status?, eventAt?, ending? }`; once its account is deleted, `{ status?, eventAt?, ending?, deletedAt }`, naming no one (see Deleting an account) |
| `<app>:<mode>:event:<id>` | processed marker, 30 days |
| `<app>:<mode>:ratelimit:<user>:<hour>` (and `…:portal`) | a count, 2 hours |

What a user holds is read from the purchase records each time (`GET me`, and the 409 at
checkout): a payment that has not been reversed, a subscription last known to be active or
trialing. Nothing a sign-in writes holds an entitlement, so nothing a sign-in writes can bring
one back or take one away.

What leaves the visitor's device, and only if they sign in or buy: Google tells the site an
account id and (if verified) an email; Stripe handles the payment. The site keeps the account
id, what was bought, and Stripe's customer id.

**Deleting an account** removes the sessions, the session index, the user records and the
payment records, in both Stripe modes; the payment itself stays with Stripe. It is refused (409
`subscription_active`) while a subscription of the visitor's will charge again (any status but
`canceled` or `incomplete_expired`, unless it is set to end with its period), in either mode:
the kit's records hold the only copies of the Stripe customer, so after deletion Manage
subscription could not reach it, and a new Buy would start a second subscription. On a
namespace Preview and Production share, a live subscription therefore refuses deletion on
Preview too; it is cancelled from Production's Manage subscription. A subscription record is
kept holding only its status, the time of its last event, whether it ends with its period and
the time of the deletion, naming no one (not its customer either): with no expiry for as long as
the subscription can still change (one set to end with its period may run on for a year), then
for 30 days after it is cancelled or expired, the time Stripe keeps an event it could resend. An
event about it in that time updates that state and still names no one, but for one kind: an
event created after the deletion, and after the last one applied, that says the subscription
will charge again and sets no end date (`cancel_at`). That is the visitor choosing to keep
paying (Renew in the portal tab they cancelled in, offered until the period ends; the owner in
the dashboard at their request; or the subscription's next period, when it was renewed before
the deletion and that reached the kit late), and the kit records it as theirs again from the
metadata it wrote at checkout: signed in again with the same Google account, they hold what it
grants, Manage subscription reaches it, a second one is not sold, and Delete account is refused
until it is cancelled again. So no event about it from before the deletion, which Stripe may
resend for days and in any order, and not its own last event, can grant it again or write the
account back. Any other event that says it may charge again keeps it naming no one and logs
a warning naming the subscription, for the owner to check in the Stripe dashboard: one from
before the deletion or from its second (a renewal the kit had not heard of when the account was
deleted, perhaps with a "set to end" after it still on its way), one from the same second as the
state it would overturn (their order is not known), or one that sets an end date (cancelling on
a date in the dashboard is not renewing). A renewal whose metadata names nothing the app sells
(edited in the dashboard, or a product since taken out of the catalogue) cannot be granted
either: it is kept naming no one, and each of its events logs a warning to cancel or refund it.
A purchase whose webhook had not arrived when the account was deleted (paid just before, or
delayed by Stripe's retries) is recorded when it does arrive, under the account its metadata
names, as any purchase is: it was paid for, and a subscription recorded so is reached by Manage
subscription and refuses the next deletion while it will charge. A subscription whose final
event never arrives (its webhook endpoint removed, say) keeps that state for good. Rate-limit
counters (which name the user) expire within two hours and are left to expire, so deleting an
account is not a way to reset the limit.

## Limits worth knowing

- **KV is eventually consistent**: a location that read a key keeps serving that read for up to
  a minute, whatever was written elsewhere, and of two writes to one key the last wins. It has
  no transactions and takes one write a second per key. So a grant or a revoke can take a
  minute to show where the visitor is (the page polls `me` after a purchase). Each purchase
  record is written only by the events about that one payment or subscription, and what a user
  holds is read from those records, so a stale copy cannot bring back a revoked entitlement.
  The user record, the index of a user's purchase records, is rewritten when a webhook adds a
  purchase to it: two purchases by one user whose webhooks are handled in two different
  locations within the same minute can each write it from a read that lacks the other, and the
  purchase that loses is then not shown (Stripe does not resend an event answered 200; the
  payment stays in the Stripe dashboard). Within one process (one isolate, the Node adapter)
  each record's read-modify-write is serialised, and Stripe's webhooks usually land in one
  location. The same applies to the session index: a session started in another location
  within the minute of a deletion may outlive it until it expires.
- The rate limit is a count read and written under the key's lock, so it is exact within one
  Node process or isolate; requests handled at once by two isolates can each pass one more. A
  count that cannot be written (KV's one write a second) is answered 429.
- Each Buy creates its own Checkout Session (the `Idempotency-Key` makes the kit's one retry
  after a dropped connection return the same session rather than a second one). A second
  purchase of a held product is refused with 409 once the first webhook has arrived. Before
  that, two Buy tabs can both be paid: for a one-time product, one charge to refund; for a
  subscription, two subscriptions that each charge every period, and under two Stripe
  customers, since Checkout makes a customer when it is given none and the kit learns the
  customer only from a webhook. Each subscription's record keeps its own customer, and Manage
  subscription opens the customer of the first that will still charge: once that one is set to
  end, the next Manage subscription reaches the other, so the visitor can cancel both, and Delete
  account (refused while either will charge) then works. Until they do, both charge: nothing on
  the page says they hold two, and the owner sees two customers in the Stripe dashboard, where
  one can be refunded.
- No Google or Stripe address is configurable. Tests inject their fakes through
  `createApp({ fetch })`.

## Testing

`node --test server/kit/selftest.mjs` runs the kit's own tests (no network): a fake Google whose
RSA key is made with Web Crypto and whose JWKS is served by the injected `fetch`, a fake Stripe,
webhooks signed with `node:crypto` independently of the kit's own HMAC, the memory store, the
file store, the KV store over a fake namespace (and over a model of KV in two locations, and one
that refuses a second write to a key within a second), the Pages handler, and the Node adapter
over a real loopback socket. The name keeps jest's and vitest's default globs off it.

## Owner's checklist

**Google Cloud**
1. A project, and the OAuth consent screen: app name, support email, privacy policy URL,
   authorised domain. `openid email` needs no verification review.
2. Credentials → OAuth client ID → **Web application**, with the authorised redirect URI
   `APP_URL` + `api/auth/google/callback` (for example
   `https://chess.example.com/api/auth/google/callback`). Its id and secret are
   `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

**Stripe** (test mode first; pay with `4242 4242 4242 4242`, any future date, any CVC)
1. A Product and a Price for each catalogue product; each Price id goes in
   `STRIPE_PRICE_<PRODUCT>`.
2. A webhook endpoint at `APP_URL` + `api/webhooks/stripe`, subscribed to
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `charge.refunded`, `charge.dispute.created`,
   `customer.subscription.updated` and `customer.subscription.deleted`. Its signing secret is
   `STRIPE_WEBHOOK_SECRET`.
3. A restricted key with Checkout Sessions write, Prices read, Customer portal write and
   Customers write: `STRIPE_SECRET_KEY`.
4. If anything is a subscription, configure the Customer Portal (leave plan switching off).
5. Repeat 1–3 in live mode with live keys when the test run is right. The test purchases stay
   in the store under `test` and are not read under the live key.

**Hosting**
1. A Cloudflare Pages project per app (its own origin) and a custom domain; `APP_URL` is it.
2. A KV namespace bound as `KIT_STORE`, and the account on Workers Paid before the shop goes
   live (the Free plan's 1,000 KV writes and 1,000 deletes a day are shared by every app on the
   account).
3. The variables above as encrypted environment variables, and `SESSION_SECRET` freshly made.
4. `_routes.json` in the build output, and `functions/api/[[path]].js` in the repository.

**Not covered:** the App Store and Google Play. Native purchases of digital goods need StoreKit
and Play Billing; the native builds keep their no-network posture and their mock store.
