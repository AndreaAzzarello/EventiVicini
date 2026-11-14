<script lang="ts">
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Clock from '@lucide/svelte/icons/clock';
	import ListIcon from '@lucide/svelte/icons/list';
	import MapPin from '@lucide/svelte/icons/map-pin';
	import Ticket from '@lucide/svelte/icons/ticket';
	import X from '@lucide/svelte/icons/x';
	import ZoomIn from '@lucide/svelte/icons/zoom-in';
	import { CATEGORY_ICONS } from '$lib/categoryIcons';
	import { formatWhen } from '$lib/dates';
	import { CATEGORIES, eventPath, PRICE_TYPES, type Event } from '$lib/event';
	import { fmtNum } from '$lib/format';
	import { imageSources } from '$lib/images';
	import CategoryArt from './CategoryArt.svelte';

	// Anteprima di un pin o di un gruppo di eventi nello stesso luogo. Sta fuori da Leaflet (non è un popup):
	// ridisegnare i marker non la tocca. Con `active` mostra un evento, senza elenca il gruppo.
	let {
		group,
		active = null,
		onpick,
		onclose,
		onzoom,
		onlist
	}: {
		group: Event[];
		active?: Event | null;
		onpick: (id: string | null) => void;
		onclose: () => void;
		onzoom: (e: Event) => void;
		onlist: (e: Event) => void;
	} = $props();

	const MAX_LIST = 20;
	let root = $state<HTMLElement>();
	let heading = $state<HTMLElement>();
	let broken = $state(false);
	const img = $derived(active?.imageUrl ? imageSources(active.imageUrl) : null);
	const Icon = $derived(active ? CATEGORY_ICONS[active.category] : null);

	// Il focus passa al titolo a ogni cambio di contenuto: chi usa la tastiera o lo screen reader sente cosa si è aperto.
	$effect(() => {
		void active?.id;
		void group.length;
		broken = false;
		heading?.focus({ preventScroll: true });
		// Su desktop la mappa può uscire dallo schermo: l'anteprima si porta in vista.
		root?.scrollIntoView({ block: 'nearest' });
	});

	function watchBroken(el: HTMLImageElement) {
		if (el.complete && el.naturalWidth === 0) broken = true;
		const fail = () => (broken = true);
		el.addEventListener('error', fail);
		return () => el.removeEventListener('error', fail);
	}
</script>

