/**
 * The upload pipeline, against real sharp.
 *
 * Both derivatives now come from one decode, so what has to hold is that they
 * still come out the right shape: bounded on the long edge, oriented the way
 * the photo was taken, and WebP whatever went in.
 */
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { processUpload } from './process';

async function image(
	width: number,
	height: number,
	format: 'jpeg' | 'png',
	opts: { orientation?: number; alpha?: boolean } = {}
): Promise<Uint8Array> {
	let s = sharp({
		create: {
			width,
			height,
			channels: opts.alpha ? 4 : 3,
			background: opts.alpha ? { r: 10, g: 120, b: 40, alpha: 0.5 } : { r: 200, g: 60, b: 40 }
		}
	});
	s = format === 'jpeg' ? s.jpeg() : s.png();
	if (opts.orientation) s = s.withMetadata({ orientation: opts.orientation });
	return new Uint8Array(await s.toBuffer());
}

const isWebp = (b: Uint8Array) =>
	Buffer.from(b.subarray(0, 4)).toString('ascii') === 'RIFF' &&
	Buffer.from(b.subarray(8, 12)).toString('ascii') === 'WEBP';

describe('processUpload', () => {
	it('bounds both derivatives on the long edge and keeps the aspect ratio', async () => {
		const out = await processUpload(await image(4000, 3000, 'jpeg'));
		expect([out.display.width, out.display.height]).toEqual([1600, 1200]);
		expect([out.thumb.width, out.thumb.height]).toEqual([256, 192]);
		expect(isWebp(out.display.data)).toBe(true);
		expect(isWebp(out.thumb.data)).toBe(true);
	});

	it('bakes EXIF orientation into both', async () => {
		// Stored landscape, tagged "rotate 90°": a portrait photo as phones save it.
		const out = await processUpload(await image(4000, 3000, 'jpeg', { orientation: 6 }));
		expect([out.display.width, out.display.height]).toEqual([1200, 1600]);
		expect([out.thumb.width, out.thumb.height]).toEqual([192, 256]);
	});

	it('never enlarges a small image', async () => {
		const out = await processUpload(await image(300, 200, 'png'));
		expect([out.display.width, out.display.height]).toEqual([300, 200]);
		expect([out.thumb.width, out.thumb.height]).toEqual([256, 171]);
	});

	it('carries an alpha channel through', async () => {
		const out = await processUpload(await image(800, 800, 'png', { alpha: true }));
		const meta = await sharp(Buffer.from(out.thumb.data)).metadata();
		expect(meta.hasAlpha).toBe(true);
	});

	it('refuses what is not an image', async () => {
		await expect(processUpload(new Uint8Array(64))).rejects.toThrow(/Not a supported image/);
	});
});
