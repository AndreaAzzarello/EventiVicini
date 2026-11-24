import { beforeEach, describe, expect, it, vi } from 'vitest';

// #46: l'admin non deve perdere cityAlt (nome nell'altra lingua) quando salva un evento importato.
const saved: { data?: Record<string, unknown> } = {};
let old: Record<string, unknown> | undefined;
const batched: { set?: Record<string, unknown> } = {};

vi.mock('./session.svelte', () => ({
	session: {
		start: async () => ({
			db: {},
			fs: {
				doc: (_db: unknown, _c: string, id?: string) => ({ id: id ?? 'nuovo' }),
				collection: () => ({}),
				getDoc: async () => ({ data: () => old }),
				serverTimestamp: () => 'ts',
				increment: (n: number) => n,
				writeBatch: () => ({
					set: (_ref: unknown, data: Record<string, unknown>) => {
						batched.set = data;
					},
					update: () => {},
					commit: async () => {}
				}),
				setDoc: async (_ref: unknown, data: Record<string, unknown>) => {
					saved.data = data;
				}
			}
		})
	}
}));

const { approve, saveEvent } = await import('./admin');

const input = (over = {}) =>
	({
		title: 'Festa', shortDescription: '', category: 'culture', priceType: 'free', startTime: 1_000, endTime: 2_000, venueName: '',
		address: 'Via Roma 1', lat: 46.5, lng: 11.35, imageUrl: '', ticketUrl: '', tags: [], geohash: 'u0q', city: 'Bolzano',
		citySlug: 'bolzano', province: 'BZ', region: 'Trentino-Alto Adige', ...over
	}) as never;

describe('saveEvent e cityAlt', () => {
	beforeEach(() => {
		saved.data = undefined;
		old = { source: 'scraper', sourceUrl: 'https://x.it/e', createdAt: 5, startTime: 1_000, endTime: 2_000, city: 'Bolzano', cityAlt: 'Bozen' };
	});

	it('lo conserva se il comune non cambia', async () => {
		await saveEvent('e1', input());
		expect(saved.data?.cityAlt).toBe('Bozen');
	});

	it('lo toglie se l’admin sposta l’evento in un altro comune', async () => {
		await saveEvent('e1', input({ city: 'Merano', citySlug: 'merano' }));
		expect(saved.data).not.toHaveProperty('cityAlt');
	});

	it('non lo inventa su un evento che non lo aveva, né su uno nuovo', async () => {
		old = { source: 'manual', city: 'Bolzano' };
		await saveEvent('e1', input());
		expect(saved.data).not.toHaveProperty('cityAlt');
		old = undefined;
		await saveEvent(null, input());
		expect(saved.data).not.toHaveProperty('cityAlt');
	});

	it('un cityAlt non testo nel vecchio documento non passa', async () => {
		old = { source: 'scraper', city: 'Bolzano', cityAlt: 5 };
		await saveEvent('e1', input());
		expect(saved.data).not.toHaveProperty('cityAlt');
	});
});

describe('approve e link alla fonte', () => {
	const sub = (over = {}) => ({ ...(input() as object), id: 's1', ownerId: 'u1', status: 'pending', createdAt: 1, ...over }) as never;

	it('copia il link della proposta in sourceUrl, con source "user"', async () => {
		await approve(sub({ sourceUrl: 'https://www.instagram.com/p/AbC123/' }));
		expect(batched.set).toMatchObject({ source: 'user', sourceUrl: 'https://www.instagram.com/p/AbC123/' });
	});

	it('senza link resta vuoto e non copia ownerId', async () => {
		await approve(sub());
		expect(batched.set).toMatchObject({ source: 'user', sourceUrl: '' });
		expect(batched.set).not.toHaveProperty('ownerId');
	});
});
