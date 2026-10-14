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
| `config.js` | what is configured, with no state: `validateCatalogue`, `priceVariable`, `readConfig` (the environment read into what is on) and `safeReturnPath`, for a server that keeps its own accounts and does not run `app.js` (see Inside a server of your own) |
| `app.js` | `createApp(...)` → `handle(request) → Response`: sessions, users, entitlements and the routes; it re-exports everything in `config.js` |
| `cloudflare.js` | the Cloudflare Pages Functions entry (`pagesHandler`) and the KV store |
| `node.js` | the `node:http` adapter (`serve`), bound to 127.0.0.1, and the file store |
| `*.d.ts` | the declarations of each module, generated from its JSDoc, so a TypeScript app with `allowJs` off (notenote, tvsham's server, collectcollect) imports the kit with its types and no compiler setting changed. They are declarations, not sources: nothing compiles them, a repository with no TypeScript carries them as they are, and the byte-for-byte copy (and anything that pins its bytes) covers them with the rest. Never edited by hand: the canonical copy's workbench regenerates them and fails when they differ |
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
| `KIT_DATA_DIR` | Node only: the directory the file store writes to. Outside the web root, writable by the service alone (the kit creates it 0700, files 0600). | required by `serve()`; a server that calls `createApp` itself passes `createFileStore(KIT_DATA_DIR)` as its `store` |
| `KIT_PORT`, `KIT_HOST` | Node only: where `serve()` listens. Default `8788` on `127.0.0.1`. | |

**What turns on.** Sign-in needs `APP_URL`, `SESSION_SECRET`, both Google values and a store
(without one the warning says `no store (KIT_STORE on Cloudflare, KIT_DATA_DIR under Node)`).
The shop needs sign-in, the Stripe key, the webhook secret and a price for at least one product:
nothing is sold that cannot be granted. A partial configuration logs **one** warning naming
what is missing or malformed (never a value) and reports the feature off. A price that is
inactive, has no fixed amount (pay what you want, tiered), or does not fit its product (a
subscription needs a recurring price, a one-time product a one-time one) is logged, and that
product is neither listed nor sold. A price lookup that fails (Stripe unreachable) lists the
product without a price and is tried again after a minute; one Stripe has not answered within
2.5 seconds is left out of that `GET config` (see Routes) and fills the price in when it does.

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
visitor has made, `POST checkout` 5 reads (plus one per purchase, and one more once the session
it gave before was paid) and 2 writes (1 write when it gives back the session it made before), a
paid `checkout.session.completed` 4 reads and 3 writes, a refund 2 reads and 2 writes, an event
the kit ignores 1 read, sign-out 2 reads and 2 deletes. A few hundred sign-ins a day across all the
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

Beside it, `server/package.json` holding `{"type":"module"}` (or name the catalogue
`catalogue.mjs`). The catalogue is an ES module; in a repository whose own `package.json` has no
`type` (every Expo app), Node 22 reads `server/catalogue.js` as CommonJS first, then again as a
module, and prints a `MODULE_TYPELESS_PACKAGE_JSON` warning on every start. The kit's own
`package.json` covers `server/kit/` alone.

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
    # With the API not running, nginx's own 502 (504 when it does not answer in time) would go
    # out with that one header. This answers with the site's not-found page instead, its status
    # kept, served by the site's own location with every header of the server block. No
    # proxy_intercept_errors: the kit's own answers (its JSON 404, 401, 409) pass through.
    error_page 502 504 /404.html;
}
```

For a site under a sub-path (on an origin whose every page is this app's own, see the start of
Hosting) the location is `/chess/api/` and its error page `/chess/404.html`. The kit sends its
own API headers. A site that does not run the API deletes the block, and its allow-list of the
site's paths then serves the static `api/config` (see GitHub Pages, Netlify), which it must
list.
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

**Apache:** `ProxyPass` is server configuration, so the API goes in the virtual host, with
`mod_proxy` and `mod_proxy_http`:

```apache
ProxyPass "/api/" "http://127.0.0.1:8788/api/"
ErrorDocument 502 /404.html
ErrorDocument 503 /404.html
ErrorDocument 504 /404.html
```

With the `ProxyPass` and no process behind it Apache answers 503 with its own page and none of
the site's headers; the `ErrorDocument` lines answer with the site's not-found page instead, the
status kept (no `ProxyErrorOverride`, so the kit's own answers pass through). An `.htaccess` can
proxy as well, through `RewriteRule ^api/(.*)$ http://127.0.0.1:8788/api/$1 [P,L]`, where
`mod_proxy` and `mod_proxy_http` are loaded and the directory allows it; the virtual host is
still the place for it, beside its `ErrorDocument` lines, where a site's own tests can read it.

