<script lang="ts">
	import '@fontsource/fraunces/latin-600.css';
	import '@fontsource/fraunces/latin-600-italic.css';
	import '../app.css';
	import frauncesUrl from '@fontsource/fraunces/files/fraunces-latin-600-normal.woff2?url';
	import frauncesItalicUrl from '@fontsource/fraunces/files/fraunces-latin-600-italic.woff2?url';
	import { onMount } from 'svelte';
	import { dev } from '$app/environment';
	import { env as pub } from '$env/dynamic/public';
	import { page } from '$app/state';
	import Heart from '@lucide/svelte/icons/heart';
	import Moon from '@lucide/svelte/icons/moon';
	import Plus from '@lucide/svelte/icons/plus';
	import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
	import Sun from '@lucide/svelte/icons/sun';
	import User from '@lucide/svelte/icons/user';
	import X from '@lucide/svelte/icons/x';
	import { favorites, session } from '$lib/session.svelte';
	import { KEYS, readJson, writeJson } from '$lib/storage';
	import { dismiss, pause, resume, toasts } from '$lib/toast.svelte';

	let { children } = $props();
	let theme = $state<'light' | 'dark' | null>(null);

	onMount(() => {
		theme = readJson(KEYS.theme, null);
		favorites.load();
		session.resume();
		if (!dev && 'serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js');
	});

	function toggleTheme() {
		const current =
			theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
		theme = current === 'dark' ? 'light' : 'dark';
		document.documentElement.dataset.theme = theme;
		writeJson(KEYS.theme, theme);
	}

	const nav = [
		{ href: '/proponi', label: 'Proponi', icon: Plus },
		{ href: '/preferiti', label: 'Preferiti', icon: Heart }
	] as const;
	const active = (href: string) => page.url.pathname.startsWith(href);
</script>

