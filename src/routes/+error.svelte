<script lang="ts">
	import { page } from '$app/state';
	import { Search, Lock, CircleAlert } from '@lucide/svelte';
	let status = $derived(page.status);
	const ICONS = { search: Search, lock: Lock, exclamation: CircleAlert };
	const m: Record<number, { icon: keyof typeof ICONS; t: string; d: string }> = {
		404: { icon: 'search', t: 'Not found', d: "This page doesn't exist." },
		403: { icon: 'lock', t: 'Access denied', d: "You don't have permission to see this." },
		500: { icon: 'exclamation', t: 'Something went wrong', d: 'An unexpected error occurred.' }
	};
	let x = $derived(m[status] ?? m[500]);
	const ErrIcon = $derived(ICONS[x.icon]);
</script>

<svelte:head><title>{x.t} · Ledger</title></svelte:head>

<div
	class="min-h-viewport flex items-center justify-center px-6"
	style="--ws-accent: light-dark(#B4472B, color-mix(in oklch, #B4472B, white 18%)); --accent: var(--ws-accent)"
>
	<div class="text-center">
		<div
			class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl"
			style="background: var(--surface)"
		>
			<ErrIcon class="h-6 w-6" style="color: var(--ink-3)" />
		</div>
		<h1 class="text-[22px]">{x.t}</h1>
		<p class="mt-1 text-[15px]" style="color: var(--ink-3)">{x.d}</p>
		{#if page.error?.errorId}
			<!-- Quotable, so "it broke" can be matched to the one log line that says why. -->
			<p class="num mt-3 text-[12px]" style="color: var(--ink-3)">
				Reference {page.error.errorId.slice(-8)}
			</p>
		{/if}
		<a href="/" class="btn btn-accent mt-6">Go home</a>
	</div>
</div>
