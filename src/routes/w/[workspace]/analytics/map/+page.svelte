<script lang="ts">
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import { ChevronLeft, Maximize2 } from '@lucide/svelte';
	import { fade, fly } from 'svelte/transition';
	import Segmented from '$lib/components/Segmented.svelte';
	import { dismiss } from '$lib/actions/dismiss';
	import { modal } from '$lib/actions/modal';
	import { formatMinor } from '$lib/money-format';
	import { ledgerLink } from '$lib/ledger-filters';
	import {
		E3,
		MAX_LAT_E3,
		MAX_LNG_E3,
		formatCoords,
		fromE3,
		type Coords
	} from '$lib/domain/location/coords';
	import {
		MAX_ZOOM,
		MIN_ZOOM,
		fitBounds,
		screenXY,
		tilesFor,
		unproject,
		project,
		viewportBounds,
		type Viewport
	} from '$lib/domain/location/mercator';
	import {
		bubbleRadius,
		clusterPoints,
		labelLayout,
		placeLabels,
		type Bubble,
		type LocatedAmount
	} from '$lib/domain/location/cluster';

	let { data } = $props();
	const slug = $derived(page.params.workspace!);

	/*
	 * The map is a plotted chart, not a photograph of the world.
	 *
	 * Everything is drawn on the same paper as the rest of the app: a graticule
	 * of hairlines on the round decimal degree, bubbles washed in the category's
	 * colour and drawn in ink, amounts set in the display face. When a basemap is
	 * configured it goes *under* that, filtered toward the paper's own hue, so
	 * streets read as printing rather than as a screenshot of somebody else's app.
	 *
	 * Clustering, projection and label placement are all pure functions in
	 * domain/location. Nothing here computes geometry; it only draws it.
	 */

	// ── Viewport ──────────────────────────────────────────────────────────
	let canvas: HTMLDivElement | null = $state(null);
	let width = $state(390);
	let height = $state(520);
	let center = $state<Coords>({ lat: 0, lng: 0 });
	let z = $state<number>(MIN_ZOOM);
	let ready = $state(false);

	const points = $derived<LocatedAmount[]>(
		data.points.map((p) => ({
			id: p.id,
			latE3: p.latE3,
			lngE3: p.lngE3,
			// Money crosses the wire as a string and becomes a bigint here, once.
			amountMinor: BigInt(p.amountMinor),
			label: p.label,
			color: p.color
		}))
	);

	const viewport = $derived<Viewport>({ center, z, width, height });

	/*
	 * Clustering keys on the rounded zoom, so a pinch does not re-key every
	 * bubble on every frame — the set of bubbles changes when you cross a zoom
	 * level, and glides in between.
	 */
	const bubbles = $derived(ready ? clusterPoints(points, z) : []);
	const maxMinor = $derived(bubbles.length > 0 ? bubbles[0].totalMinor : 0n);

	interface Laid {
		b: Bubble;
		x: number;
		y: number;
		r: number;
	}

	const laid = $derived<Laid[]>(
		bubbles.map((b) => {
			const p = screenXY(b.center, viewport);
			return { b, x: p.x, y: p.y, r: bubbleRadius(b.totalMinor, maxMinor) };
		})
	);

	// Only what is actually on screen gets drawn, with a margin so a bubble
	// half-off the edge still shows its half.
	const visible = $derived(
		laid.filter((l) => l.x > -80 && l.x < width + 80 && l.y > -80 && l.y < height + 80)
	);

	/** The name as drawn, including the "+3 more" when a bubble swallowed others. */
	function nameOf(b: Bubble): string | null {
		if (!b.topLabel) return null;
		return b.labelCount > 1 ? `${b.topLabel} +${b.labelCount - 1}` : b.topLabel;
	}

	const labelled = $derived(
		placeLabels(
			visible.map((l) => ({
				key: l.b.key,
				x: l.x,
				y: l.y,
				r: l.r,
				totalMinor: l.b.totalMinor,
				amountText: formatMinor(l.b.totalMinor, data.currency),
				nameText: nameOf(l.b)
			}))
		)
	);

	/*
	 * No global "tiles failed" latch.
	 *
	 * There was one, and a single failed image killed the basemap for the rest of
	 * the session — along with the attribution caption, which the licence
	 * requires to be permanent. And failures are routine rather than exceptional:
	 * the proxy answers 204 for a tile upstream doesn't have (ocean, edges) and
	 * 429 once the per-minute limiter trips during a hard pan, and an `<img>`
	 * treats both as an error.
	 *
	 * A tile that doesn't arrive simply doesn't paint — `alt=""` renders nothing —
	 * and the graticule underneath is drawn either way, so the map stays readable
	 * with any subset of its tiles missing.
	 */
	const tiles = $derived(data.tileUrl && ready ? tilesFor(viewport) : []);

	/*
	 * A tile that didn't arrive, tried again shortly.
	 *
	 * The server answers 204 for a square it has neither cached nor budget to
	 * fetch, which happens in bursts while you sweep through zoom levels. Without
	 * this the `<img>` stays blank for as long as that view is on screen: settling
	 * back on it re-renders the same key, so nothing re-requests and the map keeps
	 * a hole in it. Reloading in place is per-tile and needs no re-render, and the
	 * attempt cap stops a genuinely missing square retrying forever.
	 */
	const RETRY_DELAY_MS = 1200;
	const MAX_TILE_RETRIES = 3;
	const tileAttempts = new WeakMap<HTMLImageElement, number>();

	function retryTile(event: Event) {
		const img = event.currentTarget as HTMLImageElement;
		const tried = tileAttempts.get(img) ?? 0;
		if (tried >= MAX_TILE_RETRIES) return;
		tileAttempts.set(img, tried + 1);
		const { src } = img;
		setTimeout(
			() => {
				// Only if this element is still on screen showing the same square.
				if (!img.isConnected || img.src !== src) return;
				img.src = '';
				img.src = src;
			},
			RETRY_DELAY_MS * (tried + 1)
		);
	}

	/*
	 * The graticule: lines on the round decimal degree, at whatever interval
	 * gives four to eight of them across the view. This is the default map — no
	 * third party, nothing leaves the box, and the geometry is exactly as correct
	 * as it is with streets underneath. You just read position off the numbers in
	 * the margin instead of off the buildings.
	 */
	/*
	 * Coarsest first, and the predicate is "at least this many lines", not "at
	 * most".
	 *
	 * `find` returns the first match, so asking for `span / s <= 8` was satisfied
	 * by the 90° step for every span smaller than 720° — which is all of them.
	 * The world view looked right by luck and every closer view drew no grid at
	 * all. Asking for `s <= span / 4` picks the coarsest interval that still puts
	 * four lines on screen, which is the actual intent.
	 */
	const STEPS = [90, 30, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001];
	const MIN_GRID_LINES = 4;
	/** Hard ceiling, so no arithmetic surprise can ever draw an unbounded grid. */
	const MAX_GRID_LINES = 24;

	interface Graticule {
		lines: { x1: number; y1: number; x2: number; y2: number }[];
		labels: { x: number; y: number; text: string; anchor: string }[];
	}

	const graticule = $derived.by<Graticule>(() => {
		const empty: Graticule = { lines: [], labels: [] };
		if (!ready) return empty;
		/*
		 * Only when there is no basemap.
		 *
		 * Without streets the graticule *is* the map — it is the only thing telling
		 * you where on Earth a bubble sits. With streets under it, it is a second
		 * grid over a picture that already answers that question, and it reads as
		 * pattern rather than as information. The scale bar stays either way, since
		 * that is the one thing tiles don't state.
		 */
		if (data.tileUrl) return empty;

		const b = viewportBounds(viewport);
		const span = Math.max(b.maxLng - b.minLng, 1e-6);
		// Falls back to the finest interval only for a span smaller than the data's
		// own precision, where any grid is arbitrary anyway.
		const step = STEPS.find((s) => s <= span / MIN_GRID_LINES) ?? STEPS[STEPS.length - 1];
		const dp = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;

		const lines: Graticule['lines'] = [];
		const labels: Graticule['labels'] = [];

		const first = (min: number) => Math.ceil(min / step) * step;

		for (
			let lng = first(b.minLng), i = 0;
			lng <= b.maxLng && i < MAX_GRID_LINES;
			lng += step, i++
		) {
			const x = screenXY({ lat: center.lat, lng }, viewport).x;
			lines.push({ x1: x, y1: 0, x2: x, y2: height });
			labels.push({ x: x + 4, y: height - 6, text: `${lng.toFixed(dp)}°`, anchor: 'start' });
		}
		for (
			let lat = first(b.minLat), i = 0;
			lat <= b.maxLat && i < MAX_GRID_LINES;
			lat += step, i++
		) {
			const y = screenXY({ lat, lng: center.lng }, viewport).y;
			lines.push({ x1: 0, y1: y, x2: width, y2: y });
			labels.push({ x: 4, y: y - 4, text: `${lat.toFixed(dp)}°`, anchor: 'start' });
		}
		return { lines, labels };
	});

	/** A scale bar, so distance on the plot is readable without a basemap. */
	const scaleBar = $derived.by(() => {
		if (!ready) return null;
		// Metres per pixel at this latitude, from the Mercator scale factor.
		const mPerPx = (156543.03392 * Math.cos((center.lat * Math.PI) / 180)) / 2 ** z;
		const targets = [
			50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000, 100_000, 200_000, 500_000,
			1_000_000
		];
		const want = mPerPx * 90;
		const m = targets.find((t) => t >= want) ?? targets[targets.length - 1]!;
		return { px: m / mPerPx, text: m >= 1000 ? `${m / 1000} km` : `${m} m` };
	});

	// ── Fitting and URL state ─────────────────────────────────────────────
	/**
	 * Frame every pin. Deliberately does not touch the URL: arriving at a page
	 * should not rewrite its address, and `replaceState` throws outright before
	 * the router has initialised. Only a gesture or the Fit button commits.
	 */
	function fit() {
		const { center: c, z: nz } = fitBounds(
			points.map((p) => fromE3(p)),
			width,
			height,
			56
		);
		center = c;
		z = nz;
	}

	function fitAndCommit() {
		fit();
		commit();
	}

	/**
	 * Write the view back to the URL — but only when a gesture ends.
	 *
	 * Doing it per frame would walk the back button through forty pan states, and
	 * `replaceState` keeps the map's position shareable and restorable without
	 * adding history entries at all.
	 */
	function commit() {
		// A throwaway builder, read once into a string; nothing renders from the
		// instance, so it has no reason to be reactive.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const q = new URLSearchParams(page.url.searchParams);
		q.set('z', z.toFixed(2));
		q.set('c', `${Math.round(center.lat * E3)},${Math.round(center.lng * E3)}`);
		replaceState(`?${q}`, page.state);
	}

	/**
	 * The view carried in the URL — which is a shareable, editable string, so
	 * every part of it is range-checked rather than trusted. `?c=9999999,9999999`
	 * used to survive as a centre ten thousand degrees off-world, leaving a blank
	 * canvas with no way back except the Fit button.
	 */
	function readUrl(): boolean {
		const c = page.url.searchParams.get('c');
		const zp = page.url.searchParams.get('z');
		if (!c || !zp) return false;
		const parts = c.split(',');
		if (parts.length !== 2) return false;
		const [latE3, lngE3] = parts.map(Number);
		const zn = Number(zp);
		if (![latE3, lngE3, zn].every(Number.isFinite)) return false;
		if (Math.abs(latE3) > MAX_LAT_E3 || Math.abs(lngE3) > MAX_LNG_E3) return false;
		center = fromE3({ latE3, lngE3 });
		z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zn));
		return true;
	}

	$effect(() => {
		if (!canvas || ready) return;
		const r = canvas.getBoundingClientRect();
		width = Math.max(1, Math.round(r.width));
		height = Math.max(1, Math.round(r.height));
		ready = true;
		if (!readUrl()) fit();
	});

	$effect(() => {
		if (!canvas) return;
		const ro = new ResizeObserver(([e]) => {
			width = Math.max(1, Math.round(e.contentRect.width));
			height = Math.max(1, Math.round(e.contentRect.height));
		});
		ro.observe(canvas);
		return () => ro.disconnect();
	});

	// ── Direct manipulation ───────────────────────────────────────────────
	/*
	 * Pan and pinch are hand-rolled on pointer events. They are never suppressed
	 * under reduced motion: a gesture that doesn't track the finger is broken,
	 * not calm. Only the *animated* zoom on a double tap is.
	 */
	// Gesture bookkeeping, read only inside the handlers that write it. Nothing
	// renders from it, and making it reactive would re-run the whole map on
	// every pointermove.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const pointers = new Map<number, { x: number; y: number }>();
	let gesture: { dist: number; z: number; mid: { x: number; y: number }; center: Coords } | null =
		null;
	let panFrom: { x: number; y: number; center: Coords } | null = null;
	let moved = false;

	function localXY(e: PointerEvent) {
		const r = canvas!.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	}

	function onPointerDown(e: PointerEvent) {
		canvas?.setPointerCapture(e.pointerId);
		pointers.set(e.pointerId, localXY(e));
		moved = false;
		if (pointers.size === 2) {
			const [a, b] = [...pointers.values()];
			gesture = {
				dist: Math.hypot(a.x - b.x, a.y - b.y),
				z,
				mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
				center
			};
			panFrom = null;
		} else if (pointers.size === 1) {
			panFrom = { ...localXY(e), center };
		}
	}

	function onPointerMove(e: PointerEvent) {
		if (!pointers.has(e.pointerId)) return;
		pointers.set(e.pointerId, localXY(e));

		if (pointers.size === 2 && gesture) {
			const [a, b] = [...pointers.values()];
			const dist = Math.hypot(a.x - b.x, a.y - b.y);
			if (dist < 8) return;
			moved = true;
			const nz = clampZoom(gesture.z + Math.log2(dist / gesture.dist));
			// Anchor the midpoint: the spot between the fingers stays under them,
			// which is what makes a pinch feel like it's grabbing the map rather
			// than operating a zoom control.
			zoomAround(gesture.mid, nz, { center: gesture.center, z: gesture.z });
			return;
		}

		if (panFrom && pointers.size === 1) {
			const p = localXY(e);
			const dx = p.x - panFrom.x;
			const dy = p.y - panFrom.y;
			if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
			const o = project(panFrom.center, z);
			center = unproject({ x: o.x - dx, y: o.y - dy }, z);
		}
	}

	function onPointerUp(e: PointerEvent) {
		pointers.delete(e.pointerId);
		if (pointers.size < 2) gesture = null;
		if (pointers.size === 0) {
			panFrom = null;
			if (moved) commit();
		}
	}

	const clampZoom = (n: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, n));

	/** Zoom keeping `anchor` (in viewport pixels) over the same coordinate. */
	function zoomAround(
		anchor: { x: number; y: number },
		nz: number,
		from: { center: Coords; z: number } = { center, z }
	) {
		const before = unproject(
			{
				x: project(from.center, from.z).x - width / 2 + anchor.x,
				y: project(from.center, from.z).y - height / 2 + anchor.y
			},
			from.z
		);
		const after = project(before, nz);
		center = unproject(
			{ x: after.x + width / 2 - anchor.x, y: after.y + height / 2 - anchor.y },
			nz
		);
		z = nz;
	}

	function onWheel(e: WheelEvent) {
		e.preventDefault();
		const r = canvas!.getBoundingClientRect();
		zoomAround({ x: e.clientX - r.left, y: e.clientY - r.top }, clampZoom(z - e.deltaY / 400));
		queueCommit();
	}

	let commitTimer: ReturnType<typeof setTimeout> | undefined;
	function queueCommit() {
		clearTimeout(commitTimer);
		commitTimer = setTimeout(commit, 220);
	}

	// ── The sheet ─────────────────────────────────────────────────────────
	let sheet = $state<Bubble | null>(null);

	/**
	 * The biggest three purchases inside the tapped bubble.
	 *
	 * Listed by *item*, not by place: the place is already the sheet's heading,
	 * so repeating it three times says nothing and hides what was actually
	 * bought.
	 */
	const sheetRows = $derived.by(() => {
		if (!sheet) return [];
		const ids = new Set(sheet.memberIds);
		return data.points
			.filter((p) => ids.has(p.id))
			.map((p) => ({ id: p.id, itemName: p.itemName, amountMinor: BigInt(p.amountMinor) }))
			.sort((a, b) => (a.amountMinor > b.amountMinor ? -1 : 1))
			.slice(0, 3);
	});

	/**
	 * True when *nothing* in this bubble was observed — every pin in it came from
	 * a vendor's usual place. Requiring a single member meant a cluster of purely
	 * inherited pins silently claimed to be somewhere people had been.
	 */
	const sheetInherited = $derived.by(() => {
		if (!sheet) return false;
		const ids = new Set(sheet.memberIds);
		const members = data.points.filter((p) => ids.has(p.id));
		return members.length > 0 && members.every((p) => p.inherited);
	});

	/**
	 * Back to Activity on the same window. Built by deleting the map-only keys
	 * rather than by stripping them with a regex: a regex assuming `z`/`c` are
	 * never first produced `?period=week` → `&period=week`, i.e. a path, on any
	 * URL a person had edited or reordered.
	 */
	const backSearch = $derived.by(() => {
		// A throwaway builder, read once into a string; nothing renders from the
		// instance, so it has no reason to be reactive.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const q = new URLSearchParams(page.url.searchParams);
		q.delete('z');
		q.delete('c');
		return q.size > 0 ? `?${q}` : '';
	});

	function periodHref(extra: Record<string, string>) {
		// A throwaway builder, read once into a string; nothing renders from the
		// instance, so it has no reason to be reactive.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const q = new URLSearchParams(page.url.searchParams);
		for (const [k, val] of Object.entries(extra)) q.set(k, val);
		// A new period means a new set of pins; the old centre would be wrong for
		// them, so drop it and let the map fit itself again.
		q.delete('z');
		q.delete('c');
		return `?${q}`;
	}

	const PERIOD_TABS = [
		{ value: 'day', label: 'Day', href: '?period=day' },
		{ value: 'week', label: 'Week', href: '?period=week' },
		{ value: 'month', label: 'Month', href: '?period=month' },
		{ value: 'year', label: 'Year', href: '?period=year' }
	];

	/*
	 * Stepping the period. Each period keeps its own parameter — the resolver on
	 * the server reads whichever one matches `period` and ignores the rest — so
	 * these only ever set the one that applies.
	 */
	function stepParams(dir: 'prev' | 'next'): Record<string, string> {
		const n = data.nav;
		switch (data.period) {
			case 'day':
				return { day: dir === 'prev' ? n.prevDay : n.nextDay };
			case 'week':
				return { wo: String(dir === 'prev' ? n.prevWeekOffset : n.nextWeekOffset) };
			case 'year': {
				const y = Number(page.url.searchParams.get('year') ?? new Date().getFullYear());
				return { year: String(dir === 'prev' ? y - 1 : y + 1) };
			}
			default:
				return { month: dir === 'prev' ? n.prevMonth : n.nextMonth };
		}
	}

	/** The accent as a wash. Ink draws the line; colour only tints the fill. */
	function wash(color: string | null): string {
		const base = color ?? 'var(--ink-3)';
		return `color-mix(in oklab, ${base} 34%, transparent)`;
	}
