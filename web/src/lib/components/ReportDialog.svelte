<script lang="ts">
	import Flag from '@lucide/svelte/icons/flag';
	import { REASONS, REPORT_LIMITS, alreadyReported, sendReport, validateReport, type Reason } from '$lib/reports';
	import { toast } from '$lib/toast.svelte';
	import ErrorMessage from './ErrorMessage.svelte';

	// Segnalazione di un contenuto (DSA, art. 16): aperta a tutti, anche senza account.
	let { eventId, title, contact }: { eventId: string; title: string; contact: string } = $props();

	let dialog: HTMLDialogElement;
	let reason = $state<Reason>('misleading');
	let text = $state('');
	let email = $state('');
	let trap = $state(''); // campo esca: le persone non lo vedono, molti bot lo riempiono
	let error = $state('');
	let busy = $state(false);
	let done = $state(false);
	let already = $state(false);

	function open() {
		already = alreadyReported(eventId);
		error = '';
		dialog.showModal();
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		const input = { eventId, reason, text, email };
		error = validateReport(input) ?? '';
		if (error) return;
		busy = true;
		try {
			// Se l'esca è piena si fa finta di niente: il bot non impara cosa lo ha fermato.
			if (!trap) await sendReport(input);
			done = true;
			toast('Grazie, la segnalazione è arrivata. La esaminiamo e ti rispondiamo se hai lasciato l’email.');
		} catch (err) {
			console.error(err);
			error = 'Non sono riuscito a inviare la segnalazione. Riprova tra poco, oppure scrivici all’indirizzo qui sotto.';
		} finally {
			busy = false;
		}
	}

	function close() {
		dialog.close();
		if (done) {
			done = false;
			text = '';
			email = '';
		}
	}
</script>

<button type="button" class="btn btn-sm report" onclick={open}><Flag size={16} aria-hidden="true" /> Segnala questo evento</button>

<dialog bind:this={dialog} aria-labelledby="rep-title" onclose={() => (done = false)}>
	{#if done}
		<div class="box">
			<h2 id="rep-title">Segnalazione inviata</h2>
			<p>Grazie. Ogni segnalazione viene esaminata a mano. Se hai lasciato un’email, ti scriviamo cosa abbiamo deciso e perché.</p>
			<div class="actions"><button type="button" class="btn btn-primary" onclick={close}>Chiudi</button></div>
		</div>
	{:else if already}
		<div class="box">
			<h2 id="rep-title">Hai già segnalato questo evento</h2>
			<p>La tua segnalazione è già con noi. Se hai altro da aggiungere, scrivici a <a href={`mailto:${contact}`}>{contact}</a>.</p>
			<div class="actions"><button type="button" class="btn" onclick={close}>Chiudi</button></div>
		</div>
	{:else}
		<form class="box" onsubmit={submit} novalidate>
			<h2 id="rep-title">Segnala “{title}”</h2>
			<p class="muted">Dicci cosa non va: la leggiamo e decidiamo se togliere o correggere l’evento.</p>
			<div class="field">
				<label for="rep-reason">Motivo</label>
				<select id="rep-reason" bind:value={reason}>
					{#each Object.entries(REASONS) as [value, label] (value)}
						<option {value}>{label}</option>
					{/each}
				</select>
			</div>
			<div class="field">
				<label for="rep-text">Spiegazione</label>
				<textarea
					id="rep-text"
					bind:value={text}
					minlength={REPORT_LIMITS.textMin}
					maxlength={REPORT_LIMITS.textMax}
					aria-describedby="rep-text-h"
					aria-invalid={error ? 'true' : undefined}
					placeholder="Es. la data è sbagliata: sul sito del Comune l’evento è il 15 e non il 14."
				></textarea>
				<span id="rep-text-h" class="hint">Almeno {REPORT_LIMITS.textMin} caratteri ({text.trim().length}/{REPORT_LIMITS.textMax}).</span>
			</div>
			<div class="field">
				<label for="rep-email">La tua email (facoltativa)</label>
				<input id="rep-email" type="email" bind:value={email} autocomplete="email" maxlength="254" aria-describedby="rep-email-h" />
				<span id="rep-email-h" class="hint">Serve solo per dirti l’esito. Senza email la segnalazione resta anonima.</span>
			</div>
			<div class="visually-hidden" aria-hidden="true">
				<label>Non compilare questo campo<input type="text" tabindex="-1" autocomplete="off" bind:value={trap} /></label>
			</div>
			{#if error}<ErrorMessage>{error}</ErrorMessage>{/if}
			<p class="hint">
				Inviando accetti i <a href="/termini">Termini</a>; come trattiamo i dati lo trovi nella <a href="/privacy">Privacy</a>.
				Puoi anche scrivere a <a href={`mailto:${contact}`}>{contact}</a>.
			</p>
			<div class="actions">
				<button type="button" class="btn" onclick={close} disabled={busy}>Annulla</button>
				<button class="btn btn-primary" disabled={busy}>{busy ? 'Invio…' : 'Invia la segnalazione'}</button>
			</div>
		</form>
	{/if}
</dialog>

<style>
	.report {
		color: var(--muted);
	}
	.box {
		display: grid;
		gap: var(--space-3);
	}
	.box h2,
	.box p {
		margin: 0;
	}
	.box .field {
		margin-bottom: 0;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: var(--space-2);
	}
</style>
