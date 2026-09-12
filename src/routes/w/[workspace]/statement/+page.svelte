<script lang="ts">
	import { page } from '$app/state';
	import Money from '$lib/components/Money.svelte';
	import { ledgerLink } from '$lib/ledger-filters';
	import { calDateInZone } from '$lib/domain/time/zoned';
	import { addDays, isoWeekday } from '$lib/domain/recurrence/rrule';
	import {
		Sparkles,
		Printer,
		ChevronLeft,
		ChevronRight,
		Download,
		FileCheck
	} from '@lucide/svelte';

	let { data } = $props();
	const slug = $derived(page.params.workspace!);
	const currency = $derived(data.workspace.currency);
	const tz = $derived(data.workspace.timezone ?? 'UTC');
	const f = $derived(data.figures);
	const s = $derived(data.summary);

	// The month's verdict picks the accent the sheet is read through.
	const TONE_COLOR: Record<string, string> = {
		saved: 'var(--approve)',
		over: 'var(--deny)',
		even: 'var(--ink)',
		neutral: 'var(--ink)',
		budget: 'var(--ink)'
	};
	const heroColor = $derived(TONE_COLOR[data.narration.tone] ?? 'var(--ink)');

	const outMinor = $derived(f.spentMinor);
	/*
	 * The month as four movements that sum to net position, each shown with the
	 * sign it carries into that sum.
	 *
	 * "From buckets" is the one that needs explaining: spending charged to a
	 * bucket is already inside Spending, and its cost was borne in the month the
	 * money was set aside, so the funded part comes back as a credit here. What a
	 * bucket couldn't cover isn't in this line at all, which is exactly why it
	 * stays counted against the month.
	 */
	const flows = $derived([
		{ label: 'Income', minor: f.incomeMinor, sign: true, hide: f.incomeMinor === 0n },
		{ label: 'Spending', minor: -outMinor, sign: true, hide: false },
		{ label: 'Set aside', minor: -f.savingsMinor, sign: true, hide: f.savingsMinor === 0n },
		{ label: 'From buckets', minor: f.releasedMinor, sign: true, hide: f.releasedMinor === 0n }
	]);

	const catMax = $derived(
		data.categories.reduce((m: bigint, c) => (c.totalMinor > m ? c.totalMinor : m), 1n)
	);
	function pct(part: bigint, whole: bigint): number {
		return whole > 0n ? Number((part * 100n) / whole) : 0;
	}

	function formatDate(d: Date | null): string {
		if (!d) return '—';
		// Device locale, like every other date on the page.
		return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}

	function formatCalDate(d: { y: number; m: number; d: number }): string {
		return new Date(Date.UTC(d.y, d.m - 1, d.d)).toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric'
		});
	}

	interface WeekGroup {
		label: string;
		from: { y: number; m: number; d: number };
		to: { y: number; m: number; d: number };
		tx: typeof data.transactions;
	}

	const weekGroups = $derived<WeekGroup[]>(
		(() => {
			const groups: Record<string, WeekGroup> = {};
			for (const tx of data.transactions) {
				const at = tx.completedAt ?? tx.requestedAt;
				if (!at) continue;
				const cd = calDateInZone(at, tz);
				// Move back to Monday (ISO weekday 1).
				const offset = isoWeekday(cd) - 1;
				const mon = addDays(cd, -offset);
				const sun = addDays(mon, 6);
				const key = `${mon.y}-${String(mon.m).padStart(2, '0')}-${String(mon.d).padStart(2, '0')}`;
				let g = groups[key];
				if (!g) {
					g = {
						label: `Week of ${formatCalDate(mon)}`,
						from: mon,
						to: sun,
						tx: []
					};
					groups[key] = g;
				}
				g.tx.push(tx);
			}
			return Object.values(groups);
		})()
	);

	function printSheet() {
		window.print();
	}
</script>

<svelte:head><title>{data.label} statement · {data.workspace.name}</title></svelte:head>

<!-- Month navigation: screen only, never printed. -->
<header
	class="screen-only sticky top-0 z-10 flex items-center justify-between px-4 py-3"
	style="background: color-mix(in oklab, var(--paper) 92%, transparent); box-shadow: 0 0.5px 0 var(--hairline)"
