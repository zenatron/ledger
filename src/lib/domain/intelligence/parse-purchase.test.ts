import { describe, expect, it } from 'vitest';
import { parsePurchaseText } from './parse-purchase';

describe('parsePurchaseText', () => {
	it('parses a full sentence into fields', () => {
		const r = parsePurchaseText('23 bucks on lunch at chipotle yesterday');
		expect(r.amount).toBe('23');
		expect(r.dateOffsetDays).toBe(-1);
		expect(r.merchantName).toBe('Chipotle');
		expect(r.itemName).toBe('lunch');
		expect(r.intent).toBe('log');
	});

	it('reads a currency symbol and a decimal', () => {
		const r = parsePurchaseText('$4.50 coffee');
		expect(r.amount).toBe('4.50');
		expect(r.itemName).toBe('coffee');
	});

	it('strips leading verbs and prepositions from the item', () => {
		const r = parsePurchaseText('spent 60 on groceries at whole foods');
		expect(r.amount).toBe('60');
		expect(r.merchantName).toBe('Whole Foods');
		expect(r.itemName).toBe('groceries');
	});

	it('detects a request (ask-first) phrasing', () => {
		const r = parsePurchaseText('can I buy a $200 jacket');
		expect(r.intent).toBe('request');
		expect(r.amount).toBe('200');
		expect(r.itemName).toBe('jacket');
	});

	it('does not mistake a date number for the amount', () => {
		const r = parsePurchaseText('lunch 3 days ago for $12');
		expect(r.amount).toBe('12');
		expect(r.dateOffsetDays).toBe(-3);
		expect(r.itemName).toBe('lunch');
	});

	it('handles "dollars" as a money word', () => {
		const r = parsePurchaseText('bought a book for 15 dollars');
		expect(r.amount).toBe('15');
		expect(r.itemName).toBe('book');
	});

	it('strips thousands separators', () => {
		const r = parsePurchaseText('$1,299 for a laptop');
		expect(r.amount).toBe('1299');
		expect(r.itemName).toBe('laptop');
	});

	it('defaults date to today with no date phrase', () => {
		const r = parsePurchaseText('$8 sandwich');
		expect(r.dateOffsetDays).toBe(0);
		expect(r.dateLabel).toBeNull();
	});

	it('returns a null amount when there is no number', () => {
		const r = parsePurchaseText('coffee at blue bottle');
		expect(r.amount).toBeNull();
		expect(r.merchantName).toBe('Blue Bottle');
		expect(r.itemName).toBe('coffee');
	});

	it('reads "weeks ago"', () => {
		const r = parsePurchaseText('$40 haircut 2 weeks ago');
		expect(r.dateOffsetDays).toBe(-14);
		expect(r.amount).toBe('40');
		expect(r.itemName).toBe('haircut');
	});

	describe('merchant without a preposition', () => {
		it('reads a capitalised name before an errand word', () => {
			const r = parsePurchaseText('Costco run, 84 bucks');
			expect(r.merchantName).toBe('Costco');
			expect(r.amount).toBe('84');
		});

		it('reads a capitalised name set off by commas', () => {
			const r = parsePurchaseText('lunch, Chipotle, 12');
			expect(r.merchantName).toBe('Chipotle');
			expect(r.amount).toBe('12');
			expect(r.itemName).toBe('lunch');
		});

		// The point of leaning on the person's own capitals: a lower-case
		// describing word must never be promoted to a merchant.
		it('does not invent a merchant from a lower-case aside', () => {
			const r = parsePurchaseText('coffee, black, 4');
			expect(r.merchantName).toBeNull();
		});

		it('does not treat a capitalised filler word as a name', () => {
			const r = parsePurchaseText('The run, 20');
			expect(r.merchantName).toBeNull();
		});
	});

	describe('capitalisation', () => {
		it("leaves a brand's own styling alone", () => {
			expect(parsePurchaseText('bought an iPhone at Apple').merchantName).toBe('Apple');
			expect(parsePurchaseText('$5 from iHop').merchantName).toBe('iHop');
		});

		it('does not capitalise the letter after an apostrophe', () => {
			expect(parsePurchaseText("$8 at mcdonald's").merchantName).toBe("Mcdonald's");
		});
	});

	describe('absolute dates', () => {
		const today = { y: 2026, m: 8, d: 2 };

		it('reads a day of the month that has already passed', () => {
			const r = parsePurchaseText('$23 groceries on the 1st', today);
			expect(r.dateOffsetDays).toBe(-1);
			expect(r.amount).toBe('23');
		});

		// "the 20th" with today the 2nd can only mean last month — a purchase is
		// something that already happened.
		it('walks back a month when the day is still ahead', () => {
			const r = parsePurchaseText('$23 groceries on the 20th', today);
			expect(r.dateOffsetDays).toBe(-13);
		});

		it('reads "Jan 12" without billing the 12 as money', () => {
			const r = parsePurchaseText('flight Jan 12', today);
			expect(r.dateOffsetDays).toBe(-202);
			expect(r.amount).toBeNull();
			expect(r.itemName).toBe('flight');
		});

		it('reads "12 July" and keeps the amount separate', () => {
			const r = parsePurchaseText('$60 dinner on 12 July', today);
			expect(r.dateOffsetDays).toBe(-21);
			expect(r.amount).toBe('60');
		});

		it('reads an ISO date', () => {
			const r = parsePurchaseText('2026-07-30 coffee $4', today);
			expect(r.dateOffsetDays).toBe(-3);
			expect(r.amount).toBe('4');
		});

		it('pins an ISO date with an explicit year instead of the recent one', () => {
			// Most recent Jul 30 is -3 days, but the year was said: 2024 it is.
			const r = parsePurchaseText('2024-07-30 coffee $4', today);
			expect(r.dateOffsetDays).toBe(-733);
			expect(r.amount).toBe('4');
			expect(r.dateLabel).toBe('2024-07-30');
		});

		it('consumes a trailing year on a month-day date', () => {
			// The year must leave with the date: if it stayed, "2024" is a bare
			// integer and the amount extractor bills it.
			const r = parsePurchaseText('flight jan 12 2024', today);
			expect(r.dateOffsetDays).toBe(-933);
			expect(r.amount).toBeNull();
			expect(r.itemName).toBe('flight');
		});

		it('does not read a stray large number as a year', () => {
			const r = parsePurchaseText('lunch jan 12 4500', today);
			// 4500 is out of the plausible year range, so the date falls back to
			// the most recent Jan 12 and the 4500 is left for the amount.
			expect(r.dateOffsetDays).toBe(-202);
			expect(r.amount).toBe('4500');
		});

		it('resolves nothing for a plausible but future explicit date', () => {
			expect(parsePurchaseText('2027-01-01 coffee', today).dateOffsetDays).toBe(0);
		});

		// One component over 12 settles the order; a bare 12/03 never can, so it
		// is left unread rather than guessed at.
		it('reads a slash date only when it is unambiguous', () => {
			expect(parsePurchaseText('$10 lunch 25/12', today).dateOffsetDays).toBe(-220);
			expect(parsePurchaseText('$10 lunch 12/03', today).dateOffsetDays).toBe(0);
		});

		it('ignores an impossible day rather than clamping it', () => {
			const r = parsePurchaseText('$9 snack on Feb 31', today);
			expect(r.dateOffsetDays).toBe(0);
		});

		it('ignores absolute dates when given no reference day', () => {
			expect(parsePurchaseText('$23 groceries on the 1st').dateOffsetDays).toBe(0);
		});
	});
});
