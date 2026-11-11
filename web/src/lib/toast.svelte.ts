// Messaggi brevi e non bloccanti, annunciati agli screen reader dal contenitore aria-live.
export interface Toast {
	id: number;
	text: string;
	action?: { label: string; href: string };
}

/** Durata minima e massima di un messaggio, in ms. */
export const TOAST_MIN_MS = 6000;
export const TOAST_MAX_MS = 15000;
const FREE_WORDS = 10; // le prime parole stanno nel minimo
const MS_PER_EXTRA_WORD = 250; // circa 1 s ogni 4 parole oltre le prime

/** Tempo di lettura: 6 s fino a 10 parole, poi circa 1 s ogni 4 parole, al massimo 15 s. */
export function toastDuration(text: string): number {
	const words = text.trim().split(/\s+/).filter(Boolean).length;
	return Math.min(TOAST_MAX_MS, TOAST_MIN_MS + Math.max(0, words - FREE_WORDS) * MS_PER_EXTRA_WORD);
}

type Hold = 'mouse' | 'focus';

let next = 1;
export const toasts = $state<Toast[]>([]);

// Timer di chiusura, fuori dallo stato reattivo: quanto manca e da quando sta correndo (undefined = in pausa).
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- stato dei timer, non va mostrato: la vista legge solo `toasts`
const timers = new Map<number, { handle?: ReturnType<typeof setTimeout>; left: number; since?: number; holds: Set<Hold> }>();

function arm(id: number) {
	const t = timers.get(id);
	if (!t) return;
	t.since = Date.now();
	t.handle = setTimeout(() => dismiss(id), t.left);
}

export function toast(text: string, action?: Toast['action'], ms = toastDuration(text)) {
	const t = { id: next++, text, action };
	toasts.push(t);
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- come `timers`: non reattivo
	timers.set(t.id, { left: ms, holds: new Set() });
	arm(t.id);
}

/** Sospende la chiusura automatica finché c'è il mouse sopra il messaggio o il focus al suo interno. */
export function pause(id: number, hold: Hold) {
	const t = timers.get(id);
	if (!t) return;
	t.holds.add(hold);
	if (t.since === undefined) return;
	clearTimeout(t.handle);
	t.left = Math.max(0, t.left - (Date.now() - t.since));
	t.since = undefined;
}

/** Toglie una causa di pausa; quando non ne resta nessuna riprende dal tempo rimasto, con almeno 1 s per non far sparire il messaggio di colpo. */
export function resume(id: number, hold: Hold) {
	const t = timers.get(id);
	if (!t) return;
	t.holds.delete(hold);
	if (t.holds.size || t.since !== undefined) return;
	t.left = Math.max(t.left, 1000);
	arm(id);
}

export function dismiss(id: number) {
	const t = timers.get(id);
	if (t) clearTimeout(t.handle);
	timers.delete(id);
	const i = toasts.findIndex((x) => x.id === id);
	if (i >= 0) toasts.splice(i, 1);
}
