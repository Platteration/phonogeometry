import { pagesHandler } from '../../server/kit/cloudflare.js';
import catalogue from '../../server/catalogue.js';
export const onRequest = pagesHandler(catalogue);
