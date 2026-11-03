// Stato di login e preferiti. Firebase parte solo se c'era già una sessione o se l'utente
// sceglie di accedere: il login non viene mai chiesto all'apertura.
import { ADMIN_EMAIL } from './config';
import { firebase, type Firebase } from './firebase/client';
import { MAX_DAILY_CHANGES, MAX_FAVORITES, afterChange, countersOf, dailyRoom, prioritize, type FavCounters } from './favLimits';
import { KEYS, mergeFavorites, readJson, writeJson } from './storage';
import type { ChosenPlace } from './geo';
import { toast } from './toast.svelte';

export interface SessionUser {
	uid: string;
	email: string;
	name: string;
	isAdmin: boolean;
	provider: 'google' | 'email';
	lastSignIn: number;
}

class Session {
	user = $state<SessionUser | null>(null);
	/** idle: Firebase mai caricato (visitatore anonimo); ready: stato di login noto. */
	status = $state<'idle' | 'loading' | 'ready'>('idle');
	#started: Promise<Firebase> | null = null;

	/** Avvia Auth e ascolta i cambi di stato. Idempotente. */
	start(): Promise<Firebase> {
		this.#started ??= (async () => {
			this.status = 'loading';
			const fb = await firebase();
			await new Promise<void>((resolve) => {
				fb.a.onAuthStateChanged(fb.auth, async (u) => {
					if (u) {
						writeJson(KEYS.session, true);
						this.user = {
							uid: u.uid,
							email: u.email ?? '',
							name: u.displayName ?? '',
							isAdmin: u.email === ADMIN_EMAIL && u.emailVerified,
							provider: u.providerData.some((p) => p.providerId === 'google.com') ? 'google' : 'email',
							lastSignIn: Date.parse(u.metadata.lastSignInTime ?? '') || 0
						};
						try {
							const profile = await ensureProfile(fb, u.uid, u.displayName ?? '');
							await favorites.attach(fb, u.uid, profile);
							await homePlace.attach(fb, u.uid, profile.homePlace);
						} catch (e) {
							console.error(e);
							toast('Non riesco a sincronizzare i preferiti: riprova più tardi.');
						}
					} else {
						writeJson(KEYS.session, null);
						this.user = null;
						favorites.detach();
						homePlace.detach();
					}
					this.status = 'ready';
					resolve();
				});
			});
			return fb;
		})();
		return this.#started;
	}

	/** All'avvio della pagina: carica Firebase solo per chi aveva già fatto login. */
	resume() {
		if (readJson(KEYS.session, false)) this.start();
		else this.status = 'ready';
	}

	async signOut() {
		const fb = await this.start();
		await fb.a.signOut(fb.auth);
	}
}

async function ensureProfile(fb: Firebase, uid: string, name: string): Promise<{ homePlace?: unknown; [k: string]: unknown }> {
	const ref = fb.fs.doc(fb.db, 'users', uid);
	const snap = await fb.fs.getDoc(ref);
	if (snap.exists()) return snap.data();
	await fb.fs.setDoc(ref, {
		name: name.slice(0, 80),
		city: '',
		createdAt: fb.fs.serverTimestamp(),
		pendingCount: 0
	});
	return {};
}

/** Solo i campi ammessi dalle regole (users/{uid}.homePlace), mai undefined; null se non è una zona valida. */
export function toHomePlace(p: unknown): ChosenPlace | null {
	const v = p as Partial<ChosenPlace> | null;
	if (!v || typeof v.label !== 'string' || !v.label || !Number.isFinite(v.lat) || !Number.isFinite(v.lng)) return null;
	return {
		label: v.label.slice(0, 80),
		lat: v.lat!,
		lng: v.lng!,
		...(v.slug ? { slug: v.slug.slice(0, 80) } : {}),
		...(v.region ? { region: v.region.slice(0, 80) } : {})
	};
}

/** Zona scelta: in localStorage per chi è anonimo, anche nel profilo (users/{uid}.homePlace) per chi ha l'account. */
class HomePlace {
	/** Impostata al login quando il profilo ha una zona: la home la applica. */
	value = $state<ChosenPlace | null>(null);
	#remote: { fb: Firebase; uid: string } | null = null;

