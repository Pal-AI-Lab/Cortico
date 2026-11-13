/**
 * Requests the model service refuses for their images, through both built-in modules against a
 * local fake service that refuses a request by its body.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GenerationError } from '../../../src/core/generation.ts';
import { nullLogger } from '../../../src/core/util.ts';
import { blobLine } from '../../../src/core/blobs.ts';
import type { BlobRef, LLMProviderEntry } from '../../../src/core/types.ts';
import type { ProviderModule } from '../../../src/providers/base.ts';
import type { Request } from '../../../src/protocol/open-responses/index.ts';
import { message } from '../../../src/protocol/open-responses/context.ts';
import { isContextOverflow } from '../../../src/providers/transport/errors.ts';
import { imageLeftOut } from '../../../src/providers/transport/image-fallback.ts';
import { FALLBACK_SIDE } from '../../../src/providers/transport/image-fit.ts';
import { encode } from 'jpeg-js';
import COMPAT from '../../../src/providers/openai-responses-compat/index.ts';
import LLAMACPP from '../../../src/providers/llamacpp/index.ts';

const IMAGE = Buffer.from('an image the service will not take');
const IMAGE_DATA = IMAGE.toString('base64');
const picture: BlobRef = { handle: 'log:0123456789abcdef0123.png', mime: 'image/png', name: 'big.png', fallbackText: 'Image' };
const context = [message('user', `look\n${blobLine(picture)}`, { blobs: [picture] })];
const OPENRESTY_413 = '<html><head><title>413 Request Entity Too Large</title></head><body><center>openresty</center></body></html>';

/** A JPEG wider than `FALLBACK_SIDE`, so the fallback has something to re-encode. */
const WIDE_WIDTH = FALLBACK_SIDE + 400;
const WIDE_BYTES = Buffer.from(encode({ width: WIDE_WIDTH, height: 64, data: gradient(WIDE_WIDTH, 64) }, 90).data);
const WIDE_DATA = WIDE_BYTES.toString('base64');
const wide: BlobRef = { handle: 'log:fedcba9876543210fedc.jpg', mime: 'image/jpeg', name: 'wide.jpg', fallbackText: 'Image' };
const wideContext = [message('user', `look\n${blobLine(wide)}`, { blobs: [wide] })];
const JPEG_DATA_URL = 'data:image/jpeg;base64,';

/** Opaque pixels of one hue the JPEG encoder keeps, so the fixture stays small. */
function gradient(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = x % 256;
      data[i + 1] = y % 256;
      data[i + 2] = (x + y) % 256;
      data[i + 3] = 255;
    }
  }
  return data;
}

const REPLIES: Record<string, object> = {
  '/responses': { id: 'r1', object: 'response', model: 'm', status: 'completed', created_at: 1, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    output: [{ type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }] },
  '/chat/completions': { id: 'c1', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
};

let server: Server | null = null;
afterEach(() => { server?.close(); server = null; });

/** A fake service that answers `status` with `error` to the requests `refuse` picks. */
async function service(refuse: (body: string) => boolean, status = 400, error = JSON.stringify({ error: { message: 'unsupported image' } })) {
  const bodies: string[] = [];
  server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    bodies.push(body);
    if (refuse(body)) return res.writeHead(status, { 'content-type': error.startsWith('<') ? 'text/html' : 'application/json' }).end(error);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(REPLIES[(req.url ?? '').split('?')[0]!] ?? {}));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
  return { url: `http://127.0.0.1:${(server!.address() as { port: number }).port}`, bodies };
}

const carriesImage = (body: string) => body.includes(IMAGE_DATA);

function client(module: ProviderModule, url: string, patch: Partial<LLMProviderEntry> = {}) {
  const entry: LLMProviderEntry = { kind: module.id, baseUrl: url, multimodal: true, spec: { model: 'm', thinking: false }, ...patch };
  return module.create('x', entry, {
    stateDir: mkdtempSync(join(tmpdir(), 'image-fallback-')), secret: () => '', keepThinking: () => true, log: nullLogger(),
    readBlob: (handle: string) => (handle === picture.handle ? IMAGE : null),
  }).client;
}

