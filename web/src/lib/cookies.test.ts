import { describe, expect, it } from 'vitest';
import { isDeclared } from './cookies';

describe('isDeclared', () => {
	it('riconosce nomi esatti e con suffisso', () => {
		expect(isDeclared('localStorage', 'ev:theme')).toBe(true);
		expect(isDeclared('cacheStorage', 'shell-abc123')).toBe(true);
	});
	it('rifiuta ciò che non è dichiarato, anche con il tipo sbagliato', () => {
		expect(isDeclared('cookie', '_ga')).toBe(false);
		expect(isDeclared('localStorage', 'firebaseLocalStorageDb')).toBe(false);
		expect(isDeclared('indexedDB', 'altro')).toBe(false);
	});
});