	/** Al login: la zona del profilo vince e aggiorna quella locale; se il profilo non ne ha, vale quella locale. */
	async attach(fb: Firebase, uid: string, remote: unknown) {
		this.#remote = { fb, uid };
		const saved = toHomePlace(remote);
		if (saved) {
			writeJson(KEYS.place, saved);
			this.value = saved;
			return;
		}
		const local = toHomePlace(readJson<unknown>(KEYS.place, null));
		if (local) await this.#write(local);
	}

	detach() {
		this.#remote = null;
		this.value = null;
	}

	/** Dopo una scelta dell'utente: se ha l'account la salva nel profilo. */
	save(p: ChosenPlace) {
		const place = toHomePlace(p);
		if (place && this.#remote) this.#write(place).catch((e) => console.error(e));
	}

	async #write(place: ChosenPlace) {
		const { fb, uid } = this.#remote!;
		await fb.fs.updateDoc(fb.fs.doc(fb.db, 'users', uid), { homePlace: place });
	}
}

/**
 * Preferiti. Anonimo: solo localStorage. Con l'account: su Firestore, un preferito per scrittura, con i contatori del
 * profilo che le regole controllano (tetto 200, 100 modifiche al giorno: vedi favLimits.ts). Quelli che non entrano
 * (limite del giorno) restano nel localStorage (`pending`) e si sincronizzano ai prossimi accessi.
 */
class Favorites {
	ids = $state<string[]>([]);
	#remote: { fb: Firebase; uid: string } | null = null;
	#counters: FavCounters = { count: 0, changes: 0, at: null };
	#pending: string[] = [];
	#queue: Promise<unknown> = Promise.resolve(); // le scritture vanno una alla volta: ognuna parte dai contatori della precedente

	load() {
		if (!this.#remote) this.ids = readJson<string[]>(KEYS.favorites, []);
	}

	has(id: string) {
		return this.ids.includes(id);
	}

	/** Restituisce true se l'evento è stato aggiunto. */
	async toggle(id: string): Promise<boolean> {
		const adding = !this.has(id);
		if (adding && this.ids.length >= MAX_FAVORITES) {
			toast(`Hai raggiunto il massimo di ${MAX_FAVORITES} preferiti. Toglierne qualcuno per aggiungerne altri.`);
			return false;
		}
		const before = this.ids;
		this.ids = adding ? [...before, id] : before.filter((x) => x !== id);
		const remote = this.#remote;
		if (!remote) {
			writeJson(KEYS.favorites, this.ids);
			if (adding && !readJson(KEYS.loginHintShown, false)) {
				writeJson(KEYS.loginHintShown, true);
				toast('Salvato nei preferiti su questo dispositivo.', {
					label: 'Accedi per non perderli',
					href: `/accedi?next=${encodeURIComponent(location.pathname + location.search)}`
				}, 10000);
			}
			return adding;
		}
		if (!adding && this.#pending.includes(id)) {
			this.#setPending(this.#pending.filter((x) => x !== id)); // mai arrivato su Firestore: niente da scrivere
			return false;
		}
		try {
			if (await this.#serial(() => this.#change(adding ? 'add' : 'remove', id))) return adding;
		} catch (e) {
			this.ids = before;
			throw e;
		}
		// Limite del giorno raggiunto: aggiungere resta possibile (si sincronizza domani), togliere no.
		if (adding) {
			this.#setPending([...this.#pending, id]);
			toast(`Salvato su questo dispositivo: oggi hai raggiunto il limite di ${MAX_DAILY_CHANGES} modifiche ai preferiti, si sincronizzerà nei prossimi giorni.`);
			return true;
		}
		this.ids = before;
		toast(`Oggi hai raggiunto il limite di ${MAX_DAILY_CHANGES} modifiche ai preferiti. Potrai togliere questo preferito domani.`);
		return false;
	}

	/** Al login: unisce i preferiti locali a quelli dell'account; ciò che non entra oggi resta in locale. */
	async attach(fb: Firebase, uid: string, profile?: unknown) {
		const { fs, db } = fb;
		const snap = await fs.getDocs(fs.collection(db, 'users', uid, 'favorites'));
		const remoteIds = snap.docs.map((d) => d.id);
		this.#remote = { fb, uid };
		this.#counters = countersOf(profile);
		const { toUpload } = mergeFavorites(readJson<string[]>(KEYS.favorites, []), remoteIds);
		const fits = toUpload.slice(0, Math.max(0, MAX_FAVORITES - remoteIds.length));
		this.#setPending(fits);
		this.ids = [...remoteIds, ...fits];
		if (fits.length < toUpload.length) toast(`Il massimo è ${MAX_FAVORITES} preferiti: ${toUpload.length - fits.length} di quelli di questo dispositivo non sono stati aggiunti.`);
		if (fits.length) void this.#drain(uid);
	}

	detach() {
		this.#remote = null;
		this.#pending = [];
		this.ids = readJson<string[]>(KEYS.favorites, []);
	}

	#setPending(list: string[]) {
		this.#pending = list;
		writeJson(KEYS.favorites, list.length ? list : null);
	}

	#serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(fn, fn);
		this.#queue = run.catch(() => undefined);
		return run;
	}

