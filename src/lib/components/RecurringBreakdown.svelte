<script lang="ts" module>
	export interface CategoryCostView {
		/** A category id, or NO_CATEGORY for the uncategorized remainder. */
		key: string;
		name: string;
		icon: string | null;
		color: string;
		count: number;
		monthlyMinor: bigint;
		yearlyMinor: bigint;
		/** What rules in this category actually charged in the last 365 days. */
		chargedYearMinor: bigint;
	}

	// Chip states, the same pair the ledger's filter chips use: ink fill for
	// the chosen one (ink is the primary action colour here), hairline on
	// surface for the rest.
	const SELECTED =
		'color: var(--paper); background: var(--ink); box-shadow: none; font-weight: 600';
	const UNSELECTED =
		'color: var(--ink-2); background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--hairline); font-weight: 500';
</script>

<script lang="ts">
	/**
	 * Where the standing money goes.
	 *
	 * Recurring spending was one figure — "$2,480 a month" — and rent is most of
	 * any household's. A streaming service, a cloud plan and three apps nobody
	 * opens disappeared into it, which is exactly the spending people most want
	 * to see and least expect to add up. So the headline is cut by category:
	 * a ribbon whose pieces are the categories, in proportion, and a chip for
	 * each that narrows the whole page to it.
	 *
	 * A ribbon, not a ring or a pie: the parts are read against each other and
	 * against the whole, left to right, which a straight bar does exactly and a
	 * circle only approximately — and the design rules out many-slice pies.
	 *
	 * Selecting a category is a URL change the page owns (`onselect`); this
	 * component only draws. The figures are the plan at today's prices, with
	 * what was actually charged over the last year beside them, because the two
	 * disagree in exactly the cases worth noticing — a price rise, a trial that
	 * became a subscription.
	 */
	import { ArrowRight } from '@lucide/svelte';
	import { prefersReducedMotion } from 'svelte/motion';
	import HeroCard from '$lib/components/HeroCard.svelte';
	import Ribbon from '$lib/components/Ribbon.svelte';
	import { formatMinor } from '$lib/money-format';
	import { ledgerLink, NO_CATEGORY } from '$lib/ledger-filters';

	let {
		costs,
		monthlyMinor,
		yearlyMinor,
		count,
		chargedYearMinor,
		chargedFrom,
		chargedTo,
		currency,
		slug,
		selected,
		onselect
	}: {
		costs: CategoryCostView[];
		monthlyMinor: bigint;
		yearlyMinor: bigint;
		count: number;
		chargedYearMinor: bigint;
		/** The window `chargedYearMinor` covers, inclusive, YYYY-MM-DD. */
		chargedFrom: string;
		chargedTo: string;
		currency: string;
		slug: string;
		/** The selected category key, or '' for everything. */
		selected: string;
		onselect: (key: string) => void;
	} = $props();

	const focus = $derived(costs.find((c) => c.key === selected) ?? null);

	/** Share of the monthly total, as a fraction. 0 when there's nothing. */
	function share(minor: bigint): number {
		return monthlyMinor > 0n ? Number(minor) / Number(monthlyMinor) : 0;
	}
	function pct(f: number): string {
		if (f > 0 && f < 0.01) return '<1%';
		return `${Math.round(f * 100)}%`;
	}

	// The chosen chip is brought into view — it may be the smallest category,
	// last on the rail, and arriving by link or by tapping the ribbon would
	// otherwise leave the one highlighted control off the edge of the screen.
	// Scrolled on the rail itself, not with scrollIntoView, which also moves the
	// page; instant the first time (a smooth scroll during the first paint gets
	// cut short), smooth after that.
	let rail: HTMLElement | undefined = $state();
	let railPlaced = false;
	$effect(() => {
		const key = selected;
		if (!rail) return;
		const chip = rail.querySelector<HTMLElement>(`[data-key="${CSS.escape(key || 'all')}"]`);
		if (!chip) return;
		// Measured from the rects, not offsetLeft: which ancestor a chip's offset is
		// relative to depends on what happens to be positioned, and a mask or a
		// transform on the rail changes that.
		const left =
			chip.getBoundingClientRect().left - rail.getBoundingClientRect().left + rail.scrollLeft;
		const inView =
			left >= rail.scrollLeft && left + chip.offsetWidth <= rail.scrollLeft + rail.clientWidth;
		if (!inView) {
			rail.scrollTo({
				left: Math.max(0, left - 20),
				behavior: railPlaced && !prefersReducedMotion.current ? 'smooth' : 'instant'
			});
		}
		railPlaced = true;
	});

	const charges = (n: number) => `${n} ${n === 1 ? 'charge' : 'charges'}`;

	const headline = $derived(
		focus
			? {
					overline: focus.name,
					monthly: focus.monthlyMinor,
					yearly: focus.yearlyMinor,
					line: `${charges(focus.count)} · ${pct(share(focus.monthlyMinor))} of everything recurring`,
					charged: focus.chargedYearMinor,
					href: ledgerLink(slug, {
						from: chargedFrom,
						to: chargedTo,
						category: focus.key === NO_CATEGORY ? null : focus.key,
						recurring: true
					})
				}
			: {
					overline: 'Recurring',
					monthly: monthlyMinor,
					yearly: yearlyMinor,
					line: `${charges(count)} across ${costs.length} ${costs.length === 1 ? 'category' : 'categories'}`,
					charged: chargedYearMinor,
					href: ledgerLink(slug, { from: chargedFrom, to: chargedTo, recurring: true })
				}
	);

	function pick(key: string) {
		onselect(selected === key ? '' : key);
	}
