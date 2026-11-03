import { HTML_CACHE } from '$lib/server/cache';
import { error, redirect } from '@sveltejs/kit';
import { cityPath, slugify } from '$lib/event';
import { comuneBySlug } from '$lib/server/comuneSlug';
import { coverage, eventsInCity, regionCoverage } from '$lib/server/firestore';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, setHeaders }) => {
	if (params.slug !== slugify(params.slug)) error(404, 'Città non trovata');
	const events = await eventsInCity(params.slug);
	// Senza eventi non sappiamo nemmeno il nome della città: 404 vero, non una pagina vuota indicizzata.
	if (!events.length) {
		// /citta/bozen o /citta/bolzano-bozen: l'indirizzo canonico è quello col nome italiano
		const alias = (await coverage().catch(() => [])).flatMap((r) => r.comuni).find(
			(c) => c.alt && [c.alt, `${c.name} ${c.alt}`, `${c.alt} ${c.name}`].some((n) => slugify(n) === params.slug)
		);
		if (alias) redirect(301, cityPath(alias.slug));
		// Comune vero ma senza eventi propri: 302 (non 301) perché domani potrebbe averne; la home mostra gli eventi vicini.
		if (await comuneBySlug(params.slug)) redirect(302, `/?luogo=${params.slug}`);
		error(404, 'Nessun evento in programma per questa città.');
	}
	setHeaders({ 'cache-control': HTML_CACHE });
	const { city, province, region } = events[0];
	// Link alla pagina regione solo se esiste (regione coperta): niente breadcrumb che portano a un 404.
	const regionSlug = region ? slugify(region) : '';
	const regionPage = regionSlug ? await regionCoverage(regionSlug).catch(() => null) : null;
	const cityAlt = events.find((e) => e.cityAlt)?.cityAlt ?? '';
	return { slug: params.slug, events, city, cityAlt, province, region, regionSlug: regionPage ? regionSlug : '' };
};
