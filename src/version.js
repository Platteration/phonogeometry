// The version the About block shows. A static page has no build step to stamp it, so it is a
// constant here and `test/settings-contract.test.js` fails when it drifts from package.json.
// It is not the service worker's cache generation (`sw.js` VERSION), which changes with every
// shell edit and says nothing a person would want to read.
export const APP_VERSION = '0.1.0';
