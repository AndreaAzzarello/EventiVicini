<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		authMessage,
		completeEmailLink,
		deleteAccountAndData,
		isEmailLink,
		needsRecentLogin,
		reauthWithGoogle,
		savedEmail,
		sendEmailLink
	} from '$lib/auth';
	import FavoritesList from '$lib/components/FavoritesList.svelte';
	import Download from '@lucide/svelte/icons/download';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash from '@lucide/svelte/icons/trash';
	import ErrorMessage from '$lib/components/ErrorMessage.svelte';
	import LoginPanel from '$lib/components/LoginPanel.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import { formatWhen } from '$lib/dates';
	import { downloadMyData } from '$lib/exportData';
	import { eventPath } from '$lib/event';
	import { session } from '$lib/session.svelte';
	import { STATUS_LABEL, mySubmissions, withdraw, type Submission } from '$lib/submissions';
	import { toast } from '$lib/toast.svelte';

	let name = $state('');
	let city = $state('');
	let profileMsg = $state('');
	let subs = $state<Submission[] | null>(null);
	let subsError = $state('');
	let dialog: HTMLDialogElement;
	let deleting = $state(false);
	let deleteError = $state('');
	let reauthSent = $state(false);
	let exporting = $state(false);

	async function exportData() {
		exporting = true;
		try {
			await downloadMyData();
			toast('File scaricato.');
		} catch (e) {
			console.error(e);
			toast('Non sono riuscito a preparare il file. Riprova tra poco.');
		} finally {
			exporting = false;
		}
	}

	onMount(async () => {
		await session.start();
		// Ritorno dal link di riautenticazione per eliminare l'account.
		if (session.user && (await isEmailLink(location.href))) {
			try {
				await completeEmailLink(savedEmail() || session.user.email, location.href);
				session.user.lastSignIn = Date.now();
				history.replaceState(null, '', '/account');
				dialog.showModal();
			} catch (e) {
				toast(authMessage(e));
			}
		}
	});

	let loadedFor = '';
	$effect(() => {
		const u = session.user;
		if (u && loadedFor !== u.uid) {
			loadedFor = u.uid;
			loadProfile();
			loadSubs();
		}
	});

	async function loadProfile() {
		const fb = await session.start();
		const snap = await fb.fs.getDoc(fb.fs.doc(fb.db, 'users', session.user!.uid));
		name = (snap.data()?.name as string) ?? '';
		city = (snap.data()?.city as string) ?? '';
	}

	async function loadSubs() {
		subsError = '';
		try {
			subs = await mySubmissions();
		} catch (e) {
			console.error(e);
			subsError = 'Non riesco a caricare le tue proposte.';
		}
	}

	async function saveProfile(e: SubmitEvent) {
		e.preventDefault();
		const fb = await session.start();
		try {
			await fb.fs.updateDoc(fb.fs.doc(fb.db, 'users', session.user!.uid), {
				name: name.trim().slice(0, 80),
				city: city.trim().slice(0, 80)
			});
			profileMsg = 'Profilo salvato.';
		} catch {
			profileMsg = 'Salvataggio non riuscito.';
		}
	}

	async function remove(s: Submission) {
		if (!confirm(`Ritirare la proposta “${s.title}”?`)) return;
		try {
			await withdraw(s.id);
			subs = subs?.filter((x) => x.id !== s.id) ?? null;
			toast('Proposta ritirata.');
		} catch {
			toast('Non sono riuscito a ritirare la proposta.');
		}
	}

	async function confirmDelete() {
		const u = session.user!;
		deleting = true;
		deleteError = '';
		try {
			if (needsRecentLogin(u.lastSignIn)) {
				if (u.provider === 'google') {
					await reauthWithGoogle();
				} else {
					await sendEmailLink(u.email, '/account?elimina=1');
					reauthSent = true;
					return;
				}
			}
			await deleteAccountAndData();
			dialog.close();
			toast('Account e dati eliminati. Ci mancherai!');
			await goto('/');
		} catch (e) {
			deleteError = authMessage(e);
		} finally {
			deleting = false;
		}
	}
</script>

<Seo title="Il mio account" noindex />

