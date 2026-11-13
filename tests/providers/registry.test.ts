/**
 * 实例缓存键感知端点 `.env` 的内容:文件变更后下一次解析重建实例。
 * `bind` 给没有声明 `handlesRefusedImages` 的实例套一层 `ImageFallback`,每个实例一份。
 */
import { afterEach, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeCfg, makeTmpDir } from '../core/helpers.ts';
import { nullLogger } from '../../src/core/util.ts';
import { ProviderRegistry } from '../../src/providers/registry.ts';
import { BaseProvider, type ProviderModule } from '../../src/providers/base.ts';
import { GenerationError, type GenerateOptions, type Generation } from '../../src/core/generation.ts';
import type { BlobRef } from '../../src/core/types.ts';
import { decode, encode } from 'jpeg-js';
import { FALLBACK_SIDE } from '../../src/providers/transport/image-fit.ts';
import { createResponse, type Request } from '../../src/protocol/open-responses/index.ts';
import { message } from '../../src/protocol/open-responses/context.ts';

class StubClient extends BaseProvider {
  async respond(): Promise<never> { throw new Error('unused'); }
}

/** 每次实例创建时按端点 `.env` 读到的密钥值。 */
const seenKeys: string[] = [];
const stub: ProviderModule = {
  id: 'stub', title: 'Stub', reasoningTiers: [], serviceTiers: [],
  create: (_name, entry, host) => {
    seenKeys.push(entry.secret ? host.secret(entry.secret) : '');
    return { client: new StubClient() };
  },
};

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); seenKeys.splice(0); });
function fixture() {
  const temp = makeTmpDir(); cleanups.push(temp.cleanup);
  const root = join(temp.dir, 'providers'); mkdirSync(root);
  const dir = join(root, 'Alpha'); mkdirSync(dir);
  writeFileSync(join(dir, '.env'), 'CORTICO_KEY_ALPHA=first\n');
  const cfg = makeCfg({ providers: { Alpha: { kind: 'stub', baseUrl: 'https://model.test', secret: 'CORTICO_KEY_ALPHA' } }, activeProvider: 'Alpha' });
  const registry = new ProviderRegistry(() => cfg.providers, { stateRoot: root, readBlob: () => null, keepThinking: () => true, log: nullLogger() }, [stub]);
  return { registry, dir };
}

it('rebuilds the instance with the new key after the endpoint .env changes', () => {
  const { registry, dir } = fixture();
  const first = registry.resolve('Alpha');
  expect(seenKeys.at(-1)).toBe('first');
  writeFileSync(join(dir, '.env'), 'CORTICO_KEY_ALPHA=second\n');
  expect(registry.resolve('Alpha')).not.toBe(first);
  expect(seenKeys.at(-1)).toBe('second');
});

it('keeps the cached instance while the .env content is unchanged', () => {
  const { registry } = fixture();
  const first = registry.resolve('Alpha');
  expect(registry.resolve('Alpha')).toBe(first);
  expect(seenKeys).toHaveLength(1);
});

const picture: BlobRef = { handle: 'log:0123456789abcdef0123.png', mime: 'image/png', name: 'big.png', fallbackText: 'Image' };

/** A client whose service refuses every request that carries an image; `carried` is one entry per request. */
class RefusesImages extends BaseProvider {
  readonly carried: boolean[] = [];
  async respond(request: Request, options: GenerateOptions = {}): Promise<Generation> {
    const carries = (options.context ?? []).some((entry) => entry.context.blobs?.length);
    this.carried.push(carries);
    if (carries) throw new GenerationError('refused', [], null, options.origin!, 400, 'unsupported image');
    return { response: createResponse('r1', request), origin: options.origin!, attempts: [] };
  }
}

function imageFixture(handlesRefusedImages?: true) {
  const temp = makeTmpDir(); cleanups.push(temp.cleanup);
  const client = new RefusesImages();
  const module: ProviderModule = {
    id: 'stub', title: 'Stub', reasoningTiers: [], serviceTiers: [],
    create: () => ({ client, ...(handlesRefusedImages ? { handlesRefusedImages } : {}) }),
  };
  const cfg = makeCfg({ providers: { Alpha: { kind: 'stub', baseUrl: 'https://model.test', multimodal: true } }, activeProvider: 'Alpha' });
  const registry = new ProviderRegistry(() => cfg.providers, { stateRoot: temp.dir, readBlob: () => Buffer.from('image'), keepThinking: () => true, log: nullLogger() }, [module]);
  const ask = () => registry.bind('Alpha').respond({ model: 'm', input: [] }, { context: [message('user', 'look', { blobs: [picture] })] });
  return { client, ask };
}

