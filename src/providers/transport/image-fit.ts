/**
 * Re-encode the JPEGs of a request the model service refused, so the request can be sent once more
 * with smaller images. A service that bounds a decoded image rejects the whole request, so the bound
 * is learned from the refusal and never configured: a refused request's JPEGs are shrunk to
 * `FALLBACK_SIDE`. PNG, GIF and WebP are not re-encoded; those images keep the existing "left out"
 * path in `image-fallback.ts`.
 *
 * Only the fallback path decodes anything: an ordinary request sends the recorded bytes untouched.
 */
import { decode, encode } from 'jpeg-js';
import type { CompatMediaOptions } from './history.ts';

/** Longest side a refused request's JPEGs are re-encoded to before the one more try. */
export const FALLBACK_SIDE = 2000;

/** Larger images go to the "left out" path instead of a decode and re-encode. */
const MAX_PIXELS = 60_000_000;

/** Quality the re-encode uses; high enough that the image still reads as itself. */
const QUALITY = 85;

interface Size {
  width: number;
  height: number;
}

/**
 * The module's media with a per-handle override `read` returns first. The fallback resizes refused
 * images through `serve`; the override outlives the request so a handle sent again carries the
 * resized bytes without another decode. `restore` drops an override whose retry was refused too.
 */
export function overridableMedia(enabled: () => boolean, read: (ref: string) => Buffer | null): CompatMediaOptions {
  const overridden = new Map<string, Buffer>();
  return {
    enabled,
    read: (ref) => overridden.get(ref) ?? read(ref),
    serve: (ref, bytes) => {
      overridden.set(ref, bytes);
    },
    restore: (ref) => {
      overridden.delete(ref);
    },
  };
}

/**
 * `bytes` re-encoded so the longest side is `FALLBACK_SIDE`, or null when the bytes are not a JPEG,
 * already fit, are too large to decode, or cannot be re-encoded.
 */
export function shrinkJpeg(bytes: Buffer): Buffer | null {
  const size = jpegSize(bytes);
  if (!size) return null;
  if (Math.max(size.width, size.height) <= FALLBACK_SIDE) return null;
  if (size.width * size.height > MAX_PIXELS) return null;
  let decoded: { width: number; height: number; data: Uint8Array };
  try {
    decoded = decode(bytes, { useTArray: true });
  } catch {
    return null;
  }
  const next = fit({ width: decoded.width, height: decoded.height });
  try {
    const encoded = encode({ data: boxResize(decoded.data, { width: decoded.width, height: decoded.height }, next), width: next.width, height: next.height }, QUALITY);
    return Buffer.from(encoded.data);
  } catch {
    return null;
  }
}

/**
 * The image size a JPEG declares in its frame header, or null when the bytes are not a JPEG or the
 * header is unreadable. Read before decoding so an over-budget image costs no allocation.
 */
function jpegSize(bytes: Buffer): Size | null {
  // The magic; the bytes decide, never the declared mime.
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9) return null;
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return null;
    // SOF0-SOF15 minus DHT (C4), JPG (C8) and DAC (CC); the height and width follow the precision.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 > bytes.length) return null;
      const height = bytes.readUInt16BE(offset + 5);
      const width = bytes.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (marker === 0xda) return null;
    offset += 2 + length;
  }
  return null;
}

/** `size` with its longest side at `FALLBACK_SIDE`, keeping the aspect ratio. */
function fit(size: Size): Size {
  const ratio = FALLBACK_SIDE / Math.max(size.width, size.height);
  return {
    width: Math.max(1, Math.round(size.width * ratio)),
    height: Math.max(1, Math.round(size.height * ratio)),
  };
}

/** Area-average resample; only used to shrink, so every destination pixel covers a real region. */
function boxResize(src: Uint8Array, from: Size, to: Size): Uint8Array {
  const { width: sw, height: sh } = from;
  const { width: dw, height: dh } = to;
  const out = new Uint8Array(dw * dh * 4);
  const startX = new Int32Array(dw);
  const endX = new Int32Array(dw);
  for (let x = 0; x < dw; x++) {
    startX[x] = Math.floor((x * sw) / dw);
    endX[x] = Math.max(startX[x] + 1, Math.min(sw, Math.ceil(((x + 1) * sw) / dw)));
  }
  for (let y = 0; y < dh; y++) {
    const startY = Math.floor((y * sh) / dh);
    const endY = Math.max(startY + 1, Math.min(sh, Math.ceil(((y + 1) * sh) / dh)));
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = startY; sy < endY; sy++) {
        const row = sy * sw;
        for (let sx = startX[x]; sx < endX[x]; sx++) {
          const i = (row + sx) * 4;
          r += src[i]!; g += src[i + 1]!; b += src[i + 2]!; a += src[i + 3]!;
          n++;
        }
      }
      const o = (y * dw + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}
