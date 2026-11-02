<script lang="ts">
	import { CATEGORY_ICONS } from '$lib/categoryIcons';
	import { MAX_DAYS, dayInput, parseDay, romeParts, romeTime, shortDate, type DateWindow } from '$lib/dates';
	import { CATEGORIES, type Category } from '$lib/event';
	import { EMPTY_FILTER, type Filter } from '$lib/filters';
	import { RADII_KM } from '$lib/geo';
	import CalendarDays from '@lucide/svelte/icons/calendar-days';
	import X from '@lucide/svelte/icons/x';

	import type { Snippet } from 'svelte';

	let {
		filter,
		onchange,
		showRadius = true,
		children
	}: { filter: Filter; onchange: (f: Filter) => void; showRadius?: boolean; children?: Snippet } = $props();

	const set = (patch: Partial<Filter>) => onchange({ ...filter, ...patch });
	const active = $derived(filter.q !== '' || filter.when !== 'any' || filter.free || filter.kids || filter.category !== null);

	const PRESETS: [DateWindow, string][] = [
		['today', 'Oggi'],
		['tomorrow', 'Domani'],
		['weekend', 'Weekend'],
		['week', 'Prossimi 7 giorni']
	];

	// Selettore di un giorno o di un periodo, da oggi a MAX_DAYS giorni
	let dialog: HTMLDialogElement;
	let from = $state('');
	let to = $state('');
	const today = new Date();
	const minDay = dayInput(today.getTime());
	const p0 = romeParts(today.getTime());
	const maxDay = dayInput(romeTime(p0.year, p0.month, p0.day + MAX_DAYS));

	const dayLabel = (v: string) => {
		const d = parseDay(v)!;
		return shortDate(romeTime(d[0], d[1], d[2], 12));
	};
	const rangeLabel = $derived(
		filter.when === 'range' && filter.from
			? filter.to && filter.to !== filter.from
				? `${dayLabel(filter.from)} – ${dayLabel(filter.to)}`
				: dayLabel(filter.from)
			: 'Scegli date'
	);

	function openPicker() {
		from = filter.from || '';
		to = filter.to || '';
		dialog.showModal();
	}
	function apply(e: SubmitEvent) {
		e.preventDefault();
		if (!parseDay(from)) return;
		set({ when: 'range', from, to: to && to !== from ? to : '' });
		dialog.close();
	}

	function reset() {
		onchange({ ...EMPTY_FILTER, radiusKm: filter.radiusKm });
	}
</script>

<form class="filters" role="search" onsubmit={(e) => e.preventDefault()}>
	{@render children?.()}
	<div class="row" role="group" aria-label="Filtri">
		{#if showRadius}
			<label class="select-chip">
				<span class="visually-hidden">Distanza massima</span>
				<select value={filter.radiusKm} onchange={(e) => set({ radiusKm: Number(e.currentTarget.value) })}>
					{#each RADII_KM as km (km)}
						<option value={km}>Entro {km} km</option>
					{/each}
				</select>
			</label>
		{/if}
		{#each PRESETS as [w, label] (w)}
			<button type="button" class="chip" aria-pressed={filter.when === w} onclick={() => set({ when: filter.when === w ? 'any' : w, from: '', to: '' })}>{label}</button>
		{/each}
		<button type="button" class="chip" aria-pressed={filter.when === 'range'} aria-haspopup="dialog" onclick={openPicker}>
			<CalendarDays size={16} aria-hidden="true" />{rangeLabel}
		</button>
		<button type="button" class="chip" aria-pressed={filter.free} onclick={() => set({ free: !filter.free })}>Gratis</button>
		<button type="button" class="chip" aria-pressed={filter.kids} onclick={() => set({ kids: !filter.kids })}>Bambini</button>
		<span class="sep" aria-hidden="true"></span>
		{#each Object.entries(CATEGORIES).filter(([value]) => value !== 'kids') as [value, label] (value)}
			{@const Icon = CATEGORY_ICONS[value as Category]}
			<button
				type="button"
				class="chip chip-cat"
				data-cat={value}
				aria-pressed={filter.category === value}
				onclick={() => set({ category: filter.category === value ? null : (value as Category) })}
			>
				<Icon size={16} aria-hidden="true" />{label}
			</button>
		{/each}
		{#if active}
			<button type="button" class="chip reset" onclick={reset}><X size={16} aria-hidden="true" /> Azzera</button>
		{/if}
	</div>
</form>

<dialog bind:this={dialog} aria-labelledby="date-title">
	<form class="picker" onsubmit={apply}>
		<h2 id="date-title">Scegli le date</h2>
		<p class="muted">Un giorno solo, oppure un periodo: fino a {MAX_DAYS} giorni da oggi.</p>
		<label>
			Dal
			<input type="date" required bind:value={from} min={minDay} max={maxDay} />
		</label>
		<label>
			Al (facoltativo)
			<input type="date" bind:value={to} min={from || minDay} max={maxDay} />
		</label>
		<div class="actions">
			<button type="button" class="btn" onclick={() => dialog.close()}>Annulla</button>
			{#if filter.when === 'range'}
				<button type="button" class="btn" onclick={() => (set({ when: 'any', from: '', to: '' }), dialog.close())}>Togli date</button>
			{/if}
			<button type="submit" class="btn btn-primary">Applica</button>
		</div>
	</form>
</dialog>

<style>
	.filters {
		display: grid;
		gap: var(--space-3);
	}
	/* Una sola riga che scorre in orizzontale: la barra resta bassa su mobile */
	.row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		overflow-x: auto;
		padding: 2px;
		margin: 0;
		scrollbar-width: none;
	}
	.row > * {
		flex: none;
	}
	/* Stacco tra i filtri rapidi e le categorie */
	.sep {
		align-self: stretch;
		margin: var(--space-1) 0;
		border-left: 1px solid var(--border);
	}
	/* L'icona di categoria ha il suo colore finché il chip è spento; acceso, tutto segue il testo del chip */
	.chip-cat:not([aria-pressed='true']) :global(svg) {
		color: var(--ink);
	}
	.row::-webkit-scrollbar {
		display: none;
	}
	.select-chip {
		position: relative; /* contiene il testo visually-hidden: fuori dallo scroller allargherebbe la pagina */
	}
	.select-chip select {
		min-height: var(--control);
		width: auto;
		padding: var(--space-1) var(--space-6) var(--space-1) var(--space-3);
		border-radius: var(--radius);
		font-size: var(--text-sm);
	}
	.reset {
		border-style: dashed;
	}
	.picker {
		display: grid;
		gap: var(--space-3);
	}
	.picker h2,
	.picker p {
		margin: 0;
	}
	.picker label {
		display: grid;
		gap: var(--space-1);
		font-weight: 600;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: var(--space-2);
	}
	@media (min-width: 900px) {
		.row {
			flex-wrap: wrap;
			overflow: visible;
		}
		.sep {
			display: none;
		}
	}
</style>
