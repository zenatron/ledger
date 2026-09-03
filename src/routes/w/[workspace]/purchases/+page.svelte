<script lang="ts">
	import { page } from '$app/state';
	import { onMount, untrack } from 'svelte';
	import { scale, fade, slide } from 'svelte/transition';
	import {
		Check,
		ChevronDown,
		CircleHelp,
		Eye,
		EyeOff,
		Funnel,
		Landmark,
		Lock,
		Moon,
		RotateCcw,
		Search,
		ShoppingBag,
		Sparkles,
		X
	} from '@lucide/svelte';
	import Money from '$lib/components/Money.svelte';
	import SkeletonHero from '$lib/components/SkeletonHero.svelte';
	import SkeletonRow from '$lib/components/SkeletonRow.svelte';
	import { dismiss } from '$lib/actions/dismiss';
	import { modal } from '$lib/actions/modal';
	import { swipe } from '$lib/actions/swipe';
	import { submit } from '$lib/actions/submit';
	import type { ConfirmSpec } from '$lib/confirm-state.svelte';
	import { goto } from '$app/navigation';
	import { formatMinor } from '$lib/money-format';
	import { narrateSafeToSpend } from '$lib/domain/forecast/safe-to-spend';
	import { maskAmount } from '$lib/domain/visibility/discretion';
	import { NO_CATEGORY } from '$lib/ledger-filters';
	import { toastError } from '$lib/toast-state.svelte';
	let { data } = $props();
	let slug = $derived(page.params.workspace);

	// The slow pieces of the load arrive as streamed promises (see handlers.ts):
	// the shell paints at once, and each promise swaps its skeleton for real
	// content as it lands. `Awaited` unwraps each to what the page renders.
	type Feed = Awaited<typeof data.feed>;
	type Entry = Feed['entries'][number];
	type Forecast = Awaited<typeof data.forecast>;
	type Runway = Awaited<typeof data.runway>;

	/*
	 * Search and category live in the URL, like `movements`. Filtering used to
	 * happen client-side over whatever had been fetched, which meant it searched
	 * the loaded page rather than the workspace, and "Show more" had to be hidden
	 * whenever a filter was on because paging filtered results was incoherent.
	 */
	let search = $state(page.url.searchParams.get('q') ?? '');
	const category = $derived(page.url.searchParams.get('category') ?? '');
	const member = $derived(page.url.searchParams.get('member') ?? '');
	const from = $derived(page.url.searchParams.get('from') ?? '');
	const to = $derived(page.url.searchParams.get('to') ?? '');
	const bbox = $derived(page.url.searchParams.get('bbox') ?? '');
	const activeQuery = $derived(page.url.searchParams.get('q') ?? '');
	let showFilter = $state(false);

	// Filter-chip states. Selected = ink fill / paper text (ink is the primary
	// action color in this theme); unselected = hairline outline on surface-2.
	const SELECTED =
		'color: var(--paper); background: var(--ink); box-shadow: none; font-weight: 600';
	const UNSELECTED =
		'color: var(--ink-2); background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--hairline); font-weight: 500';
	let loadingMore = $state(false);

	/*
	 * The chips below the search box, one per active filter. You can arrive here
	 * from a figure on the analytics page, so the list is often already narrowed
	 * before you've touched anything — without a visible, removable account of
	 * why, a filtered ledger just looks like a ledger that lost your data.
	 */
	const activeFilters = $derived.by(() => {
		const out: { key: string; label: string; clear: Record<string, string> }[] = [];
		if (from || to) {
			out.push({
				key: 'date',
				label:
					from && to
						? `${fmtDay(from)} – ${fmtDay(to)}`
						: from
							? `From ${fmtDay(from)}`
							: `Until ${fmtDay(to)}`,
				clear: { from: '', to: '', basis: '' }
			});
		}
		if (member) {
			const name = data.members.find((m) => m.id === member)?.name ?? 'Member';
			out.push({ key: 'member', label: name, clear: { member: '' } });
		}
		if (category) {
			const name =
				category === NO_CATEGORY
					? 'Other'
					: (data.categories.find((c) => c.id === category)?.name ?? 'Category');
			out.push({ key: 'category', label: name, clear: { category: '' } });
		}
		// Arriving from a bubble on the map or a "By place" row narrows the list
		// hard — often to three rows out of a month. Without a chip naming it, that
		// reads as a ledger that lost your data. The server also drops bucket
		// movements while a bbox is on (nobody stood anywhere to set money aside),
		// so clearing it puts them back.
		if (bbox) {
			out.push({
				key: 'bbox',
				label: placeLabel ?? 'On the map',
				clear: { bbox: '' }
			});
		}
		return out;
	});

	const hasFilters = $derived(activeFilters.length > 0);

	let items = $state<Entry[]>([]);
	let hasMore = $state(false);
	// The count of everything matching the current filters, from the server.
	// Deliberately not items.length: that's the number *loaded*, which grew every
	// time you tapped "Show more" and under-reported until you did.
	let total = $state(0);
	// The bbox chip's label, read off the rows the resolved feed actually returned.
	let placeLabel = $state<string | null>(null);

	/*
	 * Each streamed piece carries its own "still arriving" flag. An empty array
	 * is a meaningful *resolved* answer — nothing pending, nothing held — so the
	 * emptiness of the data alone can't stand in for "loading".
	 */
	let feedPending = $state(true);
	let awaitingPending = $state(true);
	let sleepingPending = $state(true);
	let awaitingRows = $state<Entry[]>([]);
	let sleepingRows = $state<Entry[]>([]);
	let f = $state<Forecast | undefined>(undefined);
	let runway = $state<Runway | undefined>(undefined);
	// A failed forecast quietly hides the hero rather than leaving a skeleton
	// frozen mid-print; a failed feed toasts, like "Show more" does.
	let forecastFailed = $state(false);

	// Consume the streamed promises, re-seeding on every load — not just the
	// first paint. An SSE invalidation or a filter change hands us fresh
	// promises, and the paginated `items` array is what renders, so replacing it
	// wholesale is what kept live updates from freezing stale rows. The run
	// token discards callbacks from a superseded load arriving late.
	//
	// While a promise is pending, whatever was already on screen stays (stale
	// while re-validate) — a skeleton is only for when there is genuinely
	// nothing to show yet.
	let runToken = 0;
	$effect(() => {
		const run = ++runToken;
		feedPending = true;
		awaitingPending = true;
		sleepingPending = true;
		forecastFailed = false;
		data.feed.then(
			(v) => {
				if (run !== runToken) return;
				items = [...v.entries];
				hasMore = v.hasMore;
				total = v.total;
				placeLabel = v.placeLabel;
				feedPending = false;
			},
			() => {
				if (run !== runToken) return;
				feedPending = false;
				toastError("Couldn't load the ledger");
			}
		);
		data.awaiting.then(
			(v) => {
				if (run !== runToken) return;
				awaitingRows = v;
				awaitingPending = false;
			},
			() => {
				if (run !== runToken) return;
				awaitingPending = false;
			}
		);
		data.sleeping.then(
			(v) => {
				if (run !== runToken) return;
				sleepingRows = v;
				sleepingPending = false;
			},
			() => {
				if (run !== runToken) return;
				sleepingPending = false;
			}
		);
		data.forecast.then(
			(v) => {
				if (run !== runToken) return;
				f = v;
			},
			() => {
				if (run !== runToken) return;
				forecastFailed = true;
			}
		);
		// The months-after projection is optional garnish: a failure just leaves
		// the breakdown without it.
		void data.runway.then(
			(v) => {
				if (run !== runToken) return;
				runway = v;
			},
			() => {}
		);
	});

	/*
	 * The q the URL is expected to hold, as far as this component is concerned.
	 *
	 * The box has to follow the URL when someone presses back or clears — but the
	 * URL is *also* written by our own debounced search, and those two cases used
	 * to be indistinguishable. Typing raced itself: "coffee" typed quickly fired a
	 * navigation for "coff", and when that landed a moment later the box was
	 * written back to "coff", eating the letters typed in between. The faster you
	 * typed, the more it ate.
	 *
	 * Recording what we sent lets the effect ignore the echo of our own write and
	 * react only to a change that came from somewhere else.
	 */
	let knownQuery = page.url.searchParams.get('q') ?? '';

	// Keep the box in step when the URL changes underneath it — back button,
	// or the clear affordance. Never when the change was ours.
	$effect(() => {
		const fromUrl = activeQuery;
		if (fromUrl === knownQuery) return;
		knownQuery = fromUrl;
		if (fromUrl !== untrack(() => search)) search = fromUrl;
	});

	const isPurchase = (e: Entry): e is Extract<Entry, { kind: 'purchase' }> => e.kind === 'purchase';

	/** The server already filtered; the client only groups. */
	const filtered = $derived(items);

	function navigateWith(changes: Record<string, string>, opts: { replace?: boolean } = {}) {
		const next = new URL(page.url);
		for (const [k, v] of Object.entries(changes)) {
			if (v) next.searchParams.set(k, v);
			else next.searchParams.delete(k);
		}
		return goto(next, {
			noScroll: true,
			keepFocus: true,
			replaceState: opts.replace ?? false
		});
	}

	// Debounced so typing doesn't fire a request per keystroke, and replaces
	// history so the back button doesn't walk letter by letter.
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	function onSearchInput() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			// Claim the value before navigating, so the URL settling on it is
			// recognised as our own echo rather than an external change.
			knownQuery = search;
			void navigateWith({ q: search }, { replace: true });
		}, 250);
	}

	// These commit a filter but leave the modal open, so you can stack a date, a
	// member and a category in one visit and see each selection land. The modal
	// closes on Done / dismiss, not on each pick.
	function pickCategory(id: string) {
		void navigateWith({ category: id });
	}

	function pickMember(id: string) {
		void navigateWith({ member: id });
	}

	/*
	 * Changing a date by hand drops the spend basis. The basis is only ever set
	 * by a drill-through link, and it means "the rows behind that figure"; once
	 * you move the window yourself you are no longer looking at that figure, and
	 * silently keeping a stricter filter would hide pending rows for no reason
	 * you could see.
	 */
	function setRange(next: { from?: string; to?: string }) {
		void navigateWith({ ...next, basis: '' });
	}

	function clearFilters() {
		void navigateWith({ category: '', member: '', from: '', to: '', basis: '' });
	}

	// The "Bucket activity" toggle is remembered per user: it's a lasting
	// preference about how you read the ledger, not a per-visit filter.
	// Persisted to the DB so it follows you across devices; localStorage is a
	// fast cache for the initial mount before the server round-trip completes.
	const MOVEMENTS_KEY = 'ledger-movements';

	/** Reloads from the server: it changes what gets paged over, not just shown. */
	function toggleMovements() {
		const next = data.includeMovements ? '' : '1';
		const on = next === '1';
		try {
			localStorage.setItem(MOVEMENTS_KEY, on ? '1' : '0');
		} catch {
			/* storage unavailable — still applies for this session */
		}
		// Persist to the server in the background — fire-and-forget so the toggle
		// feels instant; the server-side load already reads from the DB so the
		// next page load naturally reflects the saved value.
		fetch(`/w/${page.params.workspace}/settings/member-flag`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ flag: 'includeLedgerMovements', value: on })
		}).catch(() => {
			/* silent — preference didn't save, but the toggle already moved */
		});
		void navigateWith({ movements: next });
	}

	// Apply the stored preference on first load, unless the URL already says
	// (e.g. a shared or drill-through link, which wins and updates the pref).
	onMount(() => {
		try {
			if (page.url.searchParams.has('movements')) {
				localStorage.setItem(MOVEMENTS_KEY, data.includeMovements ? '1' : '0');
			} else if (localStorage.getItem(MOVEMENTS_KEY) === '1') {
				void navigateWith({ movements: '1' }, { replace: true });
			}
		} catch {
			/* storage unavailable — no persistence this session */
		}
	});

	function clearSearch() {
		search = '';
		clearTimeout(searchTimer);
		searchTimer = undefined;
		knownQuery = '';
		void navigateWith({ q: '' }, { replace: true });
	}

	const stateVar: Record<string, string> = {
		pending_approval: '--pending',
		approved: '--approve',
		denied: '--deny',
		refunded: '--info',
		held: '--seal',
		cancelled: '--ink-4',
		draft: '--ink-4'
	};
	const stateLabel: Record<string, string> = {
		pending_approval: 'Pending',
		approved: 'Approved',
		denied: 'Denied',
		refunded: 'Refunded',
		held: 'Sleeping',
		cancelled: 'Cancelled',
		draft: 'Draft'
	};

	type P = Extract<Entry, { kind: 'purchase' }>;
	const pending = $derived(
		filtered.filter((e): e is P => isPurchase(e) && e.state === 'pending_approval')
	);

	// Confirmation shown before a swipe-to-decide finalizes — it surfaces the
	// requester's note so the approver sees the reason before committing.
	function decideBody(p: P): string {
		const head = `${p.itemName} · ${formatMinor(p.amountMinor, p.currency)} · ${p.requesterName}`;
		return p.note ? `${head}\n“${p.note}”` : `${head}\nNo note provided.`;
	}
	function approveSpec(p: P): ConfirmSpec {
		return { title: 'Approve this request?', body: decideBody(p), confirmLabel: 'Approve' };
	}
	function denySpec(p: P): ConfirmSpec {
		return {
			title: 'Deny this request?',
			body: decideBody(p),
			confirmLabel: 'Deny',
			tone: 'danger'
		};
	}

	/*
	 * "Confirm what you paid": your approved-but-unconfirmed purchases, served
	 * whole (not from the paged feed) so an old backfilled one can't be missed.
	 * Only shown on the default view — under a search or filter you want raw
	 * results, not a standing to-do header — and there, those rows are left to
	 * appear in Recent normally instead.
	 */
	// Filter to purchase-kind so the row snippet's type narrows; the server only
	// ever puts purchases here, this just tells the compiler that.
	const confirmItems = $derived(awaitingRows.filter(isPurchase));
	const showConfirm = $derived(!hasFilters && !activeQuery && confirmItems.length > 0);
	// "Sleep on it": paused requests, served whole like the confirm to-do.
	const sleepingItems = $derived(sleepingRows.filter(isPurchase));
	const showSleeping = $derived(!hasFilters && !activeQuery && sleepingItems.length > 0);
	const rest = $derived(
		filtered.filter((e) => {
			if (isPurchase(e) && e.state === 'pending_approval') return false;
			if (showSleeping && isPurchase(e) && e.state === 'held') return false;
			if (showConfirm && isPurchase(e) && e.state === 'approved' && e.mine) return false;
			return true;
		})
	);

	/** "3 days left" · "tomorrow" · "ready". */
	function heldLeft(iso: string | null): string {
		if (!iso) return '';
		const ms = new Date(iso).getTime() - Date.now();
		if (ms <= 0) return 'ready';
		const days = Math.ceil(ms / 86_400_000);
		return days <= 1 ? 'tomorrow' : `${days} days left`;
	}

	// Harmony's Safe to Spend — the hero. Always visible, even under search and
	// filters: the number is a whole-month figure regardless, and hiding it made
	// the whole page jump — on PWA the focused search field could be pulled out
	// from under the user mid-typing. (`f` arrives on the streamed forecast
	// promise; until it lands the card holds SkeletonHero's shape.)

	// Svelte JS transitions escape the global reduced-motion clamp in CSS, so
	// they read the query themselves — the same concession Money.svelte makes.
	const reduceMotion =
		typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

	// The months after this one (`runway`, streamed): projected free cash, shown
	// inside the expanded breakdown. Every figure is a projection; the caption
	// says so. Gated on the member's own preference as well as on there being
	// anything to show: a projection is a different question from "what's left
	// this month", and not everyone wants the second answer attached to the first.
	const runwayHasSignal = $derived(
		data.showRunwayMonths &&
			(runway?.months.some(
				(m) => m.incomeMinor !== 0n || m.billsMinor !== 0n || m.savingsMinor !== 0n
			) ??
				false)
	);
	const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	function monthLabel(m: { y: number; m: number }, originY: number): string {
		// Append a short year only when the horizon crosses into a new one.
		const rollsYear = originY !== m.y;
		return `${MON[m.m - 1]}${rollsYear ? ` ’${String(m.y).slice(2)}` : ''}`;
	}
	const runwaySummary = $derived.by(() => {
		if (!runway || !runwayHasSignal) return '';
		const originY = runway.months[0].month.y;
		if (runway.firstShortMonth) return `Tight in ${monthLabel(runway.firstShortMonth, originY)}`;
		const last = runway.months[runway.months.length - 1];
		return `On track through ${monthLabel(last.month, originY)}`;
	});

	/*
	 * Discretion. The one number on this page that reads across a café from the
	 * next table, so it's the one you get to turn down: shown, masked until you
	 * ask, or off entirely. Per member and persisted — see
	 * $lib/domain/visibility/discretion.
	 *
	 * Set in Settings → Harmony, not here. It lived in this page's filter sheet,
	 * which put a durable preference among the transient ones: everything else in
	 * that sheet resets when you leave, and this does not. The momentary reveal
	 * below is the part that genuinely belongs to the page, and it stays.
	 */
	const display = $derived(data.safeToSpendDisplay);
	// A momentary reveal, deliberately *not* persisted: leaving the ledger and
	// coming back re-hides the number, which is the whole point of asking for it.
	let revealed = $state(false);
	const showForecast = $derived(display !== 'off' && !forecastFailed);
	const masked = $derived(display === 'masked' && !revealed);
	/** Formats an amount inside the card, honouring the mask. */
	const amt = $derived((minor: bigint) =>
		masked ? maskAmount(formatMinor(minor, data.currency)) : formatMinor(minor, data.currency)
	);

	// The runway waterfall unfolds in place: income minus everything already
	// spent, promised, and set aside, arriving at the free number above.
	let showRunway = $state(false);
	// Harmony's read of the number — deterministic interpretation, not an LLM call.
	// Null only while the forecast is still streaming in.
	const narration = $derived(
		f ? narrateSafeToSpend(f, (m) => formatMinor(m, data.currency)) : null
	);
	const narrationColor = $derived(
		narration?.tone === 'over'
			? 'var(--deny)'
			: narration?.tone === 'tight' || narration?.tone === 'budget'
				? 'var(--pending)'
				: 'var(--ink-3)'
	);
	/** "Jul 31" — the last day of the horizon month. */
	function monthEndLabel(forecast: Forecast): string {
		const t = forecast.horizon.toExclusive; // first of next month
		const last = new Date(Date.UTC(t.y, t.m - 1, 1) - 86_400_000);
		return last.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
	}

	async function loadMore() {
		if (loadingMore) return;
		loadingMore = true;
		try {
			// One-shot fetch URL, not reactive state. It carries the page's whole
			// query so the next page is filtered exactly like the first — copying
			// the current params is what keeps that true as filters are added,
			// rather than a hand-maintained list that silently falls behind.
			// Built as string pairs rather than a URLSearchParams instance: this is a
			// throwaway value read once, and a mutable URLSearchParams in component
			// scope is the reactivity footgun svelte/prefer-svelte-reactivity warns
			// about.
			const qs = [...page.url.searchParams.entries()]
				.filter(([k]) => k !== 'offset')
				.concat([['offset', String(items.length)]])
				.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
				.join('&');
			const res = await fetch(`/w/${slug}/purchases/data?${qs}`);
			if (!res.ok) throw new Error(String(res.status));
			const json = await res.json();
			items = [...items, ...json.entries];
			hasMore = json.hasMore;
			if (typeof json.total === 'number') total = json.total;
		} catch {
			// Failing silently left "Show more" looking like a no-op button.
			toastError("Couldn't load more");
		}
		loadingMore = false;
	}

	function fmtDate(iso: string): string {
		return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}

	/** "2026-06-01" -> "Jun 1". Parsed as parts, not Date: `new Date('2026-06-01')`
	 *  is UTC midnight, which renders as the day before west of Greenwich. */
	function fmtDay(ymd: string): string {
		const [y, m, d] = ymd.split('-').map(Number);
		return new Date(y, m - 1, d).toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric'
		});
	}
