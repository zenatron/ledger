<script lang="ts">
	/**
	 * The headline card at the top of a planning page: Recurring, Buckets and
	 * Income.
	 *
	 * Text first, as every hero here is: a tracked-out overline names the
	 * figure, the figure is set large in the display face, and one line under it
	 * says what it is made of. Whatever a page adds below that (a ribbon, a
	 * legend, a footnote) goes in `children`.
	 *
	 * One component so the three pages can't drift. They used to: Recurring had
	 * this statement, while Buckets and Income opened on a two-up box of
	 * small numbers or on nothing at all, so the same tab read three ways.
	 *
	 * The wash in the corner takes `tint`: the workspace accent by default, the
	 * chosen category's colour on Recurring, the approve green on Income.
	 */
	import type { Snippet } from 'svelte';
	import Money from '$lib/components/Money.svelte';

	let {
		overline,
		minor,
		currency,
		tint = 'var(--ws-accent)',
		label,
		sign = false,
		icon,
		line,
		children
	}: {
		overline: string;
		minor: bigint;
		currency: string;
		tint?: string;
		/** Names the region for assistive tech. */
		label: string;
		/** Prefix a + on a positive figure (income). */
		sign?: boolean;
		/** An emoji ahead of the overline, for a category in focus. */
		icon?: string | null;
		line?: Snippet;
		children?: Snippet;
	} = $props();
</script>

<section
	class="card-lg grain relative overflow-hidden p-5 pb-4"
	style="background: radial-gradient(120% 90% at 100% -20%, color-mix(in oklab, {tint} 22%, transparent), transparent 62%), var(--surface); transition: background var(--dur-slow) var(--ease-out)"
	aria-label={label}
>
	<p class="section-label flex items-center gap-1.5">
		{#if icon}<span class="text-[13px] tracking-normal normal-case">{icon}</span>{/if}
		<span>{overline}</span>
	</p>
	<Money
		{minor}
		{currency}
		{sign}
		block
		class="mt-2 font-[family-name:var(--font-display)] text-[length:var(--fs-hero)] leading-none font-bold"
	/>
	{#if line}
		<p class="mt-2 text-[14px] leading-snug" style="color: var(--ink-2)">
			{@render line()}
		</p>
	{/if}
	{@render children?.()}
</section>
