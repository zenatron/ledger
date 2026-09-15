<script lang="ts">
	/**
	 * A month of what's coming, as a grid.
	 *
	 * The whole design rests on one distinction the data carries and most
	 * calendars don't have to: some of these figures are settled and some are
	 * projections. A bucket accrual will be that amount; a variable utility bill
	 * is last month's number wearing next month's date. Drawing them identically
	 * would be quietly lying on exactly the days someone plans around, so an
	 * estimate is drawn with a dotted underline and says so when opened.
	 *
	 * Whole dollars in the grid, exact figures in the day sheet. A cell is read at
	 * a glance and cents are noise at that size; the moment you actually want the
	 * number, you tap, and there it is in full.
	 */
	import { page } from '$app/state';
	import { formatMinor } from '$lib/money-format';
	import { dismiss } from '$lib/actions/dismiss';
	import { modal } from '$lib/actions/modal';
	import { fade, scale } from 'svelte/transition';
	import { ChevronLeft, ChevronRight, X } from '@lucide/svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const slug = $derived(page.params.workspace);
	const currency = $derived(data.currency);

	/** The day whose sheet is open, if any. */
	let openDay = $state<number | null>(null);
	const day = $derived(openDay === null ? null : data.days.find((d) => d.day === openDay));

	const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

	/** Padding cells before the 1st, keyed so the grid doesn't rebuild on nav. */
	const blanks = $derived(Array.from({ length: data.month.leadingBlanks }, (_, i) => i));

	/**
	 * Rounded to the whole unit, half up — add half a unit, then truncate. Integer
	 * division alone floors, so £12.60 was showing as £12: a cell that reads low
	 * every time, which for a glance-first figure is the wrong direction to be
	 * wrong in.
	 *
	 * The one case that needs a word: an amount under half a unit rounds to zero,
	 * and "£0" on a highlighted day reads as "nothing happened". It shows "<1"
	 * instead — still true, and it doesn't claim the day is free.
	 */
	function whole(minor: bigint): string {
		const abs = minor < 0n ? -minor : minor;
		if (abs === 0n) return '0';
		const units = (abs + 50n) / 100n;
		return units === 0n ? '<1' : String(units);
	}

	const symbol = $derived(
		(0).toLocaleString(undefined, { style: 'currency', currency }).replace(/[\d.,\s]/g, '')
	);

	function kindColor(kind: string): string {
		if (kind === 'income') return 'var(--approve)';
		if (kind === 'saving') return 'var(--seal)';
		if (kind === 'decision') return 'var(--pending)';
		return 'var(--ink-2)';
	}
</script>

<svelte:head><title>{data.month.label} · Calendar · Ledger</title></svelte:head>

