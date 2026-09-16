<script lang="ts">
	import { submit } from '$lib/actions/submit';
	import { page } from '$app/state';
	import { Check, ChevronLeft, Key, KeyRound, Webhook } from '@lucide/svelte';

	let { data, form } = $props();
	let slug = $derived(page.params.workspace);

	const mcpUrl = $derived(`${page.url.origin}/mcp`);

	// The just-created secret (shown once). Cleared when the user copies/dismisses.
	let revealed = $state<{ secret: string; name: string } | null>(null);
	$effect(() => {
		if (form?.created) revealed = { secret: form.created.secret, name: form.created.name };
	});

	let copied = $state(false);
	async function copy(textToCopy: string) {
		try {
			await navigator.clipboard.writeText(textToCopy);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			/* clipboard blocked — the value is on screen to copy by hand */
		}
	}

	/*
	 * What a token may do, and what is ticked before you decide.
	 *
	 * All three used to be ticked, which meant every token minted could approve
	 * household spending unless someone noticed and unticked it. A default is a
	 * decision made on the user's behalf, and that is not one to make quietly —
	 * so approval is now opt-in, and each line says what it really covers rather
	 * than the friendliest example of it.
	 */
	const SCOPES: { id: string; label: string; hint: string; standard: boolean }[] = [
		{
			id: 'read',
			label: 'Read',
			hint: 'View spending, summaries, buckets, and pending items. Read-only.',
			standard: true
		},
		{
			id: 'write',
			label: 'Log & manage',
			hint: 'Record purchases, and edit buckets, income and recurring plans',
			standard: true
		},
		{
			id: 'approve',
			label: 'Approve spending',
			hint: 'Approve or deny purchases waiting on you. Leave off unless you want an assistant deciding.',
			standard: false
		}
	];

	function fmtDate(iso: string) {
		return new Date(iso).toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		});
	}
	function scopeLabel(s: string) {
		return SCOPES.find((x) => x.id === s)?.label ?? s;
	}
</script>

