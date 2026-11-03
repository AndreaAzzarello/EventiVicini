<script lang="ts">
	import { page } from '$app/state';
	import { SITE_NAME, siteUrl } from '$lib/config';
	import { metaDescription } from '$lib/format';

	let {
		title,
		description = 'Concerti, sagre, mostre, mercatini e attività per bambini vicino a te: l’agenda degli eventi in Italia, con mappa e filtri.',
		image = '',
		type = 'website',
		noindex = false,
		path = page.url.pathname
	}: { title: string; description?: string; image?: string; type?: string; noindex?: boolean; path?: string } = $props();

	const full = $derived(title === SITE_NAME ? title : `${title} · ${SITE_NAME}`);
	const canonical = $derived(siteUrl() + path);
	const desc = $derived(metaDescription(description));
	const ogImage = $derived(image || `${siteUrl()}/icons/og.png`);
</script>

<svelte:head>
	<title>{full}</title>
	<meta name="description" content={desc} />
	{#if noindex}<meta name="robots" content="noindex" />{:else}<link rel="canonical" href={canonical} />{/if}
	<meta property="og:site_name" content={SITE_NAME} />
	<meta property="og:locale" content="it_IT" />
	<meta property="og:type" content={type} />
	<meta property="og:title" content={title} />
	<meta property="og:description" content={desc} />
	<meta property="og:url" content={canonical} />
	<meta property="og:image" content={ogImage} />
	<meta name="twitter:card" content={image ? 'summary_large_image' : 'summary'} />
</svelte:head>
