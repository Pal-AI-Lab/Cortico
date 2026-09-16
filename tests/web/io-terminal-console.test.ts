/** Terminal World 使用假 ConsoleStream 验证协议与双向通信。连接进出更新状态，只有消息产生投递事件；控制台贡献按局部 panel id 分派。 */
import { describe, it, expect } from 'vitest';
import { TerminalWorld } from '../../src/worlds/terminal/world.ts';
import { TERMINAL_DEFAULTS, type TerminalConfigSection } from '../../src/worlds/terminal/config.ts';
import { renderWorldEnvPrompt } from '../../src/core/prefix.ts';
import { ioPageContribution } from '../../src/bot.ts';
import { isPanelId } from '../../src/web/shared/console-protocol.ts';
import type { ConsoleStream } from '../../src/web/shared/console-protocol.ts';
import type { ToolCallContext } from '../../src/core/types.ts';
import { nullLogger } from '../../src/core/util.ts';
import { FakeHost, type PushedRecord } from './fakes.ts';

const toolCtx: ToolCallContext = { role: 'main', log: nullLogger() };
/** 回显在 pushEvent 落库之后才广播(句柄那时才有);让微任务与一个宏任务跑完 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// ── 假件 ────────────────────────────────────────────────────────────────

/** 协议里那个 `ConsoleStream` 的最小实现:记下推出去的帧,能被对端喂帧与关闭。 */
class FakeStream implements ConsoleStream {
  sent: string[] = [];
  closedWith: string | undefined;
  private messageCbs: Array<(text: string) => void> = [];
  private closeCbs: Array<() => void> = [];
  private alive = true;

  get open(): boolean { return this.alive; }

  send(data: string): void {
    if (!this.alive) return; // 与服务端适配器一致:已关时静默丢弃
    this.sent.push(data);
  }

  close(reason?: string): void {
    if (!this.alive) return;
    this.closedWith = reason;
    this.alive = false;
    for (const cb of [...this.closeCbs]) cb();
    this.closeCbs.length = 0;
  }

  onMessage(cb: (text: string) => void): void { this.messageCbs.push(cb); }
  onClose(cb: () => void): void {
    if (!this.alive) { cb(); return; }
    this.closeCbs.push(cb);
  }

