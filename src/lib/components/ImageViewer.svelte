<script lang="ts">
	/**
	 * Full-screen look at a photo or a bill page.
	 *
	 * The list and the detail hero both have to fit a photo into a layout, so a
	 * tall receipt is always compromised somewhere. This is the one place it
	 * isn't: the image gets the whole screen at its own shape.
	 *
	 * The canvas is the app's own paper — the viewer is the photo card from the
	 * detail page, fullscreen, not a different application. The photo carries
	 * the same frame it has everywhere else (hairline + card shadow) so a bright
	 * receipt keeps its edges on cream paper in light mode; framed-on-paper is
	 * the idiom every other image in the app already uses.
	 */
	import { X } from '@lucide/svelte';

	let {
		src,
		alt = '',
		/** One line of context under the photo — size, dimensions, when added. */
		meta = '',
		open = $bindable(false)
	}: { src: string; alt?: string; meta?: string; open?: boolean } = $props();

	let dialog: HTMLDialogElement | null = $state(null);

	/*
	 * <dialog showModal> rather than a hand-rolled overlay: the platform gives
	 * focus trapping, Escape, inertness of the page behind, and the top layer
	 * (so nothing can z-index its way over it) for free. Re-implementing those is
	 * where accessible modals usually go wrong.
	 */
	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) dialog.showModal();
		else if (!open && dialog.open) dialog.close();
	});
</script>

<dialog
	bind:this={dialog}
	onclose={() => (open = false)}
	class="max-h-none max-w-none border-none bg-transparent p-0"
	style="width: 100vw; height: 100dvh"
	aria-label={alt || 'Photo'}
>
	<div
		class="relative flex h-full w-full flex-col items-center justify-center gap-3 p-4 pb-0"
		style="background: var(--paper)"
	>
		<!--
			Tap-anywhere-to-close, as its own element behind the image rather than a
			handler on the image. A click listener on an <img> is unreachable by
			keyboard; Escape and the close button are the accessible ways out, so
			this is a pointer convenience only and stays out of the a11y tree.
		-->
		<button
			onclick={() => (open = false)}
			tabindex="-1"
			aria-hidden="true"
			class="absolute inset-0 cursor-default"
		></button>
		<!-- The frame rides on outline, not inset box-shadow: an <img> paints over
		     its own inset shadow, and the hairline is the point. -->
		<img
			{src}
			{alt}
			class="pointer-events-none relative max-h-full max-w-full object-contain"
			style="border-radius: 4px; outline: 1px solid var(--hairline); outline-offset: -1px; box-shadow: var(--shadow-card)"
		/>
		{#if meta}
			<p
				class="num mb-[max(env(safe-area-inset-bottom, 0px), 12px)] relative max-w-full truncate rounded-[var(--r-full)] px-3 py-1.5 text-[12px]"
				style="background: var(--surface); color: var(--ink-2); box-shadow: inset 0 0 0 1px var(--hairline)"
			>
				{meta}
			</p>
		{/if}
	</div>

	<!-- Inside the safe area: on a notched phone a top-right button at inset 0
	     lands under the status bar. The app's own icon-button recipe — surface,
	     hairline, ink-3 — which stays legible on paper in both themes. -->
	<button
		onclick={() => (open = false)}
		aria-label="Close"
		class="press absolute flex h-10 w-10 items-center justify-center rounded-full"
		style="top: calc(env(safe-area-inset-top, 0px) + 12px); right: 12px; background: var(--surface); color: var(--ink-3); box-shadow: inset 0 0 0 1px var(--hairline), var(--shadow-card)"
	>
		<X class="h-5 w-5" />
	</button>
</dialog>

<style>
	dialog::backdrop {
		background: oklch(0 0 0 / 0.6);
	}
	/* The dialog is the full viewport, so it must not scroll — the image is
	   already bounded by max-height. */
	dialog {
		overflow: hidden;
	}
</style>