</script>

<svelte:head><title>Map · Ledger</title></svelte:head>

<div
	class="-mx-4 flex flex-col"
	style="height: calc(100dvh - var(--header-h, 0px) - var(--nav-h) - 0.75rem)"
>
	<!-- Back to the list, and what window we're looking at. -->
	<div class="flex items-center justify-between px-4 pt-1 pb-2">
		<a
			href="/w/{slug}/analytics{backSearch}"
			class="press -ml-1 flex items-center gap-0.5 text-[15px]"
			style="color: var(--ink-3)"
		>
			<ChevronLeft class="h-4 w-4" /> Activity
		</a>
		<span class="section-label">Map</span>
	</div>

	<!--
		Activity's control, now literally the same component. It had drifted into a
		pill with an ink fill — a different control for the same job on the screen
		next door.

		`?period=X` alone, as Activity does: it drops month/day/wo so switching
		lands on the current window, and drops z/c so the new set of pins is framed
		fresh.
	-->
	<div class="flex justify-center px-4 pb-2">
		<Segmented
			options={PERIOD_TABS}
			value={data.period}
			size="sm"
			fill={false}
			ariaLabel="Period"
		/>
	</div>

	<!-- Also Activity's: 36px round buttons with inline chevrons, a 17px semibold
	     label between them, and an equally sized spacer when a direction has
	     nowhere to go so the label never shifts. -->
	<div class="mb-1 flex items-center justify-between gap-1 px-3">
		{#if data.hasPrev}
			<a
				href={periodHref(stepParams('prev'))}
				class="press flex h-9 w-9 items-center justify-center rounded-full"
				style="color: var(--ink-3)"
				aria-label="Previous"
			>
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2.4"
					stroke-linecap="round"
					stroke-linejoin="round"><path d="M15 18l-6-6 6-6" /></svg
				>
			</a>
		{:else}
			<div class="h-9 w-9"></div>
		{/if}
		<span class="text-[17px] font-semibold" style="color: var(--ink)">{data.label}</span>
		{#if data.hasNext}
			<a
				href={periodHref(stepParams('next'))}
				class="press flex h-9 w-9 items-center justify-center rounded-full"
				style="color: var(--ink-3)"
				aria-label="Next"
			>
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2.4"
					stroke-linecap="round"
					stroke-linejoin="round"><path d="M9 18l6-6-6-6" /></svg
				>
			</a>
		{:else}
			<div class="h-9 w-9"></div>
		{/if}
	</div>

	{#if data.points.length === 0}
		<!--
			Empty state: no canvas at all. A compass rose in hairlines, and plain
			words about why it's empty — capture is opt-in, so an empty map usually
			means nobody has pinned anything yet rather than that anything is wrong.
		-->
		<div class="flex flex-1 flex-col items-center justify-center px-8 text-center">
			<svg width="76" height="76" viewBox="-40 -40 80 80" aria-hidden="true">
				<circle r="30" fill="none" stroke="var(--hairline)" stroke-width="1" />
				<circle r="21" fill="none" stroke="var(--hairline)" stroke-width="0.5" />
				{#each [0, 90, 180, 270] as a (a)}
					<line
						x1="0"
						y1="-36"
						x2="0"
						y2="-24"
						stroke="var(--ink-4)"
						stroke-width="1"
						transform="rotate({a})"
					/>
				{/each}
				<path d="M0 -21 L5 0 L0 21 L-5 0 Z" fill="none" stroke="var(--ink-4)" stroke-width="1" />
			</svg>
			<p class="mt-5 text-[17px] font-medium" style="color: var(--ink)">
				Nothing on the map this {data.period}.
			</p>
			<p class="mt-2 max-w-xs text-[14px] leading-relaxed" style="color: var(--ink-3)">
				A purchase gets a place when you tap <strong style="color: var(--ink-2)"
					>Use my location</strong
				> on the form, or paste a map link. Nothing is captured on its own.
			</p>
			<a href="/w/{slug}/purchases/new" class="btn btn-ghost mt-5">Log a purchase</a>
		</div>
	{:else}
		<div
			bind:this={canvas}
			role="application"
			aria-label="Spending map. Drag to pan, pinch or scroll to zoom."
			class="map-canvas relative flex-1 overflow-hidden"
			style="background: var(--paper); touch-action: none"
			onpointerdown={onPointerDown}
			onpointermove={onPointerMove}
			onpointerup={onPointerUp}
			onpointercancel={onPointerUp}
			onwheel={onWheel}
		>
			{#if tiles.length > 0}
				<div class="map-tiles pointer-events-none absolute inset-0">
					<!--
						Keyed on the *unwrapped* column. Tiles wrap across the antimeridian
						so panning past the date line keeps drawing map, which means the
						same (z,x,y) legitimately appears twice whenever the viewport is
						wider than the world — and keying on it threw `each_key_duplicate`,
						taking the whole page down at low zoom.
					-->
					{#each tiles as t (`${t.z}/${t.column}/${t.y}`)}
						<img
							src="{data.tileUrl}/{t.z}/{t.x}/{t.y}"
							alt=""
							draggable="false"
							decoding="async"
							onerror={retryTile}
							style="position:absolute; left:0; top:0; width:{t.size}px; height:{t.size}px; transform: translate3d({t.px}px, {t.py}px, 0)"
						/>
					{/each}
				</div>
			{/if}

			<svg
				class="pointer-events-none absolute inset-0"
				{width}
				{height}
				aria-hidden="true"
				style="overflow: visible"
			>
				<!-- The plot. Drawn whether or not there are tiles under it: the
				     coordinates are the measurement, and streets are context. -->
				<g class="graticule">
					{#each graticule.lines as l, i (i)}
						<line
							x1={l.x1}
							y1={l.y1}
							x2={l.x2}
							y2={l.y2}
							stroke="var(--hairline)"
							stroke-width="1"
						/>
					{/each}
					{#each graticule.labels as l, i (i)}
						<text
							x={l.x}
							y={l.y}
							font-size="10"
							text-anchor={l.anchor}
							fill="var(--ink-4)"
							class="num">{l.text}</text
						>
					{/each}
				</g>

				{#each visible as l (l.b.key)}
					<g class="bubble" transform="translate({l.x} {l.y})">
						<circle
							r={l.r}
							fill={wash(l.b.color)}
							stroke="var(--ink)"
							stroke-width="1"
							stroke-opacity="0.62"
						/>
						<!-- A surveyor's tick at the exact centroid: this is a measurement
						     taken at a point, not a blob dropped near one. -->
						<path
							d="M-3.5 0h7M0 -3.5v7"
							stroke="var(--ink)"
							stroke-width="0.75"
							stroke-opacity="0.5"
						/>
					</g>
				{/each}

				{#each visible.filter((l) => labelled.has(l.b.key)) as l (l.b.key)}
					<!--
						Positions come from labelLayout, the same function placeLabels used
						to reserve the space — so what won a slot is drawn exactly where
						the slot was.
					-->
					{@const lay = labelLayout(l.r)}
					<text
						x={l.x}
						y={l.y + lay.amountDy}
						text-anchor="middle"
						font-size="11"
						font-weight="700"
						fill="var(--ink)"
						class="num"
						style="font-family: var(--font-display)"
					>
						{formatMinor(l.b.totalMinor, data.currency)}
					</text>
					{#if nameOf(l.b)}
						<text
							x={l.x}
							y={l.y + lay.nameDy}
							text-anchor="middle"
							font-size="11"
							fill="var(--ink-3)"
						>
							{nameOf(l.b)}
						</text>
					{/if}
				{/each}
			</svg>

			<!-- Hit targets, separate from the drawing so every bubble clears the
			     touch floor however small it is drawn. -->
			{#each visible as l (l.b.key)}
				<button
					type="button"
					class="absolute rounded-full"
					aria-label="{l.b.topLabel ?? 'Unnamed place'}, {formatMinor(
						l.b.totalMinor,
						data.currency
					)}, {l.b.count} {l.b.count === 1 ? 'purchase' : 'purchases'}"
					style="left: {l.x - Math.max(l.r, 22)}px; top: {l.y -
						Math.max(l.r, 22)}px; width: {Math.max(l.r, 22) * 2}px; height: {Math.max(l.r, 22) *
						2}px; background: transparent"
					onclick={() => {
						if (!moved) sheet = l.b;
					}}
				></button>
			{/each}

			{#if scaleBar}
				<div
					class="pointer-events-none absolute flex items-center gap-1.5"
					style="left: 12px; bottom: 10px"
				>
					<span
						style="display:block; width: {scaleBar.px}px; height: 5px; border: 1px solid var(--ink-3); border-top: none"
					></span>
					<span class="num text-[10px]" style="color: var(--ink-3)">{scaleBar.text}</span>
				</div>
			{/if}

			<button
				type="button"
				onclick={fitAndCommit}
				class="icon-btn press material absolute"
				style="right: 12px; bottom: 34px"
				aria-label="Fit every place on screen"
			>
				<Maximize2 class="h-[17px] w-[17px]" />
			</button>

			{#if data.tileUrl}
				<!-- ODbL requires visible credit, so this is a permanent caption
				     rather than something behind a tap. -->
				<span
					class="pointer-events-none absolute rounded-[var(--r-sm)] px-1.5 py-0.5 text-[10px]"
					style="right: 6px; bottom: 6px; color: var(--ink-3); background: color-mix(in oklab, var(--paper) 78%, transparent)"
				>
					{data.tileAttribution}
				</span>
			{/if}

			{#if data.truncated}
				<span
					class="pointer-events-none absolute left-3 text-[11px]"
					style="top: 8px; color: var(--pending)"
				>
					Showing the largest {data.points.length} purchases
				</span>
			{/if}
		</div>
	{/if}
</div>

{#if sheet}
	<!-- A bottom sheet rather than a popover pinned to the bubble: this is about
	     the thing under your thumb, and a tooltip anchored to a circle is the
	     Google Maps idiom this map is deliberately not. -->
	<div
		class="fixed inset-0 z-40"
		style="background: var(--scrim)"
		transition:fade={{ duration: 140 }}
		aria-hidden="true"
	></div>
	<div
		class="fixed inset-x-0 bottom-0 z-50 px-3"
		style="padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px))"
		transition:fly={{ y: 24, duration: 170 }}
		use:modal
		use:dismiss={() => (sheet = null)}
	>
		<!--
			`.card-lg` is a radius modifier, not a card — the surface and the float
			shadow are set here, exactly as the ledger's filter modal does it.
		-->
		<div
			class="card-lg mx-auto max-w-lg p-5"
			style="background: var(--surface); box-shadow: var(--shadow-float)"
		>
			<h2
				class="font-[family-name:var(--font-display)] text-[22px] leading-tight"
				style="color: var(--ink)"
			>
				{sheet.topLabel ?? 'Unnamed place'}
			</h2>
			<p class="section-label mt-1">
				{sheet.count}
				{sheet.count === 1 ? 'purchase' : 'purchases'} · {data.label}
			</p>
			<p
				class="num mt-3 font-[family-name:var(--font-display)] text-[32px] font-bold"
				style="color: var(--ink)"
			>
				{formatMinor(sheet.totalMinor, data.currency)}
			</p>
			<p class="num mt-0.5 text-[11px]" style="color: var(--ink-3)">
				{formatCoords({
					latE3: Math.round(sheet.center.lat * E3),
					lngE3: Math.round(sheet.center.lng * E3)
				})} · ±110 m
			</p>

			{#if sheetInherited}
				<p class="mt-2 text-[12px] leading-relaxed" style="color: var(--ink-3)">
					{sheet.count === 1 ? 'Placed' : 'All placed'} from the vendor's usual location. Nobody recorded
					being here.
				</p>
			{/if}

			<div class="mt-4" style="border-top: 0.5px solid var(--hairline)">
				{#each sheetRows as r (r.id)}
					<a
						href="/w/{slug}/purchases/{r.id}"
						class="press hairline flex items-baseline justify-between gap-3 py-3"
					>
						<span class="truncate text-[15px]" style="color: var(--ink)">{r.itemName}</span>
						<span class="num shrink-0 text-[15px] font-medium" style="color: var(--ink)">
							{formatMinor(r.amountMinor, data.currency)}
						</span>
					</a>
				{/each}
			</div>

			<a
				href={ledgerLink(slug, {
					from: data.rangeFrom,
					to: data.rangeTo,
					bbox: sheet.bboxE3
				})}
				class="btn btn-accent mt-4 w-full"
			>
				See all purchases here
			</a>
			<button type="button" class="btn btn-plain mt-1 w-full" onclick={() => (sheet = null)}>
				Close
			</button>
		</div>
	</div>
{/if}

<style>
	/*
	 * The paper tooth, inlined rather than using the shared `.grain` class.
	 *
	 * `.grain` ships a `.grain > * { position: relative }` rule to lift content
	 * above its texture, and that rule is unlayered — so it beats Tailwind's
	 * `absolute` utility on every direct child. On a map, where the tile layer,
	 * the plot and the controls are all absolutely positioned, that quietly
	 * dropped every one of them back into normal flow. Same texture, no rule
	 * about children.
	 */
	.map-canvas::after {
		content: '';
		position: absolute;
		inset: 0;
		pointer-events: none;
		opacity: 0.06;
		mix-blend-mode: multiply;
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
	}

	/*
	 * A basemap printed on the statement's paper rather than pasted onto it.
	 * Desaturate to kill the tile source's own palette, sepia toward the paper's
	 * warmth, then multiply so the paper and its grain show through the roads.
	 * Contrast comes *down*: a printed map is faint, and full-contrast tiles under
	 * an ink bubble is exactly the screenshot this is not.
	 */
	:global(.map-tiles img) {
		filter: grayscale(1) sepia(0.4) saturate(0.6) contrast(0.92) brightness(1.02);
		mix-blend-mode: multiply;
		/*
		 * Tuned against real tiles, not guessed. The first pass (0.5 opacity,
		 * contrast 0.86, brightness 1.06) rendered near-white OSM tiles into cream
		 * on cream — the basemap loaded correctly and was invisible. Going the
		 * other way, at 0.75 the tile source's own place labels started competing
		 * with the bubbles' names for the same reading. This sits where streets
		 * and water are legible as context and the plot is unambiguously the
		 * subject.
		 */
		opacity: 0.55;
	}
	@media (prefers-color-scheme: dark) {
		:global(:root:not([data-theme='light']) .map-tiles img) {
			/* Invert first so roads stay light on dark, then tint back to the ink. */
			filter: grayscale(1) invert(1) sepia(0.3) saturate(0.5) contrast(0.8) brightness(0.85);
			mix-blend-mode: screen;
			opacity: 0.34;
		}
	}
	:global([data-theme='dark'] .map-tiles img) {
		filter: grayscale(1) invert(1) sepia(0.3) saturate(0.5) contrast(0.8) brightness(0.85);
		mix-blend-mode: screen;
		opacity: 0.34;
	}

	.bubble circle {
		transition:
			r var(--dur) var(--ease-out),
			fill-opacity var(--dur) var(--ease-out);
	}
	@media (prefers-reduced-motion: reduce) {
		.bubble circle {
			transition: none;
		}
	}
</style>
