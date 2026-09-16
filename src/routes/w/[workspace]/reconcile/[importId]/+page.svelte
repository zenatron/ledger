<script lang="ts">
	import { page } from '$app/state';
	import { submit } from '$lib/actions/submit';
	import { dismiss } from '$lib/actions/dismiss';
	import { modal } from '$lib/actions/modal';
	import { formatMinor } from '$lib/money-format';
	import { fade, scale } from 'svelte/transition';
	import { Check, ChevronLeft, EyeOff, Link2, Plus, Sparkles, Undo2, X } from '@lucide/svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let slug = $derived(page.params.workspace);

	/** The line whose "link by hand" picker is open, if any. */
	let linking = $state<string | null>(null);
	let linkQuery = $state('');

	/*
	 * "Help me find this": the optional model's only role in reconciliation.
	 *
	 * It reads the bank's shorthand — the thing the deterministic matcher can't,
	 * because a descriptor shares no whole words with "flat white" — and picks one
	 * of the candidates we already computed. What it produces is a *highlight in a
	 * list the person is reading anyway*. Nothing is written, nothing is
	 * preselected into a form, and the Link button below is still the only thing
	 * that links. A wrong answer costs a glance.
	 */
	let asking = $state<string | null>(null);
	let suggestedId = $state<string | null>(null);
	/** Shown when the model was asked and declined, so the button isn't a no-op. */
	let suggestMissed = $state(false);

	const lines = $derived(data.lines);
	const currency = $derived(data.currency);

	/*
	 * The review is counted work, so the header states where it stands. `private`
	 * lines count as settled: they're accounted for by something the viewer can't
	 * see, and there's nothing further for them to do about it — leaving them in
	 * "to review" would mean the count could never reach zero.
	 */
	const settled = $derived(
		lines.filter(
			(l) =>
				l.matchState === 'confirmed' || l.matchState === 'ignored' || l.matchState === 'private'
		)
	);
	const proposed = $derived(lines.filter((l) => l.matchState === 'matched'));
	const open = $derived(lines.filter((l) => l.matchState === 'unmatched'));
	const remaining = $derived(proposed.length + open.length);

	function fmtDay(iso: string): string {
		return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}
	function fmtDateLong(iso: string): string {
		return new Date(iso).toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		});
	}

	const periodLabel = $derived(
		data.import.periodStart && data.import.periodEnd
			? `${fmtDay(data.import.periodStart)} – ${fmtDay(data.import.periodEnd)}`
			: data.import.filename
	);

	/**
	 * Candidates narrowed by the picker's search box, best-dated first — except
	 * that a model's suggestion floats to the top so it doesn't have to be hunted
	 * for. It is only ever moved and labelled, never auto-selected: the list is
	 * still the whole list, in the same order, with one row lifted out of it.
	 */
	const linkCandidates = $derived.by(() => {
		const q = linkQuery.trim().toLowerCase();
		const all = [...data.candidates].sort((a, b) => b.completedAt.localeCompare(a.completedAt));
		const matching = !q
			? all
			: all.filter(
					(c) =>
						c.itemName.toLowerCase().includes(q) || (c.merchantName ?? '').toLowerCase().includes(q)
				);
		const lifted = suggestedId ? matching.filter((c) => c.id === suggestedId) : [];
		return [...lifted, ...matching.filter((c) => c.id !== suggestedId)].slice(0, 40);
	});

	function openLinker(lineId: string) {
		linking = lineId;
		linkQuery = '';
		suggestedId = null;
		suggestMissed = false;
	}

	/**
	 * Ask the model, then open the picker either way. Opening regardless is the
	 * point: the button promises help finding a purchase, and a full searchable
	 * list is help even when the model had nothing to say. Any failure — off,
	 * offline, timed out, abstained — lands in the same place as a miss.
	 */
	async function askForHelp(lineId: string) {
		asking = lineId;
		let picked: string | null = null;
		try {
			const res = await fetch(`/w/${slug}/reconcile/${data.import.id}/suggest`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ lineId })
			});
			if (res.ok) picked = ((await res.json()) as { purchaseId: string | null }).purchaseId;
		} catch {
			// Nothing to report: the picker below is the fallback, and it's the same
			// picker the "Link a purchase" button opens.
		}
		asking = null;
		linking = lineId;
		linkQuery = '';
		suggestedId = picked;
		suggestMissed = picked === null;
	}

	/**
	 * "Log this" hands the line to the new-purchase screen through the same
	 * `?describe=` door the Harmony palette uses — it arrives parsed into an
	 * editable form rather than silently created.
	 */
	function describeFor(l: (typeof lines)[number]): string {
		const amount = formatMinor(l.amountMinor < 0n ? -l.amountMinor : l.amountMinor, l.currency);
		return `${amount} at ${l.rawDescription} on ${fmtDateLong(l.postedAt)}`;
	}
