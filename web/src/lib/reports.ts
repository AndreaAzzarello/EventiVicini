// Segnalazioni di contenuti (DSA, art. 16). Regole e limiti: firebase/firestore.rules, collezione `reports`.
import { session } from './session.svelte';
import { KEYS, readJson, writeJson } from './storage';

export const REASONS = {
	illegal: 'Contenuto illegale',
	misleading: 'Informazioni false o ingannevoli',
	personal: 'Dati personali miei o di altri',
	other: 'Altro'
} as const;
export type Reason = keyof typeof REASONS;

export const REPORT_LIMITS = { textMin: 10, textMax: 1000, decisionMin: 3, decisionMax: 500 } as const;

export interface ReportInput {
	eventId: string;
	reason: Reason;
	text: string;
	email: string;
}

/** Controlli prima dell'invio: gli stessi delle regole, per dire all'utente cosa correggere. */
export function validateReport(r: ReportInput): string | null {
	const text = r.text.trim();
	if (text.length < REPORT_LIMITS.textMin) return `Spiega in almeno ${REPORT_LIMITS.textMin} caratteri cosa non va.`;
	if (text.length > REPORT_LIMITS.textMax) return `Massimo ${REPORT_LIMITS.textMax} caratteri.`;
	const email = r.email.trim();
	if (email && (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) return 'L’indirizzo email non sembra valido.';
	return null;
}

/** Un dispositivo, una segnalazione per evento: freno leggero contro i duplicati (non è una difesa dagli abusi). */
export const alreadyReported = (eventId: string) => readJson<string[]>(KEYS.reported, []).includes(eventId);
const remember = (eventId: string) => writeJson(KEYS.reported, [...new Set([...readJson<string[]>(KEYS.reported, []), eventId])].slice(-200));

export async function sendReport(r: ReportInput): Promise<void> {
	const { fs, db } = await session.start();
	await fs.addDoc(fs.collection(db, 'reports'), {
		eventId: r.eventId,
		reason: r.reason,
		text: r.text.trim(),
		email: r.email.trim(),
		status: 'open',
		createdAt: fs.serverTimestamp()
	});
	remember(r.eventId);
}

export interface Report {
	id: string;
	eventId: string;
	reason: Reason;
	text: string;
	email: string;
	createdAt: number;
}

export function reportFromSnap(id: string, d: Record<string, unknown>): Report {
	const reason = d.reason as Reason;
	return {
		id,
		eventId: String(d.eventId ?? ''),
		reason: reason in REASONS ? reason : 'other',
		text: String(d.text ?? ''),
		email: String(d.email ?? ''),
		createdAt: (d.createdAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0
	};
}
