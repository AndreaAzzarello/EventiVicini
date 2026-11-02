// Portabilità dei dati (GDPR, art. 20): tutto ciò che l'account ha su Firestore, più le chiavi locali del dispositivo, in un JSON.
// Costruito nel browser con le letture che l'utente già può fare: nessun passaggio dal server, nessuna lettura se non lo chiede.
import { dayInput } from './dates';
import { session } from './session.svelte';
import { readJson } from './storage';

/** Timestamp Firestore → ISO; il resto resta com'è, anche dentro liste e oggetti. */
export function plain(v: unknown): unknown {
	if (v && typeof v === 'object') {
		if ('toDate' in v && typeof v.toDate === 'function') return (v.toDate() as Date).toISOString();
		if (Array.isArray(v)) return v.map(plain);
		return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
	}
	return v;
}

/** Chiavi `ev:*` del dispositivo (luogo, preferiti locali, tema, segnalazioni inviate…): solo quelle del sito. */
export function localKeys(): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	try {
		for (const k of Object.keys(localStorage)) if (k.startsWith('ev:')) out[k] = readJson(k, null);
	} catch {
		// storage bloccato: niente chiavi locali da esportare
	}
	return out;
}

export async function buildExport(now = Date.now()): Promise<object> {
	const { fs, db, auth } = await session.start();
	const user = auth.currentUser;
	if (!user) throw new Error('not-signed-in');
	const [profile, favs, subs] = await Promise.all([
		fs.getDoc(fs.doc(db, 'users', user.uid)),
		fs.getDocs(fs.collection(db, 'users', user.uid, 'favorites')),
		fs.getDocs(fs.query(fs.collection(db, 'submissions'), fs.where('ownerId', '==', user.uid)))
	]);
	return {
		esportatoIl: new Date(now).toISOString(),
		note: 'Dati di Eventi Vicini collegati al tuo account, più quelli salvati su questo dispositivo. Le segnalazioni che hai inviato sono anonime e non compaiono qui.',
		account: {
			uid: user.uid,
			email: user.email,
			nome: user.displayName,
			accesso: user.providerData.map((p) => p.providerId),
			creatoIl: user.metadata.creationTime
		},
		profilo: profile.exists() ? plain(profile.data()) : null,
		preferiti: favs.docs.map((d) => ({ eventId: d.id, ...(plain(d.data()) as object) })),
		proposte: subs.docs.map((d) => ({ id: d.id, ...(plain(d.data()) as object) })),
		suQuestoDispositivo: localKeys()
	};
}

export async function downloadMyData() {
	const now = Date.now();
	const blob = new Blob([JSON.stringify(await buildExport(now), null, 2)], { type: 'application/json;charset=utf-8' });
	const a = document.createElement('a');
	a.href = URL.createObjectURL(blob);
	a.download = `eventi-vicini-dati-${dayInput(now)}.json`;
	a.click();
	setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
