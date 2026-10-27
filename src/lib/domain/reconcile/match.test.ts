import { describe, expect, it } from 'vitest';
import { matchLines, type MatchCandidate } from './match';
import type { RawStatementLine } from './parse-csv';

const day = (d: number) => new Date(Date.UTC(2026, 5, d, 12, 0, 0, 0));

function line(amountMinor: number, d: number, description = 'CARD PURCHASE'): RawStatementLine {
	return {
		postedAt: day(d),
		amountMinor: BigInt(amountMinor),
		currency: 'USD',
		rawDescription: description,
		normalizedDescription: description.trim().replace(/\s+/g, ' ').toLowerCase()
	};
}

function candidate(
	id: string,
	amountMinor: number,
	d: number,
	itemName = 'Something',
	merchantName: string | null = null
): MatchCandidate {
	return { id, amountMinor: BigInt(amountMinor), completedAt: day(d), itemName, merchantName };
}

describe('matchLines — amount and date', () => {
	it('matches a lone candidate on the same day', () => {
		const [p] = matchLines([line(-1250, 10)], [candidate('a', 1250, 10)]);
		expect(p.state).toBe('matched');
		expect(p.purchaseId).toBe('a');
		expect(p.reason).toBe('amount and date');
	});

	it('compares amounts on magnitude, so sign convention does not matter', () => {
		// Debit-negative export vs debit-positive export, same purchase.
		expect(matchLines([line(-1250, 10)], [candidate('a', 1250, 10)])[0].purchaseId).toBe('a');
		expect(matchLines([line(1250, 10)], [candidate('a', 1250, 10)])[0].purchaseId).toBe('a');
	});

	it('matches within the date tolerance — cards post days after the swipe', () => {
		const [p] = matchLines([line(-1250, 13)], [candidate('a', 1250, 10)]);
		expect(p.state).toBe('matched');
	});

	it('does not match beyond the tolerance', () => {
		const [p] = matchLines([line(-1250, 20)], [candidate('a', 1250, 10)]);
		expect(p.state).toBe('unmatched');
		expect(p.suggestions).toEqual([]);
	});

	it('honours a custom tolerance', () => {
		const [p] = matchLines([line(-1250, 17)], [candidate('a', 1250, 10)], { toleranceDays: 7 });
		expect(p.state).toBe('matched');
	});

	it('does not match a different amount', () => {
		const [p] = matchLines([line(-1251, 10)], [candidate('a', 1250, 10)]);
		expect(p.state).toBe('unmatched');
	});

	it('leaves a line with no candidates unmatched and unsuggested', () => {
		const [p] = matchLines([line(-999, 10)], []);
		expect(p.state).toBe('unmatched');
		expect(p.purchaseId).toBeNull();
		expect(p.suggestions).toEqual([]);
	});
});

describe('matchLines — description evidence', () => {
	it('reports description corroboration in the reason', () => {
		const [p] = matchLines(
			[line(-1250, 10, 'SQ *BLUE BOTTLE 8837')],
			[candidate('a', 1250, 10, 'Coffee', 'Blue Bottle')]
		);
		expect(p.state).toBe('matched');
		expect(p.reason).toBe('amount, date and description');
	});

	it('breaks an otherwise-tied pair using the description', () => {
		const [p] = matchLines(
			[line(-1250, 10, 'AMAZON MKTP GB*2H41K')],
			[candidate('a', 1250, 10, 'Batteries', 'Amazon'), candidate('b', 1250, 10, 'Lunch', 'Pret')]
		);
		expect(p.state).toBe('matched');
		expect(p.purchaseId).toBe('a');
	});

	it('does not treat an abbreviated descriptor as evidence', () => {
		// "AMZN" is not a substring of "amazon". Containment is deliberately literal:
		// fuzzy matching here would invent confidence about someone's money, so an
		// abbreviation the parser can't verify falls through to a human instead.
		const [p] = matchLines(
			[line(-1250, 10, 'AMZN Mktp GB*2H41K')],
			[candidate('a', 1250, 10, 'Batteries', 'Amazon'), candidate('b', 1250, 10, 'Lunch', 'Pret')]
		);
		expect(p.state).toBe('unmatched');
		expect(p.suggestions.map((s) => s.purchaseId).sort()).toEqual(['a', 'b']);
	});

	it('ignores tokens shorter than four characters', () => {
		// "Pret" is 4 and would count; "Co" must not make every descriptor a hit.
		const [p] = matchLines(
			[line(-1250, 10, 'PAYMENT CO 1234')],
			[candidate('a', 1250, 10, 'Tea', 'Co'), candidate('b', 1250, 10, 'Tea', 'Co')]
		);
		expect(p.state).toBe('unmatched');
	});
});

