/** jpeg-js ships JavaScript only; this is the surface `image-fit.ts` uses. */
declare module 'jpeg-js' {
  export interface RawImageData {
    width: number;
    height: number;
    data: Uint8Array;
  }

  export function decode(
    bytes: Buffer | Uint8Array,
    options?: { useTArray?: boolean; formatAsRGBA?: boolean; maxMemoryUsageInMB?: number },
  ): RawImageData;

  export function encode(image: RawImageData, quality?: number): { data: Uint8Array; width: number; height: number };
}
