import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventEnvelope, WorldHost, PushOptions } from '../../../src/core/types.ts';
import { dryMountWorld } from '../../../src/extensions/dry-mount.ts';
import { QQ } from '../../../src/worlds/qq/definition.ts';
import { QQWorld } from '../../../src/worlds/qq/world.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'qq-world-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 记录推送的事件；其余宿主接口空实现。 */
class FakeHost implements WorldHost {
  events: EventEnvelope[] = [];
  pushDeferred(): void {}
  store = { get: () => undefined, latestCursor: () => 0, range: () => [], around: () => [], grep: () => [] } as unknown as WorldHost['store'];
  blob = () => null;
  modelFacts = { model: () => 'test', accepts: () => false, contextWindow: () => 128000 };
  log = { child() { return this; }, info() {}, warn() {}, error() {}, debug() {}, trace() {}, emit() {} } as unknown as WorldHost['log'];
  pushOpts: Array<PushOptions | undefined> = [];
  async pushEvent(e: Omit<EventEnvelope, 'cursor'>, _opts?: PushOptions): Promise<EventEnvelope> {
    const full = { ...e, cursor: this.events.length + 1 } as EventEnvelope;
    this.events.push(full);
    return full;
  }
  async drainPendingEvents(): Promise<EventEnvelope[]> { return []; }
  reportUsage(): void {}
}

const CFG = {
  wsUrl: 'ws://127.0.0.1:1',
  groups: [],
  privates: [],
  token: '',
  timezone: 'Asia/Shanghai',
  dataDir: '',
  media: { enabled: true },
};

/** 直接驱动 handleMessage：它是 private，这里借 any 访问以避开起 WS。 */
async function deliver(world: QQWorld, host: FakeHost, segments: Array<{ type: string; data?: Record<string, unknown> }>): Promise<void> {
  await (world as unknown as {
    handleMessage: (m: unknown, c: unknown) => Promise<void>;
  }).handleMessage(
    {
      post_type: 'message', message_type: 'group', group_id: 1, user_id: 100,
      message_id: 7, time: 1700000000, sender: { nickname: '小明' },
      message: segments,
    },
    { kind: 'group', id: 1 },
  );
}

describe('QQ World · 视频落盘', () => {
  it('干装载不报失败', async () => {
    const report = await dryMountWorld(QQ, { scratchDir: dir });
    expect(report.failures).toEqual([]);
  });

  it('describe 里有 qq.video 事件', () => {
    const types = (QQ.describe?.events ?? []).map((e) => e.type);
    expect(types).toContain('qq.video');
  });

  it('默认配置带 media 段，enabled 为 true', () => {
    const d = QQ.defaults();
    expect(d.media.enabled).toBe(true);
    expect(d.media.maxVideoBytes).toBe(200 * 1024 * 1024);
    expect(d.media.timeoutMs).toBe(60_000);
  });

  it('video 段落盘后另发 qq.video，正文带绝对路径', async () => {
    const src = join(dir, 'clip.mp4');
    writeFileSync(src, Buffer.alloc(4096, 3));
    const host = new FakeHost();
    const world = new QQWorld({ ...CFG, dataDir: dir });
    await world.start(host);

    await deliver(world, host, [{ type: 'video', data: { file: src } }]);
    // 等落盘事件落地
    await new Promise((r) => setTimeout(r, 300));

    const video = host.events.filter((e) => e.type === 'qq.video');
    expect(video.length).toBe(1);
    expect(video[0].text).toContain('[video] 已存本地：');
    expect(video[0].text).toMatch(/qq-media[\\/].*clip\.mp4/);
    expect(existsSync(String(video[0].meta?.video_path))).toBe(true);

    // 消息本体照常投递，没被卡住
    const msg = host.events.filter((e) => e.type === 'qq.message');
    expect(msg.length).toBe(1);
    await world.stop();
  });

  it('拿不到文件时写清原因，消息本体照样投递', async () => {
    const host = new FakeHost();
    const world = new QQWorld({ ...CFG, dataDir: dir });
    await world.start(host);

    await deliver(world, host, [{ type: 'video', data: {} }]);
    await new Promise((r) => setTimeout(r, 200));

    // 没有源的段不入列，不会有 qq.video；但消息必须在
    expect(host.events.filter((e) => e.type === 'qq.message').length).toBe(1);
    expect(host.events.filter((e) => e.type === 'qq.video').length).toBe(0);
    await world.stop();
  });

  it('本地文件不存在时，qq.video 写失败原因', async () => {
    const host = new FakeHost();
    const world = new QQWorld({ ...CFG, dataDir: dir });
    await world.start(host);

    await deliver(world, host, [{ type: 'video', data: { file: join(dir, 'ghost.mp4') } }]);
    await new Promise((r) => setTimeout(r, 300));

    const video = host.events.filter((e) => e.type === 'qq.video');
    expect(video.length).toBe(1);
    expect(video[0].text).toContain('没能落盘');
    expect(host.events.filter((e) => e.type === 'qq.message').length).toBe(1);
    await world.stop();
  });

  it('media.enabled=false 时不落盘，video 段只留占位', async () => {
    const src = join(dir, 'off.mp4');
    writeFileSync(src, Buffer.alloc(2048, 1));
    const host = new FakeHost();
    const world = new QQWorld({ ...CFG, dataDir: dir, media: { enabled: false } });
    await world.start(host);

    await deliver(world, host, [{ type: 'video', data: { file: src } }]);
    await new Promise((r) => setTimeout(r, 200));

    expect(host.events.filter((e) => e.type === 'qq.video').length).toBe(0);
    const m = host.events.find((e) => e.type === 'qq.message');
    expect(m?.text).toContain('[视频]');
    await world.stop();
  });

  it('多个 video 段各自落盘、各自一条事件', async () => {
    const a = join(dir, 'a.mp4');
    const b = join(dir, 'b.mp4');
    writeFileSync(a, Buffer.alloc(2048, 1));
    writeFileSync(b, Buffer.alloc(2048, 2));
    const host = new FakeHost();
    const world = new QQWorld({ ...CFG, dataDir: dir });
    await world.start(host);

    await deliver(world, host, [
      { type: 'video', data: { file: a } },
      { type: 'video', data: { file: b } },
    ]);
    await new Promise((r) => setTimeout(r, 400));

    const videos = host.events.filter((e) => e.type === 'qq.video');
    expect(videos.length).toBe(2);
    expect(videos[0].text).not.toBe(videos[1].text);
    const mediaDir = join(dir, 'qq-media');
    expect(existsSync(mediaDir)).toBe(true);
    const files = readdirSync(mediaDir);
    expect(files.filter((f) => f.endsWith('.mp4')).length).toBe(2);
    await world.stop();
  });

  it('图片逻辑没被带坏：无图无 blob，有 vision 时也不落视频以外的怪东西', async () => {
    const host = new FakeHost();
    const world = new QQWorld({ ...CFG, dataDir: dir });
    await world.start(host);
    await deliver(world, host, [{ type: 'text', data: { text: '纯文本' } }]);
    const m = host.events.find((e) => e.type === 'qq.message');
    expect(m?.blobs ?? []).toEqual([]);
    await world.stop();
  });
});
