<script lang="ts">
	import { submit } from '$lib/actions/submit';
	import { page } from '$app/state';
	import {
		Bell,
		Camera,
		ChevronRight,
		CircleHelp,
		Download,
		FileCheck,
		Palette,
		Settings,
		Shapes,
		Sparkles,
		Users,
		Webhook
	} from '@lucide/svelte';
	import { installPrompt, isIos, promptInstall, dismissInstall } from '$lib/install-prompt.svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	let { data, form } = $props();
	let slug = $derived(page.params.workspace);
	let prompting = $state(false);

	// Imported at click time, the way DemoBanner does it: a static import would
	// keep $lib/demo in the production bundle even though `{#if __DEMO__}`
	// removes the call.
	async function demoSignOut() {
		const { signOut } = await import('$lib/demo/session');
		signOut();
		await goto(`${base}/`);
	}

	async function install() {
		prompting = true;
		try {
			await promptInstall();
		} finally {
			prompting = false;
		}
	}

	let confirmingDelete = $state(false);
	let deleteConfirmText = $state('');
	// The workspace the delete confirmation was opened for, frozen at that moment
	// (not read live from data). It's submitted with the form and re-checked on
	// the server, so an armed delete can never act on a workspace you switched to.
	let armedWorkspaceId = $state<string | null>(null);

	function armDelete() {
		confirmingDelete = true;
		armedWorkspaceId = data.workspace.id;
		deleteConfirmText = '';
	}
	function disarmDelete() {
		confirmingDelete = false;
		deleteConfirmText = '';
		armedWorkspaceId = null;
	}

	// Belt to the server's braces: if the workspace changes while a delete is
	// armed — should never happen, since the layout recreates this page per
	// workspace, but this doesn't depend on that — disarm so no stale, dangerous
	// confirmation is ever left on screen.
	$effect(() => {
		if (confirmingDelete && armedWorkspaceId !== data.workspace.id) disarmDelete();
	});

	const memberSummary = $derived(
		`${data.memberCount} ${data.memberCount === 1 ? 'person' : 'people'} · approvals and invites`
	);
</script>