<div class="mx-auto max-w-lg space-y-4">
	<a
		href="/w/{slug}"
		class="press -ml-1 inline-flex items-center gap-0.5 text-[15px]"
		style="color: var(--ink-3)"
	>
		<ChevronLeft class="h-4 w-4" /> Settings
	</a>
	<h1 class="px-1 text-[28px]">API &amp; MCP</h1>

	<!-- What this is -->
	<div class="card p-4">
		<h2
			class="flex items-center gap-2 font-[family-name:var(--font-sans)] text-[16px] font-semibold tracking-normal"
			style="color: var(--ink)"
		>
			<Webhook class="h-4 w-4" style="color: var(--ws-accent)" /> Connect your assistant
		</h2>
		<p class="mt-1 text-[13px] leading-relaxed" style="color: var(--ink-3)">
			Add this workspace as an <strong>MCP server</strong> in Claude, ChatGPT, or your editor, and ask
			about your budget in plain language, like “how much did we spend on groceries?” or “log $40 at Trader
			Joe’s”. It acts as you, so approvals and gift-mode seals still apply.
		</p>
		<div class="mt-3">
			<span class="section-label mb-1.5 block">Server URL</span>
			<div class="flex items-center gap-2">
				<code
					class="num flex-1 truncate rounded-[10px] px-3 py-2 text-[13px]"
					style="background: var(--surface-2); color: var(--ink-2)">{mcpUrl}</code
				>
				<button
					type="button"
					onclick={() => copy(mcpUrl)}
					class="btn btn-ghost shrink-0 px-3 py-2 text-[13px]">Copy</button
				>
			</div>
			<p class="mt-1.5 text-[13px] leading-relaxed" style="color: var(--ink-3)">
				Your assistant will ask for a token when you add this URL. Create one below and paste it in.
			</p>
		</div>
	</div>

	{#if form?.error}
		<div
			class="card p-4 text-[15px]"
			style="color: var(--deny); background: color-mix(in oklab, var(--deny) 12%, var(--surface))"
		>
			{form.error}
		</div>
	{/if}

	<!-- Freshly-created secret: shown exactly once -->
	{#if revealed}
		<div
			class="card p-4"
			style="background: color-mix(in oklab, var(--approve) 10%, var(--surface)); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--approve) 30%, transparent)"
		>
			<p class="flex items-center gap-1.5 text-[14px] font-semibold" style="color: var(--approve)">
				<Check class="h-4 w-4" /> “{revealed.name}” created
			</p>
			<p class="mt-1 text-[13px]" style="color: var(--ink-3)">
				Copy it now. This is the only time it’s shown.
			</p>
			<div class="mt-2.5 flex items-center gap-2">
				<code
					class="num flex-1 truncate rounded-[10px] px-3 py-2 text-[13px]"
					style="background: var(--surface-2); color: var(--ink)">{revealed.secret}</code
				>
				<button
					type="button"
					onclick={() => copy(revealed!.secret)}
					class="btn btn-accent shrink-0 px-3 py-2 text-[13px]">{copied ? 'Copied' : 'Copy'}</button
				>
			</div>
			<button
				type="button"
				onclick={() => (revealed = null)}
				class="btn btn-plain mt-2 px-0 text-[13px]"
				style="color: var(--ink-3)">Saved it, hide</button
			>
		</div>
	{/if}

	<!-- Create -->
	<div class="card p-5">
		<h2
			class="flex items-center gap-2 font-[family-name:var(--font-sans)] text-[16px] font-semibold tracking-normal"
			style="color: var(--ink)"
		>
			<KeyRound class="h-4 w-4" style="color: var(--ws-accent)" /> New token
		</h2>
		<form
			method="POST"
			action="?/create"
			use:submit={{ success: 'Token created' }}
			class="mt-3 space-y-4"
		>
			<label class="block">
				<span class="section-label mb-1.5 block">Name</span>
				<input
					name="name"
					required
					maxlength="60"
					placeholder="e.g. Claude on my phone"
					class="field text-[16px]"
				/>
			</label>

			<fieldset>
				<legend class="section-label mb-1.5">Permissions</legend>
				<!--
					One quiet panel of hairline-separated rows, like every other list in
					the app. Three separately outlined boxes read as three competing
					cards, which put more weight on the chrome than on the choice.
				-->
				<div class="overflow-hidden rounded-[10px]" style="background: var(--surface-2)">
					{#each SCOPES as s, i (s.id)}
						<label
							class="flex cursor-pointer items-start gap-3 px-3.5 py-3 {i > 0 ? 'hairline' : ''}"
						>
							<input
								type="checkbox"
								name="scopes"
								value={s.id}
								checked={s.standard}
								class="mt-0.5 h-4 w-4 shrink-0"
								style="accent-color: var(--ws-accent)"
							/>
							<span class="min-w-0 flex-1">
								<span class="block text-[15px] font-medium" style="color: var(--ink)"
									>{s.label}</span
								>
								<span class="mt-0.5 block text-[13px] leading-relaxed" style="color: var(--ink-3)"
									>{s.hint}</span
								>
							</span>
						</label>
					{/each}
				</div>
			</fieldset>

			<label class="block">
				<span class="section-label mb-1.5 block">Expires</span>
				<select name="expiresInDays" class="field text-[16px]">
					<option value="">Never</option>
					<option value="30">In 30 days</option>
					<option value="90">In 90 days</option>
					<option value="365">In 1 year</option>
				</select>
			</label>

			<button class="btn btn-accent w-full">Create token</button>
		</form>
	</div>

	<!-- Existing tokens -->
	<div class="card p-5">
		<h2
			class="flex items-center gap-2 font-[family-name:var(--font-sans)] text-[16px] font-semibold tracking-normal"
			style="color: var(--ink)"
		>
			<Key class="h-4 w-4" style="color: var(--ws-accent)" /> Your tokens
		</h2>
		{#if data.tokens.length === 0}
			<p class="mt-3 text-[14px]" style="color: var(--ink-3)">
				No tokens yet. Create one above to connect a client.
			</p>
		{:else}
			<div class="mt-3 space-y-2.5">
				{#each data.tokens as t (t.id)}
					<div
						class="flex items-center gap-3 p-4"
						style="box-shadow: inset 0 0 0 1px var(--hairline); border-radius: var(--r-sm)"
					>
						<div class="min-w-0 flex-1">
							<p class="truncate text-[15px] font-medium" style="color: var(--ink)">{t.name}</p>
							<p class="num mt-0.5 text-[12px]" style="color: var(--ink-3)">
								{t.prefix}…&nbsp;·&nbsp;{t.scopes.map(scopeLabel).join(', ')}
							</p>
							<p class="mt-0.5 text-[12px]" style="color: var(--ink-3)">
								{t.lastUsedAt ? `Last used ${fmtDate(t.lastUsedAt)}` : 'Never used'}
								{#if t.expiresAt}· expires {fmtDate(t.expiresAt)}{/if}
							</p>
						</div>
						<form
							method="POST"
							action="?/revoke"
							use:submit={{
								confirm: `Revoke “${t.name}”? Any client using it stops working immediately.`,
								success: 'Token revoked'
							}}
						>
							<input type="hidden" name="tokenId" value={t.id} />
							<button class="btn btn-danger px-3.5 py-2 text-[13px]">Revoke</button>
						</form>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>
