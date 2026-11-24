import { describe, expect, it, vi } from 'vitest';
import { imageFallback } from './imageFallback';

const ORIGINAL = 'https://x.it/orig.jpg';

function fakeImg(src: string, state: { complete?: boolean; naturalWidth?: number } = {}) {
	const t = new EventTarget();
	const img = {
		src,
		currentSrc: src,
		complete: state.complete ?? false,
		naturalWidth: state.naturalWidth ?? 0,
		attrs: new Set(['srcset']),
		addEventListener: t.addEventListener.bind(t),
		removeEventListener: t.removeEventListener.bind(t),
		removeAttribute(n: string) {
			this.attrs.delete(n);
		},
		fire: () => t.dispatchEvent(new Event('error'))
	};
	return img;
}

describe('imageFallback', () => {
	it('variante in errore: torna all’originale senza srcset e senza segnalare', () => {
		const onBroken = vi.fn();
		const img = fakeImg('https://x.it/mini.jpg');
		imageFallback(ORIGINAL, onBroken)(img);
		img.fire();
		expect(img.src).toBe(ORIGINAL);
		expect(img.attrs.has('srcset')).toBe(false);
		expect(onBroken).not.toHaveBeenCalled();
	});
	it('anche l’originale in errore: onBroken una volta sola, nessun loop', () => {
		const onBroken = vi.fn();
		const img = fakeImg('https://x.it/mini.jpg');
		imageFallback(ORIGINAL, onBroken)(img);
		img.fire();
		img.fire();
		img.fire();
		img.fire();
		expect(onBroken).toHaveBeenCalledTimes(1);
		expect(img.src).toBe(ORIGINAL);
	});
	it('src già uguale all’originale (fonte senza variante): al primo errore onBroken', () => {
		const onBroken = vi.fn();
		const img = fakeImg(ORIGINAL);
		imageFallback(ORIGINAL, onBroken)(img);
		img.fire();
		expect(onBroken).toHaveBeenCalledTimes(1);
	});
	it('errore avvenuto prima dell’idratazione: ripiega subito', () => {
		const onBroken = vi.fn();
		const img = fakeImg('https://x.it/mini.jpg', { complete: true, naturalWidth: 0 });
		imageFallback(ORIGINAL, onBroken)(img);
		expect(img.src).toBe(ORIGINAL);
		expect(onBroken).not.toHaveBeenCalled();
	});
	it('immagine già caricata: nessun ripiego', () => {
		const onBroken = vi.fn();
		const img = fakeImg('https://x.it/mini.jpg', { complete: true, naturalWidth: 128 });
		imageFallback(ORIGINAL, onBroken)(img);
		expect(img.src).toBe('https://x.it/mini.jpg');
		expect(onBroken).not.toHaveBeenCalled();
	});
	it('la pulizia toglie il listener', () => {
		const onBroken = vi.fn();
		const img = fakeImg('https://x.it/mini.jpg');
		const cleanup = imageFallback(ORIGINAL, onBroken)(img);
		cleanup?.();
		img.fire();
		expect(img.src).toBe('https://x.it/mini.jpg');
	});
});
