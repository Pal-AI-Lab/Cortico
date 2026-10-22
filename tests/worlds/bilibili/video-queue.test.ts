import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorldHost } from '../../../src/core/types.ts';
import { nullLogger } from '../../../src/core/util.ts';
import { cloneOverlayConfig } from '../../../src/worlds/bilibili/overlay/model.ts';
import { parseBvid, VideoQueueStore } from '../../../src/worlds/bilibili/overlay/video-queue.ts';
import { BilibiliWorld } from '../../../src/worlds/bilibili/world.ts';

const roots: string[] = [];
const toolContext = { role: 'main', log: null as never } as const;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('视频排队', () => {
  it('BV 号可从视频链接里取出，前缀写成大写；前后紧挨字母数字的不算', () => {
    expect(parseBvid('https://www.bilibili.com/video/bv1Ab4y1C7dE/?p=2')).toBe('BV1Ab4y1C7dE');
    expect(parseBvid('BV1Ab4y1C7dEx')).toBeNull();
    expect(parseBvid('BV1Ab4y1C7d0')).toBeNull();
  });

  it('排满后加入被拒绝，文件里的队列不变', () => {
    const file = tempFile();
    const store = new VideoQueueStore(file);
    store.add('BV1Ab4y1C7dE', '', undefined, 2);
    store.add('BV1Qx411m7Ks', '', undefined, 2);
    expect(() => store.add('BV1Zr4y1N7pQ', '', undefined, 2)).toThrow('队列已满(2/2)');
    const saved = new VideoQueueStore(file).current;
    expect(saved.items.map((item) => item.bvid)).toEqual(['BV1Ab4y1C7dE', 'BV1Qx411m7Ks']);
    expect(saved.revision).toBe(2);
  });

  it('插入与移动的位置从 1 数起，超出末尾排到最后；同一 BV 号排了多次时移除第一个', () => {
    const store = new VideoQueueStore();
    store.add('BV1Ab4y1C7dE', 'a', undefined, 10);
    store.add('BV1Qx411m7Ks', 'b', 1, 10);
    store.add('BV1Ab4y1C7dE', 'c', 99, 10);
    expect(store.current.items.map((item) => item.note)).toEqual(['b', 'a', 'c']);
    store.move('BV1Qx411m7Ks', 99);
    expect(store.current.items.map((item) => item.note)).toEqual(['a', 'c', 'b']);
    store.remove('BV1Ab4y1C7dE');
    expect(store.current.items.map((item) => item.note)).toEqual(['c', 'b']);
    expect(() => store.remove('BV1Zr4y1N7pQ')).toThrow('队列里没有 BV1Zr4y1N7pQ');
  });

  it('工具改队列后回执列出整队，ENV 占位符与 Overlay SSE 同步；出错时队列不动', async () => {
    const root = tempRoot();
    const module = new BilibiliWorld({
      roomId: 0,
      overlay: { ...cloneOverlayConfig(), port: 0 },
      overlayAssetDir: join(root, 'assets'),
      videoQueueFile: join(root, 'video-queue.json'),
      maxQueuedVideos: () => 3,
    });
    await module.start({ log: nullLogger() } as unknown as WorldHost);
    try {
      const obs = module.webUi('zh').links?.find((link) => link.href.endsWith('/overlay'));
      const stream = await openSse(obs!.href.replace(/\/overlay$/, '/stream'));
      await stream.readUntil('"type":"snapshot"');
      const tool = module.tools().find((item) => item.name === 'bilibili_update_video_queue')!;

      const added = await tool.handler(
        { action: 'add', bvid: 'https://b23.tv/BV1Ab4y1C7dE', note: '新番预告' },
        toolContext,
      );
      expect(added).toBe('[video queue] 1/3\n1. BV1Ab4y1C7dE 新番预告');
      expect(await stream.readUntil('BV1Ab4y1C7dE')).toContain('"type":"video-queue"');
      expect(module.envPromptVars()).toMatchObject({
        'bilibili.videoQueue': '1. BV1Ab4y1C7dE 新番预告',
        'bilibili.videoQueueLimit': '3',
      });

      expect(await tool.handler({ action: 'move', bvid: 'BV1Ab4y1C7dE' }, toolContext)).toBe('[not executed] move 需要 position');
      expect(await tool.handler({ action: 'add', bvid: '第一个视频' }, toolContext)).toContain('[not executed]');
      expect(await tool.handler({ action: 'clear' }, toolContext)).toBe('[video queue] 0/3\n(empty)');
      expect(JSON.parse(readFileSync(join(root, 'video-queue.json'), 'utf8')).items).toEqual([]);
      await stream.close();
    } finally {
      await module.stop();
    }
  });
});

async function openSse(url: string): Promise<{
  readUntil(text: string): Promise<string>;
  close(): Promise<void>;
}> {
  const response = await fetch(url);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  return {
    async readUntil(text: string): Promise<string> {
      for (let index = 0; index < 20 && !pending.includes(text); index += 1) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
      }
      if (!pending.includes(text)) throw new Error(`SSE 未收到 ${text}`);
      const out = pending;
      pending = '';
      return out;
    },
    async close(): Promise<void> {
      await reader.cancel();
    },
  };
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bilibili-video-queue-'));
  roots.push(root);
  return root;
}

function tempFile(): string {
  return join(tempRoot(), 'state', 'video-queue.json');
}