<svelte:head>
	<link rel="preload" href={frauncesUrl} as="font" type="font/woff2" crossorigin="anonymous" />
	<link rel="preload" href={frauncesItalicUrl} as="font" type="font/woff2" crossorigin="anonymous" />
	<!-- Statistiche aggregate senza cookie né storage (Cloudflare Web Analytics): attive solo se il token è configurato. -->
	{#if pub.PUBLIC_CF_BEACON_TOKEN}
		<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon={JSON.stringify({ token: pub.PUBLIC_CF_BEACON_TOKEN })}></script>
	{/if}
</svelte:head>

<a class="skip" href="#main">Vai al contenuto</a>

<header class="site-header">
	<div class="container bar">
		<a class="brand" href="/" aria-label="Eventi Vicini, home">
			<svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true">
				<path fill="var(--accent)" d="M16 2a11 11 0 0 0-11 11c0 8.2 11 17 11 17s11-8.8 11-17A11 11 0 0 0 16 2z" />
				<rect x="10.5" y="9" width="11" height="10" rx="2" fill="none" stroke="var(--accent-ink)" stroke-width="2" />
				<path d="M10.5 12.5h11M13.5 7.5v3M18.5 7.5v3" stroke="var(--accent-ink)" stroke-width="2" stroke-linecap="round" />
			</svg>
			<span>Eventi <em class="display-em">Vicini</em></span>
		</a>
		<nav aria-label="Principale">
			{#each nav as item (item.href)}
				<a href={item.href} class="nav-link" class:nav-extra={item.href === '/proponi'} aria-current={active(item.href) ? 'page' : undefined}>
					<item.icon size={20} aria-hidden="true" />
					<span class="nav-text">{item.label}</span>
				</a>
			{/each}
			{#if session.user}
				<a href="/account" class="nav-link" aria-current={active('/account') ? 'page' : undefined}>
					<span class="avatar" aria-hidden="true">{(session.user.name || session.user.email || '?')[0].toUpperCase()}</span>
					<span class="nav-text">Account</span>
				</a>
				{#if session.user.isAdmin}
					<a href="/admin" class="nav-link nav-admin" aria-current={active('/admin') ? 'page' : undefined}>
						<SlidersHorizontal size={20} aria-hidden="true" /><span class="nav-text">Admin</span>
					</a>
				{/if}
			{:else}
				<a href="/accedi" class="nav-link" aria-current={active('/accedi') ? 'page' : undefined}>
					<User size={20} aria-hidden="true" /><span class="nav-text">Accedi</span>
				</a>
			{/if}
			<button class="nav-link theme" onclick={toggleTheme} aria-label="Cambia tema chiaro/scuro">
				<span class="sun"><Sun size={20} aria-hidden="true" /></span><span class="moon"><Moon size={20} aria-hidden="true" /></span>
			</button>
		</nav>
	</div>
</header>

<main id="main" tabindex="-1">
	{@render children()}
</main>

<footer class="site-footer">
	<div class="container foot">
		<div>
			<p class="foot-brand">Eventi <em class="display-em">Vicini</em></p>
			<p class="muted">L’agenda degli eventi vicino a te. Gratis, senza pubblicità e senza tracciamento.</p>
		</div>
		<nav aria-label="Informazioni">
			<a href="/proponi">Proponi un evento</a>
			<a href="/privacy">Privacy</a>
			<a href="/cookie">Cookie</a>
			<a href="/termini">Termini</a>
		</nav>
		<p class="muted small">
			Eventi dai siti istituzionali dei Comuni (fonte citata in ogni scheda) e dagli utenti. Mappe &copy;
			<a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>.
		</p>
	</div>
</footer>

<div class="toasts" aria-live="polite" aria-atomic="false">
	{#each toasts as t (t.id)}
		<!-- Mouse sopra o focus dentro: il conto alla rovescia si ferma, così c'è tempo di leggere e di premere il link. -->
		<div
			class="toast"
			role="status"
			onmouseenter={() => pause(t.id, 'mouse')}
			onmouseleave={() => resume(t.id, 'mouse')}
			onfocusin={() => pause(t.id, 'focus')}
			onfocusout={() => resume(t.id, 'focus')}
		>
			<span>{t.text}</span>
			{#if t.action}<a class="btn btn-primary btn-sm" href={t.action.href} onclick={() => dismiss(t.id)}>{t.action.label}</a>{/if}
			<button class="btn btn-ghost btn-sm close" onclick={() => dismiss(t.id)} aria-label="Chiudi avviso"><X size={16} aria-hidden="true" /></button>
		</div>
	{/each}
</div>

<style>
	.skip {
		position: absolute;
		left: var(--space-2);
		top: calc(-1 * var(--header-h));
		z-index: 100;
		padding: var(--space-2) var(--space-3);
		background: var(--text);
		color: var(--bg);
		border-radius: var(--radius-sm);
	}
	.skip:focus {
		top: var(--space-2);
	}
	.site-header {
		position: sticky;
		top: 0;
		z-index: 1000;
		background: var(--bg);
		border-bottom: 1px solid var(--border);
	}
	.bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		height: var(--header-h);
	}
	.brand {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		color: var(--text);
		text-decoration: none;
		font: var(--fw-strong) var(--text-lg)/1 var(--font-display);
		white-space: nowrap;
		min-width: 0;
	}
	.brand span {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.brand svg {
		flex-shrink: 0;
	}
	nav[aria-label='Principale'] {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		flex-shrink: 0;
	}
	.nav-link {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		min-height: var(--control);
		min-width: var(--control);
		justify-content: center;
		padding: 0 var(--space-2);
		border: none;
		border-radius: var(--radius);
		background: none;
		color: var(--text);
		font: var(--fw-strong) var(--text-sm) var(--font-body);
		text-decoration: none;
		cursor: pointer;
	}
	.nav-link:hover {
		background: var(--surface-2);
		color: var(--text);
	}
	.nav-link[aria-current='page'] {
		color: var(--accent);
	}
	.nav-text {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
	.avatar {
		display: grid;
		place-items: center;
		width: var(--control-sm);
		height: var(--control-sm);
		border-radius: var(--radius-full);
		background: var(--accent);
		color: var(--accent-ink);
		font-size: var(--text-sm);
	}
	.theme {
		border-radius: var(--radius-full);
	}
	.theme .moon {
		display: none;
	}
	:global([data-theme='dark']) .theme .sun {
		display: none;
	}
	:global([data-theme='dark']) .theme .moon {
		display: inline;
	}
	@media (prefers-color-scheme: dark) {
		:global(:root:not([data-theme='light'])) .theme .sun {
			display: none;
		}
		:global(:root:not([data-theme='light'])) .theme .moon {
			display: inline;
		}
	}
	/* Su schermi stretti il nome intero ha la precedenza: "Proponi" è nel footer, "Admin" nella pagina account. */
	@media (max-width: 479px) {
		.nav-extra,
		.nav-admin {
			display: none;
		}
	}
	@media (max-width: 419px) {
		.brand {
			font-size: var(--text-md);
			gap: var(--space-1);
		}
		nav[aria-label='Principale'] {
			gap: 0;
		}
		.nav-link {
			padding: 0;
		}
	}
	@media (min-width: 720px) {
		.nav-text {
			position: static;
			width: auto;
			height: auto;
			overflow: visible;
			clip: auto;
		}
	}
	main {
		min-height: calc(100vh - var(--header-h) - var(--space-7) * 3);
		outline: none;
	}
	.site-footer {
		margin-top: var(--space-7);
		border-top: 1px solid var(--border);
		background: var(--surface-2);
		padding: var(--space-5) 0 var(--space-7);
	}
	.foot {
		display: grid;
		gap: var(--space-3);
	}
	.foot-brand {
		font: var(--fw-strong) var(--text-lg) var(--font-display);
		margin: 0 0 var(--space-1);
	}
	.foot nav {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1) var(--space-4);
	}
	.foot nav a {
		display: inline-flex;
		align-items: center;
		min-height: var(--control);
		color: var(--text);
		font-weight: var(--fw-strong);
	}
	.small {
		font-size: var(--text-sm);
	}
	.small a {
		color: inherit;
	}
	@media (min-width: 720px) {
		.foot {
			grid-template-columns: 2fr 1fr;
		}
		.small {
			grid-column: 1 / -1;
		}
	}
	.toasts {
		position: fixed;
		left: 50%;
		bottom: max(var(--space-3), env(safe-area-inset-bottom));
		transform: translateX(-50%);
		z-index: 2000;
		display: grid;
		gap: var(--space-2);
		width: min(var(--w-dialog), 100% - 2 * var(--space-3));
	}
	.toast {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-3);
		padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
		border-radius: var(--radius);
		background: var(--text);
		color: var(--bg);
		box-shadow: var(--shadow-overlay);
	}
	.toast span {
		flex: 1;
	}
	.toast .close {
		--b-fg: var(--bg);
	}
</style>