</script>

<HeroCard
	label="Recurring spending by category"
	overline="{headline.overline} · per month"
	icon={focus?.icon}
	minor={headline.monthly}
	{currency}
	tint={focus?.color ?? 'var(--ws-accent)'}
>
	{#snippet line()}
		<span class="num">{formatMinor(headline.yearly, currency)}</span> a year
		<span style="color: var(--ink-3)">· {headline.line}</span>
	{/snippet}

	{#if costs.length > 0}
		<Ribbon
			class="mt-5"
			parts={costs.map((c) => ({
				key: c.key,
				label: c.name,
				color: c.color,
				minor: c.monthlyMinor
			}))}
			focus={focus?.key ?? null}
			onpick={pick}
		/>

		<!--
			The chips double as the legend. Scrolls sideways rather than wrapping:
			a household can have a dozen categories of standing charges, and five
			rows of chips would push the list itself off the first screen.
		-->
		<div
			bind:this={rail}
			class="chip-rail -mx-5 mt-4 flex gap-2 overflow-x-auto px-5 pb-1"
			role="group"
			aria-label="Show one category"
		>
			<button
				type="button"
				onclick={() => onselect('')}
				data-key="all"
				aria-pressed={!focus}
				class="press rail-chip"
				style={!focus ? SELECTED : UNSELECTED}
			>
				All
			</button>
			{#each costs as c (c.key)}
				{@const on = focus?.key === c.key}
				<button
					type="button"
					onclick={() => pick(c.key)}
					data-key={c.key}
					aria-pressed={on}
					aria-label="{c.name}, {formatMinor(c.monthlyMinor, currency)} a month, {pct(
						share(c.monthlyMinor)
					)}"
					class="press rail-chip"
					style={on ? SELECTED : UNSELECTED}
				>
					<span
						class="h-2 w-2 shrink-0 rounded-full"
						style="background: {c.color}; box-shadow: 0 0 0 1.5px {on
							? 'color-mix(in oklab, var(--paper) 60%, transparent)'
							: 'transparent'}"
					></span>
					{#if c.icon}<span aria-hidden="true">{c.icon}</span>{/if}
					<span>{c.name}</span>
					<span class="num" style="opacity: 0.72">{formatMinor(c.monthlyMinor, currency)}</span>
				</button>
			{/each}
		</div>
	{/if}

	<!--
		The plan against what happened. Only said when something was charged —
		a brand-new rule has no history, and "$0.00 charged" would read as a fault.
	-->
	{#if headline.charged !== 0n}
		<a
			href={headline.href}
			class="press mt-3 flex items-center justify-between gap-3 border-t pt-3 text-[13px]"
			style="border-color: var(--hairline); color: var(--ink-3)"
		>
			<span>
				<span class="num font-semibold" style="color: var(--ink-2)"
					>{formatMinor(headline.charged, currency)}</span
				> actually charged in the last 12 months
			</span>
			<span class="flex shrink-0 items-center gap-1 font-medium" style="color: var(--accent-ink)">
				See charges <ArrowRight class="h-3.5 w-3.5" />
			</span>
		</a>
	{/if}
</HeroCard>

<style>
	.rail-chip {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		gap: 6px;
		border-radius: var(--r-full);
		padding: 0.5rem 0.85rem;
		font-size: 14px;
		line-height: 1.1;
		white-space: nowrap;
		transition:
			background 0.12s ease,
			color 0.12s ease,
			box-shadow 0.12s ease;
	}
	/* A scroller, not a scrollbar: the chips peeking past the edge say there is
	   more, and a bar under a row of pills is chrome the paper doesn't need. */
	.chip-rail {
		scrollbar-width: none;
		scroll-snap-type: x proximity;
		/* The rail bleeds to the card's edges (-mx-5) and pads itself back in
		   (px-5), but a snap point aligns to the scrollport, not the padding:
		   without this, proximity snapping pulled "All" flush against the card's
		   left edge on first paint. Matches px-5 so snapped chips rest where the
		   text above them starts. */
		scroll-padding-inline: 1.25rem;
		/* Faded on the right only, where the rest of the chips wait; a fade on
		   the left would sit over "All" before anything has been scrolled. */
		-webkit-mask-image: linear-gradient(to right, #000 calc(100% - 1.5rem), transparent);
		mask-image: linear-gradient(to right, #000 calc(100% - 1.5rem), transparent);
	}
	.chip-rail::-webkit-scrollbar {
		display: none;
	}
	.rail-chip {
		scroll-snap-align: start;
	}
</style>
