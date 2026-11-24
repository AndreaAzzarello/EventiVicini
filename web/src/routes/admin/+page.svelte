<script lang="ts">
	import { PAGE_SIZE, deleteEvent, listEvents } from '$lib/admin';
	import ErrorMessage from '$lib/components/ErrorMessage.svelte';
	import { formatWhen } from '$lib/dates';
	import { CATEGORY_ICONS } from '$lib/categoryIcons';
	import { CATEGORIES, eventPath, type Event } from '$lib/event';
	import { fmtNum } from '$lib/format';
	import { errorMessage } from '$lib/errors';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash from '@lucide/svelte/icons/trash';
	import { toast } from '$lib/toast.svelte';

	let events = $state<Event[] | null>(null);
	let more = $state(false);
	let error = $state('');
	let q = $state('');
	let toDelete = $state<Event | null>(null);
	let dialog: HTMLDialogElement;

	async function load(append = false) {
		error = '';
		try {
			const page = await listEvents(append ? events?.at(-1) : undefined);
			events = append ? [...(events ?? []), ...page] : page;
			more = page.length === PAGE_SIZE;
		} catch (e) {
			console.error(e);
			error = errorMessage(e, 'Non riesco a caricare gli eventi.');
		}
	}
	load();

	const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
	const shown = $derived(
		(events ?? []).filter((e) => !q.trim() || norm(`${e.title} ${e.venueName} ${e.city}`).includes(norm(q.trim())))
	);
	const SOURCE = { manual: 'Manuale', scraper: 'Importato', user: 'Utente' };

	function ask(e: Event) {
		toDelete = e;
		dialog.showModal();
	}
	async function confirmDelete() {
		const e = toDelete!;
		try {
			await deleteEvent(e.id);
			events = events?.filter((x) => x.id !== e.id) ?? null;
			toast(`Eliminato “${e.title}”.`);
		} catch (err) {
			toast(errorMessage(err, 'Eliminazione non riuscita.'));
		}
		dialog.close();
	}
</script>

<div class="head">
	<h1>Eventi</h1>
	<a class="btn btn-primary" href="/admin/eventi/nuovo"><Plus size={20} aria-hidden="true" /> Nuovo evento</a>
</div>

<div class="field search">
	<label for="admin-q">Cerca tra gli eventi caricati</label>
	<input id="admin-q" type="search" bind:value={q} placeholder="Titolo, luogo o città" />
</div>

{#if error}
	<ErrorMessage>{error}</ErrorMessage>
	<button class="btn btn-sm" onclick={() => load()}>Riprova</button>
{:else if events === null}
	<div class="skeleton" style="height: calc(var(--space-7) * 4)" aria-hidden="true"></div>
{:else}
	<p class="muted" role="status">{fmtNum(shown.length)} eventi{q ? ' trovati' : ''}</p>
	<ul class="rows">
		{#each shown as e (e.id)}
			{@const Cat = CATEGORY_ICONS[e.category]}
			<li class="card row">
				<div class="info">
					<a href={eventPath(e)} class="title">{e.title}</a>
					<span class="muted">{formatWhen(e.startTime, e.endTime)} · {e.city || e.address}</span>
					<span class="tags">
						<span class="badge"><Cat size={16} aria-hidden="true" /> {CATEGORIES[e.category]}</span>
						<span class="badge">{SOURCE[e.source]}</span>
						{#if !e.geohash}<span class="badge">Senza geohash</span>{/if}
					</span>
				</div>
				<div class="actions">
					<a class="btn btn-sm" href="/admin/eventi/{e.id}" aria-label="Modifica {e.title}"><Pencil size={16} aria-hidden="true" /> Modifica</a>
					<button class="btn btn-sm btn-danger" onclick={() => ask(e)} aria-label="Elimina {e.title}"><Trash size={16} aria-hidden="true" /> Elimina</button>
				</div>
			</li>
		{/each}
	</ul>
	{#if more}<button class="btn more" onclick={() => load(true)}>Carica altri</button>{/if}
{/if}

<dialog bind:this={dialog} aria-labelledby="adm-del">
	<h2 id="adm-del">Eliminare l’evento?</h2>
	<p>“{toDelete?.title}” sparirà dall’agenda. Se è importato, il prossimo import potrebbe ricrearlo.</p>
	<div class="dlg-actions">
		<button class="btn" onclick={() => dialog.close()}>Annulla</button>
		<button class="btn btn-danger" onclick={confirmDelete}>Elimina</button>
	</div>
</dialog>

<style>
	.head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-3);
	}
	.search {
		max-width: var(--w-dialog);
	}
	.rows {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: var(--space-2);
	}
	.row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-3);
		padding: var(--space-3);
	}
	.info {
		flex: 1 1 calc(var(--space-7) * 4);
		display: grid;
		gap: var(--space-1);
		min-width: 0;
	}
	.muted {
		font-variant-numeric: tabular-nums;
	}
	.title {
		font-weight: var(--fw-strong);
		color: var(--text);
		overflow-wrap: break-word;
	}
	.tags {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.actions {
		display: flex;
		gap: var(--space-2);
		flex: none;
	}
	.more {
		margin-top: var(--space-3);
	}
	.dlg-actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
	}
</style>
