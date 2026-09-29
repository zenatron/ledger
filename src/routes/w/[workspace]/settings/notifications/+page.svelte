<script lang="ts">
	import { untrack } from 'svelte';
	import Segmented from '$lib/components/Segmented.svelte';
	import { submit } from '$lib/actions/submit';
	import { page } from '$app/state';
	import {
		Antenna,
		Bell,
		ChevronLeft,
		CircleAlert,
		Newspaper,
		Route,
		Smartphone
	} from '@lucide/svelte';
	import Toggle from '$lib/components/Toggle.svelte';
	import SettingGroup from '$lib/components/SettingGroup.svelte';

	let { data, form } = $props();
	let slug = $derived(page.params.workspace);

	let permission: NotificationPermission | 'unsupported' = $state('unsupported');
	let subscribed = $state(false);
	let busy = $state(false);
	let pushError: string | null = $state(null);
	let showA2hs = $state(false);

	// Seeded once, deliberately: the form's draft. Re-seeded below after a save.
	let ntfyServerUrl = $state(untrack(() => data.ntfy.serverUrl));
	let ntfyTopic = $state(untrack(() => data.ntfy.topic));

	// Re-sync from server only after a successful ntfy save — never after a test
	// (which doesn't write) or on initial load (the $state init handles that).
	$effect(() => {
		if (form?.section !== 'ntfy' || !form.ok || form.tested) return;
		ntfyServerUrl = data.ntfy.serverUrl;
		ntfyTopic = data.ntfy.topic;
	});

	$effect(() => {
		const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
		const standalone =
			('standalone' in navigator && (navigator as { standalone?: boolean }).standalone === true) ||
			matchMedia('(display-mode: standalone)').matches;
		showA2hs = isIos && !standalone;

		if ('Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window) {
			permission = Notification.permission;
			navigator.serviceWorker.ready.then(async (reg) => {
				subscribed = (await reg.pushManager.getSubscription()) !== null;
			});
		}
	});

	async function enablePush() {
		if (!data.vapidPublicKey) return;
		busy = true;
		pushError = null;
		try {
			const result = await Notification.requestPermission();
			permission = result;
			if (result !== 'granted') return;
			const reg = await navigator.serviceWorker.ready;
			const sub = await reg.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: data.vapidPublicKey
			});
			const res = await fetch('/push', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(sub.toJSON())
			});
			if (!res.ok) throw new Error(`server said ${res.status}`);
			subscribed = true;
		} catch (e) {
			pushError = e instanceof Error ? e.message : 'Could not enable push';
		} finally {
			busy = false;
		}
	}

	async function disablePush() {
		busy = true;
		try {
			const reg = await navigator.serviceWorker.ready;
			const sub = await reg.pushManager.getSubscription();
			if (sub) {
				await fetch('/push', {
					method: 'DELETE',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ endpoint: sub.endpoint })
				});
				await sub.unsubscribe();
			}
			subscribed = false;
		} finally {
			busy = false;
		}
	}

	const isEnabled = (event: string, channel: string) =>
		!data.disabled.includes(`${event}:${channel}`);

	// ntfy delivers nothing until a topic is saved, so its column is inert until
	// then — showing it as tickable invited people to configure a dead channel.
	const ntfyConfigured = $derived(!data.ntfy.unsaved);
	// The server-side half of push. Without VAPID keys nothing can be delivered
	// on that channel by anyone, which is a different thing from this particular
	// browser not being subscribed.
	const pushConfigured = $derived(!!data.vapidPublicKey);

	/*
	 * The ntfy group's switch. On means "show me this channel's settings", which
	 * is true whenever a topic is already saved and stays true while you fill the
	 * form in. Off is only meaningful once something is stored, and then it means
	 * remove it — so it submits the removal the page already had a button for.
	 */
	let ntfyOpened = $state(false);
	let ntfyOffForm: HTMLFormElement | undefined = $state();
	const ntfyOn = $derived(ntfyConfigured || ntfyOpened);

	/*
	 * The summary group's switch. The cadence form submits on choice, so the
	 * switch reuses it: on picks a starting cadence, off writes 'off'. Doing it
	 * through the same action keeps one writer for one column.
	 */
	let summaryForm: HTMLFormElement | undefined = $state();
	let summarySwitchValue = $state('off');

	function setCadence(next: string) {
		summarySwitchValue = next;
		// After the binding has landed in the DOM, or the form would post the
		// previous value.
		queueMicrotask(() => summaryForm?.requestSubmit());
	}

	function turnNtfy(next: boolean) {
		if (next) {
			ntfyOpened = true;
			return;
		}
		ntfyOpened = false;
		if (ntfyConfigured) ntfyOffForm?.requestSubmit();
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
	<h1 class="px-1 text-[28px]">Notifications</h1>

	{#if showA2hs}
		<section
			class="card p-4"
			style="background: color-mix(in oklab, var(--pending) 12%, var(--surface))"
		>
			<h2
				class="flex items-center gap-2 font-[family-name:var(--font-sans)] text-[15px] font-semibold tracking-normal"
				style="color: var(--pending)"
			>
				<CircleAlert class="h-4 w-4" /> Install the app first
			</h2>
			<p class="mt-1.5 text-[13px] leading-relaxed" style="color: var(--ink-2)">
				On iPhone, notifications only work for installed apps. In Safari, tap
				<strong style="color: var(--ink)">Share</strong> (the square with the arrow) and choose
				<strong style="color: var(--ink)">Add to Home Screen</strong>, then open Ledger from your
				home screen and come back here.
			</p>
		</section>
	{/if}

	<!--
		The switch is the subscription. It used to be a button that said "Enable
		notifications" and, once pressed, a different button that said "Turn off on
		this device" — two shapes for one boolean, neither of which read as a
		setting. `onToggle` throwing is what makes it spring back when the browser
		refuses permission, which is the case that actually needed saying.
	-->
	{#if !data.vapidPublicKey || permission === 'unsupported' || permission === 'denied'}
		<section class="card p-5">
			<h2
				class="flex items-center gap-2 font-[family-name:var(--font-sans)] text-[16px] font-semibold tracking-normal"
				style="color: var(--ink)"
			>
				<Smartphone class="h-4 w-4" style="color: var(--ws-accent)" /> Push on this device
			</h2>
			<p class="mt-2 text-[14px]" style="color: var(--ink-3)">
				{#if !data.vapidPublicKey}
					Push is not configured on this server.
				{:else if permission === 'denied'}
					Notifications are blocked. Enable them in your browser settings.
				{:else}
					This browser doesn't support push{showA2hs ? ' until the app is installed' : ''}.
				{/if}
			</p>
		</section>
	{:else}
		<SettingGroup
			title="Push on this device"
			description="Get notified about approvals here."
			icon={Smartphone}
			on={subscribed}
			disabled={busy}
			onToggle={(next) => (next ? enablePush() : disablePush())}
		>
			<div class="flex flex-wrap items-center gap-2.5">
				<form method="POST" action="?/pushTest" use:submit={{ success: 'Test sent' }}>
					<button class="btn btn-ghost px-4 py-2 text-[14px]">Send test</button>
				</form>
				{#if data.subscriptionCount > 0}
					<span class="text-[12px]" style="color: var(--ink-3)">
						{data.subscriptionCount} device{data.subscriptionCount === 1 ? '' : 's'} registered
					</span>
				{/if}
			</div>
			{#if pushError}
				<p class="mt-2 text-[13px]" style="color: var(--deny)">{pushError}</p>
			{/if}
		</SettingGroup>
	{/if}

	<!--
		ntfy is optional and most households will never use it, so its server and
		topic fields no longer sit on the page for people who have said no to it.
		The switch means "I want this channel": on, the form appears; off, a
		configured topic is removed, which is the only way "off" can be true.
	-->
	<SettingGroup
		title="ntfy"
		description="Reliable delivery via the ntfy app. Subscribe to your topic there."
		icon={Antenna}
		on={ntfyOn}
		onToggle={turnNtfy}
	>
		<form method="POST" action="?/ntfy" use:submit class="space-y-3">
			<label class="block">
				<span class="text-[12px]" style="color: var(--ink-3)">Server</span>
				<input name="serverUrl" bind:value={ntfyServerUrl} class="field mt-1 text-[16px]" />
			</label>
			<label class="block">
				<span class="text-[12px]" style="color: var(--ink-3)">Topic (treat it like a password)</span
				>
				<input name="topic" bind:value={ntfyTopic} class="field mt-1 font-mono text-[16px]" />
			</label>
			<div class="flex flex-wrap items-center gap-2.5">
				<button class="btn btn-accent px-4 py-2 text-[14px]">Save</button>
				<button formaction="?/ntfyTest" class="btn btn-ghost px-4 py-2 text-[14px]"
					>Send test</button
				>
			</div>
		</form>
		{#if form?.section === 'ntfy'}
			{#if form.error}
				<p class="mt-2 text-[13px]" style="color: var(--deny)">{form.error}</p>
			{:else if form.tested}
				<p class="mt-2 text-[13px]" style="color: var(--approve)">Test sent. Check the ntfy app.</p>
			{:else}
				<p class="mt-2 text-[13px]" style="color: var(--approve)">Saved.</p>
			{/if}
		{/if}
	</SettingGroup>

	<!-- Turning ntfy off posts the existing removal action; kept out of the group
	     so the group's own children stay declarative. -->
	<form method="POST" action="?/ntfyOff" bind:this={ntfyOffForm} class="hidden"></form>

	<section class="card p-5">
		<h2
			class="flex items-center gap-2 font-[family-name:var(--font-sans)] text-[16px] font-semibold tracking-normal"
			style="color: var(--ink)"
		>
			<Route class="h-4 w-4" style="color: var(--ws-accent)" /> What to send where
		</h2>
		<form
			method="POST"
			action="?/prefs"
			use:submit={{ success: 'Preferences saved' }}
			class="mt-3.5"
		>
			<div class="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-1 text-[15px]">
				<span></span>
				<span
					class="w-11 text-center text-[12px] font-semibold"
					style="color: var(--ink-3); opacity: {pushConfigured ? 1 : 0.4}">Push</span
				>
				<span
					class="w-11 text-center text-[12px] font-semibold"
					style="color: var(--ink-3); opacity: {ntfyConfigured ? 1 : 0.4}">ntfy</span
				>
				{#each data.eventTypes as event, i (event.id)}
					<span
						class="py-1"
						style="color: var(--ink-2); {i > 0
							? 'box-shadow: inset 0 0.5px 0 var(--hairline);'
							: ''}">{event.label}</span
					>
					<!--
						Wrapped in labels purely for the tap target: the box itself is 17px,
						and these sit shoulder to shoulder in a dense grid, so bare inputs
						made it easy to toggle the wrong channel on a phone.
					-->
					<!-- Both columns are inert until their channel can actually deliver.
					     ntfy has always been; push was not, so a server with no VAPID
					     keys offered a full column of tickable boxes directly beneath a
					     card saying push is not configured. -->
					<label
						class="flex justify-center py-2 {pushConfigured ? 'cursor-pointer' : 'cursor-default'}"
						style="opacity: {pushConfigured ? 1 : 0.4}; {i > 0
							? 'box-shadow: inset 0 0.5px 0 var(--hairline)'
							: ''}"
					>
						<span class="sr-only">{event.label} (push)</span>
						<input
							type="checkbox"
							name="enabled"
							value="{event.id}:webpush"
							checked={pushConfigured && isEnabled(event.id, 'webpush')}
							disabled={!pushConfigured}
						/>
					</label>
					<label
						class="flex justify-center py-2 {ntfyConfigured ? 'cursor-pointer' : 'cursor-default'}"
						style="opacity: {ntfyConfigured ? 1 : 0.4}; {i > 0
							? 'box-shadow: inset 0 0.5px 0 var(--hairline)'
							: ''}"
					>
						<span class="sr-only">{event.label} (ntfy)</span>
						<input
							type="checkbox"
							name="enabled"
							value="{event.id}:ntfy"
							checked={ntfyConfigured && isEnabled(event.id, 'ntfy')}
							disabled={!ntfyConfigured}
						/>
					</label>
				{/each}
			</div>
			{#if !pushConfigured}
				<p class="mt-2 text-[12px]" style="color: var(--ink-3)">
					Push is not configured on this server, so that column can't deliver.
				</p>
			{/if}
			{#if !ntfyConfigured}
				<p class="mt-2 text-[12px]" style="color: var(--ink-3)">
					Save an ntfy topic above to send to that column.
				</p>
			{/if}
			<div class="mt-4 flex items-center gap-3">
				<button class="btn btn-accent px-4 py-2 text-[14px]">Save preferences</button>
				{#if form?.section === 'prefs' && form.ok}
					<span class="text-[14px]" style="color: var(--approve)">Saved.</span>
				{/if}
			</div>
		</form>
	</section>

	<!--
		Frequency, gated on wanting one at all. "Off" was a third segment beside
		Weekly and Monthly, which made the absence of a digest look like a kind of
		digest. Choosing still *is* the submit; the switch just decides whether
		there is anything to choose between.
	-->
	<SettingGroup
		title="Spending summary"
		description="A short digest of your spending, with your total, top category, and net, sent to your notifications. It's your own view, so sealed purchases stay hidden."
		icon={Newspaper}
		on={data.summaryCadence !== 'off'}
		onToggle={(next) => setCadence(next ? 'weekly' : 'off')}
	>
		{#snippet badge()}
			<span
				class="rounded-[var(--r-full)] px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.06em] uppercase"
				style="background: color-mix(in oklab, var(--pending) 16%, var(--surface)); color: var(--pending)"
				>Alpha</span
			>
		{/snippet}
		<form method="POST" action="?/summary" use:submit={{ success: 'Summary updated' }}>
			<Segmented
				options={[
					{ value: 'weekly', label: 'Weekly' },
					{ value: 'monthly', label: 'Monthly' }
				]}
				value={data.summaryCadence}
				submitName="cadence"
				fill={false}
				size="sm"
				label="How often"
				ariaLabel="Summary frequency"
			/>
			<p class="mt-2.5 text-[12px]" style="color: var(--ink-3)">
				Arrives at the start of each {data.summaryCadence === 'monthly' ? 'month' : 'week'}, for the
				one just ended.
			</p>
		</form>
	</SettingGroup>

	<!-- The switch's own writer, outside the group: the group renders its children
	     only when on, so a form living inside it could never turn it on. -->
	<form
		method="POST"
		action="?/summary"
		bind:this={summaryForm}
		use:submit={{ success: 'Summary updated' }}
		class="hidden"
	>
		<input type="hidden" name="cadence" bind:value={summarySwitchValue} />
	</form>

	<section class="card flex items-start justify-between gap-4 p-4">
		<div>
			<h2
				class="flex items-center gap-2 font-[family-name:var(--font-sans)] text-[16px] font-semibold tracking-normal"
				style="color: var(--ink)"
			>
				<Bell class="h-4 w-4" style="color: var(--ws-accent)" /> Safe-to-Spend alerts
			</h2>
			<p class="mt-0.5 text-[13px] leading-relaxed" style="color: var(--ink-3)">
				Notify each member when their month turns "tight" or "over", computed from their own
				seal-aware view.
			</p>
		</div>
		{#if data.isOwner}
			<Toggle
				on={data.safeToSpendAlertsEnabled}
				flag="safeToSpendAlertsEnabled"
				label="Toggle Safe-to-Spend alerts"
			/>
		{/if}
	</section>
</div>
