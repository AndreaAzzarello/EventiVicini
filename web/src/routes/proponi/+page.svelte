<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import EventForm from '$lib/components/EventForm.svelte';
	import LoginPanel from '$lib/components/LoginPanel.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import { session } from '$lib/session.svelte';
	import { submitEvent } from '$lib/submissions';
	import { toast } from '$lib/toast.svelte';

	// Proporre richiede l'account: qui (e solo qui) Firebase parte anche per chi non aveva mai fatto login.
	onMount(() => {
		session.start();
	});

	async function send(input: Parameters<typeof submitEvent>[0]) {
		await submitEvent(input);
		toast('Grazie! La tua proposta è in revisione: trovi lo stato in “Il mio account”.');
		await goto('/account#proposte');
	}
</script>

<Seo title="Proponi un evento" noindex />

<div class="container narrow page">
	<h1>Proponi un evento</h1>
	<p class="muted lead">
		Conosci un concerto, una sagra o un mercatino che manca? Segnalalo: lo controlliamo e, se è tutto in ordine, lo
		pubblichiamo. Il tuo nome non comparirà nell’evento.
	</p>

	{#if session.status !== 'ready'}
		<div class="skeleton" style="height: var(--w-dialog)" aria-hidden="true"></div>
		<p class="visually-hidden" role="status">Caricamento…</p>
	{:else if !session.user}
		<LoginPanel
			next="/proponi"
			title="Accedi per proporre"
			intro="Ci serve sapere chi propone per evitare spam. Bastano Google o un link via email."
		/>
	{:else}
		<EventForm submitLabel="Invia la proposta" onsubmit={send} />
		<p class="hint">Puoi avere fino a 5 proposte in attesa di revisione.</p>
		<p class="hint">Inviando accetti i <a href="/termini">Termini</a>; leggi come trattiamo i dati nella <a href="/privacy">Privacy</a>.</p>
	{/if}
</div>

<style>
	.page {
		padding-top: var(--space-4);
	}
	.lead {
		font-size: var(--text-md);
		margin-bottom: var(--space-4);
	}
</style>