### GitHub Pages, Netlify (static)

No functions run, so everything stays off and the page draws nothing. (Netlify Functions would
need `@netlify/blobs` for a store; not added.) The page's one `GET api/config` is then a 404,
which a browser logs as an error on every visit. Publishing a file at `api/config` with what the
kit answers when nothing is set, exactly

```json
{"auth":{"google":false},"shop":{"products":[]}}
```

answers it instead (a test can hold the file equal to `createApp` with an empty `env`). Where the
API runs, its route answers in the file's place: Cloudflare Pages invokes the Function for
`/api/*` (`_routes.json`), nginx and Apache proxy `api/`. A static host serves a file with no
extension under whatever type it chooses; the page reads it with `fetch` and parses the body,
which does not look at the type.

### Inside a server of your own

A server that already answers other routes (tvsham's) mounts `createApp(...).handle` for
`api/` paths and hands it the web `Request`:

- **Headers.** The kit sets its own on every answer (`Cache-Control` among them: `no-store`, or
  `public, max-age=60` on `config`, or `no-store` on a `config` answered without a price). A
  framework middleware that sets headers after the handler replaces them; let the kit's through,
  or set the same values.
- **Order.** Mount it after any gate that refuses a foreign `Origin` (the kit makes the same
  check on every write, and refusing earlier costs nothing), and before any gate that wants a
  bearer token or the server's own session: Google sends the browser back by a navigation and
  Stripe posts from its own servers, and neither carries one.
- **The store.** Pass `createFileStore(KIT_DATA_DIR)` from `node.js` as `store` (one process per
  directory), and call its `sweep()` now and then, as `serve()` does every hour, to remove expired
  records.
- **The proxy.** The nginx location above is safe as written in front of the kit's own Node
  adapter, which answers the kit's routes and nothing else. In front of a server that answers
  other routes it is not: nginx takes a backslash in the path for an ordinary character and
  passes the target on as written, while a WHATWG URL parser reads it as a slash, so
  `/api/..\..\health` reaches the server's `/health`. Such a location refuses one, and, where the
  server reads `X-Forwarded-For`, appends the address nginx saw rather than passing on the
  client's own:

  ```nginx
  if ($request_uri ~ "^[^?]*\x5c") { return 400; }
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  ```

  The kit itself reads no `X-Forwarded-*`.
- **Your own accounts.** A server that keeps its own accounts and sessions and uses the kit's
  `google.js`, `stripe.js`, `crypto.js` and `http.js` from inside its stack imports
  `validateCatalogue`, `priceVariable`, `readConfig` and `safeReturnPath` from `config.js`, which
  holds no state and imports no store, rather than from `app.js`.

## Routes (under `APP_URL` + `api/`)

| Route | Does |
| --- | --- |
| `GET config` | `{ auth: { google }, shop: { products: [{ id, name, description, mode, price? }] } }`; `price` is `{ unit_amount, currency, interval?, interval_count? }` from Stripe, cached in memory for an hour (a failed lookup lists the product without it and is retried after a minute; a price Stripe answers with that is not usable leaves the product out). It waits for Stripe 2.5 seconds at most (the page asks before it draws): a price not known by then is left out of that answer, which then carries `Cache-Control: no-store`, and its lookup goes on (under Cloudflare's `waitUntil`) and fills it in. Otherwise `Cache-Control: public, max-age=60`. |
| `GET auth/google/start?return=<path>` | 302 to Google (`response_type=code`, `scope=openid email`, `state`, `nonce`, PKCE S256, `redirect_uri` from `APP_URL`). State, nonce, verifier and return path travel in the `__Host-<app>-oauth` cookie (HttpOnly, Secure, SameSite=Lax, Path=/, 10 minutes), HMAC-signed with `SESSION_SECRET` and bound to its own expiry. A `return` that is not a path under the site becomes the site's root. |
| `GET auth/google/callback` | Checks the cookie, `state` (constant time) and the absence of `error`; exchanges the code (10 s limit); verifies the ID token (RS256 only, Google's keys, `iss`, `aud`, `azp`, `exp`/`iat` with 60 s skew, `nonce`). Mints a **new** session, clears the oauth cookie, sends the browser to the return path. Any failure: clears the cookie and sends the browser to `APP_URL?signin=failed`; nothing from Google is shown or logged. |
| `POST auth/logout` | Ends the session and clears its cookie. 204. |
| `GET me` | `{ user: { email? } \| null, entitlements: [ids] }`, `Cache-Control: no-store`. |
| `DELETE me` | Deletes every session of the user, the user records, the purchase records that point at them and the Checkout Sessions remembered for a second Buy of each product the catalogue lists, in both Stripe modes, whether the shop is on or not (see Deleting an account). 204. 409 `{ error: 'subscription_active' }` while a subscription of theirs will charge again, in either mode: the visitor cancels it first. |
| `POST checkout` | `{ product }`. 401 signed out (and when the account was deleted while the press was under way); 404 for a product not in the catalogue, not priced, or whose price is not usable; 409 `already_owned` when its entitlement is already held; 409 `subscription_active` when it is not held but a subscription of the visitor's to it will still charge (past due, unpaid, paused or incomplete: it is active again once paid or resumed); 409 `payment_pending` when the Checkout Session the visitor was given for it has been paid and the purchase is not recorded yet, where the request is handled; 429 past 10 per user per hour (each press that asks Stripe counts); 502 when Stripe fails, and to a press that reaches Stripe while a press that read the same is still having its session made (see Limits). Otherwise `{ url }`, a Stripe Checkout address: the session given for that product before, while it is still open, else a new one, which expires 55 to 60 minutes after it is made. |
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
  After `?purchase=success`, poll `api/me` up to five times over fifteen seconds. A second Buy
  before the webhook (another tab, the page back from Checkout, a reload) is given the same
  session while it is open, so only one can be paid; once it is paid, Buy answers 409
  `payment_pending` until the purchase is recorded where the request is handled: say "Payment
  received. It can take a minute to appear — reload to check." A 409 `subscription_active` means
  a subscription to it is past due or paused and will charge again once paid or resumed: offer
  Manage subscription rather than Buy. A 409 never comes with a Checkout address, so a page that
  reads every 409 as owned offers no second payment. Send one Buy at a time: keep the control
  disabled while a press is out, so a double click sends one. Two presses sent at once are still
  given one session wherever they are handled, but the one that reaches Stripe while the other's
  session is being made is answered 502 (pressed again, it is given that session), so read a 502
  as "try again" (on KV a press whose count is written within a second of another's is answered
  429 first: see Limits). Two payments for one product take presses that read different states, each
  then paid: two browsers or devices signed in to the account at once, or presses on either side
  of a five-minute boundary (see Limits). For the same reason, send Delete account only while no
  Buy is out.
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
  product's. The payment intent (or subscription) and the customer are recorded. The session the
  visitor was given for the product stays remembered: a second Buy reads this purchase record
  through it (POST checkout). An unpaid session waits for `async_payment_succeeded`;
  `async_payment_failed` grants nothing and lets that session go (its id is kept for an hour,
  marked failed), so the visitor can pay another way.
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
Buy presses that read different states, both paid; see Limits), or a subscription and a one-time
product granting one entitlement, each
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
| `<app>:<mode>:user:google:<sub>` | `{ refs: [record names], customer? }`: the user's purchase records and their Stripe customer in that mode. The user is Google's `sub`, never the email. Written by the webhook and by account deletion, and by Buy or Manage subscription only to forget a customer Stripe no longer has. |
| `<app>:<mode>:payment:<payment_intent>` | `{ user, product, grants, revoked? }` (a free checkout is recorded under its session id) |
| `<app>:<mode>:subscription:<id>` | `{ user, product, grants, customer?, status?, eventAt?, ending? }`; once its account is deleted, `{ status?, eventAt?, ending?, deletedAt }`, naming no one (see Deleting an account). Either way kept with no expiry while the subscription can still change, then 30 days once it is cancelled or expired |
| `<app>:<mode>:checkout:<user>:<product>` | `{ id, url }`: the Checkout Session the visitor was last given for the product, 30 days; once its delayed payment fails, `{ id, failed: true }` for an hour; deleted with the account |
| `<app>:<mode>:event:<id>` | processed marker, 30 days |
| `<app>:<mode>:ratelimit:<user>:<hour>` (and `…:portal`) | a count, 2 hours |

What a user holds is read from the purchase records each time (`GET me`, and the 409 at
checkout): a payment that has not been reversed, a subscription last known to be active or
trialing. Nothing a sign-in writes holds an entitlement, so nothing a sign-in writes can bring
one back or take one away.

What leaves the visitor's device, and only if they sign in or buy: Google tells the site an
account id and (if verified) an email; Stripe handles the payment, and is told the account id
(`google:<sub>`) with it, as the Checkout Session's `client_reference_id` and in the metadata
copied onto the payment or subscription, which is how the webhook finds the account. The site
keeps the account id, what was bought, Stripe's customer id, and the email in the session
record while the visitor is signed in.

**Deleting an account** removes the sessions, the session index, the user records, the payment
records and the Checkout Sessions remembered for a second Buy, in both Stripe modes; the payment
itself stays with Stripe, with the account id it was made under. It is refused (409
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
account back (within one process; across KV's locations, see Limits). Any other event that says
it may charge again keeps it naming no one and logs
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
account is not a way to reset the limit. Within one process (one isolate, the Node adapter) the
deletion reads and rewrites each record under that record's lock, as the webhook writes it, so
an event handled while the deletion runs is applied wholly before or wholly after it, and the
webhook adds a purchase to the user record only while the purchase still names the account. A
Buy that took its product's turn first (it holds it while it asks Stripe) is waited for, and its
session let go with the rest; one that reaches its turn while the deletion holds it, or after
(its sign-in read before, its body or the price still on the way), waits, finds the sign-in
ended, is answered 401 and makes nothing. None of that reaches past the process: Delete account
waits only for a Buy handled by its own isolate (or Node process). A Buy handled at the same
moment by another isolate, or in another KV location, can make its Checkout Session after the
deletion has looked for the markers: its marker then names the account until it expires, 30
days after that Buy, its Checkout address can be paid for the hour the session lasts, and a
payment made there is recorded under the account, as any whose webhook arrives after a deletion
is. A page that sends Delete account only while no Buy is out leaves this to two tabs or devices.
The remembered Checkout Sessions are looked for under every product the catalogue lists, whether
the shop is on or not; one remembered for a product since taken out of the catalogue is not
found, and names the account (and a Checkout address) until it expires, 30 days after the Buy
that made it.

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
  each record's read-modify-write is serialised, Delete account included, and Stripe's webhooks
  usually land in one location. The same applies to the session index: a session started in
  another location within the minute of a deletion may outlive it until it expires. And to
  Delete account itself: an event about one of the visitor's subscriptions handled where
  webhooks land within the minute after the deletion was handled elsewhere can still read the
  subscription's record as naming the account and write it back so (with its Stripe customer),
  and a later event about it can write the user record back. A later deletion reaches neither,
  since it starts from the user record. The subscription's record goes 30 days after the
  subscription ends, like any; a user record written back stays until the owner removes it.
- The rate limit is a count read and written under the key's lock, so it is exact within one
  Node process or isolate; requests handled at once by two isolates can each pass one more. A
  count that cannot be written (KV's one write a second) is answered 429.
- One Checkout Session per visitor and product at a time: a second Buy is given the open session
  again, and once it is paid is refused for as long as what it bought holds: 409 `payment_pending`
  while its purchase record is not there (the webhook has not arrived, or the location handling
  the press does not see it yet), `already_owned` while it grants, `subscription_active` while its
  subscription will still charge. It gets a new one only once Stripe reports the last expired
  unpaid (or no longer has it), its delayed payment failed, or what it bought was refunded,
  disputed or has ended. The remembered session is kept after the webhook for this: on KV the
  location where the visitor's requests land can serve, for a minute, a user record its page read
  before the webhook (the poll after `?purchase=success`), and a Buy there then reads the purchase
  through the session rather than the user record. Each press with a remembered session asks
  Stripe for its state; only a 404 says Stripe has no such session, and any other failure (a 5xx,
  its rate limit, a refused key) is a 502 and no new session, rather than a guess. A session paid
  whose webhook never arrives (its endpoint removed, say) is refused for the 30 days it is
  remembered. Within one process presses at once are taken one at a time, under the remembered
  session's lock. No lock reaches another Workers isolate (two can take the two presses of one
  double click) or another KV location, so the request for a new session, and the Idempotency-Key
  it goes to Stripe under, are what the press read: the sign-in it came with, the session
  remembered (or none), the Stripe customer kept (or none), the product and its price, and the
  five minutes of the clock it is handled in, whose start fixes `expires_at` (so a session expires
  55 to 60 minutes after it is made). Stripe answers a request under a key it has answered before
  with that first answer, and keeps a key for a day at least (Stripe's documentation, "Idempotent
  requests"; not run against Stripe itself): presses that read the same within the same five
  minutes, wherever they are handled, are given one session. One that reaches Stripe while that
  session is still being made is refused by Stripe (`idempotency_key_in_use`) and answered 502,
  and pressed again is given it. One whose write of the marker KV refuses (KV takes one write a
  second to a key) is answered with its session when the marker already names it, and with a 500
  otherwise, its session handed to no one. (On KV a second press whose count is written within a
  second of the first's is answered 429 before Stripe is asked: see the rate limit above.) Stripe
  keeps an error under its key too, once the request had begun to run (a 500 among them; one
  refused before it ran, for failing validation or meeting a request under way, is not kept): a
  press so failed is answered the same 502 when pressed again within those five minutes, without
  Stripe trying again; the next five minutes try afresh. A deleted account's next sign-in is a new
  sign-in, and a session whose delayed payment failed is remembered for an hour marked failed, so
  neither reads as an earlier press did, and neither is given that press's session back. Presses
  that read different states can each still make a session: two sign-ins to the account at once
  (two browsers or devices), presses on either side of a five-minute boundary, or two KV locations
  within a minute of which one has seen the visitor's remembered session or Stripe customer and
  the other not yet. Then, as before this guard, both can be paid: for a one-time product, one
  charge to refund; for a subscription, two that each charge every period, under two Stripe
  customers (Checkout makes one when it is given none, and the kit learns it only from a webhook).
  Each subscription's record keeps its own customer, and Manage subscription opens the customer of
  the first that will still charge: once that one is set to end, the next Manage subscription
  reaches the other, so the visitor can cancel both, and Delete account (refused while either will
  charge) then works. Two products that grant one entitlement are two products here: buying both
  before either webhook is two payments.
- A Stripe customer the kit keeps that Stripe no longer knows (deleted in the dashboard, or with
  all of test mode's data) is forgotten the first time Stripe says so (a 400 `resource_missing`
  for `customer`): Buy then makes its session without it, so Checkout makes a new one, and Manage
  subscription answers 404. The owner's log says so once, naming the field and never the id.
- No Google or Stripe address is configurable. Tests inject their fakes through
  `createApp({ fetch })`.

## Testing

`node --test server/kit/selftest.mjs` runs the kit's own tests (no network): a fake Google whose
RSA key is made with Web Crypto and whose JWKS is served by the injected `fetch`, a fake Stripe,
webhooks signed with `node:crypto` independently of the kit's own HMAC, the memory store, the
file store, the KV store over a fake namespace (and over a model of KV in two locations, and one
that refuses a second write to a key within a second), the Pages handler, and the Node adapter
over a real loopback socket. The name keeps jest's and vitest's default globs off it.

A site's browser suite that plays the whole sign-in meets one snag: Playwright's `page.route` is
not called for a request a redirect makes, so routing `https://accounts.google.com/**` alone
never sees the kit's 302 from `api/auth/google/start`, and the browser goes on to the real
Google. Answer at the kit's own redirect instead: route `**/api/auth/google/start*`, take the
kit's answer with `route.fetch({ maxRedirects: 0 })`, check its `Location` is Google's authorize
URL for your client, and fulfil with that answer (its `Set-Cookie`, the sign-in cookie, kept)
but a `Location` that is the callback with a code your fake Google issued and the authorize
URL's `state`; a 302 works, or a 200 with `Refresh: 0;url=<callback>` where a page should see the
hop. Checkout is a navigation of the page's own, which `page.route` takes as it is.

A site's own fake Stripe whose tests press Buy for a product a second time (another tab, a
reload, a Buy after a refund) serves `GET /v1/checkout/sessions/<id>` as Stripe does: `{ id,
status, url }`, `status` being `open`, `complete` or `expired`, with the `url` while it is open,
and once it is complete the `payment_intent` (payment mode, `null` for a free checkout) or the
`subscription` (subscription mode) it made, the ids its webhook carries. Without those ids a paid
session reads as a payment still on its way, and Buy answers 409 `payment_pending` for the 30
days the session is remembered; a 404 says Stripe no longer has it, and a new one is made. A fake
that makes a new session for every `POST /v1/checkout/sessions` passes tests Stripe would answer
otherwise: Stripe answers a request under an `Idempotency-Key` it has answered before with that
first answer, an error included, and the kit's key is what the press read (see Limits), so a Buy
pressed again within five minutes of a Stripe failure is given that failure again. The self-test's
fake keeps its answers by key.

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
