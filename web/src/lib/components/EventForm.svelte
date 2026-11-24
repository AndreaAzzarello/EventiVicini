<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { fromLocalInput, toLocalInput } from '$lib/dates';
	import {
		CATEGORIES,
		LIMITS,
		PRICE_TYPES,
		parseTags,
		validateEvent,
		type Category,
		type EventErrors,
		type EventInput,
		type PriceType
	} from '$lib/event';
	import { geohashOf, type Place } from '$lib/geo';
	import { errorMessage } from '$lib/errors';
	import { reversePlace, searchPlaces, type GeoResult } from '$lib/geocode';
	import Search from '@lucide/svelte/icons/search';
	import MapPin from '@lucide/svelte/icons/map-pin';
	import ErrorMessage from './ErrorMessage.svelte';
	import PinMap from './PinMap.svelte';

	let {
		initial = {},
		submitLabel = 'Salva',
		onsubmit
	}: { initial?: Partial<EventInput>; submitLabel?: string; onsubmit: (input: EventInput) => Promise<void> } =
		$props();

	// Copia iniziale una tantum: il form poi vive di stato proprio.
	const init = untrack(() => ({ ...initial }));
	let title = $state(init.title ?? '');
	let shortDescription = $state(init.shortDescription ?? '');
	let category = $state<Category>(init.category ?? 'other');
	let priceType = $state<PriceType>(init.priceType ?? 'free');
	let start = $state(init.startTime ? toLocalInput(init.startTime) : '');
	let end = $state(init.endTime ? toLocalInput(init.endTime) : '');
	let venueName = $state(init.venueName ?? '');
	let address = $state(init.address ?? '');
	let lat = $state<number | null>(init.lat ?? null);
	let lng = $state<number | null>(init.lng ?? null);
	let place = $state<Place | null>(
		init.city ? { city: init.city, citySlug: init.citySlug ?? '', province: init.province ?? '', region: init.region ?? '' } : null
	);
	let imageUrl = $state(init.imageUrl ?? '');
	let ticketUrl = $state(init.ticketUrl ?? '');
	let tags = $state((init.tags ?? []).join(', '));

	let errors = $state<EventErrors>({});
	let submitted = $state(false);
	let saving = $state(false);
	let saveError = $state('');
	let geoBusy = $state(false);
	let geoMsg = $state('');
	let candidates = $state<GeoResult[]>([]);
	let summaryEl: HTMLDivElement | undefined = $state();

	const ids = {
		title: 'f-title',
		shortDescription: 'f-desc',
		category: 'f-cat',
		priceType: 'f-price',
		startTime: 'f-start',
		endTime: 'f-end',
		venueName: 'f-venue',
		address: 'f-address',
		place: 'f-find',
		imageUrl: 'f-image',
		ticketUrl: 'f-ticket',
		tags: 'f-tags'
	} as Record<string, string>;

	function build(): EventInput {
		return {
			title: title.trim(),
			shortDescription: shortDescription.trim(),
			category,
			priceType,
			startTime: fromLocalInput(start),
			endTime: fromLocalInput(end || start),
			venueName: venueName.trim(),
			address: address.trim(),
			lat: lat ?? 0,
			lng: lng ?? 0,
			imageUrl: imageUrl.trim(),
			ticketUrl: ticketUrl.trim(),
			tags: parseTags(tags),
			geohash: lat != null && lng != null ? geohashOf({ lat, lng }) : '',
			city: place?.city ?? '',
			citySlug: place?.citySlug ?? '',
			province: place?.province ?? '',
			region: place?.region ?? ''
		};
	}

	// Dopo il primo invio la validazione segue la digitazione.
	$effect(() => {
		if (submitted) errors = validateEvent(build());
	});

	function setFrom(r: GeoResult) {
		lat = r.lat;
		lng = r.lng;
		place = r.place;
		candidates = [];
		geoMsg = r.place ? `Trovato: ${r.label}` : 'Trovato. Controlla il segnaposto sulla mappa.';
	}

	async function find() {
		const q = [address, venueName && !address ? venueName : ''].filter(Boolean).join(', ');
		if (q.trim().length < 3) {
			geoMsg = 'Scrivi prima l’indirizzo (via, numero e città).';
			return;
		}
		geoBusy = true;
		geoMsg = '';
		try {
			const results = await searchPlaces(q, 'address');
			if (!results.length) geoMsg = 'Indirizzo non trovato. Prova a semplificarlo o sposta il segnaposto a mano.';
			else if (results.length === 1) setFrom(results[0]);
			else {
				candidates = results;
				geoMsg = 'Più risultati: scegli quello giusto.';
			}
		} catch (e) {
			geoMsg = (e as Error).message;
		} finally {
			geoBusy = false;
		}
	}

	async function moved(la: number, ln: number) {
		lat = la;
		lng = ln;
		try {
			const hit = await reversePlace(la, ln);
			place = hit?.place ?? null;
			geoMsg = place ? `Comune: ${place.city}${place.province ? ` (${place.province})` : ''}` : 'Comune non riconosciuto qui.';
		} catch (e) {
			geoMsg = (e as Error).message;
		}
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		submitted = true;
		saveError = '';
		const input = build();
		errors = validateEvent(input);
		if (Object.keys(errors).length) {
			await tick();
			summaryEl?.focus();
			return;
		}
		saving = true;
		try {
			await onsubmit(input);
		} catch (err) {
			saveError = errorMessage(err, (err as Error).message || 'Salvataggio non riuscito. Riprova.');
		} finally {
			saving = false;
		}
	}

	const err = (k: keyof EventErrors) => (submitted ? errors[k] : undefined);
	const LABELS: Record<string, string> = {
		title: 'Titolo',
		shortDescription: 'Descrizione',
		startTime: 'Inizio',
		endTime: 'Fine',
		venueName: 'Luogo',
		address: 'Indirizzo',
		place: 'Posizione sulla mappa',
		imageUrl: 'Immagine',
		ticketUrl: 'Biglietti',
		tags: 'Tag',
		category: 'Categoria',
		priceType: 'Prezzo'
	};
