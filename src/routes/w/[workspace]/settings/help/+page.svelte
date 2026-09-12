<script lang="ts">
	import { page } from '$app/state';
	import {
		ChevronLeft,
		ChevronDown,
		CreditCard,
		Check,
		Bell,
		Gift,
		Moon,
		ChartNoAxesColumnIncreasing,
		Repeat,
		Landmark,
		CircleDollarSign,
		Users,
		Sparkles,
		Wallet,
		NotebookText,
		MessageCircle,
		PiggyBank
	} from '@lucide/svelte';

	const HELP_ICONS: Record<string, typeof CreditCard> = {
		card: CreditCard,
		checkmark: Check,
		bell: Bell,
		gift: Gift,
		moon: Moon,
		chart: ChartNoAxesColumnIncreasing,
		repeat: Repeat,
		bank: Landmark,
		dollar: CircleDollarSign,
		people: Users,
		sparkle: Sparkles,
		wallet: Wallet,
		notepad: NotebookText,
		message: MessageCircle,
		piggy: PiggyBank
	};

	/**
	 * The app's rules in one place. Written against how it actually behaves.
	 * Several of these (sealing hiding totals, the approver conflict, recurring
	 * bypassing approval) are deliberate decisions that are impossible to infer
	 * from the UI alone.
	 */
	let slug = $derived(page.params.workspace);

	// Empty states link straight to the answer, e.g. …/settings/help?s=buckets.
	// A query param rather than a #fragment on purpose: a fragment makes the
	// browser scroll to the element itself, before any of this runs, so the
	// first section scrolled the heading off screen for no reason.
	$effect(() => {
		const id = page.url.searchParams.get('s') ?? '';
		if (!id) return;
		const el = document.getElementById(id);
		if (!(el instanceof HTMLDetailsElement)) return;
		el.open = true;
		requestAnimationFrame(() => {
			const { top, bottom } = el.getBoundingClientRect();
			const needsRoom = bottom > window.innerHeight && top > 100;
			if (top < 0 || needsRoom) {
				el.scrollIntoView({ block: 'start', behavior: 'smooth' });
			}
		});
	});

	const groups = [
		{
			label: 'The basics',
			sections: [
				{
					id: 'logging',
					icon: 'card',
					title: 'Logging vs asking',
					body: [
						'**Log it** records something you already bought. **Ask first** requests permission before you spend.',
						'Logging something from a while ago? Set **When** to the day it happened so it counts toward that month instead of the current one.',
						'Which one needs approval is set per person in Settings → Members. If your policy says no approval is needed, "Ask first" is approved the moment you submit it.'
					]
				},
				{
					id: 'describe',
					icon: 'sparkle',
					title: 'Describe a purchase',
					body: [
						'At the top of the Add screen is a field you can type or **dictate** into, using your phone keyboard’s microphone. Say something like *23 on lunch at Krusty Krab yesterday* and Ledger fills in the fields for you.',
						'The amount and date come from fixed rules, so a misheard number is visible and easy to correct before you save. A category is only suggested when AI assistance is turned on. Nothing is saved until you tap **Log it** or **Ask first**.',
						'The sparkle button at the top of the app understands the same thing: *log 18 for tacos* opens the Add screen already filled in.'
					]
				}
			]
		},
		{
			label: 'Approvals & decisions',
			sections: [
				{
					id: 'approvals',
					icon: 'checkmark',
					title: 'Approvals',
					body: [
						'A policy is either **never**, **above an amount**, or **always**. You also choose who decides: any one of the approvers, or one specific person.',
						'Being someone’s approver and needing approval yourself are independent settings.',
						'**Spending more than approved sends it back.** If the final amount is well over what was approved, the purchase returns to waiting until the approver confirms the real price.',
						'Editing the item, amount, or category of an approved purchase also sends it back. Purchases that never needed approval just update.',
						'**A denial is not the end.** The person who asked can **Ask again** with a note saying what changed, which sends it back to whoever can decide now. An approver who said no can **Allow it after all**, also with a note. Both land in the purchase\u2019s history beside the denial, so the record shows it was refused and then answered again.'
					]
				},
				{
					id: 'needs',
					icon: 'bell',
					title: 'What needs you',
					body: [
						'Two kinds of items can wait on you. Both sit at the top of the Ledger and add up on one card in Settings.',
						'**Awaiting a decision**: purchases waiting for an approver to say yes or no.',
						'**Confirm what you paid**: purchases that are approved but have no final amount yet. This can be a recurring bill set to ask you, or a request you approved for an estimate. Only you can confirm your own. Open one to enter the amount you were actually charged and the date.',
						'Each one is dated by when it happened, so an older item counts toward its own month. They are listed oldest first.'
					]
				},
				{
					id: 'sleep',
					icon: 'moon',
					title: 'Sleep on it',
					body: [
						'Not sure about a purchase? Put it to sleep instead of deciding now. The request pauses for a set time and then comes back for a decision.',
						'On a waiting request, tap **Sleep on it** and choose how long. The suggested length is based on the amount, and you can spin the dial to change it. Either the requester or an approver can start a pause.',
						'While it’s asleep it can’t be approved or bought, and it shows on the Ledger under **Sleeping on it** with a countdown. You can wake it early or let it go at any time.',
						'When the time is up it’s marked **Ready to decide** and you get a reminder. From there you can choose **Buy it** to return it to the approval queue, **wait more**, or **let it go**.'
					]
				},
				{
					id: 'gift',
					icon: 'gift',
					title: 'Gift mode',
					body: [
						'Hides a purchase from the people you pick until a date you choose.',
						'It is hidden **everywhere**: the list, search, the detail page, and every total on Activity. Their spending figures are computed as if it does not exist, so the amount cannot be worked out by subtraction.',
						'Only the person who created it can reveal it early. It opens automatically on the chosen date.',
						'If the only possible approver is also the person it is hidden from, it is approved automatically **and the audit trail says so**.'
					]
				}
			]
		},
		{
			label: 'Planning & tracking',
			sections: [
				{
					id: 'budgets',
					icon: 'chart',
					title: 'Budgets & Activity',
					body: [
						'Budgets are monthly, set overall or per category, and can be scheduled up to a year ahead for months you know will be different.',
						'Setting a new budget does not rewrite past months. Each month keeps the budget that applied at the time.',
						'You get a notification when a budget passes 80% and again when it is exceeded.',
						'Swipe the card on Activity to move between periods.',
						'Tap any category or person in a breakdown to open just those purchases in the Ledger, already filtered to the period you were looking at. You can also filter the Ledger yourself by date, person, or category.'
					]
				},
				{
					id: 'recurring',
					icon: 'repeat',
					title: 'Recurring charges',
					body: [
						'For rent, subscriptions, and bills. Each rule generates purchases on its own schedule. A rule can be charged to a bucket, which draws the bucket down as each charge lands.',
						'**Record automatically** posts them as already paid at the set amount. Leave it off for a bill that changes each month, and each charge appears under **Confirm what you paid** at the top of the Ledger, waiting for you to enter the real figure.',
						'Recurring purchases skip approval. The decision was made when you created the rule.',
						'If the app is offline for a while, missed occurrences are generated when it comes back.',
						'Ending a charge keeps it under **Ended** at the bottom of the page, with what it cost you over its life. You can start it again at a new price or on a new schedule, or delete the record for good.'
					]
				},
				{
					id: 'buckets',
					icon: 'bank',
					title: 'Buckets',
					body: [
						'A bucket sets money aside on a schedule, such as a travel fund or an emergency float. Choose the amount and how often it accrues. A start date in the past can backfill accruals you already missed.',
						'Buckets belong to the person who made them. Only that person can withdraw or adjust one.',
						'Anyone can charge a purchase to a bucket. Under **Who can charge this**, pick **Only me** or name the people who may, and it disappears from everyone else\u2019s purchase form. Any recurring rule of theirs that charged it stops charging it, and keeps running as ordinary spending.',
						'You can charge a purchase to a bucket, which draws it down. The workspace sets a default for whether bucket charges skip approval, and each person can override it for their own charges.',
						'A bucket can go **overdrawn**: a charge bigger than the balance is allowed, since no real money moves. You are warned before it happens and the bucket is marked on this page. The next accrual pays off the shortfall before adding to the balance, and the part the bucket could not cover counts as ordinary spending.'
					]
				},
				{
					id: 'income',
					icon: 'dollar',
					title: 'Income',
					body: [
						'Add what comes in, either as a one-off or as a monthly amount on a chosen day.',
						'A monthly entry is a template. The occurrences are computed when you view them, so editing the template corrects every month at once.',
						'Income is visible to everyone in the workspace. Unlike purchases, it cannot be hidden.',
						'It drives the net position on Activity: what came in, minus what went out and what you set aside, plus whatever you withdrew from a bucket. That spending was already paid for in the month you set it aside.'
					]
				}
			]
		},
		{
			label: 'Harmony',
			sections: [
				{
					id: 'safe-to-spend',
					icon: 'wallet',
					title: 'Safe to Spend',
					body: [
						'The number at the top of the Ledger is how much is free to spend this month. Tap it to see the full breakdown.',
						'It starts from your **Income** for the month, then subtracts four things. **Recurring** is the bills still to come before month-end. **Saved** is what you set aside into your buckets this month. **Approved** is purchases that were approved but not yet paid. **Spent** is what has already left your account, net of refunds. What remains is **Free to spend**.',
						'Money charged to a bucket does not count as spending here, because it was set aside in an earlier month. If a bucket is charged past its balance, the uncovered part does count as spending.',
						'**Pending** requests and ones you’re **sleeping on** are shown but not subtracted, since they might still be denied or let go. If you set a budget, Harmony also marks the point where the budget becomes the limit.',
						'Every figure is plain arithmetic computed on your server at the moment you view it, so a hidden gift never appears in the total shown to the person it is hidden from.',
						'In **Settings → Harmony**, the **Safe to Spend** switch decides whether the headline appears at all, and how it reads: **Hidden until tapped** (the default) shows the digits as dots until you tap the eye, and hides them again the next time you open the app; **Always shown** leaves them on screen. **The months after** switches the projection on and off inside the breakdown. All of it is yours alone and changes nothing for anyone else in the workspace.'
					]
				},
				{
					id: 'statement',
					icon: 'notepad',
					title: 'Month-End Statement',
					body: [
						'From the Activity page, open the statement for any month. It summarizes what came in, what went out, what you set aside, and where you landed. It defaults to the current month, marked *in progress* until the month ends.',
						'Harmony summarizes the month in plain language at the top. It only comments on net position when income is recorded, since a balance needs both sides. With no income logged, it describes the spending without judging it.',
						'Every line is seal-aware, like the rest of the app: a statement shows only what you are allowed to see. Use the print button for a clean paper copy.'
					]
				},
				{
					id: 'reconcile',
					icon: 'checkmark',
					title: 'Reconciling a statement',
					body: [
						'Export a CSV or PDF from your bank and import it under Settings → Reconcile. Ledger reads the date, amount, and description columns (you can name them yourself if the headers are unfamiliar) and matches each transaction against what is recorded here. A PDF is parsed on your device: only the three columns are sent, and the document never leaves it.',
						'A match is only a **suggestion**. Importing never creates, edits, or deletes a purchase and never changes an amount. Confirming a match writes a single mark saying the purchase appeared on a statement. Undo is always available, and removing an import releases every mark it made.',
						'When two purchases fit a line equally well, Ledger shows both and lets you choose. An unresolved line arrives with its shortlist of closest matches, each one tap from being linked. Lines that were never purchases, such as fees or transfers, can be set aside, and a line with nothing behind it can be logged as a purchase in one tap.',
						'**Help me find this** appears on an unmatched line if AI assistance is on. It helps where a bank descriptor like *SQ \\*BLUE BOTTLE 0042* shares no words with *flat white*. It picks from the purchases already on screen and highlights the best candidate. You still press Link.',
						'Reconciling is seal-aware. A line that belongs to a purchase hidden from you reads *accounted for, hidden from you*. That is enough to avoid logging a duplicate of a gift you are not meant to know about, and it reveals nothing more.'
					]
				},
				{
					id: 'pictures',
					icon: 'sparkle',
					title: 'Reading a bill, receipt or scan',
					body: [
						'Most PDFs carry their text inside them, and Ledger reads it directly without AI. A **scan** is a photograph of a page with no text in it, so it needs a model that can see.',
						'With a vision model turned on, Ledger offers to read scanned bills, receipt photos, and scanned bank statements. It always asks first and shows you what it read before anything lands in a field.',
						'**Nothing it reads is taken on trust.** The model only copies what is printed, and Ledger then parses those characters with the same rules it uses for any other text. Anything it can’t read cleanly is left blank for you to fill in, so a misread costs some typing.',
						'A statement gets one extra step. Before importing, Ledger shows the bank, account, and period it read from the page and asks you to confirm they are yours. Those imports stay marked wherever they appear, so you can always tell which figures were transcribed.',
						'If your model cannot read images, Ledger says so and points you to one that can. Most external providers don’t publish their models’ capabilities, so Ledger tries anyway and shows you the provider’s own answer.'
					]
				},
				{
					id: 'palette',
					icon: 'message',
					title: 'Asking questions',
					body: [
						'The sparkle in the header takes plain language: *how much did I spend on groceries last month*, *what’s my net position*, *add income of 4800 per month on the first*, or *log 23 for lunch* to open the Add screen filled in.',
						'It shows what it understood as you type and offers to complete a half-typed command instead of guessing what is missing.',
						'The commands it recognizes and the totals it computes use pattern matching and arithmetic on your server, with or without AI assistance. With a model turned on, it can also answer open-ended questions like *am I spending more than last month* over your real figures. It reads those numbers from the app and tells you when the answer isn’t in the data.'
					]
				},
				{
					id: 'ai',
					icon: 'sparkle',
					title: 'AI assistance',
					body: [
						'Harmony works entirely on plain arithmetic and pattern matching. In Settings → Harmony you can optionally let a language model help with the fuzzy parts: suggesting a category, matching a cryptic bank line to a purchase, reading a bill that only exists as a picture, or answering an open-ended question using figures the app has already computed.',
						'It only ever **suggests** or **explains**. It cannot approve a purchase, move money, or decide your Safe to Spend. When it answers a question it uses your real figures, and every suggestion is checked against the app’s own options before you see it.',
						'You choose the source. **Local** runs a model on your own machine, so nothing leaves your server. **External** uses an outside API, which means the text you send is processed by a third party. **Off**, the default, keeps everything deterministic and contacts no model at all.'
					]
				}
			]
		},
		{
			label: 'Workspace',
			sections: [
				{
					id: 'members',
					icon: 'people',
					title: 'Members & roles',
					body: [
						'Everyone is an **owner** or a **member**. Owners change workspace settings, budgets, invites, and everyone’s approval policy; members do everything else.',
						'Any owner can make another person an owner, or step someone (including themselves) back down to member, as long as one owner remains. Promote first, then demote yourself to hand a workspace over.',
						'**Disable** someone to take away their access without erasing their history; **restore** brings them back. You can’t disable yourself, the last owner, or the only person left who can approve someone else’s spending.',
						'**Deleting the workspace** removes everything in it and cannot be undone. You have to type the workspace name to confirm.'
					]
				},
				{
					id: 'allowances',
					icon: 'piggy',
					title: 'Allowances',
					body: [
						'An allowance gives someone a set amount to spend on their own, topped up on a schedule. Open **Settings → Members**, tap **Allowance** beside their name, and choose the amount and how often.',
						'They get a bucket only they can charge to. Purchases that fit inside it go through without asking. A purchase bigger than the balance comes to an owner as a normal approval request, so the amount is a real limit.',
						'Everything else they buy needs approval as usual, and they cannot charge to anyone else\u2019s bucket.',
						'Run the same action again to change the amount or the schedule. The balance stays where it is.',
						'The pieces are ordinary settings, so you can build the same thing by hand: a bucket set to **Only me** on the Buckets page, plus **Buckets they can charge** set to **Only their own** under **Policy**.'
					]
				}
			]
		}
	];

	/** Minimal **bold** and *italic* so the copy above stays readable as prose. */
	function render(text: string): string {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/\*\*(.+?)\*\*/g, '<strong style="color: var(--ink)">$1</strong>')
			.replace(/\*(.+?)\*/g, '<em>$1</em>');
	}