  /** 对端发来一帧。 */
  feed(text: string): void { for (const cb of [...this.messageCbs]) cb(text); }
  /** 对端断开(网络断/页面关),与 provider 主动 close 走同一条清理路。 */
  hangup(): void {
    if (!this.alive) return;
    this.alive = false;
    for (const cb of [...this.closeCbs]) cb();
    this.closeCbs.length = 0;
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

// ── 归一化:两条路只该差在时间戳上 ────────────────────────────────────

/** `[18:56]` → `[TT]`,免得测试跨分钟边界时自己红。 */
const stripClock = (s: string): string => s.replace(/\[\d{2}:\d{2}\]/g, '[TT]');

const normEvents = (pushed: PushedRecord[]): unknown[] =>
  pushed.map((p) => ({
    type: p.e.type,
    source: p.e.source,
    text: stripClock(p.e.text),
    senderKey: p.e.senderKey,
    meta: p.e.meta,
    opts: p.opts,
  }));

const normFrames = (frames: Array<Record<string, unknown>>): unknown[] =>
  frames.map(({ ts, ...rest }) => {
    void ts; // 时间戳是唯一允许不同的字段
    return rest;
  });

/** 一段覆盖到全部分支的输入:合法/非法 JSON、非对象、未 hello 先说话、未知类型。 */
const SCRIPT = [
  'not json{{',
  '"我是一个裸字符串"',
  JSON.stringify({ type: 'msg', text: '偷跑' }),
  JSON.stringify({ type: 'hello', name: '' }),
  JSON.stringify({ type: 'hello', name: '阿明' }),
  JSON.stringify({ type: 'hello', name: '阿明' }),
  JSON.stringify({ type: 'msg', text: '  你好呀  ' }),
  JSON.stringify({ type: 'msg', text: '   ' }),
  JSON.stringify({ type: 'zzz' }),
];

// ── 1. 流式通道 ────────────────────────────────────────────────────────

describe('TerminalWorld 的流式通道', () => {
  it('连上就有开场白,hello+msg 走通:事件落库 + 回显推回', async () => {
    const host = new FakeHost();
    const mod = new TerminalWorld({ timezone: 'Asia/Shanghai' });
    await mod.start(host);
    const sock = new FakeStream();

    mod.stream('chat', sock);
    expect(sock.frames()[0]).toMatchObject({ type: 'sys' });
    expect(String(sock.frames()[0].text)).toContain('hello');
    expect(mod.onlineCount()).toBe(1);

    sock.feed(JSON.stringify({ type: 'hello', name: '阿明' }));
    expect(String(sock.frames()[1].text)).toContain('阿明');
    // 进出终端不投递事件:presence 噪音不打扰bot
    expect(host.pushed.some((p) => p.e.type === 'terminal.presence')).toBe(false);

    sock.feed(JSON.stringify({ type: 'msg', text: '你好呀' }));
    await settle();
    const msg = host.pushed.find((p) => p.e.type === 'terminal.message');
    expect(msg!.opts?.trigger).toBe('flush');
    expect(msg!.e.senderKey).toBe('阿明');
    expect(msg!.e.source).toBe('terminal');
    expect(msg!.e.text).toMatch(/^\[\d{2}:\d{2}\] 阿明: 你好呀$/);
    // 回显推回给发送者本人(前端以回显为准渲染)
    expect(sock.frames().at(-1)).toMatchObject({ type: 'msg', from: '阿明', text: '你好呀' });

    await mod.stop();
  });

  it('terminal_send 推得到流上的人,断开后安静出名单(无presence事件)', async () => {
    const host = new FakeHost();
    const mod = new TerminalWorld({ timezone: 'Asia/Shanghai', botName: 'Yukima' });
    await mod.start(host);
    const sock = new FakeStream();
    mod.stream('chat', sock);
    sock.feed(JSON.stringify({ type: 'hello', name: '小北' }));

    const send = mod.tools().find((t) => t.name === 'terminal_send')!;
    const result = await send.handler({ text: '我在。' }, toolCtx);
    expect(String(result).startsWith('[sent] ')).toBe(true);
    expect(sock.frames().at(-1)).toMatchObject({ type: 'msg', from: 'Yukima', text: '我在。' });

    sock.hangup();
    expect(mod.onlineCount()).toBe(0);
    expect(host.pushed.some((p) => p.e.type === 'terminal.presence')).toBe(false);
    await mod.stop();
  });

  /**
   * terminal_send 回执报告消息去向及当前连接情况，只给事实，不给建议。
   */
  it('terminal_send 回执报清发到哪、几个连接在线、是谁', async () => {
    const host = new FakeHost();
    const mod = new TerminalWorld({ timezone: 'Asia/Shanghai', botName: 'Yukima' });
    await mod.start(host);
    const send = mod.tools().find((t) => t.name === 'terminal_send')!;

    const alone = String(await send.handler({ text: '有人在吗' }, toolCtx));
    expect(alone).toContain('"Terminal" page');
    expect(alone).toContain('no connection is open');
    expect(alone).toContain('nobody sees this');
    expect(alone).not.toMatch(/read it|has read/);
    expect(alone).not.toMatch(/stream is|live/);

    const sock = new FakeStream();
    mod.stream('chat', sock);
    sock.feed(JSON.stringify({ type: 'hello', name: '小北' }));
    const withPeer = String(await send.handler({ text: '我在。' }, toolCtx));
    expect(withPeer).toContain('1 connection online');
    expect(withPeer).toContain('小北');
    // 第二条起要带上一条隔了多久、此后终端上有没有人说过话
    expect(withPeer).toMatch(/went out \d+ minutes? ago/);
    expect(withPeer).toContain('nobody has said anything');

    sock.feed(JSON.stringify({ type: 'msg', text: '在的' }));
    const afterReply = String(await send.handler({ text: '好' }, toolCtx));
    expect(afterReply).toContain('1 message from people');
    await mod.stop();
  });

  it('两条流互相看得见:一个人说话,另一条流上的人收得到', async () => {
    const host = new FakeHost();
    const mod = new TerminalWorld({ timezone: 'Asia/Shanghai' });
    await mod.start(host);
    // 扇出归 World 自己管:框架一条连接只调一次 stream(),不广播也不去重
    const a = new FakeStream();
    const b = new FakeStream();
    mod.stream('chat', a);
    mod.stream('chat', b);
    a.feed(JSON.stringify({ type: 'hello', name: '阿明' }));
    b.feed(JSON.stringify({ type: 'hello', name: '小北' }));
    expect(a.frames().some((f) => String(f.text).includes('小北 进入了对话'))).toBe(true);

    a.feed(JSON.stringify({ type: 'msg', text: '在吗' }));
    await settle();
    expect(b.frames().at(-1)).toMatchObject({ type: 'msg', from: '阿明', text: '在吗' });
    expect(mod.onlineCount()).toBe(2);

    await mod.stop();
    // stop 把在连的流都关掉
    expect(a.open).toBe(false);
    expect(b.open).toBe(false);
    expect(mod.onlineCount()).toBe(0);
  });

  it('hello 后回放最近历史,history 标记带上', async () => {
    const host = new FakeHost();
    const mod = new TerminalWorld({ timezone: 'Asia/Shanghai', botName: 'Yukima' });
    await mod.start(host);
    host.store.append({
      type: 'terminal.message', ts: '2026-08-12T10:00:00+08:00', source: 'terminal', origin: 'external',
      text: '[10:00] 阿明: 昨天那事', senderKey: '阿明', meta: { from: '阿明', body: '昨天那事' },
    });

    const sock = new FakeStream();
    mod.stream('chat', sock);
    sock.feed(JSON.stringify({ type: 'hello', name: '阿明' }));
    expect(sock.frames().some((f) => f.history === true && f.text === '昨天那事')).toBe(true);

    await mod.stop();
  });
});

// ── 1b. 图片 ───────────────────────────────────────────────────────────

describe('终端消息附图', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6]);

