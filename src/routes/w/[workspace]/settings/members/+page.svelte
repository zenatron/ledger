<script lang="ts">
	import { submit } from '$lib/actions/submit';
	import { dismiss } from '$lib/actions/dismiss';
	import { modal } from '$lib/actions/modal';
	import { page } from '$app/state';
	import { fade, scale } from 'svelte/transition';
	import {
		ChevronLeft,
		ChevronRight,
		Mail,
		PiggyBank,
		ShieldCheck,
		Users,
		X
	} from '@lucide/svelte';
	import { money } from '$lib/actions/money';
	import { formatMinor } from '$lib/money-format';

	let { data, form } = $props();
	let slug = $derived(page.params.workspace);
	let copied: string | null = $state(null);

	const roleLabel: Record<string, string> = { owner: 'Owner', member: 'Member' };

	type Member = (typeof data.members)[number];

	/*
	 * The member sheet. A row used to carry Allowance, Policy and Disable as three
	 * text buttons, which crowded a phone row and put a destructive action one
	 * mis-tap from an everyday one. Now the row is the button, and everything you
	 * can do about a person sits in one sheet, with Disable at the bottom, apart.
	 *
	 * Held by id, not by object, so the sheet reads the freshly loaded member
	 * after a save instead of the one it was opened with.
	 */
	let sheetId: string | null = $state(null);
	const sheet = $derived(sheetId ? (data.members.find((m) => m.id === sheetId) ?? null) : null);
	let editingPolicy = $state(false);

	function openSheet(m: Member) {
		sheetId = m.id;
		editingPolicy = false;
	}
	function closeSheet() {
		sheetId = null;
		editingPolicy = false;
	}

	/*
	 * Draft state for the policy editor. The fields depend on each other — a
	 * threshold only means something in "Above amount", approvers only when
	 * approval can be required — so the selects have to be bound rather than
	 * uncontrolled, or the form can't hide what doesn't apply.
	 */
	let mode = $state('none');
	let routingMode = $state('any_of');
	let approvers = $state<string[]>([]);
	let bucketCharges = $state('inherit');
	let bucketScope = $state('any');
	let threshold = $state('');

	const activeMembers = $derived(data.members.filter((m) => m.status === 'active'));
	/** Approvers only matter when something can actually need approving. */
	const canRequireApproval = $derived(mode !== 'none' || bucketCharges === 'require');

	function openPolicy(m: Member) {
		editingPolicy = true;
		mode = m.policy.mode;
		routingMode = m.policy.routing.mode;
		approvers = [...m.policy.routing.approver_ids];
		bucketCharges = m.policy.bucket_charges ?? 'inherit';
		bucketScope = m.policy.own_buckets_only ? 'own' : 'any';
		threshold =
			m.policy.threshold_minor !== undefined ? (m.policy.threshold_minor / 100).toFixed(2) : '';
	}

	const nameOf = (id: string) => data.members.find((m) => m.id === id)?.displayName ?? 'someone';

	/**
	 * The policy read back in a sentence, live, as you edit it.
	 *
	 * The controls describe the rule in pieces — a mode, a number, a routing
	 * choice, a list — and it is genuinely hard to tell from four widgets what
	 * combination you have just built. This is the one place that says it whole,
	 * which is also how you notice you meant the opposite.
	 */
	const preview = $derived.by(() => {
		const who = sheet ? sheet.displayName : 'They';
		const lines: string[] = [];

		if (mode === 'none') lines.push(`${who} can spend freely.`);
		else if (mode === 'always') lines.push(`Everything ${who} buys needs approval.`);
		else {
			const amt = threshold.trim();
			lines.push(
				amt
					? `${who} needs approval at ${symbol}${amt} and above.`
					: `${who} needs approval above an amount. Set it below.`
			);
		}

		if (bucketCharges === 'skip') {
			lines.push('Bucket charges never need approval.');
		} else if (bucketCharges === 'require') {
			lines.push('Bucket charges always need approval, even so.');
		} else if (data.workspaceSkipsBucketCharges) {
			lines.push('Bucket charges skip approval, following the workspace setting.');
		}

		if (bucketScope === 'own') {
			lines.push(`${who} can only charge to buckets they own.`);
			lines.push('Going past what a bucket holds needs approval.');
		}

		if (canRequireApproval) {
			if (approvers.length === 0) lines.push('Nobody can decide yet.');
			else if (routingMode === 'specific') lines.push(`Only ${nameOf(approvers[0])} can decide.`);
			else if (approvers.length === 1) lines.push(`${nameOf(approvers[0])} decides.`);
			else
				lines.push(
					`Any of ${approvers.slice(0, -1).map(nameOf).join(', ')} or ${nameOf(approvers.at(-1)!)} can decide.`
				);
		}
		return lines.join(' ');
	});

	const symbol = $derived(
		(0)
			.toLocaleString(undefined, { style: 'currency', currency: data.workspace.currency })
			.replace(/[\d.,\s]/g, '')
	);

	/*
	 * "One specific approver" is validated server-side as exactly one
	 * (domain/approval/policy.ts). Checkboxes let you tick three and only find
	 * out on save, so that mode swaps to radios and this keeps the selection
	 * legal as you switch between them.
	 */
	function toggleApprover(id: string) {
		if (routingMode === 'specific') {
			approvers = [id];
			return;
		}
		approvers = approvers.includes(id) ? approvers.filter((x) => x !== id) : [...approvers, id];
	}

	function onRoutingChange(next: string) {
		routingMode = next;
		if (next === 'specific' && approvers.length > 1) approvers = [approvers[0]];
	}

	function policySummary(p: { mode: string; threshold_minor?: number | null }) {
		if (p.mode === 'none') return 'No approval needed';
		if (p.mode === 'always') return 'Always needs approval';
		const minor = p.threshold_minor ?? 0;
		return `Approval above ${formatMinor(BigInt(minor), data.workspace.currency)}`;
	}

	/**
	 * What happens to this member's bucket-charged purchases specifically.
	 *
	 * States the effective outcome rather than the stored setting: "inherit" is
	 * true of the configuration, but what you want to know reading down a list is
	 * whether these get approved, and inherit alone doesn't answer that without
	 * you also remembering the workspace default.
	 */
	function bucketSummary(p: { bucket_charges?: string }) {
		const rule = p.bucket_charges ?? 'inherit';
		if (rule === 'require') return 'Buckets always need approval';
		if (rule === 'skip') return 'Buckets skip approval';
		return data.workspaceSkipsBucketCharges
			? 'Buckets skip approval, per the workspace'
			: 'Buckets follow the same rule';
	}

	async function copyCode(code: string) {
		try {
			await navigator.clipboard.writeText(code);
			copied = code;
			setTimeout(() => (copied = copied === code ? null : copied), 1400);
		} catch {
			/* clipboard may be unavailable */
		}
	}

	function expiresIn(iso: string) {
		const ms = new Date(iso).getTime() - Date.now();
		const days = Math.ceil(ms / 86_400_000);
		if (days <= 0) return 'Expired';
		return days === 1 ? 'Expires tomorrow' : `Expires in ${days} days`;
	}
