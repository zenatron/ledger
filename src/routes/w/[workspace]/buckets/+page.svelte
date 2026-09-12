<script lang="ts">
	import { submit } from '$lib/actions/submit';
	import { swipe } from '$lib/actions/swipe';
	import { page } from '$app/state';
	import PlanTabs from '$lib/components/PlanTabs.svelte';
	import { money } from '$lib/actions/money';
	import { formatMinor, minorToDecimalInput, tryParseMinor } from '$lib/money-format';
	import { overdraftBy } from '$lib/domain/bucket/flows';
	import { formatPct } from '$lib/format';
	import { Archive, CircleHelp, Pause, Pencil, Play, Plus, Wallet } from '@lucide/svelte';
	import Money from '$lib/components/Money.svelte';
	import RecurrencePicker from '$lib/components/RecurrencePicker.svelte';
	import CheckField from '$lib/components/CheckField.svelte';
	import Segmented from '$lib/components/Segmented.svelte';
	import { describeChargeScope } from '$lib/domain/bucket/scope';
	import { calDateInZone } from '$lib/domain/time/zoned';
	import { ACCENTS, accentName } from '$lib/accent';

	let { data, form } = $props();
	let slug = $derived(page.params.workspace);

	let showNew = $state(false);
	let createColor = $state<string | null>(null);
	/*
	 * Who may charge to the bucket: 'anyone', 'only-me', or 'choose' plus the
	 * people picked. One slot each, like the color, because only one bucket is
	 * being created or edited at a time.
	 *
	 * The owner never appears in the list. They are always allowed, and a stored
	 * copy of that could only ever go out of sync with the row that owns it.
	 */
	let createScope = $state('anyone');
	let createPicked = $state<string[]>([]);
	let editScope = $state('anyone');
	let editPicked = $state<string[]>([]);

	const others = $derived(data.members.filter((m) => m.id !== data.viewerMemberId));
	const nameOf = (id: string) => data.members.find((m) => m.id === id)?.displayName ?? 'someone';

	const SCOPE_OPTIONS = [
		{ value: 'anyone', label: 'Anyone' },
		{ value: 'only-me', label: 'Only me' },
		{ value: 'choose', label: 'Pick people' }
	];

	/** The stored value read back as the control's three states. */
	function scopeOf(ids: string[] | null): string {
		if (ids === null) return 'anyone';
		return ids.length === 0 ? 'only-me' : 'choose';
	}

	const scopeLabel = (b: (typeof data.buckets)[number]) =>
		describeChargeScope(
			{ memberId: b.memberId, chargeMemberIds: b.chargeMemberIds },
			data.viewerMemberId,
			nameOf
		);
	let editing: string | null = $state(null);
	let editColor: Record<string, string | null> = $state({});
	let adjusting: string | null = $state(null);
	// The adjust form's two fields, bound so the overdraft warning can see what's
	// about to happen. Only one bucket adjusts at a time, so single slots.
	let adjustAmount = $state('');
	let adjustType = $state('withdrawal');

	// Bound straight into RecurrencePicker, which emits the same field names the
	// server already parses. Only one bucket is open for editing at a time, so
	// the edit fields are single slots rather than a map keyed by bucket id.
	let freq = $state('monthly');
	let interval = $state(1);
	let weekDays = $state<number[]>([]);
	let monthDay = $state('1');
	let editFreq = $state('monthly');
	let editInterval = $state(1);
	let editWeekDays = $state<number[]>([]);
	let editMonthDay = $state('1');
	let editStart = $state('');

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
	let backfill = $state(false);

	const overdrawn = $derived(data.buckets.filter((b) => b.balanceMinor < 0n));
	const overdrawnTotal = $derived(overdrawn.reduce((sum, b) => sum - b.balanceMinor, 0n));

	function colorFor(b: (typeof data.buckets)[number]): string {
		return b.color ?? 'var(--ws-accent)';
	}

	function fmtStart(d: string): string {
		const [y, m, day] = d.split('-').map(Number);
		return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString(undefined, {
			month: 'long',
			day: 'numeric',
			year: 'numeric',
			timeZone: 'UTC'
		});
	}

	/**
	 * "+$400.00 · every month on the 1st · next Aug 1" — the cadence comes from
	 * describeRecurrence on the stored rule, and the date is the actual
	 * next_accrual_at timestamp, so the sweep and the display agree exactly.
	 */
	function cadenceLine(b: (typeof data.buckets)[number]): string {
		const cadence = b.cadence ? b.cadence.charAt(0).toLowerCase() + b.cadence.slice(1) : '';
		const base = `+${formatMinor(b.amountMinor, b.currency)}${cadence ? ` · ${cadence}` : ''}`;
		const a = b.nextAccrualAt;
		if (!a) return base;
		const dueNow = new Date(a).getTime() <= Date.now();
		const when = dueNow
			? 'due now'
			: new Date(a).toLocaleDateString(undefined, {
					month: 'short',
					day: 'numeric',
					timeZone: 'UTC'
				});
		return `${base} · ${b.everAccrued ? 'next' : 'first'} ${when}`;
	}

	/**
	 * The friction on taking out money that isn't there. Nothing here can stop
	 * the charge — no real money moves either way, and refusing it would only
	 * make people lie to the app — so the modal names the shortfall, says what
	 * it will do to the balance, and lets them through.
	 */
	function overdraftConfirm(b: (typeof data.buckets)[number]) {
		if (adjustType !== 'withdrawal') return undefined;
		const minor = tryParseMinor(adjustAmount, b.currency);
		if (minor === null) return undefined;
		const short = overdraftBy(b.balanceMinor, minor);
		if (short === 0n) return undefined;
		return {
			title: `${b.name} doesn't have that`,
			body: `It holds ${formatMinor(b.balanceMinor, b.currency)}, and you're taking out ${formatMinor(minor, b.currency)}. That leaves it ${formatMinor(short, b.currency)} overdrawn, and the next accrual pays that back before it saves anything.`,
			confirmLabel: 'Take it out anyway',
			tone: 'danger' as const
		};
	}

	function resetAdjustForm() {
		adjusting = null;
		adjustAmount = '';
		adjustType = 'withdrawal';
	}

	function progressPct(b: (typeof data.buckets)[number]): number {
		if (!b.goalCapMinor || b.goalCapMinor <= 0n) return 0;
		const pct = Math.round((Number(b.balanceMinor) / Number(b.goalCapMinor)) * 100);
		return Math.max(0, Math.min(100, pct));
	}

	function startEdit(b: (typeof data.buckets)[number]) {
		editing = editing === b.id ? null : b.id;
		if (editing === null) return;
		editColor = { ...editColor, [b.id]: b.color };
		editScope = scopeOf(b.chargeMemberIds);
		editPicked = [...(b.chargeMemberIds ?? [])];
		editFreq = b.freq;
		editInterval = b.interval;
		editWeekDays = [...b.byDay];
		editMonthDay = String(b.monthDay ?? 1);
		editStart = b.startDate ?? today;
	}

	function resetNewForm() {
		showNew = false;
		createColor = null;
		createScope = 'anyone';
		createPicked = [];
		freq = 'monthly';
		interval = 1;
		weekDays = [];
		monthDay = '1';
		startDate = today;
		backfill = false;
	}
