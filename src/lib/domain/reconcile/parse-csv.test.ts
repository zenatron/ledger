import { describe, expect, it } from 'vitest';
import { detectColumns, parseCsv, dedupKey, type RawStatementLine } from './parse-csv';

const usd = (minor: number) => BigInt(minor);
const date = (s: string) =>
	new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), 12, 0, 0, 0));

// ---------------------------------------------------------------------------
// detectColumns
// ---------------------------------------------------------------------------

describe('detectColumns', () => {
	it('maps canonical headers', () => {
		const m = detectColumns(['Date', 'Description', 'Amount']);
		expect(m).not.toBeNull();
		expect(m!.dateCol).toBe(0);
		expect(m!.descriptionCol).toBe(1);
		expect(m!.amountCol).toBe(2);
	});

	it('maps headers with extra columns', () => {
		const m = detectColumns(['Check Number', 'Date', 'Amount', 'Description', 'Balance']);
		expect(m).not.toBeNull();
		expect(m!.dateCol).toBe(1);
		expect(m!.amountCol).toBe(2);
		expect(m!.descriptionCol).toBe(3);
	});

	it('maps alternate header names', () => {
		const m = detectColumns(['Posting Date', 'Transaction Amount', 'Memo']);
		expect(m).not.toBeNull();
		expect(m!.dateCol).toBe(0);
		expect(m!.amountCol).toBe(1);
		expect(m!.descriptionCol).toBe(2);
	});

	it('maps Debit as amount column', () => {
		const m = detectColumns(['Date', 'Payee', 'Debit']);
		expect(m).not.toBeNull();
		expect(m!.amountCol).toBe(2);
	});

	it('maps Credit as amount column', () => {
		const m = detectColumns(['Date', 'Description', 'Credit']);
		expect(m).not.toBeNull();
	});

	it('returns null when date column is missing', () => {
		expect(detectColumns(['Foo', 'Description', 'Amount'])).toBeNull();
	});

	it('returns null when amount column is missing', () => {
		expect(detectColumns(['Date', 'Description', 'Foo'])).toBeNull();
	});

	it('returns null when description column is missing', () => {
		expect(detectColumns(['Date', 'Amount', 'Foo'])).toBeNull();
	});

	it('is case-insensitive and whitespace-tolerant', () => {
		const m = detectColumns(['  DATE  ', ' DESCRIPTION ', ' AMOUNT']);
		expect(m).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// parseCsv
// ---------------------------------------------------------------------------

describe('parseCsv', () => {
	it('returns empty for an empty file', () => {
		const r = parseCsv('', 'USD');
		expect(r.lines).toHaveLength(0);
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0].message).toContain('empty');
	});

	it('returns an error when columns cannot be detected', () => {
		const r = parseCsv('Foo,Bar,Baz\n1,2,3', 'USD');
		expect(r.lines).toHaveLength(0);
		expect(r.errors[0].message).toContain('Could not auto-detect');
	});

	it('parses a simple CSV with explicit column map', () => {
		const csv = [
			'Date,Payee,Amount',
			'2024-01-15,Coffee Shop,12.50',
			'2024-01-16,Restaurant,45.00'
		].join('\n');
		const r = parseCsv(csv, 'USD', { dateCol: 0, amountCol: 2, descriptionCol: 1 });
		expect(r.errors).toHaveLength(0);
		expect(r.lines).toHaveLength(2);
		expect(r.lines[0].amountMinor).toBe(usd(1250));
		expect(r.lines[1].amountMinor).toBe(usd(4500));
	});

	it('parses with auto-detected headers', () => {
		const csv = [
			'Date,Description,Amount',
			'2024-01-15,Coffee Shop,12.50',
			'2024-01-16,Restaurant,45.00'
		].join('\n');
		const r = parseCsv(csv, 'USD');
		expect(r.errors).toHaveLength(0);
		expect(r.lines).toHaveLength(2);
	});

	it('skips blank rows', () => {
		const csv = [
			'Date,Description,Amount',
			'2024-01-15,Coffee Shop,12.50',
			',,',
			'2024-01-16,Restaurant,45.00'
		].join('\n');
		const r = parseCsv(csv, 'USD');
		expect(r.errors).toHaveLength(0);
		expect(r.lines).toHaveLength(2);
	});

	it('associates the workspace currency', () => {
		const csv = 'Date,Description,Amount\n2024-01-15,Coffee,12.50';
		const r = parseCsv(csv, 'GBP');
		expect(r.lines[0].currency).toBe('GBP');
	});

	// -----------------------------------------------------------------------
	// Amount formats
	// -----------------------------------------------------------------------

	it('handles dollar sign and thousands separator', () => {
		const csv = 'Date,Description,Amount\n2024-01-15,Shop,"$1,234.56"';
		const r = parseCsv(csv, 'USD');
		expect(r.lines[0].amountMinor).toBe(usd(123456));
	});

	it('reads a lone comma before three digits as thousands, not decimal', () => {
		const csv = 'Date,Description,Amount\n2024-01-15,Shop,"1,234"';
		const r = parseCsv(csv, 'USD');
		expect(r.lines[0].amountMinor).toBe(usd(123400));
	});

	it('reads repeated commas as thousands grouping', () => {
		const csv = 'Date,Description,Amount\n2024-01-15,Shop,"1,234,567"';
		const r = parseCsv(csv, 'USD');
		expect(r.lines[0].amountMinor).toBe(usd(123456700));
	});

	it('reads a lone comma before 1-2 digits as a decimal comma', () => {
		const csv = 'Date,Description,Amount\n2024-01-15,Café,"12,5"';
		const r = parseCsv(csv, 'EUR');
		expect(r.lines[0].amountMinor).toBe(usd(1250));
	});

	it('reads dot-grouped decimal-comma amounts (1.234,56)', () => {
		const csv = 'Date,Description,Amount\n2024-01-15,Café,"1.234,56"';
		const r = parseCsv(csv, 'EUR');
		expect(r.lines[0].amountMinor).toBe(usd(123456));
	});

	it('reads dot-grouped whole amounts (1.234) as thousands', () => {
		const csv = 'Date,Description,Amount\n2024-01-15,Café,"1.234"';
		const r = parseCsv(csv, 'EUR');
		expect(r.lines[0].amountMinor).toBe(usd(123400));
	});

	it('keeps exact cents on large amounts without float drift', () => {
		const csv = 'Date,Description,Amount\n2024-01-15,Rent,"90071992547409.93"';
		const r = parseCsv(csv, 'USD');
		expect(r.lines[0].amountMinor).toBe(9007199254740993n);
	});

	it('reads a lone decimal separator with a zero integer part as decimal', () => {
		const csv = 'Date,Description,Amount\n2024-01-15,Fee,0.500';
		const r = parseCsv(csv, 'USD');
		expect(r.lines[0].amountMinor).toBe(usd(50));
	});

	it('rounds a third fraction digit half-up', () => {
		const csv = 'Date,Description,Amount\n2024-01-15,Shop,"0,125"';
		const r = parseCsv(csv, 'EUR');
		expect(r.lines[0].amountMinor).toBe(13n);
	});

	it('handles parenthetical negative notation', () => {
		const csv = 'Date,Description,Amount\n2024-01-15,Refund,(100.00)';
		const r = parseCsv(csv, 'USD');
		expect(r.lines[0].amountMinor).toBe(usd(-10000));
	});

	it('handles leading minus', () => {
		const csv = 'Date,Description,Amount\n2024-01-15,Adjustment,-50.00';
		const r = parseCsv(csv, 'USD');
		expect(r.lines[0].amountMinor).toBe(usd(-5000));
	});

	it('handles trailing minus', () => {
		const csv = 'Date,Description,Amount\n2024-01-15,Adjustment,50.00-';
		const r = parseCsv(csv, 'USD');
		expect(r.lines[0].amountMinor).toBe(usd(-5000));
	});

	it('handles zero', () => {
		const csv = 'Date,Description,Amount\n2024-01-15,Fee,$0.00';
		const r = parseCsv(csv, 'USD');
		expect(r.lines[0].amountMinor).toBe(0n);
	});

	it('reports error for non-numeric amount', () => {
		const csv = 'Date,Description,Amount\n2024-01-15,Shop,nonsense';
		const r = parseCsv(csv, 'USD');
		expect(r.lines).toHaveLength(0);
		expect(r.errors[0].message).toContain('Could not parse amount');
	});

	// -----------------------------------------------------------------------
	// Date formats
	// -----------------------------------------------------------------------

	it('parses ISO 8601 dates', () => {
		const csv = 'Date,Description,Amount\n2024-01-15,Shop,10.00';
		const r = parseCsv(csv, 'USD');
		expect(r.lines[0].postedAt.toISOString().slice(0, 10)).toBe('2024-01-15');
	});

	it('parses compact 20240115 dates', () => {
		const csv = 'Date,Description,Amount\n20240115,Shop,10.00';
		const r = parseCsv(csv, 'USD');
		expect(r.lines[0].postedAt.toISOString().slice(0, 10)).toBe('2024-01-15');
	});

	it('parses US slash dates (MDY default)', () => {
		const csv = 'Date,Description,Amount\n01/15/2024,Shop,10.00';
		const r = parseCsv(csv, 'USD');
		expect(r.lines[0].postedAt.toISOString().slice(0, 10)).toBe('2024-01-15');
	});

	it('parses slash dates in DMY order', () => {
		const csv = 'Date,Description,Amount\n15/01/2024,Shop,10.00';
		const r = parseCsv(csv, 'USD', {
			dateCol: 0,
			amountCol: 2,
			descriptionCol: 1,
			dateOrder: 'DMY'
		});
		expect(r.lines[0].postedAt.toISOString().slice(0, 10)).toBe('2024-01-15');
	});

	it('parses named-month dates (US order, quoted for the comma)', () => {
		const csv = 'Date,Description,Amount\n"Jan 15, 2024",Shop,10.00';
		const r = parseCsv(csv, 'USD');
		expect(r.lines[0].postedAt.toISOString().slice(0, 10)).toBe('2024-01-15');
	});

	it('parses named-month dates (day-first)', () => {
		const csv = 'Date,Description,Amount\n15 Jan 2024,Shop,10.00';
		const r = parseCsv(csv, 'USD');
		expect(r.lines[0].postedAt.toISOString().slice(0, 10)).toBe('2024-01-15');
	});

	it('parses 2-digit years as 2000s', () => {
		const csv = 'Date,Description,Amount\n01/15/24,Shop,10.00';
		const r = parseCsv(csv, 'USD');
		expect(r.lines[0].postedAt.toISOString().slice(0, 10)).toBe('2024-01-15');
	});

	it('reports error for unparseable date', () => {
		const csv = 'Date,Description,Amount\nNotADate,Shop,10.00';
		const r = parseCsv(csv, 'USD');
		expect(r.errors[0].message).toContain('Could not parse date');
	});

	// -----------------------------------------------------------------------
	// Inverted amounts
	// -----------------------------------------------------------------------

	it('inverts amounts when invertAmount is true', () => {
		const csv = 'Date,Description,Amount\n2024-01-15,Interest,5.00';
		const r = parseCsv(csv, 'USD', {
			dateCol: 0,
			amountCol: 2,
			descriptionCol: 1,
			invertAmount: true
		});
		expect(r.lines[0].amountMinor).toBe(usd(-500));
	});

	// -----------------------------------------------------------------------
	// Descriptions
	// -----------------------------------------------------------------------

	it('normalises descriptions to lower-case single-spaced', () => {
		const csv = 'Date,Description,Amount\n2024-01-15,"  COFFEE   SHOP  ",10.00';
		const r = parseCsv(csv, 'USD');
		expect(r.lines[0].rawDescription).toBe('COFFEE   SHOP');
		expect(r.lines[0].normalizedDescription).toBe('coffee shop');
	});

	it('reports error for empty description', () => {
		const csv = 'Date,Description,Amount\n2024-01-15,,10.00';
		const r = parseCsv(csv, 'USD');
		expect(r.errors[0].message).toContain('Description is empty');
	});

	// -----------------------------------------------------------------------
	// Quoted fields
	// -----------------------------------------------------------------------

	it('handles quoted fields with commas', () => {
		const csv = 'Date,Description,Amount\n2024-01-15,"Coffee, Books & More",12.50';
		const r = parseCsv(csv, 'USD');
		expect(r.lines[0].rawDescription).toBe('Coffee, Books & More');
	});

	it('handles quoted fields with escaped quotes', () => {
		const csv = 'Date,Description,Amount\n2024-01-15,"L""Artisan Bakery",12.50';
		const r = parseCsv(csv, 'USD');
		expect(r.lines[0].rawDescription).toBe('L"Artisan Bakery');
	});

	it('handles multi-line quoted fields', () => {
		const csv = 'Date,Description,Amount\n2024-01-15,"Line 1\nLine 2",12.50';
		const r = parseCsv(csv, 'USD');
		expect(r.lines[0].rawDescription).toBe('Line 1\nLine 2');
	});

	// -----------------------------------------------------------------------
	// Dedup key
	// -----------------------------------------------------------------------

	it('produces a deterministic dedup key', () => {
		const line: RawStatementLine = {
			postedAt: date('2024-01-15'),
			amountMinor: usd(1250),
			currency: 'USD',
			rawDescription: 'Coffee Shop',
			normalizedDescription: 'coffee shop'
		};
		expect(dedupKey(line)).toBe('2024-01-15|1250|coffee shop');
	});

	it('dedup key distinguishes different amounts', () => {
		const a = dedupKey({
			postedAt: date('2024-01-15'),
			amountMinor: usd(1250),
			currency: 'USD',
			rawDescription: 'Coffee',
			normalizedDescription: 'coffee'
		});
		const b = dedupKey({
			postedAt: date('2024-01-15'),
			amountMinor: usd(1400),
			currency: 'USD',
			rawDescription: 'Coffee',
			normalizedDescription: 'coffee'
		});
		expect(a).not.toBe(b);
	});

	// -----------------------------------------------------------------------
	// Column positions beyond row length
	// -----------------------------------------------------------------------

	it('produces parse errors when columns are out of range', () => {
		const csv = 'Date,Description,Amount\n2024-01-15,Shop';
		const r = parseCsv(csv, 'USD');
		expect(r.errors[0].message).toContain('Could not parse amount');
	});
});
