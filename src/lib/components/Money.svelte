<script lang="ts">
	import { maskAmount } from '$lib/domain/visibility/discretion';
	import { formatMinor } from '$lib/money-format';

	let {
		minor,
		currency,
		sign = false,
		block = false,
		/** Blank the digits — discretion, not secrecy. See domain/visibility/discretion. */
		masked = false,
		class: cls = ''
	}: {
		minor: bigint;
		currency: string;
		sign?: boolean;
		block?: boolean;
		masked?: boolean;
		class?: string;
	} = $props();

	// Live, not one-shot: flipping the OS setting mid-session must take effect
	// without a reload, exactly as theme.svelte.ts re-reads its media query.
	const media =
		typeof window !== 'undefined' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
	let reduce = $state(media?.matches ?? true);
	$effect(() => {
		const onChange = () => (reduce = media?.matches ?? true);
		media?.addEventListener('change', onChange);
		return () => media?.removeEventListener('change', onChange);
	});

	let text = $derived.by(() => {
		const body = formatMinor(minor < 0n ? -minor : minor, currency);
		const prefix = minor < 0n ? '−' : sign ? '+' : '';
		// The sign goes with the digits when masked: a leading − would announce
		// "you're under", which is exactly what the mask is meant to withhold.
		return masked ? maskAmount(body) : prefix + body;
	});
	let chars = $derived([...text]);

	// A per-glyph roll: changed digits rise into place with a slight stagger.
	// Amounts stay tabular so nothing shifts horizontally while they settle.
	function roll(_node: Element, { i }: { i: number }) {
		if (reduce) return {};
		return {
			delay: i * 20,
			duration: 300,
			css: (t: number) => {
				const e = 1 - Math.pow(1 - t, 3);
				return `opacity:${t};transform:translateY(${(1 - e) * 0.5}em)`;
			}
		};
	}

	/*
	 * The roll must never own the resting state. A glyph mounted offscreen —
	 * a Money below the fold, or one that lands mid view-transition — can have
	 * its animation throttled by the browser and sit frozen on its first frame:
	 * a blank where a digit belongs, until a scroll happens to resume it. So
	 * after the longest possible roll has certainly finished, every glyph is
	 * forced to its final, fully-visible style. A completed roll is a no-op;
	 * a frozen one snaps clean.
	 */
	let host: HTMLElement | undefined = $state();
	$effect(() => {
		// Track chars so a later value change re-arms the settle for new glyphs.
		void chars;
		void masked;
		if (reduce || !host) return;
		const timer = setTimeout(() => {
			for (const el of host!.querySelectorAll<HTMLElement>('span')) {
				el.style.animation = 'none';
				el.style.opacity = '1';
				el.style.transform = 'none';
			}
		}, 1500);
		return () => clearTimeout(timer);
	});
</script>

<span
	class="num {cls}"
	style="overflow:hidden;display:{block ? 'block' : 'inline-flex'}"
	aria-hidden={masked ? 'true' : undefined}
	bind:this={host}
>
	{#each chars as c, i (i + ':' + c)}
		<span in:roll={{ i }} style="display:inline-block;white-space:pre">{c}</span>
	{/each}
</span>
{#if masked}
	<!-- Bullets read as noise to a screen reader; say what's actually there. -->
	<span class="sr-only">Amount hidden</span>
{/if}