</script>

<svelte:head><title>{periodLabel} · Reconcile · Ledger</title></svelte:head>

{#snippet stateChip(label: string, colorVar: string)}
	<span
		class="chip"
		style="color: var({colorVar}); background: color-mix(in oklab, var({colorVar}) 14%, transparent)"
		>{label}</span
	>
{/snippet}

{#snippet lineRow(l: (typeof lines)[number], last: boolean)}
	<div class="py-3.5 {last ? '' : 'hairline'}">
		<!-- The statement's own words, and its amount, always the top line: this is
		     the thing being explained, so it reads first. -->
		<div class="flex items-baseline justify-between gap-3">
			<div class="min-w-0 flex-1">
				<p class="truncate text-[15px] font-medium" style="color: var(--ink)">
					{l.rawDescription}
				</p>
				<p class="num mt-0.5 text-[13px]" style="color: var(--ink-3)">{fmtDay(l.postedAt)}</p>
			</div>
			<span class="num shrink-0 text-[15px] font-semibold" style="color: var(--ink)">
				{formatMinor(l.amountMinor < 0n ? -l.amountMinor : l.amountMinor, l.currency)}
			</span>
		</div>

		{#if l.matchState === 'private'}
			<!--
				Accounted for by a purchase this person can't see. It says that much and
				no more: no item, no merchant, no member, no link to follow. Without the
				line, an unexplained row invites someone to log a duplicate of a gift
				they're not meant to know about — which is the louder disclosure.
			-->
			<p class="mt-2 flex items-center gap-1.5 text-[13px]" style="color: var(--seal)">
				<EyeOff class="h-3.5 w-3.5 shrink-0" />
				<span>Accounted for, hidden from you</span>
			</p>
		{:else if l.purchase}
			<div class="mt-2 flex items-center gap-2.5">
				<a
					href="/w/{slug}/purchases/{l.purchase.id}"
					class="press flex min-w-0 flex-1 items-center gap-2 rounded-[10px] px-2.5 py-2"
					style="background: var(--surface-2)"
				>
					{#if l.purchase.categoryIcon}<span class="shrink-0">{l.purchase.categoryIcon}</span>{/if}
					<span class="min-w-0 flex-1 truncate text-[14px]" style="color: var(--ink-2)">
						{l.purchase.itemName}{l.purchase.merchantName ? ` · ${l.purchase.merchantName}` : ''}
					</span>
					<!--
						The reason is shown only when the evidence is *thin*. A match on
						amount, date and description needs no caption: the bank's words and
						the item name are sitting next to each other on this very row, so
						the caption only restated what you can already see — and repeated
						down 25 rows it became wallpaper, which is how a real warning gets
						missed. A match on amount and date alone is the one worth a second
						look, so that is the one that speaks.
					-->
					{#if l.matchReason && l.matchReason !== 'amount, date and description'}
						<span class="shrink-0 text-[12px]" style="color: var(--pending)">{l.matchReason}</span>
					{/if}
				</a>
			</div>
			<div class="mt-2 flex flex-wrap items-center gap-2">
				{#if l.matchState === 'confirmed'}
					{@render stateChip('Cleared', '--approve')}
					<form method="POST" action="?/unlink" use:submit={{ success: 'Match undone' }}>
						<input type="hidden" name="lineId" value={l.id} />
						<button class="press flex items-center gap-1.5 text-[13px]" style="color: var(--ink-3)">
							<Undo2 class="h-3.5 w-3.5" /> Undo
						</button>
					</form>
				{:else}
					<form method="POST" action="?/confirm" use:submit={{ success: 'Cleared' }}>
						<input type="hidden" name="lineId" value={l.id} />
						<button class="btn btn-accent px-3.5 py-1.5 text-[13px]">
							<Check class="h-3.5 w-3.5" /> That's it
						</button>
					</form>
					<form method="POST" action="?/unlink" use:submit={{ success: 'Match removed' }}>
						<input type="hidden" name="lineId" value={l.id} />
						<button class="press flex items-center gap-1.5 text-[13px]" style="color: var(--ink-3)">
							<X class="h-3.5 w-3.5" /> Not this
						</button>
					</form>
				{/if}
			</div>
		{:else if l.matchState === 'ignored'}
			<div class="mt-2 flex items-center gap-3">
				{@render stateChip('Set aside', '--ink-4')}
				<form method="POST" action="?/unignore" use:submit={{ success: 'Back in review' }}>
					<input type="hidden" name="lineId" value={l.id} />
					<button class="press flex items-center gap-1.5 text-[13px]" style="color: var(--ink-3)">
						<Undo2 class="h-3.5 w-3.5" /> Put back
					</button>
				</form>
			</div>
		{:else}
			<!--
				The matcher wouldn't claim this line, but it did rank what was in range
				— close on amount and date, just not decisively enough to auto-match,
				or beaten to its purchase by a stronger line. That ranking used to be
				thrown away and the person got a blank search box for a question we had
				already half-answered.

				So it is offered here, best first, as a shortlist rather than a verdict:
				"Did you mean" states plainly that this is a question, each row is one
				tap to link, and the full search below stays exactly where it was for
				when the answer isn't in the list. No model is involved — this is the
				same deterministic scoring that produced the matches above.
			-->
			{#if l.suggestions.length > 0}
				<p class="mt-2.5 text-[13px]" style="color: var(--ink-3)">Did you mean</p>
				<div class="mt-1 flex flex-col gap-1.5">
					{#each l.suggestions as s (s.id)}
						<form method="POST" action="?/link" use:submit={{ success: 'Linked' }} class="contents">
							<input type="hidden" name="lineId" value={l.id} />
							<input type="hidden" name="purchaseId" value={s.id} />
							<button
								class="press flex w-full items-center gap-2 rounded-[10px] px-2.5 py-2 text-left"
								style="background: var(--surface-2)"
							>
								{#if s.categoryIcon}<span class="shrink-0">{s.categoryIcon}</span>{/if}
								<span class="min-w-0 flex-1">
									<span class="block truncate text-[14px]" style="color: var(--ink-2)">
										{s.itemName}{s.merchantName ? ` · ${s.merchantName}` : ''}
									</span>
									{#if s.completedAt}
										<span class="num mt-0.5 block text-[12px]" style="color: var(--ink-3)">
											{fmtDay(s.completedAt)}
										</span>
									{/if}
								</span>
								<span class="num shrink-0 text-[14px]" style="color: var(--ink-3)">
									{formatMinor(s.amountMinor, l.currency)}
								</span>
								<span class="shrink-0 text-[12px] font-medium" style="color: var(--accent)">
									Link
								</span>
							</button>
						</form>
					{/each}
				</div>
			{/if}

			<!-- Nothing here matches it. Three honest answers: it's this purchase,
			     it was never recorded, or it isn't a purchase at all. -->
			<div class="mt-2.5 flex flex-wrap items-center gap-2">
				<button
					onclick={() => openLinker(l.id)}
					class="btn btn-ghost px-3.5 py-1.5 text-[13px]"
					style="color: var(--ink-2)"
				>
					<Link2 class="h-3.5 w-3.5" /> Link a purchase
				</button>
				{#if data.assistAvailable}
					<!-- Offered only where it can help: a line with nothing on it, and
					     only when an assist is actually configured. -->
					<button
						onclick={() => askForHelp(l.id)}
						disabled={asking !== null}
						class="btn btn-ghost px-3.5 py-1.5 text-[13px]"
						style="color: var(--accent-ink)"
					>
						<Sparkles class="h-3.5 w-3.5" />
						{asking === l.id ? 'Looking…' : 'Help me find this'}
					</button>
				{/if}
				{#if !data.import.modelRead && l.amountMinor < 0n}
					<!-- The direct door: this line becomes a purchase, through the same
					     submission path a hand-logged one takes. Absent for model-read
					     imports by design — a transcribed figure must be retyped by a
					     person, not promoted into the ledger by a tap — and for lines
					     that are money in. -->
					<form method="POST" action="?/create" use:submit={{ success: 'Added to the ledger' }}>
						<input type="hidden" name="lineId" value={l.id} />
						<input type="hidden" name="itemName" value={l.rawDescription} />
						<button class="btn btn-ghost px-3.5 py-1.5 text-[13px]" style="color: var(--ink-2)">
							<Plus class="h-3.5 w-3.5" /> Add to ledger
						</button>
					</form>
				{/if}
				<a
					href="/w/{slug}/purchases/new?describe={encodeURIComponent(describeFor(l))}"
					class="btn btn-ghost px-3.5 py-1.5 text-[13px]"
					style="color: var(--ink-2)"
				>
					<Plus class="h-3.5 w-3.5" /> Log it
				</a>
				<form method="POST" action="?/ignore" use:submit={{ success: 'Set aside' }}>
					<input type="hidden" name="lineId" value={l.id} />
					<button
						class="press flex items-center gap-1.5 px-1 text-[13px]"
						style="color: var(--ink-3)"
					>
						Not a purchase
					</button>
				</form>
			</div>
		{/if}
	</div>
{/snippet}

<div class="mx-auto max-w-lg">
	<a
		href="/w/{slug}/reconcile"
		class="press mb-4 -ml-1 inline-flex items-center gap-0.5 text-[14px] font-medium"
		style="color: var(--ink-3)"
	>
		<ChevronLeft class="h-4 w-4" /> Statements
	</a>

	<!-- Editorial masthead, as elsewhere: the period as the headline, the state of
	     the work as the standfirst. -->
	<div class="px-1">
		<p class="section-label">Statement</p>
		<h1 class="mt-1 text-[28px]">{periodLabel}</h1>
		<p class="mt-2 text-[15px]" style="color: var(--ink-3)">
			{#if remaining === 0}
				All {data.import.lineCount}
				{data.import.lineCount === 1 ? 'line' : 'lines'} accounted for.
			{:else}
				<span class="num">{remaining}</span>
				of <span class="num">{data.import.lineCount}</span> still to account for.
			{/if}
		</p>
		<!--
			The session's own lifecycle. Closing is a statement — this period is
			reconciled, stop carrying it as open work — and it is deliberately soft:
			reopen is one tap, and any line put back in review reopens on its own.
		-->
		{#if data.import.closed}
			<div class="mt-3 flex items-center gap-2.5">
				<span
					class="chip"
					style="color: var(--approve); background: color-mix(in oklab, var(--approve) 14%, transparent)"
				>
					<Check class="h-3 w-3" /> Closed
				</span>
				<form method="POST" action="?/reopen" use:submit={{ success: 'Reopened' }}>
					<button class="press text-[13px] font-semibold" style="color: var(--ink-3)">
						Reopen
					</button>
				</form>
			</div>
		{:else if remaining === 0}
			<form
				method="POST"
				action="?/close"
				use:submit={{ success: 'Statement closed' }}
				class="mt-3"
			>
				<button class="btn btn-tint px-4 py-2 text-[14px]">
					<Check class="h-4 w-4" /> Close statement
				</button>
			</form>
		{/if}
	</div>

	<!--
		A standing notice, not a one-time toast. These figures were transcribed from
		a picture by a model, and every judgement on this screen — is this the right
		purchase, has this really cleared — is made against them. That is worth
		saying on the screen where the judgements happen, for as long as they are
		being made.
	-->
	{#if data.import.modelRead}
		<div
			class="card mt-4 flex items-start gap-2.5 p-3.5 text-[13px] leading-relaxed"
			style="background: color-mix(in oklab, var(--pending) 12%, var(--surface)); color: var(--ink-2)"
		>
			<Sparkles class="mt-0.5 h-4 w-4 shrink-0" style="color: var(--pending)" />
			<span>
				This statement was read from a picture. Check each amount against the statement before you
				clear it.
			</span>
		</div>
	{/if}

	{#if form?.error}
		<div
			class="card mt-4 p-4 text-[15px]"
			style="color: var(--deny); background: color-mix(in oklab, var(--deny) 12%, var(--surface))"
		>
			{form.error}
		</div>
	{/if}

	{#if proposed.length > 0}
		<!-- Green, like the APPROVED chip: these are found, they just need a nod. -->
		<div class="mt-7 mb-1 flex items-center justify-between px-1">
			<p class="section-label" style="color: var(--approve)">Looks like a match</p>
			<span
				class="chip num"
				style="color: var(--approve); background: color-mix(in oklab, var(--approve) 12%, transparent)"
				>{proposed.length}</span
			>
		</div>
		<div class="rule">
			{#each proposed as l, i (l.id)}
				{@render lineRow(l, i === proposed.length - 1)}
			{/each}
		</div>
	{/if}

	{#if open.length > 0}
		<div class="mt-7 mb-1 flex items-center justify-between px-1">
			<p class="section-label" style="color: var(--pending)">Nothing matched</p>
			<span
				class="chip num"
				style="color: var(--pending); background: color-mix(in oklab, var(--pending) 12%, transparent)"
				>{open.length}</span
			>
		</div>
		<div class="rule">
			{#each open as l, i (l.id)}
				{@render lineRow(l, i === open.length - 1)}
			{/each}
		</div>
	{/if}

	{#if settled.length > 0}
		<div class="mt-7 mb-1 flex items-center justify-between px-1">
			<p class="section-label">Accounted for</p>
			<span class="chip num" style="color: var(--ink-3); background: var(--surface-2)"
				>{settled.length}</span
			>
		</div>
		<div class="rule">
			{#each settled as l, i (l.id)}
				{@render lineRow(l, i === settled.length - 1)}
			{/each}
		</div>
	{/if}
</div>

{#if linking}
	{@const lineId = linking}
	<div
		class="fixed inset-0 z-50"
		style="background: var(--scrim)"
		use:dismiss={() => (linking = null)}
		transition:fade={{ duration: 140 }}
	></div>
	<div
		class="fixed inset-x-4 top-[10vh] z-50 mx-auto flex max-h-[80vh] max-w-md flex-col"
		role="dialog"
		aria-modal="true"
		aria-label="Link a purchase"
		tabindex="-1"
		use:modal
		transition:scale={{ start: 0.96, duration: 170 }}
	>
		<div
			class="card-lg flex min-h-0 flex-col overflow-hidden"
			style="box-shadow: var(--shadow-float); background: var(--surface)"
		>
			<div class="flex items-center justify-between px-5 pt-4 pb-3.5">
				<h2 class="font-[family-name:var(--font-display)] text-[22px]" style="color: var(--ink)">
					Link a purchase
				</h2>
				<button
					onclick={() => (linking = null)}
					class="press -mr-1 flex h-8 w-8 items-center justify-center rounded-full"
					style="color: var(--ink-3)"
					aria-label="Close"
				>
					<X class="h-4 w-4" />
				</button>
			</div>
			<div class="px-5 pb-3">
				<label>
					<span class="sr-only">Search purchases</span>
					<input bind:value={linkQuery} placeholder="Search purchases…" class="field text-[16px]" />
				</label>
				<!--
					Say plainly which of the two happened. A model that declined is far
					more common than one that guessed wrong, and silence after tapping
					"Help me find this" reads as a broken button rather than an honest
					"I don't know" — which is the answer we actually want it giving.
				-->
				{#if suggestedId}
					<p class="mt-2 flex items-start gap-1.5 text-[12.5px]" style="color: var(--ws-accent)">
						<Sparkles class="mt-0.5 h-3.5 w-3.5 shrink-0" />
						<span style="color: var(--ink-3)">
							A guess is at the top. Check it against the statement line before you link it.
						</span>
					</p>
				{:else if suggestMissed}
					<p class="mt-2 text-[12.5px]" style="color: var(--ink-3)">
						Nothing recognizable in that line. Here's everything in the period.
					</p>
				{/if}
			</div>
			<div class="h-px" style="background: var(--hairline)"></div>

			<div class="min-h-0 flex-1 overflow-y-auto px-5 py-2">
				{#if linkCandidates.length === 0}
					<p class="py-8 text-center text-[14px]" style="color: var(--ink-3)">
						{data.candidates.length === 0
							? 'Every purchase in this period is already matched.'
							: 'No purchases match that search.'}
					</p>
				{:else}
					{#each linkCandidates as c, i (c.id)}
						<form
							method="POST"
							action="?/link"
							use:submit={{ success: 'Linked', onSuccess: () => (linking = null) }}
						>
							<input type="hidden" name="lineId" value={lineId} />
							<input type="hidden" name="purchaseId" value={c.id} />
							<button
								class="press flex w-full items-center gap-3 py-3 text-left {i ===
								linkCandidates.length - 1
									? ''
									: 'hairline'}"
							>
								<span class="min-w-0 flex-1">
									<span class="flex items-center gap-1.5">
										<span class="truncate text-[15px]" style="color: var(--ink)">{c.itemName}</span>
										{#if c.id === suggestedId}
											<!-- Labelled, not styled-as-chosen: this row is a question. -->
											<span
												class="chip shrink-0"
												style="color: var(--accent-ink); background: color-mix(in oklab, var(--ws-accent) 14%, transparent)"
												>Guess</span
											>
										{/if}
									</span>
									<span class="mt-0.5 block truncate text-[13px]" style="color: var(--ink-3)">
										{c.merchantName ? `${c.merchantName} · ` : ''}{fmtDay(c.completedAt)}
									</span>
								</span>
								<span class="num shrink-0 text-[15px]" style="color: var(--ink-2)">
									{formatMinor(c.amountMinor, currency)}
								</span>
							</button>
						</form>
					{/each}
				{/if}
			</div>
		</div>
	</div>
{/if}