/** The same client, reading the wide JPEG fixture. */
const wideClient = (module: ProviderModule, url: string) => module.create('x',
  { kind: module.id, baseUrl: url, multimodal: true, spec: { model: 'm', thinking: false } },
  {
    stateDir: mkdtempSync(join(tmpdir(), 'image-fallback-')), secret: () => '', keepThinking: () => true, log: nullLogger(),
    readBlob: (handle: string) => (handle === wide.handle ? WIDE_BYTES : null),
  }).client;

const ask = (target: ReturnType<typeof client>, ctx = context) => target.respond({ model: 'm', input: [] } as unknown as Request, { context: ctx });

describe('a request the model service refuses for its images', () => {
  it('is sent once more without them on both modules, and later requests leave them out: one request each', async () => {
    const { url, bodies } = await service(carriesImage);
    for (const module of [COMPAT, LLAMACPP]) {
      bodies.length = 0;
      const target = client(module, url);
      const first = await ask(target);
      expect(first.attempts.map((a) => a.status), module.id).toEqual([400, 200]);
      expect(bodies.map(carriesImage), module.id).toEqual([true, false]);
      expect(bodies[1], module.id).toContain(imageLeftOut(picture.handle));
      await ask(target);
      expect(bodies.map(carriesImage), module.id).toEqual([true, false, false]);
      expect(bodies[2], module.id).toBe(bodies[1]);
    }
  });

  it('puts the left-out line on its own line on Chat, which joins text parts without a separator', async () => {
    const { url, bodies } = await service(carriesImage);
    await ask(client(LLAMACPP, url));
    expect(JSON.parse(bodies[1]!).messages.at(-1).content).toBe(`look\n${blobLine(picture)}\n${imageLeftOut(picture.handle)}`);
  });

  it('is sent again without them on a 413, which otherwise counts as a context overflow', async () => {
    const { url, bodies } = await service(carriesImage, 413, OPENRESTY_413);
    const first = await ask(client(COMPAT, url));
    expect(first.attempts.map((a) => a.status)).toEqual([413, 200]);
    expect(bodies.map(carriesImage)).toEqual([true, false]);
  });

  it('keeps both attempts on the error when the request without them is refused too, and sends them next time', async () => {
    const { url, bodies } = await service(() => true, 413, OPENRESTY_413);
    const target = client(COMPAT, url);
    const error = await ask(target).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GenerationError);
    expect((error as GenerationError).attempts.map((a) => a.status)).toEqual([413, 413]);
    expect(isContextOverflow(error as GenerationError)).toBe(true);
    await ask(target).catch(() => {});
    expect(bodies.map(carriesImage)).toEqual([true, false, true, false]);
  });

  it('is not sent again when the refusal is a token overflow: one request', async () => {
    const { url, bodies } = await service(carriesImage, 400, JSON.stringify({ error: { code: 'context_length_exceeded', message: 'too long' } }));
    await expect(ask(client(COMPAT, url))).rejects.toMatchObject({ status: 400 });
    expect(bodies).toHaveLength(1);
  });

  it('is not sent again when the endpoint sends no images: one request', async () => {
    const { url, bodies } = await service(() => true);
    await expect(ask(client(COMPAT, url, { multimodal: false }))).rejects.toMatchObject({ status: 400 });
    expect(bodies).toHaveLength(1);
  });

  it('sends a refused JPEG once more with its longest side at FALLBACK_SIDE, and later requests reuse those bytes', async () => {
    const { url, bodies } = await service((body) => body.includes(WIDE_DATA));
    const target = wideClient(COMPAT, url);
    const first = await ask(target, wideContext);
    expect(first.attempts.map((a) => a.status)).toEqual([400, 200]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain(JPEG_DATA_URL);
    expect(bodies[1]).not.toContain(WIDE_DATA);
    await ask(target, wideContext);
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toBe(bodies[1]);
  });

  it('drops the image when the resized request is refused too, and names it in the left-out line', async () => {
    const { url, bodies } = await service((body) => body.includes(JPEG_DATA_URL), 413, OPENRESTY_413);
    const first = await ask(wideClient(COMPAT, url), wideContext);
    expect(first.attempts.map((a) => a.status)).toEqual([413, 413, 200]);
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toContain(imageLeftOut(wide.handle));
    expect(bodies[2]).not.toContain(JPEG_DATA_URL);
  });
});
