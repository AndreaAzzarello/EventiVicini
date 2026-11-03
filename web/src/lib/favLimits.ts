// Limiti dei preferiti: gli stessi di firebase/firestore.rules (validFavChange), che li impongono davvero.
// Il giorno è quello UTC, come request.time nelle regole.
export const MAX_FAVORITES = 200;
export const MAX_DAILY_CHANGES = 100;

/** Contatori del profilo: quanti preferiti, quante modifiche nel giorno di `at` (ms). */
export type FavCounters = { count: number; changes: number; at: number | null };

const dayNum = (ms: number) => {
	const d = new Date(ms);
	return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
};

export function countersOf(profile: unknown): FavCounters {
	const p = (profile ?? {}) as { favCount?: unknown; favChanges?: unknown; favAt?: { toMillis?: () => number } };
	return {
		count: Number.isInteger(p.favCount) ? (p.favCount as number) : 0,
		changes: Number.isInteger(p.favChanges) ? (p.favChanges as number) : 0,
		at: typeof p.favAt?.toMillis === 'function' ? p.favAt.toMillis() : null
	};
}

export const changesToday = (c: FavCounters, now: number) => (c.at != null && dayNum(c.at) === dayNum(now) ? c.changes : 0);

/** Quante modifiche restano oggi. */
export const dailyRoom = (c: FavCounters, now: number) => Math.max(0, MAX_DAILY_CHANGES - changesToday(c, now));

/** Valori da scrivere nel profilo con una modifica; rimuovere non porta mai sotto zero (preferiti nati prima dei contatori). */
export function afterChange(c: FavCounters, op: 'add' | 'remove', now: number) {
	return { favCount: op === 'add' ? c.count + 1 : Math.max(0, c.count - 1), favChanges: changesToday(c, now) + 1 };
}

/** Prima gli eventi in corso o futuri, dal più vicino; poi gli altri (passati o sconosciuti) nell'ordine dato. */
export function prioritize(ids: string[], when: Map<string, { start: number; end: number }>, now: number): string[] {
	const upcoming = ids.filter((id) => (when.get(id)?.end ?? -1) >= now).sort((a, b) => when.get(a)!.start - when.get(b)!.start);
	const rest = ids.filter((id) => !upcoming.includes(id));
	return [...upcoming, ...rest];
}
