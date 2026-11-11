import { legalInfo } from '$lib/server/legal';
import type { PageServerLoad } from './$types';

// Pagina legale prerenderizzata (#44): è un file statico, non invoca il Worker. I dati del titolare sono quelli della build
// (legal.ts); le intestazioni di sicurezza vengono da web/_headers, la CSP da un <meta> con gli hash.
export const prerender = true;

export const load: PageServerLoad = () => legalInfo();