</script>

<form class="event-form" novalidate onsubmit={submit}>
	{#if submitted && Object.keys(errors).length}
		<div class="notice summary" tabindex="-1" bind:this={summaryEl} role="alert">
			<strong>Controlla questi campi:</strong>
			<ul>
				{#each Object.entries(errors) as [k, msg] (k)}
					<li><a href="#{ids[k]}">{LABELS[k]}</a>: {msg}</li>
				{/each}
			</ul>
		</div>
	{/if}

	<fieldset>
		<legend>L’evento</legend>
		<div class="field">
			<label for="f-title">Titolo *</label>
			<input id="f-title" type="text" bind:value={title} maxlength={LIMITS.title} required aria-invalid={!!err('title')} aria-describedby="e-title" />
			{#if err('title')}<ErrorMessage id="e-title">{err('title')}</ErrorMessage>{/if}
		</div>
		<div class="field">
			<label for="f-desc">Descrizione</label>
			<textarea id="f-desc" bind:value={shortDescription} maxlength={LIMITS.shortDescription} aria-describedby="h-desc"></textarea>
			<span id="h-desc" class="hint">{shortDescription.length}/{LIMITS.shortDescription} caratteri</span>
		</div>
		<div class="grid2">
			<div class="field">
				<label for="f-cat">Categoria</label>
				<select id="f-cat" bind:value={category}>
					{#each Object.entries(CATEGORIES) as [v, l] (v)}<option value={v}>{l}</option>{/each}
				</select>
			</div>
			<div class="field">
				<label for="f-price">Prezzo</label>
				<select id="f-price" bind:value={priceType}>
					{#each Object.entries(PRICE_TYPES) as [v, l] (v)}<option value={v}>{l}</option>{/each}
				</select>
			</div>
		</div>
	</fieldset>

	<fieldset>
		<legend>Quando</legend>
		<div class="grid2">
			<div class="field">
				<label for="f-start">Inizio *</label>
				<input id="f-start" type="datetime-local" bind:value={start} required aria-invalid={!!err('startTime')} aria-describedby="e-start" />
				{#if err('startTime')}<ErrorMessage id="e-start">{err('startTime')}</ErrorMessage>{/if}
			</div>
			<div class="field">
				<label for="f-end">Fine</label>
				<input id="f-end" type="datetime-local" bind:value={end} min={start} aria-invalid={!!err('endTime')} aria-describedby="e-end h-end" />
				<span id="h-end" class="hint">Se la lasci vuota coincide con l’inizio. Ora italiana.</span>
				{#if err('endTime')}<ErrorMessage id="e-end">{err('endTime')}</ErrorMessage>{/if}
			</div>
		</div>
	</fieldset>

	<fieldset>
		<legend>Dove</legend>
		<div class="field">
			<label for="f-venue">Nome del luogo</label>
			<input id="f-venue" type="text" bind:value={venueName} maxlength={LIMITS.venueName} placeholder="Es. Teatro Comunale" />
		</div>
		<div class="field">
			<label for="f-address">Indirizzo *</label>
			<div class="with-btn">
				<input id="f-address" type="text" bind:value={address} maxlength={LIMITS.address} required placeholder="Via, numero, città" aria-invalid={!!err('address')} aria-describedby="e-address" />
				<button id="f-find" type="button" class="btn" onclick={find} disabled={geoBusy}>
					<Search size={20} aria-hidden="true" /> {geoBusy ? 'Cerco…' : 'Trova'}
				</button>
			</div>
			{#if err('address')}<ErrorMessage id="e-address">{err('address')}</ErrorMessage>{/if}
		</div>
		{#if candidates.length}
			<ul class="candidates">
				{#each candidates as c (c.lat + ',' + c.lng)}
					<li><button type="button" class="btn btn-sm" onclick={() => setFrom(c)}><MapPin size={16} aria-hidden="true" /> {c.label}</button></li>
				{/each}
			</ul>
		{/if}
		<p class="hint" role="status">{geoMsg}</p>
		{#if err('place')}<ErrorMessage>{err('place')}</ErrorMessage>{/if}
		{#if lat != null && lng != null}
			<PinMap {lat} {lng} label="Posizione dell’evento: trascina il segnaposto per correggerla" onmove={moved} />
			<p class="hint">Trascina il segnaposto o tocca la mappa per correggere la posizione.</p>
		{/if}
	</fieldset>

	<fieldset>
		<legend>Link e dettagli</legend>
		<div class="field">
			<label for="f-ticket">Link biglietti o informazioni</label>
			<input id="f-ticket" type="url" bind:value={ticketUrl} placeholder="https://" inputmode="url" aria-invalid={!!err('ticketUrl')} aria-describedby="e-ticket" />
			{#if err('ticketUrl')}<ErrorMessage id="e-ticket">{err('ticketUrl')}</ErrorMessage>{/if}
		</div>
		<div class="field">
			<label for="f-image">Immagine (link)</label>
			<input id="f-image" type="url" bind:value={imageUrl} placeholder="https://…/foto.jpg" inputmode="url" aria-invalid={!!err('imageUrl')} aria-describedby="h-image e-image" />
			<span id="h-image" class="hint">Solo un link a un’immagine già online, che hai il diritto di usare.</span>
			{#if err('imageUrl')}<ErrorMessage id="e-image">{err('imageUrl')}</ErrorMessage>{/if}
		</div>
		<div class="field">
			<label for="f-tags">Tag</label>
			<input id="f-tags" type="text" bind:value={tags} placeholder="all'aperto, family" aria-describedby="h-tags e-tags" />
			<span id="h-tags" class="hint">Separati da virgola. “family” o “kids” lo mostrano anche nel filtro Bambini.</span>
			{#if err('tags')}<ErrorMessage id="e-tags">{err('tags')}</ErrorMessage>{/if}
		</div>
	</fieldset>

	{#if saveError}<ErrorMessage>{saveError}</ErrorMessage>{/if}
	<button class="btn btn-primary submit" disabled={saving}>{saving ? 'Salvataggio…' : submitLabel}</button>
</form>

<style>
	.event-form {
		display: grid;
		gap: var(--space-4);
	}
	fieldset {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: var(--space-3) var(--space-3) var(--space-1);
		margin: 0;
		background: var(--surface);
		min-width: 0;
	}
	legend {
		padding: 0 var(--space-2);
		font-family: var(--font-display);
		font-weight: var(--fw-strong);
		font-size: var(--text-lg);
	}
	.grid2 {
		display: grid;
		gap: 0 var(--space-3);
	}
	@media (min-width: 560px) {
		.grid2 {
			grid-template-columns: 1fr 1fr;
		}
	}
	.with-btn {
		display: flex;
		gap: var(--space-2);
	}
	.with-btn input {
		flex: 1;
	}
	.candidates {
		list-style: none;
		padding: 0;
		margin: 0 0 var(--space-2);
		display: grid;
		gap: var(--space-1);
		justify-items: start;
	}
	.summary ul {
		margin: var(--space-2) 0 0;
		padding-left: var(--space-4);
	}
	.summary a {
		color: inherit;
	}
	.submit {
		justify-self: start;
	}
	fieldset :global(.wrap) {
		margin-bottom: var(--space-2);
	}
</style>
