// Test tooling only, never imported by the API itself (test/api.test.js holds that): a fake
// Google and a fake Stripe behind one `fetch`, which the tests hand to server/kit through
// `createApp({ fetch })` (serve()'s `fetch`). Nothing points the kit at another host: it calls the
// real addresses, and this function answers them. Shared by test/api.test.js and the browser
// suite (test/browser/run.mjs).
//
// Google: an RSA key made with Web Crypto, its JWKS, an authorization step (`consent`) that turns
// the authorize URL the kit sent the browser to into the callback URL Google would send it back
// to, and a token endpoint that checks the code, the client and the PKCE verifier before it signs
// an ID token for the nonce. Stripe: a Price, Checkout Sessions recorded as the kit created them,
// and webhook events signed as Stripe signs them, with node:crypto rather than the kit's code.
import { createHash, createHmac } from 'node:crypto';

export const CLIENT_ID = 'fake-client.apps.googleusercontent.com';
export const CLIENT_SECRET = 'fake-google-client-secret';
export const STRIPE_KEY = 'sk_test_fakeStripeKey000000000000';
export const WEBHOOK_SECRET = 'whsec_fakeWebhookSecret0000000000';
export const PRICE = 'price_supporterFake';
/** 32 bytes of base64url. */
export const SESSION_SECRET = 'c2Vzc2lvbi1zZWNyZXQtZm9yLXRoZS10ZXN0cy0wMDA';
export const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';

/** The variables a deployment sets, for an API whose public address is `appUrl`. */
export function envFor(appUrl) {
  return {
    APP_URL: appUrl,
    SESSION_SECRET,
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    STRIPE_SECRET_KEY: STRIPE_KEY,
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_PRICE_SUPPORTER: PRICE,
  };
}

const b64 = (data) => Buffer.from(typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)).toString('base64url');

/** A fake Google and a fake Stripe. `fetch` is what the kit is given; the rest is for the test
 *  to play the browser's part and Stripe's. */
export async function createFakes() {
  const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'fake-key', alg: 'RS256', use: 'sig' };
  const codes = new Map();      // code -> { challenge, redirectUri, nonce, person }
  const sessions = new Map();   // Checkout Session id -> the form the kit posted
  const unexpected = [];
  const calls = [];
  let seq = 0;

  const signIdToken = async (claims) => {
    const head = b64(JSON.stringify({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' }));
    const body = b64(JSON.stringify(claims));
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${b64(signature)}`;
  };

  const token = async (body) => {
    const form = new URLSearchParams(body);
    const code = form.get('code') ?? '';
    const grant = codes.get(code);
    codes.delete(code);
    const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
    if (!grant || form.get('grant_type') !== 'authorization_code' || form.get('client_id') !== CLIENT_ID
      || form.get('client_secret') !== CLIENT_SECRET || form.get('redirect_uri') !== grant.redirectUri || challenge !== grant.challenge) {
      return Response.json({ error: 'invalid_grant' }, { status: 400 });
    }
    const at = Math.floor(Date.now() / 1000);
    const idToken = await signIdToken({
      iss: 'https://accounts.google.com', aud: CLIENT_ID, azp: CLIENT_ID, sub: grant.person.sub, email: grant.person.email,
      email_verified: true, iat: at, exp: at + 3600, nonce: grant.nonce,
    });
    return Response.json({ id_token: idToken, access_token: 'unused', token_type: 'Bearer', expires_in: 3599 });
  };

  const stripe = (path, method, headers, body) => {
    if (headers.get('authorization') !== `Bearer ${STRIPE_KEY}`) return Response.json({ error: { message: 'bad key' } }, { status: 401 });
    if (method === 'GET' && path === `/prices/${PRICE}`) {
      return Response.json({ id: PRICE, object: 'price', active: true, currency: 'eur', unit_amount: 400, recurring: null, type: 'one_time' });
    }
    if (method === 'POST' && path === '/checkout/sessions') {
      seq += 1;
      const id = `cs_test_fake${seq}`;
      sessions.set(id, new URLSearchParams(body));
      return Response.json({ id, object: 'checkout.session', url: `https://checkout.stripe.com/c/pay/${id}` });
    }
    unexpected.push(`${method} stripe ${path}`);
    return Response.json({ error: { message: 'unknown endpoint' } }, { status: 404 });
  };

  const fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? init.body : '';
    calls.push(`${method} ${url}`);
    if (url === 'https://www.googleapis.com/oauth2/v3/certs' && method === 'GET') {
      return Response.json({ keys: [jwk] }, { headers: { 'cache-control': 'public, max-age=3600' } });
    }
    if (url === 'https://oauth2.googleapis.com/token' && method === 'POST') return token(body);
    if (url.startsWith('https://api.stripe.com/v1/')) return stripe(url.slice('https://api.stripe.com/v1'.length), method, headers, body);
    unexpected.push(`${method} ${url}`);
    throw new TypeError(`fetch to an address the fakes do not serve: ${url}`);
  };

  return {
    fetch,
    calls,
    unexpected,
    sessions,
    /**
     * Google's half of a sign-in: the authorize URL the kit sent the browser to, checked, and the
     * callback URL Google sends it back to, with a code the token endpoint exchanges once for an
     * ID token naming `person`.
     */
    consent(authorizeUrl, person = { sub: '1001', email: 'ada@example.com' }) {
      const url = new URL(authorizeUrl);
      const params = url.searchParams;
      if (`${url.origin}${url.pathname}` !== AUTHORIZE) throw new Error(`not Google's authorize URL: ${authorizeUrl}`);
      if (params.get('client_id') !== CLIENT_ID || params.get('response_type') !== 'code' || params.get('code_challenge_method') !== 'S256'
        || params.get('scope') !== 'openid email') {
        throw new Error(`an authorize URL Google would refuse: ${authorizeUrl}`);
      }
      seq += 1;
      const code = `code${seq}`;
      codes.set(code, { challenge: params.get('code_challenge') ?? '', redirectUri: params.get('redirect_uri') ?? '', nonce: params.get('nonce') ?? '', person });
      const back = new URL(params.get('redirect_uri') ?? '');
      back.searchParams.set('code', code);
      back.searchParams.set('state', params.get('state') ?? '');
      return back;
    },
    /** The `checkout.session.completed` event Stripe sends once the session `checkoutUrl` names is
     *  paid, built from what the kit asked for when it created that session. */
    paid(checkoutUrl) {
      const id = new URL(checkoutUrl).pathname.split('/').pop() ?? '';
      const asked = sessions.get(id);
      if (!asked) throw new Error(`no Checkout Session ${id}`);
      return {
        id: `evt_fake${id.replace(/[^0-9A-Za-z]/g, '')}`,
        object: 'event',
        type: 'checkout.session.completed',
        livemode: false,
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id,
            object: 'checkout.session',
            mode: asked.get('mode'),
            payment_status: 'paid',
            client_reference_id: asked.get('client_reference_id'),
            metadata: { app: asked.get('metadata[app]'), user: asked.get('metadata[user]'), product: asked.get('metadata[product]') },
            payment_intent: `pi_fake${id.replace(/[^0-9A-Za-z]/g, '')}`,
            customer: 'cus_fake1',
          },
        },
      };
    },
  };
}

/** A webhook delivery as Stripe signs it: the body, and its Stripe-Signature header. */
export function signedDelivery(event, { secret = WEBHOOK_SECRET, at = Math.floor(Date.now() / 1000) } = {}) {
  const body = JSON.stringify(event);
  const v1 = createHmac('sha256', secret).update(`${at}.${body}`).digest('hex');
  return { body, signature: `t=${at},v1=${v1}` };
}