	/** Una modifica (preferito + contatori nello stesso batch). false = limite del giorno raggiunto, nulla di scritto. */
	async #change(op: 'add' | 'remove', id: string): Promise<boolean> {
		const { fb, uid } = this.#remote!;
		const { fs, db } = fb;
		for (let attempt = 0; attempt < 2; attempt++) {
			const now = Date.now();
			if (dailyRoom(this.#counters, now) === 0) return false;
			const next = afterChange(this.#counters, op, now);
			const batch = fs.writeBatch(db);
			const ref = fs.doc(db, 'users', uid, 'favorites', id);
			if (op === 'add') batch.set(ref, { addedAt: now });
			else batch.delete(ref);
			batch.update(fs.doc(db, 'users', uid), { ...next, favAt: fs.serverTimestamp(), lastFavId: id });
			try {
				await batch.commit();
				this.#counters = { count: next.favCount, changes: next.favChanges, at: now };
				return true;
			} catch (e) {
				if ((e as { code?: string }).code !== 'permission-denied' || attempt) throw e;
				// Contatori non aggiornati (altro dispositivo, orologio sfasato): si rileggono dal profilo e si riprova una volta.
				this.#counters = countersOf((await fs.getDoc(fs.doc(db, 'users', uid))).data());
			}
		}
		return false;
	}

	/** Carica in background i preferiti locali, dal più vicino nel tempo, finché c'è posto oggi. */
	async #drain(uid: string) {
		const order = await this.#byDate(this.#pending);
		for (const id of order) {
			if (this.#remote?.uid !== uid || !this.#pending.includes(id)) continue;
			try {
				if (!(await this.#serial(() => this.#change('add', id)))) break;
			} catch (e) {
				console.error(e);
				break;
			}
			this.#setPending(this.#pending.filter((x) => x !== id));
		}
		if (this.#remote?.uid === uid && this.#pending.length)
			toast(`${this.#pending.length} preferiti si sincronizzeranno nei prossimi giorni (massimo ${MAX_DAILY_CHANGES} modifiche al giorno). Nel frattempo restano salvati su questo dispositivo.`);
	}

	/** Ordina per data dell'evento (blocchi da 25 come l'API); se la rete manca vale l'ordine dato. */
	async #byDate(ids: string[]): Promise<string[]> {
		if (ids.length <= dailyRoom(this.#counters, Date.now())) return ids;
		try {
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- locale e non reattiva: serve solo a ordinare
			const when = new Map<string, { start: number; end: number }>();
			for (let i = 0; i < ids.length; i += 25) {
				const res = await fetch(`/api/events?ids=${encodeURIComponent(ids.slice(i, i + 25).sort().join(','))}`);
				if (!res.ok) throw new Error();
				for (const e of (await res.json()) as { id: string; startTime: number; endTime: number }[]) when.set(e.id, { start: e.startTime, end: e.endTime });
			}
			return prioritize(ids, when, Date.now());
		} catch {
			return ids;
		}
	}
}

export const session = new Session();
export const favorites = new Favorites();
export const homePlace = new HomePlace();