<div class="space-y-4">
	<h1 class="px-1 pt-1 text-[28px]">Settings</h1>

	<!-- Profile -->
	<div class="card flex items-center gap-3.5 p-4">
		<form method="POST" action="?/avatar" enctype="multipart/form-data" use:submit>
			<label class="press relative block cursor-pointer">
				{#if data.user.avatarBlobId}
					<!-- ?v= is the blob id, and blobs are content-addressed: replacing
					     the photo changes the URL, so no stale cached photo can stick. -->
					<img
						src="/w/{slug}/avatar?v={data.user.avatarBlobId}"
						alt=""
						class="h-12 w-12 rounded-full object-cover"
						style="box-shadow: inset 0 0 0 0.5px var(--hairline)"
					/>
				{:else}
					<div
						class="flex h-12 w-12 items-center justify-center rounded-full font-[family-name:var(--font-display)] text-[22px] font-bold text-white"
						style="background: color-mix(in oklab, var(--ws-accent) 80%, black)"
					>
						{data.user.displayName.charAt(0)}
					</div>
				{/if}
				<span
					class="absolute -right-0.5 -bottom-0.5 flex h-6 w-6 items-center justify-center rounded-full text-white"
					style="background: color-mix(in oklab, var(--ink) 50%, transparent); box-shadow: 0 0 0 2px var(--paper)"
					aria-label="Change photo"
				>
					<Camera class="h-3.5 w-3.5" />
				</span>
				<input
					type="file"
					name="photo"
					accept="image/jpeg,image/png,image/webp"
					onchange={(e) => {
						const f = (e.target as HTMLInputElement).files?.[0];
						if (f) (e.target as HTMLInputElement).form?.requestSubmit();
					}}
					class="sr-only"
				/>
			</label>
			<button type="submit" class="sr-only">Upload</button>
		</form>
		<div class="min-w-0 flex-1">
			<p class="truncate text-[17px] font-semibold" style="color: var(--ink)">
				{data.user.displayName}
			</p>
			<p class="text-[13px] capitalize" style="color: var(--ink-3)">
				{data.member.role} · {data.workspace.name}
			</p>
			{#if form?.section === 'avatar' && form.error}
				<p class="mt-0.5 text-[13px]" style="color: var(--deny)">{form.error}</p>
			{/if}
		</div>
		<!--
			Signing out is a server act: the session row is destroyed and the cookie
			cleared by /auth/logout. The demo has neither, and posting to an endpoint
			that isn't in the static build landed on the error page, so there it ends
			the tab's session and returns to the landing page instead. The visitor's
			data is left alone; "Reset demo" in the banner is what discards it.
		-->
		{#if __DEMO__}
			<button type="button" onclick={demoSignOut} class="btn btn-ghost px-4 py-2 text-[14px]">
				Sign out
			</button>
		{:else}
			<form method="POST" action="/auth/logout">
				<button class="btn btn-ghost px-4 py-2 text-[14px]">Sign out</button>
			</form>
		{/if}
	</div>

	<!--
		One card for everything on your plate, not a stack of separate bubbles: two
		different to-dos (record what you paid; wait on / give a decision) read as a
		single "here's what needs you" so nothing is missed and nothing competes.
		Amber throughout — the shared "attention" colour — with the parts spelled
		out in the subtitle rather than colour-coded, which kept it calm.
	-->
	{#if data.confirmCount > 0 || data.pendingCount > 0}
		{@const total = data.confirmCount + data.pendingCount}
		{@const parts = [
			data.confirmCount > 0 ? `${data.confirmCount} to confirm` : null,
			data.pendingCount > 0 ? `${data.pendingCount} awaiting a decision` : null
		].filter(Boolean)}
		<a
			href="/w/{slug}/purchases"
			class="press card flex items-center gap-3.5 p-4"
			style="background: color-mix(in oklab, var(--pending) 12%, var(--surface))"
		>
			<span
				class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[15px] font-bold text-white"
				style="background: var(--pending)">{total}</span
			>
			<div class="flex-1">
				<p class="text-[15px] font-semibold" style="color: var(--pending)">Needs your attention</p>
				<p class="text-[13px]" style="color: var(--ink-3)">{parts.join(' · ')}</p>
			</div>
			<ChevronRight class="h-4 w-4" style="color: var(--pending)" />
		</a>
	{/if}

	<!-- Workspace -->
	{#if !__DEMO__}
		<a href="/w/{slug}/settings/members" class="press card flex items-center gap-3.5 p-4">
			<span
				class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
				style="background: color-mix(in oklab, var(--ws-accent) 18%, transparent)"
			>
				<Users class="h-[18px] w-[18px]" style="color: var(--ws-accent)" />
			</span>
			<div class="flex-1">
				<p class="text-[15px] font-medium" style="color: var(--ink)">Members</p>
				<p class="text-[13px]" style="color: var(--ink-3)">{memberSummary}</p>
			</div>
			<ChevronRight class="h-4 w-4" style="color: var(--ink-4)" />
		</a>
	{/if}

	<a href="/w/{slug}/settings/categories" class="press card flex items-center gap-3.5 p-4">
		<span
			class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
			style="background: color-mix(in oklab, var(--ws-accent) 18%, transparent)"
		>
			<Shapes class="h-[18px] w-[18px]" style="color: var(--ws-accent)" />
		</span>
		<div class="flex-1">
			<p class="text-[15px] font-medium" style="color: var(--ink)">Categories</p>
			<p class="text-[13px]" style="color: var(--ink-3)">Add custom spending categories</p>
		</div>
		<ChevronRight class="h-4 w-4" style="color: var(--ink-4)" />
	</a>

	{#if !__DEMO__}
		<a href="/w/{slug}/settings/notifications" class="press card flex items-center gap-3.5 p-4">
			<span
				class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
				style="background: color-mix(in oklab, var(--ws-accent) 18%, transparent)"
			>
				<Bell class="h-[18px] w-[18px]" style="color: var(--ws-accent)" />
			</span>
			<div class="flex-1">
				<p class="text-[15px] font-medium" style="color: var(--ink)">Notifications</p>
				<p class="text-[13px]" style="color: var(--ink-3)">Push, ntfy, and per-event routing</p>
			</div>
			<ChevronRight class="h-4 w-4" style="color: var(--ink-4)" />
		</a>
	{/if}

	{#if !__DEMO__}
		<a href="/w/{slug}/settings/intelligence" class="press card flex items-center gap-3.5 p-4">
			<span
				class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
				style="background: color-mix(in oklab, var(--ws-accent) 18%, transparent)"
			>
				<Sparkles class="h-[18px] w-[18px]" style="color: var(--ws-accent)" />
			</span>
			<div class="flex-1">
				<p class="flex items-center gap-2 text-[15px] font-medium" style="color: var(--ink)">
					Harmony
					<span
						class="rounded-[var(--r-full)] px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.06em] uppercase"
						style="background: color-mix(in oklab, var(--pending) 16%, var(--surface)); color: var(--pending)"
						>Alpha</span
					>
				</p>
				<p class="text-[13px]" style="color: var(--ink-3)">
					Safe to Spend, bill reading, and optional AI assistance
				</p>
			</div>
			<ChevronRight class="h-4 w-4" style="color: var(--ink-4)" />
		</a>
	{/if}

	{#if !__DEMO__}
		<a href="/w/{slug}/reconcile" class="press card flex items-center gap-3.5 p-4">
			<span
				class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
				style="background: color-mix(in oklab, var(--ws-accent) 18%, transparent)"
			>
				<FileCheck class="h-[18px] w-[18px]" style="color: var(--ws-accent)" />
			</span>
			<div class="flex-1">
				<p class="flex items-center gap-2 text-[15px] font-medium" style="color: var(--ink)">
					Reconcile
					<span
						class="rounded-[var(--r-full)] px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.06em] uppercase"
						style="background: color-mix(in oklab, var(--pending) 16%, var(--surface)); color: var(--pending)"
						>Alpha</span
					>
				</p>
				<p class="text-[13px]" style="color: var(--ink-3)">
					Tick a bank statement against this ledger
				</p>
			</div>
			<ChevronRight class="h-4 w-4" style="color: var(--ink-4)" />
		</a>
	{/if}

	{#if !__DEMO__}
		<a href="/w/{slug}/settings/advanced" class="press card flex items-center gap-3.5 p-4">
			<span
				class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
				style="background: color-mix(in oklab, var(--ws-accent) 18%, transparent)"
			>
				<Settings class="h-[18px] w-[18px]" style="color: var(--ws-accent)" />
			</span>
			<div class="flex-1">
				<p class="text-[15px] font-medium" style="color: var(--ink)">Advanced</p>
				<p class="text-[13px]" style="color: var(--ink-3)">
					Timing, thresholds, nudges, and limits
				</p>
			</div>
			<ChevronRight class="h-4 w-4" style="color: var(--ink-4)" />
		</a>
	{/if}

	{#if !__DEMO__}
		<a href="/w/{slug}/settings/api" class="press card flex items-center gap-3.5 p-4">
			<span
				class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
				style="background: color-mix(in oklab, var(--ws-accent) 18%, transparent)"
			>
				<Webhook class="h-[18px] w-[18px]" style="color: var(--ws-accent)" />
			</span>
			<div class="flex-1">
				<p class="flex items-center gap-2 text-[15px] font-medium" style="color: var(--ink)">
					API &amp; MCP
					<span
						class="rounded-[var(--r-full)] px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.06em] uppercase"
						style="background: color-mix(in oklab, var(--pending) 16%, var(--surface)); color: var(--pending)"
						>Alpha</span
					>
				</p>
				<p class="text-[13px]" style="color: var(--ink-3)">Connect Claude or another assistant</p>
			</div>
			<ChevronRight class="h-4 w-4" style="color: var(--ink-4)" />
		</a>
	{/if}

	{#if form?.error && form?.section !== 'avatar'}
		<div
			class="card p-4 text-[15px]"
			style="color: var(--deny); background: color-mix(in oklab, var(--deny) 12%, var(--surface))"
		>
			{form.error}
		</div>
	{/if}

	<!--
		Install, offered rather than begged for: one quiet card that appears when
		the platform has an install to offer (or is an iPhone, where the only
		lever is Share → Add to Home Screen) and stays dismissed once answered.
		Amber like every other "consider this" card; nothing pulses, nothing
		re-appears after "Not now".
	-->
	{#if !installPrompt.installed && !installPrompt.dismissed}
		{#if installPrompt.available}
			<div
				class="card p-4"
				style="background: color-mix(in oklab, var(--pending) 12%, var(--surface))"
			>
				<div class="flex items-center gap-2.5">
					<span
						class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
						style="background: color-mix(in oklab, var(--pending) 16%, transparent)"
					>
						<Download class="h-4 w-4" style="color: var(--pending)" />
					</span>
					<div class="flex-1">
						<p class="text-[15px] font-semibold" style="color: var(--pending)">Install Ledger</p>
						<p class="text-[13px]" style="color: var(--ink-3)">
							Full screen, its own window, and works offline.
						</p>
					</div>
				</div>
				<div class="mt-3 flex items-center gap-2.5">
					<button
						onclick={install}
						disabled={prompting}
						class="btn btn-accent px-4 py-2 text-[14px]"
					>
						Install
					</button>
					<button
						onclick={dismissInstall}
						disabled={prompting}
						class="btn btn-plain px-4 py-2 text-[14px]"
						style="color: var(--ink-3)">Not now</button
					>
				</div>
			</div>
		{:else if isIos()}
			<div
				class="card p-4"
				style="background: color-mix(in oklab, var(--pending) 12%, var(--surface))"
			>
				<div class="flex items-center gap-2.5">
					<span
						class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
						style="background: color-mix(in oklab, var(--pending) 16%, transparent)"
					>
						<Download class="h-4 w-4" style="color: var(--pending)" />
					</span>
					<p class="text-[15px] font-semibold" style="color: var(--pending)">Install Ledger</p>
				</div>
				<p class="mt-1.5 text-[13px] leading-relaxed" style="color: var(--ink-2)">
					In Safari, tap <strong style="color: var(--ink)">Share</strong> (the square with the
					arrow) and choose <strong style="color: var(--ink)">Add to Home Screen</strong>.
				</p>
				<button
					onclick={dismissInstall}
					class="btn btn-plain mt-2 px-4 py-2 text-[14px]"
					style="color: var(--ink-3)">Not now</button
				>
			</div>
		{/if}
	{/if}

	<a href="/w/{slug}/settings/appearance" class="press card flex items-center gap-3.5 p-4">
		<span
			class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
			style="background: color-mix(in oklab, var(--ws-accent) 18%, transparent)"
		>
			<Palette class="h-[18px] w-[18px]" style="color: var(--ws-accent)" />
		</span>
		<div class="flex-1">
			<p class="text-[15px] font-medium" style="color: var(--ink)">Appearance</p>
			<p class="text-[13px]" style="color: var(--ink-3)">Theme and the workspace accent</p>
		</div>
		<ChevronRight class="h-4 w-4" style="color: var(--ink-4)" />
	</a>

	<a href="/w/{slug}/settings/help" class="press card flex items-center gap-3.5 p-4">
		<span
			class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
			style="background: color-mix(in oklab, var(--ws-accent) 18%, transparent)"
		>
			<CircleHelp class="h-[18px] w-[18px]" style="color: var(--ws-accent)" />
		</span>
		<div class="flex-1">
			<p class="text-[15px] font-medium" style="color: var(--ink)">Help</p>
			<p class="text-[13px]" style="color: var(--ink-3)">Approvals, gift mode, buckets, budgets</p>
		</div>
		<ChevronRight class="h-4 w-4" style="color: var(--ink-4)" />
	</a>

	{#if data.member.role === 'owner'}
		<!--
			Danger zone. Collapsed by default so the delete control isn't sitting
			under your thumb during ordinary settings changes — you have to open it,
			type the exact name, and clear a confirm. Three deliberate acts for one
			irreversible one.
		-->
		<div
			class="card p-5"
			style="box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--deny) 30%, transparent)"
		>
			<p class="text-[15px] font-medium" style="color: var(--deny)">Danger zone</p>
			<p class="mt-0.5 text-[13px]" style="color: var(--ink-3)">
				Permanently removes {data.workspace.name}: every purchase, bucket, budget, and member. This
				cannot be undone.
			</p>

			{#if !confirmingDelete}
				<button
					onclick={armDelete}
					class="press mt-3.5 rounded-[var(--r-sm)] px-4 py-2 text-[14px] font-medium"
					style="color: var(--deny); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--deny) 40%, transparent)"
				>
					Delete this workspace…
				</button>
			{:else}
				<form
					method="POST"
					action="?/deleteWorkspace"
					use:submit={{
						confirm: `Delete ${data.workspace.name} and everything in it? This cannot be undone.`
					}}
					class="mt-3.5 space-y-3"
				>
					<input type="hidden" name="workspaceId" value={armedWorkspaceId} />
					<label class="block">
						<span class="text-[13px]" style="color: var(--ink-3)">
							Type <strong style="color: var(--ink)">{data.workspace.name}</strong> to confirm
						</span>
						<input
							name="confirmName"
							bind:value={deleteConfirmText}
							autocomplete="off"
							autocapitalize="off"
							spellcheck="false"
							class="field mt-1.5 text-[16px]"
							placeholder={data.workspace.name}
						/>
					</label>
					<div class="flex gap-2">
						<button
							disabled={deleteConfirmText.trim() !== data.workspace.name}
							class="press rounded-[var(--r-sm)] px-4 py-2 text-[14px] font-semibold text-white disabled:opacity-40"
							style="background: var(--deny)"
						>
							Delete forever
						</button>
						<button
							type="button"
							onclick={disarmDelete}
							class="press rounded-[var(--r-sm)] px-4 py-2 text-[14px]"
							style="color: var(--ink-3)"
						>
							Cancel
						</button>
					</div>
				</form>
			{/if}
		</div>
	{/if}

	<!-- One block, so the page's `space-y-4` spaces the footer as a whole and the
	     two lines keep their own tighter gap. -->
	<div class="pt-2 text-center">
		<p class="text-[12px]" style="color: var(--ink-3)">Ledger v{data.version}</p>
		<p class="mt-2 text-[12px]" style="color: var(--ink-4)">
			Made with ❤️ by <a
				href="https://github.com/zenatron"
				target="_blank"
				rel="noopener noreferrer"
				style="color: var(--accent-ink)">zenatron</a
			>
		</p>
	</div>
</div>