<div class="mx-auto max-w-lg">
	<a
		href="/w/{slug}/recurring"
		class="press mb-4 -ml-1 inline-flex items-center gap-0.5 text-[14px] font-medium"
		style="color: var(--ink-3)"
	>
		<ChevronLeft class="h-4 w-4" /> Plan
	</a>

	<!-- Masthead: the month as the headline, what it costs as the standfirst. -->
	<div class="flex items-end justify-between gap-3 px-1">
		<div class="min-w-0">
			<p class="section-label">What's coming</p>
			<h1 class="mt-1 truncate text-[28px]">{data.month.label}</h1>
		</div>
		<div class="flex shrink-0 items-center gap-1">
			<a href="?m={data.month.prev}" class="press icon-btn" aria-label="Previous month"
				><ChevronLeft class="h-4 w-4" /></a
			>
			<a href="?m={data.month.next}" class="press icon-btn" aria-label="Next month"
				><ChevronRight class="h-4 w-4" /></a
			>
		</div>
	</div>

	<!--
		In and out, never netted. A single figure would hide the shape of the month:
		£4,000 in and £3,900 out is a very different month from £100 in and nothing
		out, and they net to the same number.
	-->
	<div class="card mt-4 flex items-stretch p-4">
		<div class="flex-1">
			<p class="section-label">Coming in</p>
			<p class="num mt-0.5 text-[20px] font-semibold" style="color: var(--approve)">
				{formatMinor(data.month.inMinor, currency)}
			</p>
		</div>
		<div class="w-px" style="background: var(--hairline)"></div>
		<div class="flex-1 pl-4">
			<p class="section-label">Going out</p>
			<p class="num mt-0.5 text-[20px] font-semibold" style="color: var(--ink)">
				{formatMinor(data.month.outMinor, currency)}
			</p>
		</div>
	</div>

	<div class="mt-5 grid grid-cols-7 gap-1 px-0.5">
		{#each WEEKDAYS as w, i (i)}
			<div class="pb-1 text-center text-[11px] font-semibold" style="color: var(--ink-3)">{w}</div>
		{/each}

		<!-- Blank cells so the 1st lands on its real weekday. -->
		{#each blanks as b (b)}
			<div></div>
		{/each}

		{#each data.days as d (d.day)}
			{@const busy = d.entries.length > 0}
			{@const isToday = data.todayDay === d.day}
			<!--
				A day is a button only when there's something to open. An empty day
				that depresses under the thumb and shows nothing is a small lie about
				where the information is.
			-->
			<svelte:element
				this={busy ? 'button' : 'div'}
				role={busy ? 'button' : undefined}
				tabindex={busy ? 0 : undefined}
				onclick={busy ? () => (openDay = d.day) : undefined}
				class="flex aspect-square flex-col items-center justify-start rounded-[10px] pt-1.5 {busy
					? 'press'
					: ''}"
				style="background: {busy ? 'var(--surface-2)' : 'transparent'}; box-shadow: {isToday
					? 'inset 0 0 0 1.5px var(--ws-accent)'
					: 'none'}"
			>
				<span
					class="num text-[12px] {isToday ? 'font-bold' : ''}"
					style="color: {isToday ? 'var(--ws-accent)' : busy ? 'var(--ink-2)' : 'var(--ink-3)'}"
					>{d.day}</span
				>
				{#if d.outMinor > 0n}
					<span class="num mt-0.5 text-[11px] leading-none font-semibold" style="color: var(--ink)">
						{symbol}{whole(d.outMinor)}
					</span>
				{/if}
				{#if d.inMinor > 0n}
					<span
						class="num mt-0.5 text-[11px] leading-none font-semibold"
						style="color: var(--approve)"
					>
						+{symbol}{whole(d.inMinor)}
					</span>
				{/if}
				{#if d.outMinor === 0n && d.inMinor === 0n && busy}
					<!-- Something to decide, but no money moving. A dot, not a figure. -->
					<span
						class="mt-1 h-1 w-1 rounded-full"
						style="background: var(--pending)"
						aria-hidden="true"
					></span>
				{/if}
			</svelte:element>
		{/each}
	</div>

	{#if data.month.inMinor === 0n && data.month.outMinor === 0n && data.days.every((d) => d.entries.length === 0)}
		<p class="mt-6 px-1 text-[14px] leading-relaxed" style="color: var(--ink-3)">
			Nothing scheduled this month. Recurring purchases and bucket accruals show up here once
			they're set up under <a
				href="/w/{slug}/recurring"
				class="font-medium"
				style="color: var(--accent)">Plan</a
			>.
		</p>
	{/if}
</div>

{#if day}
	{@const d = day}
	<div
		class="fixed inset-0 z-50"
		style="background: var(--scrim)"
		use:dismiss={() => (openDay = null)}
		transition:fade={{ duration: 140 }}
	></div>
	<!-- Raised clear of the tab bar, which is fixed over every screen. -->
	<div
		class="fixed inset-x-4 z-50 mx-auto max-w-md"
		style="bottom: calc(env(safe-area-inset-bottom, 0px) + 84px)"
		role="dialog"
		aria-modal="true"
		aria-label="What's on this day"
		tabindex="-1"
		use:modal
		transition:scale={{ start: 0.96, duration: 170 }}
	>
		<!--
			`card-lg` is a border-radius and nothing else — every other sheet in the
			app pairs it with an explicit surface. Without one the scrim showed
			straight through, which read as a translucent panel nothing else here has.
		-->
		<div
			class="card-lg overflow-hidden"
			style="box-shadow: var(--shadow-float); background: var(--surface)"
		>
			<div class="flex items-center justify-between px-5 pt-4 pb-2">
				<h2 class="font-[family-name:var(--font-display)] text-[20px]" style="color: var(--ink)">
					{data.month.label.split(' ')[0]}
					{d.day}
				</h2>
				<button
					onclick={() => (openDay = null)}
					class="press -mr-1 grid h-8 w-8 place-items-center rounded-full"
					style="color: var(--ink-3)"
					aria-label="Close"><X class="h-4 w-4" /></button
				>
			</div>
			<div class="px-5 pb-4">
				{#each d.entries as e (e.sourceId + e.label)}
					<div class="hairline flex items-baseline gap-3 py-2.5 first:pt-0">
						<span class="min-w-0 flex-1">
							<span class="block truncate text-[15px]" style="color: var(--ink)">{e.label}</span>
							<span class="mt-0.5 block text-[12px]" style="color: {kindColor(e.kind)}">
								{e.kind === 'income'
									? 'Expected in'
									: e.kind === 'saving'
										? 'Set aside'
										: e.kind === 'decision'
											? 'Comes back to decide'
											: 'Bill'}{e.estimate ? ' · estimated' : ''}
							</span>
						</span>
						{#if e.direction !== 'none'}
							<span
								class="num shrink-0 text-[15px] font-semibold"
								style="color: {e.direction === 'in' ? 'var(--approve)' : 'var(--ink)'}; {e.estimate
									? 'text-decoration: underline dotted; text-underline-offset: 3px;'
									: ''}"
							>
								{e.direction === 'in' ? '+' : ''}{formatMinor(e.amountMinor, currency)}
							</span>
						{:else}
							<span class="num shrink-0 text-[15px]" style="color: var(--ink-3)">
								{formatMinor(e.amountMinor, currency)}
							</span>
						{/if}
					</div>
				{/each}
				{#if d.entries.some((e) => e.estimate)}
					<!--
						Said once, at the bottom, rather than on every row. The dotted
						figures already carry it; this explains what the dots mean to
						someone seeing them for the first time.
					-->
					<p class="mt-3 text-[12px] leading-relaxed" style="color: var(--ink-3)">
						Dotted figures are estimates. Those bills ask you to confirm the real price, so this is
						what they cost last time.
					</p>
				{/if}
			</div>
		</div>
	</div>
{/if}
