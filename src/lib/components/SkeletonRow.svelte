<script lang="ts">
	/**
	 * A placeholder in the exact shape of a ledger row — 40px icon square, two
	 * text lines, optional trailing amount and state chip — so a loading section
	 * fills with the shape of what's coming rather than a spinner and a growing
	 * void. Only ever a handful of rows: a skeleton list as long as the page it
	 * imitates would be theatre, not information.
	 *
	 * Widths are fixed percentages of the row, not measured from the data:
	 * skeletons that matched the incoming content exactly would be a lie told
	 * precisely. Generic mid-length lines read as "rows are coming", which is
	 * all a skeleton owes anyone.
	 *
	 * `index` is the row's position in its section: it feeds the --i custom
	 * property that stages the ink animation, so a loading list typesets
	 * top-down instead of blinking on at once.
	 */
	let {
		lines = 2,
		trailing = true,
		chip = false,
		last = false,
		index = 0
	}: {
		lines?: number;
		trailing?: boolean;
		chip?: boolean;
		last?: boolean;
		index?: number;
	} = $props();
</script>

<div
	class="relative flex items-center gap-3 px-1 py-3 {last ? '' : 'hairline-draw'}"
	aria-hidden="true"
	style="--i: {index}"
>
	<div class="skeleton h-10 w-10 shrink-0 rounded-[12px]" style="--j: 0"></div>
	<div class="flex min-w-0 flex-1 flex-col gap-1.5">
		{#each Array(lines) as _, i (i)}
			<div class="skeleton h-3.5" style="max-width: {i === 0 ? 62 : 38}%; --j: {i + 1}"></div>
		{/each}
	</div>
	{#if trailing}
		{#if chip}
			<!-- Amount over the uppercase state label, as the real row wears. -->
			<div class="flex shrink-0 flex-col items-end gap-1">
				<div class="skeleton h-3.5 w-14" style="--j: 0.6"></div>
				<div class="skeleton h-2.5 w-12 rounded-full" style="--j: 1.6"></div>
			</div>
		{:else}
			<div class="skeleton h-3.5 w-14 shrink-0" style="--j: 0.6"></div>
		{/if}
	{/if}
</div>
