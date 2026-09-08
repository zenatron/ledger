import { expect, test } from '@playwright/test';
import {
	createWorkspace,
	enablePlaces,
	loginAs,
	newPurchase,
	placeField,
	waitForHydration
} from './helpers';

/*
 * One tap on a suggestion must be enough.
 *
 * The place candidates and the "Suggested · Apply" chip both sit under a text
 * input whose blur does work: the place field re-searches, the suggester
 * re-asks. A tap blurs the input at pointerdown — before click — so the blur
 * handler has a window in which it can wipe the very button being tapped, and
 * the first tap lands on nothing. These tests hold that window shut.
 *
 * Two rules keep them honest. Setup may retry (`toPass`, like the helpers — a
 * fill can land before the bindings attach), but the tap under test is always
 * a single bare `click()` followed by direct assertions. And the search
 * counter is reset after setup, so it counts only what the tap itself caused.
 */
test.describe.configure({ timeout: 360_000 });

const FERRY = 'Ferry Building, San Francisco';

/**
 * A stand-in for the geocoder. The E2E deployment has none configured, and the
 * search endpoint answers an unconfigured one with an empty list — so the
 * candidates come from intercepting the endpoint here.
 */
async function serveOneCandidate(page: Parameters<typeof enablePlaces>[0]): Promise<() => number> {
	let searches = 0;
	await page.route('**/places/search', async (route) => {
		searches++;
		await route.fulfill({
			contentType: 'application/json',
			body: JSON.stringify({
				places: [{ latE3: 377749, lngE3: -1224194, label: FERRY }]
			})
		});
	});
	return () => searches;
}

test('places: one tap on a candidate pins it, and does not ask the geocoder again', async ({
	browser
}) => {
	const alice = await loginAs(browser, 'alice');
	const slug = await createWorkspace(alice, `PW Tappin ${Date.now()}`);
	await enablePlaces(alice, slug);
	const searches = await serveOneCandidate(alice);

	await alice.goto(`/w/${slug}/purchases/new`);
	await waitForHydration(alice);
	await expect(async () => {
		await placeField(alice).fill('Ferry Building San Francisco');
		await placeField(alice).press('Enter');
		await expect(alice.getByRole('button', { name: FERRY })).toBeVisible({ timeout: 1000 });
	}).toPass({ timeout: 20_000 });

	const candidate = alice.getByRole('button', { name: FERRY });
	// From here on, the geocoder's answer is on screen. A tap that asks the same
	// question again is the bug: the repeat rides the adapter's one-per-second
	// gate and can come back "nothing found" over a list that was right.
	const before = searches();

	// The tap under test. At pointerdown the place input still holds focus, so
	// this is the exact moment the blur handler used to wipe the list.
	await candidate.click();

	// Pinned on the first tap: the hidden fields the form posts are there.
	await expect(alice.locator('input[name="latE3"]')).toHaveCount(1);
	await expect(alice.locator('input[name="latE3"]')).toHaveValue('377749');
	expect(searches()).toBe(before);
	await expect(alice.getByText(/Nothing found/)).toHaveCount(0);
});

test('places: leaving the field without editing does not re-search what is on screen', async ({
	browser
}) => {
	const alice = await loginAs(browser, 'alice');
	const slug = await createWorkspace(alice, `PW NoReAsk ${Date.now()}`);
	await enablePlaces(alice, slug);
	const searches = await serveOneCandidate(alice);

	await alice.goto(`/w/${slug}/purchases/new`);
	await waitForHydration(alice);
	await expect(async () => {
		await placeField(alice).fill('Ferry Building San Francisco');
		await placeField(alice).press('Enter');
		await expect(alice.getByRole('button', { name: FERRY })).toBeVisible({ timeout: 1000 });
	}).toPass({ timeout: 20_000 });
	const before = searches();

	// Blur by tapping another field — not by editing the text. The answer is
	// already on screen; the same question must not be asked again.
	await alice.getByLabel('Item').click();
	await expect(alice.getByRole('button', { name: FERRY })).toBeVisible();
	expect(searches()).toBe(before);

	// But a real edit is a new question, and asking it again must still work.
	await placeField(alice).fill('Ferry Building');
	await placeField(alice).press('Enter');
	await expect(alice.getByRole('button', { name: FERRY })).toBeVisible();
	expect(searches()).toBe(before + 1);

	// And blurring after that edit must not ask it a third time.
	await placeField(alice).blur();
	await expect(alice.getByRole('button', { name: FERRY })).toBeVisible();
	expect(searches()).toBe(before + 1);
});

test('harmony: one tap on Apply takes the suggestion', async ({ browser }) => {
	const alice = await loginAs(browser, 'alice');
	const slug = await createWorkspace(alice, `PW Apply ${Date.now()}`);

	// The chip only renders when AI is on, and saving that wants an endpoint and
	// a model — dummies are fine. Nothing will contact them: the suggestion
	// below comes from merchant memory, which answers before any model is asked.
	// Each pass drives the whole form from a fresh load: a click can land before
	// hydration and a fill before the freshly-rendered panel binds, and either
	// way the save silently doesn't happen while the switch reads optimistically
	// on. The reload at the end only passes on the state that survived.
	await expect(async () => {
		await alice.goto(`/w/${slug}/settings/intelligence`);
		await waitForHydration(alice);
		const toggle = alice.getByRole('switch', { name: 'Toggle AI assistance' });
		await expect(toggle).toBeVisible({ timeout: 2000 });
		if ((await toggle.getAttribute('aria-checked')) !== 'true') {
			await toggle.click();
		}
		await alice.getByLabel('Endpoint').fill('http://localhost:9');
		await alice.getByLabel('Model').fill('e2e-model');
		await alice.getByRole('button', { name: 'Save' }).click();
		await expect(alice.getByText('Intelligence settings saved')).toBeVisible({ timeout: 5000 });
		await alice.reload();
		await expect(alice.getByRole('switch', { name: 'Toggle AI assistance' })).toHaveAttribute(
			'aria-checked',
			'true',
			{ timeout: 2000 }
		);
	}).toPass({ timeout: 60_000 });

	// Teach the memory: Blue Bottle files under Dining.
	await newPurchase(alice, slug, {
		item: 'Flat white',
		amount: '4.50',
		intent: 'log',
		merchant: 'Blue Bottle',
		category: 'Dining'
	});

	await alice.goto(`/w/${slug}/purchases/new`);
	await waitForHydration(alice);
	await expect(async () => {
		await alice.getByLabel('Item').fill('Flat white');
		await alice.getByLabel('Paid to').fill('Blue Bottle');
		// Leaving the field is what asks; memory answers without a model.
		await alice.getByLabel('Paid to').blur();
		await expect(alice.getByRole('button', { name: /· Apply$/ })).toBeVisible({ timeout: 1000 });
	}).toPass({ timeout: 20_000 });
	// `· Apply` with the anchor: the workspace switcher's name ends in the
	// workspace name, and this one is called "PW Apply …".
	const apply = alice.getByRole('button', { name: /· Apply$/ });

	// The bug's exact setup: a field focused, its text changed since the last
	// ask. Tapping Apply blurs that field; the re-ask must not swap the button
	// for "Finding a category…" fast enough to eat the tap.
	const item = alice.getByLabel('Item');
	await item.click();
	await item.fill('Flat white oat');
	await apply.click();

	// One tap, and the category is chosen.
	const dining = alice.locator('select[name="categoryId"] option', { hasText: 'Dining' });
	await expect(dining).toHaveCount(1);
	await expect(alice.locator('select[name="categoryId"]')).toHaveValue(
		(await dining.getAttribute('value'))!
	);
});
