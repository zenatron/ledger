<script lang="ts">
	import { submit } from '$lib/actions/submit';
	import { swipe } from '$lib/actions/swipe';
	import { page } from '$app/state';
	import { money } from '$lib/actions/money';
	import { ArrowUpRight, ChevronDown, CircleHelp, Pencil, Trash2, Wallet } from '@lucide/svelte';
	import { slide } from 'svelte/transition';
	import Money from '$lib/components/Money.svelte';
	import { minorToDecimalInput } from '$lib/money-format';
	import IncomeSchedule from '$lib/components/IncomeSchedule.svelte';
	import { calDateInZone } from '$lib/domain/time/zoned';
	let { data, form } = $props();
	let slug = $derived(page.params.workspace);
	let showNew = $state(false);
	// Today in the *workspace* timezone. toISOString() is UTC, so after ~8pm in
	// the Americas these forms defaulted to tomorrow's date.
	const today = $derived.by(() => {
		const t = calDateInZone(new Date(), data.workspace.timezone);
		return `${t.y}-${String(t.m).padStart(2, '0')}-${String(t.d).padStart(2, '0')}`;
	});

	// New-entry schedule. `today` seeds the defaults and the user edits from
	// there; the page remounts per workspace so the snapshot can't go stale.
	let repeat = $state('once');
	// svelte-ignore state_referenced_locally
	let date = $state(today);
	let monthDay = $state('1');

	// Only one entry is open for editing at a time, so single slots suffice.
	let editing: string | null = $state(null);
	let editRepeatVal = $state('once');
	// svelte-ignore state_referenced_locally
	let editDate = $state(today);
	let editMonthDay = $state('1');

	function fmtDate(iso: string): string {
		return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}

	/*
	 * Two lists, because they answer different questions.
	 *
	 * What's live — the monthly templates and any one-off still ahead — is what
	 * you came to check, and it was getting pushed off the screen by every
	 * one-off ever recorded. Those stay, below, because deleting history is not
	 * the fix; they just stop competing for the top of the page.
	 *
	 * Recurring first inside the live list: a template describes every month,
	 * where a dated entry describes one. Past runs most-recent first, which is
	 * the order you look for something you half-remember.
	 */
	const current = $derived(
		data.entries
			.filter((e) => !e.past)
			.slice()
			.sort((a, b) => {
				if (a.recurring !== b.recurring) return a.recurring ? -1 : 1;
				return a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0;
			})
	);
	const past = $derived(
		data.entries
			.filter((e) => e.past)
			.slice()
			.sort((a, b) => (a.receivedAt > b.receivedAt ? -1 : a.receivedAt < b.receivedAt ? 1 : 0))
	);
	let showPast = $state(false);

	function startEdit(e: (typeof data.entries)[number]) {
		editing = editing === e.id ? null : e.id;
		if (editing === null) return;
		editRepeatVal = e.freq === 'monthly' ? 'monthly' : 'once';
		editDate = e.receivedDate;
		editMonthDay = String(e.monthDay ?? 1);
	}
</script>

<!--
	One row definition, rendered into both lists. Splitting the page into
	"coming up" and "already received" is a sort, not two different things,
	so the row must not fork with it.

	Swipe parity with the ledger, as a second affordance rather than a
	replacement: the inline Edit/Remove stay for the pointer, and a left swipe on
	your own row reveals a full-height Remove. The reveal (and the gesture) stand
	down while the row is expanded into its edit form — sliding a form out from
	under someone typing in it is not a feature.
