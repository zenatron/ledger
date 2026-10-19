<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * The small pill label — "Alpha", "Refund", a model's capability.
	 *
	 * Nine hand-rolled copies had drifted the way Segmented's did: two letter-
	 * spacings, two corner radii, a 14% tint beside a 16% one. They were also set
	 * at 10px, the smallest type in the app, on a phone held at arm's length;
	 * 11px is the floor everything else keeps to.
	 *
	 * `tone` is any colour expression — a state token, usually. `quiet` is the
	 * neutral form for a fact rather than a status (a refund is not a warning).
	 */
	let {
		tone = 'var(--pending)',
		quiet = false,
		caps = true,
		class: extra = '',
		children
	}: {
		tone?: string;
		quiet?: boolean;
		/** Uppercase and tracked out. Off for labels that are names (a capability). */
		caps?: boolean;
		class?: string;
		children: Snippet;
	} = $props();
</script>

<span
	class="rounded-[var(--r-full)] px-1.5 py-0.5 text-[11px] font-semibold {caps
		? 'tracking-[0.06em] uppercase'
		: 'tracking-[0.02em]'} {extra}"
	style={quiet
		? 'background: var(--surface-2); color: var(--ink-3)'
		: `background: color-mix(in oklab, ${tone} 16%, var(--surface)); color: ${tone}`}
	>{@render children()}</span
>
