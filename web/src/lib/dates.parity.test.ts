import { describe, expect, it } from 'vitest';
import { TZ, formatTime, formatWhen, romeParts, romePartsIntl, shortDate, shortDay, romeTime } from './dates';

// Parità esaustiva con Intl (#51): romeParts e i testi it-IT non usano più ICU nel percorso caldo; un errore sull'ora legale
// sposterebbe gli eventi di un'ora, uno sul testo cambierebbe ciò che vede l'utente. Qui il riferimento è Intl vero.
const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('it-IT', { timeZone: TZ, ...o });
const F = {
	short: fmt({ day: 'numeric', month: 'short' }),
	card: fmt({ weekday: 'short', day: 'numeric', month: 'short' }),
	day: fmt({ weekday: 'long', day: 'numeric', month: 'long' }),
	dayYear: fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
	time: fmt({ hour: '2-digit', minute: '2-digit' }),
	year: fmt({ year: 'numeric' })
};
const HOUR = 3_600_000;
const START = Date.UTC(2024, 0, 1);
const END = Date.UTC(2041, 0, 1);

describe('romeParts senza Intl', () => {
	it('uguale a Intl a ogni ora (con minuti e secondi diversi) dal 2024 al 2040', () => {
		let bad = 0;
		for (let t = START, i = 0; t < END; t += HOUR, i++) {
			const ms = t + (i % 60) * 60_000 + (i % 59) * 1000;
			const a = romeParts(ms);
			const b = romePartsIntl(ms);
			if (JSON.stringify(a) !== JSON.stringify(b)) {
				if (bad++ < 3) expect(a, new Date(ms).toISOString()).toEqual(b);
			}
		}
		expect(bad).toBe(0);
	});
	it('uguale a Intl al minuto attorno a ogni cambio d’ora (±2 ore) dal 2024 al 2040', () => {
		for (let y = 2024; y <= 2040; y++)
			for (const month of [2, 9]) {
				const last = new Date(Date.UTC(y, month + 1, 0)).getUTCDate();
				const day = last - new Date(Date.UTC(y, month, last)).getUTCDay();
				const change = Date.UTC(y, month, day, 1);
				for (let m = -120; m <= 120; m++) expect(romeParts(change + m * 60_000), `${y}-${month + 1} ${m}`).toEqual(romePartsIntl(change + m * 60_000));
			}
	});
	it('fuori dagli anni 2000-2099 ripiega su Intl (stesso risultato per costruzione)', () => {
		for (const ms of [Date.UTC(1985, 6, 1), Date.UTC(2150, 0, 1), 0]) expect(romeParts(ms)).toEqual(romePartsIntl(ms));
	});
	it('romeTime resta coerente col cambio d’ora', () => {
		expect(new Date(romeTime(2027, 3, 28, 2, 30)).toISOString()).toBe('2027-03-28T01:30:00.000Z');
		expect(new Date(romeTime(2027, 10, 31, 3, 0)).toISOString()).toBe('2027-10-31T02:00:00.000Z');
	});
});

describe('testi it-IT senza Intl', () => {
	it('shortDate, shortDay, formatTime e formatWhen uguali a Intl ogni ora dal 2024 al 2040', () => {
		let bad = 0;
		const note = (what: string, got: string, want: string, ms: number) => {
			if (got !== want && bad++ < 5) expect(got, `${what} ${new Date(ms).toISOString()}`).toBe(want);
		};
		for (let t = START, i = 0; t < END; t += HOUR, i++) {
			const ms = t + (i % 60) * 60_000;
			note('shortDate', shortDate(ms), F.short.format(ms), ms);
			note('formatTime', formatTime(ms), F.time.format(ms), ms);
			// shortDay: con now = ms vale "Oggi"; con now molto prima, il giorno dopo ecc. cadono in "Domani"/testo: confrontiamo il caso testo
			const now = ms - 10 * 24 * HOUR;
			note('shortDay', shortDay(ms, now), F.card.format(ms), ms);
			// formatWhen: stesso giorno, anno corrente e non, e intervalli su più giorni
			const end = ms + 2 * HOUR;
			const sameDay = F.short.format(ms) === F.short.format(end);
			if (sameDay) {
				const sameYear = F.year.format(ms) === F.year.format(now);
				const day = (sameYear ? F.day : F.dayYear).format(ms);
				const allDay = F.time.format(ms) === '00:00' && F.time.format(end) === '23:59';
				note('formatWhen', formatWhen(ms, end, now), allDay ? `${day} · tutto il giorno` : `${day} · ${F.time.format(ms)}–${F.time.format(end)}`, ms);
			} else {
				note('formatWhen/multi', formatWhen(ms, end, ms), `dal ${F.short.format(ms)} al ${F.short.format(end)}`, ms);
			}
		}
		expect(bad).toBe(0);
	}, 60_000);
	it('formatWhen: anno mostrato solo se diverso, evento a orario singolo e tutto il giorno', () => {
		const a = romeTime(2027, 5, 12, 21, 0);
		expect(formatWhen(a, a, romeTime(2027, 1, 1))).toBe('mercoledì 12 maggio · 21:00');
		expect(formatWhen(a, a, romeTime(2026, 1, 1))).toBe('mercoledì 12 maggio 2027 · 21:00');
		expect(formatWhen(romeTime(2027, 5, 12), romeTime(2027, 5, 12, 23, 59), romeTime(2027, 1, 1))).toBe('mercoledì 12 maggio · tutto il giorno');
	});
});
