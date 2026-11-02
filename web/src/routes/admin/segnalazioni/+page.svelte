<script lang="ts">
	import { decideReport, loadEvent, openReports } from '$lib/admin';
	import ErrorMessage from '$lib/components/ErrorMessage.svelte';
	import { formatWhen } from '$lib/dates';
	import { eventPath, type Event } from '$lib/event';
	import { REASONS, REPORT_LIMITS, type Report } from '$lib/reports';
	import { toast } from '$lib/toast.svelte';

	type Item = Report & { event: Event | null };
	let items = $state<Item[] | null>(null);
	let error = $state('');
	let deciding = $state<{ item: Item; remove: boolean } | null>(null);
	let decision = $state('');
	let busy = $state(false);
	let dialog: HTMLDialogElement;

	async function load() {
		error = '';
		try {
			const reports = await openReports();
			items = await Promise.all(reports.map(async (r) => ({ ...r, event: await loadEvent(r.eventId).catch(() => null) })));
		} catch (e) {
			console.error(e);
			error = 'Non riesco a caricare le segnalazioni.';
		}
	}
	load();

	function ask(item: Item, remove: boolean) {
		deciding = { item, remove };
		decision = '';
		dialog.showModal();
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		const { item, remove } = deciding!;
		busy = true;
		try {
			await decideReport(item, remove, decision);
			items = items?.filter((x) => x.id !== item.id) ?? null;
			toast(remove ? 'Evento rimosso e segnalazione chiusa.' : 'Segnalazione respinta.');
			dialog.close();
		} catch (err) {
			console.error(err);
			toast('Decisione non registrata.');
		} finally {
			busy = false;
		}
	}

	const when = (ms: number) => (ms ? new Date(ms).toLocaleDateString('it-IT', { timeZone: 'Europe/Rome', day: 'numeric', month: 'short', year: 'numeric' }) : '');

	// L'esito va comunicato a chi ha segnalato (DSA, art. 17): l'email è facoltativa, quindi non sempre c'è.
	const reply = (i: Item, remove: boolean, why: string) =>
		`mailto:${i.email}?subject=${encodeURIComponent('La tua segnalazione su Eventi Vicini')}&body=${encodeURIComponent(
			`Ciao, abbiamo esaminato la tua segnalazione su “${i.event?.title ?? i.eventId}”.\n\nEsito: ${remove ? 'evento rimosso' : 'segnalazione respinta'}.\nMotivo: ${why}\n\nSe non sei d’accordo rispondi a questa email: riesaminiamo la decisione.`
		)}`;
</script>

<h1>Segnalazioni</h1>

{#if error}
	<ErrorMessage>{error}</ErrorMessage>
	<button class="btn btn-sm" onclick={load}>Riprova</button>
{:else if items === null}
	<div class="skeleton" style="height: calc(var(--space-7) * 3)" aria-hidden="true"></div>
{:else if items.length === 0}
	<p class="notice">Nessuna segnalazione aperta.</p>
{:else}
	<ul class="list">
		{#each items as r (r.id)}
			<li class="card item">
				<div class="meta">
					<span class="badge">{REASONS[r.reason]}</span>
					<span class="muted">{when(r.createdAt)}</span>
				</div>
				{#if r.event}
					<h2><a href={eventPath(r.event)}>{r.event.title}</a></h2>
					<p class="muted">{formatWhen(r.event.startTime, r.event.endTime)} · {r.event.city}</p>
				{:else}
					<h2>Evento non più presente</h2>
					<p class="muted">{r.eventId}</p>
				{/if}
				<p class="text">{r.text}</p>
				<p class="muted">{r.email ? `Contatto: ${r.email}` : 'Anonima'}</p>
				<div class="actions">
					<button class="btn" onclick={() => ask(r, false)} disabled={busy}>Respingi</button>
					{#if r.event}<button class="btn btn-danger" onclick={() => ask(r, true)} disabled={busy}>Rimuovi l’evento</button>{/if}
				</div>
			</li>
		{/each}
	</ul>
{/if}

<dialog bind:this={dialog} aria-labelledby="dec-title">
	<form onsubmit={submit}>
		<h2 id="dec-title">{deciding?.remove ? 'Rimuovi' : 'Respingi la segnalazione su'} “{deciding?.item.event?.title ?? deciding?.item.eventId}”</h2>
		<div class="field">
			<label for="dec-why">Motivazione (va comunicata a chi ha segnalato)</label>
			<textarea
				id="dec-why"
				bind:value={decision}
				required
				minlength={REPORT_LIMITS.decisionMin}
				maxlength={REPORT_LIMITS.decisionMax}
				placeholder={deciding?.remove ? 'Es. il Comune ha annullato l’evento.' : 'Es. la data coincide con quella del sito del Comune.'}
			></textarea>
		</div>
		{#if deciding?.item.email}
			<p class="hint">Dopo aver confermato, apri il messaggio preparato per scrivere l’esito: <a href={reply(deciding.item, deciding.remove, decision || '…')}>scrivi a {deciding.item.email}</a>.</p>
		{/if}
		<div class="actions">
			<button type="button" class="btn" onclick={() => dialog.close()}>Annulla</button>
			<button class="btn btn-primary" disabled={busy || decision.trim().length < REPORT_LIMITS.decisionMin}>Conferma</button>
		</div>
	</form>
</dialog>

<style>
	.list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: var(--space-3);
		max-width: var(--w-prose);
	}
	.item {
		padding: var(--space-3) var(--space-4);
	}
	.item h2 {
		margin: var(--space-2) 0 var(--space-1);
		font-size: var(--text-lg);
	}
	.item p {
		margin: 0 0 var(--space-2);
	}
	.meta {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-3);
	}
	.text {
		white-space: pre-line;
		overflow-wrap: anywhere;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: var(--space-2);
		margin-top: var(--space-3);
	}
</style>
