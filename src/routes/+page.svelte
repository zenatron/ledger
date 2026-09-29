<script lang="ts">
	import { Wallet } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import DemoSignIn from '$lib/components/DemoSignIn.svelte';
	import { announcePageOwner } from '$lib/page-owner';

	// This screen means nobody is signed in: whatever pages the service worker
	// kept for offline belonged to someone else, so it lets them go.
	onMount(() => {
		if (!__DEMO__) announcePageOwner(null);
	});
</script>

<svelte:head><title>Ledger</title></svelte:head>

<main
	class="min-h-viewport flex flex-col justify-between gap-8 px-7 py-12"
	style="--ws-accent: light-dark(#B4472B, color-mix(in oklch, #B4472B, white 18%)); --accent: var(--ws-accent)"
>
	<div class="flex items-center gap-2.5 pt-4">
		<div
			class="flex h-9 w-9 items-center justify-center rounded-[9px]"
			style="background: var(--ink); color: var(--paper)"
		>
			<Wallet class="h-5 w-5" />
		</div>
		<span class="section-label" style="letter-spacing: 0.18em">The Ledger</span>
	</div>

	<div>
		<h1 class="text-[clamp(3.4rem,3rem+4vw,4.5rem)] leading-[0.92]">
			Budget<br />together<br /><span style="font-style: italic">in private.</span>
		</h1>
		<p class="mt-5 max-w-[32ch] text-[17px] leading-relaxed" style="color: var(--ink-3)">
			Ledger is a budget for the people you share money with. Log what you spent, or ask before you
			buy. Set budgets and savings goals, and see what's safe to spend this month.
		</p>
	</div>

	<div>
		<!--
			The demo has no identity provider to sign in to, so the button says what
			it does there: it opens the seeded workspace. __DEMO__ is a build-time
			constant, so only one of these two reaches either bundle.
		-->
		{#if __DEMO__}
			<DemoSignIn />
		{:else}
			<a href="/auth/login" class="btn btn-accent w-full py-4 text-[17px]">Sign in with Pocket ID</a
			>
			<p class="mt-4 text-center text-[13px]" style="color: var(--ink-3)">
				Open source · Self-hosted · Passkey auth · Optional AI integration
			</p>
		{/if}
	</div>
</main>
