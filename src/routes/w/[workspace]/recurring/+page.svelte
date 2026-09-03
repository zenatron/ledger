<script lang="ts">
	import { onMount } from 'svelte';
	import { fade, scale, slide } from 'svelte/transition';
	import { prefersReducedMotion } from 'svelte/motion';
	import { submit } from '$lib/actions/submit';
	import { swipe } from '$lib/actions/swipe';
	import { page } from '$app/state';
	import PlanTabs from '$lib/components/PlanTabs.svelte';
	import RecurrencePicker from '$lib/components/RecurrencePicker.svelte';
	import { calDateInZone } from '$lib/domain/time/zoned';
	import { money } from '$lib/actions/money';
	import { dismiss } from '$lib/actions/dismiss';
	import { formatMinor } from '$lib/money-format';
	import {
		Check,
		ChevronDown,
		ChevronRight,
		CircleHelp,
		Funnel,
		OctagonX,
		Pause,
		Pencil,
		Play,
		Repeat,
		RotateCcw,
		Trash2,
		X
	} from '@lucide/svelte';
	import Money from '$lib/components/Money.svelte';
	import CheckField from '$lib/components/CheckField.svelte';
	let { data, form } = $props();
	let slug = $derived(page.params.workspace);

	let freq = $state('monthly');
	let showNew = $state(false);
	let editing: string | null = $state(null);
	// Only one rule is open for editing at a time, so these are single slots
	// rather than a map keyed by rule id.
	let editFreq = $state('monthly');
	let editInterval = $state(1);
	let editWeekDays = $state<number[]>([]);
	let editMonthDay = $state('1');
	let editStart = $state('');
	// Bound straight into RecurrencePicker, which emits the same field names the
	// server already parses.
	let interval = $state(1);
	let weekDays = $state<number[]>([]);
	let monthDay = $state('1');
	// Today in the *workspace* timezone. toISOString() is UTC, so after ~8pm in
	// the Americas these forms defaulted to tomorrow's date.
	const today = $derived.by(() => {
		const t = calDateInZone(new Date(), data.workspace.timezone);
		return `${t.y}-${String(t.m).padStart(2, '0')}-${String(t.d).padStart(2, '0')}`;
	});
	// Intentionally a snapshot: this seeds the field's default, and the user
	// edits it from there. The page remounts per workspace, so it can't go stale.
	// svelte-ignore state_referenced_locally
	let startDate = $state(today);
	let autoComplete = $state(true);
	let backfill = $state(false);
	let editAutoComplete = $state(true);

	// Starting an ended rule again opens the same form an edit does, so it keeps
	// the same single-slot shape. A restart is the moment a price is most likely
	// to have moved, which is why it is a form and not a one-tap undo.
	let restarting: string | null = $state(null);
	let restartFreq = $state('monthly');
	let restartInterval = $state(1);
	let restartWeekDays = $state<number[]>([]);
	let restartMonthDay = $state('1');
	let restartStart = $state('');
	let restartAutoComplete = $state(true);

	function fmtStart(d: string): string {
		const [y, m, day] = d.split('-').map(Number);
		return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString(undefined, {
			month: 'long',
			day: 'numeric',
			year: 'numeric',
			timeZone: 'UTC'
		});
	}

	function fmtNext(iso: string | null): string {
		if (!iso) return '·';
		return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}

	function fmtEnded(iso: string): string {
		return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}

	function startEdit(r: (typeof data.rules)[number]) {
		editing = editing === r.id ? null : r.id;
		if (editing === null) return;
		editFreq = r.freq;
		editInterval = r.interval;
		editWeekDays = [...r.byDay];
		editMonthDay = String(r.monthDay ?? 1);
		editStart = r.startDate ?? today;
		editAutoComplete = r.autoComplete;
	}

	function startRestart(r: (typeof data.past)[number]) {
		restarting = restarting === r.id ? null : r.id;
		if (restarting === null) return;
		restartFreq = r.freq;
		restartInterval = r.interval;
		restartWeekDays = [...r.byDay];
		restartMonthDay = String(r.monthDay ?? 1);
		// Today, not the rule's original anchor. An edit deliberately preserves
		// the anchor (re-anchoring silently moved weekly rules onto a different
		// weekday). Restarting is the opposite case: you are picking when it
		// starts again, and the picker shows the date so the choice is visible.
		restartStart = today;
		restartAutoComplete = r.autoComplete;
	}

	function resetNewForm() {
		showNew = false;
		freq = 'monthly';
		interval = 1;
		weekDays = [];
		monthDay = '1';
		startDate = today;
		autoComplete = true;
		backfill = false;
	}

	// --- View preferences (grouping + sorting), persisted per user ---------------
	type Rule = (typeof data.rules)[number];
	type SortBy = 'soonest' | 'priceAsc' | 'priceDesc';
	type GroupBy = 'cadence' | 'none';
	const PREFS_KEY = 'recurring-view-prefs';

	let groupBy = $state<GroupBy>('cadence');
	let sortBy = $state<SortBy>('soonest');
	// Whether the Ended section is open. Remembered alongside the other view
	// preferences: someone who keeps an eye on what they used to pay for should
	// not have to reopen it every visit.
	let showPast = $state(false);
	// The popover edits drafts, applied only on "Done", so a half-made choice
	// doesn't reshuffle the list under you.
	let showSettings = $state(false);
	let draftGroupBy = $state<GroupBy>('cadence');
	let draftSortBy = $state<SortBy>('soonest');

	onMount(() => {
		try {
			const raw = localStorage.getItem(PREFS_KEY);
			if (!raw) return;
			const p = JSON.parse(raw);
			if (p.groupBy === 'none' || p.groupBy === 'cadence') groupBy = p.groupBy;
			if (p.sortBy === 'soonest' || p.sortBy === 'priceAsc' || p.sortBy === 'priceDesc')
				sortBy = p.sortBy;
			if (typeof p.showPast === 'boolean') showPast = p.showPast;
		} catch {
			/* corrupt or unavailable storage — fall back to defaults */
		}
	});

	function openSettings() {
		draftGroupBy = groupBy;
		draftSortBy = sortBy;
		showSettings = true;
	}
	function savePrefs() {
		try {
			localStorage.setItem(PREFS_KEY, JSON.stringify({ groupBy, sortBy, showPast }));
		} catch {
			/* storage unavailable — the choice still applies for this session */
		}
	}
	function applySettings() {
		groupBy = draftGroupBy;
		sortBy = draftSortBy;
		savePrefs();
		showSettings = false;
	}
	// The disclosure sits outside the View modal's draft-then-apply flow, so it
	// writes as it toggles.
	function togglePast() {
		showPast = !showPast;
		savePrefs();
	}

	function sortRules(rules: Rule[]): Rule[] {
		const arr = [...rules];
		arr.sort((a, b) => {
			if (sortBy === 'soonest') {
				// A rule with no next date (paused) sorts to the end.
				const na = a.nextAt ?? '￿';
				const nb = b.nextAt ?? '￿';
				return na < nb ? -1 : na > nb ? 1 : 0;
			}
			const diff = a.monthlyMinor < b.monthlyMinor ? -1 : a.monthlyMinor > b.monthlyMinor ? 1 : 0;
			return sortBy === 'priceAsc' ? diff : -diff;
		});
		return arr;
	}

	const CADENCE: { key: string; label: string }[] = [
		{ key: 'daily', label: 'Daily' },
		{ key: 'weekly', label: 'Weekly' },
		{ key: 'monthly', label: 'Monthly' },
		{ key: 'yearly', label: 'Yearly' }
	];

	// Grouped (by cadence) or flat, each bucket sorted by the chosen key; paused
	// rules always trail in their own group.
	const groups = $derived.by(() => {
		const active = data.rules.filter((r) => r.status !== 'paused');
		const paused = data.rules.filter((r) => r.status === 'paused');
		const out: { key: string; label: string; rules: Rule[] }[] = [];
		if (groupBy === 'cadence') {
			for (const { key, label } of CADENCE) {
				const rules = sortRules(active.filter((r) => r.freq === key));
				if (rules.length) out.push({ key, label, rules });
			}
		} else if (active.length) {
			out.push({ key: 'all', label: '', rules: sortRules(active) });
		}
		if (paused.length) out.push({ key: 'paused', label: 'Paused', rules: sortRules(paused) });
		return out;
	});

	// "~$4.17/mo" under a price, shown only when normalizing actually changes it
	// (so a plain monthly charge doesn't repeat itself).
	function perMonth(r: Rule): string | null {
		if (r.monthlyMinor === r.amountMinor) return null;
		return `~${formatMinor(r.monthlyMinor, r.currency)}/mo`;
	}