</script>

<div class="space-y-4">
	<PlanTabs />
	<div class="flex items-center justify-between px-1">
		<h1 class="text-[28px]">Buckets</h1>
		<button
			onclick={() => (showNew = !showNew)}
			class="btn {showNew ? 'btn-ghost' : 'btn-tint'} px-4 py-2 text-[14px]"
		>
			{showNew ? 'Cancel' : '+ New'}
		</button>
	</div>

	{#if data.buckets.length > 0}
		<!-- On hand = what's in the buckets now; Lifetime = gross ever set aside
		     (matches the Activity page's "Saved"). They diverge once money's spent. -->
		<div class="card flex items-stretch p-4">
			<div class="flex-1 text-center">
				<p class="section-label">On hand</p>
				<Money
					minor={data.onHandMinor}
					currency={data.currency}
					block
					class="num mt-1 text-[22px] font-semibold"
				/>
			</div>
			<div class="mx-2 w-px shrink-0" style="background: var(--hairline)"></div>
			<div class="flex-1 text-center">
				<p class="section-label">Lifetime saved</p>
				<Money
					minor={data.lifetimeSavedMinor}
					currency={data.currency}
					block
					class="num mt-1 text-[22px] font-semibold"
				/>
			</div>
		</div>
		<!-- On hand nets the overdrawn buckets out of the healthy ones, so it alone
		     would hide a hole. Name what's underwater instead of leaving the total
		     to quietly absorb it. -->
		{#if overdrawn.length > 0}
			<p class="px-1 text-[13px]" style="color: var(--pending)">
				{overdrawn.length === 1
					? `${overdrawn[0].name} is ${formatMinor(-overdrawn[0].balanceMinor, overdrawn[0].currency)} overdrawn`
					: `${overdrawn.length} buckets are overdrawn, ${formatMinor(overdrawnTotal, data.currency)} in total`}
			</p>
		{/if}
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
			use:submit={{ success: 'Bucket created', onSuccess: resetNewForm }}
			class="card space-y-3.5 p-5"
		>
			<div class="grid grid-cols-[1fr_auto] gap-3">
				<input
					name="name"
					required
					placeholder="Travel fund"
					aria-label="Bucket name"
					class="field text-[16px]"
				/>
				<input
					name="amount"
					required
					use:money
					inputmode="decimal"
					placeholder="500.00"
					aria-label="Amount to set aside"
					class="field w-28 text-[16px] tabular-nums"
				/>
			</div>
			<RecurrencePicker
				bind:freq
				bind:interval
				bind:weekDays
				bind:monthDay
				bind:startDate
				noun="accrual"
			/>
			<input
				name="goalCap"
				use:money
				inputmode="decimal"
				placeholder="Save up to…"
				aria-label="Goal, optional cap"
				class="field text-[16px]"
			/>
			<!--
				Only *does* anything when the start date is behind us, but it stays on
				screen either way — same as the recurring form. Disabled, it doubles as
				the instruction for enabling it, and a disabled input isn't submitted,
				so a stale tick can't leak through.
			-->
			<CheckField
				name="backfill"
				bind:checked={backfill}
				disabled={startDate >= today}
				label="Add the accruals I've already missed"
				hint={startDate < today
					? `Fills in every accrual since ${fmtStart(startDate)}.`
					: 'Set the start date in the past to fill in accruals you already missed.'}
			/>
			<div>
				<Segmented
					options={SCOPE_OPTIONS}
					bind:value={createScope}
					name="chargeScope"
					label="Who can charge this bucket"
					size="sm"
				/>
				{#if createScope === 'choose'}
					<div class="mt-2.5 flex flex-wrap gap-x-4 gap-y-2">
						{#each others as m (m.id)}
							<label class="flex items-center gap-1.5 text-[15px]" style="color: var(--ink)">
								<input
									type="checkbox"
									name="chargeMemberId"
									value={m.id}
									checked={createPicked.includes(m.id)}
									onchange={() =>
										(createPicked = createPicked.includes(m.id)
											? createPicked.filter((x) => x !== m.id)
											: [...createPicked, m.id])}
								/>
								{m.displayName}
							</label>
						{/each}
					</div>
				{/if}
				<p class="mt-1.5 text-[13px]" style="color: var(--ink-3)">
					{#if createScope === 'anyone'}
						Anyone in the workspace can charge a purchase to it.
					{:else}
						You can always charge it. Anyone left out loses it from their purchase form and from any
						recurring rule that charged it.
					{/if}
				</p>
			</div>
			<p class="text-[11px] font-medium tracking-[0.14em] uppercase" style="color: var(--ink-3)">
				Color
			</p>
			<div class="flex gap-2.5">
				{#each ACCENTS as c (c)}
					<button
						type="button"
						onclick={() => (createColor = createColor === c ? null : c)}
						class="press flex h-8 w-8 items-center justify-center rounded-full"
						style="background: {c}; box-shadow: {createColor === c
							? `0 0 0 2.5px var(--ink)`
							: `0 0 0 0px transparent`}"
						aria-label="Color {accentName(c)}"
					></button>
				{/each}
			</div>
			<input type="hidden" name="color" value={createColor ?? ''} />
			<button class="btn btn-accent w-full">Create bucket</button>
		</form>
	{/if}

	{#if data.buckets.length === 0}
		<div class="card-lg card px-6 py-16 text-center">
			<div
				class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl"
				style="background: color-mix(in oklab, var(--ws-accent) 16%, var(--surface-2))"
			>
				<Wallet class="h-7 w-7" style="color: var(--ws-accent)" />
			</div>
			<p class="text-[18px] font-semibold" style="color: var(--ink)">No buckets yet</p>
			<p class="mx-auto mt-1 max-w-[30ch] text-[15px] leading-relaxed" style="color: var(--ink-3)">
				Set money aside on a schedule for something specific, like a trip or an emergency fund.
			</p>
			<a
				href="/w/{slug}/settings/help?s=buckets"
				class="press mt-4 inline-flex items-center gap-1.5 text-[14px] font-medium"
				style="color: var(--accent-ink)"
			>
				<CircleHelp class="h-4 w-4" /> How this works
			</a>
		</div>
	{:else}
		<div class="card overflow-hidden">
			{#each data.buckets as b, i (b.id)}
				<!--
					Swipe parity with the ledger, as a second affordance: the inline
					actions stay, and a left swipe on your own row reveals the two state
					changes — Pause/Resume and Archive. Both stand down while the row is
					expanded into its edit or adjust form, for the same reason the form
					does: a thing you're typing in shouldn't slide.
				-->
				{@const expanded = editing === b.id || adjusting === b.id}
				{@const swipeable = b.mine && !expanded}
				<div
					class="relative overflow-hidden {i < data.buckets.length - 1 ? 'hairline' : ''}"
					use:swipe={{ width: swipeable ? 176 : 0, enabled: swipeable }}
				>
					{#if swipeable}
						<div class="absolute inset-y-0 right-0 z-0 flex">
							{#if b.status === 'active'}
								<form
									method="POST"
									action="?/pause"
									use:submit={{ success: 'Paused' }}
									class="contents"
								>
									<input type="hidden" name="bucketId" value={b.id} />
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
									<input type="hidden" name="bucketId" value={b.id} />
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
								action="?/archive"
								use:submit={{
									confirm:
										'Archive this bucket? Its balance and history stay, but it stops accruing.',
									success: 'Bucket archived'
								}}
								class="contents"
							>
								<input type="hidden" name="bucketId" value={b.id} />
								<button
									class="press flex h-full w-[88px] flex-col items-center justify-center gap-1 text-[13px] font-semibold"
									style="background: var(--deny); color: var(--paper)"
								>
									<Archive class="h-4 w-4" /> Archive
								</button>
							</form>
						</div>
					{/if}
					<div
						data-swipe-content
						class="relative z-10 px-4 py-3.5"
						style="background: var(--surface); touch-action: pan-y"
					>
						<div class="flex items-center gap-3">
							<div
								class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
								style="background: color-mix(in oklab, {colorFor(b)} 20%, transparent)"
							>
								<div class="h-4 w-4 rounded-full" style="background: {colorFor(b)}"></div>
							</div>
							<div class="min-w-0 flex-1">
								<p class="flex items-center gap-1.5 text-[16px]" style="color: var(--ink)">
									{b.name}
									{#if b.status === 'paused'}
										<span class="chip" style="color: var(--ink-3); background: var(--surface-2)"
											>Paused</span
										>
									{/if}
									{#if scopeLabel(b)}
										<!-- Says why a bucket you can see is missing from your
									     purchase form, which is otherwise silent about it. An
									     unrestricted bucket says nothing, so the restricted ones
									     are the ones that stand out. -->
										<span class="chip" style="color: var(--ink-3); background: var(--surface-2)"
											>{scopeLabel(b)}</span
										>
									{/if}
									{#if b.balanceMinor < 0n}
										<!-- Overdrawn: more has been charged here than was ever set
									     aside. Named on the row rather than left to a minus sign,
									     because the next accrual pays this off before it saves
									     anything. -->
										<span
											class="chip"
											style="color: var(--pending); background: color-mix(in oklab, var(--pending) 14%, transparent)"
											>Overdrawn</span
										>
									{/if}
								</p>
								<p class="text-[13px]" style="color: var(--ink-3)">{cadenceLine(b)}</p>
							</div>
							<span
								class="shrink-0 text-[16px] font-semibold"
								style="color: {b.balanceMinor < 0n ? 'var(--pending)' : 'var(--ink)'}"
							>
								<Money
									minor={b.balanceMinor}
									currency={b.currency}
									class="text-[16px] font-semibold"
								/>
							</span>
						</div>

						{#if b.goalCapMinor && b.goalCapMinor > 0n}
							<div
								class="mt-2 h-1.5 overflow-hidden rounded-full"
								style="background: var(--surface-2)"
							>
								<div
									class="h-full rounded-full transition-all"
									style="width: {progressPct(b)}%; background: {colorFor(b)}"
								></div>
							</div>
							<div class="mt-1 flex justify-between text-[11px]" style="color: var(--ink-3)">
								<span>{formatPct(progressPct(b))} of {formatMinor(b.goalCapMinor, b.currency)}</span
								>
								<span>{b.memberName}</span>
							</div>
						{/if}

						{#if b.mine}
							<div class="mt-2.5 flex items-center gap-4 text-[13px]">
								<button
									onclick={() => startEdit(b)}
									class="press inline-flex items-center gap-1"
									style="color: var(--ink-2)"
								>
									<Pencil class="h-3.5 w-3.5" /> Edit
								</button>
								{#if b.status === 'active'}
									<form method="POST" action="?/pause" use:submit={{ success: 'Paused' }}>
										<input type="hidden" name="bucketId" value={b.id} />
										<button
											class="press inline-flex items-center gap-1"
											style="color: var(--ink-3)"
										>
											<Pause class="h-3.5 w-3.5" /> Pause
										</button>
									</form>
								{:else}
									<form method="POST" action="?/resume" use:submit={{ success: 'Resumed' }}>
										<input type="hidden" name="bucketId" value={b.id} />
										<button
											class="press inline-flex items-center gap-1"
											style="color: var(--approve)"
										>
											<Play class="h-3.5 w-3.5" /> Resume
										</button>
									</form>
								{/if}
								<button
									onclick={() => {
										const open = adjusting === b.id;
										resetAdjustForm();
										if (!open) adjusting = b.id;
									}}
									class="press inline-flex items-center gap-1"
									style="color: var(--ink-2)"
								>
									<Plus class="h-3.5 w-3.5" /> Adjust
								</button>
								<form
									method="POST"
									action="?/archive"
									use:submit={{
										confirm:
											'Archive this bucket? Its balance and history stay, but it stops accruing.',
										success: 'Bucket archived'
									}}
									class="ml-auto"
								>
									<input type="hidden" name="bucketId" value={b.id} />
									<button class="press" style="color: var(--deny)">Archive</button>
								</form>
							</div>
						{/if}
					</div>

					{#if b.mine}
						{#if editing === b.id}
							{@const ec = editColor[b.id]}
							<form
								method="POST"
								action="?/edit"
								use:submit={{ success: 'Changes saved', onSuccess: () => (editing = null) }}
								class="mt-3 space-y-3 rounded-[14px] p-4"
								style="background: var(--surface-2)"
							>
								<input type="hidden" name="bucketId" value={b.id} />
								<div class="grid grid-cols-[1fr_auto] gap-3">
									<input
										name="name"
										required
										value={b.name}
										aria-label="Bucket name"
										class="field text-[16px]"
									/>
									<input
										name="amount"
										required
										use:money
										inputmode="decimal"
										value={minorToDecimalInput(b.amountMinor, b.currency)}
										aria-label="Amount each month"
										class="field w-28 text-[16px] tabular-nums"
									/>
								</div>
								<RecurrencePicker
									bind:freq={editFreq}
									bind:interval={editInterval}
									bind:weekDays={editWeekDays}
									bind:monthDay={editMonthDay}
									bind:startDate={editStart}
									noun="accrual"
								/>
								<input
									name="goalCap"
									use:money
									inputmode="decimal"
									value={b.goalCapMinor !== null
										? minorToDecimalInput(b.goalCapMinor, b.currency)
										: ''}
									placeholder="Save up to…"
									aria-label="Goal, optional cap"
									class="field text-[16px]"
								/>
								<div>
									<Segmented
										options={SCOPE_OPTIONS}
										bind:value={editScope}
										name="chargeScope"
										label="Who can charge this bucket"
										size="sm"
									/>
									{#if editScope === 'choose'}
										<div class="mt-2.5 flex flex-wrap gap-x-4 gap-y-2">
											{#each others as m (m.id)}
												<label
													class="flex items-center gap-1.5 text-[15px]"
													style="color: var(--ink)"
												>
													<input
														type="checkbox"
														name="chargeMemberId"
														value={m.id}
														checked={editPicked.includes(m.id)}
														onchange={() =>
															(editPicked = editPicked.includes(m.id)
																? editPicked.filter((x) => x !== m.id)
																: [...editPicked, m.id])}
													/>
													{m.displayName}
												</label>
											{/each}
										</div>
									{/if}
								</div>
								<p
									class="text-[11px] font-medium tracking-[0.14em] uppercase"
									style="color: var(--ink-3)"
								>
									Color
								</p>
								<div class="flex gap-2.5">
									{#each ACCENTS as c (c)}
										<button
											type="button"
											onclick={() => {
												editColor = { ...editColor, [b.id]: ec === c ? null : c };
											}}
											class="press flex h-8 w-8 items-center justify-center rounded-full"
											style="background: {c}; box-shadow: {ec === c
												? `0 0 0 2.5px var(--ink)`
												: `0 0 0 0px transparent`}"
											aria-label="Color {accentName(c)}"
										></button>
									{/each}
								</div>
								<input type="hidden" name="color" value={ec ?? ''} />
								<div class="flex gap-2">
									<button class="btn btn-accent flex-1 py-2.5 text-[14px]">Save</button>
									<button
										type="button"
										onclick={() => (editing = null)}
										class="btn btn-ghost flex-1 py-2.5 text-[14px]">Cancel</button
									>
								</div>
							</form>
						{/if}

						{#if adjusting === b.id}
							<form
								method="POST"
								action="?/adjust"
								use:submit={{
									confirm: overdraftConfirm(b),
									success: 'Bucket updated',
									onSuccess: resetAdjustForm
								}}
								class="mt-3 space-y-3 rounded-[14px] p-4"
								style="background: var(--surface-2)"
							>
								<input type="hidden" name="bucketId" value={b.id} />
								<div class="grid grid-cols-[1fr_auto] gap-3">
									<input
										name="amount"
										required
										use:money
										bind:value={adjustAmount}
										inputmode="decimal"
										placeholder={b.status === 'active' ? '50.00' : '500.00'}
										aria-label="Amount to move"
										class="field text-[16px]"
									/>
									<select name="type" bind:value={adjustType} class="field text-[16px]">
										<option value="withdrawal">Take money out</option>
										<option value="adjustment">Add money</option>
									</select>
								</div>
								<input
									name="note"
									placeholder="Optional note"
									aria-label="Optional note"
									class="field text-[16px]"
								/>
								<!-- Said before the modal too: a warning you only meet at the
								     final tap is a trap, not a warning. -->
								{#if overdraftConfirm(b)}
									<p class="text-[13px]" style="color: var(--pending)">
										That's more than this bucket holds.
									</p>
								{/if}
								<div class="flex gap-2">
									<button class="btn btn-accent flex-1 py-2.5 text-[14px]"> Save </button>
									<button
										type="button"
										onclick={resetAdjustForm}
										class="btn btn-ghost flex-1 py-2.5 text-[14px]">Cancel</button
									>
								</div>
							</form>
						{/if}
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
