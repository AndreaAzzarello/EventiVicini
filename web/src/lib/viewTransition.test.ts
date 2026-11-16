import { describe, expect, it } from 'vitest';
import { isEventPath, shouldTransition } from './viewTransition';

const base = { type: 'link', toPath: '/eventi/concerto-in-piazza-abc123', reducedMotion: false, supported: true };

describe('isEventPath', () => {
	it('solo la pagina di un evento', () => {
		expect(isEventPath('/eventi/concerto-abc123')).toBe(true);
		expect(isEventPath('/eventi')).toBe(false);
		expect(isEventPath('/eventi/')).toBe(false);
		expect(isEventPath('/eventi/a/b')).toBe(false);
		expect(isEventPath('/citta/modena')).toBe(false);
		expect(isEventPath(undefined)).toBe(false);
	});
});

describe('shouldTransition', () => {
	it('parte con un clic su un collegamento verso un evento, con supporto e movimento normale', () => {
		expect(shouldTransition(base)).toBe(true);
	});
	it('non parte con movimento ridotto', () => {
		expect(shouldTransition({ ...base, reducedMotion: true })).toBe(false);
	});
	it('non parte senza supporto del browser', () => {
		expect(shouldTransition({ ...base, supported: false })).toBe(false);
	});
	it('non parte da tasto indietro/avanti né da goto', () => {
		expect(shouldTransition({ ...base, type: 'popstate' })).toBe(false);
		expect(shouldTransition({ ...base, type: 'goto' })).toBe(false);
	});
	it('non parte verso pagine che non sono un evento', () => {
		expect(shouldTransition({ ...base, toPath: '/preferiti' })).toBe(false);
		expect(shouldTransition({ ...base, toPath: undefined })).toBe(false);
	});
});
