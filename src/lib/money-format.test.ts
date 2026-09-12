import { describe, it, expect } from 'vitest';
import {
	formatMinor,
	minorToDecimalInput,
	splitCurrencyMinor,
	tooWideForSymbol
} from './money-format';

describe('minorToDecimalInput', () => {
	it('produces the dot-decimal form an input expects, not the locale form', () => {
		expect(minorToDecimalInput(123456n, 'USD')).toBe('1234.56');
		expect(minorToDecimalInput(0n, 'USD')).toBe('0.00');
	});

	it('scales to zero-decimal currencies', () => {
		expect(minorToDecimalInput(1234n, 'JPY')).toBe('1234');
	});

	it('round-trips through Money.fromDecimal', () => {
		expect(() => minorToDecimalInput(-1250n, 'USD')).not.toThrow();
	});
});

describe('splitCurrencyMinor', () => {
	it('lifts the symbol out without touching grouping or decimals', () => {
		expect(splitCurrencyMinor(1873492256n, 'USD', 'en-US')).toEqual({
			symbol: '$',
			digits: '18,734,922.56'
		});
	});

	it('keeps the sign with the digits', () => {
		expect(splitCurrencyMinor(-1329604473n, 'USD', 'en-US').digits).toBe('-13,296,044.73');
	});

	it('handles a currency whose symbol trails the digits', () => {
		const { symbol, digits } = splitCurrencyMinor(1873492256n, 'EUR', 'de-DE');
		expect(symbol).toBe('€');
		expect(digits).toBe('18.734.922,56');
	});

	it('handles a zero-decimal currency', () => {
		expect(splitCurrencyMinor(18734922n, 'JPY', 'en-US')).toEqual({
			symbol: '¥',
			digits: '18,734,922'
		});
	});
});

describe('tooWideForSymbol', () => {
	it('trips at ten million going up, not before', () => {
		expect(tooWideForSymbol(999999999n, 'USD')).toBe(false);
		expect(tooWideForSymbol(1000000000n, 'USD')).toBe(true);
	});

	it('trips at ten million going down too', () => {
		expect(tooWideForSymbol(-999999999n, 'USD')).toBe(false);
		expect(tooWideForSymbol(-1000000000n, 'USD')).toBe(true);
	});

	it('lets a seven-figure negative through, though it is as wide as one that trips', () => {
		// Documenting the known gap rather than papering over it: the minus is a
		// glyph, so this is exactly as wide as the eight-figure positive below.
		expect(formatMinor(-999999999n, 'USD', 'en-US')).toHaveLength(14);
		expect(formatMinor(1873492256n, 'USD', 'en-US')).toHaveLength(14);
		expect(tooWideForSymbol(-999999999n, 'USD')).toBe(false);
		expect(tooWideForSymbol(1873492256n, 'USD')).toBe(true);
	});

	it('scales the threshold to the currency’s minor units', () => {
		expect(tooWideForSymbol(9999999n, 'JPY')).toBe(false);
		expect(tooWideForSymbol(10000000n, 'JPY')).toBe(true);
	});
});