<div class="container narrow page">
	<h1>Il mio account</h1>

	{#if session.status !== 'ready'}
		<div class="skeleton" style="height: var(--space-7)" aria-hidden="true"></div>
	{:else if !session.user}
		<LoginPanel next="/account" />
	{:else}
		<section class="card block" aria-labelledby="profilo">
			<h2 id="profilo">Profilo</h2>
			<p class="muted">Accesso come <strong>{session.user.email}</strong>{session.user.provider === 'google' ? ' (Google)' : ''}.</p>
			<form onsubmit={saveProfile} class="profile">
				<div class="field">
					<label for="p-name">Nome</label>
					<input id="p-name" type="text" bind:value={name} maxlength="80" autocomplete="name" />
				</div>
				<div class="field">
					<label for="p-city">Città preferita</label>
					<input id="p-city" type="text" bind:value={city} maxlength="80" autocomplete="address-level2" />
				</div>
				<div class="row">
					<button class="btn btn-primary">Salva</button>
					<span class="hint" role="status">{profileMsg}</span>
				</div>
			</form>
			<div class="row start">
				{#if session.user.isAdmin}<a class="btn btn-ghost" href="/admin">Area admin</a>{/if}
				<button class="btn btn-ghost" onclick={() => session.signOut()}>Esci</button>
			</div>
		</section>

		<section class="block" aria-labelledby="pref">
			<h2 id="pref">Preferiti</h2>
			<FavoritesList />
		</section>

		<section class="block" id="proposte" aria-labelledby="prop-h">
			<div class="head">
				<h2 id="prop-h">Le mie proposte</h2>
				<a class="btn btn-sm" href="/proponi"><Plus size={16} aria-hidden="true" /> Nuova</a>
			</div>
			{#if subsError}
				<div class="notice err-row"><ErrorMessage>{subsError}</ErrorMessage> <button class="btn btn-sm" onclick={loadSubs}>Riprova</button></div>
			{:else if subs === null}
				<div class="skeleton" style="height: var(--space-7)" aria-hidden="true"></div>
			{:else if subs.length === 0}
				<p class="muted">Non hai ancora proposto eventi.</p>
			{:else}
				<ul class="subs">
					{#each subs as s (s.id)}
						<li class="card sub">
							<div>
								<span class="badge">{STATUS_LABEL[s.status]}</span>
								<h3>{s.title}</h3>
								<p class="muted">{formatWhen(s.startTime, s.endTime)} · {s.city}</p>
								{#if s.status === 'rejected' && s.rejectReason}<p class="reason"><strong>Motivo:</strong> {s.rejectReason}</p>{/if}
							</div>
							{#if s.status === 'approved' && s.eventId}
								<a class="btn btn-sm" href={eventPath({ id: s.eventId, title: s.title })}>Vedi</a>
							{:else if s.status === 'pending'}
								<button class="btn btn-sm btn-danger" onclick={() => remove(s)}>Ritira</button>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<section class="block" aria-labelledby="exp-h">
			<h2 id="exp-h">Scarica i tuoi dati</h2>
			<p class="muted">
				Un file JSON con profilo, preferiti, proposte e ciò che è salvato su questo dispositivo. Si prepara nel tuo browser.
			</p>
			<button class="btn" onclick={exportData} disabled={exporting}>
				<Download size={20} aria-hidden="true" /> {exporting ? 'Preparo il file…' : 'Scarica i miei dati'}
			</button>
		</section>

		<section class="block danger" aria-labelledby="del-h">
			<h2 id="del-h">Elimina account e dati</h2>
			<p class="muted">
				Cancelliamo profilo, preferiti, proposte e l’account di accesso. Gli eventi già pubblicati restano, senza alcun
				riferimento a te. L’operazione non si può annullare.
			</p>
			<button class="btn btn-danger" onclick={() => ((deleteError = ''), (reauthSent = false), dialog.showModal())}>
				<Trash size={20} aria-hidden="true" /> Elimina account e dati
			</button>
		</section>
	{/if}
</div>

<dialog bind:this={dialog} aria-labelledby="del-title">
	<h2 id="del-title">Eliminare davvero l’account?</h2>
	{#if reauthSent}
		<p class="notice" role="status">
			Per sicurezza ti abbiamo mandato un link a <strong>{session.user?.email}</strong>: aprilo da questo dispositivo per
			confermare l’eliminazione.
		</p>
		<div class="row"><button class="btn" onclick={() => dialog.close()}>Chiudi</button></div>
	{:else}
		<p>Perderai preferiti e proposte. Se è passato un po’ dall’ultimo accesso ti chiederemo di confermare chi sei.</p>
		{#if deleteError}<ErrorMessage>{deleteError}</ErrorMessage>{/if}
		<div class="row">
			<button class="btn" onclick={() => dialog.close()} disabled={deleting}>Annulla</button>
			<button class="btn btn-danger" onclick={confirmDelete} disabled={deleting}>
				<Trash size={20} aria-hidden="true" />
				{deleting ? 'Elimino…' : 'Sì, elimina tutto'}
			</button>
		</div>
	{/if}
</dialog>

<style>
	.page {
		padding-top: var(--space-4);
		display: grid;
		gap: var(--space-4);
	}
	.page h1 {
		margin: 0;
	}
	.block.card {
		padding: var(--space-4);
	}
	.profile {
		display: grid;
		gap: 0 var(--space-3);
	}
	@media (min-width: 560px) {
		.profile {
			grid-template-columns: 1fr 1fr;
		}
		.profile .row {
			grid-column: 1 / -1;
		}
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		align-items: center;
		justify-content: flex-end;
	}
	.row.start,
	.profile .row {
		justify-content: flex-start;
		margin-bottom: var(--space-2);
	}
	.head {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.err-row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		align-items: center;
	}
	.subs {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: var(--space-3);
	}
	.sub {
		display: flex;
		justify-content: space-between;
		align-items: start;
		gap: var(--space-3);
		padding: var(--space-3);
	}
	.sub h3 {
		margin: var(--space-2) 0 var(--space-1);
	}
	.sub p {
		margin: 0;
	}
	.reason {
		margin-top: var(--space-2) !important;
	}
	.danger {
		border-top: 1px solid var(--border);
		padding-top: var(--space-4);
	}
</style>
