<script lang="ts">
	import { submit } from '$lib/actions/submit';
	import { page } from '$app/state';
	import { formatMinor } from '$lib/money-format';
	import {
		ChevronLeft,
		Landmark,
		Link2,
		ListFilter,
		ScrollText,
		ShieldCheck
	} from '@lucide/svelte';

	let { data, form } = $props();
	let slug = $derived(page.params.workspace);

	const BRIDGE_CREATE = 'https://beta-bridge.simplefin.org/simplefin/create';

	function fmtWhen(d: Date | string | null | undefined): string {
		if (!d) return '—';
		return new Date(d).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	}

	const STATUS: Record<string, { label: string; color: string }> = {
		active: { label: 'Connected', color: 'var(--approve)' },
		error: { label: 'Needs attention', color: 'var(--warn, var(--deny))' },
		revoked: { label: 'Access revoked', color: 'var(--deny)' },
		disconnected: { label: 'Disconnected', color: 'var(--ink-3)' }
	};

	const MATCH_LABEL: Record<string, string> = {
		contains: 'contains',
		starts_with: 'starts with',
		equals: 'is'
	};

	let ruleAction = $state<'categorize' | 'ignore'>('categorize');
	/** Which disabled account is showing its "link to" picker. */
	let linking = $state<string | null>(null);

	let feedNames = $derived(
		new Map(data.connections.flatMap((c) => c.accounts.map((a) => [a.id, a.name] as const)))
	);
	let connLabels = $derived(new Map(data.connections.map((c) => [c.id, c.label])));
	let live = $derived(data.connections.filter((c) => c.status !== 'disconnected'));
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
			<ShieldCheck class="h-4 w-4" style="color: var(--ws-accent)" /> Read-only, one way
		</h2>
		<p class="mt-1 text-[13px] leading-relaxed" style="color: var(--ink-3)">
			Transactions from your banks and cards arrive through <strong>SimpleFIN</strong>, a read-only
			bridge. Nothing here can move money. New lines land in
			<a href="/w/{slug}/reconcile" class="underline">Reconcile</a>, matched to purchases you’ve
			already logged where possible. Nothing reaches the ledger until someone says so.
		</p>
	</div>

	{#if !data.secretsConfigured}
		<div
			class="card p-4 text-[14px] leading-relaxed"
			style="color: var(--deny); background: color-mix(in oklab, var(--deny) 10%, var(--surface))"
		>
			Bank sync is off on this server. It needs <code>SECRETS_KEY</code> set, so the bank credential
			is always stored encrypted. Generate one with <code>openssl rand -base64 32</code>.
		</div>
	{/if}

	{#if form?.error}
		<div
			class="card p-4 text-[15px]"
			style="color: var(--deny); background: color-mix(in oklab, var(--deny) 12%, var(--surface))"
		>
			{form.error}
		</div>
	{/if}
	{#if form?.synced}
		<div class="card p-4 text-[14px]" style="color: var(--ink-2)">
			Synced: {form.synced.inserted} new line{form.synced.inserted === 1 ? '' : 's'}, {form.synced
				.matched} matched to purchases.
			{#if form.synced.warning}<span style="color: var(--deny)"> {form.synced.warning}</span>{/if}
		</div>
	{/if}
	{#if form?.reapplied !== undefined}
		<div class="card p-4 text-[14px]" style="color: var(--ink-2)">
			Rules answered {form.reapplied} waiting line{form.reapplied === 1 ? '' : 's'}.
		</div>
	{/if}

	<!-- Connections -->
	{#each live as c (c.id)}
		{@const st = STATUS[c.status] ?? STATUS.error}
		<div class="card p-5">
			<div class="flex items-start gap-3">
				<div class="min-w-0 flex-1">
					<h2
						class="flex items-center gap-2 font-[family-name:var(--font-sans)] text-[16px] font-semibold tracking-normal"
						style="color: var(--ink)"
					>
						<Landmark class="h-4 w-4" style="color: var(--ws-accent)" />
						<span class="truncate">{c.label}</span>
					</h2>
					<p class="mt-0.5 text-[12px]" style="color: var(--ink-3)">
						<span style="color: {st.color}">{st.label}</span> · {c.host}
					</p>
					<p class="mt-0.5 text-[12px]" style="color: var(--ink-3)">
						Last synced {fmtWhen(c.lastSuccessAt)}
						{#if c.nextSyncAt}· next {fmtWhen(c.nextSyncAt)}{/if}
					</p>
					{#if c.lastError}
						<p class="mt-1.5 text-[13px] leading-relaxed" style="color: var(--deny)">
							{c.lastError}
						</p>
					{/if}
				</div>
				{#if data.isOwner && c.status !== 'revoked'}
					<form method="POST" action="?/sync" use:submit={{ reset: false }}>
						<input type="hidden" name="connectionId" value={c.id} />
						<button class="btn btn-ghost shrink-0 px-3 py-2 text-[13px]">Sync now</button>
					</form>
				{/if}
			</div>

			<div class="mt-3 overflow-hidden rounded-[10px]" style="background: var(--surface-2)">
				{#each c.accounts as a, i (a.id)}
					<div class="px-3.5 py-3 {i < c.accounts.length - 1 ? 'hairline' : ''}">
						<div class="flex items-center gap-3">
							<div class="min-w-0 flex-1">
								<p class="truncate text-[15px] font-medium" style="color: var(--ink)">{a.name}</p>
								<p class="mt-0.5 truncate text-[12px]" style="color: var(--ink-3)">
									{a.institution ?? 'Account'}
									{#if a.balanceMinor !== null}
										· <span class="num">{formatMinor(a.balanceMinor, a.currency)}</span>
									{/if}
									{#if a.unsupportedReason}· {a.unsupportedReason}{/if}
								</p>
								{#if a.enabled}
									<p class="mt-0.5 truncate text-[12px]" style="color: var(--ink-3)">
										{a.visibility === 'shared'
											? 'Shared with everyone'
											: a.holderMemberId === data.viewerId
												? 'Only you see its lines'
												: `Only ${a.holderName ?? 'the cardholder'} sees its lines`}
									</p>
								{/if}
							</div>
							{#if data.isOwner && !a.unsupportedReason && c.status !== 'revoked'}
								{#if a.enabled}
									<form method="POST" action="?/toggle" use:submit={{ success: 'Syncing paused' }}>
										<input type="hidden" name="feedAccountId" value={a.id} />
										<input type="hidden" name="enabled" value="false" />
										<button class="btn btn-plain px-2 text-[13px]" style="color: var(--approve)"
											>Syncing · Pause</button
										>
									</form>
								{:else}
									<button
										type="button"
										class="btn btn-ghost px-3 py-1.5 text-[13px]"
										onclick={() => (linking = linking === a.id ? null : a.id)}>Sync this</button
									>
								{/if}
							{:else if a.enabled}
								<span class="text-[12px]" style="color: var(--approve)">Syncing</span>
							{/if}
						</div>
						{#if linking === a.id}
							<form
								method="POST"
								action="?/toggle"
								use:submit={{ success: 'Syncing on', onSuccess: () => (linking = null) }}
								class="mt-2.5 space-y-2.5"
							>
								<input type="hidden" name="feedAccountId" value={a.id} />
								<input type="hidden" name="enabled" value="true" />
								<label class="block">
									<span class="section-label mb-1 block">Whose card</span>
									<select name="holderMemberId" class="field text-[16px]" value={data.viewerId}>
										{#each data.members as m (m.id)}
											<option value={m.id}
												>{m.id === data.viewerId ? `${m.name} (you)` : m.name}</option
											>
										{/each}
									</select>
								</label>
								<label class="block">
									<span class="section-label mb-1 block">Who sees its transactions</span>
									<select name="visibility" class="field text-[16px]">
										<option value="holder">Only the cardholder</option>
										<option value="shared">Everyone (joint account)</option>
									</select>
									<span class="mt-1 block text-[12px] leading-relaxed" style="color: var(--ink-3)">
										Bank lines can name a gift before anyone logs it. Keep personal cards private;
										share only joint accounts.
									</span>
								</label>
								<label class="block">
									<span class="section-label mb-1 block">Attribute lines to</span>
									<select name="accountId" class="field text-[16px]">
										<option value="">New card: {a.name}</option>
										{#each data.accounts as acct (acct.id)}
											<option value={acct.id}
												>{acct.name}{acct.last4 ? ` ·${acct.last4}` : ''}</option
											>
										{/each}
									</select>
								</label>
								<button class="btn btn-accent w-full py-2 text-[14px]">Start syncing</button>
							</form>
						{/if}
					</div>
				{:else}
					<p class="px-3.5 py-3 text-[14px]" style="color: var(--ink-3)">
						No accounts reported yet. Link some at SimpleFIN Bridge, then tap Sync now.
					</p>
				{/each}
			</div>

			{#if data.isOwner}
				<form
					method="POST"
					action="?/disconnect"
					use:submit={{
						confirm: {
							title: `Disconnect “${c.label}”?`,
							body: 'The stored credential is destroyed and syncing stops. Lines already synced stay in Reconcile. To also cut access at the source, disable this app at SimpleFIN Bridge.',
							confirmLabel: 'Disconnect',
							tone: 'danger'
						},
						success: 'Disconnected'
					}}
					class="mt-3"
				>
					<input type="hidden" name="connectionId" value={c.id} />
					<button class="btn btn-plain px-0 text-[13px]" style="color: var(--deny)"
						>Disconnect</button
					>
				</form>
			{/if}
		</div>
	{/each}

	<!-- Connect -->
	{#if data.isOwner && data.secretsConfigured}
		<div class="card p-5">
			<h2
				class="flex items-center gap-2 font-[family-name:var(--font-sans)] text-[16px] font-semibold tracking-normal"
				style="color: var(--ink)"
			>
				<Link2 class="h-4 w-4" style="color: var(--ws-accent)" />
				{live.length ? 'Connect another bridge' : 'Connect your banks'}
			</h2>
			<ol
				class="mt-2 list-decimal space-y-1 pl-5 text-[13px] leading-relaxed"
				style="color: var(--ink-3)"
			>
				<li>
					Open <a href={BRIDGE_CREATE} target="_blank" rel="noopener noreferrer" class="underline"
						>SimpleFIN Bridge</a
					> and link your banks and cards there.
				</li>
				<li>
					Create a <strong>setup token</strong> for this app and paste it below. It works once.
				</li>
				<li>Pick which accounts to sync. None sync until you do.</li>
			</ol>
			<form
				method="POST"
				action="?/connect"
				use:submit={{ success: 'Connected' }}
				class="mt-3 space-y-3"
			>
				<label class="block">
					<span class="section-label mb-1.5 block">Setup token</span>
					<textarea
						name="setupToken"
						required
						rows="3"
						autocomplete="off"
						spellcheck="false"
						class="field num text-[16px]"
						placeholder="aHR0cHM6Ly9…"></textarea>
				</label>
				<label class="block">
					<span class="section-label mb-1.5 block">Name (optional)</span>
					<input
						name="label"
						maxlength="60"
						placeholder="e.g. Our banks"
						class="field text-[16px]"
					/>
				</label>
				<button class="btn btn-accent w-full">Connect</button>
			</form>
		</div>
	{/if}

	<!-- Rules -->
	{#if live.length > 0 || data.rules.length > 0}
		<div class="card p-5">
			<h2
				class="flex items-center gap-2 font-[family-name:var(--font-sans)] text-[16px] font-semibold tracking-normal"
				style="color: var(--ink)"
			>
				<ListFilter class="h-4 w-4" style="color: var(--ws-accent)" /> Rules
			</h2>
			<p class="mt-1 text-[13px] leading-relaxed" style="color: var(--ink-3)">
				Applied to each new line that doesn’t match a purchase. The first matching rule wins, lowest
				priority number first. Lines no rule covers get a category from what you filed the same
				merchant under before.
			</p>

			{#if data.rules.length}
				<div class="mt-3 overflow-hidden rounded-[10px]" style="background: var(--surface-2)">
					{#each data.rules as r, i (r.id)}
						<div
							class="flex items-center gap-3 px-3.5 py-3 {i < data.rules.length - 1
								? 'hairline'
								: ''}"
						>
							<div class="min-w-0 flex-1">
								<p class="text-[14px]" style="color: var(--ink)">
									<span style="color: var(--ink-3)">{MATCH_LABEL[r.match]}</span>
									“{r.pattern}”
									<span style="color: var(--ink-3)">→</span>
									{#if r.action === 'ignore'}
										ignore
									{:else}
										{r.categoryName ?? ''}{r.renameTo ? ` as “${r.renameTo}”` : ''}
									{/if}
								</p>
								<p class="num mt-0.5 text-[12px]" style="color: var(--ink-3)">
									#{r.priority} · {r.direction === 'out'
										? 'money out'
										: r.direction === 'in'
											? 'money in'
											: 'either way'}
									{#if r.minAmountMinor !== null}· ≥ {formatMinor(
											r.minAmountMinor,
											data.currency
										)}{/if}
									{#if r.maxAmountMinor !== null}· ≤ {formatMinor(
											r.maxAmountMinor,
											data.currency
										)}{/if}
									{#if r.feedAccountId}· {feedNames.get(r.feedAccountId) ?? 'one account'}{/if}
									· used {r.hitCount}×
								</p>
							</div>
							{#if data.isOwner}
								<form
									method="POST"
									action="?/deleteRule"
									use:submit={{ confirm: 'Delete this rule?', success: 'Rule deleted' }}
								>
									<input type="hidden" name="ruleId" value={r.id} />
									<button class="btn btn-plain px-2 text-[13px]" style="color: var(--deny)"
										>Delete</button
									>
								</form>
							{/if}
						</div>
					{/each}
				</div>
				{#if data.isOwner}
					<form method="POST" action="?/reapply" use:submit={{}} class="mt-2">
						<button class="btn btn-plain px-0 text-[13px]" style="color: var(--ink-2)"
							>Apply rules to lines still waiting</button
						>
					</form>
				{/if}
			{/if}

			{#if data.isOwner}
				<form
					method="POST"
					action="?/addRule"
					use:submit={{ success: 'Rule added' }}
					class="mt-4 space-y-3"
				>
					<div class="flex gap-2">
						<select name="match" class="field w-auto text-[16px]" aria-label="How to match">
							<option value="contains">Contains</option>
							<option value="starts_with">Starts with</option>
							<option value="equals">Is exactly</option>
						</select>
						<input
							name="pattern"
							required
							minlength="2"
							maxlength="120"
							placeholder="e.g. costco"
							aria-label="Text to match"
							class="field min-w-0 flex-1 text-[16px]"
						/>
					</div>
					<div class="flex gap-2">
						<select
							name="action"
							bind:value={ruleAction}
							class="field text-[16px]"
							aria-label="Then"
						>
							<option value="categorize">Categorize</option>
							<option value="ignore">Ignore (transfers, card payments)</option>
						</select>
						<select name="direction" class="field w-auto text-[16px]" aria-label="Direction">
							<option value="out">Money out</option>
							<option value="in">Money in</option>
							<option value="any">Either</option>
						</select>
					</div>
					{#if ruleAction === 'categorize'}
						<div class="space-y-2">
							<select name="categoryId" class="field text-[16px]" aria-label="Category">
								<option value="">No category</option>
								{#each data.categories as cat (cat.id)}
									<option value={cat.id}>{cat.icon ? `${cat.icon} ` : ''}{cat.name}</option>
								{/each}
							</select>
							<input
								name="renameTo"
								maxlength="80"
								placeholder="Rename (optional)"
								aria-label="Rename to"
								class="field text-[16px]"
							/>
						</div>
					{/if}
					<details>
						<summary class="cursor-pointer text-[13px]" style="color: var(--ink-3)"
							>More conditions</summary
						>
						<div class="mt-2 grid grid-cols-2 gap-2">
							<input
								name="minAmount"
								inputmode="decimal"
								placeholder="At least"
								aria-label="At least"
								class="field text-[16px]"
							/>
							<input
								name="maxAmount"
								inputmode="decimal"
								placeholder="At most"
								aria-label="At most"
								class="field text-[16px]"
							/>
							<select name="feedAccountId" class="field text-[16px]" aria-label="Account">
								<option value="">Any account</option>
								{#each data.connections as c (c.id)}
									{#each c.accounts as a (a.id)}
										<option value={a.id}>{a.name}</option>
									{/each}
								{/each}
							</select>
							<input
								name="priority"
								inputmode="numeric"
								placeholder="Priority (100)"
								aria-label="Priority"
								class="field text-[16px]"
							/>
						</div>
					</details>
					<button class="btn btn-ghost w-full">Add rule</button>
				</form>
			{/if}
		</div>
	{/if}

	<!-- Log -->
	{#if data.runs.length}
		<div class="card p-5">
			<h2
				class="flex items-center gap-2 font-[family-name:var(--font-sans)] text-[16px] font-semibold tracking-normal"
				style="color: var(--ink)"
			>
				<ScrollText class="h-4 w-4" style="color: var(--ws-accent)" /> Sync log
			</h2>
			<div class="mt-3 space-y-2">
				{#each data.runs as r (r.id)}
					<div class="text-[13px]" style="color: var(--ink-2)">
						<p>
							<span
								style="color: {r.status === 'ok'
									? 'var(--approve)'
									: r.status === 'running'
										? 'var(--ink-3)'
										: 'var(--deny)'}">{r.status}</span
							>
							· {fmtWhen(r.startedAt)} · {r.trigger}
							{#if connLabels.size > 1}· {connLabels.get(r.connectionId)}{/if}
						</p>
						<p class="num text-[12px]" style="color: var(--ink-3)">
							{r.fetched} read · {r.inserted} new · {r.duplicates} already had · {r.matched} matched ·
							{r.categorized} categorized · {r.ignoredByRule} ignored{r.durationMs !== null
								? ` · ${(r.durationMs / 1000).toFixed(1)}s`
								: ''}
						</p>
						{#each r.messages.slice(0, 3) as m, mi (mi)}
							<p
								class="text-[12px]"
								style="color: {m.level === 'error' ? 'var(--deny)' : 'var(--ink-3)'}"
							>
								{m.account ? `${m.account}: ` : ''}{m.msg}
							</p>
						{/each}
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
