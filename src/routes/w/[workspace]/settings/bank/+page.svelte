<script lang="ts">
	import { submit } from '$lib/actions/submit';
	import { page } from '$app/state';
	import { formatMinor } from '$lib/money-format';
	import { AlertTriangle, Check, ChevronLeft, Landmark, Link2, RefreshCw } from '@lucide/svelte';

	let { data, form } = $props();
	let slug = $derived(page.params.workspace);

	function fmtWhen(iso: string | null) {
		if (!iso) return 'Not synced yet';
		return `Synced ${new Date(iso).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		})}`;
	}

	function plural(n: number, one: string, many = `${one}s`) {
		return `${n} ${n === 1 ? one : many}`;
	}

	/** One sentence for what the last "Sync now" did, quietest outcome first. */
	let syncSummary = $derived.by(() => {
		const r = form?.synced;
		if (!r) return null;
		if (r.added === 0) return 'Up to date. No new transactions.';
		const parts = [plural(r.added, 'new transaction')];
		if (r.cleared) parts.push(`${r.cleared} cleared`);
		if (r.completed)
			parts.push(`${r.completed} approved ${r.completed === 1 ? 'request' : 'requests'} completed`);
		if (r.toReview) parts.push(`${r.toReview} to review`);
		return parts.join(' · ');
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
	<h1 class="px-1 text-[28px]">Bank sync</h1>

	<div class="card p-4">
		<h2
			class="flex items-center gap-2 font-[family-name:var(--font-sans)] text-[16px] font-semibold tracking-normal"
			style="color: var(--ink)"
		>
			<Landmark class="h-4 w-4" style="color: var(--ws-accent)" /> How it works
		</h2>
		<p class="mt-1 text-[13px] leading-relaxed" style="color: var(--ink-3)">
			Posted transactions arrive through <strong>SimpleFIN Bridge</strong> every few hours and land in
			Reconcile, one statement per card per month. A charge that plainly matches a purchase already logged
			is cleared. One that pays for an approved request completes it at the charged amount, and goes back
			to the approver if it's over. Everything else waits for you there, with “Log this” a tap away.
		</p>
	</div>

	{#if !data.available}
		<div
			class="card p-4 text-[14px] leading-relaxed"
			style="background: color-mix(in oklab, var(--pending) 12%, var(--surface)); color: var(--ink-2)"
		>
			<p class="font-semibold" style="color: var(--pending)">Not available on this server</p>
			<p class="mt-1">
				Bank sync stores a credential that reads your bank history, so it only runs when the server
				can encrypt it. Set <code>SECRETS_KEY</code> (<code>openssl rand -base64 32</code>) and
				restart.
			</p>
		</div>
	{:else if !data.isOwner}
		<p class="card p-4 text-[14px]" style="color: var(--ink-3)">
			The workspace owner manages bank connections.
		</p>
	{/if}

	{#if form?.error}
		<div
			class="card p-4 text-[15px]"
			style="color: var(--deny); background: color-mix(in oklab, var(--deny) 12%, var(--surface))"
		>
			{form.error}
		</div>
	{/if}

	{#if syncSummary}
		<div
			class="card flex items-center gap-2 p-4 text-[14px]"
			style="background: color-mix(in oklab, var(--approve) 10%, var(--surface)); color: var(--ink-2)"
		>
			<Check class="h-4 w-4 shrink-0" style="color: var(--approve)" />
			<span class="flex-1">{syncSummary}</span>
			{#if form?.synced?.toReview}
				<a
					href="/w/{slug}/reconcile"
					class="text-[14px] font-medium"
					style="color: var(--ws-accent)">Review</a
				>
			{/if}
		</div>
	{/if}

	{#each data.connections as c (c.id)}
		<section class="card p-5">
			<div class="flex items-start gap-3">
				<div class="min-w-0 flex-1">
					<h2
						class="truncate font-[family-name:var(--font-sans)] text-[16px] font-semibold tracking-normal"
						style="color: var(--ink)"
					>
						{c.label}
					</h2>
					<p class="mt-0.5 text-[13px]" style="color: var(--ink-3)">{fmtWhen(c.lastSyncedAt)}</p>
				</div>
				{#if data.isOwner && data.available}
					<form method="POST" action="?/sync" use:submit={{ reset: false }}>
						<input type="hidden" name="connectionId" value={c.id} />
						<button class="btn btn-ghost flex items-center gap-1.5 px-3 py-2 text-[13px]">
							<RefreshCw class="h-3.5 w-3.5" /> Sync now
						</button>
					</form>
				{/if}
			</div>

			{#if c.lastError}
				<p
					class="mt-3 flex items-start gap-2 rounded-[10px] p-3 text-[13px] leading-relaxed"
					style="background: color-mix(in oklab, {c.status === 'error'
						? 'var(--deny)'
						: 'var(--pending)'} 10%, var(--surface)); color: var(--ink-2)"
				>
					<AlertTriangle
						class="mt-0.5 h-4 w-4 shrink-0"
						style="color: {c.status === 'error' ? 'var(--deny)' : 'var(--pending)'}"
					/>
					{c.lastError}
				</p>
			{/if}

			<div class="mt-3 overflow-hidden rounded-[10px]" style="background: var(--surface-2)">
				{#each c.accounts as a, i (a.id)}
					<div class="px-3.5 py-3 {i < c.accounts.length - 1 ? 'hairline' : ''}">
						<div class="flex items-baseline gap-2">
							<span
								class="min-w-0 flex-1 truncate text-[15px] font-medium"
								style="color: var(--ink)">{a.name}</span
							>
							{#if a.balanceMinor !== null}
								<span class="num text-[13px]" style="color: var(--ink-3)"
									>{formatMinor(BigInt(a.balanceMinor), a.currency)}</span
								>
							{/if}
						</div>
						{#if a.orgName}
							<p class="text-[12px]" style="color: var(--ink-3)">{a.orgName}</p>
						{/if}
						{#if a.currency !== data.currency}
							<p class="mt-1 text-[12px]" style="color: var(--ink-3)">
								In {a.currency}, so it can't feed this {data.currency} ledger.
							</p>
						{:else if data.isOwner && data.available}
							<form
								method="POST"
								action="?/link"
								use:submit={{ reset: false, success: 'Saved' }}
								class="mt-2 flex items-center gap-2"
							>
								<input type="hidden" name="feedAccountId" value={a.id} />
								<Link2 class="h-4 w-4 shrink-0" style="color: var(--ink-4)" />
								<select
									name="target"
									class="field flex-1 py-1.5 text-[16px]"
									value={a.accountId ?? ''}
									onchange={(e) => e.currentTarget.form?.requestSubmit()}
									aria-label="Which card {a.name} feeds"
								>
									<option value="">Don't sync</option>
									{#each data.accounts as acct (acct.id)}
										<option value={acct.id}>Feeds {acct.label}</option>
									{/each}
									<option value="new">Feeds a new card named “{a.name}”</option>
								</select>
							</form>
						{:else}
							<p class="mt-1 text-[12px]" style="color: var(--ink-3)">
								{a.accountId
									? `Feeds ${data.accounts.find((x) => x.id === a.accountId)?.label ?? 'a card'}`
									: 'Not synced'}
							</p>
						{/if}
					</div>
				{:else}
					<p class="px-3.5 py-3 text-[14px]" style="color: var(--ink-3)">
						SimpleFIN reported no accounts for this connection.
					</p>
				{/each}
			</div>

			{#if data.isOwner}
				<form
					method="POST"
					action="?/disconnect"
					use:submit={{
						confirm: {
							title: `Disconnect ${c.label}?`,
							body: 'Syncing stops and the stored credential is deleted. Transactions already synced stay in Reconcile.',
							confirmLabel: 'Disconnect',
							tone: 'danger'
						}
					}}
					class="mt-3"
				>
					<input type="hidden" name="connectionId" value={c.id} />
					<button class="btn btn-plain px-0 text-[13px]" style="color: var(--deny)"
						>Disconnect</button
					>
				</form>
			{/if}
		</section>
	{/each}

	{#if data.isOwner && data.available}
		<section class="card p-5">
			<h2
				class="font-[family-name:var(--font-sans)] text-[16px] font-semibold tracking-normal"
				style="color: var(--ink)"
			>
				{data.connections.length === 0 ? 'Connect a bank' : 'Connect another'}
			</h2>
			<ol
				class="mt-2 list-decimal space-y-1 pl-5 text-[13px] leading-relaxed"
				style="color: var(--ink-3)"
			>
				<li>
					Sign up at <a
						href="https://beta-bridge.simplefin.org"
						target="_blank"
						rel="noopener noreferrer"
						style="color: var(--ws-accent)">SimpleFIN Bridge</a
					> and connect your banks there.
				</li>
				<li>
					Create a <strong>setup token</strong> for this app and paste it below. It works once.
				</li>
				<li>Choose which card each account feeds.</li>
			</ol>
			<form
				method="POST"
				action="?/connect"
				use:submit={{ success: 'Connected. Now choose what each account feeds.' }}
				class="mt-3 space-y-3"
			>
				<label class="block">
					<span class="section-label mb-1.5 block">Setup token</span>
					<textarea
						name="token"
						required
						rows="3"
						autocomplete="off"
						spellcheck="false"
						class="field num text-[16px]"
						placeholder="aHR0cHM6Ly9iZXRhLWJyaWRnZS5zaW1wbGVmaW4ub3Jn…"></textarea>
				</label>
				<button class="btn btn-accent w-full">Connect</button>
			</form>
		</section>
	{/if}
</div>
