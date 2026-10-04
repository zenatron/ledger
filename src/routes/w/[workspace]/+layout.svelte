<script lang="ts">
	import DemoBanner from '$lib/components/DemoBanner.svelte';
	import { invalidateAll } from '$app/navigation';
	import { scale, slide } from 'svelte/transition';
	import { page, navigating } from '$app/state';
	import {
		Check,
		ChevronDown,
		Plus,
		Settings,
		CreditCard,
		ChartNoAxesColumnIncreasing,
		Repeat,
		CircleDollarSign
	} from '@lucide/svelte';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import CommandPaletteOverlay from '$lib/components/CommandPaletteOverlay.svelte';
	import { paletteOpen, close as closePalette } from '$lib/command-palette-state.svelte';
	import { dismiss } from '$lib/actions/dismiss';
	import { menu } from '$lib/actions/menu';
	import { toastError } from '$lib/toast-state.svelte';
	import { submitting } from '$lib/submit-state.svelte';
	import { accentFor } from '$lib/accent';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import { announcePageOwner } from '$lib/page-owner';

	let { data, children } = $props();

	let pathname = $derived(page.url.pathname);

	// Derive slug from the URL, not from data — data can be stale during
	// client-side navigation when SvelteKit reuses a layout component.
	let slug = $derived(page.params.workspace ?? '');

	// Derive workspace display name from the workspaces list using the URL slug,
	// because data.workspace.name from $props() can be stale during client-side nav.
	let wsName = $derived(
		data.workspaces.find((w: { slug: string }) => w.slug === slug)?.name ?? data.workspace.name
	);

	function isActive(section: string): boolean {
		const base = `/w/${slug}`;
		if (section === '') return pathname === base || pathname === `${base}/`;
		return pathname.startsWith(`${base}/${section}`);
	}

	// The command palette is global state, not page state, so it survives a
	// workspace switch — and its last answer is about the workspace you left.
	// Close it on switch so a stale response can't linger under the new URL.
	$effect(() => {
		void slug;
		closePalette();
	});

	$effect(() => {
		// The live-refresh stream needs a server to stream from. In the demo there
		// is one tab and one writer, and every write already invalidates on its way
		// out — so there is nothing to hear, and an EventSource here would just
		// retry a 404 forever.
		if (__DEMO__) return;

		const source = new EventSource(`/w/${slug}/events`);
		let t: ReturnType<typeof setTimeout> | undefined;
		// A purchase action publishes its SSE event before it finishes and then
		// redirects, so this same browser can receive the event mid-submit. Running
		// invalidateAll() then races the redirect and strands the progress bar (see
		// submit-state). Wait for the submit and any navigation to settle, then
		// refresh — the redirect already refreshes its own destination.
		//
		// A hidden tab only notes that it is behind. Every open page re-running
		// every load on every change was the whole cost of live refresh, and a
		// backgrounded tab — a PWA in the app switcher, a second browser tab —
		// paid it for a screen nobody was looking at. It catches up once, the
		// moment it is looked at again.
		let behind = false;
		const refresh = () => {
			if (document.hidden) {
				behind = true;
				return;
			}
			if (submitting.active || navigating.to) {
				t = setTimeout(refresh, 200);
				return;
			}
			behind = false;
			void invalidateAll();
		};
		source.onmessage = (e) => {
			if (e.data.includes('"hello"')) return;
			clearTimeout(t);
			t = setTimeout(refresh, 200);
		};
		const onVisible = () => {
			if (!document.hidden && behind) refresh();
		};
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			clearTimeout(t);
			document.removeEventListener('visibilitychange', onVisible);
			source.close();
		};
	});

	// The offline page cache is this person's; a different person signing in on
	// the same device empties it first. See page-owner.ts.
	$effect(() => {
		if (!__DEMO__) announcePageOwner(data.user.id);
	});

	$effect(() => {
		// No /push endpoint without a server, and nothing to push from.
		if (__DEMO__) return;
		if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
		if (Notification.permission !== 'granted') return;
		void navigator.serviceWorker.ready.then(async (reg) => {
			const sub = await reg.pushManager.getSubscription();
			if (!sub) return;
			try {
				const res = await fetch('/push', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(sub.toJSON())
				});
				if (!res.ok) throw new Error(String(res.status));
			} catch {
				// Silence here means notifications quietly stop arriving and the
				// settings page still claims they're on.
				toastError('Push notifications could not be re-registered');
			}
		});
	});

	// Svelte's JS transitions escape the CSS reduced-motion clamp, so the badge
	// checks for itself — the same concession Money.svelte makes.
	const reduceMotion =
		typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

	let showSwitcher = $state(false);
	// Measured, not guessed: the header's height varies with the safe-area inset,
	// and anything docking beneath it needs the real number.
	let headerH = $state(0);
	// The tab bar's real height, for the one screen that must end exactly at its
	// edge (the map). --nav-h is a reserve for scrolling pages and deliberately
	// generous; it is 28px taller than the bar without a home indicator.
	let navH = $state(0);

	/*
	 * Offline notice.
	 *
	 * The service worker serves navigations network-first with the last good copy
	 * as a fallback, so going offline doesn't break the app — it quietly freezes
	 * it. Without a word on screen that's worse than an error: the numbers still
	 * look authoritative, they're just not current, and this app's whole claim is
	 * that its numbers are honest. So say so, once, quietly.
	 *
	 * Seeded from navigator.onLine rather than assumed online: the app is often
	 * launched from the home screen with no connection, and the events only fire
	 * on a *change*.
	 */
	let offline = $state(false);
	$effect(() => {
		const sync = () => (offline = !navigator.onLine);
		sync();
		window.addEventListener('online', sync);
		window.addEventListener('offline', sync);
		return () => {
			window.removeEventListener('online', sync);
			window.removeEventListener('offline', sync);
		};
	});

	/*
	 * Hide the bottom bar while the on-screen keyboard is up.
	 *
	 * On iOS a position:fixed element is anchored to the *layout* viewport, but
	 * the keyboard only shrinks the *visual* viewport — so `bottom: 0` pins the
	 * bar to the bottom of the full-height page, behind the keyboard, and Safari
	 * shifts composited fixed elements during scroll, making it drift up and rest
	 * above the keyboard. You don't need the tab nav while typing anyway, so we
	 * detect the keyboard via visualViewport (the gap between it and the layout
	 * viewport) and translate the bar out of view until the keyboard closes.
	 *
	 * The measurement alone is not enough: iOS standalone PWAs intermittently
	 * swallow the resize event that reports the keyboard *closing*, which left
	 * keyboardOpen stuck true — the bar stayed hidden until the app was
	 * restarted. So focus acts as ground truth: the keyboard can only be up
	 * while a text field holds it, and any focus change, app return, or resize
	 * re-evaluates from that. Missed events then self-heal instead of wedging.
	 */
	let keyboardOpen = $state(false);
	$effect(() => {
		const vv = window.visualViewport;
		if (!vv) return;

		const textFieldFocused = () => {
			const el = document.activeElement;
			return (
				el instanceof HTMLElement &&
				(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
			);
		};

		const onChange = () => {
			// No text field focused → the keyboard cannot be open, whatever a
			// stale viewport measurement might still claim.
			if (!textFieldFocused()) {
				keyboardOpen = false;
				return;
			}
			// A gap this large is a keyboard, not browser chrome (which is < ~100px).
			keyboardOpen = window.innerHeight - vv.height > 140;
		};

		// activeElement can still point at the blurred field during focusout;
		// wait a frame so the new target (or none) is reflected.
		const onFocusOut = () => requestAnimationFrame(onChange);

		vv.addEventListener('resize', onChange);
		document.addEventListener('focusin', onChange);
		document.addEventListener('focusout', onFocusOut);
		document.addEventListener('visibilitychange', onChange);
		onChange();
		return () => {
			vv.removeEventListener('resize', onChange);
			document.removeEventListener('focusin', onChange);
			document.removeEventListener('focusout', onFocusOut);
			document.removeEventListener('visibilitychange', onChange);
		};
	});

	// Resolved from the workspaces list by URL slug, for the same reason as
	// wsName above: data.workspace lags during client-side navigation, so
	// reading it directly painted the new workspace in the old one's accent.
	const accent = $derived(
		accentFor(data.workspaces.find((w: { slug: string }) => w.slug === slug) ?? data.workspace)
	);

	/*
	 * The accent is set on the wrapper below, which is where every workspace
	 * screen reads it from. A few things live *outside* that wrapper though — the
	 * navigation progress bar sits in the root layout, above this one — and they
	 * were quietly falling back to the app's default red whatever the workspace
	 * was painted. So the same value is mirrored onto the document element, which
	 * nothing is outside of.
	 *
	 * Cleared on the way out, so the marketing page and the error page keep their
	 * own accent rather than inheriting the last workspace visited.
	 */
	$effect(() => {
		const root = document.documentElement;
		root.style.setProperty('--ws-accent-base', accent);
		root.style.setProperty(
			'--ws-accent',
			'light-dark(var(--ws-accent-base), color-mix(in oklch, var(--ws-accent-base), white 18%))'
		);
		root.style.setProperty('--accent', 'var(--ws-accent)');
		return () => {
			root.style.removeProperty('--ws-accent-base');
			root.style.removeProperty('--ws-accent');
			root.style.removeProperty('--accent');
		};
	});

	/*
	 * Four destinations either side of the new-purchase button, which sits in the
	 * middle where a thumb actually reaches.
	 *
	 * Recurring and buckets share "Plan": both are money already claimed before
	 * anything discretionary, so they read as one idea. Settings moved to the
	 * header — it's configuration, visited rarely, and it was occupying prime
	 * thumb real estate.
	 */
	const TAB_ICONS = {
		card: CreditCard,
		chart: ChartNoAxesColumnIncreasing,
		repeat: Repeat,
		dollar: CircleDollarSign
	};
	const tabs = [
		{ section: 'purchases', label: 'Ledger', icon: 'card', also: [] as string[] },
		// A tab stays lit on the pages it leads to: the statement and the map are
		// Activity's, the calendar is Plan's.
		{ section: 'analytics', label: 'Activity', icon: 'chart', also: ['statement'] },
		{ section: 'recurring', label: 'Plan', icon: 'repeat', also: ['buckets', 'calendar'] },
		{ section: 'income', label: 'Income', icon: 'dollar', also: [] as string[] }
	];
	const leftTabs = $derived(tabs.slice(0, 2));
	const rightTabs = $derived(tabs.slice(2));

	function tabActive(tab: { section: string; also: string[] }): boolean {
		return isActive(tab.section) || tab.also.some((s) => isActive(s));
	}

	/*
	 * Settings is the workspace root and everything reached from it: its own
	 * sub-pages and Reconcile. It used to match the root alone, so the gear went
	 * dark again the moment you opened any setting.
	 */
	function isSettings(): boolean {
		return isActive('') || isActive('settings') || isActive('reconcile');
	}
</script>

<svelte:head><title>{wsName} · Ledger</title></svelte:head>

<!--
	One tab. Labels are text, so they sit on the readable ink scale (--ink-3,
	≥ 4.5:1) at 11px; they used to be 10px on --ink-4, which is only for
	non-text marks. The icon keeps the quieter tone, so an inactive tab still
	recedes.

	The Ledger tab carries the decision queue: answering a request is the most
	common thing anyone opens this app to do, and the count said so nowhere
	outside the Ledger itself. Amber, the pending colour, because that is the
	state it counts.
-->
{#snippet tabLink(tab: (typeof tabs)[number])}
	{@const active = tabActive(tab)}
	{@const TabIcon = TAB_ICONS[tab.icon as keyof typeof TAB_ICONS]}
	{@const badge = tab.section === 'purchases' ? data.decisionCount : 0}
	<a
		href="/w/{slug}/{tab.section}"
		class="press flex flex-1 flex-col items-center gap-1 py-1 text-[11px]"
		style="color: {active ? 'var(--ws-accent)' : 'var(--ink-3)'}"
		aria-current={active ? 'page' : undefined}
		aria-label={badge > 0 ? `${tab.label}, ${badge} waiting on your decision` : undefined}
	>
		<span class="relative">
			<TabIcon class="h-[24px] w-[24px]" style={active ? undefined : 'color: var(--ink-4)'} />
			{#if badge > 0}
				<span
					class="tab-badge num"
					style="background: var(--pending); color: var(--paper)"
					aria-hidden="true"
					in:scale={{ duration: reduceMotion ? 0 : 160, start: 0.6 }}
					>{badge > 9 ? '9+' : badge}</span
				>
			{/if}
		</span>
		<span class="font-medium tracking-tight">{tab.label}</span>
	</a>
{/snippet}

{#key slug}
	<div
		class="min-h-viewport flex flex-col"
		style="--ws-accent-base: {accent}; --ws-accent: light-dark(var(--ws-accent-base), color-mix(in oklch, var(--ws-accent-base), white 18%)); --accent: var(--ws-accent); --header-h: {headerH}px; --nav-h: 5.75rem; --nav-real: {navH
			? `${navH}px`
			: 'var(--nav-h)'}"
	>
		{#if __DEMO__}
			<DemoBanner />
		{/if}
		<header
			bind:clientHeight={headerH}
			class="material sticky top-0 z-20"
			style="padding-top: max(env(safe-area-inset-top, 0px), 8px)"
		>
			<div class="relative mx-auto flex max-w-3xl items-center justify-between px-5 py-2.5">
				<button
					onclick={() => (showSwitcher = !showSwitcher)}
					onkeydown={(e) => {
						// Arrow opens, per the menu pattern: a keyboard user reaching the
						// trigger should never have to guess Enter is the only way in.
						if (!showSwitcher && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
							e.preventDefault();
							showSwitcher = true;
						}
					}}
					class="press flex items-center gap-2.5"
					aria-label="Switch workspace, currently {wsName}"
					aria-expanded={showSwitcher}
					aria-haspopup="menu"
				>
					<span
						class="flex h-7 w-7 items-center justify-center rounded-[8px] font-[family-name:var(--font-display)] text-[15px] font-bold text-white"
						style="background: light-dark(color-mix(in oklab, var(--ws-accent-base) 80%, black), var(--ws-accent-base))"
						>{wsName.charAt(0)}</span
					>
					<span class="max-w-[140px] truncate text-[17px] font-semibold" style="color: var(--ink)"
						>{wsName}</span
					>
					<ChevronDown
						class="h-3.5 w-3.5 shrink-0 transition-transform duration-200 {showSwitcher
							? 'rotate-180'
							: ''}"
					/>
				</button>
				<div class="flex items-center gap-2">
					{#if !__DEMO__}
						<CommandPalette />
					{/if}
					<a
						href="/w/{slug}"
						class="press flex h-8 w-8 items-center justify-center rounded-full"
						style="color: {isSettings()
							? 'var(--ws-accent)'
							: 'var(--ink-3)'}; background: {isSettings()
							? 'color-mix(in oklab, var(--ws-accent) 14%, transparent)'
							: 'transparent'}"
						aria-label="Settings"
						aria-current={isSettings() ? 'page' : undefined}
					>
						<Settings class="h-[20px] w-[20px]" />
					</a>
				</div>

				{#if showSwitcher}
					<div class="fixed inset-0 z-30" use:dismiss={() => (showSwitcher = false)}></div>
					<div
						class="material card-lg absolute top-full left-0 z-40 mt-1 w-64 overflow-hidden p-1.5"
						style="box-shadow: var(--shadow-float); background: var(--surface); backdrop-filter: saturate(1.4) blur(24px); -webkit-backdrop-filter: saturate(1.4) blur(24px)"
						role="menu"
						aria-label="Workspaces"
						use:menu
						onfocusout={(e) => {
							// Tab past the last item leaves the menu: close it, the way a
							// native menu does, rather than leaving a popover open behind
							// the keyboard cursor. A click on an item lands here first and
							// closes harmlessly before the navigation runs.
							if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
								showSwitcher = false;
							}
						}}
					>
						{#each data.workspaces as ws (ws.slug)}
							{@const active = ws.slug === slug}
							{@const wsAccent = accentFor(ws)}
							<a
								href="/w/{ws.slug}"
								onclick={() => (showSwitcher = false)}
								role="menuitem"
								aria-current={active ? 'true' : undefined}
								class="press flex w-full items-center gap-3 rounded-[14px] px-3 py-2.5"
								style={active
									? 'background: light-dark(color-mix(in oklab, var(--ink) 6%, transparent), color-mix(in oklab, var(--ink) 7%, transparent))'
									: ''}
							>
								<span
									class="flex h-8 w-8 items-center justify-center rounded-[9px] font-[family-name:var(--font-display)] text-[15px] font-bold text-white"
									style="background: light-dark(color-mix(in oklab, {wsAccent} 80%, black), {wsAccent})"
									>{ws.name.charAt(0)}</span
								>
								<span class="text-[17px]" style="color: var(--ink)">{ws.name}</span>
								{#if active}
									<Check class="ml-auto h-4 w-4" style="color: var(--ink)" />
								{/if}
							</a>
						{/each}
						{#if !__DEMO__}
							<div class="my-1 h-px" style="background: var(--hairline)"></div>
							<a
								href="/welcome"
								onclick={() => (showSwitcher = false)}
								role="menuitem"
								class="press flex w-full items-center gap-3 rounded-[14px] px-3 py-2.5"
							>
								<span
									class="flex h-8 w-8 items-center justify-center rounded-[10px]"
									style="box-shadow: inset 0 0 0 1.5px var(--hairline-strong)"
									><Plus class="h-4 w-4" style="color: var(--ink-3)" /></span
								>
								<span class="text-[17px]" style="color: var(--ink-3)">New workspace</span>
							</a>
						{/if}
					</div>
				{/if}
			</div>
			{#if offline}
				<!--
					Docked inside the header so it inherits the frosted material and moves
					with it, rather than pushing the page down and reflowing the ledger
					underneath. A statement, not an alarm: no icon, no colour beyond the
					muted pending tone, and it disappears the moment the connection returns.
				-->
				<div
					class="px-5 pb-2 text-center text-[12px]"
					style="color: var(--pending)"
					role="status"
					transition:slide={{ duration: 180 }}
				>
					Offline. Showing what was last loaded.
				</div>
			{/if}
		</header>

		<!--
			overflow-x: clip contains anything that translates sideways — the Activity
			swipe moves its card right, which otherwise added ~74px of document width.
			On a phone that widens the layout viewport and the PWA zooms out to fit,
			so dragging back in time visibly shrank the whole app.

			Applied here rather than on <html>: overflow on the root element is
			propagated to the viewport, and there `clip` still let the page pan.
			`clip` not `hidden`, so overflow-y stays visible and the page keeps
			scrolling normally.
		-->
		<main
			class="mx-auto w-full max-w-3xl flex-1 px-4 pt-3"
			style="overflow-x: clip; padding-bottom: calc(var(--nav-h) + env(safe-area-inset-bottom, 0px))"
		>
			{@render children()}
		</main>

		{#if paletteOpen.value}
			<CommandPaletteOverlay
				currency={data.workspace.currency}
				assistEnabled={data.workspace.assistEnabled}
			/>
		{/if}

		<!-- Bottom tab bar. Compositing + keyboard-hide behavior is in <style> below. -->
		<nav
			bind:clientHeight={navH}
			class="material fixed right-0 bottom-0 left-0 z-20"
			class:kb-hidden={keyboardOpen}
			aria-hidden={keyboardOpen}
			style="padding-bottom: max(env(safe-area-inset-bottom, 0px), 6px); box-shadow: 0 -0.5px 0 var(--hairline)"
		>
			<div class="mx-auto flex max-w-3xl items-start justify-around px-2 pt-1.5">
				{#each leftTabs as tab (tab.section)}
					{@render tabLink(tab)}
				{/each}

				<!--
					An action, not a destination — so it looks like one: raised out of
					the bar, filled with the workspace accent, no label competing with
					the tab words either side.
				-->
				<a
					href="/w/{slug}/purchases/new"
					class="press flex flex-1 flex-col items-center"
					aria-label="New purchase"
				>
					<span
						class="flex h-[52px] w-[52px] -translate-y-3 items-center justify-center rounded-full text-white"
						style="background: var(--ws-accent); box-shadow: 0 6px 16px -4px color-mix(in oklab, var(--ws-accent) 55%, transparent), 0 1px 2px light-dark(oklch(0.28 0.03 65 / 0.18), oklch(0 0 0 / 0.55)); outline: 3px solid var(--paper)"
					>
						<Plus class="h-6 w-6" />
					</span>
				</a>

				{#each rightTabs as tab (tab.section)}
					{@render tabLink(tab)}
				{/each}
			</div>
		</nav>
	</div>
{/key}

<ConfirmDialog />

<style>
	/*
		translateZ(0) is load-bearing, not decoration: the bar is position:fixed and
		carries a backdrop-filter (.material), a pairing iOS Safari detaches during
		momentum scroll. Its own compositing layer keeps it pinned.
	*/
	nav {
		transform: translateZ(0);
		transition:
			transform 0.2s ease,
			opacity 0.2s ease,
			visibility 0.2s;
	}
	/*
		Keyboard up: slide the bar down AND stop rendering it (opacity + visibility).
		The translate alone isn't enough — the middle "+" is a raised FAB that
		overflows the top of the nav's box, so sliding down by the nav's own height
		leaves that overhang on screen, peeking above the keyboard. opacity +
		visibility removes it regardless of the FAB's geometry; visibility is
		transitioned so it flips to hidden only after the fade completes.
	*/
	/* Sits on the icon's corner, ringed in paper so it reads as a separate
	   mark on the frosted bar rather than a blot on the glyph. */
	.tab-badge {
		position: absolute;
		top: -5px;
		right: -9px;
		min-width: 17px;
		height: 17px;
		padding: 0 4px;
		border-radius: var(--r-full);
		font-size: 11px;
		font-weight: 700;
		line-height: 17px;
		text-align: center;
		box-shadow: 0 0 0 2px var(--paper);
	}
	nav.kb-hidden {
		transform: translateY(100%);
		opacity: 0;
		visibility: hidden;
		pointer-events: none;
	}
</style>
