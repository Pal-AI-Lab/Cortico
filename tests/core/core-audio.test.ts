/**
 * World 事件带的音频附件进日志附件库后，模型请求的上下文带着它的句柄与 mime，按句柄取回同一份字节与类型。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Core } from './fixture-core.ts';
import type { LoadedConfig } from '../../src/core/config.ts';
import type { BotConfig } from '../../bots/corti-soulmate/assemble.ts';
import type { World, WorldHost } from '../../src/core/types.ts';
import { FakeLLM, makeCfg, makeFakePersona, makeLoaded, makeTmpDir } from './helpers.ts';

function loadedFor(dir: string): LoadedConfig<BotConfig> {
  const config = makeCfg();
  config.worlds.qq.enabled = false;
  return makeLoaded({
    config,
    rootDir: dir,
    memoryDir: `${dir}/persona`,
    dataDir: `${dir}/data`,
  });
}

describe('Core · 音频附件', () => {
  let tmp: ReturnType<typeof makeTmpDir> | null = null;
  afterEach(() => {
    tmp?.cleanup();
    tmp = null;
  });

  it('World 事件带的音频字节进日志附件库,模型请求的上下文带着它的句柄与 mime,句柄取回同一份字节', async () => {
    tmp = makeTmpDir();
    const loaded = loadedFor(tmp.dir);
    let host: WorldHost | null = null;
    const probe: World = {
      id: 'probe',
      envPromptVars: () => ({}),
      tools: () => [],
      start: async (h) => { host = h; },
      stop: async () => {},
    };
    const persona = makeFakePersona([], { cfg: loaded.config, worlds: [probe] });
    const llm = new FakeLLM();
    const core = new Core(loaded, { persona, worlds: [probe], llm });
    const voice = Buffer.from('OggS-voice-with-traffic');
    try {
      await core.start();
      await host!.pushEvent({
        type: 'probe.voice', ts: '2026-08-27T21:00:00+08:00', source: 'probe', text: '[21:00] 说话',
        blobs: [{ bytes: voice, mime: 'audio/ogg', name: 'voice.ogg', fallbackText: '[语音]' }],
      }, { trigger: 'flush' });
      await vi.waitUntil(() => llm.calls.some((c) => c.messages.some((m) => m.blobs?.length)), { timeout: 5000 });
      const sent = llm.calls.flatMap((c) => c.messages).flatMap((m) => m.blobs ?? []);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ mime: 'audio/ogg', name: 'voice.ogg', fallbackText: '[语音]' });
      const got = core.resolveBlob(sent[0].handle)!;
      expect(Buffer.from(got.bytes).equals(voice)).toBe(true);
      expect(got.mime).toBe('audio/ogg');
    } finally {
      await core.stop();
    }
  });
});
