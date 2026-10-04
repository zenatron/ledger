<script lang="ts" module>
	export interface RibbonPart {
		key: string;
		/** Read out in the ribbon's accessible name. */
		label: string;
		color: string;
		/** Its size; parts are drawn in proportion to the sum. */
		minor: bigint;
	}
</script>

<script lang="ts">
	/**
	 * A whole cut into its parts, left to right, in proportion.
	 *
	 * A ribbon, not a ring or a pie: the parts are read against each other and
	 * against the whole, which a straight bar does exactly and a circle only
	 * approximately — and the design rules out many-slice pies.
	 *
	 * Each piece is separated by a hairline of the card so neighbours of similar
	 * hue stay two things. With a part in focus the rest recede rather than
	 * vanish: the part is only meaningful against the whole. When `onpick` is
	 * given the pieces are tappable (Recurring's category filter); the labelled
	 * controls for that live beside the ribbon, so the pieces themselves stay out
	 * of the tab order.
	 */
	let {
		parts,
		focus = null,
		onpick,
		class: cls = ''
	}: {
		parts: RibbonPart[];
		focus?: string | null;
		onpick?: (key: string) => void;
		class?: string;
	} = $props();

	const total = $derived(parts.reduce((s, p) => s + (p.minor > 0n ? p.minor : 0n), 0n));
	const share = (minor: bigint) => (total > 0n && minor > 0n ? Number(minor) / Number(total) : 0);
	function pct(f: number): string {
		if (f > 0 && f < 0.01) return '<1%';
		return `${Math.round(f * 100)}%`;
	}

	// Grows in from nothing once, on mount, so the proportions arrive as a
	// gesture rather than a flash. Two frames so there is a from-state.
	let drawn = $state(false);
	$effect(() => {
		const id = requestAnimationFrame(() => requestAnimationFrame(() => (drawn = true)));
		return () => cancelAnimationFrame(id);
	});

	const visible = $derived(parts.filter((p) => p.minor > 0n));
</script>

{#if visible.length > 0}
	<div
		class="flex h-3 w-full gap-[2px] overflow-hidden rounded-full {cls}"
		style="background: var(--surface-2)"
		role="img"
		aria-label={visible.map((p) => `${p.label} ${pct(share(p.minor))}`).join(', ')}
	>
		{#each visible as p (p.key)}
			{@const on = !focus || focus === p.key}
			{@const style = `flex-basis: ${drawn ? share(p.minor) * 100 : 0}%; background: ${p.color}; opacity: ${on ? 1 : 0.2}`}
			{#if onpick}
				<button
					type="button"
					tabindex="-1"
					aria-hidden="true"
					onclick={() => onpick(p.key)}
					class="ribbon-part h-full cursor-pointer"
					{style}
				></button>
			{:else}
				<span class="ribbon-part h-full" {style}></span>
			{/if}
		{/each}
	</div>
{/if}

<style>
	.ribbon-part {
		flex-grow: 0;
		flex-shrink: 0;
		min-width: 0;
		transition:
			flex-basis 700ms var(--ease-out),
			opacity var(--dur) var(--ease-out);
	}
	.ribbon-part:first-child {
		border-radius: var(--r-full) 0 0 var(--r-full);
	}
	.ribbon-part:last-child {
		border-radius: 0 var(--r-full) var(--r-full) 0;
	}
	.ribbon-part:only-child {
		border-radius: var(--r-full);
	}
	@media (prefers-reduced-motion: reduce) {
		.ribbon-part {
			transition: none;
		}
	}
</style>
