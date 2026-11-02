// localStorage può mancare o lanciare (navigazione privata, cookie bloccati): mai far cadere la pagina.
export function readJson<T>(key: string, fallback: T): T {
	try {
		const raw = localStorage.getItem(key);
		return raw == null ? fallback : (JSON.parse(raw) as T);
	} catch {
		return fallback;
	}
}

export function writeJson(key: string, value: unknown): void {
	try {
		if (value == null) localStorage.removeItem(key);
		else localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// storage pieno o bloccato: il dato vive solo in memoria per questa visita
	}
}

export const KEYS = {
	place: 'ev:place',
	favorites: 'ev:favorites',
	theme: 'ev:theme',
	session: 'ev:session', // "c'era un login": carica Firebase solo per chi ne ha bisogno
	emailForSignIn: 'ev:emailForSignIn',
	geocodeCache: 'ev:geocode',
	loginHintShown: 'ev:loginHint',
	reported: 'ev:reported' // id degli eventi già segnalati da questo dispositivo
} as const;

/** Unisce i preferiti locali a quelli dell'account: restituisce cosa caricare e l'insieme finale. */
export function mergeFavorites(local: string[], remote: string[]): { toUpload: string[]; merged: string[] } {
	const remoteSet = new Set(remote);
	const toUpload = [...new Set(local)].filter((id) => !remoteSet.has(id));
	return { toUpload, merged: [...remote, ...toUpload] };
}
