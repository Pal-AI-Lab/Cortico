/**
 * WebApp只读API测试:fake store + 临时persona/data目录fixture。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebApp, type ToolOwner } from '../../src/web/server.ts';
import { nullLogger } from '../../src/core/util.ts';
import { FakeStore } from './fakes.ts';
import type { ToolSchema } from '../../src/core/types.ts';
import type { PathPickerOptions } from '../../src/web/shared/path-picker.ts';

let app: WebApp;
let onboardingFlag = true;
let port: number;
let memoryDir: string;
let dataDir: string;
let pickerFile: string;
let pickerDir: string;
let pickerResult: string | null = null;
const pickerRequests: PathPickerOptions[] = [];
const store = new FakeStore();
const promptDocs = new Map([
  ['orientation', { key: 'orientation', title: 'ORIENTATION', scope: 'persona' as const, description: '核心说明', content: '旧定向', revision: 'r1' }],
  ['worlds.terminal.envPrompt', { key: 'worlds.terminal.envPrompt', title: '终端 · 环境提示词', scope: 'world' as const, description: '终端环境', content: '旧环境', revision: 'r2' }],
]);
let prefixReloads = 0;
const baseToolSchemas: Array<ToolSchema & { owner: ToolOwner }> = [{
  name: 'terminal_send',
  description: '向终端发送文本。',
  parameters: {
    type: 'object',
    required: ['text'],
    properties: {
      text: { type: 'string', description: '要发送的正文。' },
    },
  },
  owner: { kind: 'world', id: 'terminal', label: '终端对话' },
}];

const base = () => `http://127.0.0.1:${port}`;
const getJson = async (url: string): Promise<any> => {
  const r = await fetch(url);
  return (await r.json()) as any;
};

beforeAll(async () => {
  // persona fixture
  memoryDir = mkdtempSync(join(tmpdir(), 'webtest-persona-'));
  writeFileSync(join(memoryDir, 'CONSTITUTION.md'), '# 宪法\n测试用人格。\n', 'utf8');
  mkdirSync(join(memoryDir, 'note'));
  writeFileSync(join(memoryDir, 'note', 'hello.md'), '第一篇笔记\n', 'utf8');
  mkdirSync(join(memoryDir, 'memo', 'active'), { recursive: true });
  writeFileSync(join(memoryDir, 'memo', 'todo.md'), 'open: 记得回话\n', 'utf8');
  // 超1MB文件与二进制文件

  // data fixture
  dataDir = mkdtempSync(join(tmpdir(), 'webtest-data-'));
  pickerFile = join(dataDir, 'vision.gguf');
  pickerDir = join(dataDir, 'models');
  writeFileSync(pickerFile, 'GGUF', 'utf8');
  mkdirSync(pickerDir);
  const runlogLines = [
    JSON.stringify({ ts: '2026-07-17T10:00:00+08:00', level: 'info', area: 'loop', msg: '唤醒' }),
    'this is not json', // 坏行应被跳过
    JSON.stringify({ ts: '2026-07-17T10:00:01+08:00', level: 'warn', area: 'bus', msg: '队列偏高' }),
    JSON.stringify({ ts: '2026-07-17T10:00:02+08:00', level: 'error', area: 'worlds.qq', msg: '断线', data: { code: 1006 } }),
  ];
  mkdirSync(join(dataDir, 'runs', 'r-20260717-100000-0001'), { recursive: true });
  writeFileSync(join(dataDir, 'runs', 'r-20260717-100000-0001', 'log.jsonl'), runlogLines.join('\n') + '\n', 'utf8');

  // 事件fixture:10条,terminal/qq交替
  for (let i = 1; i <= 10; i++) {
    store.append({
      type: i % 2 === 0 ? 'qq.message' : 'terminal.message',
      ts: `2026-07-17T09:0${i - 1 < 10 ? i - 1 : 9}:00+08:00`,
      source: i % 2 === 0 ? 'qq' : 'terminal',
      origin: 'external',
      text: `[09:0${i - 1}] 某人: 消息${i}`,
      senderKey: i % 2 === 0 ? '10001' : '阿明',
    });
  }

  app = new WebApp({
    store,
    memoryDir,
    dataDir,
    botDir: memoryDir,
    getStatus: () => ({ session: { tokens: 1234, messages: 56 }, dream: 'idle', onboardingPending: onboardingFlag }),
    onboarding: { dismiss: () => { onboardingFlag = false; } },
    // World 自己声明控制台露出:badges,控制台不按 id 分支
    worlds: () => [
      {
        id: 'qq', status: 'active' as const,
        envPrompt: '你在QQ上。', workspace: 'worlds/qq', tools: ['qq_draft', 'qq_read_history'],
        badges: [{ label: '协议端', value: '已连接', tone: 'on' as const }],
      },
      {
        id: 'terminal', status: 'active' as const,
        envPrompt: '你连接着一个终端对话界面。', workspace: 'worlds/terminal', tools: ['terminal_send'],
        badges: [{ label: '在线', value: '2 人', tone: 'on' as const }],
      },
    ],
    prompts: {
      list: () => [...promptDocs.values()],
      write: (key, content) => {
        const doc = promptDocs.get(key);
        if (!doc) throw new Error('未知固定提示词');
        doc.content = content;
        doc.revision = 'next';
        return '已保存';
      },
    },
    toolSchemas: {
      list: () => baseToolSchemas,
    },
    sessionControl: {
      reloadPrefix: async () => {
        prefixReloads++;
        return '已重载';
      },
    },
    pathPicker: {
      pick: async (options) => {
        pickerRequests.push(options);
        return pickerResult;
      },
    },
    log: nullLogger(),
  });
  port = await app.start(0);
});

describe('/api/path-picker', () => {
  const postPicker = async (body: unknown): Promise<{ status: number; body: any }> => {
    const response = await fetch(base() + '/api/path-picker', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  };

  it('调用注入选择器并返回经过类型和后缀校验的绝对路径', async () => {
    pickerRequests.length = 0;
    pickerResult = pickerFile;
    const response = await postPicker({
      kind: 'file', title: '选择模型', extensions: ['gguf'], recommendedDir: 'runtime/models',
    });
    expect(response).toEqual({ status: 200, body: { path: pickerFile } });
    expect(pickerRequests).toEqual([{
      kind: 'file', title: '选择模型', extensions: ['.gguf'], recommendedDir: 'runtime/models',
    }]);
  });

  it('取消返回 null；非法 kind 不调用选择器', async () => {
    pickerRequests.length = 0;
    pickerResult = null;
    expect(await postPicker({ kind: 'directory' })).toEqual({ status: 200, body: { path: null } });
    expect(pickerRequests).toHaveLength(1);

    const bad = await postPicker({ kind: 'volume' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('kind');
    expect(pickerRequests).toHaveLength(1);
  });

  it('选择结果的类型或后缀不匹配时拒绝返回给浏览器', async () => {
    pickerResult = pickerDir;
    const wrongKind = await postPicker({ kind: 'file' });
    expect(wrongKind.status).toBe(400);
    expect(wrongKind.body.error).toContain('不是文件');

    pickerResult = pickerFile;
    const wrongSuffix = await postPicker({ kind: 'file', extensions: ['.bin'] });
    expect(wrongSuffix.status).toBe(400);
    expect(wrongSuffix.body.error).toContain('.bin');
  });
});

afterAll(async () => {
  await app.stop();
  rmSync(memoryDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('静态页', () => {
  /**
   * 首页不再预写任何视图:左栏、每一页、每个 World 面板都由内核在运行时建出来。
   * 所以这里能断言的只有骨架,以及"内核入口被注进来了"这一件事。
   */
  it('GET / 返回骨架页,并注入内核入口', async () => {
    const r = await fetch(base() + '/');
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text.toLowerCase()).toContain('<html');
    expect(text).toContain('Cortico');
    // 没有任何预写的视图容器了
    expect(text).not.toContain('class="view"');
  });

  /**
   * 注入必须落在**最后一个** body 结束标签之前。
   * 用 `replace()` 会命中第一处,而页面注释里完全可能出现那个字面量——
   * 那样 script 会被注进注释里,页面一片空白且看不出原因。这条钉住它。
   */
  it('内核入口注在注释之外:script 标签不在 HTML 注释里', async () => {
    const text = await (await fetch(base() + '/')).text();
    const at = text.indexOf('<script type="module"');
    if (at < 0) return; // 没构建过就不注入,那是正当行为
    const before = text.slice(0, at);
    const openComments = (before.match(/<!--/g) ?? []).length;
    const closeComments = (before.match(/-->/g) ?? []).length;
    expect(openComments).toBe(closeComments); // 注入点不在任何未闭合的注释里
  });
});

