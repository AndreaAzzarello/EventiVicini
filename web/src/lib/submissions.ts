import type { EventInput } from './event';
import { session } from './session.svelte';

export const MAX_PENDING = 5;

/** Proposta: i campi dell'evento più, facoltativo, il link alla fonte (https, già normalizzato). */
export type SubmissionInput = EventInput & { sourceUrl?: string };

export interface Submission extends SubmissionInput {
	id: string;
	ownerId: string;
	status: 'pending' | 'approved' | 'rejected';
	createdAt: number;
	rejectReason?: string;
	eventId?: string;
}

export class LimitError extends Error {
	constructor() {
		super(`Hai già ${MAX_PENDING} proposte in attesa di revisione: aspetta che le controlliamo prima di inviarne altre.`);
	}
}

const toMs = (v: unknown) => (v && typeof v === 'object' && 'toMillis' in v ? (v as { toMillis(): number }).toMillis() : 0);

export function fromSnap(id: string, d: Record<string, unknown>): Submission {
	return { ...(d as unknown as Submission), id, createdAt: toMs(d.createdAt) };
}

/** Proposta + contatore nella stessa transazione: le regole verificano entrambi (max 5 pending). */
export async function submitEvent(input: SubmissionInput): Promise<string> {
	const fb = await session.start();
	const uid = fb.auth.currentUser?.uid;
	if (!uid) throw new Error('Accedi per proporre un evento.');
	const { fs, db } = fb;
	const userRef = fs.doc(db, 'users', uid);
	const subRef = fs.doc(fs.collection(db, 'submissions'));
	await fs.runTransaction(db, async (tx) => {
		const user = await tx.get(userRef);
		if (!user.exists()) throw new Error('Profilo non ancora pronto: ricarica la pagina e riprova.');
		const count = Number(user.data().pendingCount ?? 0);
		if (count >= MAX_PENDING) throw new LimitError();
		tx.set(subRef, { ...input, ownerId: uid, status: 'pending', createdAt: fs.serverTimestamp() });
		tx.update(userRef, { pendingCount: count + 1, lastSubmissionId: subRef.id });
	});
	return subRef.id;
}

export async function mySubmissions(): Promise<Submission[]> {
	const fb = await session.start();
	const uid = fb.auth.currentUser?.uid;
	if (!uid) return [];
	const { fs, db } = fb;
	const snap = await fs.getDocs(
		fs.query(fs.collection(db, 'submissions'), fs.where('ownerId', '==', uid), fs.orderBy('createdAt', 'desc'))
	);
	return snap.docs.map((d) => fromSnap(d.id, d.data()));
}

/** Ritira una proposta pending liberando il posto nel contatore. */
export async function withdraw(id: string) {
	const fb = await session.start();
	const uid = fb.auth.currentUser!.uid;
	const { fs, db } = fb;
	const b = fs.writeBatch(db);
	b.delete(fs.doc(db, 'submissions', id));
	b.update(fs.doc(db, 'users', uid), { pendingCount: fs.increment(-1), lastSubmissionId: id });
	await b.commit();
}

export const STATUS_LABEL = { pending: 'In revisione', approved: 'Pubblicata', rejected: 'Non pubblicata' } as const;
