<script lang="ts">
	import { approve, pendingSubmissions, reject } from '$lib/admin';
	import ErrorMessage from '$lib/components/ErrorMessage.svelte';
	import PinMap from '$lib/components/PinMap.svelte';
	import { formatWhen } from '$lib/dates';
	import { CATEGORY_ICONS } from '$lib/categoryIcons';
	import Check from '@lucide/svelte/icons/check';
	import X from '@lucide/svelte/icons/x';
	import { CATEGORIES, LISTING_NOTE, PRICE_TYPES, eventPath } from '$lib/event';
	import type { Submission } from '$lib/submissions';
	import { errorMessage } from '$lib/errors';
	import { toast } from '$lib/toast.svelte';

	let subs = $state<Submission[] | null>(null);
	let error = $state('');
	let open = $state<string | null>(null);
	let rejecting = $state<Submission | null>(null);
	let reason = $state('');
	let busy = $state(false);
	let dialog: HTMLDialogElement;

	async function load() {
		error = '';
		try {
			subs = await pendingSubmissions();
		} catch (e) {
			console.error(e);
			error = errorMessage(e, 'Non riesco a caricare le proposte.');
		}
	}
	load();

	async function doApprove(s: Submission) {
		busy = true;
		try {
			const id = await approve(s);
			subs = subs?.filter((x) => x.id !== s.id) ?? null;
			toast(`Pubblicato “${s.title}”. ${LISTING_NOTE}`, { label: 'Vedi', href: eventPath({ id, title: s.title }) }, 12000);
		} catch (e) {
			console.error(e);
			toast(errorMessage(e, 'Approvazione non riuscita.'));
		} finally {
			busy = false;
		}
	}

	function askReject(s: Submission) {
		rejecting = s;
		reason = '';
		dialog.showModal();
	}

	async function doReject(e: SubmitEvent) {
		e.preventDefault();
		const s = rejecting!;
		busy = true;
		try {
			await reject(s, reason);
			subs = subs?.filter((x) => x.id !== s.id) ?? null;
			toast('Proposta rifiutata: l’autore vedrà il motivo.');
			dialog.close();
		} catch (err) {
			console.error(err);
			toast(errorMessage(err, 'Rifiuto non riuscito.'));
		} finally {
			busy = false;
		}
	}
</script>

<h1>Proposte in attesa</h1>

{#if error}
	<ErrorMessage>{error}</ErrorMessage>
	<button class="btn btn-sm" onclick={load}>Riprova</button>
{:else if subs === null}
	<div class="skeleton" style="height: calc(var(--space-7) * 3)" aria-hidden="true"></div>
{:else if subs.length === 0}
	<p class="notice">Nessuna proposta da revisionare.</p>
{:else}
	<ul class="list">
		{#each subs as s (s.id)}
			{@const Cat = CATEGORY_ICONS[s.category]}
			<li class="card item">
				<div class="top">
					<div>
						<div class="meta">
							<span class="badge"><Cat size={16} aria-hidden="true" /> {CATEGORIES[s.category]}</span>
							<span class="badge">{PRICE_TYPES[s.priceType]}</span>
						</div>
						<h2>{s.title}</h2>
						<p class="muted">{formatWhen(s.startTime, s.endTime)} · {s.venueName ? `${s.venueName}, ` : ''}{s.address} ({s.city}{s.province ? `, ${s.province}` : ''})</p>
					</div>
					<button class="btn btn-sm" aria-expanded={open === s.id} onclick={() => (open = open === s.id ? null : s.id)}>
						{open === s.id ? 'Chiudi anteprima' : 'Anteprima'}
					</button>
				</div>
				{#if open === s.id}
					<div class="preview">
						{#if s.imageUrl}<img src={s.imageUrl} alt="Immagine proposta per {s.title}" loading="lazy" referrerpolicy="no-referrer" />{/if}
						{#if s.shortDescription}<p class="desc">{s.shortDescription}</p>{/if}
						<dl>
							{#if s.ticketUrl}<dt>Link</dt><dd><a href={s.ticketUrl} target="_blank" rel="noopener noreferrer nofollow">{s.ticketUrl}</a></dd>{/if}
							{#if s.tags.length}<dt>Tag</dt><dd>{s.tags.join(', ')}</dd>{/if}
							<dt>Regione</dt><dd>{s.region || '—'}</dd>
						</dl>
						<PinMap lat={s.lat} lng={s.lng} label="Posizione proposta" />
					</div>
				{/if}
				<div class="actions">
					<button class="btn btn-danger" onclick={() => askReject(s)} disabled={busy}><X size={20} aria-hidden="true" /> Rifiuta</button>
					<button class="btn btn-primary" onclick={() => doApprove(s)} disabled={busy}><Check size={20} aria-hidden="true" /> Approva</button>
				</div>
			</li>
		{/each}
	</ul>
{/if}

<dialog bind:this={dialog} aria-labelledby="rej-title">
	<form onsubmit={doReject}>
		<h2 id="rej-title">Rifiuta “{rejecting?.title}”</h2>
		<div class="field">
			<label for="rej-reason">Motivo (lo vedrà l’autore)</label>
			<textarea id="rej-reason" bind:value={reason} required minlength="3" maxlength="500" placeholder="Es. evento già presente, date non verificabili…"></textarea>
		</div>
		<div class="actions">
			<button type="button" class="btn" onclick={() => dialog.close()}>Annulla</button>
			<button class="btn btn-danger" disabled={busy || reason.trim().length < 3}>Rifiuta</button>
		</div>
	</form>
</dialog>

<style>
	.meta {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-3);
	}
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
	.top {
		display: flex;
		justify-content: space-between;
		align-items: start;
		gap: var(--space-3);
	}
	.top p {
		margin: 0;
	}
	.top h2 {
		margin: var(--space-2) 0 var(--space-1);
		font-size: var(--text-lg);
	}
	.preview {
		display: grid;
		gap: var(--space-3);
		margin: var(--space-3) 0;
	}
	.preview img {
		max-height: calc(var(--space-7) * 4);
		object-fit: cover;
		border-radius: var(--radius-sm);
	}
	.desc {
		white-space: pre-line;
		overflow-wrap: anywhere;
	}
	dl {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: var(--space-1) var(--space-3);
		margin: 0;
	}
	dt {
		font-weight: var(--fw-strong);
	}
	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
		margin-top: var(--space-3);
	}
</style>
