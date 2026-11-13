// Operazioni dell'admin. Le regole Firestore le ricontrollano tutte (email admin verificata).
import { EVENT_KEYS, LONG_RUNNING_DAYS, fromData, type Event, type EventInput } from './event';
import { session } from './session.svelte';
import { reportFromSnap, type Report } from './reports';
import { fromSnap, type Submission } from './submissions';

const PAGE = 100;

/** Eventi finiti da meno di 30 giorni o futuri, a pagine: mai l'intera collezione. */
export async function listEvents(after?: Event): Promise<Event[]> {
	const { fs, db } = await session.start();
	const cutoff = Date.now() - 30 * 24 * 3600_000;
	const base = fs.query(fs.collection(db, 'events'), fs.where('endTime', '>=', cutoff), fs.orderBy('endTime'));
	const snap = await fs.getDocs(
		after ? fs.query(base, fs.startAfter(after.endTime), fs.limit(PAGE)) : fs.query(base, fs.limit(PAGE))
	);
	return snap.docs.map((d) => fromData(d.id, d.data()));
}
export const PAGE_SIZE = PAGE;

export async function loadEvent(id: string): Promise<Event | null> {
	const { fs, db } = await session.start();
	const snap = await fs.getDoc(fs.doc(db, 'events', id));
	return snap.exists() ? fromData(snap.id, snap.data()) : null;
}

/** Crea o sostituisce un evento. Un evento importato toccato a mano diventa "manual" (l'importer non lo sovrascrive più). */
export async function saveEvent(id: string | null, input: EventInput): Promise<string> {
	const { fs, db } = await session.start();
	const ref = id ? fs.doc(db, 'events', id) : fs.doc(fs.collection(db, 'events'));
	const old = id ? (await fs.getDoc(ref)).data() : undefined;
	const now = Date.now();
	// longRunning: si tiene solo se le date non sono cambiate, altrimenti si ricalcola dalla durata.
	const sameDates = old?.startTime === input.startTime && old?.endTime === input.endTime;
	const long = (sameDates && old?.longRunning === true) || input.endTime - input.startTime > LONG_RUNNING_DAYS * 86_400_000;
	const source = !old || old.source === 'scraper' ? 'manual' : old.source;
	await fs.setDoc(ref, {
		...input,
		source,
		sourceUrl: (old?.sourceUrl as string) ?? '',
		createdAt: (old?.createdAt as number) ?? now,
		updatedAt: now,
		// La frazione vale solo se l'admin non ha spostato il luogo in un altro comune.
		...(old?.locality && input.city === old.city ? { locality: old.locality } : {}),
		...(long ? { longRunning: true } : {})
	}); // niente submittedBy: un evento vecchio che lo aveva lo perde alla prima modifica
	return ref.id;
}

export async function deleteEvent(id: string) {
	const { fs, db } = await session.start();
	await fs.deleteDoc(fs.doc(db, 'events', id));
}

export async function pendingSubmissions(): Promise<Submission[]> {
	const { fs, db } = await session.start();
	const snap = await fs.getDocs(
		fs.query(fs.collection(db, 'submissions'), fs.where('status', '==', 'pending'), fs.orderBy('createdAt'), fs.limit(100))
	);
	return snap.docs.map((d) => fromSnap(d.id, d.data()));
}

/** Approva: copia in events (source "user", senza l'autore: l'uid resta solo nella proposta), chiude la proposta, libera il posto dell'autore. */
export async function approve(s: Submission): Promise<string> {
	const { fs, db } = await session.start();
	const eventRef = fs.doc(fs.collection(db, 'events'));
	const now = Date.now();
	const data = Object.fromEntries(EVENT_KEYS.map((k) => [k, s[k]]));
	const b = fs.writeBatch(db);
	b.set(eventRef, { ...data, source: 'user', sourceUrl: '', createdAt: now, updatedAt: now });
	b.update(fs.doc(db, 'submissions', s.id), { status: 'approved', eventId: eventRef.id, reviewedAt: fs.serverTimestamp() });
	b.update(fs.doc(db, 'users', s.ownerId), { pendingCount: fs.increment(-1) });
	await b.commit();
	return eventRef.id;
}

export async function reject(s: Submission, reason: string) {
	const { fs, db } = await session.start();
	const b = fs.writeBatch(db);
	b.update(fs.doc(db, 'submissions', s.id), {
		status: 'rejected',
		rejectReason: reason.trim().slice(0, 500),
		reviewedAt: fs.serverTimestamp()
	});
	b.update(fs.doc(db, 'users', s.ownerId), { pendingCount: fs.increment(-1) });
	await b.commit();
}

export interface RegionMonth {
	region: string;
	name: string;
	month: string;
	events: number;
	comuni: number;
	/** Eventi in corso o futuri entro l'orizzonte dell'import (fotografia di oggi); assente nei documenti scritti prima. */
	upcoming: number | null;
	updatedAt: number | null;
	cities: { slug: string; name: string; n: number }[];
}

/** Statistiche mensili delle regioni (scritte dall'importer) per i mesi indicati; mai il campo `ids`, che qui non serve. */
export async function listStats(months: string[]): Promise<RegionMonth[]> {
	const { fs, db } = await session.start();
	const snap = await fs.getDocs(fs.query(fs.collection(db, 'stats'), fs.where('month', 'in', months)));
	return snap.docs.map((d) => {
		const x = d.data();
		return { region: x.region, name: x.name ?? x.region, month: x.month, events: x.events ?? 0, comuni: x.comuni ?? 0, upcoming: x.upcoming ?? null, updatedAt: x.updatedAt ?? null, cities: x.cities ?? [] };
	});
}

/** Segnalazioni aperte, le più vecchie prima. Solo `status == open`: non serve un indice composto. */
export async function openReports(): Promise<Report[]> {
	const { fs, db } = await session.start();
	const snap = await fs.getDocs(fs.query(fs.collection(db, 'reports'), fs.where('status', '==', 'open'), fs.limit(100)));
	return snap.docs.map((d) => reportFromSnap(d.id, d.data())).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Decide una segnalazione, sempre con una motivazione (DSA, art. 17). Con `removeEvent` toglie anche l'evento, nello stesso batch.
 * L'evento sparisce dalle liste quando l'importer ricostruisce i bundle (come per ogni cancellazione dall'admin).
 */
export async function decideReport(r: Report, removeEvent: boolean, decision: string) {
	const { fs, db } = await session.start();
	const b = fs.writeBatch(db);
	b.update(fs.doc(db, 'reports', r.id), {
		status: removeEvent ? 'removed' : 'dismissed',
		decision: decision.trim().slice(0, 500),
		decidedAt: fs.serverTimestamp()
	});
	if (removeEvent) b.delete(fs.doc(db, 'events', r.eventId));
	await b.commit();
}
