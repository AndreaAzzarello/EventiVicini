// Ripiego per le immagini di terze parti: se la variante piccola non carica (404, errore) si torna all'originale; se anche
// l'originale fallisce si chiama onBroken (la card mostra il motivo di categoria). Al massimo un cambio: niente loop di errori.
// Niente onerror inline (la CSP lo blocca): se l'errore è avvenuto prima dell'idratazione lo si legge da complete/naturalWidth.

type Img = Pick<HTMLImageElement, 'src' | 'currentSrc' | 'complete' | 'naturalWidth' | 'addEventListener' | 'removeEventListener' | 'removeAttribute'>;

export function imageFallback(original: string, onBroken: () => void) {
	return (img: Img) => {
		let triedOriginal = false;
		let done = false;
		const fail = () => {
			if (done) return;
			if (!triedOriginal && img.src !== original) {
				triedOriginal = true;
				img.removeAttribute('srcset');
				img.src = original;
				return;
			}
			done = true;
			onBroken();
		};
		if (img.complete && img.naturalWidth === 0) fail();
		img.addEventListener('error', fail);
		return () => img.removeEventListener('error', fail);
	};
}
