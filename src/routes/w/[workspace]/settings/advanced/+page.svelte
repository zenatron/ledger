<script lang="ts">
	import { untrack } from 'svelte';
	import { submit } from '$lib/actions/submit';
	import { page } from '$app/state';
	import {
		Bell,
		Calendar,
		ChevronLeft,
		CircleAlert,
		Clock,
		RefreshCw,
		ShieldCheck
	} from '@lucide/svelte';
	import Toggle from '$lib/components/Toggle.svelte';

	let { data, form } = $props();
	let slug = $derived(page.params.workspace);
	const owner = $derived(data.isOwner);

	// Seeded once, deliberately: this is the draft being edited, and the effect
	// below re-seeds it only after a save.
	let weekStartDay = $state(untrack(() => data.weekStartDay));

	// Re-sync from server only after a successful save — never during ordinary
	// interaction where the local value is what the user is editing.
	$effect(() => {
		if (!form?.ok) return;
		weekStartDay = data.weekStartDay;
	});
</script>

<div class="mx-auto max-w-lg space-y-4">
	<a
		href="/w/{slug}"
		class="press -ml-1 inline-flex items-center gap-0.5 text-[15px]"
		style="color: var(--ink-3)"
	>
		<ChevronLeft class="h-4 w-4" /> Settings
	</a>
	<h1 class="px-1 text-[28px]">Advanced</h1>

	<form method="POST" action="?/save" use:submit={{ success: 'Settings saved' }} class="space-y-4">
		<!-- Timing -->
		<section class="card p-5">
			<h2
				class="flex items-center gap-2 font-[family-name:var(--font-sans)] text-[16px] font-semibold tracking-normal"
				style="color: var(--ink)"
			>
				<Clock class="h-4 w-4" style="color: var(--ws-accent)" /> Timing
			</h2>
			<p class="mt-1 text-[13px] leading-relaxed" style="color: var(--ink-3)">
				Controls how long things sit before the workspace nudges someone, and how long invitations
				and deletions remain possible.
			</p>

			<div class="mt-4 space-y-4">
				<div class="grid grid-cols-2 gap-4">
					<label class="block">
						<span class="section-label mb-1.5 block">Stale after</span>
						<div class="flex items-center gap-2">
							<input
								name="staleAfterHours"
								type="number"
								min="1"
								max="720"
								value={data.staleAfterHours}
								disabled={!owner}
								class="field text-[16px]"
							/>
							<span class="shrink-0 text-[13px]" style="color: var(--ink-3)">hours</span>
						</div>
						<span class="mt-1 block text-[12px]" style="color: var(--ink-3)">
							How long before nudging an approver.
						</span>
					</label>

					<label class="block">
						<span class="section-label mb-1.5 block">Delete window</span>
						<div class="flex items-center gap-2">
							<input
								name="recentDeleteHours"
								type="number"
								min="0"
								max="720"
								value={data.recentDeleteHours}
								disabled={!owner}
								class="field text-[16px]"
							/>
							<span class="shrink-0 text-[13px]" style="color: var(--ink-3)">hours</span>
						</div>
						<span class="mt-1 block text-[12px]" style="color: var(--ink-3)">
							0 means only the owner can remove entries.
						</span>
					</label>
				</div>

				<div class="grid grid-cols-2 gap-4">
					<label class="block">
						<span class="section-label mb-1.5 block">Invite expires after</span>
						<div class="flex items-center gap-2">
							<input
								name="inviteTtlDays"
								type="number"
								min="1"
								max="90"
								value={data.inviteTtlDays}
								disabled={!owner}
								class="field text-[16px]"
							/>
							<span class="shrink-0 text-[13px]" style="color: var(--ink-3)">days</span>
						</div>
					</label>

					<label class="block">
						<span class="section-label mb-1.5 block">Max nudges</span>
						<div class="flex items-center gap-2">
							<input
								name="maxNudges"
								type="number"
								min="0"
								max="20"
								value={data.maxNudges}
								disabled={!owner}
								class="field text-[16px]"
							/>
							<span class="shrink-0 text-[13px]" style="color: var(--ink-3)">pings</span>
						</div>
						<span class="mt-1 block text-[12px]" style="color: var(--ink-3)">
							0 means never nudge.
						</span>
					</label>
				</div>
			</div>
		</section>

		<!-- Approval -->
		<section class="card p-5">
			<h2
				class="flex items-center gap-2 font-[family-name:var(--font-sans)] text-[16px] font-semibold tracking-normal"
				style="color: var(--ink)"
			>
				<ShieldCheck class="h-4 w-4" style="color: var(--ws-accent)" /> Approval
			</h2>
			<p class="mt-1 text-[13px] leading-relaxed" style="color: var(--ink-3)">
				Thresholds and defaults that decide when a purchase needs approval and how long sealed gifts
				stay hidden.
			</p>

			<div class="mt-4 grid grid-cols-2 gap-4">
				<label class="block">
					<span class="section-label mb-1.5 block">Ask again above</span>
					<div class="flex items-center gap-2">
						<input
							name="reapprovalThresholdPct"
							type="number"
							min="0"
							max="100"
							value={data.reapprovalThresholdPct}
							disabled={!owner}
							class="field text-[16px]"
						/>
						<span class="shrink-0 text-[13px]" style="color: var(--ink-3)">%</span>
					</div>
					<span class="mt-1 block text-[12px]" style="color: var(--ink-3)">
						% over the approved amount that sends a purchase back.
					</span>
				</label>

				<label class="block">
					<span class="section-label mb-1.5 block">Max seal days</span>
					<div class="flex items-center gap-2">
						<input
							name="maxSealDays"
							type="number"
							min="1"
							max="365"
							value={data.maxSealDays}
							disabled={!owner}
							class="field text-[16px]"
						/>
						<span class="shrink-0 text-[13px]" style="color: var(--ink-3)">days</span>
					</div>
					<span class="mt-1 block text-[12px]" style="color: var(--ink-3)">
						Longest a gift can stay hidden.
					</span>
				</label>
			</div>

			<div class="mt-5 flex items-start justify-between gap-4">
				<div>
					<p class="text-[15px] font-medium" style="color: var(--ink)">Settle up</p>
					<p class="text-[13px]" style="color: var(--ink-3)">
						Show "who owes whom" on Activity, splitting the period's spending into fair shares.
						Households that keep separate money have no use for it.
					</p>
				</div>
				{#if owner}
					<Toggle on={data.settleUpEnabled} flag="settleUpEnabled" label="Toggle settle up" />
				{:else}
					<span class="shrink-0 text-[13px]" style="color: var(--ink-3)">
						{data.settleUpEnabled ? 'Shown' : 'Hidden'}
					</span>
				{/if}
			</div>

			<div class="mt-5 flex items-start justify-between gap-4">
				<div>
					<p class="text-[15px] font-medium" style="color: var(--ink)">Bucket charges</p>
					<p class="text-[13px]" style="color: var(--ink-3)">
						Skip approval for purchases charged directly to a bucket.
					</p>
				</div>
				{#if owner}
					<Toggle
						on={data.bucketChargesSkipApproval}
						flag="bucketChargesSkipApproval"
						label="Toggle bucket charges skip approval"
					/>
				{:else}
					<span class="shrink-0 text-[13px]" style="color: var(--ink-3)">
						{data.bucketChargesSkipApproval ? 'Skip approval' : 'Need approval'}
					</span>
				{/if}
			</div>
		</section>

		<!-- Budgets & alerts -->
		<section class="card p-5">
			<h2
				class="flex items-center gap-2 font-[family-name:var(--font-sans)] text-[16px] font-semibold tracking-normal"
				style="color: var(--ink)"
			>
				<Bell class="h-4 w-4" style="color: var(--ws-accent)" /> Budgets &amp; alerts
			</h2>
			<p class="mt-1 text-[13px] leading-relaxed" style="color: var(--ink-3)">
				When to warn about overspending and how often to repeat the warning.
			</p>

			<div class="mt-4 grid grid-cols-2 gap-4">
				<label class="block">
					<span class="section-label mb-1.5 block">Budget alert at</span>
					<div class="flex items-center gap-2">
						<input
							name="budgetAlertPct"
							type="number"
							min="1"
							max="100"
							value={data.budgetAlertPct}
							disabled={!owner}
							class="field text-[16px]"
						/>
						<span class="shrink-0 text-[13px]" style="color: var(--ink-3)">%</span>
					</div>
					<span class="mt-1 block text-[12px]" style="color: var(--ink-3)">
						% of a budget spent before the first warning.
					</span>
				</label>

				<label class="block">
					<span class="section-label mb-1.5 block">Alert cooldown</span>
					<div class="flex items-center gap-2">
						<input
							name="budgetAlertCooldownHours"
							type="number"
							min="1"
							max="720"
							value={data.budgetAlertCooldownHours}
							disabled={!owner}
							class="field text-[16px]"
						/>
						<span class="shrink-0 text-[13px]" style="color: var(--ink-3)">hours</span>
					</div>
					<span class="mt-1 block text-[12px]" style="color: var(--ink-3)">
						Minimum time between re-alerts for the same budget.
					</span>
				</label>
			</div>
		</section>

		<!-- Recurring -->
		<section class="card p-5">
			<h2
				class="flex items-center gap-2 font-[family-name:var(--font-sans)] text-[16px] font-semibold tracking-normal"
				style="color: var(--ink)"
			>
				<RefreshCw class="h-4 w-4" style="color: var(--ws-accent)" /> Recurring
			</h2>
			<p class="mt-1 text-[13px] leading-relaxed" style="color: var(--ink-3)">
				How many missed recurring charges to generate after the workspace comes back online.
			</p>

			<label class="mt-4 block">
				<span class="section-label mb-1.5 block">Catch-up max</span>
				<div class="flex items-center gap-2">
					<input
						name="recurringCatchupMax"
						type="number"
						min="1"
						max="500"
						value={data.recurringCatchupMax}
						disabled={!owner}
						class="field w-28 text-[16px]"
					/>
					<span class="text-[13px]" style="color: var(--ink-3)">occurrences</span>
				</div>
				<span class="mt-1 block text-[12px]" style="color: var(--ink-3)">
					Higher means a bigger catch-up on return.
				</span>
			</label>
		</section>

		<!-- Display -->
		<section class="card p-5">
			<h2
				class="flex items-center gap-2 font-[family-name:var(--font-sans)] text-[16px] font-semibold tracking-normal"
				style="color: var(--ink)"
			>
				<Calendar class="h-4 w-4" style="color: var(--ws-accent)" /> Display
			</h2>
			<p class="mt-1 text-[13px] leading-relaxed" style="color: var(--ink-3)">
				How dates and weeks are laid out across the workspace.
			</p>

			<label class="mt-4 block">
				<span class="section-label mb-1.5 block">First day of week</span>
				<select
					name="weekStartDay"
					bind:value={weekStartDay}
					disabled={!owner}
					class="field mt-1 w-full text-[16px]"
				>
					{#each data.weekDays as d (d.value)}
						<option value={d.value}>{d.label}</option>
					{/each}
				</select>
				<span class="mt-1 block text-[12px]" style="color: var(--ink-3)">
					Used for weekly views and period boundaries.
				</span>
			</label>

			{#if form && 'error' in form && form.error}
				<p class="mt-4 flex items-center gap-1.5 text-[13px]" style="color: var(--deny)">
					<CircleAlert class="h-4 w-4" />
					{form.error}
				</p>
			{/if}

			{#if owner}
				<button class="btn btn-accent mt-4 px-4 py-2 text-[14px]">Save</button>
			{:else}
				<p class="mt-4 text-[13px]" style="color: var(--ink-3)">
					Only the workspace owner can change these settings.
				</p>
			{/if}
		</section>
	</form>
</div>