</script>

{#snippet movementRow(m: Extract<Entry, { kind: 'movement' }>, last: boolean)}
	<!--
		Deliberately quieter than a purchase. An accrual isn't spending — it's your
		own money moving sideways — and giving it equal weight would dilute what
		the page is for.
	-->
	<a
		href="/w/{slug}/buckets"
		class="press flex items-center gap-3 px-1 py-2.5 {last ? '' : 'hairline'}"
	>
		<span
			class="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px]"
			style="background: color-mix(in oklab, {m.bucketColor ??
				'var(--seal)'} 14%, var(--surface-2))"
		>
			<Landmark class="h-[16px] w-[16px]" style="color: {m.bucketColor ?? 'var(--seal)'}" />
		</span>
		<div class="min-w-0 flex-1">
			<!-- Read the direction off the sign, not the type. A refund against a
			     bucket-charged purchase is a credit stored as a 'withdrawal' row, and
			     labelling it "Taken from" next to a +$40 was simply untrue. -->
			<p class="truncate text-[15px]" style="color: var(--ink-2)">
				{m.amountMinor < 0n ? 'Taken from' : m.type === 'accrual' ? 'Set aside' : 'Added to'}
				{m.bucketName}
			</p>
			<p class="mt-0.5 text-[13px]" style="color: var(--ink-3)">
				{m.note ?? 'Bucket'} · {fmtDate(m.at)}
			</p>
		</div>
		<span class="num shrink-0 text-[15px]" style="color: var(--ink-3)">
			{m.amountMinor >= 0n ? '+' : ''}{formatMinor(m.amountMinor, m.currency)}
		</span>
	</a>
{/snippet}

