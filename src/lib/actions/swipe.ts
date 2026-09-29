/**
 * Swipe-to-reveal for a ledger row. Attach to a container that holds an action
 * layer and a `[data-swipe-content]` element; the content slides left to expose
 * the actions behind it. A short drag snaps back, a long one snaps open.
 *
 * The design points that make it behave:
 *  - The drag starts on the content, so tapping an already-revealed action button
 *    (a sibling of the content, still inside the container) runs that button
 *    instead of starting a new drag or closing the row.
 *  - The content must carry `touch-action: pan-y` so the browser yields
 *    horizontal pointer events to us instead of hijacking them for scroll — the
 *    single most common cause of a swipe that only moves a few pixels.
 *  - Direction is decided in the first few pixels: a vertical intent detaches and
 *    lets the page scroll; a horizontal one is tracked on the window so the
 *    finger can leave the row without dropping the gesture.
 *  - Only one row is open at a time, via a module-level registry.
 */

let openRegistry: (() => void) | null = null;

const reduceMotion = () =>
	typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export interface SwipeOptions {
	/** How far the row opens, in px — the width of the actions behind it. */
	width: number;
	/** Off for rows with no action to reveal; the content then never moves. */
	enabled?: boolean;
}

export function swipe(node: HTMLElement, opts: SwipeOptions) {
	let width = opts.width;
	let enabled = opts.enabled ?? true;

	// The element that actually translates. Falls back to the container itself.
	const content = node.querySelector<HTMLElement>('[data-swipe-content]') ?? node;

	/*
	 * The action layer sits flush beneath the content's right edge, inside a
	 * rounded card that clips both. Where the two edges coincide the browser
	 * anti-aliases them together, and a hairline of the action colour (the red
	 * of Deny or End) showed down the right of every row at rest. Clipping the
	 * layer's last pixel removes the shared edge; a pixel of a 88px button is
	 * nothing anyone sees once the row is open.
	 */
	for (const layer of node.children) {
		if (layer !== content && layer instanceof HTMLElement) {
			layer.style.clipPath = 'inset(0 1px 0 0)';
		}
	}

	let startX = 0;
	let startY = 0;
	let dir: 'none' | 'h' | 'v' = 'none';
	let open = false;
	let tx = 0;

	const setTransform = (x: number, animate: boolean) => {
		content.style.transition =
			animate && !reduceMotion() ? 'transform 0.22s cubic-bezier(0.22,1,0.36,1)' : 'none';
		content.style.transform = x === 0 ? '' : `translateX(${x}px)`;
		tx = x;
	};

	const doOpen = () => {
		if (openRegistry && openRegistry !== doClose) openRegistry();
		openRegistry = doClose;
		open = true;
		setTransform(-width, true);
	};
	function doClose() {
		open = false;
		if (openRegistry === doClose) openRegistry = null;
		setTransform(0, true);
	}

	const detach = () => {
		window.removeEventListener('pointermove', onMove);
		window.removeEventListener('pointerup', onUp);
		window.removeEventListener('pointercancel', onUp);
	};

	const onMove = (e: PointerEvent) => {
		const dx = e.clientX - startX;
		const dy = e.clientY - startY;
		if (dir === 'none') {
			if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
			if (Math.abs(dy) > Math.abs(dx)) {
				dir = 'v';
				detach();
				return;
			}
			dir = 'h';
		}
		if (dir === 'h') {
			e.preventDefault();
			const base = open ? -width : 0;
			setTransform(Math.max(-width, Math.min(0, base + dx)), false);
		}
	};

	const onUp = () => {
		detach();
		if (dir !== 'h') return;
		if (tx <= -width * 0.4) doOpen();
		else doClose();
	};

	const onPointerDown = (e: PointerEvent) => {
		if (!enabled || e.button !== 0) return;
		startX = e.clientX;
		startY = e.clientY;
		dir = 'none';
		setTransform(open ? -width : 0, false);
		window.addEventListener('pointermove', onMove, { passive: false });
		window.addEventListener('pointerup', onUp);
		window.addEventListener('pointercancel', onUp);
	};

	const onScroll = () => {
		if (open) doClose();
	};

	// Suppress the content's own click after a horizontal drag (so it doesn't
	// navigate), and close on a tap while open. Bound to the content, so action
	// buttons in the layer behind are unaffected.
	const onContentClick = (e: MouseEvent) => {
		if (dir === 'h' || open) {
			e.preventDefault();
			e.stopPropagation();
			if (open && dir !== 'h') doClose();
		}
	};

	const onDocDown = (e: PointerEvent) => {
		if (open && !node.contains(e.target as Node)) doClose();
	};

	content.addEventListener('pointerdown', onPointerDown);
	content.addEventListener('click', onContentClick, true);
	window.addEventListener('scroll', onScroll, true);
	document.addEventListener('pointerdown', onDocDown, true);

	return {
		update(next: SwipeOptions) {
			width = next.width;
			enabled = next.enabled ?? true;
			if (!enabled && open) doClose();
		},
		destroy() {
			detach();
			if (openRegistry === doClose) openRegistry = null;
			content.removeEventListener('pointerdown', onPointerDown);
			content.removeEventListener('click', onContentClick, true);
			window.removeEventListener('scroll', onScroll, true);
			document.removeEventListener('pointerdown', onDocDown, true);
		}
	};
}
