import { describe, expect, it } from 'vitest';
import { normalizeMoneyInput } from './money';

describe('normalizeMoneyInput', () => {
	it('keeps plain digits and one decimal', () => {
		expect(normalizeMoneyInput('12.5', false)).toBe('12.5');
		expect(normalizeMoneyInput('1234', false)).toBe('1234');
	});

	it('caps fraction digits and drops extra dots while typing', () => {
		expect(normalizeMoneyInput('12.345', false)).toBe('12.34');
		expect(normalizeMoneyInput('1.2.3', false)).toBe('1.23');
	});

	it('strips typed commas like any other character', () => {
		expect(normalizeMoneyInput('1,234', false)).toBe('1234');
	});

	it('reads a pasted comma-decimal amount as decimal', () => {
		expect(normalizeMoneyInput('12,50', true)).toBe('12.50');
		expect(normalizeMoneyInput('12,5', true)).toBe('12.5');
	});

	it('reads pasted grouping commas as thousands', () => {
		expect(normalizeMoneyInput('1,234', true)).toBe('1234');
		expect(normalizeMoneyInput('1,234,567', true)).toBe('1234567');
	});

	it('lets the last marker win when a paste has both', () => {
		expect(normalizeMoneyInput('1,234.56', true)).toBe('1234.56');
		expect(normalizeMoneyInput('1.234,56', true)).toBe('1234.56');
	});

	it('still caps a pasted value at two fraction digits', () => {
		expect(normalizeMoneyInput('12,345', true)).toBe('12345');
		expect(normalizeMoneyInput('9.999', true)).toBe('9.99');
	});
});
