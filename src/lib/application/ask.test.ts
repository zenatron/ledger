import { describe, it, expect, vi } from 'vitest';
import { answerAsk, askOutcomeToWire, type AskDeps } from './ask';
import { parse } from '$lib/intelligence/parser';
import { fakeAssist } from '$lib/ports/fake-assist';
import type { ParsedAction } from '$lib/ports/llm-assist';

const TODAY = { y: 2026, m: 8, d: 10 };

function deps(over: Partial<AskDeps> = {}): AskDeps {
	return {
		assist: fakeAssist(),
		briefing: async () => 'Workspace: Home. Currency: USD.',
		currency: 'USD',
		today: TODAY,
		...over
	};
}

/** Run the flow the way the route does: parse first, then decide. */
function ask(query: string, d: Partial<AskDeps> = {}) {
	return answerAsk(deps(d), { query, parsed: parse(query) });
}

describe('answerAsk — the deterministic parser wins', () => {
	it('proposes a bucket without consulting the model', async () => {
		const parseCommand = vi.fn(async () => null);
		const out = await ask('create a travel bucket of 500/mo on the 5th', {
			assist: fakeAssist({ parseCommand })
		});

		expect(out).toMatchObject({ kind: 'proposal', intent: 'propose' });
		expect(out && 'propose' in out && out.propose).toMatchObject({
			intent: 'create_bucket',
			name: 'travel'
		});
		expect(parseCommand).not.toHaveBeenCalled();
	});

	it('routes a navigation command without the model', async () => {
		const parseCommand = vi.fn(async () => null);
		const out = await ask('open analytics', { assist: fakeAssist({ parseCommand }) });

		expect(out).toEqual({ kind: 'navigate', target: 'analytics', answer: 'Open analytics' });
		expect(parseCommand).not.toHaveBeenCalled();
	});

	it('behaves identically with the assist switched off', async () => {
		const on = await ask('create a travel bucket of 500/mo on the 5th');
		const off = await ask('create a travel bucket of 500/mo on the 5th', {
			assist: fakeAssist({ available: false })
		});
		expect(off).toEqual(on);
	});
});

describe('answerAsk — data intents belong to the caller', () => {
	it.each(['how much did I spend last month', 'what is my net this month'])(
		'returns null for %s so the route answers from the repositories',
		async (q) => {
			expect(await ask(q)).toBeNull();
		}
	);

	it('does not build the briefing for a data intent', async () => {
		const briefing = vi.fn(async () => 'x');
		expect(await ask('how much did I spend last month', { briefing })).toBeNull();
		expect(briefing).not.toHaveBeenCalled();
	});
});

describe('answerAsk — the model may only prepare', () => {
	it('turns an unparsed command into a proposal the caller must confirm', async () => {
		const action: ParsedAction = {
			intent: 'create_bucket',
			name: 'Holiday',
			amount: 250,
			dayOfMonth: 3
		};
		const out = await ask('set aside a bit for the holiday each month', {
			assist: fakeAssist({ parseCommand: async () => action })
		});

		expect(out).toMatchObject({ kind: 'proposal', intent: 'propose' });
		expect(out && 'propose' in out && out.propose).toMatchObject({
			intent: 'create_bucket',
			name: 'Holiday',
			dayOfMonth: 3
		});
	});

	it('re-validates every field the model touched', async () => {
		const out = await ask('do the thing', {
			assist: fakeAssist({
				parseCommand: async () => ({
					intent: 'create_bucket',
					// Control characters and runaway whitespace get scrubbed, and a
					// day of 99 is clamped rather than trusted.
					name: '  Holiday   fund  ',
					amount: 250,
					dayOfMonth: 99
				})
			})
		});

		expect(out && 'propose' in out && out.propose).toMatchObject({
			name: 'Holiday fund',
			dayOfMonth: 31
		});
	});

	it('refuses a proposal whose amount is not money', async () => {
		const out = await ask('do the thing', {
			assist: fakeAssist({
				parseCommand: async () => ({
					intent: 'create_bucket',
					name: 'Holiday',
					amount: Number.NaN,
					dayOfMonth: 3
				})
			})
		});

		expect(out).toEqual({
			kind: 'proposal',
			intent: 'create_bucket',
			answer: 'I need a positive amount for the bucket.'
		});
	});

	it('falls through to the answer path when parseCommand returns garbage', async () => {
		const answerQuestion = vi.fn(async () => 'You are doing fine.');
		const out = await ask('am I doing ok', {
			assist: fakeAssist({
				parseCommand: async () => ({ intent: 'unknown' }),
				answerQuestion
			})
		});

		expect(out).toEqual({ kind: 'answer', answer: 'You are doing fine.' });
		expect(answerQuestion).toHaveBeenCalled();
	});

	it('falls through when parseCommand returns null (off, timed out, unparseable)', async () => {
		const out = await ask('am I doing ok', {
			assist: fakeAssist({ parseCommand: async () => null })
		});
		expect(out).toMatchObject({ kind: 'refusal' });
	});
});

