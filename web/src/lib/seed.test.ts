process.env.TZ = 'Europe/Rome'; // il seed calcola i giorni nel fuso della macchina: come in e2e (Playwright usa Europe/Rome)

import { describe, expect, it } from 'vitest';
import { seedEvents } from '../../scripts/seed-events.mjs';
import { dayInput, romeTime } from './dates';
import type { Event } from './event';
import { applyFilter, EMPTY_FILTER, filterFromParams } from './filters';
import { DEFAULT_RADIUS_KM } from './geo';

// I test e2e contano gli eventi del seed (filtri-lista.spec.ts, date-filter.spec.ts, ssr-parziale.spec.ts): il seed non deve
// dipendere dal giorno della settimana in cui gira. Qui `now` si inietta: sette giorni (lunedì 23/11/2026 - domenica 29/11/2026),
// mattina, mezzogiorno e sera.
const MODENA = { lat: 44.6471, lng: 10.9252 };
const TORINO = { lat: 45.0703, lng: 7.6869 };
const WEEKDAY = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];

const times = [0, 1, 2, 3, 4, 5, 6].flatMap((k) => [7, 12, 22].map((h) => ({ k, h, now: romeTime(2026, 11, 23 + k, h) })));

for (const { k, h, now } of times) {
	describe(`${WEEKDAY[(1 + k) % 7]} alle ${h}:00`, () => {
		/** "AAAA-MM-GG" di oggi + n giorni, nel calendario di Roma (come dayPlus degli e2e). */
		const dayPlus = (n: number) => dayInput(romeTime(2026, 11, 23 + k + n, 12));
		const all = (opts = {}) => seedEvents(now, opts).map((e) => ({ id: e.id, ...e.data }) as unknown as Event);
		const live = (opts = {}) => all(opts).filter((e) => e.endTime >= now); // come i bundle: solo gli eventi non finiti
		const cases: [string, string][] = [
			['Domani', 'quando=domani'],
			['Weekend', 'quando=weekend'],
			['Prossimi 7 giorni', 'quando=7giorni'],
			['Scegli date (fino a 14 giorni)', `dal=${dayPlus(2)}&al=${dayPlus(9)}`],
			['Scegli date (oltre 14 giorni)', `dal=${dayPlus(1)}&al=${dayPlus(20)}`],
			['categoria', 'cat=music']
		];

		for (const [name, query] of cases) {
			it(`«${name}» ha almeno un evento a Modena`, () => {
				const out = applyFilter(live(), filterFromParams(new URLSearchParams(query)), now, MODENA);
				expect(out.length).toBeGreaterThan(0);
			});
		}

		it('Weekend ha un evento di sabato o di domenica, e Domani meno eventi del totale', () => {
			const weekend = applyFilter(live(), filterFromParams(new URLSearchParams('quando=weekend')), now, MODENA).map((e) => e.id);
			expect(weekend.some((id) => id === 'seedSabato' || id === 'seedDomenica')).toBe(true);
			const total = applyFilter(live(), { ...EMPTY_FILTER, radiusKm: DEFAULT_RADIUS_KM }, now, MODENA).length;
			const tomorrow = applyFilter(live(), filterFromParams(new URLSearchParams('quando=domani')), now, MODENA).length;
			expect(tomorrow).toBeLessThan(total);
		});

		it('gli eventi degli altri test restano a +1 (Mercato), +2 (Letture) e +3 (Sagra) giorni', () => {
			const day = (id: string) => dayInput(all().find((e) => e.id === id)!.startTime);
			expect(day('seedMercato')).toBe(dayPlus(1));
			expect(day('seedBimbi')).toBe(dayPlus(2));
			expect(day('seedSagra')).toBe(dayPlus(3));
		});

		it('seed grande: Torino ha 60 eventi vivi e il weekend non è vuoto (SSR parziale con quando=weekend)', () => {
			const torino = live({ big: true }).filter((e) => e.citySlug === 'torino');
			expect(torino).toHaveLength(60);
			const weekend = applyFilter(torino, filterFromParams(new URLSearchParams('quando=weekend')), now, TORINO);
			expect(weekend.length).toBeGreaterThan(0);
		});
	});
}
