import { HTML_CACHE } from '$lib/server/cache';
import { error, redirect } from '@sveltejs/kit';
import { cityPath, slugify } from '$lib/event';
import { applyFilter, filterFromParams } from '$lib/filters';
import { sections } from '$lib/sections';
import { comuneBySlug } from '$lib/server/comuneSlug';
import { coverage, eventsInCity, regionCoverage } from '$lib/server/firestore';
import type { PageServerLoad } from './$types';

/** Card per pagina: tante nell'HTML (e poi «Mostra altri»), perché renderne centinaia costa CPU al Worker (#51). */
const PAGE_SIZE = 24;

export const load: PageServerLoad = async ({ params, setHeaders, url }) => {
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
	const meta = { slug: params.slug, city, cityAlt, province, region, regionSlug: regionPage ? regionSlug : '' };
	const now = Date.now();
	const liveCount = events.filter((e) => e.endTime >= now).length;
	// Città piccola: tutto nell'HTML, il browser filtra come sempre.
	if (liveCount <= PAGE_SIZE) return { ...meta, events, all: true, total: liveCount, liveCount, pagina: 1, pages: 1, sectionCounts: null };

	// Città grande: la pagina ?pagina=N della lista già filtrata (filtri dell'URL) e ordinata per sezioni.
	const groups = sections(applyFilter(events, filterFromParams(url.searchParams), now, null), now);
	const list = groups.flatMap((g) => g.events);
	const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
	const asked = Number(url.searchParams.get('pagina'));
	const pagina = Number.isInteger(asked) && asked >= 1 ? asked : 1;
	if (pagina > pages) {
		const to = new URL(url);
		if (pages > 1) to.searchParams.set('pagina', String(pages));
		else to.searchParams.delete('pagina');
		redirect(302, to.pathname + to.search);
	}
	const sectionCounts = Object.fromEntries(groups.map((g) => [g.key, g.events.length]));
	return { ...meta, events: list.slice((pagina - 1) * PAGE_SIZE, pagina * PAGE_SIZE), all: false, total: list.length, liveCount, pagina, pages, sectionCounts };
};