  const connect = async (host: FakeHost): Promise<{ mod: TerminalWorld; sock: FakeStream }> => {
    const mod = new TerminalWorld({ timezone: 'Asia/Shanghai' });
    await mod.start(host);
    const sock = new FakeStream();
    mod.stream('chat', sock);
    sock.feed(JSON.stringify({ type: 'hello', name: '阿明' }));
    return { mod, sock };
  };

  it('图片随事件落库,正文接每张的文本形态,回显只带句柄;模型不吃图时给发送者一句提示', async () => {
    const host = new FakeHost();
    const { mod, sock } = await connect(host);
    sock.feed(JSON.stringify({
      type: 'msg', text: '看看这个',
      images: [
        { mime: 'image/png', base64: PNG.toString('base64'), name: 'shot.png' },
        { mime: 'image/jpeg', base64: JPG.toString('base64') },
      ],
    }));
    await settle();
    const msg = host.pushed.find((p) => p.e.type === 'terminal.message')!;
    expect(msg.e.blobs).toHaveLength(2);
    expect(msg.e.blobs!.map((m) => m.mime)).toEqual(['image/png', 'image/jpeg']);
    // 字节真的进了库:句柄能读回同一份
    expect(Buffer.from(host.blob(msg.e.blobs![0].handle)!.bytes).equals(PNG)).toBe(true);
    // 正文后每张一行 [blob 句柄 mime 名字] 文本形态,与模型吃不吃图无关
    const [h1, h2] = msg.e.blobs!.map((b) => b.handle);
    expect(msg.e.text).toBe(`${msg.e.text.split('\n')[0]}\n[blob ${h1} image/png shot.png] image 1/2 from 阿明\n[blob ${h2} image/jpeg] image 2/2 from 阿明`);
    expect(msg.e.text.split('\n')[0]).toMatch(/^\[\d{2}:\d{2}\] 阿明: 看看这个$/);
    expect(msg.e.blobs![0].fallbackText).toBe('image 1/2 from 阿明');
    // 回显与回放素材只带句柄,不带字节
    const echo = sock.frames().find((f) => f.type === 'msg')!;
    expect(echo.text).toBe('看看这个');
    expect(echo.images).toEqual([
      { ref: h1, mime: 'image/png', name: 'shot.png' },
      { ref: h2, mime: 'image/jpeg' },
    ]);
    expect(JSON.stringify(echo)).not.toContain(PNG.toString('base64'));
    // 发送者本人另收一句系统提示
    expect(sock.frames().some((f) => f.type === 'sys' && String(f.text).includes('不接收图像'))).toBe(true);
    await mod.stop();
  });

