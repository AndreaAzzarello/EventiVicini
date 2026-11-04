import { allDay, romeParts } from './dates';
import type { Event } from './event';

const enc = new TextEncoder();

/** RFC 5545 §3.1: righe di al massimo 75 ottetti, le continuazioni iniziano con uno spazio. Non spezza i caratteri UTF-8. */
export function foldLine(line: string): string {
	const out: string[] = [];
	let cur = '';
	let bytes = 0;
	for (const ch of line) {
		const n = enc.encode(ch).length;
		const max = out.length ? 74 : 75; // lo spazio iniziale della continuazione conta
		if (bytes + n > max) {
			out.push(cur);
			cur = '';
			bytes = 0;
		}
		cur += ch;
		bytes += n;
	}
	out.push(cur);
	return out.join('\r\n ');
}

const esc = (s: string) =>
	s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');

const utc = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

const ymd = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10).replace(/-/g, '');

/** DTSTART/DTEND: per gli eventi senza orario date intere nel fuso italiano, con fine esclusiva (RFC 5545). */
function when(e: Event): string[] {
	if (!allDay(e.startTime, e.endTime)) return [`DTSTART:${utc(e.startTime)}`, `DTEND:${utc(Math.max(e.endTime, e.startTime))}`];
	const s = romeParts(e.startTime);
	const l = romeParts(e.endTime);
	return [`DTSTART;VALUE=DATE:${ymd(s.year, s.month, s.day)}`, `DTEND;VALUE=DATE:${ymd(l.year, l.month, l.day + 1)}`];
}

/** File iCalendar con un solo evento. */
export function buildIcs(e: Event, url: string, now = Date.now()): string {
	const location = [e.venueName, e.address].filter(Boolean).join(', ');
	const description = [e.shortDescription, url].filter(Boolean).join('\n\n');
	return (
		[
			'BEGIN:VCALENDAR',
			'VERSION:2.0',
			'PRODID:-//Eventi Vicini//IT',
			'CALSCALE:GREGORIAN',
			'METHOD:PUBLISH',
			'BEGIN:VEVENT',
			`UID:${e.id}@eventi-vicini`,
			`DTSTAMP:${utc(now)}`,
			...when(e),
			`SUMMARY:${esc(e.title)}`,
			description && `DESCRIPTION:${esc(description)}`,
			location && `LOCATION:${esc(location)}`,
			`GEO:${e.lat.toFixed(6)};${e.lng.toFixed(6)}`,
			`URL:${url}`,
			'END:VEVENT',
			'END:VCALENDAR'
		]
			.filter(Boolean)
			.map((l) => foldLine(l as string))
			.join('\r\n') + '\r\n'
	);
}
