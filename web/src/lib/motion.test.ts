import { afterEach, describe, expect, it, vi } from 'vitest';
import { motionMs, parseMs, sheet } from './motion';

function env({ reduced = false, wide = false, dur = '150ms' } = {}) {
	vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') ? reduced : wide }));
	vi.stubGlobal('document', { documentElement: {} });
	vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (t: string) => (t === '--dur-view' ? '0.25s' : dur) }));
}
afterEach(() => vi.unstubAllGlobals());

describe('parseMs', () => {
	it('legge ms e s, il resto è 0', () => {
		expect(parseMs('150ms')).toBe(150);
		expect(parseMs(' 0.25s ')).toBe(250);
		expect(parseMs('')).toBe(0);
		expect(parseMs('veloce')).toBe(0);
	});
});

describe('motionMs', () => {
	it('legge il token dal CSS', () => {
		env();
		expect(motionMs('--dur')).toBe(150);
		expect(motionMs('--dur-view')).toBe(250);
	});
	it('0 con movimento ridotto', () => {
		env({ reduced: true });
		expect(motionMs('--dur')).toBe(0);
	});
});

describe('sheet', () => {
	it('stretto: sale dal basso con transform; largo: opacity', () => {
		env();
		expect(sheet({} as Element).css(0.5, 0.5)).toBe('transform: translateY(50%)');
		env({ wide: true });
		expect(sheet({} as Element).css(0.5, 0.5)).toBe('opacity: 0.5');
	});
	it('durata dal token richiesto; 0 se instant o movimento ridotto', () => {
		env();
		expect(sheet({} as Element, { token: '--dur-view' }).duration).toBe(250);
		expect(sheet({} as Element, { instant: () => true }).duration).toBe(0);
		env({ reduced: true });
		expect(sheet({} as Element).duration).toBe(0);
	});
});
