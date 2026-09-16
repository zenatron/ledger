<script lang="ts">
	import { submit } from '$lib/actions/submit';
	import { tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { money } from '$lib/actions/money';
	import { formatMinor, splitCurrencyMinor, tooWideForSymbol } from '$lib/money-format';
	import { formatPct } from '$lib/format';
	import Money from '$lib/components/Money.svelte';
	import CategoryRing from '$lib/components/CategoryRing.svelte';
	import Segmented from '$lib/components/Segmented.svelte';
	import { settleUp } from '$lib/domain/household/settlement';
	import { ChevronRight, Map as MapIcon, MapPin, X, Sparkles } from '@lucide/svelte';
	import { page } from '$app/state';
	import { ledgerLink } from '$lib/ledger-filters';
	let { data } = $props();
	const slug = $derived(page.params.workspace!);
	let showBudgetForm = $state(false);
	// The form's cadence, defaulting to the view it was opened from — the week
	// view probably means a weekly cap, the month view a monthly one.
	// Writable derived: follows the period until the form's own control moves it.
	let budgetCadence = $derived<'month' | 'week'>(data.period === 'week' ? 'week' : 'month');
	const currency = $derived(data.workspace.currency);
	const period = $derived(data.period);
	const isMonth = $derived(period === 'month');

	// `?period=X` alone: it drops month/day/wo so switching lands on the current
	// window rather than a stale one.
	const PERIOD_TABS = [
		{ value: 'day', label: 'Day', href: '?period=day' },
		{ value: 'week', label: 'Week', href: '?period=week' },
		{ value: 'month', label: 'Month', href: '?period=month' },
		{ value: 'year', label: 'Year', href: '?period=year' }
	];

	/**
	 * The map opens on whatever window this page is showing, so the two screens
	 * are the same view of the same data rather than two features that happen to
	 * both draw money. Only the period parameters carry across — z and c belong
	 * to the map and are meaningless here.
	 */
	const mapSearch = $derived.by(() => {
		// A throwaway builder, read once into a string; nothing renders from the
		// instance, so it has no reason to be reactive.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const q = new URLSearchParams();
		for (const k of ['period', 'month', 'year', 'day', 'wo']) {
			const v = page.url.searchParams.get(k);
			if (v) q.set(k, v);
		}
		return q.size > 0 ? `?${q}` : '';
	});

	let touchStartX = $state(0);
	let touchStartY = $state(0);
	let swiping = $state(false);
	let swipeOffset = $state(0);
	/** True from release until the view transition ends; suppresses the springback. */
	let committing = $state(false);

	function onTouchStart(e: TouchEvent) {
		if (e.touches.length !== 1) return;
		touchStartX = e.touches[0].clientX;
		touchStartY = e.touches[0].clientY;
		swiping = true;
	}

	/** Past this, the drag is a commit; the card never travels further. */
	const SWIPE_LIMIT = 96;

	// Rubber-band: full tracking up to the limit, then resistance. Dragging
	// toward a period that doesn't exist resists from the start, so the end of
	// the range is something you feel rather than discover on release.
	function damp(dx: number, hasTarget: boolean): number {
		const sign = Math.sign(dx);
		const mag = Math.abs(dx);
		if (!hasTarget) return sign * Math.min(mag * 0.25, 28);
		if (mag <= SWIPE_LIMIT) return dx;
		return sign * (SWIPE_LIMIT + (mag - SWIPE_LIMIT) * 0.3);
	}

	function onTouchMove(e: TouchEvent) {
		if (!swiping) return;
		const dx = e.touches[0].clientX - touchStartX;
		const dy = e.touches[0].clientY - touchStartY;
		if (Math.abs(dy) > Math.abs(dx)) {
			swiping = false;
			swipeOffset = 0;
			return;
		}
		swipeOffset = damp(dx, dx > 0 ? data.hasPrev : data.hasNext);
	}

	function onTouchEnd(e: TouchEvent) {
		if (!swiping) {
			swipeOffset = 0;
			return;
		}
		swiping = false;
		const dx = e.changedTouches[0].clientX - touchStartX;
		const commit = Math.abs(dx) >= 60;
		// On a commit the card must not spring back first: the eased return to
		// centre and the view transition's slide are two separate motions, which
		// on device reads as the card settling twice. Drop the offset with no
		// transition so the slide is the only movement you see. A cancelled swipe
		// still eases back, because there the springback IS the feedback.
		if (!commit) {
			// Didn't travel far enough: ease back to centre. Here the springback is
			// the feedback, so it keeps its transition.
			swipeOffset = 0;
			return;
		}
		// Committed: leave the card where the finger left it. navigate() resets the
		// offset inside the view transition's callback, so the outgoing snapshot is
		// captured mid-gesture and slides on from there. Resetting first made the
		// card jump ~100px back to centre and then slide forward again — two
		// direction changes, which is the double settle you feel.
		committing = true;
		void navigate(dx > 0 ? 'prev' : 'next');
	}

	/**
	 * SvelteKit routes client-side, where the CSS-only `@view-transition` rule
	 * never applies — it covers cross-document navigation only. So the transition
	 * is started explicitly here, and only here: this is the one navigation that
	 * wants a directional slide, and a global hook would silently switch it on for
	 * every route in the app.
	 */
	async function navigate(dir: 'prev' | 'next') {
		const href = navHref(dir);
		if (!href) {
			committing = false;
			return;
		}

		const root = document.documentElement;
		const start = (
			document as Document & {
				startViewTransition?: (cb: () => Promise<void>) => { finished: Promise<void> };
			}
		).startViewTransition?.bind(document);

		// Runs inside the transition, after the outgoing snapshot is taken: the
		// card returns to centre here so the reset is never visible.
		//
		// noScroll: stepping through periods keeps your place on the page. Without
		// it, SvelteKit's default scroll-to-top fired on every swipe, so comparing
		// the category breakdown across months meant scrolling back down each time.
		const step = async () => {
			swipeOffset = 0;
			await tick();
			await goto(href, { noScroll: true });
		};

		if (!start || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
			await step();
			committing = false;
			return;
		}

		root.setAttribute('data-vt-slide', dir === 'next' ? 'right' : 'left');
		try {
			await start(step).finished;
		} finally {
			root.removeAttribute('data-vt-slide');
			committing = false;
		}
	}

	const maxCategory = $derived(
		data.categories.reduce(
			(max: bigint, c: { totalMinor: bigint }) => (c.totalMinor > max ? c.totalMinor : max),
			1n
		)
	);
	const catSegments = $derived(
		[...data.categories]
			.sort((a: { totalMinor: bigint }, b: { totalMinor: bigint }) =>
				Number(b.totalMinor - a.totalMinor)
			)
			.map((c: { color: string | null; totalMinor: bigint }) => ({
				value: c.totalMinor,
				color: c.color ?? '#8E8E93'
			}))
	);
	const maxBar = $derived(
		data.buckets.reduce(
			(max: bigint, b: { totalMinor: bigint }) => (b.totalMinor > max ? b.totalMinor : max),
			1n
		)
	);
	const overall = $derived(
		data.budgets.find((b: { categoryId: string | null }) => b.categoryId === null) as
			{ budgetMinor: bigint; actualMinor: bigint } | undefined
	);
	const overallPct = $derived(
		overall && overall.budgetMinor > 0n
			? Number((overall.actualMinor * 1000n) / overall.budgetMinor) / 1000
			: null
	);
	const overBudget = $derived(overallPct !== null && overallPct > 1);

	/*
	 * Net position, as three movements rather than two.
	 *
	 * `savings` is money that went *into* buckets, so it never goes negative.
	 * `released` is money that came back out of a bucket that actually held it:
	 * that spending is already inside `totalMinor`, and it was paid for in the
	 * month it was set aside, so it's credited back here. What a bucket couldn't
	 * cover is deliberately absent from `released` and so stays counted as
	 * spending — see domain/bucket/flows.
	 */
	const savings = $derived(data.savingsMinor ?? 0n);

	/*
	 * Settlement — see the "Settle up" section below. The basis toggle is a
	 * display choice over data already on the page, so the pure domain function
	 * runs here rather than costing a server round trip per switch.
	 */
	let shareBasis = $state<'equal' | 'income'>('equal');
	const settleUpMembers = $derived(data.settlementMembers ?? []);
	const settlement = $derived(settleUp(settleUpMembers, shareBasis));
	/** What the buckets hold right now — a balance, not this period's flow. */
	const onHand = $derived(data.onHandMinor ?? 0n);
	const released = $derived(data.releasedMinor ?? 0n);
	const overdraft = $derived(data.overdraftMinor ?? 0n);
	const net = $derived(data.incomeMinor - data.totalMinor - savings + released);
	/** The Net card's tone: a negative month, or one that has overrun its budget. */
	const netBad = $derived(net < 0n || overBudget);
	const prevNet = $derived(
		data.prevIncomeMinor ? data.prevIncomeMinor - data.prevTotalMinor - savings + released : 0n
	);
	const netChange = $derived(
		data.incomeMinor > 0n
			? Number(((net - prevNet) * 1000n) / data.incomeMinor) / 10
			: net !== prevNet
				? net > prevNet
					? Infinity
					: -Infinity
				: 0
	);
	const sp = $derived(data.incomeMinor > 0n ? Number((net * 1000n) / data.incomeMinor) / 10 : 0);

	/**
	 * The one-line reading of the net figure. It used to sit under the whole grid,
	 * which left the Net card as a lone number beside a list of four rows and read
	 * as unfinished. It belongs against the figure it describes.
	 */
	const netSummary = $derived.by(() => {
		if (data.incomeMinor === 0n) return `No income recorded this ${period}`;
		if (onHand > 0n) {
			/*
			 * The rate is dropped whenever the card's heading is already a verdict.
			 *
			 * It is measured against income, not against the budget, so a month that
			 * earned well and overspent its budget read "Over budget · 69% free" —
			 * two true statements that flatly contradict each other at a glance. The
			 * heading is the finding; this line is just what is in the buckets.
			 */
			return sp >= 0 && !overBudget
				? `${formatMinor(onHand, currency)} in buckets · ${formatPct(sp)} free`
				: `${formatMinor(onHand, currency)} in buckets`;
		}
		if (sp >= 0) return `Saving ${formatPct(sp)} of what came in`;
		return `Spending more than income this ${period}`;
	});

	const comparison = $derived.by(() => {
		if (data.prevTotalMinor === 0n)
			return data.totalMinor > 0n ? `First ${period} of tracking` : null;
		const pct = Number((data.totalMinor * 1000n) / data.prevTotalMinor) / 10;
		const dir = pct > 100 ? 'up' : pct < 100 ? 'down' : 'flat';
		const diff = Math.abs(pct - 100);
		if (dir === 'flat') return `Same as ${data.prevLabel}`;
		return {
			dir,
			text: `${formatPct(diff)} ${dir === 'up' ? 'more' : 'less'} than ${data.prevLabel}`
		};
	});

	const barWidth = $derived(period === 'year' ? 16 : period === 'week' ? 34 : 6);
	const barGap = $derived(period === 'year' ? 4 : period === 'week' ? 6 : 2);
	const svgW = $derived(data.buckets.length * (barWidth + barGap));

	/*
	 * Colour follows the language the rest of the app already speaks: these are
	 * the same tones the purchase state chips use, so the row doubles as a legend
	 * for what you see on a purchase.
	 *
	 *   green  approved     blue  refunded
	 *   red    denied       grey  cancelled
	 *   purple set aside (matches "Saved" in net position above)
	 *
	 * Earned is deliberately the neutral espresso. Green was doing double duty —
	 * "approved" on every chip and "In" in net position — and putting both in one
	 * row made that read as a mistake. The coloured cards all mean something
	 * happened to a request; income is the ground they sit against, not a verdict.
	 */
	const lifetimeStats = $derived([
		{ label: 'Earned', minor: data.earnedMinor, tone: 'var(--ink)', hint: 'Income recorded' },
		{
			label: 'Approved',
			minor: data.verdicts.approvedMinor,
			tone: 'var(--approve)',
			hint: 'Total spent'
		},
		{ label: 'Saved', minor: data.savedMinor, tone: 'var(--seal)', hint: 'Set aside' }
	]);

	/*
	 * The four verdicts, paired: money that came back, then money that never
	 * left. Each pair shares a card and a rule, which is what marks them as a
	 * pair — set side by side they'd just read as more tiles.
	 *
	 * They stack rather than sit two-across because the figure is what breaks
	 * first here. A third of the row already only just holds six figures at
	 * 16px tabular; a quarter of it would break at four. Stacked, each figure
	 * gets half the row — more room than the money tiles above have.
	 */
	const lifetimePairs = $derived([
		[
			{
				label: 'Refunded',
				minor: data.verdicts.refundedMinor,
				tone: 'var(--info)',
				hint: 'Came back'
			},
			{
				label: 'Cancelled',
				minor: data.verdicts.cancelledMinor,
				tone: 'var(--ink-3)',
				hint: 'Voided'
			}
		],
		[
			{
				label: 'Denied',
				minor: data.verdicts.deniedMinor,
				tone: 'var(--deny)',
				hint: 'Turned down'
			},
			{
				label: 'Let go',
				minor: data.verdicts.letGoMinor,
				tone: 'var(--seal)',
				hint: 'Slept on, then passed'
			}
		]
	]);

	/*
	 * Past ten million a lifetime figure overruns its card. These are ledger
	 * totals, so rounding or abbreviating them is out — instead the currency
	 * symbol moves up into the label ("EARNED $"), where there's slack, and out
	 * of the number, where there isn't. A hundred million would overrun again,
	 * but that's a workspace with other problems.
	 */
	function figure(minor: bigint): { symbol: string; digits: string } {
		return tooWideForSymbol(minor, currency)
			? splitCurrencyMinor(minor, currency)
			: { symbol: '', digits: formatMinor(minor, currency) };
	}

	function pctOf(part: bigint, whole: bigint): number {
		if (whole === 0n) return 0;
		return Math.min(100, Number((part * 1000n) / whole) / 10);
	}

	function navHref(dir: 'prev' | 'next'): string | null {
		if (dir === 'prev' && !data.hasPrev) return null;
		if (dir === 'next' && !data.hasNext) return null;
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const params = new URLSearchParams();
		params.set('period', period);
		if (period === 'day') params.set('day', dir === 'prev' ? data.prevDay : data.nextDay);
		else if (period === 'week')
			params.set('wo', String(dir === 'prev' ? data.prevWeekOffset : data.nextWeekOffset));
		else if (period === 'year') params.set('year', dir === 'prev' ? data.prevYear : data.nextYear);
		else if (period === 'month')
			params.set('month', dir === 'prev' ? data.prevMonth : data.nextMonth);
		return '?' + params.toString();
	}
</script>

<div
	class="space-y-7"
	role="region"
	aria-label="Activity period"
	ontouchstart={onTouchStart}
	ontouchmove={onTouchMove}
	ontouchend={onTouchEnd}
	style="touch-action: pan-y"
>
	<div class="flex items-center justify-between px-1 pt-1">
		<h1 class="text-[28px]">Activity</h1>
		<!--
			A 38px square, per the shape rule on .icon-btn: a round button closes
			something, a square one does something. Only shown once this workspace
			has pinned anything, so an unused feature never advertises itself.

			A plain link, deliberately without startViewTransition: that slide is the
			period-stepping gesture's follow-through, and reusing it here would make
			opening the map read as changing the month.
		-->
		{#if data.hasPlaces}
			<!--
				Absolute, not relative. `href="map"` resolves against
				/w/{slug}/analytics — which has no trailing slash — so it lands on
				/w/{slug}/map and 404s. Every other link in the app is absolute or
				query-only; this was the one exception, and it was wrong.
			-->
			{#if !__DEMO__}
				<a
					href="/w/{slug}/analytics/map{mapSearch}"
					class="icon-btn press"
					aria-label="Spending map"
				>
					<MapIcon class="h-[18px] w-[18px]" />
				</a>
			{/if}
		{/if}
	</div>

	<div class="flex justify-center">
		<Segmented options={PERIOD_TABS} value={period} size="sm" fill={false} ariaLabel="Period" />
	</div>

	<!--
		Docks under the workspace header once you scroll past it. The period being
		viewed is the page's whole context, and the swipe works anywhere on the
		page — so scrolling down to the category breakdown used to leave you
		swiping months with no idea which one you'd landed on.
	-->
	<div
		class="material sticky z-10 -mx-4 flex items-center justify-between gap-1 px-3 py-2"
		style="top: var(--header-h, 0px); background: color-mix(in oklab, var(--paper) 94%, transparent); box-shadow: 0 0.5px 0 var(--hairline)"
	>
		{#if data.hasPrev}
			<button
				onclick={() => void navigate('prev')}
				class="press flex h-9 w-9 items-center justify-center rounded-full"
				style="color: var(--ink-3)"
				aria-label="Previous"
			>
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2.4"
					stroke-linecap="round"
					stroke-linejoin="round"><path d="M15 18l-6-6 6-6" /></svg
				>
			</button>
		{:else}
			<div class="h-9 w-9"></div>
		{/if}
		<span class="text-[17px] font-semibold" style="color: var(--ink)">{data.label}</span>
		{#if data.hasNext}
			<button
				onclick={() => void navigate('next')}
				class="press flex h-9 w-9 items-center justify-center rounded-full"
				style="color: var(--ink-3)"
				aria-label="Next"
			>
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2.4"
					stroke-linecap="round"
					stroke-linejoin="round"><path d="M9 18l6-6-6-6" /></svg
				>
			</button>
		{:else}
			<div class="h-9 w-9"></div>
		{/if}
	</div>

	<!--
		The period card is the only thing that tracks the swipe. Dragging the whole
		page moved the heading, the period tabs and the arrows too, which made a
		gesture that changes one number look like the entire screen was leaving.
		`view-transition-name` scopes the follow-through slide to this card as well,
		so the drag and the transition are the same motion.
	-->
	<div
		class="card-lg grain relative overflow-hidden p-6"
		style="background: radial-gradient(120% 80% at 85% -10%, color-mix(in oklab, var(--ws-accent) 24%, transparent), transparent 60%), var(--surface); view-transition-name: vt-period-card; transform: translateX({swipeOffset}px); transition: transform {swiping ||
		committing
			? '0s'
			: 'var(--dur) var(--ease-out)'}; will-change: {swiping ? 'transform' : 'auto'}"
	>
		<p class="section-label text-center">{data.label}</p>
		<div class="mt-4 flex justify-center">
			<CategoryRing
				segments={catSegments}
				cap={overall ? overall.budgetMinor : 0n}
				size={200}
				stroke={14}
			>
				<div class="px-2" style="color: {overBudget ? 'var(--deny)' : 'inherit'}">
					<Money
						minor={data.totalMinor}
						{currency}
						block
						class="font-[family-name:var(--font-display)] text-[24px] leading-none font-bold"
					/>
					{#if overallPct !== null}
						<p class="num mt-1 text-[11px]" style="color: var(--ink-3)">
							of {formatMinor(overall!.budgetMinor, currency)}
						</p>
					{/if}
				</div>
			</CategoryRing>
		</div>
		{#if overallPct !== null}
			<p
				class="mt-5 text-center text-[13px] font-medium"
				style="color: {overBudget ? 'var(--deny)' : 'var(--ink-3)'}"
			>
				{overBudget
					? `${formatPct((overallPct - 1) * 100)} over budget`
					: `${formatPct(overallPct * 100)} of budget used`}
			</p>
		{:else if comparison}
			<p
				class="mt-5 text-center text-[13px] font-medium"
				style="color: {typeof comparison === 'object' && comparison.dir === 'up'
					? 'var(--deny)'
					: typeof comparison === 'object' && comparison.dir === 'down'
						? 'var(--approve)'
						: 'var(--ink-3)'}"
			>
				{typeof comparison === 'string' ? comparison : comparison.text}
			</p>
		{/if}

		{#if isMonth}
			<div class="mt-4 flex justify-center">
				<a
					href="/w/{slug}/statement?month={data.monthParam}"
					class="inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-medium"
					style="color: var(--ink-2); box-shadow: inset 0 0 0 1px var(--hairline)"
				>
					<Sparkles size={13} style="color: var(--accent)" />
					Read the {data.label} statement
				</a>
			</div>
		{/if}

		{#if period !== 'day'}
			<svg viewBox="0 0 {svgW} 44" class="mt-6 h-11 w-full">
				{#each data.buckets as b, i (b.key)}
					{@const totalH = Math.max(
						Number((b.totalMinor * 38n) / maxBar),
						b.totalMinor > 0n ? 3 : 0
					)}
					{@const x = i * (barWidth + barGap) + 1}
					{@const y = 41 - totalH}
					<!-- Stacked category segments -->
					{#if b.segments && b.segments.length > 0}
						{@const segTotal = b.segments.reduce(
							(s: bigint, seg: { value: bigint }) => s + seg.value,
							0n
						)}
						{@const stacked = b.segments.reduce(
							(
								arr: { color: string; y: number; h: number }[],
								seg: { value: bigint; color: string }
							) => {
								const segH = (Number(seg.value) * totalH) / Math.max(1, Number(segTotal));
								const segY = arr.length === 0 ? y : arr[arr.length - 1].y + arr[arr.length - 1].h;
								arr.push({ color: seg.color, y: segY, h: Math.max(1, segH) });
								return arr;
							},
							[]
						)}
						{#each stacked as seg (seg.color)}
							{#if b.href}
								<a
									href={b.href}
									class="block"
									style="opacity: {b.today ? '1' : '0.7'}"
									aria-label="{b.label}: {formatMinor(b.totalMinor, currency)} in {b.segments
										.length} categories"
								>
									<rect {x} y={seg.y} width={barWidth} height={seg.h} fill={seg.color} />
								</a>
							{:else}
								<rect
									{x}
									y={seg.y}
									width={barWidth}
									height={seg.h}
									fill={seg.color}
									opacity={b.today ? '1' : '0.7'}
								/>
							{/if}
						{/each}
						<!-- Rounded top -->
						<rect
							{x}
							{y}
							width={barWidth}
							height={totalH}
							rx={barWidth / 2}
							fill="none"
							stroke="transparent"
						/>
					{:else if b.href}
						<a
							href={b.href}
							class="block"
							style="opacity: {b.today ? '1' : '0.7'}"
							aria-label="{b.label}: {formatMinor(b.totalMinor, currency)}"
						>
							<rect
								{x}
								{y}
								width={barWidth}
								height={totalH}
								rx={barWidth / 2}
								fill={b.today ? 'var(--ws-accent)' : 'var(--surface-hi)'}
							/>
						</a>
					{:else}
						<rect
							{x}
							{y}
							width={barWidth}
							height={totalH}
							rx={barWidth / 2}
							fill={b.today ? 'var(--ws-accent)' : 'var(--surface-hi)'}
							opacity={b.today ? '1' : '0.7'}
						/>
					{/if}
				{/each}
			</svg>

			<!-- Bar labels -->
			{#if period === 'year'}
				<div class="relative mt-1" style="height: 16px">
					{#each data.buckets as b, i (b.key)}
						<a
							href={b.href}
							class="absolute top-0 block text-center text-[10px] font-medium hover:opacity-70"
							style="left: {i * (barWidth + barGap) + 1}px; width: {barWidth - 2}px; color: {b.today
								? 'var(--ink)'
								: 'var(--ink-3)'}">{b.label}</a
						>
					{/each}
				</div>
			{:else if period === 'month'}
				<div class="mt-1.5 flex justify-between" style="padding-left: 1px; padding-right: 0">
					{#each data.buckets as b (b.key)}
						{#if b.weekLabel}
							<span class="text-[9px] font-medium" style="color: var(--ink-3)">{b.weekLabel}</span>
						{/if}
					{/each}
				</div>
			{:else if period === 'week'}
				<div class="mt-1 flex" style="gap: {barGap}px; padding-left: 1px">
					{#each data.buckets as b (b.key)}
						<span
							class="block text-center text-[9px] font-medium"
							style="width: {barWidth}px; color: {b.today ? 'var(--ink)' : 'var(--ink-3)'}"
							>{b.label}</span
						>
					{/each}
				</div>
			{/if}
		{/if}
	</div>

	<div>
		<p class="section-label mb-3 px-1">Net position</p>
		<div class="grid grid-cols-2 gap-2.5">
			<!--
				Every row is its signed contribution to the Net figure beside it, so the
				column adds up to that figure by eye. Out and Saved are negated for the
				same reason: both take money away from net, and showing "Saved +$500"
				next to "From buckets +$70" put one plus on a term that is subtracted and
				another on a term that is added. This is the framing the monthly
				statement already uses (see statement/+page.svelte) — the two screens
				render the same four figures and disagreed about what a sign meant.
			-->
			<div class="card overflow-hidden py-1">
				<div class="flex items-center justify-between px-3.5 py-1.5">
					<span class="text-[13px] font-medium" style="color: var(--approve)">In</span>
					<Money minor={data.incomeMinor} {currency} sign class="text-[16px] font-semibold" />
				</div>
				<div class="flex items-center justify-between px-3.5 py-1.5">
					<span class="text-[13px] font-medium" style="color: var(--ink-3)">Out</span>
					<Money minor={-data.totalMinor} {currency} sign class="text-[16px] font-semibold" />
				</div>
				<!--
					The rule under "From buckets" is what separates cash flow from bucket
					flow: this row sits on the cash side of it, directly under the Out it
					adjusts — it is the part of Out that earlier months already paid for,
					not a saving made this one.

					It renders even at zero, the way In and Saved do. Dropping it in months
					with no bucket charges left this card a row shorter than the Net card
					beside it, and the leftover height pooled under Saved: the breakdown
					changed shape month to month over a figure that was simply nothing.
				-->
				<div class="hairline flex items-center justify-between px-3.5 py-1.5">
					<span class="text-[13px] font-medium" style="color: var(--ink-3)">From buckets</span>
					<Money minor={released} {currency} sign class="text-[16px] font-semibold" />
				</div>
				<div class="flex items-center justify-between px-3.5 py-1.5">
					<span class="text-[13px] font-medium" style="color: var(--seal)">Saved</span>
					<Money minor={-savings} {currency} sign class="text-[16px] font-semibold" />
				</div>
			</div>
			<!--
				The heading carries the verdict. "Net" over a figure that is fine and
				"Net" over a month that has overrun its budget are the same word doing
				two different jobs, and the one that matters was left to a clause
				further down. Over budget is a red card with its name on it.
			-->
			<div
				class="card flex flex-col items-center justify-center p-4"
				style="background: {netBad
					? 'color-mix(in oklab, var(--deny) 8%, var(--surface))'
					: 'color-mix(in oklab, var(--approve) 8%, var(--surface))'}"
			>
				<p
					class="text-[11px] font-semibold tracking-[0.08em] uppercase"
					style="color: {netBad ? 'var(--deny)' : 'var(--approve)'}"
				>
					{overBudget ? 'Over budget' : 'Net'}
				</p>
				<span style="color: {netBad ? 'var(--deny)' : 'var(--approve)'}">
					<Money minor={net} {currency} sign block class="mt-0.5 text-[18px] font-semibold" />
				</span>
				{#if prevNet !== 0n && net !== prevNet}
					<span
						class="mt-1 inline-flex items-center gap-0.5 text-[11px] font-semibold"
						style="color: {netChange >= 0 ? 'var(--approve)' : 'var(--deny)'}"
					>
						<svg
							width="12"
							height="10"
							viewBox="0 0 12 10"
							fill="none"
							stroke="currentColor"
							stroke-width="1.6"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							{#if netChange >= 0}
								<path d="M2 8 C3 6, 5 2, 7 5 C8 7, 10 3, 10 2 M10 2 L8 3 M10 2 L10.5 4" />
							{:else}
								<path d="M2 2 C3 4, 5 8, 7 5 C8 3, 10 7, 10 8 M10 8 L8 7 M10 8 L10.5 6" />
							{/if}
						</svg>
						{#if Number.isFinite(netChange)}
							{formatPct(Math.abs(netChange))} vs {data.prevLabel}
						{:else}
							{netChange > 0 ? 'up' : 'down'} vs {data.prevLabel}
						{/if}
					</span>
				{/if}
				<!-- Bled to the card edges so the rule matches the breakdown's own
				     dividers rather than floating inset. -->
				<div
					class="-mx-4 mt-3 w-[calc(100%+2rem)] px-4 pt-3"
					style="border-top: 1px solid var(--hairline)"
				>
					<p class="text-center text-[12px] leading-snug" style="color: var(--ink-3)">
						{netSummary}
					</p>
				</div>
			</div>
		</div>
		<!-- Charged to a bucket that didn't have it. Counted as spending above,
		     because nothing had been set aside to cover it. -->
		{#if overdraft > 0n}
			<p class="mt-2.5 px-1 text-[13px]" style="color: var(--pending)">
				{formatMinor(overdraft, currency)} charged to buckets past their balance
			</p>
		{/if}
	</div>

	{#if (isMonth || period === 'week') && (data.budgets.length > 0 || data.isOwner)}
		<div>
			<div class="mb-3 flex items-center justify-between px-1">
				<p class="section-label">Budgets</p>
				{#if data.isOwner}
					<button
						onclick={() => (showBudgetForm = !showBudgetForm)}
						class="press text-[13px] font-semibold"
						style="color: var(--accent-ink)"
					>
						{showBudgetForm ? 'Done' : 'Set budget'}
					</button>
				{/if}
			</div>
			{#if showBudgetForm}
				<form
					method="POST"
					action="?/setBudget"
					use:submit={{ success: 'Budget saved' }}
					class="mb-3 space-y-2"
				>
					<div class="flex items-end gap-2">
						<label class="flex-1">
							<span class="text-[11px]" style="color: var(--ink-3)">Scope</span>
							<select name="categoryId" class="field mt-1 text-[16px]">
								<option value="">Everything</option>
								{#each data.allCategories as c (c.id)}
									<option value={c.id}>{c.icon} {c.name}</option>
								{/each}
							</select>
						</label>
						<label class="w-28">
							<span class="text-[11px]" style="color: var(--ink-3)">{currency}</span>
							<input
								name="amount"
								use:money
								inputmode="decimal"
								placeholder="500"
								class="field num mt-1 text-[16px]"
							/>
						</label>
					</div>
					<div class="flex items-end gap-2">
						<!--
							The cadence is a first-class choice, not a view artifact: a
							weekly grocery cap and a monthly one are separate timelines, and
							both may exist for the same scope at once.
						-->
						<label class="w-32">
							<span class="text-[11px]" style="color: var(--ink-3)">Cadence</span>
							<select name="period" bind:value={budgetCadence} class="field mt-1 text-[16px]">
								<option value="month">Monthly</option>
								<option value="week">Weekly</option>
							</select>
						</label>
						<label class="flex-1">
							<span class="text-[11px]" style="color: var(--ink-3)">Starts</span>
							{#if budgetCadence === 'week'}
								<select name="effectiveWeek" class="field mt-1 text-[16px]">
									{#each data.budgetWeeks as w (w.value)}
										<option value={w.value}>{w.label}</option>
									{/each}
								</select>
							{:else}
								<select name="effectiveMonth" class="field mt-1 text-[16px]">
									{#each data.budgetMonths as m (m.value)}
										<option value={m.value}>{m.label}</option>
									{/each}
								</select>
							{/if}
						</label>
						<button class="btn btn-accent shrink-0 px-4 py-3 text-[15px]">Save</button>
					</div>
					<p class="px-1 text-[12px]" style="color: var(--ink-3)">
						Applies from that {budgetCadence === 'week' ? 'week' : 'month'} onward until you set another.
					</p>
				</form>
			{/if}

			<!--
				Budgets scheduled ahead of the current month. Without this they were
				invisible until the month arrived, so a plan made in advance looked
				like it hadn't saved.
			-->
			{#if data.scheduledBudgets.length > 0}
				<div class="mb-4 rounded-[14px] p-3" style="background: var(--surface-2)">
					<p class="section-label mb-2 px-1">Scheduled</p>
					{#each data.scheduledBudgets as s (s.id)}
						<div class="flex items-center justify-between gap-2 px-1 py-1.5 text-[14px]">
							<span style="color: var(--ink-2)">
								{s.categoryIcon ?? ''}
								{s.categoryName ?? 'Everything'}
								<span style="color: var(--ink-3)"
									>· {s.period === 'week' ? 'weekly' : 'monthly'} from {s.label}</span
								>
							</span>
							<span class="flex items-center gap-2">
								<span class="num" style="color: var(--ink)"
									>{formatMinor(s.amountMinor, currency)}</span
								>
								{#if data.isOwner}
									<form
										method="POST"
										action="?/removeScheduledBudget"
										use:submit={{
											confirm: `Remove the budget starting ${s.label}?`,
											success: 'Scheduled budget removed'
										}}
									>
										<input type="hidden" name="budgetId" value={s.id} />
										<button class="press" style="color: var(--ink-3)" aria-label="Remove">
											<X class="h-3.5 w-3.5" />
										</button>
									</form>
								{/if}
							</span>
						</div>
					{/each}
				</div>
			{/if}
			{#if data.budgets.length > 0}
				<div class="space-y-4">
					{#each data.budgets as b (b.budgetId)}
						{@const pct = pctOf(b.actualMinor, b.budgetMinor)}
						{@const over = b.actualMinor > b.budgetMinor}
						<div>
							<div class="flex items-baseline justify-between px-1 text-[15px]">
								<span style="color: var(--ink)">{b.categoryIcon ?? ''} {b.categoryName}</span>
								<span class="num" style="color: {over ? 'var(--deny)' : 'var(--ink-3)'}">
									{formatMinor(b.actualMinor, currency)} / {formatMinor(b.budgetMinor, currency)}
								</span>
							</div>
							<div
								class="mt-2 h-2.5 overflow-hidden rounded-full"
								style="background: var(--surface-2)"
							>
								<div
									class="h-full rounded-full"
									style="width: {Math.min(pct, 100)}%; background: {over
										? 'var(--deny)'
										: 'var(--approve)'}; transition: width 800ms var(--ease-out)"
								></div>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/if}

	<div>
		<div class="mb-3.5 flex items-baseline justify-between px-1">
			<p class="section-label">By category</p>
			<!--
				Says once, quietly, what every row below affords. A chevron on each row
				shows there is somewhere to go; this says where, without repeating
				"see purchases" ten times.
			-->
			{#if data.categories.length > 0}
				<span class="text-[12px]" style="color: var(--ink-3)">Tap to see purchases</span>
			{/if}
		</div>
		{#if data.categories.length === 0}
			<p class="px-1 text-[15px]" style="color: var(--ink-3)">Nothing spent this {period}.</p>
		{:else}
			<div class="space-y-1">
				{#each data.categories as c (c.categoryId)}
					{@const pct = pctOf(c.totalMinor, data.totalMinor)}
					<a
						href={ledgerLink(slug, {
							from: data.rangeFrom,
							to: data.rangeTo,
							category: c.categoryId
						})}
						class="press -mx-1 block rounded-[var(--r-sm)] px-2 py-2.5"
						aria-label="{c.name}, {formatMinor(c.totalMinor, currency)} · see purchases"
					>
						<div class="flex items-baseline justify-between text-[15px]">
							<span style="color: var(--ink)">
								<span
									class="mr-2 inline-block h-2.5 w-2.5 rounded-full align-middle"
									style="background: {c.color ?? '#8E8E93'}"
								></span>{c.name}
							</span>
							<span class="flex items-baseline gap-1.5">
								<span class="num" style="color: var(--ink-2)">
									{formatMinor(c.totalMinor, currency)}
									<span class="ml-1 text-[12px]" style="color: var(--ink-3)">{formatPct(pct)}</span>
								</span>
								<ChevronRight class="h-3.5 w-3.5 self-center" style="color: var(--ink-4)" />
							</span>
						</div>
						<div
							class="mt-2 h-2.5 overflow-hidden rounded-full"
							style="background: var(--surface-2)"
						>
							<div
								class="h-full rounded-full"
								style="width: {pctOf(c.totalMinor, maxCategory)}%; background: {c.color ??
									'#8E8E93'}; transition: width 800ms var(--ease-out)"
							></div>
						</div>
					</a>
				{/each}
			</div>
		{/if}
	</div>

	<!--
		By place. Same row shape as By member — a place is a plain fact about where
		the money went, not a chart, and giving it its own visual language would
		make it read as more of a claim than it is.

		Only rendered with two or more places: one pinned purchase is a fact about
		that purchase, not a pattern that deserves a heading. The bbox is the row's
		own extent, so the ledger it opens holds exactly the rows behind the figure
		— no more, and none missed.
	-->
	{#if data.locationEnabled && data.places.length > 0}
		<div>
			<div class="mb-2 flex items-baseline justify-between px-1">
				<p class="section-label">By place</p>
				<span class="text-[12px]" style="color: var(--ink-3)">Tap to see purchases</span>
			</div>
			<div style="border-top: 0.5px solid var(--hairline)">
				{#each data.places as pl (pl.key)}
					<a
						href={ledgerLink(slug, {
							from: data.rangeFrom,
							to: data.rangeTo,
							bbox: pl.bboxE3
						})}
						class="press hairline flex items-baseline justify-between gap-3 py-3.5"
						aria-label="{pl.label}, {formatMinor(pl.totalMinor, currency)} · see purchases"
					>
						<span class="flex min-w-0 items-baseline gap-2">
							<MapPin class="h-3.5 w-3.5 shrink-0 self-center" style="color: var(--ink-4)" />
							<span class="truncate text-[15px]" style="color: var(--ink)">{pl.label}</span>
							<span class="num shrink-0 text-[12px]" style="color: var(--ink-3)">
								{pl.count}
							</span>
						</span>
						<span class="flex shrink-0 items-baseline gap-1.5">
							<span class="num text-[15px] font-medium" style="color: var(--ink)"
								>{formatMinor(pl.totalMinor, currency)}</span
							>
							<ChevronRight class="h-3.5 w-3.5 self-center" style="color: var(--ink-4)" />
						</span>
					</a>
				{/each}
			</div>
		</div>
	{/if}

	<div>
		<div class="mb-2 flex items-baseline justify-between px-1">
			<p class="section-label">By member</p>
			{#if data.members.length > 0}
				<span class="text-[12px]" style="color: var(--ink-3)">Tap to see purchases</span>
			{/if}
		</div>
		{#if data.members.length === 0}
			<p class="px-1 text-[15px]" style="color: var(--ink-3)">Nothing spent this {period}.</p>
		{:else}
			<div style="border-top: 0.5px solid var(--hairline)">
				{#each data.members as m (m.memberId)}
					<a
						href={ledgerLink(slug, {
							from: data.rangeFrom,
							to: data.rangeTo,
							member: m.memberId
						})}
						class="press hairline flex items-baseline justify-between py-3.5"
						aria-label="{m.name}, {formatMinor(m.totalMinor, currency)} · see purchases"
					>
						<span class="text-[15px]" style="color: var(--ink)">{m.name}</span>
						<span class="flex items-baseline gap-1.5">
							<span class="num text-[15px] font-medium" style="color: var(--ink)"
								>{formatMinor(m.totalMinor, currency)}</span
							>
							<ChevronRight class="h-3.5 w-3.5 self-center" style="color: var(--ink-4)" />
						</span>
					</a>
				{/each}
			</div>
		{/if}
	</div>

	<!--
		Settle up: the household answer to "who owes whom". Spending is treated
		as shared; each member owes a fair share of it (evenly, or weighted by
		what they earned — the toggle), and the difference against what they
		paid becomes the transfers that zero everyone out.

		The figures are this viewer's: a sealed gift is recomputed away, the
		same as every other number on this page, so two people can see two
		settlements and both be right about what they can see.
	-->
	{#if settleUpMembers.length >= 2 && data.totalMinor > 0n}
		<div>
			<div class="mb-2 flex items-center justify-between px-1">
				<p class="section-label">Settle up</p>
				<Segmented
					options={[
						{ value: 'equal', label: 'Evenly' },
						{ value: 'income', label: 'By income' }
					]}
					value={shareBasis}
					onselect={(v) => (shareBasis = v as 'equal' | 'income')}
					ariaLabel="Fair share basis"
					size="sm"
					fill={false}
				/>
			</div>
			<div style="border-top: 0.5px solid var(--hairline)">
				{#each settlement.shares as s (s.memberId)}
					<div class="hairline flex items-center justify-between gap-3 py-3">
						<span class="min-w-0 text-[15px]" style="color: var(--ink)">
							{s.name}
							<span class="num text-[12px]" style="color: var(--ink-3)">
								· paid {formatMinor(s.paidMinor, currency)} · share {formatMinor(
									s.fairShareMinor,
									currency
								)}
							</span>
						</span>
						<span
							class="num shrink-0 text-[15px] font-medium"
							style="color: {s.owedMinor > 0n
								? 'var(--pending)'
								: s.owedMinor < 0n
									? 'var(--approve)'
									: 'var(--ink-3)'}"
						>
							{#if s.owedMinor > 0n}
								owes {formatMinor(s.owedMinor, currency)}
							{:else if s.owedMinor < 0n}
								is owed {formatMinor(-s.owedMinor, currency)}
							{:else}
								even
							{/if}
						</span>
					</div>
				{/each}
			</div>
			{#if settlement.transfers.length > 0}
				<div class="mt-3 rounded-[14px] p-3.5" style="background: var(--surface-2)">
					<p class="section-label mb-1.5">To settle</p>
					{#each settlement.transfers as t (`${t.fromId}-${t.toId}`)}
						<p class="py-0.5 text-[14px]" style="color: var(--ink-2)">
							{t.fromName} pays {t.toName}
							<span class="num font-medium" style="color: var(--ink)"
								>{formatMinor(t.amountMinor, currency)}</span
							>
						</p>
					{/each}
				</div>
			{/if}
			<p class="mt-2 px-1 text-[12px] leading-relaxed" style="color: var(--ink-3)">
				Fair shares of this {period}'s shared spending{settlement.basis === 'income'
					? ', weighted by what each person earned'
					: ''}.
				{#if settlement.transfers.length === 0}Already even.{/if}
			</p>
		</div>
	{/if}

	<!--
		Lifetime totals, deliberately outside the period navigation above — these
		are running figures for the whole workspace, so they don't change as you
		swipe through months.

		Two rows that each mean something: what money did (in, out, set aside),
		then what happened to requests (returned, refused, withdrawn).
	-->
	<!--
		One tile, both grids. Label, figure and hint sit on tight line boxes with
		the same step between each: the figure used to keep the body's 1.5 leading,
		so its half-leading padded the gap above it and not the one below, and the
		label sat visibly further from the number than the hint did.
	-->
	{#snippet lifetimeTile(stat: { label: string; minor: bigint; tone: string; hint: string })}
		{@const fig = figure(stat.minor)}
		<p
			class="text-[11px] leading-none font-semibold tracking-[0.08em] uppercase"
			style="color: {stat.tone}"
		>
			{stat.label}{fig.symbol ? ` ${fig.symbol}` : ''}
		</p>
		<p class="num mt-2 text-[16px] leading-none font-semibold" style="color: var(--ink)">
			{fig.digits}
		</p>
		<p class="mt-2 text-[11px] leading-tight" style="color: var(--ink-3)">{stat.hint}</p>
	{/snippet}
	<div>
		<p class="section-label mb-2 px-1">Lifetime</p>
		<div class="grid grid-cols-3 gap-2">
			{#each lifetimeStats as stat (stat.label)}
				<div class="card p-3.5">{@render lifetimeTile(stat)}</div>
			{/each}
		</div>
		<div class="mt-2 grid grid-cols-2 gap-2">
			{#each lifetimePairs as pair (pair[0].label)}
				<div class="card">
					{#each pair as stat, i (stat.label)}
						<div class="p-3.5 {i === 0 ? 'hairline' : ''}">{@render lifetimeTile(stat)}</div>
					{/each}
				</div>
			{/each}
		</div>
	</div>
</div>