describe('matchLines — ambiguity is reported, not resolved', () => {
	it('refuses to guess between two identical candidates', () => {
		const [p] = matchLines(
			[line(-420, 10)],
			[candidate('a', 420, 10, 'Coffee'), candidate('b', 420, 10, 'Coffee')]
		);
		expect(p.state).toBe('unmatched');
		expect(p.purchaseId).toBeNull();
		expect(p.suggestions.map((s) => s.purchaseId).sort()).toEqual(['a', 'b']);
	});

	it('caps suggestions at five', () => {
		const many = Array.from({ length: 9 }, (_, i) => candidate(`c${i}`, 420, 10, 'Coffee'));
		const [p] = matchLines([line(-420, 10)], many);
		expect(p.suggestions).toHaveLength(5);
	});

	it('ranks suggestions by date proximity', () => {
		const [p] = matchLines(
			[line(-420, 10)],
			[candidate('far', 420, 13, 'Coffee'), candidate('near', 420, 10, 'Coffee')]
		);
		expect(p.suggestions[0].purchaseId).toBe('near');
	});
});

describe('matchLines — assignment', () => {
	it('never claims one purchase for two lines', () => {
		const ps = matchLines([line(-1250, 10), line(-1250, 10)], [candidate('a', 1250, 10)]);
		const matched = ps.filter((p) => p.state === 'matched');
		expect(matched).toHaveLength(1);
		expect(ps.filter((p) => p.state === 'unmatched')).toHaveLength(1);
	});

	it('does not suggest a purchase another line already claimed', () => {
		const ps = matchLines([line(-1250, 10), line(-1250, 10)], [candidate('a', 1250, 10)]);
		const loser = ps.find((p) => p.state === 'unmatched')!;
		expect(loser.suggestions).toEqual([]);
	});

	it('gives a contested purchase to the better-evidenced line, whatever the row order', () => {
		const weak = line(-1250, 10, 'CARD PURCHASE');
		const strong = line(-1250, 10, 'SQ *BLUE BOTTLE');
		const cands = [candidate('a', 1250, 10, 'Coffee', 'Blue Bottle')];

		const forwards = matchLines([weak, strong], cands);
		expect(forwards[1].purchaseId).toBe('a');
		expect(forwards[0].state).toBe('unmatched');

		// Same evidence, rows swapped: the same line must still win.
		const backwards = matchLines([strong, weak], cands);
		expect(backwards[0].purchaseId).toBe('a');
		expect(backwards[1].state).toBe('unmatched');
	});

	it('matches each line to its own purchase when both are unambiguous', () => {
		const ps = matchLines(
			[line(-1250, 10, 'BLUE BOTTLE'), line(-800, 11, 'PRET A MANGER')],
			[candidate('a', 1250, 10, 'Coffee', 'Blue Bottle'), candidate('b', 800, 11, 'Lunch', 'Pret')]
		);
		expect(ps.map((p) => p.purchaseId)).toEqual(['a', 'b']);
	});

	it('is deterministic — repeated runs agree', () => {
		const ls = [line(-420, 10, 'COFFEE'), line(-420, 11, 'COFFEE')];
		const cs = [candidate('a', 420, 10, 'Coffee'), candidate('b', 420, 11, 'Coffee')];
		const first = matchLines(ls, cs).map((p) => p.purchaseId);
		for (let i = 0; i < 5; i++) {
			expect(matchLines(ls, cs).map((p) => p.purchaseId)).toEqual(first);
		}
	});

	it('carries lineIndex so results can be zipped back to the input', () => {
		const ps = matchLines([line(-1, 10), line(-2, 10), line(-3, 10)], []);
		expect(ps.map((p) => p.lineIndex)).toEqual([0, 1, 2]);
	});

	it('never returns a confirmed state — matching only ever proposes', () => {
		const ps = matchLines(
			[line(-1250, 10, 'BLUE BOTTLE')],
			[candidate('a', 1250, 10, 'Coffee', 'Blue Bottle')]
		);
		expect(ps.every((p) => p.state === 'matched' || p.state === 'unmatched')).toBe(true);
	});

	it('excludes candidates the caller filtered out (seal is upstream)', () => {
		// A sealed purchase never reaches this function; with it absent the line
		// simply has nothing to match, and no trace of it appears in the result.
		const ps = matchLines([line(-1250, 10, 'BLUE BOTTLE')], []);
		expect(ps[0].state).toBe('unmatched');
		expect(JSON.stringify(ps)).not.toContain('1250');
	});
});

