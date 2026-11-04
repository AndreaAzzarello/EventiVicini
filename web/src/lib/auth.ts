// Login con Google o con link via email (Firebase email-link), riautenticazione ed eliminazione dell'account.
import type { Firebase } from './firebase/client';
import { session } from './session.svelte';
import { KEYS, readJson, writeJson } from './storage';

const MESSAGES: Record<string, string> = {
	'auth/invalid-email': 'Indirizzo email non valido.',
	'auth/missing-email': 'Inserisci la tua email.',
	'auth/popup-closed-by-user': 'Hai chiuso la finestra di Google prima di completare l’accesso.',
	'auth/cancelled-popup-request': 'Accesso annullato.',
	'auth/popup-blocked': 'Il browser ha bloccato la finestra di Google: consenti i popup per questo sito o usa il link via email.',
	'auth/network-request-failed': 'Connessione assente o instabile. Riprova.',
	'auth/invalid-action-code': 'Il link non è più valido (forse è già stato usato o è scaduto). Richiedine uno nuovo.',
	'auth/expired-action-code': 'Il link è scaduto. Richiedine uno nuovo.',
	'auth/too-many-requests': 'Troppi tentativi. Aspetta qualche minuto e riprova.',
	'auth/user-mismatch': 'Il link appartiene a un altro account.',
	'auth/requires-recent-login': 'Per sicurezza devi accedere di nuovo prima di continuare.',
	'auth/unauthorized-continue-uri': 'Dominio non autorizzato in Firebase: avvisa il gestore del sito.',
	'auth/unauthorized-domain': 'Dominio non autorizzato in Firebase: avvisa il gestore del sito.'
};

export function authMessage(e: unknown): string {
	const code = (e as { code?: string })?.code ?? '';
	return MESSAGES[code] ?? 'Qualcosa è andato storto. Riprova tra poco.';
}

/** Solo percorsi interni: evita redirect verso altri siti tramite ?next=. Si risolve come farebbe il browser e si confronta l'origine. */
export function safeNext(next: string | null, origin = location.origin): string {
	if (!next) return '/';
	try {
		const u = new URL(next, origin);
		return u.origin === origin ? u.pathname + u.search + u.hash : '/';
	} catch {
		return '/';
	}
}

export async function signInWithGoogle() {
	const fb = await session.start();
	await fb.a.signInWithPopup(fb.auth, new fb.a.GoogleAuthProvider());
}

export async function sendEmailLink(email: string, continuePath: string) {
	const fb = await session.start();
	await fb.a.sendSignInLinkToEmail(fb.auth, email.trim(), {
		url: new URL(continuePath, location.origin).href,
		handleCodeInApp: true
	});
	writeJson(KEYS.emailForSignIn, email.trim());
}

export const savedEmail = () => readJson<string>(KEYS.emailForSignIn, '');

export async function isEmailLink(href: string) {
	const fb = await session.start();
	return fb.a.isSignInWithEmailLink(fb.auth, href);
}

/** Completa l'accesso dal link ricevuto; se l'utente è già dentro, vale come riautenticazione. */
export async function completeEmailLink(email: string, href: string) {
	const fb = await session.start();
	const user = fb.auth.currentUser;
	if (user) {
		await fb.a.reauthenticateWithCredential(user, fb.a.EmailAuthProvider.credentialWithLink(email, href));
	} else {
		await fb.a.signInWithEmailLink(fb.auth, email, href);
	}
	writeJson(KEYS.emailForSignIn, null);
}

/** Firebase chiede un accesso recente (5 minuti) per eliminare l'account. */
export function needsRecentLogin(lastSignIn: number) {
	return Date.now() - lastSignIn > 4 * 60_000;
}

export async function reauthWithGoogle() {
	const fb = await session.start();
	await fb.a.reauthenticateWithPopup(fb.auth.currentUser!, new fb.a.GoogleAuthProvider());
}

/**
 * Elimina tutto: preferiti, proposte (le pending liberando il contatore, come chiedono le regole),
 * profilo e infine l'account di accesso.
 */
export async function deleteAccountAndData() {
	const fb: Firebase = await session.start();
	const { fs, db, auth } = fb;
	const user = auth.currentUser;
	if (!user) throw new Error('not-signed-in');
	const uid = user.uid;

	const favs = await fs.getDocs(fs.collection(db, 'users', uid, 'favorites'));

	const subs = await fs.getDocs(fs.query(fs.collection(db, 'submissions'), fs.where('ownerId', '==', uid)));
	const userRef = fs.doc(db, 'users', uid);
	// limits/{uid} resta (il client non lo cancella, così il limite del giorno non si azzera ricreando il profilo): qui si
	// porta solo il conteggio a 0; lo elimina cleanup.py quando l'account di accesso non esiste più.
	const limitsRef = fs.doc(db, 'limits', uid);
	const hasLimits = (await fs.getDoc(limitsRef)).exists();
	for (const s of subs.docs) {
		const b = fs.writeBatch(db);
		b.delete(s.ref);
		if (s.data().status === 'pending') b.update(userRef, { pendingCount: fs.increment(-1), lastSubmissionId: s.id });
		await b.commit();
	}

	// Preferiti e profilo insieme: le regole tolgono i limiti solo se il profilo sparisce nello stesso batch (max 500 scritture).
	// Oltre quel numero (impossibile col tetto di 200, possibile solo per preferiti molto vecchi) prima il profilo, poi il resto.
	if (favs.docs.length < 500) {
		const b = fs.writeBatch(db);
		for (const d of favs.docs) b.delete(d.ref);
		b.delete(userRef);
		if (hasLimits) b.update(limitsRef, { favCount: 0 });
		await b.commit();
	} else {
		const first = fs.writeBatch(db);
		first.delete(userRef);
		if (hasLimits) first.update(limitsRef, { favCount: 0 });
		await first.commit();
		for (let i = 0; i < favs.docs.length; i += 450) {
			const b = fs.writeBatch(db);
			for (const d of favs.docs.slice(i, i + 450)) b.delete(d.ref);
			await b.commit();
		}
	}
	await fb.a.deleteUser(user);
	for (const k of [KEYS.favorites, KEYS.session, KEYS.loginHintShown, KEYS.emailForSignIn]) writeJson(k, null);
}