</script>

<!-- What a row says about a person, whether or not it opens anything. -->
{#snippet memberSummary(m: Member)}
	{@const disabled = m.status === 'disabled'}
	<div class="min-w-0 flex-1 text-left" style={disabled ? 'opacity: 0.55' : ''}>
		<p class="flex flex-wrap items-center gap-x-2 text-[16px]" style="color: var(--ink)">
			{m.displayName}
			<span
				class="rounded-[var(--r-full)] px-2 py-0.5 text-[12px] font-medium"
				style="background: {m.role === 'owner'
					? 'color-mix(in oklab, var(--ws-accent) 14%, transparent)'
					: 'var(--surface-2)'}; color: {m.role === 'owner' ? 'var(--accent-ink)' : 'var(--ink-3)'}"
			>
				{roleLabel[m.role]}
			</span>
			{#if m.status !== 'active'}
				<span class="text-[13px]" style="color: var(--ink-3)">· {m.status}</span>
			{/if}
		</p>
		{#if disabled}
			<!-- A disabled member has no access, so their approval rules say
			     nothing about what can happen. Showing them would read as if
			     they were still in force. -->
			<p class="text-[13px]" style="color: var(--ink-3)">No access to this workspace</p>
		{:else}
			<p class="text-[13px]" style="color: var(--ink-3)">{policySummary(m.policy)}</p>
			{#if m.allowance}
				<!-- accent-ink, not --ws-accent: this is words. -->
				<p class="mt-0.5 text-[12px]" style="color: var(--accent-ink)">
					Allowance {formatMinor(m.allowance.amountMinor, data.workspace.currency)}
					{m.allowance.cadence.toLowerCase()} ·
					{formatMinor(m.allowance.balanceMinor, data.workspace.currency)} left
				</p>
			{/if}
		{/if}
	</div>
{/snippet}

<div class="mx-auto max-w-lg space-y-4">
	<a
		href="/w/{slug}"
		class="press -ml-1 inline-flex items-center gap-0.5 text-[15px]"
		style="color: var(--ink-3)"
	>
		<ChevronLeft class="h-4 w-4" /> Settings
	</a>
	<h1 class="px-1 text-[28px]">Members</h1>

	{#if form?.error && !sheet}
		<p class="card p-3 text-[14px]" style="color: var(--deny)">{form.error}</p>
	{/if}

	<div class="card p-5">
		<div class="flex items-center justify-between gap-3">
			<h2
				class="flex items-center gap-2 font-[family-name:var(--font-sans)] text-[16px] font-semibold tracking-normal"
				style="color: var(--ink)"
			>
				<Users class="h-4 w-4" style="color: var(--ws-accent)" /> People
			</h2>
			<span class="chip num" style="color: var(--ink-3); background: var(--surface-2)"
				>{data.members.length}</span
			>
		</div>
		<div class="mt-3">
			{#each data.members as m (m.id)}
				<!-- data-member scopes a row to one person for the e2e helpers. -->
				<div data-member={m.displayName} class="hairline last:shadow-none">
					{#if data.isOwner}
						<button
							onclick={() => openSheet(m)}
							class="press flex w-full items-center gap-3 py-3"
							aria-haspopup="dialog"
							aria-label="Manage {m.displayName}"
						>
							{@render memberSummary(m)}
							<ChevronRight class="h-4 w-4 shrink-0" style="color: var(--ink-3)" />
						</button>
					{:else}
						<div class="flex items-center gap-3 py-3">{@render memberSummary(m)}</div>
					{/if}
				</div>
			{/each}
		</div>
	</div>

	{#if data.isOwner}
		<div class="card p-5">
			<div class="flex items-center justify-between">
				<h2
					class="flex items-center gap-2 font-[family-name:var(--font-sans)] text-[16px] font-semibold tracking-normal"
					style="color: var(--ink)"
				>
					<Mail class="h-4 w-4" style="color: var(--ws-accent)" /> Invites
				</h2>
				<form method="POST" action="?/invite" use:submit={{ success: 'Invite created' }}>
					<!-- "+ New …", like every other add control in the app. -->
					<button class="btn btn-tint px-4 py-1.5 text-[13px]">+ New code</button>
				</form>
			</div>
			{#if data.invites.length === 0}
				<p class="mt-3 text-[15px]" style="color: var(--ink-3)">
					No open invites. Create a code to add someone.
				</p>
			{:else}
				<div class="mt-1">
					{#each data.invites as inv (inv.code)}
						<button
							onclick={() => copyCode(inv.code)}
							class="press hairline flex w-full items-center justify-between py-3 last:shadow-none"
						>
							<code class="font-mono text-[16px] tracking-[0.12em]" style="color: var(--ink)"
								>{inv.code}</code
							>
							<span
								class="text-[13px]"
								style="color: {copied === inv.code ? 'var(--approve)' : 'var(--ink-3)'}"
							>
								{copied === inv.code ? 'Copied ✓' : expiresIn(inv.expiresAt)}
							</span>
						</button>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>

{#if sheet && data.isOwner}
	{@const m = sheet}
	{@const disabled = m.status === 'disabled'}
	{@const self = m.id === data.viewerMemberId}
	<div
		class="fixed inset-0 z-50"
		style="background: var(--scrim)"
		use:dismiss={closeSheet}
		transition:fade={{ duration: 140 }}
	></div>
	<!-- Raised clear of the tab bar, which is fixed over every screen. -->
	<div
		class="fixed inset-x-4 z-50 mx-auto max-w-md"
		style="bottom: calc(env(safe-area-inset-bottom, 0px) + 84px)"
		role="dialog"
		aria-modal="true"
		aria-label={m.displayName}
		tabindex="-1"
		use:modal
		transition:scale={{ start: 0.96, duration: 170 }}
	>
		<div
			class="card-lg overflow-y-auto"
			style="box-shadow: var(--shadow-float); background: var(--surface); max-height: calc(100dvh - env(safe-area-inset-bottom, 0px) - 84px - 96px)"
		>
			<div class="flex items-start justify-between gap-3 px-5 pt-4 pb-1">
				<div class="min-w-0">
					<h2
						class="truncate font-[family-name:var(--font-display)] text-[22px]"
						style="color: var(--ink)"
					>
						{m.displayName}
					</h2>
					<p class="text-[13px]" style="color: var(--ink-3)">
						{roleLabel[m.role]}{disabled ? ' · no access' : ` · ${policySummary(m.policy)}`}
					</p>
				</div>
				<button
					onclick={closeSheet}
					class="press -mr-1 grid h-8 w-8 shrink-0 place-items-center rounded-full"
					style="color: var(--ink-3)"
					aria-label="Close"><X class="h-4 w-4" /></button
				>
			</div>

			{#if form?.error}
				<p class="mx-5 mt-2 text-[13px]" style="color: var(--deny)">{form.error}</p>
			{/if}

			<div class="px-5 pb-2">
				{#if !disabled}
					<!-- Role: the one line that says what they are, and the way to change it. -->
					<form
						method="POST"
						action="?/setMemberRole"
						use:submit={{
							success: m.role === 'owner' ? 'Now a member' : 'Now an owner',
							// Stepping yourself down is the one move you cannot undo alone.
							confirm:
								self && m.role === 'owner'
									? 'Give up owner access? Another owner would have to give it back.'
									: undefined
						}}
						class="hairline flex items-center justify-between gap-3 py-3"
					>
						<input type="hidden" name="memberId" value={m.id} />
						<span class="min-w-0">
							<span class="block text-[15px]" style="color: var(--ink)">Owner access</span>
							<span class="block text-[12px]" style="color: var(--ink-3)">
								{m.role === 'owner'
									? 'Can change settings, members and policies'
									: 'Can use the workspace, not manage it'}
							</span>
						</span>
						<button
							name="owner"
							value={m.role === 'owner' ? 'false' : 'true'}
							class="btn btn-ghost shrink-0 px-3.5 py-1.5 text-[13px]"
						>
							{m.role === 'owner' ? 'Make member' : 'Make owner'}
						</button>
					</form>

					<!-- Approval policy: summarized, then edited in place. -->
					<div class="hairline py-3">
						<button
							onclick={() => (editingPolicy ? (editingPolicy = false) : openPolicy(m))}
							class="press flex w-full items-center gap-3 text-left"
							aria-expanded={editingPolicy}
						>
							<ShieldCheck class="h-4 w-4 shrink-0" style="color: var(--ws-accent)" />
							<span class="min-w-0 flex-1">
								<span class="block text-[15px]" style="color: var(--ink)">Approval policy</span>
								<span class="block text-[12px]" style="color: var(--ink-3)">
									{policySummary(m.policy)} · {bucketSummary(m.policy)}
								</span>
							</span>
							<ChevronRight
								class="h-4 w-4 shrink-0 transition-transform duration-200 {editingPolicy
									? 'rotate-90'
									: ''}"
								style="color: var(--ink-3)"
							/>
						</button>

						{#if editingPolicy}
							<form
								method="POST"
								action="?/policy"
								use:submit={{ success: 'Policy updated', onSuccess: () => (editingPolicy = false) }}
								class="mt-3 space-y-3 rounded-[14px] p-4"
								style="background: var(--surface-2)"
							>
								<input type="hidden" name="memberId" value={m.id} />

								<!-- The rule in a sentence, updating as you edit. -->
								<p
									class="rounded-[10px] px-3 py-2.5 text-[13px] leading-relaxed"
									style="background: var(--surface); color: var(--ink-2)"
								>
									{preview}
								</p>

								<label class="block">
									<span class="section-label mb-1.5 block">When {m.displayName} spends</span>
									<select name="mode" bind:value={mode} class="field text-[16px]">
										<option value="none">Never needs approval</option>
										<option value="threshold">Needs approval above…</option>
										<option value="always">Always needs approval</option>
									</select>
								</label>

								<!-- Only for the mode that reads it: the server ignores the
								     threshold otherwise, so leaving it on screen showed an
								     editable field that quietly did nothing. -->
								{#if mode === 'threshold'}
									<label class="block">
										<span class="section-label mb-1.5 block">Above</span>
										<input
											name="threshold"
											aria-label="Threshold"
											bind:value={threshold}
											use:money
											inputmode="decimal"
											placeholder="50.00"
											class="field text-[16px] tabular-nums"
										/>
									</label>
								{/if}

								<label class="block">
									<span class="section-label mb-1.5 block">Bucket charges</span>
									<select name="bucketCharges" bind:value={bucketCharges} class="field text-[16px]">
										<option value="inherit"
											>Follow the workspace ({data.workspaceSkipsBucketCharges
												? 'skip approval'
												: 'needs approval'})</option
										>
										<option value="skip">Never need approval</option>
										<option value="require">Always need approval</option>
									</select>
								</label>

								<!-- "Only their own" stops them charging anyone else's bucket,
								     and takes the exemption above away for a charge bigger than
								     the bucket holds. -->
								<label class="block">
									<span class="section-label mb-1.5 block">Buckets they can charge</span>
									<select name="bucketScope" bind:value={bucketScope} class="field text-[16px]">
										<option value="any">Any bucket</option>
										<option value="own">Only their own</option>
									</select>
								</label>

								{#if canRequireApproval}
									<label class="block">
										<span class="section-label mb-1.5 block">Who decides</span>
										<select
											name="routingMode"
											value={routingMode}
											onchange={(e) => onRoutingChange(e.currentTarget.value)}
											class="field text-[16px]"
										>
											<option value="any_of">Any of these people</option>
											<option value="specific">One specific person</option>
										</select>
									</label>

									<div class="flex flex-wrap gap-x-4 gap-y-2">
										{#each activeMembers as a (a.id)}
											<label
												class="flex items-center gap-1.5 text-[15px]"
												style="color: var(--ink)"
											>
												<input
													type={routingMode === 'specific' ? 'radio' : 'checkbox'}
													name="approverIds"
													value={a.id}
													checked={approvers.includes(a.id)}
													onchange={() => toggleApprover(a.id)}
												/>
												{a.displayName}
											</label>
										{/each}
									</div>
									{#if approvers.length === 0}
										<p class="text-[13px]" style="color: var(--pending)">
											Pick at least one person who can decide.
										</p>
									{/if}
								{:else}
									<!-- Kept in the form so clearing approval doesn't silently
									     discard who used to be named on it. -->
									{#each approvers as id (id)}
										<input type="hidden" name="approverIds" value={id} />
									{/each}
								{/if}

								<button
									class="btn btn-accent w-full py-2.5 text-[15px] disabled:opacity-50"
									disabled={canRequireApproval && approvers.length === 0}
								>
									Save policy
								</button>
							</form>
						{/if}
					</div>

					<!-- Allowance: read here, managed where buckets are. -->
					<a
						href="/w/{slug}/buckets"
						class="press hairline flex items-center gap-3 py-3"
						onclick={closeSheet}
					>
						<PiggyBank class="h-4 w-4 shrink-0" style="color: var(--ws-accent)" />
						<span class="min-w-0 flex-1">
							<span class="block text-[15px]" style="color: var(--ink)">Allowance</span>
							<span class="block text-[12px]" style="color: var(--ink-3)">
								{#if m.allowance}
									{formatMinor(m.allowance.amountMinor, data.workspace.currency)}
									{m.allowance.cadence.toLowerCase()} ·
									{formatMinor(m.allowance.balanceMinor, data.workspace.currency)} left
								{:else}
									None. Set one up on Buckets
								{/if}
							</span>
						</span>
						<ChevronRight class="h-4 w-4 shrink-0" style="color: var(--ink-3)" />
					</a>
				{/if}

				<!--
					Apart from everything above, and last: the one action here that takes
					something away. Not offered for yourself — the server refuses it, and
					an action that can only fail shouldn't be on screen.
				-->
				{#if !self}
					<form
						method="POST"
						action="?/setMemberStatus"
						use:submit={{
							success: disabled ? 'Member restored' : 'Member disabled',
							confirm: disabled
								? undefined
								: `Disable ${m.displayName}? They lose access, but their history stays.`
						}}
						class="pt-3 pb-2"
					>
						<input type="hidden" name="memberId" value={m.id} />
						<button
							name="disabled"
							value={disabled ? 'false' : 'true'}
							class="press w-full rounded-[12px] py-2.5 text-[15px] font-medium"
							style="background: color-mix(in oklab, {disabled
								? 'var(--approve)'
								: 'var(--deny)'} 10%, transparent); color: {disabled
								? 'var(--approve)'
								: 'var(--deny)'}"
						>
							{disabled ? `Restore ${m.displayName}` : `Disable ${m.displayName}`}
						</button>
					</form>
				{/if}
			</div>
		</div>
	</div>
{/if}
