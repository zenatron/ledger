import { describe, expect, it } from 'vitest';
import { ledgerOptsFromUrl } from './ledger-query';

const opts = (qs: string) => ledgerOptsFromUrl(new URLSearchParams(qs), 'UTC');

describe('ledgerOptsFromUrl: movements', () => {
	it('leaves the choice to the saved preference when the URL says nothing', () => {
		expect(opts('').includeMovements).toBeUndefined();
	});

	it('reads an explicit on and off', () => {
		expect(opts('movements=1').includeMovements).toBe(true);
		expect(opts('movements=0').includeMovements).toBe(false);
	});

	it('forces movements off under a map window, whatever else is asked', () => {
		const bbox = 'bbox=51400,-200,51600,100';
		expect(opts(bbox).includeMovements).toBe(false);
		expect(opts(`${bbox}&movements=1`).includeMovements).toBe(false);
	});
});
