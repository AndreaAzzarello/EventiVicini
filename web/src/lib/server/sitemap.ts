import { siteUrl } from '$lib/config';

/** Risposta XML di una pagina di sitemap scritta dall'importer: il segnaposto {{BASE}} diventa l'indirizzo del sito. */
export const xmlResponse = (xml: string) =>
	new Response(xml.replaceAll('{{BASE}}', siteUrl()), {
		headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600, s-maxage=43200' }
	});
