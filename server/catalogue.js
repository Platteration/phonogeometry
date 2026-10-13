// @ts-check
// What the website sells through server/kit (sign in with Google, Stripe Checkout and its
// webhook): one "Support this app" payment and nothing else. It changes nothing in the app:
// every capture, build and export stays the same for everyone. A paid checkout grants the
// entitlement `supporter`, which `GET api/me` then reports, and the About block thanks a
// supporter for it (src/account.js). Its Stripe Price id is STRIPE_PRICE_SUPPORTER; without that
// variable nothing is sold.
//
// The kit checks this at start-up and throws on a malformed one (an unknown field included), and
// test/api.test.js holds it to what src/account.js asks for.

export default {
  app: 'phonogeometry',
  name: 'Phonogeometry',
  products: [
    {
      id: 'supporter',
      name: 'Support this app',
      description: 'A one-time payment towards Phonogeometry. It changes nothing in the app: every capture, build and export stays the same for everyone, and your photographs never leave your phone.',
      mode: 'payment',
      grants: 'supporter',
    },
  ],
};
