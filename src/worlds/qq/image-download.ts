/** Shared QQ image download limits and MIME handling for event capture and vision. */
export interface ImageDownloadOptions {
  timeoutMs: number;
  maxImageBytes: number;
}

export const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};

export async function downloadImageBytes(
  url: string,
  options: ImageDownloadOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<{ buffer: Uint8Array; mime: string }> {
  if (!url) throw new Error('图片地址为空');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), options.timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ab = await res.arrayBuffer();
    if (ab.byteLength > options.maxImageBytes) {
      throw new Error(`图片过大(${ab.byteLength}字节 > 上限${options.maxImageBytes})`);
    }
    return { buffer: new Uint8Array(ab), mime: pickImageMime(res.headers.get('content-type'), url) };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new Error('下载超时');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function pickImageMime(contentType: string | null, url: string): string {
  if (contentType) {
    const mime = contentType.split(';')[0].trim().toLowerCase();
    if (mime.startsWith('image/')) return mime;
  }
  const ext = (url.split('?')[0].match(/\.([a-zA-Z0-9]+)$/)?.[1] ?? '').toLowerCase();
  for (const [mime, extension] of Object.entries(MIME_EXT)) {
    if (extension === ext) return mime;
  }
  return 'image/jpeg';
}
