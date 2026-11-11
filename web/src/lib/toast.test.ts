import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOAST_MAX_MS, TOAST_MIN_MS, dismiss, pause, resume, toast, toastDuration, toasts } from './toast.svelte';

const words = (n: number) => Array.from({ length: n }, (_, i) => `parola${i}`).join(' ');

describe('toastDuration', () => {
	it('fino a 10 parole vale il minimo di 6 s', () => {
		expect(toastDuration('')).toBe(TOAST_MIN_MS);
		expect(toastDuration(words(3))).toBe(6000);
		expect(toastDuration(words(10))).toBe(6000);
	});

	it('oltre le prime 10 parole aggiunge circa 1 s ogni 4', () => {
		expect(toastDuration(words(14))).toBe(7000);
		expect(toastDuration(words(18))).toBe(8000);
		expect(toastDuration(words(30))).toBe(11000);
	});

	it('non supera mai 15 s', () => {
		expect(toastDuration(words(200))).toBe(TOAST_MAX_MS);
	});

	it('spazi multipli e a capo contano come un solo separatore', () => {
		expect(toastDuration(`  ${words(14).replace(/ /g, '  \n ')}  `)).toBe(7000);
	});

	it('il messaggio più lungo dei preferiti (sincronizzazione rimandata) resta tra 6 e 15 s', () => {
		const ms = toastDuration('3 preferiti si sincronizzeranno nei prossimi giorni (massimo 100 modifiche al giorno). Nel frattempo restano salvati su questo dispositivo.');
		expect(ms).toBeGreaterThan(TOAST_MIN_MS);
		expect(ms).toBeLessThanOrEqual(TOAST_MAX_MS);
	});
});

describe('toast: chiusura automatica, pausa e chiusura a mano', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		for (const t of [...toasts]) dismiss(t.id);
		vi.useRealTimers();
	});

	it('sparisce solo dopo la sua durata, che segue la lunghezza del testo', () => {
		toast(words(18)); // 8 s
		vi.advanceTimersByTime(7999);
		expect(toasts).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(toasts).toHaveLength(0);
	});

	it('un messaggio breve dura 6 s', () => {
		toast('Link copiato.');
		vi.advanceTimersByTime(5999);
		expect(toasts).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(toasts).toHaveLength(0);
	});

	it('la durata può essere imposta da chi chiama', () => {
		toast('Breve', undefined, 10000);
		vi.advanceTimersByTime(9999);
		expect(toasts).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(toasts).toHaveLength(0);
	});

	it('con il mouse sopra il tempo si ferma, e quando esce riprende da dove era', () => {
		toast('Breve'); // 6 s
		const id = toasts[0].id;
		vi.advanceTimersByTime(4000);
		pause(id, 'mouse');
		vi.advanceTimersByTime(60_000);
		expect(toasts).toHaveLength(1);
		resume(id, 'mouse');
		vi.advanceTimersByTime(1999);
		expect(toasts).toHaveLength(1); // restavano 2 s
		vi.advanceTimersByTime(1);
		expect(toasts).toHaveLength(0);
	});

	it('dopo la pausa resta almeno 1 s per leggere la fine', () => {
		toast('Breve');
		const id = toasts[0].id;
		vi.advanceTimersByTime(5900); // restano 100 ms
		pause(id, 'mouse');
		resume(id, 'mouse');
		vi.advanceTimersByTime(999);
		expect(toasts).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(toasts).toHaveLength(0);
	});

	it('mouse e focus: riprende solo quando sono finiti tutti e due', () => {
		toast('Breve');
		const id = toasts[0].id;
		pause(id, 'mouse');
		pause(id, 'focus');
		resume(id, 'mouse');
		vi.advanceTimersByTime(60_000);
		expect(toasts).toHaveLength(1); // il focus è ancora dentro
		resume(id, 'focus');
		vi.advanceTimersByTime(6000);
		expect(toasts).toHaveLength(0);
	});

	it('una pausa ripetuta non fa perdere tempo né lo moltiplica', () => {
		toast('Breve');
		const id = toasts[0].id;
		vi.advanceTimersByTime(1000);
		pause(id, 'mouse');
		pause(id, 'mouse');
		vi.advanceTimersByTime(10_000);
		resume(id, 'mouse');
		vi.advanceTimersByTime(4999);
		expect(toasts).toHaveLength(1); // restavano 5 s
		vi.advanceTimersByTime(1);
		expect(toasts).toHaveLength(0);
	});

	it('dismiss chiude subito, ferma il timer e le pause su un messaggio chiuso non fanno nulla', () => {
		toast('Uno');
		toast('Due');
		const [a, b] = [toasts[0].id, toasts[1].id];
		dismiss(a);
		expect(toasts.map((t) => t.id)).toEqual([b]);
		expect(() => {
			pause(a, 'mouse');
			resume(a, 'mouse');
		}).not.toThrow();
		expect(vi.getTimerCount()).toBe(1); // solo quello di «Due»
		vi.advanceTimersByTime(6000);
		expect(toasts).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);
	});
});
