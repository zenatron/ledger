import sharp from 'sharp';
import {
	ImageValidationError,
	MAX_AVATAR_BYTES,
	MAX_UPLOAD_BYTES,
	type Derivative,
	type ProcessedImage
} from '$lib/ports/image-processor';

// Re-exported so existing server-side importers keep working; the definitions
// live in the port so client code can name them without importing sharp.
export {
	ImageValidationError,
	MAX_AVATAR_BYTES,
	MAX_UPLOAD_BYTES,
	type Derivative,
	type ProcessedImage
};

/**
 * Untrusted-upload pipeline: verify magic bytes (never the client's
 * Content-Type), cap pixels before decode (decompression bombs), bake EXIF
 * orientation in with .rotate() *first*, then encode WebP — sharp drops all
 * metadata (GPS, timestamps) unless asked to keep it, which we never do.
 * Originals are discarded; only the two derivatives are stored.
 */

const MAX_INPUT_PIXELS = 40_000_000; // ~40MP
/** Bounds on the *long* edge, not on width — see `derive`. */
const DISPLAY_EDGE = 1600;
// The thumb renders exactly once, as the ledger row's 40px avatar; 256 leaves
// 2× headroom over even a 3×-DPR screen while costing about half the bytes of
// the 400px it replaces. Below this the largest tablets would go soft.
const THUMB_EDGE = 256;
const WEBP_QUALITY = 78;

function sniffFormat(data: Uint8Array): 'jpeg' | 'png' | 'webp' | null {
	if (data.length < 12) return null;
	if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
	if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'png';
	if (
		data[0] === 0x52 &&
		data[1] === 0x49 &&
		data[2] === 0x46 &&
		data[3] === 0x46 &&
		data[8] === 0x57 &&
		data[9] === 0x45 &&
		data[10] === 0x42 &&
		data[11] === 0x50
	) {
		return 'webp';
	}
	return null;
}

export async function processUpload(input: Uint8Array): Promise<ProcessedImage> {
	if (input.byteLength > MAX_UPLOAD_BYTES) {
		throw new ImageValidationError('Image is too large (15 MB max)');
	}
	if (sniffFormat(input) === null) {
		throw new ImageValidationError('Not a supported image (JPEG, PNG, or WebP)');
	}

	/*
	 * `fit: 'inside'` bounds the long edge, so both dimensions stay under `edge`
	 * and the aspect ratio is untouched — nothing is ever cropped here. Bounding
	 * width alone made portrait uploads the most expensive thing in the store: a
	 * phone photo came out 1600×2133, half again the pixels of the same shot held
	 * landscape. Cropping to a uniform shape is a presentation choice and belongs
	 * in CSS, where it can be changed later; these are the only copies kept.
	 */
	async function derive(edge: number): Promise<Derivative> {
		const out = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
			.rotate() // bake EXIF orientation before metadata is dropped
			.resize(edge, edge, { fit: 'inside', withoutEnlargement: true })
			.webp({ quality: WEBP_QUALITY })
			.toBuffer({ resolveWithObject: true });
		return { data: out.data, width: out.info.width, height: out.info.height };
	}

	try {
		const [display, thumb] = await Promise.all([derive(DISPLAY_EDGE), derive(THUMB_EDGE)]);
		return { display, thumb };
	} catch (e) {
		if (e instanceof ImageValidationError) throw e;
		throw new ImageValidationError('Could not decode this image');
	}
}
/**
 * Re-encode an image to JPEG for a model to look at.
 *
 * Not cosmetic, and not optional. **Ollama does not decode WebP** — and the
 * failure is silent: the image is dropped from the request and the model,
 * handed a bill-shaped question with no bill, answers from its priors. It
 * invents a plausible vendor and a plausible total. That is the single worst
 * outcome this whole layer is built to prevent, and it cannot be detected
 * downstream, because a confabulated invoice looks exactly like a real one.
 *
 * WebP is the right format for storage and for the browser, so `read-pdf` keeps
 * rendering it and the attached page is unchanged. This converts on the way to
 * the model only, at the one point every image passes through, so no caller has
 * to remember. JPEG rather than PNG because a photographed page is a photograph:
 * a fifth of the bytes at the same legibility, and bytes are tokens here.
 *
 * The long edge stays generous — small print is the whole reason to be reading
 * this at all, and downsampling a page until the model can't read the decimals
 * would defeat the exercise more quietly than failing would.
 */
const MODEL_EDGE = 2000;
const MODEL_QUALITY = 88;

export async function toModelImage(
	input: Uint8Array
): Promise<{ data: Uint8Array; mediaType: 'image/jpeg' }> {
	if (sniffFormat(input) === null) {
		throw new ImageValidationError('Not a supported image (JPEG, PNG, or WebP)');
	}
	try {
		const out = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
			.rotate()
			.resize(MODEL_EDGE, MODEL_EDGE, { fit: 'inside', withoutEnlargement: true })
			// Pages are transparent where nothing is drawn; flattened onto black by
			// default, a bill becomes an unreadable rectangle.
			.flatten({ background: '#ffffff' })
			.jpeg({ quality: MODEL_QUALITY })
			.toBuffer();
		return { data: out, mediaType: 'image/jpeg' };
	} catch (e) {
		if (e instanceof ImageValidationError) throw e;
		throw new ImageValidationError('Could not decode this image');
	}
}

/** Max bytes for a user-uploaded avatar (10 MB). */
const AVATAR_EDGE = 256;
const AVATAR_QUALITY = 72;
/** Decode cap: a 10 MB file can easily be a 20 MP phone photo. */
const AVATAR_MAX_INPUT_PIXELS = 20_000_000;

/**
 * Process a profile-picture upload into a single small WebP derivative.  Bounds
 * to 256 px on the long edge with a moderate quality — avatars render at ~48 px
 * but the extra resolution keeps them crisp on HiDPI screens.
 */
export async function processAvatar(input: Uint8Array): Promise<Derivative> {
	if (input.byteLength > MAX_AVATAR_BYTES) {
		throw new ImageValidationError('Photo is too large (10 MB max)');
	}
	if (sniffFormat(input) === null) {
		throw new ImageValidationError('Not a supported image (JPEG, PNG, or WebP)');
	}
	try {
		const out = await sharp(input, { limitInputPixels: AVATAR_MAX_INPUT_PIXELS })
			.rotate()
			.resize(AVATAR_EDGE, AVATAR_EDGE, { fit: 'inside', withoutEnlargement: true })
			.webp({ quality: AVATAR_QUALITY })
			.toBuffer({ resolveWithObject: true });
		return { data: out.data, width: out.info.width, height: out.info.height };
	} catch (e) {
		if (e instanceof ImageValidationError) throw e;
		throw new ImageValidationError('Could not decode this photo');
	}
}
