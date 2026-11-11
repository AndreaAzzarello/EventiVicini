/** Numeri all'italiana: 1.234 (anche da quattro cifre, dove it-IT di default non mette il punto). */
let nf: Intl.NumberFormat | undefined; // creato alla prima chiamata (costo di avvio a freddo, #51)
export const fmtNum = (n: number): string => (nf ??= new Intl.NumberFormat('it-IT', { useGrouping: 'always' })).format(n);

/** Meta description: spazi e a capo normalizzati, al massimo `max` caratteri, tagliata su un confine di parola con "…". */
export function metaDescription(text: string, max = 155): string {
	const s = text.replace(/\s+/g, ' ').trim();
	if (s.length <= max) return s;
	const cut = s.slice(0, max - 1);
	const space = cut.lastIndexOf(' ');
	// shortcut: una sola parola più lunga del limite viene tagliata a metà, caso che nei testi italiani non si presenta
	return (space > 0 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–]+$/, '') + '…';
}

/** Chiavi AAAA-MM del mese corrente e del precedente, a ora di Roma. */
export function monthKeys(now = new Date()): { cur: string; prev: string } {
	const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit' }).formatToParts(now);
	const y = Number(p.find((x) => x.type === 'year')!.value);
	const m = Number(p.find((x) => x.type === 'month')!.value);
	const key = (yy: number, mm: number) => `${yy}-${String(mm).padStart(2, '0')}`;
	return { cur: key(y, m), prev: m === 1 ? key(y - 1, 12) : key(y, m - 1) };
}

export const monthName = (key: string) =>
	new Intl.DateTimeFormat('it-IT', { month: 'long', timeZone: 'UTC' }).format(new Date(`${key}-15T12:00:00Z`));
const a = (name: string) => (name.startsWith('a') ? 'ad' : 'a');

/** "412 eventi a novembre · +38 rispetto a ottobre". Senza dati del mese precedente, solo la prima parte. */
export function monthLine(cur: number, prev: number | null, keys: { cur: string; prev: string }): string {
	const [mc, mp] = [monthName(keys.cur), monthName(keys.prev)];
	const head = `${cur === 1 ? '1 evento' : `${fmtNum(cur)} eventi`} ${a(mc)} ${mc}`;
	if (prev === null) return head;
	const d = cur - prev;
	const delta = d === 0 ? 'stesso numero' : `${d > 0 ? '+' : '−'}${fmtNum(Math.abs(d))}`;
	return `${head} · ${delta} rispetto ${a(mp)} ${mp}`;
}

/** Variazione col mese precedente, per le tabelle: "+38", "−12", "0"; vuota senza dati. */
export function monthDelta(cur: number, prev: number | null): string {
	if (prev === null) return '';
	const d = cur - prev;
	return d === 0 ? '0' : `${d > 0 ? '+' : '−'}${fmtNum(Math.abs(d))}`;
}