  it('模型接受图像时不另提示;只有图没有字也能发', async () => {
    const host = new FakeHost();
    host.modelFacts = { ...host.modelFacts, accepts: (mime: string) => mime.startsWith('image/') };
    const { mod, sock } = await connect(host);
    sock.feed(JSON.stringify({ type: 'msg', text: '', images: [{ mime: 'image/png', base64: PNG.toString('base64') }] }));
    await settle();
    const msg = host.pushed.find((p) => p.e.type === 'terminal.message')!;
    expect(msg.e.text).toMatch(/^\[\d{2}:\d{2}\] 阿明: \n\[blob log:\S+ image\/png\] image 1\/1 from 阿明$/);
    expect(msg.e.origin).toBe('internal');
    expect(msg.opts?.trigger).toBe('flush');
    expect(sock.frames().some((f) => f.type === 'sys' && String(f.text).includes('不接收图像'))).toBe(false);
    await mod.stop();
  });

  it('不支持的格式、超过张数上限:整条拒收,不落库不投递,给发送者一句理由', async () => {
    const host = new FakeHost();
    const { mod, sock } = await connect(host);
    sock.feed(JSON.stringify({ type: 'msg', text: 'x', images: [{ mime: 'image/svg+xml', base64: 'PHN2Zz4=' }] }));
    sock.feed(JSON.stringify({
      type: 'msg', text: 'y',
      images: Array.from({ length: 9 }, () => ({ mime: 'image/png', base64: PNG.toString('base64') })),
    }));
    expect(host.pushed.filter((p) => p.e.type === 'terminal.message')).toHaveLength(0);
    const refusals = sock.frames().filter((f) => f.type === 'sys' && String(f.text).startsWith('图片未发送'));
    expect(refusals.map((f) => f.text)).toEqual([
      '图片未发送: 不支持的图片格式: image/svg+xml',
      '图片未发送: 一条消息最多 8 张图',
    ]);
    await mod.stop();
  });

  it('hello 回放从落库的 blobs 取图片句柄一并带回', async () => {
    const host = new FakeHost();
    const handle = host.putBlob(PNG, 'image/png');
    host.store.append({
      type: 'terminal.message', ts: '2026-08-12T10:00:00+08:00', source: 'terminal', origin: 'internal',
      text: `[10:00] 阿明: 昨天那张\n[blob ${handle} image/png a.png] 阿明 发来的图片 1/1`, senderKey: '阿明',
      meta: { from: '阿明', body: '昨天那张' },
      blobs: [{ handle, mime: 'image/png', name: 'a.png', fallbackText: '阿明 发来的图片 1/1' }],
    });
    const { mod, sock } = await connect(host);
    const replay = sock.frames().find((f) => f.history === true)!;
    expect(replay.text).toBe('昨天那张');
    expect(replay.images).toEqual([{ ref: handle, mime: 'image/png', name: 'a.png' }]);
    await mod.stop();
  });

});


describe('协议解析', () => {
  it('一串覆盖全分支的输入:合法/非法 JSON、非对象、未 hello 先说话、未知类型', async () => {
    const host = new FakeHost();
    const mod = new TerminalWorld({ timezone: 'Asia/Shanghai' });
    await mod.start(host);
    const sock = new FakeStream();
    mod.stream('chat', sock);
    for (const line of SCRIPT) sock.feed(line);

    const frames = normFrames(sock.frames());
    const texts = frames.map((f) => String((f as { text?: unknown }).text));
    expect(texts.some((t) => t.includes('JSON'))).toBe(true);
    expect(texts.some((t) => t.includes('格式不对'))).toBe(true);
    expect(texts.some((t) => t.includes('请先发送 hello'))).toBe(true);
    expect(texts.some((t) => t.includes('名字不能为空'))).toBe(true);
    expect(texts.some((t) => t.includes('未知消息类型'))).toBe(true);
    // 只剩 message 一条;presence 不投递,空白消息与重复 hello 也不产事件
    expect(normEvents(host.pushed)).toHaveLength(1);

    await mod.stop();
  });
});

// ── 2.5 控制台通道:角色提升与口令 ──────────────────────────────────────

