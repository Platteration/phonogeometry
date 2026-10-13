// @ts-check
// The website's API when the site is self-hosted: server/kit's node:http adapter with this
// app's catalogue, listening on 127.0.0.1:8788 (KIT_HOST, KIT_PORT) behind the reverse proxy
// that sends it the site's `api/` (deploy/nginx.conf's `location ^~ /api/`; for Apache, a
// ProxyPass in the virtual host). It keeps its records as one file per key under KIT_DATA_DIR, a
// directory outside the web root, and reads every other variable (APP_URL, SESSION_SECRET, the
// Google client, the Stripe keys and STRIPE_PRICE_SUPPORTER) from the environment: with none set
// it answers `GET api/config` with nothing on and every other route with a 404, and the page
// draws no sign-in and no shop. One process per data directory (server/kit/README.md).
//
//   KIT_DATA_DIR=/var/lib/phonogeometry-api node server/start.mjs
//
// Cloudflare Pages runs functions/api/[[path]].js instead; GitHub Pages runs nothing.

import process from 'node:process';
import { pathToFileURL } from 'node:url';
import catalogue from './catalogue.js';
import { serve } from './kit/node.js';

/**
 * Starts the API. The options are serve()'s less the catalogue, which is this app's: the tests
 * pass their own environment, data directory, port and the fakes of Google and Stripe.
 * @param {Omit<Parameters<typeof serve>[0], 'catalogue'>} [options]
 */
export function start(options = {}) {
  return serve({ ...options, catalogue });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { url, features } = await start();
  globalThis.console.log(`phonogeometry api listening on ${url} (sign-in ${features.signIn ? 'on' : 'off'}, shop ${features.shop ? 'on' : 'off'})`);
}
