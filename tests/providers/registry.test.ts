/**
 * 实例缓存键感知端点 `.env` 的内容:文件变更后下一次解析重建实例。
 * `bind` 给没有声明 `handlesRefusedAttachments` 的实例套一层 `AttachmentFallback`,每个实例一份。
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
const recording: BlobRef = { handle: 'log:0123456789abcdef0124.wav', mime: 'audio/wav', name: 'heard.wav', fallbackText: 'Recording' };

/** A client whose service refuses every request that carries an attachment; `carried` is one entry per request. */
class RefusesAttachments extends BaseProvider {
  readonly carried: boolean[] = [];
  async respond(request: Request, options: GenerateOptions = {}): Promise<Generation> {
    const carries = (options.context ?? []).some((entry) => entry.context.blobs?.length);
    this.carried.push(carries);
    if (carries) throw new GenerationError('refused', [], null, options.origin!, 400, 'unsupported attachment');
    return { response: createResponse('r1', request), origin: options.origin!, attempts: [] };
  }
}

function imageFixture(handlesRefusedAttachments?: true, blob = picture, accepts?: ProviderModule['accepts']) {
  const temp = makeTmpDir(); cleanups.push(temp.cleanup);
  const client = new RefusesAttachments();
  const module: ProviderModule = {
    id: 'stub', title: 'Stub', reasoningTiers: [], serviceTiers: [], ...(accepts ? { accepts } : {}),
    create: () => ({ client, ...(handlesRefusedAttachments ? { handlesRefusedAttachments } : {}) }),
  };
  const cfg = makeCfg({ providers: { Alpha: { kind: 'stub', baseUrl: 'https://model.test', multimodal: true, spec: { model: 'm', thinking: false } } }, activeProvider: 'Alpha' });
  const registry = new ProviderRegistry(() => cfg.providers, { stateRoot: temp.dir, readBlob: () => Buffer.from('bytes'), keepThinking: () => true, log: nullLogger() }, [module]);
  const ask = () => registry.bind('Alpha').respond({ model: 'm', input: [] }, { context: [message('user', 'look', { blobs: [blob] })] });
  return { client, ask };
}

it('sends a request refused for its images once more without them, and the next bind leaves them out: one request', async () => {
  const { client, ask } = imageFixture();
  await ask();
  expect(client.carried).toEqual([true, false]);
  await ask();
  expect(client.carried).toEqual([true, false, false]);
});

it('adds no fallback around an instance that declares handlesRefusedAttachments: one request, and the refusal reaches the caller', async () => {
  const { client, ask } = imageFixture(true);
  await expect(ask()).rejects.toMatchObject({ status: 400 });
  expect(client.carried).toEqual([true]);
});

it('drops an attachment of another type the module accepts when its request is refused, and the next bind leaves it out', async () => {
  const { client, ask } = imageFixture(undefined, recording, (_entry, _spec, mime) => mime.startsWith('image/') || mime === 'audio/wav');
  await ask();
  expect(client.carried).toEqual([true, false]);
  await ask();
  expect(client.carried).toEqual([true, false, false]);
});

it('does not retry for an attachment type the module does not accept: the client never sent it, and the refusal reaches the caller', async () => {
  const { client, ask } = imageFixture(undefined, recording);
  await expect(ask()).rejects.toMatchObject({ status: 400 });
  expect(client.carried).toEqual([true]);
});
