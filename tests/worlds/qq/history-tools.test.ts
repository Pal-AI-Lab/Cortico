/**
 * qq_read_history / qq_grep_history:基于FakeStore(内存EventStoreReader stub)。
 * 这里不启动OneBot/WS；协议边界由module-loop和driver测试覆盖。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlEventStore } from '../../../src/core/event-store.ts';
import { nullLogger } from '../../../src/core/util.ts';
import type { EventStoreReader, ToolCallContext, ToolDef } from '../../../src/core/types.ts';
import { createHistoryTools } from '../../../src/worlds/qq/history-tools.ts';
import { makeTmpDir } from '../../core/helpers.ts';
import { FakeHost } from './helpers.ts';

const GROUP = 424242;
const toolCtx: ToolCallContext = { role: 'main', log: nullLogger() };

let host: FakeHost;
let tools: ToolDef[];

/** 造第i条种子事件:12:00起每分钟一条 */
function seed(
  i: number,
  text: string,
  senderKey: string,
  source = 'qq',
): void {
  const mm = String(i % 60).padStart(2, '0');
  const hh = String(12 + Math.floor(i / 60)).padStart(2, '0');
  host.store.append({
    type: 'qq.message',
    ts: `2026-07-16T${hh}:${mm}:00+08:00`,
    source,
    origin: 'external',
    text: `[${hh}:${mm}] ${text}`,
    senderKey,
    meta: { message_id: 10000 + i },
  });
}

beforeEach(() => {
  host = new FakeHost();
  // 30条qq消息:#1..#30;其中#10、#25含"火锅";#5、#15来自2002
  for (let i = 1; i <= 30; i++) {
    const sender = i === 5 || i === 15 ? '2002' : '1001';
    const name = sender === '2002' ? '阿强' : '阿明';
    const body =
      i === 10 || i === 25 ? `${name}: 周末吃火锅吗(${i})` : `${name}: 消息${i}`;
    seed(i, body, sender);
  }
  // 一条其他 World 的事件(#31),验证source过滤
  seed(31, 'web: 面板消息', 'web-user', 'web');
  // 一条本 World 的内部项(#32):历史工具只回答"谁说过什么",不包含core自身的运行记录
  host.store.append({
    type: 'worlds.note',
    ts: '2026-07-16T12:40:00+08:00',
    source: 'qq',
    origin: 'internal',
    text: '[system/qq] 起草的那条已经发出去了',
  });

  tools = createHistoryTools({ source: 'qq', host: () => host, messageTs: firstTsOf(host.store) });
});

/** 与 QQ World 的消息索引同义:首条带这个号的事件的 ts。 */
function firstTsOf(store: EventStoreReader): (messageId: string) => string | undefined {
  return (messageId) => store.range({ source: 'qq' }).find((e) => String(e.meta?.message_id) === messageId)?.ts;
}

function tool(name: string) {
  const t = tools.find((item) => item.name === name);
  if (!t) throw new Error(`tool不存在: ${name}`);
  return t;
}

/** 第 i 条种子消息的平台 message_id */
const mid = (i: number): number => 10000 + i;