</script>

<div class="space-y-4">
	<PlanTabs />
	<div class="flex items-center justify-between px-1">
		<h1 class="text-[28px]">Recurring</h1>
		<div class="flex items-center gap-2">
			{#if data.rules.length > 1}
				<button onclick={openSettings} class="press icon-btn" aria-label="Sort and group">
					<Funnel class="h-4 w-4" style="color: var(--ink-3)" />
				</button>
			{/if}
			<button
				onclick={() => (showNew = !showNew)}
				class="btn {showNew ? 'btn-ghost' : 'btn-tint'} px-4 py-2 text-[14px]"
			>
				{showNew ? 'Cancel' : '+ New'}
			</button>
		</div>
	</div>

	{#if showSettings}
		<!-- Centered modal, mirroring the ledger filter. Choices are drafted here and
		     committed on Done, then remembered for next time. -->
		<div
			class="fixed inset-0 z-50"
			style="background: var(--scrim)"
			use:dismiss={() => (showSettings = false)}
			transition:fade={{ duration: 140 }}
		></div>
		<div
			class="fixed inset-x-4 top-[14vh] z-50 mx-auto max-w-sm"
			role="dialog"
			aria-modal="true"
			aria-label="Sort and group"
			transition:scale={{ start: 0.96, duration: 170 }}
		>
			<div
				class="card-lg overflow-hidden"
				style="box-shadow: var(--shadow-float); background: var(--surface)"
			>
				<div class="flex items-center justify-between px-5 pt-4 pb-3.5">
					<h2 class="font-[family-name:var(--font-display)] text-[22px]" style="color: var(--ink)">
						View
					</h2>
					<button
						onclick={() => (showSettings = false)}
						class="press -mr-1 flex h-8 w-8 items-center justify-center rounded-full"
						style="color: var(--ink-3)"
						aria-label="Close"
					>
						<X class="h-4 w-4" />
					</button>
				</div>
				<div class="h-px" style="background: var(--hairline)"></div>

				<div class="space-y-5 px-5 py-4">
					<div>
						<p class="section-label mb-2">Sort by</p>
						<div class="flex flex-col gap-1.5">
							{#each [{ v: 'soonest', l: 'Soonest' }, { v: 'priceAsc', l: 'Price: low to high' }, { v: 'priceDesc', l: 'Price: high to low' }] as o (o.v)}
								{@const on = draftSortBy === o.v}
								<button
									onclick={() => (draftSortBy = o.v as SortBy)}
									role="radio"
									aria-checked={on}
									class="press flex items-center justify-between rounded-[12px] px-3.5 py-2.5 text-[15px]"
									style={on
										? 'background: var(--ink); color: var(--paper)'
										: 'background: var(--surface-2); color: var(--ink-2)'}
								>
									{o.l}
									{#if on}<Check class="h-4 w-4" />{/if}
								</button>
							{/each}
						</div>
					</div>

					<button
						onclick={() => (draftGroupBy = draftGroupBy === 'cadence' ? 'none' : 'cadence')}
						role="switch"
						aria-checked={draftGroupBy === 'cadence'}
						class="press flex w-full items-center justify-between"
					>
						<span class="text-left">
							<span class="block text-[15px]" style="color: var(--ink)">Group by cadence</span>
							<span class="block text-[13px]" style="color: var(--ink-3)">
								Weekly, monthly and yearly under their own headings
							</span>
						</span>
						<span
							class="relative h-[28px] w-[44px] shrink-0 rounded-full transition-colors"
							style="background: {draftGroupBy === 'cadence'
								? 'var(--accent)'
								: 'var(--surface-hi)'}"
						>
							<span
								class="absolute top-1 left-0 h-5 w-5 rounded-full bg-white shadow-sm transition-transform"
								style="transform: translateX({draftGroupBy === 'cadence' ? '20px' : '4px'})"
							></span>
						</span>
					</button>
				</div>

				<div class="h-px" style="background: var(--hairline)"></div>
				<div class="px-5 py-3">
					<button onclick={applySettings} class="btn btn-accent w-full py-2.5 text-[14px]"
						>Done</button
					>
				</div>
			</div>
		</div>
	{/if}

	{#if data.rules.length > 0}
		<!-- What the active rules add up to, per month and annualized. -->
		<div class="card flex items-stretch p-4">
			<div class="flex-1 text-center">
				<p class="section-label">Per month</p>
				<Money
					minor={data.monthlyTotalMinor}
					currency={data.currency}
					block
					class="num mt-1 text-[22px] font-semibold"
				/>
			</div>
			<div class="mx-2 w-px shrink-0" style="background: var(--hairline)"></div>
			<div class="flex-1 text-center">
				<p class="section-label">Per year</p>
				<Money
					minor={data.yearlyTotalMinor}
					currency={data.currency}
					block
					class="num mt-1 text-[22px] font-semibold"
				/>
			</div>
		</div>
	{/if}

	{#if data.needsConfirmingCount > 0}
		<!-- Charges that landed but still need the real amount; the ledger's
		     "Confirm what you paid" section is where you clear them. -->
		<a
			href="/w/{slug}/purchases"
			class="press card flex items-center justify-between gap-3 p-4"
			style="box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--approve) 30%, transparent)"
		>
			<span class="flex items-center gap-2.5">
				<Check class="h-4 w-4 shrink-0" style="color: var(--approve)" />
				<span class="text-[15px]" style="color: var(--ink)">
					{data.needsConfirmingCount}
					{data.needsConfirmingCount === 1 ? 'charge needs' : 'charges need'} confirming
				</span>
			</span>
			<ChevronRight class="h-4 w-4 shrink-0" style="color: var(--ink-4)" />
		</a>
	{/if}

	{#if form?.error}
		<div
			class="card p-4 text-[15px]"
			style="color: var(--deny); background: color-mix(in oklab, var(--deny) 12%, var(--surface))"
		>
			{form.error}
		</div>
	{/if}

	{#if showNew}
		<form
			method="POST"
			action="?/create"
			use:submit={{ success: 'Recurring charge added', onSuccess: resetNewForm }}
			class="card space-y-3.5 p-5"
		>
			<div class="grid grid-cols-[1fr_auto] gap-3">
				<input name="itemName" required placeholder="Streaming service" class="field text-[16px]" />
				<input
					name="amount"
					required
					use:money
					inputmode="decimal"
					placeholder="9.99"
					class="field w-28 text-[16px] tabular-nums"
				/>
			</div>
			<RecurrencePicker bind:freq bind:interval bind:weekDays bind:monthDay bind:startDate />

			<select name="categoryId" class="field text-[16px]">
				<option value="">Other (no category)</option>
				{#each data.categories as c (c.id)}<option value={c.id}>{c.icon} {c.name}</option>{/each}
			</select>
			{#if data.buckets.length > 0}
				<select name="bucketId" class="field text-[16px]">
					<option value="">Charge to bucket…</option>
					{#each data.buckets as b (b.id)}<option value={b.id}>{b.name}</option>{/each}
				</select>
			{/if}
			<!--
				Only *does* anything when the start date is behind us, but it stays on
				screen either way: hiding it meant you couldn't discover backfilling
				until you'd already backdated the start, and the form reflowed the
				moment you did. Disabled, it doubles as the instruction for enabling it.
				A disabled input isn't submitted, so a stale tick can't leak through.
			-->
			<CheckField
				name="backfill"
				bind:checked={backfill}
				disabled={startDate >= today}
				label="Add the charges I've already missed"
				hint={startDate < today
					? `Fills in every occurrence since ${fmtStart(startDate)}.`
					: 'Set the start date in the past to fill in charges you already missed.'}
			/>
			<CheckField
				name="autoComplete"
				bind:checked={autoComplete}
				label="It's the same amount every time"
				hint={autoComplete
					? 'Recorded for you on the day, at this amount.'
					: 'Each charge waits for you to enter what you were actually billed.'}
			/>
			<button class="btn btn-accent w-full">Add recurring charge</button>
		</form>
	{/if}

	{#if data.rules.length === 0 && data.past.length > 0}
		<!-- Everything on file has ended. The full empty state would be wrong here:
		     you have used this page, and the record is sitting right below. -->
		<p class="card px-4 py-5 text-center text-[15px]" style="color: var(--ink-3)">
			Nothing recurring right now. Ended charges are below.
		</p>
	{:else if data.rules.length === 0}
		<div class="card-lg card px-6 py-16 text-center">
			<div
				class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl"
				style="background: color-mix(in oklab, var(--ws-accent) 16%, var(--surface-2))"
			>
				<Repeat class="h-7 w-7" style="color: var(--ws-accent)" />
			</div>
			<p class="text-[18px] font-semibold" style="color: var(--ink)">No recurring charges</p>
			<p class="mx-auto mt-1 max-w-[28ch] text-[15px] leading-relaxed" style="color: var(--ink-3)">
				Add a bill or subscription and each charge is recorded on its own schedule.
			</p>
			<a
				href="/w/{slug}/settings/help?s=recurring"
				class="press mt-4 inline-flex items-center gap-1.5 text-[14px] font-medium"
				style="color: var(--accent-ink)"
			>
				<CircleHelp class="h-4 w-4" /> How this works
			</a>
		</div>
	{:else}
		{#each groups as g (g.key)}
			<div class="space-y-2">
				{#if g.label}<p class="section-label px-1">{g.label}</p>{/if}
				<div class="card overflow-hidden">
					{#each g.rules as r, i (r.id)}
						<!--
							Swipe parity with the ledger, as a second affordance: the inline
							actions stay, and a left swipe on your own rule reveals the two
							state changes — Pause/Resume and End. Standing down while the row
							is expanded into its edit form, like the other pages.
						-->
						{@const swipeable = r.mine && editing !== r.id}
						<div
							class="relative overflow-hidden {i < g.rules.length - 1 ? 'hairline' : ''}"
							use:swipe={{ width: swipeable ? 176 : 0, enabled: swipeable }}
						>
							{#if swipeable}
								<div class="absolute inset-y-0 right-0 z-0 flex">
									{#if r.status === 'active'}
										<form
											method="POST"
											action="?/pause"
											use:submit={{ success: 'Paused' }}
											class="contents"
										>
											<input type="hidden" name="ruleId" value={r.id} />
											<button
												class="press flex h-full w-[88px] flex-col items-center justify-center gap-1 text-[13px] font-semibold"
												style="background: var(--pending); color: var(--paper)"
											>
												<Pause class="h-4 w-4" /> Pause
											</button>
										</form>
									{:else}
										<form
											method="POST"
											action="?/resume"
											use:submit={{ success: 'Resumed' }}
											class="contents"
										>
											<input type="hidden" name="ruleId" value={r.id} />
											<button
												class="press flex h-full w-[88px] flex-col items-center justify-center gap-1 text-[13px] font-semibold"
												style="background: var(--approve); color: var(--paper)"
											>
												<Play class="h-4 w-4" /> Resume
											</button>
										</form>
									{/if}
									<form
										method="POST"
										action="?/end"
										use:submit={{
											confirm: 'End this recurring charge? It stops generating new purchases.',
											success: 'Recurring charge ended'
										}}
										class="contents"
									>
										<input type="hidden" name="ruleId" value={r.id} />
										<button
											class="press flex h-full w-[88px] flex-col items-center justify-center gap-1 text-[13px] font-semibold"
											style="background: var(--deny); color: var(--paper)"
										>
											<OctagonX class="h-4 w-4" /> End
										</button>
									</form>
								</div>
							{/if}
							<div
								data-swipe-content
								class="relative z-10 px-4 py-3.5"
								style="background: var(--surface); touch-action: pan-y"
							>
								<div class="flex items-center justify-between gap-3">
									<div class="min-w-0">
										<p class="flex items-center gap-1.5 text-[16px]" style="color: var(--ink)">
											{r.itemName}
											{#if r.status === 'paused'}
												<span class="chip" style="color: var(--ink-3); background: var(--surface-2)"
													>Paused</span
												>
											{/if}
										</p>
										<p class="mt-0.5 text-[13px]" style="color: var(--ink-3)">
											{r.cadence} · next {fmtNext(r.nextAt)}{r.autoComplete
												? ''
												: ' · needs confirming'}{r.bucketName ? ` · ${r.bucketName}` : ''}
										</p>
									</div>
									<div class="shrink-0 text-right">
										<Money
											minor={r.amountMinor}
											currency={r.currency}
											block
											class="text-[16px] font-semibold"
										/>
										{#if perMonth(r)}
											<span class="num text-[12px]" style="color: var(--ink-3)">{perMonth(r)}</span>
										{/if}
									</div>
								</div>
								{#if r.mine}
									<div class="mt-2.5 flex items-center gap-4 text-[13px]">
										{#if r.status === 'active'}
											<form method="POST" action="?/pause" use:submit={{ success: 'Paused' }}>
												<input type="hidden" name="ruleId" value={r.id} />
												<button
													class="press inline-flex items-center gap-1"
													style="color: var(--ink-3)"
												>
													<Pause class="h-3.5 w-3.5" /> Pause
												</button>
											</form>
										{:else}
											<form method="POST" action="?/resume" use:submit={{ success: 'Resumed' }}>
												<input type="hidden" name="ruleId" value={r.id} />
												<button
													class="press inline-flex items-center gap-1"
													style="color: var(--approve)"
												>
													<Play class="h-3.5 w-3.5" /> Resume
												</button>
											</form>
										{/if}
										<button
											onclick={() => startEdit(r)}
											class="press inline-flex items-center gap-1"
											style="color: var(--ink-2)"
										>
											<Pencil class="h-3.5 w-3.5" /> Edit
										</button>
										<form
											method="POST"
											action="?/end"
											use:submit={{
												confirm: 'End this recurring charge? It stops generating new purchases.',
												success: 'Recurring charge ended'
											}}
											class="ml-auto"
										>
											<input type="hidden" name="ruleId" value={r.id} />
											<button class="press" style="color: var(--deny)">End</button>
										</form>
									</div>
								{/if}
							</div>

							{#if r.mine}
								{#if editing === r.id}
									<form
										method="POST"
										action="?/edit"
										use:submit={{ success: 'Changes saved', onSuccess: () => (editing = null) }}
										class="mt-3 space-y-3 rounded-[14px] p-4"
										style="background: var(--surface-2)"
									>
										<input type="hidden" name="ruleId" value={r.id} />
										<div class="grid grid-cols-[1fr_auto] gap-3">
											<input
												name="itemName"
												required
												value={r.itemName}
												class="field text-[16px]"
											/>
											<input
												name="amount"
												required
												use:money
												inputmode="decimal"
												value={(Number(r.amountMinor) / 100).toFixed(2)}
												class="field w-28 text-[16px] tabular-nums"
											/>
										</div>
										<RecurrencePicker
											bind:freq={editFreq}
											bind:interval={editInterval}
											bind:weekDays={editWeekDays}
											bind:monthDay={editMonthDay}
											bind:startDate={editStart}
										/>
										<select name="categoryId" class="field text-[16px]">
											<option value="">Other (no category)</option>
											{#each data.categories as c (c.id)}
												<option value={c.id} selected={c.id === r.categoryId}
													>{c.icon} {c.name}</option
												>
											{/each}
										</select>
										{#if data.buckets.length > 0 || r.bucketId}
											<select name="bucketId" class="field text-[16px]">
												<option value="">Not charged to a bucket</option>
												{#each data.buckets as b (b.id)}
													<option value={b.id} selected={b.id === r.bucketId}>{b.name}</option>
												{/each}
												<!-- The rule's bucket is paused/archived: keep it attached
												     unless the owner picks something else. -->
												{#if r.bucketId && !data.buckets.some((b) => b.id === r.bucketId)}
													<option value={r.bucketId} selected
														>{r.bucketName ?? 'Current bucket'}</option
													>
												{/if}
											</select>
										{/if}
										<CheckField
											name="autoComplete"
											bind:checked={editAutoComplete}
											label="It's the same amount every time"
											hint={editAutoComplete
												? 'Recorded for you on the day, at this amount.'
												: 'Each charge waits for you to enter what you were actually billed.'}
										/>
										<div class="flex gap-2">
											<button class="btn btn-accent flex-1 py-2.5 text-[14px]">Save changes</button>
											<button
												type="button"
												onclick={() => (editing = null)}
												class="btn btn-ghost flex-1 py-2.5 text-[14px]">Cancel</button
											>
										</div>
									</form>
								{/if}
							{/if}
						</div>
					{/each}
				</div>
			</div>
		{/each}
	{/if}

	{#if data.past.length > 0}
		<!--
			Ended rules, folded away instead of removed. The Income page's past
			section works the same way: it is the list wanted least often, so it
			opens on request and says how much is in there before you ask.
		-->
		<button
			onclick={togglePast}
			class="press flex w-full items-center justify-between px-1 py-1"
			aria-expanded={showPast}
		>
			<span class="section-label">Ended</span>
			<span class="flex items-center gap-1 text-[13px]" style="color: var(--ink-3)">
				{data.past.length}
				<ChevronDown
					class="h-4 w-4 transition-transform duration-200 {showPast ? 'rotate-180' : ''}"
				/>
			</span>
		</button>
		{#if showPast}
			<div
				class="card overflow-hidden"
				transition:slide={{ duration: prefersReducedMotion.current ? 0 : 180 }}
			>
				{#each data.past as r, i (r.id)}
					{@const swipeable = r.mine && restarting !== r.id}
					{@const charges = `${r.chargeCount} ${r.chargeCount === 1 ? 'charge' : 'charges'}`}
					<!--
						Built by joining the parts that exist. A rule ended by any released
						version carries an ended_at (endRule has always written one), but a
						row without it should drop the clause instead of printing a stray
						separator.
					-->
					{@const meta = [
						r.cadence,
						r.endedAt ? `ended ${fmtEnded(r.endedAt)}` : null,
						r.chargeCount ? charges : 'never charged'
					]
						.filter(Boolean)
						.join(' · ')}
					<div
						class="relative overflow-hidden {i < data.past.length - 1 ? 'hairline' : ''}"
						use:swipe={{ width: swipeable ? 88 : 0, enabled: swipeable }}
					>
						{#if swipeable}
							<div class="absolute inset-y-0 right-0 z-0 flex">
								<form
									method="POST"
									action="?/remove"
									use:submit={{
										confirm: {
											title: 'Delete this record?',
											body: r.chargeCount
												? `The ${charges} it made stay in the Ledger. This cannot be undone.`
												: 'This cannot be undone.',
											confirmLabel: 'Delete',
											tone: 'danger'
										},
										success: 'Deleted'
									}}
									class="contents"
								>
									<input type="hidden" name="ruleId" value={r.id} />
									<button
										class="press flex h-full w-[88px] flex-col items-center justify-center gap-1 text-[13px] font-semibold"
										style="background: var(--deny); color: var(--paper)"
									>
										<Trash2 class="h-4 w-4" /> Delete
									</button>
								</form>
							</div>
						{/if}
						<div
							data-swipe-content
							class="relative z-10 px-4 py-3.5"
							style="background: var(--surface); touch-action: pan-y"
						>
							<div class="flex items-center justify-between gap-3">
								<div class="min-w-0">
									<!--
										Quieter than a live row, because ink lightens as it matters
										less. It stops at ink-3: ink-4 sits below the readable
										contrast floor and is for chevrons and rules, not words.
									-->
									<p class="text-[16px]" style="color: var(--ink-2)">{r.itemName}</p>
									<p class="mt-0.5 text-[13px]" style="color: var(--ink-3)">
										{meta}
									</p>
								</div>
								<!-- Same two slots an active row uses, one word changed in each:
								     the standing price, and what it came to in the end. -->
								<div class="shrink-0 text-right" style="color: var(--ink-2)">
									<Money minor={r.amountMinor} currency={r.currency} block class="text-[16px]" />
									{#if r.chargeCount > 0}
										<span class="num text-[12px]" style="color: var(--ink-3)">
											{formatMinor(r.lifetimeMinor, r.currency)} total
										</span>
									{/if}
								</div>
							</div>
							{#if r.mine}
								<div class="mt-2.5 flex items-center gap-4 text-[13px]">
									<button
										onclick={() => startRestart(r)}
										class="press inline-flex items-center gap-1"
										style="color: var(--ink-2)"
									>
										<RotateCcw class="h-3.5 w-3.5" /> Start again
									</button>
									<form
										method="POST"
										action="?/remove"
										use:submit={{
											confirm: {
												title: 'Delete this record?',
												body: r.chargeCount
													? `The ${charges} it made stay in the Ledger. This cannot be undone.`
													: 'This cannot be undone.',
												confirmLabel: 'Delete',
												tone: 'danger'
											},
											success: 'Deleted'
										}}
										class="ml-auto"
									>
										<input type="hidden" name="ruleId" value={r.id} />
										<button class="press" style="color: var(--deny)">Delete</button>
									</form>
								</div>
							{/if}
						</div>

						{#if r.mine && restarting === r.id}
							<!--
								The edit form, reached from a different door. A price or a billing
								day has usually moved by the time you want something back, so this
								asks. The rule it ended on may no longer be the going rate.
								There is no backfill option: the months it sat ended are a real
								gap, and filling them in would invent spending nobody did.
							-->
							<form
								method="POST"
								action="?/restart"
								use:submit={{ success: 'Started again', onSuccess: () => (restarting = null) }}
								class="mt-3 space-y-3 rounded-[14px] p-4"
								style="background: var(--surface-2)"
							>
								<input type="hidden" name="ruleId" value={r.id} />
								<div class="grid grid-cols-[1fr_auto] gap-3">
									<input name="itemName" required value={r.itemName} class="field text-[16px]" />
									<input
										name="amount"
										required
										use:money
										inputmode="decimal"
										value={(Number(r.amountMinor) / 100).toFixed(2)}
										class="field w-28 text-[16px] tabular-nums"
									/>
								</div>
								<RecurrencePicker
									bind:freq={restartFreq}
									bind:interval={restartInterval}
									bind:weekDays={restartWeekDays}
									bind:monthDay={restartMonthDay}
									bind:startDate={restartStart}
								/>
								<select name="categoryId" class="field text-[16px]">
									<option value="">Other (no category)</option>
									{#each data.categories as c (c.id)}
										<option value={c.id} selected={c.id === r.categoryId}>{c.icon} {c.name}</option>
									{/each}
								</select>
								{#if data.buckets.length > 0 || r.bucketId}
									<select name="bucketId" class="field text-[16px]">
										<option value="">Not charged to a bucket</option>
										{#each data.buckets as b (b.id)}
											<option value={b.id} selected={b.id === r.bucketId}>{b.name}</option>
										{/each}
										<!-- The bucket it used to charge is paused or archived. Keep it
										     on offer, and let createRule's own check refuse it. -->
										{#if r.bucketId && !data.buckets.some((b) => b.id === r.bucketId)}
											<option value={r.bucketId} selected
												>{r.bucketName ?? 'Previous bucket'}</option
											>
										{/if}
									</select>
								{/if}
								<CheckField
									name="autoComplete"
									bind:checked={restartAutoComplete}
									label="It's the same amount every time"
									hint={restartAutoComplete
										? 'Recorded for you on the day, at this amount.'
										: 'Each charge waits for you to enter what you were actually billed.'}
								/>
								<div class="flex gap-2">
									<button class="btn btn-accent flex-1 py-2.5 text-[14px]">Start again</button>
									<button
										type="button"
										onclick={() => (restarting = null)}
										class="btn btn-ghost flex-1 py-2.5 text-[14px]">Cancel</button
									>
								</div>
							</form>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	{/if}
</div>
