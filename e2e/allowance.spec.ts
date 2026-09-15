import { expect, test } from '@playwright/test';
import {
	createInvite,
	createWorkspace,
	joinWorkspace,
	loginAs,
	newPurchase,
	waitForHydration
} from './helpers';

/**
 * The allowance, as a household actually uses it.
 *
 * The pieces are unit- and integration-tested already. What only a browser can
 * answer is whether the guided setup on the Buckets page really composes them:
 * that the pot appears, that the picker offers it to its owner and hides it from
 * everyone else, and that the two sides of the cap land in different places.
 */
test('allowance: set one up, spend under the cap, then ask to go over', async ({ browser }) => {
	const alice = await loginAs(browser, 'alice');
	const slug = await createWorkspace(alice, `PW Allowance ${Date.now()}`);
	const code = await createInvite(alice, slug);

	const bob = await loginAs(browser, 'bob');
	await joinWorkspace(bob, code, slug);

	// Alice sets Bob up with 40.00 a week, under Allowances on the Buckets page.
	await alice.goto(`/w/${slug}/buckets`);
	await waitForHydration(alice);
	const amount = alice.getByLabel('Allowance amount');
	await expect(async () => {
		if (!(await amount.isVisible())) {
			await alice.getByRole('button', { name: '+ Allowance' }).click();
		}
		await expect(amount).toBeVisible({ timeout: 1000 });
	}).toPass({ timeout: 15_000 });
	await alice.locator('select[name="memberId"]').selectOption({ label: 'Bob Test' });
	await amount.fill('40.00');
	// The schedule is the app's ordinary recurrence picker, so a weekly allowance
	// is chosen the same way a weekly bucket accrual is.
	await alice.getByRole('radio', { name: 'Weekly', exact: true }).click();
	await alice.getByRole('button', { name: 'Set up allowance' }).click();
	// Generous timeout because this is the first POST to a route the dev server
	// compiles on hit. The form closes itself on success.
	await expect(amount).toBeHidden({ timeout: 30_000 });
	await expect(alice.getByText("Bob Test's allowance")).toBeVisible();

	// The Members page reads it back, for reference.
	await alice.goto(`/w/${slug}/settings/members`);
	const allowanceLine = alice.locator('[data-member="Bob Test"] p').filter({ hasText: 'week' });
	await expect(allowanceLine).toContainText('$40.00', { timeout: 30_000 });
	// Alice can see it and cannot spend from it: it never reaches her picker.
	await alice.goto(`/w/${slug}/purchases/new`);
	await expect(
		alice.locator('select[name="bucketId"] option', { hasText: 'allowance' })
	).toHaveCount(0);

	// Bob tops his own pot up, which he is allowed to do: it is his bucket. It is
	// the workspace's only bucket, so the row's controls are unambiguous.
	await bob.goto(`/w/${slug}/buckets`);
	await waitForHydration(bob);
	const adjustAmount = bob.getByPlaceholder('50.00');
	await expect(async () => {
		if (!(await adjustAmount.isVisible())) {
			await bob.getByRole('button', { name: 'Adjust' }).click();
		}
		await expect(adjustAmount).toBeVisible({ timeout: 1000 });
	}).toPass({ timeout: 15_000 });
	await adjustAmount.fill('40.00');
	await bob.locator('select[name="type"]').selectOption('adjustment');
	await bob.getByRole('button', { name: 'Save', exact: true }).click();
	// The form closes itself on success. Waiting for that is what keeps the
	// navigation below from aborting the post that is still in flight.
	await expect(adjustAmount).toBeHidden({ timeout: 30_000 });
	// Asserted on the picker rather than on the page: the row also prints $40.00
	// as the weekly accrual, so a balance that never landed would still pass.
	await bob.goto(`/w/${slug}/purchases/new`);
	await expect(
		bob.locator('select[name="bucketId"] option', { hasText: 'allowance' })
	).toContainText('$40.00 left', { timeout: 30_000 });

	// Under the cap: charged to the pot, no approval, done.
	await newPurchase(bob, slug, {
		item: 'Comic book',
		amount: '15.00',
		intent: 'log',
		bucket: "Bob Test's allowance"
	});
	await expect(bob.locator('.chip', { hasText: 'Completed' })).toBeVisible();

	// Over what is left: same bucket, but it goes to Alice instead.
	// Past what is left, so the form warns first. For a member on an allowance
	// the warning says where it goes, and the affirmative says so too.
	const overUrl = await newPurchase(bob, slug, {
		item: 'Headphones',
		amount: '60.00',
		intent: 'log',
		bucket: "Bob Test's allowance",
		confirm: 'Send for approval'
	});
	await expect(bob.locator('.chip', { hasText: 'Waiting' })).toBeVisible();

	await alice.goto(overUrl);
	await expect(alice.getByRole('button', { name: 'Approve' })).toBeVisible();
});
