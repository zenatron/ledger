<script lang="ts">
	import { submit } from '$lib/actions/submit';
	import { ChevronRight } from '@lucide/svelte';
	import AccentPicker from '$lib/components/AccentPicker.svelte';
	import { ACCENTS, accentFor } from '$lib/accent';
	import { defaultCurrency, timeZoneOptions } from '$lib/locale-defaults';
	let { data, form } = $props();
	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
	// The browser's zone is always selectable, and the currency starts at the
	// one for the browser's region. See locale-defaults.ts for why both matter.
	const zones = $derived(timeZoneOptions(data.timezones, tz));
	const currency = $derived(
		typeof navigator === 'undefined' ? 'USD' : defaultCurrency(navigator.languages, data.currencies)
	);

	let selectedColor = $state<string>(ACCENTS[0]);
	let wsName = $state('');
</script>

<svelte:head><title>Welcome · Ledger</title></svelte:head>

<main
	class="min-h-viewport px-5 py-10"
	style="padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 2.5rem)"
>
	<div class="mx-auto max-w-md space-y-6">
		<header class="px-1 pt-4 pb-2">
			<h1 class="text-[28px] leading-tight">Hi, {data.displayName}</h1>
			<p class="mt-1.5 text-[16px] leading-relaxed" style="color: var(--ink-3)">
				Pick a workspace to continue, or create a new one.
			</p>
		</header>

		{#if data.workspaces.length > 0}
			<div class="space-y-2">
				{#each data.workspaces as ws (ws.slug)}
					{@const color = accentFor(ws)}
					<a
						href="/w/{ws.slug}"
						class="card press flex items-center gap-3.5 overflow-hidden px-4 py-3.5"
						style="box-shadow: var(--shadow-card), inset 0 0 0 0.5px var(--hairline)"
					>
						<span
							class="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] font-[family-name:var(--font-display)] text-[16px] font-bold text-white"
							style="background: light-dark(color-mix(in oklab, {color} 80%, black), {color})"
						>
							{ws.name.charAt(0)}
						</span>
						<span class="flex-1 truncate text-[17px] font-medium" style="color: var(--ink)">
							{ws.name}
						</span>
						<ChevronRight class="h-4 w-4 shrink-0" style="color: var(--ink-4)" />
					</a>
				{/each}
			</div>
		{/if}

		<div class="card space-y-4 p-5">
			<form method="POST" action="?/create" use:submit class="space-y-4">
				<div class="flex items-start gap-3">
					<span
						class="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] font-[family-name:var(--font-display)] text-[18px] font-bold text-white"
						style="background: light-dark(color-mix(in oklab, {selectedColor} 80%, black), {selectedColor})"
						aria-hidden="true">{(wsName.trim()[0] ?? 'W').toUpperCase()}</span
					>
					<div class="flex-1 space-y-1">
						<p class="text-[17px] font-semibold" style="color: var(--ink)">Create a workspace</p>
						<input
							name="name"
							aria-label="Name"
							bind:value={wsName}
							required
							maxlength="60"
							placeholder="Our household"
							class="field text-[16px]"
						/>
					</div>
				</div>
				<AccentPicker bind:value={selectedColor} />
				<input type="hidden" name="accentColor" value={selectedColor} />
				<div class="grid grid-cols-2 gap-3">
					<select name="currency" class="field text-[16px]">
						{#each data.currencies as c (c)}<option value={c} selected={c === currency}>{c}</option
							>{/each}
					</select>
					<select name="timezone" class="field text-[16px]">
						{#each zones as t (t)}<option value={t} selected={t === tz}>{t}</option>{/each}
					</select>
				</div>
				{#if form?.action === 'create' && form?.error}
					<div
						class="rounded-[10px] px-4 py-3 text-[14px] font-medium"
						style="color: var(--deny); background: color-mix(in oklab, var(--deny) 12%, transparent)"
					>
						{form.error}
					</div>
				{/if}
				<button class="btn btn-accent w-full">Create workspace</button>
			</form>
		</div>

		<div class="card space-y-3.5 p-5">
			<p class="text-[13px] font-semibold tracking-[0.06em] uppercase" style="color: var(--ink-3)">
				Join with invite code
			</p>
			<form method="POST" action="?/join" use:submit class="space-y-3.5">
				<input
					name="code"
					aria-label="Invite code"
					required
					placeholder="e.g. 7XK2M9QRTB"
					autocapitalize="characters"
					autocomplete="off"
					spellcheck="false"
					class="field text-center font-mono tracking-[0.14em] uppercase"
				/>
				{#if form?.action === 'join' && form?.error}
					<div
						class="rounded-[10px] px-4 py-3 text-[14px] font-medium"
						style="color: var(--deny); background: color-mix(in oklab, var(--deny) 12%, transparent)"
					>
						{form.error}
					</div>
				{/if}
				<button class="btn btn-ghost w-full">Join</button>
			</form>
		</div>

		<form method="POST" action="/auth/logout" class="pt-1 text-center">
			<button class="btn btn-plain text-[15px]" style="color: var(--ink-3)">Sign out</button>
		</form>
	</div>
</main>