</script>

<svelte:head><title>Help · Ledger</title></svelte:head>

<div class="mx-auto max-w-lg space-y-4">
	<a
		href="/w/{slug}"
		class="press -ml-1 inline-flex items-center gap-0.5 text-[14px] font-medium"
		style="color: var(--ink-3)"
	>
		<ChevronLeft class="h-4 w-4" /> Settings
	</a>

	<div class="px-1">
		<h1 class="text-[28px]">How Ledger works</h1>
		<p class="mt-1.5 text-[15px] leading-relaxed" style="color: var(--ink-3)">
			New here? Everything you need to get going.
		</p>
	</div>

	{#each groups as group}
		<p class="section-label px-1 pt-2">{group.label}</p>
		<div class="space-y-2">
			{#each group.sections as s (s.id)}
				{@const SIcon = HELP_ICONS[s.icon] ?? HELP_ICONS.card}
				<details id={s.id} class="card overflow-hidden">
					<summary
						class="press flex cursor-pointer list-none items-center gap-3.5 p-4 [&::-webkit-details-marker]:hidden"
					>
						<span
							class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
							style="background: color-mix(in oklab, var(--ws-accent) 18%, transparent)"
						>
							<SIcon class="h-[18px] w-[18px]" style="color: var(--ws-accent)" />
						</span>
						<span class="flex-1 text-[16px] font-medium" style="color: var(--ink)">{s.title}</span>
						<ChevronDown class="chevron h-4 w-4" style="color: var(--ink-3)" />
					</summary>
					<div class="space-y-2.5 px-4 pb-4" style="padding-left: 4.25rem">
						{#each s.body as para (para)}
							<p class="text-[14px] leading-relaxed" style="color: var(--ink-2)">
								<!-- eslint-disable-next-line svelte/no-at-html-tags -->
								{@html render(para)}
							</p>
						{/each}
					</div>
				</details>
			{/each}
		</div>
	{/each}

	<p class="px-1 pt-2 text-[13px] leading-relaxed" style="color: var(--ink-3)">
		Every number on Activity is filtered to what you're allowed to see, so two people can look at
		the same screen and correctly see different totals.
	</p>
</div>

<style>
	details :global(.chevron) {
		transition: transform var(--dur-fast) var(--ease-out);
	}
	details[open] :global(.chevron) {
		transform: rotate(180deg);
	}
</style>