it('sends a request refused for its images once more without them, and the next bind leaves them out: one request', async () => {
  const { client, ask } = imageFixture();
  await ask();
  expect(client.carried).toEqual([true, false]);
  await ask();
  expect(client.carried).toEqual([true, false, false]);
});

it('adds no fallback around an instance that declares handlesRefusedImages: one request, and the refusal reaches the caller', async () => {
  const { client, ask } = imageFixture(true);
  await expect(ask()).rejects.toMatchObject({ status: 400 });
  expect(client.carried).toEqual([true]);
});

/** A JPEG wider than `FALLBACK_SIDE`, so the fallback has to decode and re-encode it. */
const WIDE_WIDTH = FALLBACK_SIDE + 400;
const WIDE_BYTES = Buffer.from(encode({ width: WIDE_WIDTH, height: 32, data: pixels(WIDE_WIDTH, 32) }, 80).data);
const widePicture: BlobRef = { handle: 'log:fedcba9876543210fedc.jpg', mime: 'image/jpeg', name: 'wide.jpg', fallbackText: 'Image' };

function pixels(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = x % 256; data[i + 1] = y % 256; data[i + 2] = (x + y) % 256; data[i + 3] = 255;
    }
  return data;
}

/** Sends the bytes its host serves, and refuses while one of them is the original wide JPEG. */
class ReadsBlobs extends BaseProvider {
  /** One entry per request: the bytes the client would have attached. */
  readonly requests: Buffer[][] = [];
  constructor(private readonly readBlob: (handle: string) => Buffer | null) { super(); }
  async respond(request: Request, options: GenerateOptions = {}): Promise<Generation> {
    const bytes = (options.context ?? []).flatMap((entry) => (entry.context.blobs ?? [])
      .map((blob) => this.readBlob(blob.handle))
      .filter((value): value is Buffer => value !== null));
    this.requests.push(bytes);
    if (bytes.some((value) => value.equals(WIDE_BYTES)))
      throw new GenerationError('refused', [], null, options.origin!, 400, 'unsupported image');
    return { response: createResponse('r1', request), origin: options.origin!, attempts: [] };
  }
}

function wideImageFixture() {
  const temp = makeTmpDir(); cleanups.push(temp.cleanup);
  let client: ReadsBlobs | undefined;
  const module: ProviderModule = {
    id: 'stub', title: 'Stub', reasoningTiers: [], serviceTiers: [],
    create: (_name, _entry, host) => {
      client = new ReadsBlobs(host.readBlob);
      return { client };
    },
  };
  const cfg = makeCfg({ providers: { Alpha: { kind: 'stub', baseUrl: 'https://model.test', multimodal: true } }, activeProvider: 'Alpha' });
  const registry = new ProviderRegistry(() => cfg.providers, {
    stateRoot: temp.dir,
    readBlob: (handle) => (handle === widePicture.handle ? WIDE_BYTES : null),
    keepThinking: () => true,
    log: nullLogger(),
  }, [module]);
  const ask = () => registry.bind('Alpha').respond({ model: 'm', input: [] }, { context: [message('user', 'look', { blobs: [widePicture] })] });
  registry.resolve('Alpha');
  return { client: client!, ask };
}

it("serves the fallback's resized JPEG through the instance's readBlob, and later requests reuse those bytes", async () => {
  const { client, ask } = wideImageFixture();
  await ask();
  expect(client.requests).toHaveLength(2);
  expect(client.requests[1]![0]!.equals(WIDE_BYTES)).toBe(false);
  const shrunk = decode(client.requests[1]![0]!, { useTArray: true });
  expect(Math.max(shrunk.width, shrunk.height)).toBe(FALLBACK_SIDE);
  await ask();
  expect(client.requests).toHaveLength(3);
  expect(client.requests[2]![0]!.equals(client.requests[1]![0]!)).toBe(true);
});