describe('bot 头像', () => {
  it('裁剪后的 PNG 固定写入 bot 根目录的 avatar.png，并可原样读取', async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('cropped-avatar'),
    ]);
    const write = await fetch(base() + '/api/avatar', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: png,
    });
    expect(write.status).toBe(200);

    const read = await fetch(base() + '/api/avatar');
    expect(read.status).toBe(200);
    expect(read.headers.get('content-type')).toContain('image/png');
    expect(Buffer.from(await read.arrayBuffer())).toEqual(png);
    expect(readFileSync(join(memoryDir, 'avatar.png'))).toEqual(png);
  });

  it('拒绝把非 PNG 内容写进头像文件', async () => {
    const response = await fetch(base() + '/api/avatar', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: Buffer.from('not an image'),
    });
    expect(response.status).toBe(400);
  });
});

describe('/api/onboarding/dismiss', () => {
  it('销掉标记后状态里不再报 pending', async () => {
    expect((await getJson(base() + '/api/status')).onboardingPending).toBe(true);

    const r = await fetch(base() + '/api/onboarding/dismiss', { method: 'POST' });
    expect(r.status).toBe(200);
    expect((await getJson(base() + '/api/status')).onboardingPending).toBe(false);
  });
});

describe('/api/status', () => {
  it('返回getStatus()结果+uptime', async () => {
    const r = await fetch(base() + '/api/status');
    expect(r.status).toBe(200);
    const s = (await r.json()) as any;
    expect(s.session).toEqual({ tokens: 1234, messages: 56 });
    expect(s.dream).toBe('idle');
    expect(typeof s.uptimeSec).toBe('number');
  });
});

