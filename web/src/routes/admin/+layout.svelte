<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import LoginPanel from '$lib/components/LoginPanel.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import { session } from '$lib/session.svelte';

	let { children } = $props();
	onMount(() => {
		session.start();
	});
	const tabs = [
		{ href: '/admin', label: 'Eventi' },
		{ href: '/admin/proposte', label: 'Proposte' },
		{ href: '/admin/segnalazioni', label: 'Segnalazioni' },
		{ href: '/admin/statistiche', label: 'Statistiche' },
		{ href: '/admin/stile', label: 'Stile' }
	];
</script>

<Seo title="Admin" noindex />

<div class="container page">
	{#if session.status !== 'ready'}
		<p class="muted" role="status">Verifico l’accesso…</p>
	{:else if !session.user}
		<h1>Area riservata</h1>
		<LoginPanel next={page.url.pathname} />
	{:else if !session.user.isAdmin}
		<h1>Area riservata</h1>
		<p class="notice">Questo account non ha i permessi di amministrazione.</p>
	{:else}
		<nav class="tabs" aria-label="Sezioni admin">
			{#each tabs as t (t.href)}
				<a href={t.href} aria-current={page.url.pathname === t.href ? 'page' : undefined}>{t.label}</a>
			{/each}
		</nav>
		{@render children()}
	{/if}
</div>

<style>
	.page {
		padding-top: var(--space-4);
	}
	.tabs {
		display: flex;
		gap: var(--space-1);
		border-bottom: 1px solid var(--border);
		margin-bottom: var(--space-4);
		overflow-x: auto;
	}
	.tabs a {
		display: inline-flex;
		align-items: center;
		min-height: var(--control);
		padding: 0 var(--space-2);
		color: var(--muted);
		font-weight: var(--fw-strong);
		text-decoration: none;
		border-bottom: 2px solid transparent;
	}
	@media (min-width: 480px) {
		.tabs a {
			padding: 0 var(--space-3);
		}
	}
	.tabs a[aria-current='page'] {
		color: var(--accent);
		border-color: var(--accent);
	}
</style>
