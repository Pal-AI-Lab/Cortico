/**
 * The JPEG re-encode the fallback uses on a refused image, and the media override it serves the
 * result through.
 */
import { describe, expect, it } from 'vitest';
import { decode, encode } from 'jpeg-js';
import { FALLBACK_SIDE, overridableMedia, shrinkJpeg } from '../../../src/providers/transport/image-fit.ts';

const ROWS = 48;

/** A JPEG of the given width, tall enough that re-encoding is cheap to verify. */
const jpeg = (width: number, height = ROWS): Buffer => {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = i % 256;
    data[i * 4 + 1] = (i * 7) % 256;
    data[i * 4 + 2] = (i * 13) % 256;
    data[i * 4 + 3] = 255;
  }
  return Buffer.from(encode({ width, height, data }, 90).data);
};

describe('shrinkJpeg', () => {
  it('brings the longest side to FALLBACK_SIDE and keeps the aspect ratio', () => {
    const wide = jpeg(FALLBACK_SIDE + 200, (FALLBACK_SIDE + 200) / 2);
    const shrunk = shrinkJpeg(wide);
    expect(shrunk).not.toBeNull();
    const decoded = decode(shrunk!, { useTArray: true });
    expect(Math.max(decoded.width, decoded.height)).toBe(FALLBACK_SIDE);
    expect(decoded.width / decoded.height).toBeCloseTo(2, 1);
  });

  it('leaves a JPEG that already fits alone', () => {
    expect(shrinkJpeg(jpeg(FALLBACK_SIDE))).toBeNull();
  });

  it('leaves bytes that are not a JPEG alone', () => {
    expect(shrinkJpeg(Buffer.from('an image the service will not take'))).toBeNull();
  });

  it('leaves a JPEG alone when its frame header declares dimensions over the pixel budget', () => {
    // SOI, SOF0 with height and width 65535 and three components, EOI.
    const header = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0xff, 0xff, 0xff, 0xff,
      0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
    expect(shrinkJpeg(header)).toBeNull();
  });
});

describe('overridableMedia', () => {
  it('returns served bytes until they are restored', () => {
    const original = Buffer.from('original');
    const served = Buffer.from('served');
    const media = overridableMedia(() => true, (ref) => (ref === 'a' ? original : null));
    expect(media.read('a')).toEqual(original);
    media.serve!('a', served);
    expect(media.read('a')).toEqual(served);
    media.restore!('a');
    expect(media.read('a')).toEqual(original);
  });
});
