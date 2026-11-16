import { idFromSlug } from '$lib/event';

// Passaggio card → dettaglio con le View Transitions (DESIGN.md, «Movimento»): il riquadro della card si allarga nella testata.
// Senza supporto del browser, con movimento ridotto o dal tasto indietro la navigazione resta istantanea.
export const MEDIA_NAME = 'ev-media';

type Input = {
	/** Tipo di navigazione di SvelteKit: solo 'link' (clic su un collegamento). */
	type: string;
	toPath: string | undefined;
	reducedMotion: boolean;
	supported: boolean;
};

const EVENT_PATH = /^\/eventi\/[^/]+$/;

export const isEventPath = (path: string | undefined) => !!path && EVENT_PATH.test(path);

export function shouldTransition({ type, toPath, reducedMotion, supported }: Input): boolean {
	return supported && !reducedMotion && type === 'link' && isEventPath(toPath);
}

/** Il riquadro da trasformare nella card dell'evento aperto: l'immagine (o il motivo), nelle card compatte il tagliando. */
export function sourceFor(root: ParentNode, toPath: string): HTMLElement | null {
	const id = idFromSlug(toPath.split('/').pop() ?? '');
	if (!id) return null;
	const card = root.querySelector(`[data-ev-id="${CSS.escape(id)}"]`);
	return card?.querySelector<HTMLElement>('.media, .stub') ?? null;
}