describe('matchLines — one statement per card', () => {
	const onCard = (id: string, amountMinor: number, d: number, accountId: string | null) => ({
		...candidate(id, amountMinor, d),
		accountId
	});

	// The default, and what every import made before cards existed did.
	it('considers every purchase when the statement names no card', () => {
		const p = matchLines([line(-1250, 10)], [onCard('a', 1250, 10, 'visa')]);
		expect(p[0].purchaseId).toBe('a');
	});

	// The whole point: once a purchase has been reconciled onto one card, another
	// card's statement must not be able to claim it too.
	it('excludes a purchase already known to be on a different card', () => {
		const p = matchLines([line(-1250, 10)], [onCard('a', 1250, 10, 'visa')], {
			accountId: 'amex'
		});
		expect(p[0].state).toBe('unmatched');
		expect(p[0].suggestions).toEqual([]);
	});

	it('matches a purchase already known to be on this card', () => {
		const p = matchLines([line(-1250, 10)], [onCard('a', 1250, 10, 'visa')], {
			accountId: 'visa'
		});
		expect(p[0].purchaseId).toBe('a');
	});

	// Almost every purchase starts with no card recorded. Excluding those would
	// reconcile nothing at all, so they stay eligible.
	it('keeps purchases with no card recorded eligible', () => {
		const p = matchLines([line(-1250, 10)], [onCard('a', 1250, 10, null)], {
			accountId: 'amex'
		});
		expect(p[0].purchaseId).toBe('a');
	});

	// Two cards, one amount, one day — previously a coin flip between them.
	it('picks the purchase belonging to this card over an identical rival', () => {
		const p = matchLines(
			[line(-1250, 10)],
			[onCard('visa-one', 1250, 10, 'visa'), onCard('amex-one', 1250, 10, 'amex')],
			{ accountId: 'amex' }
		);
		expect(p[0].state).toBe('matched');
		expect(p[0].purchaseId).toBe('amex-one');
	});

	// Scoping must not turn a genuine ambiguity into a false confidence.
	it('still refuses to choose between two eligible purchases', () => {
		const p = matchLines(
			[line(-1250, 10)],
			[onCard('a', 1250, 10, null), onCard('b', 1250, 10, 'amex')],
			{ accountId: 'amex' }
		);
		expect(p[0].state).toBe('unmatched');
		expect(p[0].suggestions.map((s) => s.purchaseId).sort()).toEqual(['a', 'b']);
	});
});

describe('close amounts and open requests', () => {
	const at = (d: string) => new Date(d);
	const line = (amt: bigint, desc: string, d = '2026-10-12T10:00:00Z') => ({
		postedAt: at(d),
		amountMinor: amt,
		currency: 'USD',
		rawDescription: desc,
		normalizedDescription: desc.toLowerCase()
	});
	const cand = (id: string, amt: bigint, extra: Record<string, unknown> = {}) => ({
		id,
		amountMinor: amt,
		completedAt: at('2026-10-12T09:00:00Z'),
		itemName: 'Thing',
		merchantName: null,
		...extra
	});

	it('a close amount on a settled purchase is offered only when the description names it', () => {
		const [quiet] = matchLines([line(-5300n, 'POS 1234')], [cand('p', 5000n)]);
		expect(quiet.suggestions).toEqual([]);
		const [named] = matchLines(
			[line(-5300n, 'BLUE BOTTLE 1234')],
			[cand('p', 5000n, { merchantName: 'Blue Bottle' })]
		);
		expect(named.state).toBe('unmatched');
		expect(named.suggestions.map((s) => s.purchaseId)).toEqual(['p']);
	});

	it('an open request is offered, never claimed, even on an exact amount', () => {
		const [p] = matchLines(
			[line(-5000n, 'BEST BUY', '2026-10-20T10:00:00Z')],
			[cand('o', 5000n, { open: true, completedAt: at('2026-10-05T10:00:00Z') })]
		);
		expect(p.state).toBe('unmatched');
		expect(p.suggestions[0]).toMatchObject({
			purchaseId: 'o',
			reason: 'asked for, not yet marked bought'
		});
	});

	it('an open request does not block an exact settled match', () => {
		const [p] = matchLines(
			[line(-5000n, 'BEST BUY')],
			[cand('o', 5000n, { open: true }), cand('s', 5000n)]
		);
		expect(p.state).toBe('matched');
		expect(p.purchaseId).toBe('s');
	});
});