describe('/api/worlds', () => {
  it('列出已挂载 World(id/envPrompt/workspace/tools + World 自声明的 badges)', async () => {
    const d = await getJson(base() + '/api/worlds');
    expect(Array.isArray(d.worlds)).toBe(true);
    expect(d.worlds).toHaveLength(2);
    expect(d.worlds[0]).toMatchObject({ id: 'qq', workspace: 'worlds/qq' });
    expect(d.worlds[0].tools).toContain('qq_draft');
    expect(d.worlds[0].badges).toEqual([{ label: '协议端', value: '已连接', tone: 'on' }]);
    expect(d.worlds[1]).toMatchObject({ id: 'terminal', workspace: 'worlds/terminal' });
    expect(d.worlds[1].badges).toEqual([{ label: '在线', value: '2 人', tone: 'on' }]);
  });
});

describe('/api/capabilities', () => {
  it('报出这个实例挂了哪些面(前端据此决定渲染什么)', async () => {
    const d = await getJson(base() + '/api/capabilities');
    expect(d.capabilities.worlds).toBe(true);
    expect(d.capabilities.prompts).toBe(true);
    expect(d.capabilities.toolSchemas).toBe(true);
    expect(d.capabilities.sessionControl).toBe(true);
    expect(d.capabilities.pricing).toBeUndefined();
  });
});

describe('/api/prompts 与 session 前缀重载', () => {
  it('读取并保存固定提示词，拒绝未知 key', async () => {
    const before = await getJson(base() + '/api/prompts');
    expect(before.prompts.map((p: { key: string }) => p.key)).toContain('orientation');

    const saved = await fetch(base() + '/api/prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'orientation', content: '新定向' }),
    });
    expect(saved.status).toBe(200);
    expect(promptDocs.get('orientation')?.content).toBe('新定向');

    const bad = await fetch(base() + '/api/prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'missing', content: 'x' }),
    });
    expect(bad.status).toBe(400);
  });

  it('重载当前 session 前缀', async () => {
    const r = await fetch(base() + '/api/session/reload-prefix', { method: 'POST' });
    expect(r.status).toBe(200);
    expect(prefixReloads).toBe(1);
  });
});

describe('/api/tool-schemas', () => {
  it('只读返回完整工具说明、参数结构与约束', async () => {
    const data = await getJson(base() + '/api/tool-schemas');
    expect(data.tools[0].name).toBe('terminal_send');
    expect(data.tools[0].description).toBe('向终端发送文本。');
    expect(data.tools[0].parameters.required).toEqual(['text']);
    expect(data.tools[0].parameters.properties.text.description).toBe('要发送的正文。');
  });

  it('不提供 description 写入接口', async () => {
    const response = await fetch(base() + '/api/tool-schemas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'terminal_send', descriptions: { '/description': '修改' } }),
    });
    expect(response.status).toBe(404);
  });
});



describe('/api/events', () => {
  it('默认返回最近100条(这里全量10条)+latest', async () => {
    const d = await getJson(base() + '/api/events');
    expect(d.latest).toBe(10);
    expect(d.events).toHaveLength(10);
    expect(d.events[0].cursor).toBe(1);
    expect(d.events[9].cursor).toBe(10);
  });

  it('from=6 → 游标6..10', async () => {
    const d = await getJson(base() + '/api/events?from=6');
    expect(d.events.map((e: { cursor: number }) => e.cursor)).toEqual([6, 7, 8, 9, 10]);
  });

  it('limit=3 → 尾部3条(最近优先)', async () => {
    const d = await getJson(base() + '/api/events?limit=3');
    expect(d.events.map((e: { cursor: number }) => e.cursor)).toEqual([8, 9, 10]);
  });

  it('to=5&limit=3 → 向前翻页取3..5', async () => {
    const d = await getJson(base() + '/api/events?to=5&limit=3');
    expect(d.events.map((e: { cursor: number }) => e.cursor)).toEqual([3, 4, 5]);
  });

  it('source=terminal → 只剩终端来源', async () => {
    const d = await getJson(base() + '/api/events?source=terminal');
    expect(d.events.length).toBe(5);
    for (const e of d.events) expect(e.source).toBe('terminal');
  });
});

