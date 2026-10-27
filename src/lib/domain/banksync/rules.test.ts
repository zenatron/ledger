import { describe, expect, it } from 'vitest';
import { cleanDescriptor, firstRule, merchantKey, ruleFits, type Rule } from './rules';

const rule = (r: Partial<Rule>): Rule => ({
	id: 'r',
	priority: 100,
	match: 'contains',
	pattern: 'costco',
	direction: 'out',
	minAmountMinor: null,
	maxAmountMinor: null,
	feedAccountId: null,
	action: 'categorize',
	categoryId: 'cat',
	renameTo: null,
	...r
});
const line = (description: string, amountMinor = -1000n, feedAccountId = 'F1') => ({
	description,
	amountMinor,
	feedAccountId
});

describe('cleanDescriptor', () => {
	it.each([
		['SQ *BLUE BOTTLE COFFEE', 'BLUE BOTTLE COFFEE'],
		['TST* JOES PIZZA #123', 'JOES PIZZA'],
		['PAYPAL *SPOTIFY 4029357733', 'SPOTIFY'],
		['TRADER JOE S #552 SAN FRANCISCO CA', 'TRADER JOE S SAN FRANCISCO'],
		['POS PURCHASE 10/24 WHOLEFDS MKT', 'WHOLEFDS MKT'],
		['AMAZON.COM*2K4', 'AMAZON.COM 2K4']
	])('%s → %s', (raw, want) => expect(cleanDescriptor(raw)).toBe(want));

	it('never returns empty', () => {
		expect(cleanDescriptor('#1234')).toBe('#1234');
	});

	it('merchantKey folds case', () => {
		expect(merchantKey('SQ *Blue  Bottle')).toBe('blue bottle');
	});
});

describe('ruleFits', () => {
	it('matches contains / starts_with / equals on the folded descriptor', () => {
		expect(ruleFits(rule({}), line('COSTCO WHSE #0144'))).toBe(true);
		expect(
			ruleFits(rule({ match: 'starts_with', pattern: 'blue bottle' }), line('SQ *BLUE BOTTLE CO'))
		).toBe(true);
		expect(ruleFits(rule({ match: 'equals', pattern: 'netflix.com' }), line('NETFLIX.COM'))).toBe(
			true
		);
		expect(ruleFits(rule({ match: 'equals', pattern: 'netflix' }), line('NETFLIX.COM'))).toBe(
			false
		);
	});

	it('honours direction, amount bounds and account', () => {
		expect(ruleFits(rule({}), line('COSTCO REFUND', 500n))).toBe(false);
		expect(ruleFits(rule({ direction: 'in' }), line('COSTCO REFUND', 500n))).toBe(true);
		expect(ruleFits(rule({ direction: 'any' }), line('COSTCO', 500n))).toBe(true);
		expect(ruleFits(rule({ minAmountMinor: 5000n }), line('COSTCO', -1000n))).toBe(false);
		expect(ruleFits(rule({ maxAmountMinor: 500n }), line('COSTCO', -1000n))).toBe(false);
		expect(ruleFits(rule({ minAmountMinor: 1000n, maxAmountMinor: 1000n }), line('COSTCO'))).toBe(
			true
		);
		expect(ruleFits(rule({ feedAccountId: 'F2' }), line('COSTCO'))).toBe(false);
	});

	it('an empty pattern matches nothing', () => {
		expect(ruleFits(rule({ pattern: '' }), line('anything'))).toBe(false);
	});
});

describe('firstRule', () => {
	it('picks the lowest priority number that fits', () => {
		const rules = [
			rule({ id: 'broad', priority: 200, pattern: 'amazon' }),
			rule({ id: 'narrow', priority: 10, pattern: 'amazon prime', action: 'ignore' }),
			rule({ id: 'other', priority: 1, pattern: 'costco' })
		];
		expect(firstRule(rules, line('AMAZON PRIME*2K4'))?.id).toBe('narrow');
		expect(firstRule(rules, line('AMAZON MKTP'))?.id).toBe('broad');
		expect(firstRule(rules, line('SAFEWAY'))).toBeNull();
	});
});
