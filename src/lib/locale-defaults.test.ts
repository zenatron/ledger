import { describe, expect, it } from 'vitest';
import { defaultCurrency, isUsableTimeZone, timeZoneOptions } from './locale-defaults';

describe('timeZoneOptions', () => {
	const list = ['Africa/Abidjan', 'Asia/Kolkata', 'Europe/London'];

	it("puts the browser's zone in the list when the list spells it differently", () => {
		expect(timeZoneOptions(list, 'Asia/Calcutta')[0]).toBe('Asia/Calcutta');
		expect(timeZoneOptions(list, 'UTC')[0]).toBe('UTC');
	});

	it('leaves the list alone when the zone is already there, or not a zone', () => {
		expect(timeZoneOptions(list, 'Europe/London')).toBe(list);
		expect(timeZoneOptions(list, 'Not/AZone')).toBe(list);
	});

	it('accepts any zone the runtime can use', () => {
		expect(isUsableTimeZone('UTC')).toBe(true);
		expect(isUsableTimeZone('Not/AZone')).toBe(false);
	});
});

describe('defaultCurrency', () => {
	const offered = ['USD', 'EUR', 'GBP', 'JPY', 'INR'];

	it("reads the region off the browser's languages", () => {
		expect(defaultCurrency(['en-GB'], offered)).toBe('GBP');
		expect(defaultCurrency(['de-DE', 'en'], offered)).toBe('EUR');
		// A bare language is maximized to its likeliest region.
		expect(defaultCurrency(['ja'], offered)).toBe('JPY');
	});

	it('falls back to USD for a region it does not know or a currency not offered', () => {
		expect(defaultCurrency(['xx-ZZ'], offered)).toBe('USD');
		expect(defaultCurrency(['en-AU'], offered)).toBe('USD');
	});
});
