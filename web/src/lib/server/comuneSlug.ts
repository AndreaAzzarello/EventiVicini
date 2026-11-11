import { read } from '$app/server';
import { comuneFromChunk, type SlugChunk } from '$lib/comuni';
import type { ChosenPlace } from '$lib/geo';

// Un file per iniziale dello slug (vedi tools/importer/build_comuni.py), ~0,5 MB in tutto. Non vanno nel bundle del Worker: Pages lo
// ricompone in un solo script, e ogni isolate freddo dovrebbe leggerli tutti (#44). Qui si importa solo l'URL dell'asset statico
// (query ?url, eager: sono stringhe) e il file della singola iniziale si legge con read(), cioè da env.ASSETS, che non è
// un'invocazione del Worker e non tocca Firestore.
const slugUrls = import.meta.glob<string>('/src/lib/data/slug/*.json', { query: '?url', import: 'default', eager: true });

const parsed = new Map<string, Promise<SlugChunk | null>>();

function loadChunk(initial: string): Promise<SlugChunk | null> {
	const url = slugUrls[`/src/lib/data/slug/${initial}.json`];
	if (!url) return Promise.resolve(null);
	let p = parsed.get(initial);
	if (!p) {
		p = read(url)
			.json()
			.catch((e) => {
				parsed.delete(initial); // un errore di lettura non resta in cache
				throw e;
			}) as Promise<SlugChunk>;
		parsed.set(initial, p);
	}
	return p;
}

/** Il comune italiano (dataset ISTAT locale, nessuna lettura Firestore) con questo slug, o null. */
export async function comuneBySlug(slug: string): Promise<ChosenPlace | null> {
	if (!/^[a-z0-9-]{1,80}$/.test(slug)) return null;
	const chunk = await loadChunk(slug[0]);
	return chunk ? comuneFromChunk(chunk, slug) : null;
}
