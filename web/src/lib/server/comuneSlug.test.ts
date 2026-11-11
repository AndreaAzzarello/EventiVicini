import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { comuneBySlug } from './comuneSlug';

// In vitest l'URL dell'asset è il percorso del file nel progetto (in produzione è /_app/immutable/assets/<iniziale>.<hash>.json).
const reads = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock('$app/server', () => ({
	read: (url: string) => {
		reads.urls.push(url);
		return { json: async () => JSON.parse(await readFile(join(process.cwd(), url), 'utf8')) };
	}
}));

describe('comuneBySlug', () => {
	it('risolve un comune dal file della sua iniziale', async () => {
		expect(await comuneBySlug('cabiate')).toMatchObject({ label: 'Cabiate', slug: 'cabiate', region: 'Lombardia' });
	});
	it('legge ogni file una volta sola per isolate', async () => {
		await comuneBySlug('cadeo');
		await comuneBySlug('cagli');
		expect(reads.urls.filter((u) => u.endsWith('/c.json'))).toHaveLength(1);
	});
	it('slug sconosciuto, malformato o con iniziale senza file: null, senza leggere', async () => {
		const before = reads.urls.length;
		expect(await comuneBySlug('cittainventata')).toBeNull();
		expect(await comuneBySlug('../etc')).toBeNull();
		expect(await comuneBySlug('')).toBeNull();
		expect(await comuneBySlug('1abc')).toBeNull();
		expect(reads.urls.length).toBe(before); // il file della "c" è già in cache, gli altri slug non arrivano a leggere
	});
});