<div class="sheet" bind:this={root} role="dialog" aria-modal="false" aria-labelledby="sheet-title" data-testid="map-sheet" data-cat={active?.category}>
	<button type="button" class="close" aria-label="Chiudi anteprima" onclick={onclose}><X size={20} aria-hidden="true" /></button>
	{#if active && Icon}
		{#if group.length > 1}
			<button type="button" class="back" onclick={() => onpick(null)}>
				<ArrowLeft size={16} aria-hidden="true" />Tutti gli eventi qui ({fmtNum(group.length)})
			</button>
		{/if}
		<div class="head">
			<div class="text">
				<p class="kicker"><Icon size={16} aria-hidden="true" />{CATEGORIES[active.category]}</p>
				<h2 id="sheet-title" bind:this={heading} tabindex="-1">{active.title}</h2>
			</div>
			<div class="media" aria-hidden="true">
				{#if img && !broken}
					<img src={img.src} srcset={img.srcset} sizes="64px" alt="" width="64" height="64" loading="lazy" decoding="async" referrerpolicy="no-referrer" {@attach watchBroken} />
				{:else}
					<CategoryArt category={active.category} />
				{/if}
			</div>
		</div>
		<ul class="facts">
			<li><Clock size={16} aria-hidden="true" /><span>{formatWhen(active.startTime, active.endTime)}</span></li>
			<li><MapPin size={16} aria-hidden="true" /><span>{active.approxLocation ? 'Luogo da confermare' : active.venueName || active.city}</span></li>
			<li><Ticket size={16} aria-hidden="true" /><span>{PRICE_TYPES[active.priceType]}</span></li>
		</ul>
		<div class="actions">
			<a class="btn btn-primary btn-sm" href={eventPath(active)}>Apri scheda</a>
			<button type="button" class="btn btn-sm" onclick={() => active && onzoom(active)}><ZoomIn size={16} aria-hidden="true" />Zoom qui</button>
			<button type="button" class="btn btn-sm" onclick={() => active && onlist(active)}><ListIcon size={16} aria-hidden="true" />Vedi nella lista</button>
		</div>
	{:else}
		<h2 id="sheet-title" bind:this={heading} tabindex="-1">{fmtNum(group.length)} eventi in questo luogo</h2>
		<ul class="pick">
			{#each group.slice(0, MAX_LIST) as e (e.id)}
				<li>
					<button type="button" onclick={() => onpick(e.id)}>
						<span class="t">{e.title}</span>
						<span class="w">{formatWhen(e.startTime, e.endTime)}</span>
					</button>
				</li>
			{/each}
		</ul>
		{#if group.length > MAX_LIST}<p class="more">E altri {fmtNum(group.length - MAX_LIST)} eventi: avvicina la mappa o usa la lista.</p>{/if}
	{/if}
</div>

<style>
	.sheet {
		position: absolute;
		z-index: 1100;
		left: 0;
		right: 0;
		bottom: 0;
		display: grid;
		gap: var(--space-2);
		max-height: 55%;
		overflow-y: auto;
		padding: var(--space-3) var(--space-4) var(--space-4);
		background: var(--surface);
		color: var(--text);
		border-top: 1px solid var(--border);
		border-radius: var(--radius) var(--radius) 0 0;
		box-shadow: var(--shadow-overlay);
		animation: rise var(--dur) var(--ease);
	}
	@keyframes rise {
		from {
			transform: translateY(100%);
		}
	}
	@media (min-width: 960px) {
		.sheet {
			left: var(--space-3);
			right: auto;
			bottom: var(--space-3);
			width: min(calc(var(--space-7) * 5), calc(100% - var(--space-3) * 2));
			border: 1px solid var(--border);
			border-radius: var(--radius);
			box-shadow: var(--shadow-lift);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.sheet {
			animation: none;
		}
	}
	.close {
		position: absolute;
		top: var(--space-1);
		right: var(--space-1);
		display: grid;
		place-items: center;
		width: var(--control);
		height: var(--control);
		border: 0;
		border-radius: var(--radius-full);
		background: none;
		color: var(--muted);
		cursor: pointer;
	}
	.close:hover {
		color: var(--text);
	}
	.close:focus-visible,
	.back:focus-visible,
	.pick button:focus-visible,
	h2:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.head {
		display: flex;
		gap: var(--space-3);
		align-items: flex-start;
		padding-right: var(--control);
	}
	.text {
		flex: 1;
		min-width: 0;
	}
	.kicker {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		margin: 0 0 var(--space-1);
		font-size: var(--text-sm);
		font-weight: var(--fw-strong);
		color: var(--ink);
	}
	h2 {
		margin: 0;
		font: var(--fw-strong) var(--text-md) / var(--lh-tight) var(--font-display);
		overflow-wrap: anywhere;
	}
	.sheet > h2 {
		padding-right: var(--control);
	}
	.media {
		flex: none;
		width: var(--space-7);
		aspect-ratio: 1;
		border-radius: var(--radius-sm);
		overflow: hidden;
		background: var(--surface-2);
	}
	.media img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.facts {
		display: grid;
		gap: var(--space-1);
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: var(--text-sm);
		color: var(--muted);
	}
	.facts li {
		display: flex;
		align-items: flex-start;
		gap: var(--space-1);
	}
	.facts :global(svg) {
		flex: none;
		margin-top: 2px;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-top: var(--space-1);
	}
	.back {
		justify-self: start;
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		min-height: var(--control-sm);
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent-hover);
		font: inherit;
		font-size: var(--text-sm);
		cursor: pointer;
	}
	.back:hover {
		text-decoration: underline;
	}
	.pick {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.pick li + li {
		border-top: 1px solid var(--border);
	}
	.pick button {
		display: grid;
		gap: 2px;
		width: 100%;
		min-height: var(--control);
		padding: var(--space-2) var(--space-1);
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.pick button:hover .t {
		text-decoration: underline;
	}
	.t {
		font-weight: var(--fw-strong);
		overflow-wrap: anywhere;
	}
	.w,
	.more {
		font-size: var(--text-sm);
		color: var(--muted);
	}
	.more {
		margin: 0;
	}
</style>