describe('控制台通道', () => {
  const section = (pin: string): TerminalConfigSection =>
    ({ ...TERMINAL_DEFAULTS, enabled: true, pin });

  /** 一条操作员消息,返回它落库的信封。 */
  const speak = async (
    mod: TerminalWorld,
    host: FakeHost,
    text: string,
  ): Promise<PushedRecord> => {
    const sock = new FakeStream();
    mod.stream('chat', sock);
    sock.feed(JSON.stringify({ type: 'hello', name: '操作员' }));
    sock.feed(JSON.stringify({ type: 'msg', text }));
    return host.pushed.find((p) => p.e.type === 'terminal.message')!;
  };

  it('操作员消息按 internal 投递:落进 user 区而不是工具回执区', async () => {
    const host = new FakeHost();
    const mod = new TerminalWorld({ timezone: 'Asia/Shanghai', cfg: section('') });
    await mod.start(host);
    const msg = await speak(mod, host, '把手上的事停一下');
    // loop 只按 origin 分区:internal 并进 user 消息,external 走 external_event_frame
    expect(msg.e.origin).toBe('internal');
    expect(msg.opts?.trigger).toBe('flush');
    await mod.stop();
  });

  it('配了口令:正文带标记,口令不进回显、不进回放', async () => {
    const host = new FakeHost();
    const mod = new TerminalWorld({ timezone: 'Asia/Shanghai', cfg: section('406193') });
    await mod.start(host);
    const msg = await speak(mod, host, '别念后台的话');
    expect(msg.e.text).toMatch(/^\[console\|PIN:406193\] \[\d{2}:\d{2}\] 操作员: 别念后台的话$/);
    expect(msg.e.origin).toBe('internal');
    // 前端那条对话线上不该出现口令:回显发的是原文,回放读的是 meta.body
    const echo = new FakeStream();
    mod.stream('chat', echo);
    echo.feed(JSON.stringify({ type: 'hello', name: '操作员' }));
    expect(echo.sent.join('\n')).not.toContain('406193');
    await mod.stop();
  });

  it('没配口令:正文一个字不加(不留空标记)', async () => {
    const host = new FakeHost();
    const mod = new TerminalWorld({ timezone: 'Asia/Shanghai', cfg: section('') });
    await mod.start(host);
    const msg = await speak(mod, host, '在吗');
    expect(msg.e.text).toMatch(/^\[\d{2}:\d{2}\] 操作员: 在吗$/);
    await mod.stop();
  });

  it('口令形状不对当未配置,且徽标把两种"没生效"分开说', async () => {
    const host = new FakeHost();
    const mod = new TerminalWorld({ timezone: 'Asia/Shanghai', cfg: section('40619') });
    await mod.start(host);
    const msg = await speak(mod, host, '在吗');
    expect(msg.e.text).not.toContain('PIN');
    expect(mod.console().badges).toContainEqual({ label: '口令', value: '格式不对', tone: 'off' });
    expect(new TerminalWorld({ cfg: section('') }).console().badges)
      .toContainEqual({ label: '口令', value: '未设置', tone: 'off' });
    expect(new TerminalWorld({ cfg: section('406193') }).console().badges)
      .toContainEqual({ label: '口令', value: '已启用', tone: 'on' });
    await mod.stop();
  });

  it('口令热改:改配置节的下一条消息就带新口令', async () => {
    const host = new FakeHost();
    const cfg = section('');
    const mod = new TerminalWorld({ timezone: 'Asia/Shanghai', cfg });
    await mod.start(host);
    const sock = new FakeStream();
    mod.stream('chat', sock);
    sock.feed(JSON.stringify({ type: 'hello', name: '操作员' }));
    sock.feed(JSON.stringify({ type: 'msg', text: '一' }));
    cfg.pin = '406193'; // 控制台写配置就是就地写这个对象
    sock.feed(JSON.stringify({ type: 'msg', text: '二' }));
    const texts = host.pushed.filter((p) => p.e.type === 'terminal.message').map((p) => p.e.text);
    expect(texts[0]).not.toContain('PIN');
    expect(texts[1]).toContain('[console|PIN:406193]');
    await mod.stop();
  });

  it('她自己的回录不带口令标记(自己说的话不是控制台指示)', async () => {
    const host = new FakeHost();
    const mod = new TerminalWorld({ timezone: 'Asia/Shanghai', botName: '可缇', cfg: section('406193') });
    await mod.start(host);
    const send = mod.tools().find((t) => t.name === 'terminal_send')!;
    await send.handler({ text: '好' }, toolCtx);
    const self = host.pushed.find((p) => p.e.type === 'terminal.self')!;
    expect(self.e.text).not.toContain('406193');
    await mod.stop();
  });

  it('生效中的口令经模板变量进前缀;没配时模板的缺省文案接管', async () => {
    const live = await renderWorldEnvPrompt(new TerminalWorld({ cfg: section('406193') }));
    expect(new TerminalWorld({ cfg: section('406193') }).envPromptVars())
      .toEqual({ 'terminal.pin': '406193' });
    expect(live.text).toContain('406193');

    const off = new TerminalWorld({ cfg: section('40619x') });
    expect(off.envPromptVars()).toEqual({ 'terminal.pin': '' });
    const text = (await renderWorldEnvPrompt(off)).text;
    expect(text).not.toContain('40619');
    expect(text).not.toMatch(/\{\{/);
  });
});

// ── 3. 控制台贡献 ──────────────────────────────────────────────────────

describe('控制台贡献', () => {
  it('这一页不声明面板:对话只在终端页;流的通道名 chat 是局部 id(不带 World 名前缀)', () => {
    const mod = new TerminalWorld();
    const decl = mod.console();
    expect(decl.panels).toBeUndefined();
    expect(decl.invoke).toBeUndefined();
    expect(typeof decl.stream).toBe('function');
    expect(isPanelId('chat')).toBe(true);
  });

  it('在线人数徽标随连接变化', async () => {
    const host = new FakeHost();
    const mod = new TerminalWorld();
    await mod.start(host);
    expect(mod.console().badges![0]).toMatchObject({ label: '在线', value: '0 人', tone: 'off' });
    mod.stream('chat', new FakeStream());
    expect(mod.console().badges![0]).toMatchObject({ value: '1 人', tone: 'on' });
    await mod.stop();
  });

});

// ── 4. 按局部 id 分派 ──────────────────────────────────────────────────

describe('stream 按局部 panel id 分派', () => {
  it('未知通道抛错(旧的全局扁平 id 也在其中),已建立的连接不受影响', async () => {
    const host = new FakeHost();
    const mod = new TerminalWorld();
    await mod.start(host);
    const good = new FakeStream();
    mod.stream('chat', good);

    for (const bad of ['terminal-chat', 'world:terminal', 'nosuch']) {
      const sock = new FakeStream();
      expect(() => mod.stream(bad, sock)).toThrow(/未知通道/);
      // 抛错的那条一个人都没进名单
      expect(sock.sent).toHaveLength(0);
    }
    expect(mod.onlineCount()).toBe(1);
    expect(good.open).toBe(true);
    await mod.stop();
  });
});


describe('界面语言', () => {
  it('同一个实例按请求的语言报显示名与面板文案,装配层的槽位名仍是定义里的', () => {
    const mod = new TerminalWorld({ timezone: 'Asia/Shanghai' });
    expect(mod.console().label).toBe('终端对话');
    expect(mod.console('en').label).toBe('Terminal chat');
    expect(mod.console('en').promptDocs?.[0]?.title).toBe('Terminal · Environment prompt');
    expect(mod.console('en').config?.[0]?.schema.title).not.toMatch(/[一-鿿]/);
    // 控制台 provider 的显示名跟实例走;定义里的中文名只在实例没报时兜底。
    expect(ioPageContribution('terminal', '终端对话', undefined, mod, 'en').label).toBe('Terminal chat');
    expect(ioPageContribution('terminal', '终端对话', undefined, undefined, 'en').label).toBe('终端对话');
  });

  it('流上的系统提示按各自握手时的语言;给模型的口令标记与回执不随语言变', async () => {
    const host = new FakeHost();
    const mod = new TerminalWorld({ timezone: 'Asia/Shanghai', cfg: { ...TERMINAL_DEFAULTS, enabled: true, pin: '406193' } });
    await mod.start(host);
    const zh = new FakeStream();
    const en = new FakeStream();
    mod.console('zh').stream!('chat', zh);
    mod.console('en').stream!('chat', en);
    expect(String(zh.frames()[0].text)).toContain('报上名字');
    expect(String(en.frames()[0].text)).toContain('introduce yourself');
    zh.feed(JSON.stringify({ type: 'hello', name: '阿明' }));
    en.feed(JSON.stringify({ type: 'hello', name: 'Bob' }));
    // 同一件事,两条流各看各的语言
    expect(zh.frames().some((f) => f.text === 'Bob 进入了对话')).toBe(true);
    expect(en.frames().some((f) => f.text === '阿明 joined the chat')).toBe(true);

    en.feed(JSON.stringify({ type: 'msg', text: 'hi' }));
    await settle();
    const msg = host.pushed.find((p) => p.e.type === 'terminal.message')!;
    expect(msg.e.text).toMatch(/^\[console\|PIN:406193\] \[\d{2}:\d{2}\] Bob: hi$/);
    expect(() => mod.console('en').stream!('other', new FakeStream())).toThrow('Unknown channel');
    await mod.stop();
  });
});

describe('World 的 stream 经装配层适配后对框架可达', () => {
  it('ioPageContribution 转发 stream,并把局部 id 反归一化给 World', async () => {
    const host = new FakeHost();
    const mod = new TerminalWorld();
    await mod.start(host);

    const contribution = ioPageContribution('terminal', '终端对话', undefined, mod);
    expect(typeof contribution.stream).toBe('function');
    // 这一页没有自己的面板:对话只在终端页,流照旧接在 chat 通道上
    expect(contribution.panels).toBeUndefined();

    const sock = new FakeStream();
    contribution.stream!('chat', sock);
    expect(mod.onlineCount()).toBe(1);

    await mod.stop();
  });

  it('没声明 stream 的 World 不产出 stream 键(握手会被正当拒绝)', () => {
    const bare = {
      id: 'bare',
      envPromptVars: () => ({}),
      tools: () => [],
      console: () => ({ panels: [{ id: 'x', title: 'X' }] }),
      start: async () => {},
      stop: async () => {},
    };
    const contribution = ioPageContribution('bare', '裸 World', undefined, bare);
    expect(contribution.stream).toBeUndefined();
  });
});

describe('开场那颗按钮', () => {
  /** 连上、报名字，然后按下按钮。 */
  const press = async (host: FakeHost, label?: string): Promise<FakeStream> => {
    const mod = new TerminalWorld({ timezone: 'Asia/Shanghai' });
    await mod.start(host);
    const sock = new FakeStream();
    mod.stream('chat', sock);
    sock.feed(JSON.stringify({ type: 'hello', name: '控制台' }));
    sock.feed(JSON.stringify(label === undefined ? { type: 'greet' } : { type: 'greet', label }));
    await settle();
    await mod.stop();
    return sock;
  };

  it('投一条内部事件:引号里是按钮上当时的字,并报这个终端此前没人说过话', async () => {
    const host = new FakeHost();
    await press(host, '打个招呼');

    const invite = host.pushed.find((p) => p.e.type === 'terminal.invite')!;
    expect(invite.e.origin).toBe('internal');
    expect(invite.opts?.trigger).toBe('flush');
    expect(invite.e.senderKey).toBe('控制台');
    expect(invite.e.text).toContain('"打个招呼"');
    expect(invite.e.text).toContain('Nothing has been said here before');
  });

  it('这个终端上说过话以后,不再报那一句', async () => {
    const host = new FakeHost();
    const mod = new TerminalWorld({ timezone: 'Asia/Shanghai' });
    await mod.start(host);
    const sock = new FakeStream();
    mod.stream('chat', sock);
    sock.feed(JSON.stringify({ type: 'hello', name: '控制台' }));
    sock.feed(JSON.stringify({ type: 'msg', text: '在吗' }));
    await settle();
    sock.feed(JSON.stringify({ type: 'greet', label: 'Say hello' }));
    await settle();

    const invite = host.pushed.find((p) => p.e.type === 'terminal.invite')!;
    expect(invite.e.text).toContain('"Say hello"');
    expect(invite.e.text).not.toContain('Nothing has been said');
    await mod.stop();
  });

  it('没带标签的帧不投:正文里没有可引用的事实', async () => {
    const host = new FakeHost();
    await press(host);
    expect(host.pushed.some((p) => p.e.type === 'terminal.invite')).toBe(false);
  });
});
