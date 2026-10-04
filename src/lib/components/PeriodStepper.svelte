<script lang="ts" module>
	/** A direction to step in: a link, or a handler for pages that animate it. */
	export type Step = { href: string } | { onclick: () => void } | null;
</script>

<script lang="ts">
	/**
	 * Previous · label · next — the stepper for a period or a month.
	 *
	 * Activity, the map and the statement each drew their own: 36px circles with
	 * an inline chevron on two of them, lucide circles on the third, while the
	 * calendar used the square `.icon-btn`. Per the shape rule on `.icon-btn`, a
	 * round button closes something and a square one does something, and
	 * stepping a month does something. So: squares, everywhere, from here.
	 *
	 * A direction with nowhere to go leaves an equally sized gap rather than a
	 * dead button, so the label never shifts as you reach either end.
	 */
	import { ChevronLeft, ChevronRight } from '@lucide/svelte';

	let {
		label,
		sublabel,
		prev,
		next,
		prevLabel = 'Previous',
		nextLabel = 'Next'
	}: {
		label: string;
		/** A quiet second line under the label, like "In progress". */
		sublabel?: string | null;
		prev: Step;
		next: Step;
		prevLabel?: string;
		nextLabel?: string;
	} = $props();
</script>

{#snippet arrow(step: Step, aria: string, dir: 'prev' | 'next')}
	{#if step === null}
		<span class="h-[38px] w-[38px] shrink-0" aria-hidden="true"></span>
	{:else if 'href' in step}
		<a href={step.href} class="press icon-btn" aria-label={aria}>
			{#if dir === 'prev'}<ChevronLeft class="h-4 w-4" />{:else}<ChevronRight
					class="h-4 w-4"
				/>{/if}
		</a>
	{:else}
		<button type="button" onclick={step.onclick} class="press icon-btn" aria-label={aria}>
			{#if dir === 'prev'}<ChevronLeft class="h-4 w-4" />{:else}<ChevronRight
					class="h-4 w-4"
				/>{/if}
		</button>
	{/if}
{/snippet}

<div class="flex items-center justify-between gap-2">
	{@render arrow(prev, prevLabel, 'prev')}
	<div class="min-w-0 text-center">
		<p class="truncate text-[17px] font-semibold" style="color: var(--ink)">{label}</p>
		{#if sublabel}
			<p class="section-label mt-0.5 text-[10px]">{sublabel}</p>
		{/if}
	</div>
	{@render arrow(next, nextLabel, 'next')}
</div>
