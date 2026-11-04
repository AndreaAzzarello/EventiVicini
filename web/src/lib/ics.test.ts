import { describe, expect, it } from 'vitest';
import { fromData } from './event';
import { romeTime } from './dates';
import { buildIcs, foldLine } from './ics';
import { xssDue, xssUno } from './hostileEvents';

const bytes = (s: string) => new TextEncoder().encode(s).length;
const unfold = (s: string) => s.split('\r\n').map((l, i) => (i ? l.slice(1) : l)).join('');

describe('foldLine (RFC 5545)', () => {
	it('righe corte intatte', () => expect(foldLine('SUMMARY:Ciao')).toBe('SUMMARY:Ciao'));
	it('spezza a 75 ottetti con spazio di continuazione', () => {
		const text = 'DESCRIPTION:' + 'a'.repeat(200);
		const lines = foldLine(text).split('\r\n');
		expect(lines.every((l) => bytes(l) <= 75)).toBe(true);
		expect(bytes(lines[0])).toBe(75);
		expect(lines.slice(1).every((l) => l.startsWith(' '))).toBe(true);
		expect(unfold(foldLine(text))).toBe(text);
	});
	it('non spezza i caratteri multibyte', () => {
		const text = 'DESCRIPTION:' + 'è€😀'.repeat(40);
		expect(foldLine(text).split('\r\n').every((l) => bytes(l) <= 75)).toBe(true);
		expect(unfold(foldLine(text))).toBe(text);
	});
});

describe('buildIcs', () => {
	const e = fromData('abc', {
		title: 'Concerto; jazz, blues',
		shortDescription: 'Riga 1\nRiga 2',
		startTime: Date.UTC(2026, 10, 14, 20),
		endTime: Date.UTC(2026, 10, 14, 22),
		venueName: 'Teatro',
		address: 'Via Roma 1, Modena',
		lat: 44.6,
		lng: 10.9
	});
	const ics = buildIcs(e, 'https://x.it/eventi/concerto-abc', Date.UTC(2026, 9, 1));
	it('struttura e CRLF', () => {
		expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
		expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
		expect(ics.replace(/\r\n/g, '')).not.toMatch(/\n/);
	});
	it('date UTC ed escape', () => {
		expect(ics).toContain('DTSTART:20261114T200000Z');
		expect(ics).toContain('DTEND:20261114T220000Z');
		expect(ics).toContain('SUMMARY:Concerto\\; jazz\\, blues');
		expect(ics).toContain('DESCRIPTION:Riga 1\\nRiga 2');
		expect(ics).toContain('UID:abc@eventi-vicini');
	});
});

describe('buildIcs, orari e giorni interi', () => {
	const mk = (startTime: number, endTime: number) =>
		buildIcs(fromData('x', { title: 'T', startTime, endTime, lat: 44, lng: 10 }), 'https://x.it/e', 0);
	it('un giorno intero: fine esclusiva', () => {
		const ics = mk(romeTime(2026, 11, 14), romeTime(2026, 11, 14, 23, 59));
		expect(ics).toContain('DTSTART;VALUE=DATE:20261114');
		expect(ics).toContain('DTEND;VALUE=DATE:20261115');
	});
	it('più giorni interi, a cavallo di fine mese', () => {
		const ics = mk(romeTime(2026, 11, 28), romeTime(2026, 11, 30, 23, 59));
		expect(ics).toContain('DTSTART;VALUE=DATE:20261128');
		expect(ics).toContain('DTEND;VALUE=DATE:20261201');
	});
	it('con orario: UTC con Z', () => {
		const ics = mk(romeTime(2026, 7, 1, 21), romeTime(2026, 7, 1, 23));
		expect(ics).toContain('DTSTART:20260701T190000Z');
		expect(ics).toContain('DTEND:20260701T210000Z');
	});
	it('cambio ora legale (25 ott 2026): giorno intero senza slittamenti', () => {
		const ics = mk(romeTime(2026, 10, 25), romeTime(2026, 10, 25, 23, 59));
		expect(ics).toContain('DTSTART;VALUE=DATE:20261025');
		expect(ics).toContain('DTEND;VALUE=DATE:20261026');
	});
	it('a cavallo del cambio ora con orario', () => {
		const ics = mk(romeTime(2026, 10, 24, 22), romeTime(2026, 10, 25, 4));
		expect(ics).toContain('DTSTART:20261024T200000Z');
		expect(ics).toContain('DTEND:20261025T030000Z');
	});
});

describe('buildIcs: contenuto ostile (payload di xssUno/xssDue)', () => {
	const logical = (s: string) => s.replace(/\r\n /g, '').split('\r\n').filter(Boolean);
	it('xssDue: a capo, punto e virgola, virgole e backslash non aprono righe né proprietà nuove', () => {
		const out = buildIcs(xssDue(), 'https://example.test/eventi/x');
		const lines = logical(out);
		expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1);
		expect(lines.filter((l) => l === 'END:VEVENT')).toHaveLength(1);
		expect(lines.some((l) => l.startsWith('ATTENDEE'))).toBe(false);
		expect(lines.find((l) => l.startsWith('SUMMARY:'))).toBe('SUMMARY:Titolo\\nBEGIN:VEVENT\\nSUMMARY:iniettato\\nEND:VEVENT');
		expect(lines.find((l) => l.startsWith('LOCATION:'))).toContain('Luogo\\; con\\, virgole\\\\e\\nnuova riga');
		expect(out.split('\r\n').every((l) => bytes(l) <= 75)).toBe(true);
		expect(lines.find((l) => l.startsWith('UID:'))).toBe('UID:xssDue@eventi-vicini');
	});
	it('xssUno: U+2028, U+2029 e <!-- restano testo in una sola proprietà', () => {
		const out = buildIcs(xssUno(), 'https://example.test/eventi/x');
		const lines = logical(out);
		expect(lines.filter((l) => l.startsWith('DESCRIPTION:'))).toHaveLength(1);
		expect(lines.find((l) => l.startsWith('DESCRIPTION:'))).toContain('<!-- fine');
		expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1);
		expect(out.endsWith('\r\n')).toBe(true);
		expect(out.split('\r\n').every((l) => bytes(l) <= 75)).toBe(true);
	});
	it('un CR da solo (senza LF) non resta nel file: alcuni lettori lo trattano come fine riga', () => {
		const e = fromData('cr', { title: 'A\rBEGIN:VEVENT\rSUMMARY:x', shortDescription: 'p\rq', venueName: 'v\ru', startTime: 1, endTime: 2, lat: 44, lng: 10 });
		const out = buildIcs(e, 'https://x.it/e');
		expect(out.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
	});
});