-->
{#snippet entryRow(e: (typeof data.entries)[number], last: boolean)}
	{@const swipeable = e.mine && editing !== e.id}
	<div
		class="relative overflow-hidden {last ? '' : 'hairline'}"
		use:swipe={{ width: swipeable ? 116 : 0, enabled: swipeable }}
	>
		{#if swipeable}
			<div class="absolute inset-y-0 right-0 z-0 flex">
				<form
					method="POST"
					action="?/remove"
					use:submit={{ confirm: 'Remove this income entry?', success: 'Income removed' }}
					class="contents"
				>
					<input type="hidden" name="incomeId" value={e.id} />
					<button
						class="press flex h-full w-[116px] flex-col items-center justify-center gap-1 text-[13px] font-semibold"
						style="background: var(--deny); color: var(--paper)"
					>
						<Trash2 class="h-4 w-4" /> Remove
					</button>
				</form>
			</div>
		{/if}
		<div
			data-swipe-content
			class="relative z-10 flex items-center gap-3 px-4 py-3.5"
			style="background: var(--surface); touch-action: pan-y"
		>
			<span
				class="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px]"
				style="background: color-mix(in oklab, var(--approve) 18%, transparent)"
			>
				<ArrowUpRight class="h-4 w-4" style="color: var(--approve)" />
			</span>
			<div class="min-w-0 flex-1">
				<p class="text-[16px]" style="color: var(--ink)">{e.source}</p>
				<p class="text-[13px]" style="color: var(--ink-3)">
					{e.memberName} · {e.cadence ?? fmtDate(e.receivedAt)}
				</p>
			</div>
			<span style="color: var(--approve)">
				<Money minor={e.amountMinor} currency={e.currency} sign class="text-[16px] font-semibold" />
			</span>
			{#if e.mine}
				<button
					onclick={() => startEdit(e)}
					class="press ml-1 inline-flex items-center gap-1"
					style="color: var(--ink-2)"
					aria-label="Edit"
				>
					<Pencil class="h-3.5 w-3.5" />
				</button>
				<form
					method="POST"
					action="?/remove"
					use:submit={{ confirm: 'Remove this income entry?', success: 'Income removed' }}
				>
					<input type="hidden" name="incomeId" value={e.id} />
					<button class="press ml-0.5" style="color: var(--ink-3)" aria-label="Remove">
						<Trash2 class="h-4 w-4" />
					</button>
				</form>
			{/if}
		</div>
		{#if editing === e.id}
			<form
				method="POST"
				action="?/edit"
				use:submit={{ success: 'Changes saved', onSuccess: () => (editing = null) }}
				class="mt-3 space-y-3 rounded-[14px] p-4"
				style="background: var(--surface-2)"
			>
				<input type="hidden" name="incomeId" value={e.id} />
				<div class="grid grid-cols-[1fr_auto] gap-3">
					<input
						name="source"
						required
						value={e.source}
						aria-label="Source"
						class="field text-[16px]"
					/>
					<input
						name="amount"
						required
						use:money
						inputmode="decimal"
						value={minorToDecimalInput(e.amountMinor, e.currency)}
						aria-label="Amount"
						class="field w-28 text-[16px] tabular-nums"
					/>
				</div>
				<IncomeSchedule
					bind:repeat={editRepeatVal}
					bind:date={editDate}
					bind:monthDay={editMonthDay}
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
	</div>
{/snippet}

<div class="space-y-4">
	<div class="flex items-center justify-between px-1 pt-1">
		<h1 class="text-[28px]">Income</h1>
		<button
			onclick={() => (showNew = !showNew)}
			class="btn {showNew ? 'btn-ghost' : 'btn-tint'} px-4 py-2 text-[14px]"
		>
			{showNew ? 'Cancel' : 'Add income'}
		</button>
	</div>

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
			action="?/add"
			use:submit={{ success: 'Income added', onSuccess: () => (showNew = false) }}
			class="card space-y-3.5 p-5"
		>
			<div class="grid grid-cols-[1fr_auto] gap-3">
				<input
					name="source"
					required
					placeholder="Salary"
					aria-label="Source"
					class="field text-[16px]"
				/>
				<input
					name="amount"
					required
					use:money
					inputmode="decimal"
					placeholder="3200.00"
					aria-label="Amount"
					class="field w-32 text-[16px] tabular-nums"
				/>
			</div>
			<IncomeSchedule bind:repeat bind:date bind:monthDay />

			<button class="btn btn-accent w-full">Add income</button>
		</form>
	{/if}

	{#if data.entries.length === 0}
		<div class="card-lg card px-6 py-16 text-center">
			<div
				class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl"
				style="background: color-mix(in oklab, var(--approve) 16%, var(--surface-2))"
			>
				<Wallet class="h-7 w-7" style="color: var(--approve)" />
			</div>
			<p class="text-[18px] font-semibold" style="color: var(--ink)">No income yet</p>
			<p class="mx-auto mt-1 max-w-[30ch] text-[15px] leading-relaxed" style="color: var(--ink-3)">
				Add what comes in and Ledger can work out what's free to spend.
			</p>
			<a
				href="/w/{slug}/settings/help?s=income"
				class="press mt-4 inline-flex items-center gap-1.5 text-[14px] font-medium"
				style="color: var(--accent-ink)"
			>
				<CircleHelp class="h-4 w-4" /> How this works
			</a>
		</div>
	{:else}
		{#if current.length > 0}
			<div class="card overflow-hidden">
				{#each current as e, i (e.id)}
					{@render entryRow(e, i === current.length - 1)}
				{/each}
			</div>
		{:else}
			<!-- Everything on file has already been received. Worth saying, because
			     an empty top section otherwise reads as a page that failed to load. -->
			<p class="card px-4 py-5 text-center text-[15px]" style="color: var(--ink-3)">
				Nothing coming up. Past income is below.
			</p>
		{/if}

		<!--
			History, folded away rather than removed. It is the longest list on the
			page and the least often wanted, so it opens on request and says how
			much is in there before you ask for it.
		-->
		{#if past.length > 0}
			<button
				onclick={() => (showPast = !showPast)}
				class="press flex w-full items-center justify-between px-1 py-1"
				aria-expanded={showPast}
			>
				<span class="section-label">Past income</span>
				<span class="flex items-center gap-1 text-[13px]" style="color: var(--ink-3)">
					{past.length}
					<ChevronDown
						class="h-4 w-4 transition-transform duration-200 {showPast ? 'rotate-180' : ''}"
					/>
				</span>
			</button>
			{#if showPast}
				<div class="card overflow-hidden" transition:slide={{ duration: 180 }}>
					{#each past as e, i (e.id)}
						{@render entryRow(e, i === past.length - 1)}
					{/each}
				</div>
			{/if}
		{/if}
	{/if}
</div>
