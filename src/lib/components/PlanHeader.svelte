<script lang="ts">
	import type { Snippet } from 'svelte';
	import Segmented from '$lib/components/Segmented.svelte';
	import { page } from '$app/state';
	import { CalendarDays } from '@lucide/svelte';

	/**
	 * The Plan tab's masthead and its sub-navigation.
	 *
	 * Recurring charges and buckets are both money already claimed before
	 * anything discretionary — a subscription and a standing transfer to the
	 * travel fund are the same shape from a budgeting view — so they share a tab.
	 *
	 * The heading names the tab, "Plan", in the same place every other tab puts
	 * its own: top left, actions on the right. The switch used to sit *above* the
	 * heading, which made Plan the one tab whose title moved down the screen and
	 * whose first thing under the thumb was navigation rather than content. The
	 * switch now sits under the heading, full width, the way a native large title
	 * carries a segmented control: one wide target per half, easy one-handed.
	 *
	 * Real links rather than a client-side toggle: each keeps its own route, load
	 * and actions, and stays independently bookmarkable.
	 *
	 * The calendar is an action beside the heading rather than a third segment.
	 * A third segment would say it is a sibling of Recurring and Buckets, and it
	 * isn't: it's a view *across* both.
	 */
	/**
	 * `tools` are a page's own secondary buttons (Recurring's sort and group);
	 * `primary` is its + New. The calendar sits between them, always directly
	 * left of + New, so switching Recurring ↔ Buckets leaves the calendar and
	 * + New in exactly the same place under the thumb, whatever else a page adds.
	 */
	let { tools, primary }: { tools?: Snippet; primary?: Snippet } = $props();

	let slug = $derived(page.params.workspace);
	let current = $derived(page.url.pathname.includes('/buckets') ? 'buckets' : 'recurring');

	const items = [
		{ key: 'recurring', label: 'Recurring', hint: 'Bills & subscriptions' },
		{ key: 'buckets', label: 'Buckets', hint: 'Set aside each month' }
	];
</script>

<div class="space-y-3">
	<div class="flex items-center justify-between gap-3 px-1 pt-1">
		<h1 class="text-[28px]">Plan</h1>
		<div class="flex items-center gap-2">
			{@render tools?.()}
			<a
				href="/w/{slug}/calendar"
				class="press icon-btn"
				aria-label="Month calendar"
				title="Scheduled, by day"
			>
				<CalendarDays class="h-4 w-4" />
			</a>
			{@render primary?.()}
		</div>
	</div>
	<Segmented
		options={items.map((i) => ({
			value: i.key,
			label: i.label,
			href: `/w/${slug}/${i.key}`,
			title: i.hint
		}))}
		value={current}
		ariaLabel="Plan section"
	/>
</div>