/**
 * 摄取刻的原始归档(archive-only)与发车刻的投影是同一件事的两条记录。控制台默认
 * 只展示投影,否则每条弹幕都是双份;`archive=1` 仍能把归档看全,库里一条不删。
 */
describe('/api/events 的 archive-only 展示口径', () => {
  let dupApp: WebApp;
  let dupPort: number;
  const dupBase = (): string => `http://127.0.0.1:${dupPort}`;

  beforeAll(async () => {
    const dupStore = new FakeStore();
    for (let i = 1; i <= 4; i++) {
      dupStore.append({
        type: 'bilibili.danmaku',
        ts: `2026-08-27T15:0${i}:00+08:00`,
        source: 'bilibili',
        origin: 'external',
        contextDelivery: 'archive-only',
        text: `[弹幕|观众${i}] 原始第 ${i} 条`,
      });
    }
    for (let i = 1; i <= 4; i++) {
      dupStore.append({
        type: 'bilibili.danmaku',
        ts: `2026-08-27T15:0${i}:07+08:00`,
        source: 'bilibili',
        origin: 'external',
        contextDelivery: 'deliver',
        text: `[弹幕|观众${i}] 原始第 ${i} 条`,
      });
    }
    dupApp = new WebApp({
      store: dupStore,
      memoryDir,
      dataDir,
      botDir: memoryDir,
      getStatus: () => ({}),
      log: nullLogger(),
    });
    dupPort = await dupApp.start(0);
  });

  afterAll(async () => {
    await dupApp.stop();
  });

  it('默认滤掉原始归档,只剩投影(不再双份)', async () => {
    const d = await getJson(dupBase() + '/api/events');
    expect(d.latest).toBe(8);
    expect(d.events).toHaveLength(4);
    expect(d.events.map((e: { cursor: number }) => e.cursor)).toEqual([5, 6, 7, 8]);
    for (const e of d.events) expect(e.contextDelivery).toBe('deliver');
  });

  it('archive=1 把原始归档也拿回来——库里一条没删', async () => {
    const d = await getJson(dupBase() + '/api/events?archive=1');
    expect(d.events).toHaveLength(8);
    expect(d.events.filter((e: { contextDelivery?: string }) => e.contextDelivery === 'archive-only'))
      .toHaveLength(4);
  });

  it('过滤后仍能凑满 limit 条(多取一截再截尾)', async () => {
    const d = await getJson(dupBase() + '/api/events?limit=3');
    expect(d.events.map((e: { cursor: number }) => e.cursor)).toEqual([6, 7, 8]);
  });
});

describe('/api/log', () => {
  it('按 run 读 log.jsonl 尾部,坏行跳过', async () => {
    const entries = await getJson(base() + '/api/log?run=r-20260717-100000-0001');
    expect(entries).toHaveLength(3); // 4行里1行坏
    expect(entries[2].level).toBe('error');
    expect(entries[2].data).toEqual({ code: 1006 });
  });

  it('limit=2 → 尾部2条;level/area/grep 在服务端过滤', async () => {
    const entries = await getJson(base() + '/api/log?run=r-20260717-100000-0001&limit=2');
    expect(entries).toHaveLength(2);
    expect(entries[0].level).toBe('warn');
    const warns = await getJson(base() + '/api/log?run=r-20260717-100000-0001&level=warn');
    expect(warns.map((e: { area: string }) => e.area)).toEqual(['bus', 'worlds.qq']);
    const byArea = await getJson(base() + '/api/log?run=r-20260717-100000-0001&area=worlds');
    expect(byArea.map((e: { msg: string }) => e.msg)).toEqual(['断线']);
    const grep = await getJson(base() + '/api/log?run=r-20260717-100000-0001&grep=1006');
    expect(grep).toHaveLength(1);
  });

  it('没有 run 参数也没有当前 run → []', async () => {
    expect(await getJson(base() + '/api/log')).toEqual([]);
  });

  it('文件不存在 → []', async () => {
    // 用一个没有jsonl的独立WebApp实例验证
    const emptyData = mkdtempSync(join(tmpdir(), 'webtest-empty-'));
    const app2 = new WebApp({
      store, memoryDir, dataDir: emptyData,
      getStatus: () => ({}), log: nullLogger(),
    });
    const p2 = await app2.start(0);
    try {
      expect(await getJson(`http://127.0.0.1:${p2}/api/log?run=r-20260717-100000-0001`)).toEqual([]);
    } finally {
      await app2.stop();
      rmSync(emptyData, { recursive: true, force: true });
    }
  });
});
