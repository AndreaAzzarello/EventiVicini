import { comuneFromChunk, type SlugChunk } from '$lib/comuni';
import type { ChosenPlace } from '$lib/geo';

// Un file per iniziale dello slug (vedi tools/importer/build_comuni.py): se ne carica uno solo, e solo se serve.
const slugChunks = import.meta.glob<SlugChunk>('/src/lib/data/slug/*.json', { import: 'default' });

/** Il comune italiano (dataset ISTAT locale, nessuna lettura Firestore) con questo slug, o null. */
export async function comuneBySlug(slug: string): Promise<ChosenPlace | null> {
	if (!/^[a-z0-9-]{1,80}$/.test(slug)) return null;
	const chunk = slugChunks[`/src/lib/data/slug/${slug[0]}.json`];
	return chunk ? comuneFromChunk(await chunk(), slug) : null;
}