{#snippet row(p: P, last: boolean)}
	<!-- Swipe left to reveal a row's primary action: Approve/Deny for a pending
	     request you can decide, or Confirm for your own approved-but-unconfirmed
	     charge. Deciding shows a confirmation with the requester's note first;
	     Confirm opens the detail page to enter what you actually paid. -->
	{@const decide = p.state === 'pending_approval' && p.canDecide}
	{@const confirm = p.state === 'approved' && p.mine}
	{@const swipeW = decide ? 176 : confirm ? 116 : 0}
	<div
		class="relative overflow-hidden {last ? '' : 'hairline'}"
		use:swipe={{ width: swipeW, enabled: swipeW > 0 }}
	>
		{#if decide}
			<div class="absolute inset-y-0 right-0 z-0 flex">
				<form
					method="POST"
					action="/w/{slug}/purchases/{p.id}?/deny"
					use:submit={{ confirm: denySpec(p), success: 'Denied' }}
					class="contents"
				>
					<button
						class="press flex h-full w-[88px] flex-col items-center justify-center gap-1 text-[13px] font-semibold"
						style="background: var(--deny); color: var(--paper)"
					>
						<X class="h-4 w-4" /> Deny
					</button>
				</form>
				<form
					method="POST"
					action="/w/{slug}/purchases/{p.id}?/approve"
					use:submit={{ confirm: approveSpec(p), success: 'Approved' }}
					class="contents"
				>
					<button
						class="press flex h-full w-[88px] flex-col items-center justify-center gap-1 text-[13px] font-semibold"
						style="background: var(--approve); color: var(--paper)"
					>
						<Check class="h-4 w-4" /> Approve
					</button>
				</form>
			</div>
		{:else if confirm}
			<a
				href="/w/{slug}/purchases/{p.id}"
				class="absolute inset-y-0 right-0 z-0 flex items-center gap-1.5 pr-4 pl-5 text-[14px] font-semibold"
				style="background: var(--approve); color: var(--paper)"
			>
				<Check class="h-4 w-4" /> Confirm
			</a>
		{/if}
		<a
			href="/w/{slug}/purchases/{p.id}"
			data-swipe-content
			class="press relative z-10 flex items-center gap-3 px-1 py-3"
			style="view-transition-name: vt-card-{p.id}; background: var(--paper); touch-action: pan-y"
		>
			<!--
			A refund borrows the original purchase's photo and dims it under a
			reversal arrow: you recognize the item at a glance, and it can't be
			mistaken for a second purchase of the same thing. With no original
			photo, the arrow stands in for the generic bag.
		-->
			{#if p.thumbBlobId}
				<span class="relative h-10 w-10 shrink-0">
					<!--
					Cropped from the top, not the centre. At 40px a letterboxed thumb
					would shrink the content to nothing, so the square crop stays — but
					receipts, bills and product shots all carry the identifying thing
					(logo, vendor, item) at the top, and centre-cropping a receipt
					showed a band of blank paper.
				-->
					<img
						src="/w/{slug}/blobs/{p.thumbBlobId}"
						alt=""
						class="h-10 w-10 rounded-[12px] object-cover object-top"
						style="box-shadow: inset 0 0 0 0.5px var(--hairline); {p.isRefund
							? 'filter: grayscale(0.45) brightness(0.82)'
							: ''}"
					/>
					{#if p.isRefund}
						<span class="absolute inset-0 flex items-center justify-center">
							<RotateCcw class="h-[18px] w-[18px] text-white drop-shadow" />
						</span>
					{/if}
				</span>
			{:else}
				<span
					class="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] text-[18px]"
					style="background: var(--surface-2); box-shadow: inset 0 0 0 0.5px var(--hairline)"
				>
					{#if p.isRefund}
						<RotateCcw class="h-[18px] w-[18px]" style="color: var(--ink-4)" />
					{:else}
						<ShoppingBag class="h-[18px] w-[18px]" style="color: var(--ink-4)" />
					{/if}
				</span>
			{/if}
			<div class="min-w-0 flex-1">
				<div class="flex items-center gap-1.5">
					<span class="truncate text-[16px] font-medium" style="color: var(--ink)"
						>{p.itemName}</span
					>
					{#if p.sealed}
						<span
							role="img"
							title="Sealed: hidden from some members"
							aria-label="Sealed: hidden from some members"
							class="contents"
						>
							<Lock class="h-3 w-3 shrink-0" style="color: var(--seal)" />
						</span>
					{/if}
				</div>
				<div class="mt-0.5 flex items-center gap-1.5 text-[13px]" style="color: var(--ink-3)">
					{#if p.categoryIcon}<span>{p.categoryIcon}</span>{/if}
					<span>{p.requesterName}</span>
					<span>· {fmtDate(p.at)}</span>
					{#if p.state === 'pending_approval' && p.waitingDays > 0}
						<span style={p.stale ? 'color: var(--pending)' : ''}
							>· {p.waitingDays}d{p.stale ? ' · stale' : ''}</span
						>
					{/if}
				</div>
			</div>
			<div class="flex shrink-0 flex-col items-end gap-0.5">
				<Money minor={p.amountMinor} currency={p.currency} class="text-[16px] font-semibold" />
				{#if p.state !== 'completed' && stateLabel[p.state]}
					<span
						class="text-[10px] font-semibold tracking-[0.04em] uppercase"
						style="color: var({stateVar[p.state]})">{stateLabel[p.state]}</span
					>
				{/if}
			</div>
		</a>
	</div>
{/snippet}

{#snippet runwayLine(label: string, minor: bigint, kind: 'add' | 'sub' | 'total', estimate = false)}
	<div class="flex items-center justify-between {kind === 'total' ? '' : 'mt-1.5'}">
		<span style="color: {kind === 'total' ? 'var(--ink)' : 'var(--ink-3)'}">{label}</span>
		<!--
			A dotted figure is a projection, not a measurement. Same notation as the
			calendar, for the same reason and deliberately nowhere else: it only
			carries meaning while it stays rare.
		-->
		<span
			class="num {kind === 'total' ? 'font-semibold' : ''}"
			style="color: {kind === 'total'
				? minor < 0n
					? 'var(--deny)'
					: 'var(--ink)'
				: kind === 'add'
					? 'var(--ink)'
					: 'var(--ink-3)'}; {estimate
				? 'text-decoration: underline dotted; text-underline-offset: 3px;'
				: ''}"
		>
			{kind === 'add' ? '+' : kind === 'sub' ? '−' : ''}{formatMinor(minor, data.currency)}
		</span>
	</div>
{/snippet}

<div>
	{#if showForecast}
		<!-- Harmony's headline: the money that's actually free this month. Live —
		     pending reserves it, sleeping releases it, approving commits it. -->
		<div class="card mb-5 p-4">
			{#if !f}
				<!-- The card's frame belongs to the shell; only the figures stream in. -->
				<p class="section-label">Safe to spend</p>
				<SkeletonHero />
			{:else}
				<div class="flex items-start justify-between gap-2">
					<button
						type="button"
						onclick={() => (masked ? (revealed = true) : (showRunway = !showRunway))}
						class="press -m-1 flex min-w-0 flex-1 items-start justify-between gap-3 p-1 text-left"
						aria-expanded={masked ? undefined : showRunway}
						aria-label={masked
							? 'Reveal the amount'
							: showRunway
								? 'Hide the breakdown'
								: 'Show how this is calculated'}
					>
						<div class="min-w-0">
							<p class="section-label">Safe to spend · through {monthEndLabel(f)}</p>
							<div
								class="mt-1 font-[family-name:var(--font-display)] text-[32px] leading-[0.95] font-bold"
								style="color: {masked
									? 'var(--ink-3)'
									: f.freeMinor < 0n
										? 'var(--deny)'
										: 'var(--ink)'}"
							>
								<!-- Colour goes neutral under the mask too: red would say "you're
							     under" as loudly as the digits would. -->
								<Money minor={f.freeMinor} currency={data.currency} {masked} />
							</div>
						</div>
						{#if !masked}
							<ChevronDown
								class="mt-0.5 h-5 w-5 shrink-0 transition-transform duration-200 {showRunway
									? 'rotate-180'
									: ''}"
								style="color: var(--ink-3)"
							/>
						{/if}
					</button>
					{#if display === 'masked'}
						<!-- The banking-app eye: reveal for as long as you're looking, no
					     longer. Never persisted — see `revealed`. -->
						<button
							type="button"
							onclick={() => {
								revealed = !revealed;
								if (!revealed) showRunway = false;
							}}
							class="press -m-1 shrink-0 p-1"
							aria-pressed={revealed}
							aria-label={revealed ? 'Hide the amount' : 'Reveal the amount'}
						>
							{#if revealed}
								<EyeOff class="h-5 w-5" style="color: var(--ink-3)" />
							{:else}
								<Eye class="h-5 w-5" style="color: var(--ink-3)" />
							{/if}
						</button>
					{/if}
				</div>
				<!-- Harmony's read: always present, the story above the numbers — except
			     under the mask, where the story *is* the number in words, and its
			     tone colour gives the answer away on its own. -->
				{#if masked}
					<p class="mt-1.5 text-[13px] leading-snug" style="color: var(--ink-3)">
						Hidden. Tap to reveal.
					</p>
				{:else}
					<p
						class="mt-1.5 flex items-start gap-1.5 text-[13px] leading-snug"
						style="color: {narrationColor}"
					>
						<Sparkles class="mt-[3px] h-3.5 w-3.5 shrink-0" />
						<span>{narration?.text}</span>
					</p>
				{/if}
				{#if showRunway}
					<!-- The runway: how income becomes the free number, line by line. -->
					<div
						class="mt-4 border-t pt-3 text-[14px]"
						style="border-color: var(--hairline)"
						transition:slide={{ duration: reduceMotion ? 0 : 220 }}
					>
						{@render runwayLine('Income', f.breakdown.incomeMinor, 'add')}
						{@render runwayLine(
							'Recurring',
							f.breakdown.upcomingBillsMinor,
							'sub',
							f.breakdown.upcomingBillsEstimated
						)}
						{@render runwayLine('Saved', f.breakdown.savingsMinor, 'sub')}
						{@render runwayLine('Approved', f.breakdown.cashCommittedMinor, 'sub')}
						{@render runwayLine('Spent', f.breakdown.cashSpentMinor, 'sub')}
						<div class="mt-2 border-t pt-2" style="border-color: var(--hairline)">
							{@render runwayLine('Free to spend', f.freeMinor, 'total')}
						</div>
						{#if f.breakdown.reservedMinor > 0n}
							<div class="mt-2.5 flex items-center justify-between" style="color: var(--ink-3)">
								<span>Reserved for pending</span>
								<span class="num" style="color: var(--pending)"
									>−{formatMinor(f.breakdown.reservedMinor, data.currency)}</span
								>
							</div>
							<div class="flex items-center justify-between" style="color: var(--ink-3)">
								<span>If all approved</span>
								<span
									class="num"
									style="color: {f.afterReservedMinor < 0n ? 'var(--pending)' : 'var(--ink-2)'}"
									>{formatMinor(f.afterReservedMinor, data.currency)}</span
								>
							</div>
						{/if}
						{#if f.breakdown.sleepingMinor > 0n}
							<div
								class="mt-1 flex items-center justify-between gap-1.5"
								style="color: var(--seal)"
							>
								<span class="flex items-center gap-1.5"><Moon class="h-3.5 w-3.5" /> Sleeping</span>
								<span class="num">{formatMinor(f.breakdown.sleepingMinor, data.currency)}</span>
							</div>
						{/if}
						{#if f.breakdown.budgetRemainingMinor !== null}
							<div class="mt-1 flex items-center justify-between" style="color: var(--ink-3)">
								<!--
								Two different figures wear this row. With an overall budget it is
								one ceiling; without one it is the headroom summed across separate
								category allowances, which you cannot move money between. Calling
								both "your budget" flattened that.
							-->
								<span>
									{f.breakdown.budgetRemainingKind === 'categories'
										? 'Left across budgets'
										: 'Left in your budget'}
								</span>
								<span
									class="num"
									style="color: {f.breakdown.budgetRemainingMinor < 0n
										? 'var(--pending)'
										: 'var(--ink-2)'}"
									>{formatMinor(f.breakdown.budgetRemainingMinor, data.currency)}</span
								>
							</div>
						{/if}
						{#if f.breakdown.upcomingBillsEstimated}
							<!-- Said once, under the figures, rather than on the row itself. -->
							<p class="mt-2.5 text-[12px] leading-relaxed" style="color: var(--ink-3)">
								The dotted figure is an estimate. Some of those bills ask you to confirm the real
								price, so it's what they came to last time.
							</p>
						{/if}
						{#if runway && runwayHasSignal}
							<!-- The months after this one: projected free cash left each month, after
						     income, bills and saving. A projection, not a commitment. -->
							<div class="mt-4 border-t pt-3" style="border-color: var(--hairline)">
								<span class="section-label">The months after</span>
								<div class="mt-1.5 text-[14px]">
									{#each runway.months as m (`${m.month.y}-${m.month.m}`)}
										<div class="flex items-center justify-between py-0.5">
											<span style="color: var(--ink-2)"
												>{monthLabel(m.month, runway.months[0].month.y)}</span
											>
											<!-- The same dotted underline the current month's estimate
										     wears: a projection whose bills include one that still asks
										     for its real price. -->
											<span
												class="num"
												style="color: {m.freeMinor < 0n
													? 'var(--deny)'
													: 'var(--ink)'}; {m.estimated
													? 'text-decoration: underline dotted; text-underline-offset: 3px;'
													: ''}"
												>{m.freeMinor >= 0n ? '' : '−'}{formatMinor(
													m.freeMinor < 0n ? -m.freeMinor : m.freeMinor,
													data.currency
												)}</span
											>
										</div>
									{/each}
								</div>
								{#if runwaySummary}
									<p class="mt-2 text-[12px] leading-relaxed" style="color: var(--ink-3)">
										<!-- The newline before the block is load-bearing: with `yet.{#if`
									     adjacent, Svelte trims and the sentences run together as
									     "yet.A dotted figure". -->
										{runwaySummary}. Projected from what repeats each month. Nothing here is spent
										yet.
										{#if runway.months.some((m) => m.estimated)}
											A dotted figure includes a bill that still asks for its real price.
										{/if}
									</p>
								{/if}
							</div>
						{/if}
					</div>
				{/if}
				{#if !showRunway}
					<p class="mt-1.5 text-[13px]" style="color: var(--ink-3)">
						<span class="num">{amt(f.breakdown.upcomingBillsMinor)}</span>
						bills ·
						<span class="num">{amt(f.breakdown.savingsMinor)}</span> saved{f.breakdown
							.cashCommittedMinor > 0n
							? ` · ${amt(f.breakdown.cashCommittedMinor)} approved`
							: ''} this month
					</p>
					{#if f.breakdown.sleepingMinor > 0n}
						<p class="mt-1 flex items-center gap-1.5 text-[13px]" style="color: var(--seal)">
							<Moon class="h-3.5 w-3.5" />
							<span><span class="num">{amt(f.breakdown.sleepingMinor)}</span> sleeping on it</span>
						</p>
					{/if}
				{/if}
			{/if}
		</div>
	{/if}

	<div class="flex items-end justify-between px-1 pt-1 pb-2">
		<h1>Ledger</h1>
		<span class="num pb-1 text-[13px]" style="color: var(--ink-3)">
			{#if feedPending && items.length === 0}
				<!-- The count streams with the feed; a block of paper stands in for
				     it rather than a number that would be wrong twice. -->
				<span class="skeleton inline-block h-3 w-14 align-middle" aria-hidden="true"></span>
			{:else}
				{total}
				{total === 1 ? 'item' : 'items'}
			{/if}
		</span>
	</div>

	<div class="mb-5 flex gap-2">
		<label class="relative flex-1">
			<span class="sr-only">Search the ledger</span>
			<Search
				class="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2"
				style="color: var(--ink-3)"
			/>
			<input
				type="text"
				placeholder="Search the ledger..."
				bind:value={search}
				oninput={onSearchInput}
				class="field pr-10 pl-10 text-[16px]"
			/>
			{#if search}
				<button
					onclick={clearSearch}
					class="press absolute top-1/2 right-3 -translate-y-1/2"
					style="color: var(--ink-3)"
					aria-label="Clear"
				>
					<X class="h-4 w-4" />
				</button>
			{/if}
		</label>
		<button
			onclick={() => (showFilter = !showFilter)}
			class="press relative flex h-[45px] w-11 shrink-0 items-center justify-center rounded-[var(--r-sm)]"
			aria-label="Filter the ledger"
		>
			<Funnel
				class="h-[18px] w-[18px] transition-colors"
				style="color: {hasFilters ? 'var(--ws-accent)' : 'var(--ink-4)'}"
			/>
			{#if hasFilters}
				<span
					class="absolute top-1.5 right-1 h-2 w-2 rounded-full"
					style="background: var(--ws-accent)"
				></span>
			{/if}
		</button>
	</div>

	{#if hasFilters}
		<div class="mb-4 flex flex-wrap items-center gap-2">
			{#each activeFilters as f (f.key)}
				<button
					onclick={() => navigateWith(f.clear)}
					class="press flex items-center gap-1.5 rounded-[var(--r-full)] py-1.5 pr-2.5 pl-3 text-[13px]"
					style="background: var(--surface-2); color: var(--ink-2)"
					aria-label="Remove filter: {f.label}"
				>
					{f.label}
					<X class="h-3 w-3" style="color: var(--ink-4)" />
				</button>
			{/each}
			{#if activeFilters.length > 1}
				<button
					onclick={clearFilters}
					class="press px-1 text-[13px] underline underline-offset-2"
					style="color: var(--ink-3)">Clear all</button
				>
			{/if}
		</div>
	{/if}

	{#if showFilter}
		<!-- Centered modal, mirroring the intelligence palette — a made object, not
			a settings dropdown. Chips commit a filter on tap; the panel stays open so
			you can stack a date, a member and a category in one visit. -->
		<div
			class="fixed inset-0 z-50"
			style="background: var(--scrim)"
			use:dismiss={() => (showFilter = false)}
			transition:fade={{ duration: reduceMotion ? 0 : 140 }}
		></div>
		<div
			class="fixed inset-x-4 top-[10vh] z-50 mx-auto flex max-h-[80vh] max-w-md flex-col"
			role="dialog"
			aria-modal="true"
			aria-label="Filter the ledger"
			tabindex="-1"
			use:modal
			onkeydown={(e) => {
				if (e.key === 'Escape') showFilter = false;
			}}
			transition:scale={{ start: 0.96, duration: reduceMotion ? 0 : 170 }}
		>
			<div
				class="card-lg flex min-h-0 flex-col overflow-hidden"
				style="box-shadow: var(--shadow-float); background: var(--surface)"
			>
				<!-- Masthead header -->
				<div class="flex items-center justify-between px-5 pt-4 pb-3.5">
					<h2 class="font-[family-name:var(--font-display)] text-[22px]" style="color: var(--ink)">
						Filter
					</h2>
					<button
						onclick={() => (showFilter = false)}
						class="press -mr-1 flex h-8 w-8 items-center justify-center rounded-full"
						style="color: var(--ink-3)"
						aria-label="Close"
					>
						<X class="h-4 w-4" />
					</button>
				</div>
				<div class="h-px" style="background: var(--hairline)"></div>

				<!-- Scrollable body -->
				<div class="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
					<!-- Date range -->
					<div>
						<p class="section-label mb-2">Date range</p>
						<div class="flex items-center gap-2">
							<label class="flex-1">
								<span class="sr-only">From date</span>
								<input
									type="date"
									value={from}
									max={to || undefined}
									onchange={(e) => setRange({ from: e.currentTarget.value })}
									class="field text-[16px]"
								/>
							</label>
							<span class="text-[13px]" style="color: var(--ink-3)">to</span>
							<label class="flex-1">
								<span class="sr-only">To date</span>
								<input
									type="date"
									value={to}
									min={from || undefined}
									onchange={(e) => setRange({ to: e.currentTarget.value })}
									class="field text-[16px]"
								/>
							</label>
						</div>
					</div>

					<!-- Member -->
					{#if data.members.length > 1}
						<div>
							<p class="section-label mb-2">Member</p>
							<div class="flex flex-wrap gap-2">
								<button
									onclick={() => pickMember('')}
									role="radio"
									aria-checked={!member}
									class="press chip-btn"
									style={!member ? SELECTED : UNSELECTED}>Anyone</button
								>
								{#each data.members as m (m.id)}
									{@const on = member === m.id}
									<button
										onclick={() => pickMember(m.id)}
										role="radio"
										aria-checked={on}
										class="press chip-btn"
										style={on ? SELECTED : UNSELECTED}>{m.name}</button
									>
								{/each}
							</div>
						</div>
					{/if}

					<!-- Category -->
					<div>
						<p class="section-label mb-2">Category</p>
						<div class="flex flex-wrap gap-2">
							<button
								onclick={() => pickCategory('')}
								role="radio"
								aria-checked={!category}
								class="press chip-btn"
								style={!category ? SELECTED : UNSELECTED}>All</button
							>
							{#each data.categories as c (c.id)}
								{@const on = category === c.id}
								<button
									onclick={() => pickCategory(c.id)}
									role="radio"
									aria-checked={on}
									class="press chip-btn"
									style={on ? SELECTED : UNSELECTED}>{c.icon} {c.name}</button
								>
							{/each}
							<button
								onclick={() => pickCategory(NO_CATEGORY)}
								role="radio"
								aria-checked={category === NO_CATEGORY}
								class="press chip-btn"
								style={category === NO_CATEGORY ? SELECTED : UNSELECTED}>Other</button
							>
						</div>
					</div>

					<!-- Bucket activity toggle -->
					<div class="h-px" style="background: var(--hairline)"></div>
					<button
						onclick={toggleMovements}
						role="switch"
						aria-checked={data.includeMovements}
						class="press flex w-full items-center justify-between"
					>
						<span class="text-left">
							<span class="block text-[15px]" style="color: var(--ink)">Bucket activity</span>
							<span class="block text-[13px]" style="color: var(--ink-3)"
								>Show money moving in and out of buckets</span
							>
						</span>
						<span
							class="relative h-[28px] w-[44px] shrink-0 rounded-full transition-colors"
							style="background: {data.includeMovements ? 'var(--accent)' : 'var(--surface-hi)'}"
						>
							<span
								class="absolute top-1 left-0 h-5 w-5 rounded-full bg-white shadow-sm transition-transform"
								style="transform: translateX({data.includeMovements ? '20px' : '4px'})"
							></span>
						</span>
					</button>
				</div>

				<!-- Footer -->
				<div class="h-px" style="background: var(--hairline)"></div>
				<div class="flex items-center justify-between px-5 py-3">
					<button
						onclick={clearFilters}
						disabled={!hasFilters}
						class="press text-[14px] disabled:opacity-40"
						style="color: var(--ink-3)">Clear all</button
					>
					<button onclick={() => (showFilter = false)} class="btn btn-accent px-5 py-2 text-[14px]"
						>Done</button
					>
				</div>
			</div>
		</div>
	{/if}

	{#if awaitingPending && awaitingRows.length === 0 && !hasFilters && !activeQuery}
		<!-- The confirm to-do streams separately from the feed; while it's in
		     flight, its rows hold the shape. Default view only, like the section
		     itself — under a search or filter you want raw results. -->
		<p class="section-label mt-2 mb-1 px-1" style="color: var(--pending)">Awaiting a decision</p>
		<div class="mb-6">
			{#each Array(2) as _, i (i)}
				<SkeletonRow index={i} chip last={i === 1} />
			{/each}
		</div>
	{/if}

	{#if feedPending && items.length === 0}
		<!-- Known-loading rows: four placeholders carry the message as well as
		     twenty would; a skeleton list as long as the content it imitates is
		     theatre. -->
		<p class="section-label mt-2 mb-1 px-1">Recent</p>
		<div>
			{#each Array(4) as _, i (i)}
				<SkeletonRow index={i} chip last={i === 3} />
			{/each}
		</div>
	{:else if filtered.length === 0}
		<div class="mt-6 px-6 py-10 text-center">
			<div
				class="mx-auto mb-5 flex h-20 w-20 items-center justify-center rounded-[22px]"
				style="background: radial-gradient(120% 120% at 30% 20%, color-mix(in oklab, var(--ws-accent) 40%, var(--surface)), var(--surface))"
			>
				<ShoppingBag
					class="h-8 w-8"
					style="color: color-mix(in oklab, var(--ws-accent) 80%, white)"
				/>
			</div>
			<p class="text-[19px] font-semibold" style="color: var(--ink)">
				{activeQuery || hasFilters ? 'No matches' : 'Nothing here yet'}
			</p>
			{#if activeQuery || hasFilters}
				<p
					class="mx-auto mt-1.5 max-w-[28ch] text-[15px] leading-relaxed"
					style="color: var(--ink-3)"
				>
					Try adjusting your search or filter.
				</p>
			{:else}
				<p
					class="mx-auto mt-1.5 max-w-[28ch] text-[15px] leading-relaxed"
					style="color: var(--ink-3)"
				>
					Log something you bought, or ask for approval before you spend.
				</p>
			{/if}
			<a href="/w/{slug}/purchases/new" class="btn btn-accent mt-6">New purchase</a>
			{#if !activeQuery && !hasFilters}
				<!-- Empty states are the teaching moment: you're here precisely
				     because you haven't done the thing yet. -->
				<a
					href="/w/{slug}/settings/help?s=logging"
					class="press mt-4 flex items-center justify-center gap-1.5 text-[14px] font-medium"
					style="color: var(--accent-ink)"
				>
					<CircleHelp class="h-4 w-4" /> How this works
				</a>
			{/if}
		</div>
	{:else}
		{#if pending.length > 0}
			<p class="section-label mt-2 mb-1 px-1" style="color: var(--pending)">
				Awaiting a decision · {pending.length}
			</p>
			<div class="mb-6">
				{#each pending as p, i (p.id)}
					{@render row(p, i === pending.length - 1)}
				{/each}
			</div>
		{/if}

		{#if showConfirm}
			<!-- Green like the APPROVED chip these rows carry: greenlit, they just
			     need the real amount recorded. -->
			<p class="section-label mt-2 mb-1 px-1" style="color: var(--approve)">
				Confirm what you paid · {confirmItems.length}
			</p>
			<div class="mb-6">
				{#each confirmItems as p, i (p.id)}
					{@render row(p, i === confirmItems.length - 1)}
				{/each}
			</div>
		{/if}

		{#if showSleeping}
			<!-- Seal-purple: the temporal-lock tone shared with sealed gifts. -->
			<p class="section-label mt-2 mb-1 px-1" style="color: var(--seal)">
				Sleeping on it · {sleepingItems.length}
			</p>
			<div class="mb-6">
				{#each sleepingItems as p, i (p.id)}
					<a
						href="/w/{slug}/purchases/{p.id}"
						class="press flex items-center gap-3 px-1 py-3 {i === sleepingItems.length - 1
							? ''
							: 'hairline'}"
					>
						<span
							class="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px]"
							style="background: color-mix(in oklab, var(--seal) 13%, var(--surface-2)); color: var(--seal)"
						>
							<Moon class="h-[18px] w-[18px]" />
						</span>
						<div class="min-w-0 flex-1">
							<span class="block truncate text-[16px] font-medium" style="color: var(--ink)"
								>{p.itemName}</span
							>
							<span class="mt-0.5 block text-[13px]" style="color: var(--ink-3)"
								>{p.requesterName}</span
							>
						</div>
						<div class="flex shrink-0 flex-col items-end gap-1">
							<Money
								minor={p.amountMinor}
								currency={p.currency}
								class="text-[16px] font-semibold"
							/>
							<span
								class="chip num"
								style="color: color-mix(in oklab, var(--seal) 80%, var(--ink)); background: color-mix(in oklab, var(--seal) 13%, var(--surface))"
								>{heldLeft(p.heldUntil)}</span
							>
						</div>
					</a>
				{/each}
			</div>
		{/if}

		{#if rest.length > 0}
			<p class="section-label mb-1 px-1">Recent</p>
			<div>
				{#each rest as e, i (e.id)}
					{#if e.kind === 'movement'}
						{@render movementRow(e, i === rest.length - 1)}
					{:else}
						{@render row(e, i === rest.length - 1)}
					{/if}
				{/each}
				<!-- The page size is 20, but four placeholders carry the message as
				     well as twenty would; a skeleton list as long as the content it
				     imitates is theatre. -->
				{#if loadingMore}
					{#each Array(4) as _, i (i)}
						<SkeletonRow index={i} chip last={i === 3} />
					{/each}
				{/if}
			</div>
		{/if}
		{#if hasMore}
			<button
				onclick={loadMore}
				disabled={loadingMore}
				class="btn btn-ghost mt-3 w-full py-3 text-[15px]"
			>
				{loadingMore ? 'Loading...' : 'Show more'}
			</button>
		{/if}
	{/if}
</div>

<style>
	/* Filter chips: rounded, tactile, quick state transition. Selected/unselected
	   colors are set inline (SELECTED/UNSELECTED) so the same class serves both. */
	.chip-btn {
		border-radius: var(--r-full);
		padding: 0.5rem 0.85rem;
		font-size: 14px;
		line-height: 1.1;
		transition:
			background 0.12s ease,
			color 0.12s ease,
			box-shadow 0.12s ease;
	}
</style>