describe('qq_read_history', () => {
  it('无参数:最近的qq事件(默认limit=50),行里只有 World 写的正文', async () => {
    const res = (await tool('qq_read_history').handler({}, toolCtx)) as string;
    const lines = res.split('\n');
    expect(lines).toHaveLength(30); // 30条qq消息(web事件被source过滤),没有别的行
    expect(lines[0]).toBe('[12:01] 阿明: 消息1');
    expect(lines[29]).toContain('消息30');
    expect(res).not.toMatch(/^#\d+ \[12:01\]/m);
    expect(res).not.toContain('面板消息');
  });

  it('limit:从尾部取,最近优先', async () => {
    const res = (await tool('qq_read_history').handler({ limit: 5 }, toolCtx)) as string;
    const lines = res.split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('消息26');
    expect(lines[4]).toContain('消息30');
  });

  it('around:按平台message_id取邻域,before/after控制条数', async () => {
    const res = (await tool('qq_read_history').handler(
      { around: mid(15), before: 2, after: 2 },
      toolCtx,
    )) as string;
    expect(res.split('\n').map((l) => l.replace(/^\[\d\d:\d\d\] 阿[明强]: /, ''))).toEqual([
      '消息13',
      '消息14',
      '消息15',
      '消息16',
      '消息17',
    ]);
  });

  it('around 接受 #<id> 写法', async () => {
    const res = (await tool('qq_read_history').handler(
      { around: `#${mid(15)}`, before: 1, after: 0 },
      toolCtx,
    )) as string;
    expect(res.split('\n')).toHaveLength(2);
    expect(res).toContain('消息15');
  });

  it('around_time:没有消息号时按时间取邻域', async () => {
    const res = (await tool('qq_read_history').handler(
      { around_time: '2026-07-16T12:15:00+08:00', before: 1, after: 1 },
      toolCtx,
    )) as string;
    expect(res.split('\n').map((l) => l.replace(/^\[\d\d:\d\d\] 阿[明强]: /, ''))).toEqual([
      '消息14',
      '消息15',
      '消息16',
    ]);
  });

  it('around给了查不到的消息号 → 空结果,不静默退回全量', async () => {
    const res = await tool('qq_read_history').handler({ around: 424242 }, toolCtx);
    expect(res).toBe('(no matching messages)');
  });

  it('around只按QQ事件计数，不把相邻的其他 World 事件带进结果', async () => {
    const res = (await tool('qq_read_history').handler(
      { around: mid(30), before: 1, after: 1 },
      toolCtx,
    )) as string;
    expect(res.split('\n').map((l) => l.replace(/^\[\d\d:\d\d\] 阿[明强]: /, ''))).toEqual([
      '消息29',
      '消息30',
    ]);
    expect(res).not.toContain('面板消息');
  });

  it('sender过滤', async () => {
    const res = (await tool('qq_read_history').handler({ sender: '2002' }, toolCtx)) as string;
    const lines = res.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('消息5');
    expect(lines[1]).toContain('消息15');
  });

  it('时间区间过滤', async () => {
    const res = (await tool('qq_read_history').handler(
      { from_time: '2026-07-16T12:10:00+08:00', to_time: '2026-07-16T12:12:00+08:00' },
      toolCtx,
    )) as string;
    expect(res.split('\n').map((l) => l.replace(/^\[\d\d:\d\d\] 阿[明强]: /, ''))).toEqual([
      '周末吃火锅吗(10)',
      '消息11',
      '消息12',
    ]);
  });

  it('空结果 → 友好提示', async () => {
    const res = await tool('qq_read_history').handler({ sender: '9999' }, toolCtx);
    expect(res).toBe('(no matching messages)');
  });
});

describe('qq_grep_history', () => {
  it('命中带前后各3条上下文,组间---分隔', async () => {
    const res = (await tool('qq_grep_history').handler({ keyword: '火锅' }, toolCtx)) as string;
    const groups = res.split('\n---\n');
    expect(groups).toHaveLength(2);
    // 第一组:第10条命中,上下文第7..13条
    const g1 = groups[0].split('\n').map((l) => l.replace(/^\[\d\d:\d\d\] 阿[明强]: /, ''));
    expect(g1).toEqual([
      '消息7',
      '消息8',
      '消息9',
      '周末吃火锅吗(10)',
      '消息11',
      '消息12',
      '消息13',
    ]);
    // 第二组:第25条命中
    expect(groups[1]).toContain('周末吃火锅吗(25)');
    expect(groups[1]).toContain('消息22');
    expect(groups[1]).toContain('消息28');
  });

  it('limit限制命中组数', async () => {
    const res = (await tool('qq_grep_history').handler(
      { keyword: '火锅', limit: 1 },
      toolCtx,
    )) as string;
    expect(res.split('\n---\n')).toHaveLength(1);
    expect(res).toContain('周末吃火锅吗(10)');
  });

  it('命中上下文不泄漏相邻的其他 World 事件', async () => {
    const res = (await tool('qq_grep_history').handler(
      { keyword: '消息30' },
      toolCtx,
    )) as string;
    expect(res).toContain('消息30');
    expect(res).not.toContain('面板消息');
  });

  it('sender过滤 + 无命中 → 友好提示', async () => {
    const res = await tool('qq_grep_history').handler(
      { keyword: '火锅', sender: '2002' },
      toolCtx,
    );
    expect(res).toBe('(no messages containing "火锅")');
  });

  it('keyword缺失 → 参数错误', async () => {
    const res = await tool('qq_grep_history').handler({}, toolCtx);
    expect(res).toContain('bad input');
  });
});

describe('conversation 会话过滤', () => {
  beforeEach(() => {
    // 追加两条带 meta.conv 的事件:一条群、一条私聊(#32 起,原30条无conv)
    host.store.append({
      type: 'qq.message',
      ts: '2026-07-16T13:00:00+08:00',
      source: 'qq',
      origin: 'external',
      text: '[群「深夜食堂」 13:00] 阿明: 群里的话',
      senderKey: '1001',
      meta: { message_id: 20001, conv: { kind: 'group', id: GROUP } },
    });
    host.store.append({
      type: 'qq.message',
      ts: '2026-07-16T13:01:00+08:00',
      source: 'qq',
      origin: 'external',
      text: '[私聊 13:01] 老王: 私聊的话',
      senderKey: '1001',
      meta: { message_id: 20002, conv: { kind: 'private', id: 1001 } },
    });
  });

  it('qq_read_history按会话只返回该会话消息(无conv的旧事件被排除)', async () => {
    const g = (await tool('qq_read_history').handler(
      { conversation: `group:${GROUP}` },
      toolCtx,
    )) as string;
    expect(g).toContain('群里的话');
    expect(g).not.toContain('私聊的话');
    expect(g).not.toContain('消息1'); // 无conv的旧事件不算入该会话

    const p = (await tool('qq_read_history').handler(
      { conversation: 'private:1001' },
      toolCtx,
    )) as string;
    expect(p).toContain('私聊的话');
    expect(p).not.toContain('群里的话');
  });

  it('qq_grep_history按会话过滤命中及上下文，不混入相邻私聊', async () => {
    const res = (await tool('qq_grep_history').handler(
      { keyword: '群里的话', conversation: `group:${GROUP}` },
      toolCtx,
    )) as string;
    expect(res).toContain('群里的话');
    expect(res).not.toContain('私聊的话');
  });

  it('显式会话id过滤宽松:未监听的群号也可翻(无匹配则返回空,不报错)', async () => {
    const res = await tool('qq_read_history').handler(
      { conversation: 'group:999999' },
      toolCtx,
    );
    expect(res).toBe('(no matching messages)');
  });

  it('无法解析的会话名 → 参数错误', async () => {
    const res = await tool('qq_read_history').handler(
      { conversation: '并不存在的群名' },
      toolCtx,
    );
    expect(res).toContain('bad input');
  });
});

describe('真实事件库:会话消息分散在多个 run 里', () => {
  const RUNS = ['r-20260716-120000-aaaa', 'r-20260716-121300-bbbb', 'r-20260716-122500-cccc'];
  const group = { kind: 'group', id: GROUP };
  const peer = { kind: 'private', id: 1001 };
  let tmp: ReturnType<typeof makeTmpDir>;
  let runTools: ToolDef[];

  const read = async (args: Record<string, unknown>): Promise<string[]> =>
    ((await runTools.find((t) => t.name === 'qq_read_history')!.handler(args, toolCtx)) as string).split('\n');

  beforeEach(() => {
    tmp = makeTmpDir();
    // 每个 run 12 条,第 n 条在 12:n 分;n 是 4 的倍数的落在群里,其余是私聊。
    // 第二个 run 末尾另有一条给 #30020 贴表情的事件,和那条消息同号。
    let store!: JsonlEventStore;
    let n = 0;
    for (const run of RUNS) {
      store = new JsonlEventStore({ dataDir: tmp.dir, run });
      for (let i = 0; i < 12; i++) {
        n++;
        const conv = n % 4 === 0 ? group : peer;
        store.append({
          type: 'qq.message',
          ts: `2026-07-16T12:${String(n).padStart(2, '0')}:00+08:00`,
          source: 'qq',
          origin: 'external',
          text: `${conv.kind} ${n}`,
          senderKey: '1001',
          meta: { message_id: 30000 + n, conv },
        });
      }
      if (n === 24) {
        store.append({
          type: 'qq.emoji',
          ts: '2026-07-16T12:24:30+08:00',
          source: 'qq',
          origin: 'external',
          text: 'emoji on 20',
          senderKey: '1001',
          meta: { message_id: 30020, conv: group },
        });
      }
    }
    const runHost = Object.assign(new FakeHost(), { store });
    runTools = createHistoryTools({ source: 'qq', host: () => runHost, messageTs: firstTsOf(store) });
  });
  afterEach(() => tmp.cleanup());

  it('按会话读取返回该会话最新的 limit 条,跨 run 按时间升序', async () => {
    expect(await read({ conversation: `group:${GROUP}`, limit: 4 })).toEqual([
      'emoji on 20', 'group 28', 'group 32', 'group 36',
    ]);
  });

  it('按消息号读邻域:中心是消息本身,前后只数同会话的事件', async () => {
    expect(await read({ around: '#30020', conversation: `group:${GROUP}`, before: 2, after: 2 })).toEqual([
      'group 12', 'group 16', 'group 20', 'group 24', 'emoji on 20',
    ]);
  });

  it('按时间读邻域:中心是该时刻及之后同会话的第一条', async () => {
    expect(await read({ around_time: '2026-07-16T12:17:00+08:00', conversation: `group:${GROUP}`, before: 1, after: 1 })).toEqual([
      'group 16', 'group 20', 'group 24',
    ]);
  });
});