describe('answerAsk — the out-of-briefing refusal is not the model’s job', () => {
	it('refuses before any model call', async () => {
		const parseCommand = vi.fn(async () => null);
		const answerQuestion = vi.fn(async () => 'I definitely know this.');
		const briefing = vi.fn(async () => 'x');

		const out = await ask('how did I do in March 2024', {
			assist: fakeAssist({ parseCommand, answerQuestion }),
			briefing
		});

		expect(out).toMatchObject({ kind: 'refusal' });
		expect(out?.answer).toContain('I can only answer for this month and last month');
		expect(answerQuestion).not.toHaveBeenCalled();
		expect(briefing).not.toHaveBeenCalled();
	});

	it('gives the same refusal with the assist off', async () => {
		const on = await ask('how did I do in March 2024');
		const off = await ask('how did I do in March 2024', {
			assist: fakeAssist({ available: false })
		});
		expect(off).toEqual(on);
	});
});

describe('answerAsk — narration', () => {
	it('answers over the briefing when the model has something to say', async () => {
		const briefing = vi.fn(async () => 'Spent 100.');
		const answerQuestion = vi.fn(async () => 'A little more than last month.');
		const out = await ask('how am I doing', {
			assist: fakeAssist({ answerQuestion }),
			briefing
		});

		expect(out).toEqual({ kind: 'answer', answer: 'A little more than last month.' });
		expect(answerQuestion).toHaveBeenCalledWith({
			query: 'how am I doing',
			briefing: 'Spent 100.'
		});
	});

	it('falls back to the deterministic reply when the model returns null', async () => {
		const out = await ask('how am I doing', {
			assist: fakeAssist({ answerQuestion: async () => null })
		});
		expect(out).toMatchObject({ kind: 'refusal' });
		expect(out?.answer).toContain("I couldn't understand that");
	});

	it('never builds a briefing, nor asks, when the assist is off', async () => {
		const briefing = vi.fn(async () => 'x');
		const out = await ask('how am I doing', {
			assist: fakeAssist({ available: false }),
			briefing
		});

		expect(out).toMatchObject({ kind: 'refusal' });
		expect(briefing).not.toHaveBeenCalled();
	});
});

describe('askOutcomeToWire', () => {
	it('keeps the shape the palette client already reads', () => {
		expect(askOutcomeToWire({ kind: 'answer', answer: 'hi' })).toEqual({
			intent: 'answer',
			answer: 'hi'
		});
		expect(askOutcomeToWire({ kind: 'refusal', answer: 'no', raw: 'q' })).toEqual({
			intent: 'unknown',
			answer: 'no',
			raw: 'q'
		});
		expect(
			askOutcomeToWire({ kind: 'navigate', target: 'buckets', answer: 'Open buckets' })
		).toEqual({
			intent: 'navigate',
			answer: 'Open buckets',
			propose: { intent: 'navigate', target: 'buckets', label: 'buckets' }
		});
	});

	it('omits absent optional fields rather than sending nulls', () => {
		expect(
			askOutcomeToWire({ kind: 'proposal', intent: 'create_bucket', answer: 'I need a name.' })
		).toEqual({ intent: 'create_bucket', answer: 'I need a name.' });
	});
});

describe('answerAsk — budgets and Safe to Spend', () => {
	it('proposes a monthly budget without consulting the model', async () => {
		const parseCommand = vi.fn(async () => null);
		const out = await ask('set groceries budget to 400', {
			assist: fakeAssist({ parseCommand })
		});

		expect(out).toMatchObject({ kind: 'proposal', intent: 'propose' });
		expect(out && 'propose' in out && out.propose).toMatchObject({
			intent: 'set_budget',
			category: 'groceries',
			period: 'month'
		});
		expect(parseCommand).not.toHaveBeenCalled();
	});

	it('refuses a non-positive budget amount rather than proposing it', async () => {
		const out = await ask('set groceries budget to 0');
		expect(out).toMatchObject({ kind: 'proposal', intent: 'set_budget' });
		// No propose payload: the amount never became money.
		expect(out && 'propose' in out ? out.propose : undefined).toBeUndefined();
	});

	it('hands Safe to Spend back to the route as a data intent', async () => {
		const out = await ask('how much can I spend?');
		expect(out).toBeNull();
	});
});

describe('answerAsk — the wider window', () => {
	it('refuses a named month outside the briefing, naming what it covers', async () => {
		// A shape the deterministic parser does not recognize, naming a month.
		const out = await ask('did we blow through money in march');
		expect(out).toMatchObject({ kind: 'refusal' });
		if (!out || out.kind !== 'refusal') return;
		expect(out.answer).toContain('this month and last month');
		expect(out.answer).toContain('march');
	});

	it('answers for a named month the briefing was built around', async () => {
		const out = await ask('did we blow through money in march', {
			coveredMonths: [{ y: 2026, m: 3 }],
			briefing: async () => 'The month asked about (March 2026): spent $500.'
		});
		// The scope guard passed it through: the terminal answer is the generic
		// fallback (the fake assist answers nothing), never the window refusal.
		expect(out).not.toBeNull();
		expect(out && 'answer' in out ? out.answer : '').not.toContain('only answer for');
	});
});
