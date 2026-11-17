import { cubicOut } from 'svelte/easing';

// Durate di svelte/transition: i valori stanno solo in tokens.css (--dur, --dur-view), qui si leggono; vedi DESIGN.md «Movimento».
export type MotionToken = '--dur' | '--dur-view';

/** Da «150ms» o «0.25s» ai millisecondi; 0 se non è una durata. */
export function parseMs(value: string): number {
	const m = value.trim().match(/^(\d*\.?\d+)(ms|s)$/);
	if (!m) return 0;
	return Math.round(Number(m[1]) * (m[2] === 's' ? 1000 : 1));
}

/** Durata del token in ms; 0 con prefers-reduced-motion (letto a ogni chiamata, segue la preferenza a runtime). */
export function motionMs(token: MotionToken): number {
	if (matchMedia('(prefers-reduced-motion: reduce)').matches) return 0;
	return parseMs(getComputedStyle(document.documentElement).getPropertyValue(token));
}

/** Stessa soglia del CSS di MapSheet: da qui la scheda è un riquadro sulla mappa, sotto è un pannello dal basso. */
const WIDE = '(min-width: 960px)';

/**
 * Transizione della scheda mappa: sotto 960 px sale/scende dal bordo basso (transform), da 960 px si dissolve (opacity).
 * `instant` azzera la durata (es. mentre la mappa è in trascinamento o zoom).
 */
export function sheet(node: Element, { token = '--dur', instant }: { token?: MotionToken; instant?: () => boolean } = {}) {
	const wide = matchMedia(WIDE).matches;
	return {
		duration: instant?.() ? 0 : motionMs(token),
		easing: cubicOut,
		css: (t: number, u: number) => (wide ? `opacity: ${t}` : `transform: translateY(${u * 100}%)`)
	};
}