>
	<a
		class="grid h-9 w-9 place-items-center rounded-full"
		style="color: {data.hasPrev ? 'var(--ink-2)' : 'var(--ink-4)'}; pointer-events: {data.hasPrev
			? 'auto'
			: 'none'}"
		href="?month={data.prevMonth}"
		aria-label="Previous month"><ChevronLeft size={20} /></a
	>
	<div class="text-center">
		<p class="text-[15px] font-semibold" style="color: var(--ink)">{data.label}</p>
		{#if data.isPartial}
			<p class="text-[10px] font-medium tracking-wide uppercase" style="color: var(--ink-3)">
				In progress
			</p>
		{/if}
	</div>
	<a
		class="grid h-9 w-9 place-items-center rounded-full"
		style="color: {data.hasNext ? 'var(--ink-2)' : 'var(--ink-4)'}; pointer-events: {data.hasNext
			? 'auto'
			: 'none'}"
		href="?month={data.nextMonth}"
		aria-label="Next month"><ChevronRight size={20} /></a
	>
</header>

<article class="sheet w-full pt-6 pb-24">
	<!-- Letterhead -->
	<header class="flex items-start justify-between gap-4">
		<div>
			<p class="text-[11px] font-semibold tracking-[0.12em] uppercase" style="color: var(--ink-3)">
				Monthly Statement
			</p>
			<h1
				class="mt-1 font-[family-name:var(--font-display)] text-[28px] leading-none font-bold"
				style="color: var(--ink)"
			>
				{data.workspace.name}
			</h1>
			<p class="mt-1.5 text-[14px]" style="color: var(--ink-2)">
				{data.label}{#if data.isPartial}
					, through {data.asOf}{/if}
			</p>
		</div>
		<div class="text-right">
			<div class="screen-only flex items-center justify-end gap-2">
				<!-- The adjacent idea: this sheet says what Ledger thinks happened;
				     reconcile checks it against what the bank says happened. -->
				<a
					href="/w/{slug}/reconcile"
					class="press icon-btn"
					aria-label="Reconcile against a bank statement"><FileCheck size={16} /></a
				>
				<button onclick={printSheet} class="press icon-btn" aria-label="Print this statement"
					><Printer size={16} /></button
				>
				<button onclick={printSheet} class="press icon-btn" aria-label="Save as PDF"
					><Download size={16} /></button
				>
			</div>
			<p class="mt-1 text-[11px]" style="color: var(--ink-3)">
				Generated {data.generatedAt}
			</p>
		</div>
	</header>

	<div class="my-6 h-px" style="background: var(--hairline-strong)"></div>

	<!-- Summary cards -->
	<section class="grid grid-cols-2 gap-3 md:grid-cols-4">
		{#each flows as row (row.label)}
			{#if !row.hide}
				<div
					class="rounded-2xl p-3.5"
					style="background: var(--surface); box-shadow: inset 0 0 0 1px var(--hairline)"
				>
					<p
						class="text-[11px] font-semibold tracking-[0.08em] uppercase"
						style="color: var(--ink-3)"
					>
						{row.label}
					</p>
					<p
						class="mt-1.5 font-[family-name:var(--font-display)] text-[22px] font-bold"
						style="color: var(--ink)"
					>
						<Money minor={row.minor} {currency} sign={row.sign} />
					</p>
				</div>
			{/if}
		{/each}
		<div
			class="rounded-2xl p-3.5"
			style="background: color-mix(in oklab, {heroColor} 8%, var(--surface)); box-shadow: inset 0 0 0 1px color-mix(in oklab, {heroColor} 20%, var(--hairline))"
		>
			<p class="text-[11px] font-semibold tracking-[0.08em] uppercase" style="color: {heroColor}">
				Net position
			</p>
			<p
				class="mt-1.5 font-[family-name:var(--font-display)] text-[22px] font-bold"
				style="color: {heroColor}"
			>
				<Money minor={s.netMinor} {currency} sign />
			</p>
		</div>
	</section>

	<!-- Verdict -->
	<p class="mt-4 text-[13px]" style="color: {heroColor}">{data.narration.lead}</p>

	<!-- Harmony's read -->
	{#if data.narration.notes.length > 0}
		<div
			class="mt-6 rounded-2xl p-4"
			style="background: var(--surface); box-shadow: inset 0 0 0 1px var(--hairline)"
		>
			<p class="section-label mb-2 flex items-center gap-1.5">
				<Sparkles size={13} style="color: var(--accent)" /> Harmony's read
			</p>
			<ul class="space-y-1.5">
				{#each data.narration.notes as note (note)}
					<li class="text-[13px] leading-snug" style="color: var(--ink-2)">{note}</li>
				{/each}
			</ul>
		</div>
	{/if}

	<!-- Where it went -->
	{#if data.categories.length > 0}
		<section class="mt-8">
			<h2 class="section-label mb-3">Spending by category</h2>
			<div
				class="statement-table overflow-hidden rounded-2xl"
				style="box-shadow: inset 0 0 0 1px var(--hairline)"
			>
				<table class="w-full text-left">
					<thead class="screen-only">
						<tr style="background: var(--surface-2)">
							<th
								class="px-4 py-2 text-[11px] font-semibold tracking-wide uppercase"
								style="color: var(--ink-3)">Category</th
							>
							<th
								class="px-4 py-2 text-right text-[11px] font-semibold tracking-wide uppercase"
								style="color: var(--ink-3)">Amount</th
							>
							<th
								class="px-4 py-2 text-right text-[11px] font-semibold tracking-wide uppercase"
								style="color: var(--ink-3)">Share</th
							>
						</tr>
					</thead>
					<tbody>
						{#each data.categories as c (c.categoryId)}
							<tr class="group" style="border-top: 1px solid var(--hairline)">
								<td class="px-4 py-2.5">
									<a
										href={ledgerLink(slug, {
											from: data.rangeFrom,
											to: data.rangeTo,
											category: c.categoryId
										})}
										class="screen-only block text-[14px] font-medium"
										style="color: var(--ink-2)"
									>
										{c.name}
									</a>
									<span class="print-only text-[14px] font-medium" style="color: var(--ink-2)"
										>{c.name}</span
									>
									<div
										class="mt-1.5 h-1 overflow-hidden rounded-full"
										style="background: var(--hairline)"
									>
										<div
											class="h-full rounded-full"
											style="width: {pct(c.totalMinor, catMax)}%; background: {c.color ??
												'var(--ink-3)'}"
										></div>
									</div>
								</td>
								<td
									class="px-4 py-2.5 text-right text-[14px] font-medium"
									style="color: var(--ink)"
								>
									<Money minor={c.totalMinor} {currency} />
								</td>
								<td class="px-4 py-2.5 text-right text-[13px]" style="color: var(--ink-3)">
									{pct(c.totalMinor, f.spentMinor)}%
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{/if}

	<!-- Household split -->
	{#if data.members.length > 1}
		<section class="mt-8">
			<h2 class="section-label mb-3">Spending by member</h2>
			<div
				class="statement-table overflow-hidden rounded-2xl"
				style="box-shadow: inset 0 0 0 1px var(--hairline)"
			>
				<table class="w-full text-left">
					<thead class="screen-only">
						<tr style="background: var(--surface-2)">
							<th
								class="px-4 py-2 text-[11px] font-semibold tracking-wide uppercase"
								style="color: var(--ink-3)">Member</th
							>
							<th
								class="px-4 py-2 text-right text-[11px] font-semibold tracking-wide uppercase"
								style="color: var(--ink-3)">Amount</th
							>
							<th
								class="px-4 py-2 text-right text-[11px] font-semibold tracking-wide uppercase"
								style="color: var(--ink-3)">Share</th
							>
						</tr>
					</thead>
					<tbody>
						{#each data.members as m (m.memberId)}
							<tr style="border-top: 1px solid var(--hairline)">
								<td class="px-4 py-2.5 text-[14px]" style="color: var(--ink-2)">{m.name}</td>
								<td
									class="px-4 py-2.5 text-right text-[14px] font-medium"
									style="color: var(--ink)"
								>
									<Money minor={m.totalMinor} {currency} />
								</td>
								<td class="px-4 py-2.5 text-right text-[13px]" style="color: var(--ink-3)">
									{pct(m.totalMinor, f.spentMinor)}%
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{/if}

	<!-- Transaction register -->
	<section class="mt-8">
		<div class="mb-3 flex items-baseline justify-between">
			<h2 class="section-label">Transaction register</h2>
			<span class="text-[12px]" style="color: var(--ink-3)">
				{f.txCount}
				{f.txCount === 1 ? 'purchase' : 'purchases'}
			</span>
		</div>
		{#if data.transactions.length === 0}
			<p
				class="rounded-2xl p-4 text-[14px]"
				style="background: var(--surface); color: var(--ink-3)"
			>
				No completed purchases in this period.
			</p>
		{:else}
			<!-- The register renders two ways from the same data. Wide screens get a
		     real table; narrow ones (PWA) get stacked rows — a five-column table
		     at phone width read as cramped and cluttered. Same information in
		     both: item, refund flag, merchant, date, category, member, amount. -->
			<div
				class="statement-table hidden overflow-hidden rounded-2xl md:block"
				style="box-shadow: inset 0 0 0 1px var(--hairline)"
			>
				<table class="w-full text-left">
					<thead>
						<tr style="background: var(--surface-2)">
							<th
								class="px-4 py-2 text-[11px] font-semibold tracking-wide uppercase"
								style="color: var(--ink-3)">Date</th
							>
							<th
								class="px-4 py-2 text-[11px] font-semibold tracking-wide uppercase"
								style="color: var(--ink-3)">Description</th
							>
							<th
								class="px-4 py-2 text-[11px] font-semibold tracking-wide uppercase"
								style="color: var(--ink-3)">Category</th
							>
							<th
								class="px-4 py-2 text-[11px] font-semibold tracking-wide uppercase"
								style="color: var(--ink-3)">Member</th
							>
							<th
								class="px-4 py-2 text-right text-[11px] font-semibold tracking-wide uppercase"
								style="color: var(--ink-3)">Amount</th
							>
						</tr>
					</thead>
					<tbody>
						{#each weekGroups as group (group.label)}
							{@const groupTotal = group.tx.reduce((sum, tx) => sum + tx.amountMinor, 0n)}
							<tr class="week-header" style="border-top: 1px solid var(--hairline)">
								<td
									colspan="4"
									class="px-4 py-2 text-[12px] font-semibold tracking-wide"
									style="background: var(--surface); color: var(--ink-2)"
								>
									{group.label}
									<span class="font-normal" style="color: var(--ink-3)">
										({formatCalDate(group.from)} &ndash; {formatCalDate(group.to)})
									</span>
								</td>
								<td
									class="px-4 py-2 text-right text-[12px] font-semibold"
									style="background: var(--surface); color: var(--ink)"
								>
									<Money minor={groupTotal} {currency} />
								</td>
							</tr>
							{#each group.tx as tx (tx.id)}
								<tr class="tx-row" style="border-top: 1px solid var(--hairline)">
									<td
										class="px-4 py-2.5 align-top text-[13px] whitespace-nowrap"
										style="color: var(--ink-3)"
									>
										{formatDate(tx.completedAt ?? tx.requestedAt)}
									</td>
									<td class="px-4 py-2.5 align-top">
										<p class="text-[14px] font-medium" style="color: var(--ink)">
											{tx.itemName}
											{#if tx.isRefund}
												<span
													class="ml-1.5 rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase"
													style="background: var(--surface-2); color: var(--ink-3)">Refund</span
												>
											{/if}
										</p>
										{#if tx.merchantName}
											<p class="text-[12px]" style="color: var(--ink-3)">{tx.merchantName}</p>
										{/if}
									</td>
									<td class="px-4 py-2.5 align-top text-[13px]" style="color: var(--ink-2)">
										{#if tx.categoryIcon}{tx.categoryIcon}
										{/if}{tx.categoryName ?? 'Uncategorized'}
									</td>
									<td class="px-4 py-2.5 align-top text-[13px]" style="color: var(--ink-2)"
										>{tx.requesterName}</td
									>
									<td
										class="px-4 py-2.5 text-right align-top text-[14px] font-medium"
										style="color: var(--ink)"
									>
										<Money minor={tx.amountMinor} {currency} />
									</td>
								</tr>
							{/each}
						{/each}
					</tbody>
				</table>
			</div>
			<!-- Narrow (PWA): the same register as stacked rows. -->
			<div
				class="statement-table overflow-hidden rounded-2xl md:hidden"
				style="box-shadow: inset 0 0 0 1px var(--hairline)"
			>
				{#each weekGroups as group (group.label)}
					{@const groupTotal = group.tx.reduce((sum, tx) => sum + tx.amountMinor, 0n)}
					<div
						class="week-header flex items-baseline justify-between gap-2 px-4 py-2"
						style="border-top: 1px solid var(--hairline); background: var(--surface)"
					>
						<p class="text-[12px] font-semibold tracking-wide" style="color: var(--ink-2)">
							{group.label}
							<span class="font-normal" style="color: var(--ink-3)">
								({formatCalDate(group.from)} &ndash; {formatCalDate(group.to)})
							</span>
						</p>
						<p class="num shrink-0 text-[12px] font-semibold" style="color: var(--ink)">
							<Money minor={groupTotal} {currency} />
						</p>
					</div>
					{#each group.tx as tx (tx.id)}
						<div class="tx-row px-4 py-2.5" style="border-top: 1px solid var(--hairline)">
							<div class="flex items-baseline justify-between gap-3">
								<p class="min-w-0 text-[14px] font-medium" style="color: var(--ink)">
									{tx.itemName}
									{#if tx.isRefund}
										<span
											class="ml-1.5 rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase"
											style="background: var(--surface-2); color: var(--ink-3)">Refund</span
										>
									{/if}
								</p>
								<p class="num shrink-0 text-[14px] font-medium" style="color: var(--ink)">
									<Money minor={tx.amountMinor} {currency} />
								</p>
							</div>
							<p class="mt-0.5 text-[12px]" style="color: var(--ink-3)">
								{formatDate(tx.completedAt ?? tx.requestedAt)} ·
								{#if tx.categoryIcon}{tx.categoryIcon}
								{/if}{tx.categoryName ?? 'Uncategorized'} · {tx.requesterName}
							</p>
							{#if tx.merchantName}
								<p class="mt-0.5 text-[12px]" style="color: var(--ink-3)">{tx.merchantName}</p>
							{/if}
						</div>
					{/each}
				{/each}
			</div>
		{/if}
	</section>

	<!--
		Reconcile's real home.
		
		It used to be reachable only from Settings, which is where you go to change
		how something behaves — not where you go to do a month's work. And an
		icon-only link in the header (still there, for anyone who has learned it)
		is not a feature anyone finds. This sheet says what Ledger thinks happened
		this month; checking that against the bank is the obvious next question, so
		it gets asked here, in words, at the point the question occurs to you.
	-->
	<a href="/w/{slug}/reconcile" class="press screen-only card mt-8 flex items-center gap-3.5 p-4">
		<span
			class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
			style="background: color-mix(in oklab, var(--ws-accent) 18%, transparent)"
		>
			<FileCheck class="h-[18px] w-[18px]" style="color: var(--ws-accent)" />
		</span>
		<span class="min-w-0 flex-1">
			<span class="block text-[15px] font-medium" style="color: var(--ink)">
				Check this against your bank
			</span>
			<span class="mt-0.5 block text-[13px] leading-snug" style="color: var(--ink-3)">
				Import {data.label}'s statement and tick off what cleared. Nothing is created or changed.
			</span>
		</span>
		<ChevronRight class="h-4 w-4 shrink-0" style="color: var(--ink-4)" />
	</a>

	<!-- Fine print -->
	<footer
		class="mt-8 border-t pt-4 text-[11px] leading-relaxed"
		style="border-color: var(--hairline); color: var(--ink-3)"
	>
		<p>
			{f.txCount}
			{f.txCount === 1 ? 'purchase' : 'purchases'} recorded{#if data.isPartial}, through {data.asOf}{/if}.
			Figures reflect what you can see: sealed purchases appear only to those they're shared with.
		</p>
		<a
			href={ledgerLink(slug, { from: data.rangeFrom, to: data.rangeTo })}
			class="screen-only mt-2 inline-block font-medium"
			style="color: var(--accent)"
		>
			Open the full ledger for {data.label}
		</a>
	</footer>
</article>

<style>
	/* The sheet reads as paper on screen, and prints as ink on white with the
	   chrome (nav, tab bar, buttons, bars) stripped away. */
	@media print {
		@page {
			margin: 16mm 14mm;
			@bottom-center {
				content: counter(page);
				font-size: 10px;
				color: #666;
			}
		}
		:global(.screen-only) {
			display: none !important;
		}
		:global(.print-only) {
			display: block !important;
		}
		:global(nav) {
			display: none !important;
		}
		.sheet {
			max-width: none;
			padding: 0;
		}
		.statement-table {
			box-shadow: none !important;
			border: 1px solid #ccc;
		}
		.statement-table thead {
			display: table-header-group;
		}
		.statement-table thead th {
			background: #f5f5f5 !important;
			color: #333 !important;
		}
		.week-header td {
			background: #fafafa !important;
			color: #333 !important;
		}
		.tx-row,
		.week-header {
			page-break-inside: avoid;
		}
		.group > td > div:last-child {
			display: none;
		}
	}
	.print-only {
		display: none;
	}
</style>
