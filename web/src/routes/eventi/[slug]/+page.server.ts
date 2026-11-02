import { HTML_CACHE } from '$lib/server/cache';
import { error, redirect } from '@sveltejs/kit';
import { eventPath, idFromSlug } from '$lib/event';
import { getEvent } from '$lib/server/firestore';
import { legalInfo } from '$lib/server/legal';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, setHeaders }) => {
	const event = await getEvent(idFromSlug(params.slug));
	if (!event) error(404, 'Evento non trovato: forse è stato rimosso.');
	// Titolo cambiato o slug sbagliato: un solo URL canonico.
	const canonical = eventPath(event);
	if (`/eventi/${params.slug}` !== canonical) redirect(301, canonical);
	setHeaders({ 'cache-control': HTML_CACHE });
	return { event, contact: legalInfo().email };
};
