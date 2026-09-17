<script lang="ts">
	import { page } from '$app/state';
	import { ChevronLeft, ShieldAlert } from '@lucide/svelte';

	let { data } = $props();
	let slug = $derived(page.params.workspace);

	let flagged = $derived(data.events.filter((e) => e.mismatch).length);

	function fmt(iso: string) {
		return new Date(iso).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
			second: '2-digit'
		});
	}
</script>

<div class="mx-auto max-w-lg space-y-4">
	<a
		href="/w/{slug}"
		class="press -ml-1 inline-flex items-center gap-0.5 text-[15px]"
		style="color: var(--ink-3)"
	>
		<ChevronLeft class="h-4 w-4" /> Settings
	</a>
	<h1 class="px-1 text-[28px]">Security log</h1>
	<p class="px-1 text-[13px] leading-relaxed" style="color: var(--ink-3)">
		Sign-ins, role and member changes, invites, tokens and workspace settings, with the device each
		one came from. A session marked <strong>different device</strong> was used somewhere other than where
		it signed in. A browser update does that too, but so does a stolen session.
	</p>

	{#if flagged > 0}
		<div
			class="card flex items-start gap-2.5 p-4 text-[14px]"
			style="color: var(--deny); background: color-mix(in oklab, var(--deny) 12%, var(--surface))"
		>
			<ShieldAlert class="mt-0.5 h-4 w-4 shrink-0" />
			<span>
				{flagged === 1 ? '1 event' : `${flagged} events`} below came from a different device than the
				session signed in on.
			</span>
		</div>
	{/if}

	<div class="card p-2">
		{#if data.events.length === 0}
			<p class="p-3 text-[14px]" style="color: var(--ink-3)">Nothing recorded yet.</p>
		{:else}
			{#each data.events as e, i (e.id)}
				<div class="px-3 py-3 {i > 0 ? 'hairline' : ''}">
					<p class="text-[15px]" style="color: var(--ink)">{e.text}</p>
					<p class="num mt-0.5 text-[12px]" style="color: var(--ink-3)">
						{fmt(e.at)} · {e.device}{#if e.sessionTag}&nbsp;· session {e.sessionTag}{/if}
					</p>
					{#if e.mismatch}
						<p class="mt-0.5 text-[12px] font-medium" style="color: var(--deny)">
							Different device: session signed in on {e.sessionDevice ?? 'another device'}
						</p>
					{/if}
				</div>
			{/each}
		{/if}
	</div>
</div>
