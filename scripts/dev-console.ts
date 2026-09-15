import { ProviderSettings, defaultPricing } from '../src/providers/console/settings.ts';
import { ProviderRegistry } from '../src/providers/registry.ts';
import type { FixtureMessage } from '../tests/core/fixture-messages.ts';
import { fixtureRecords } from '../tests/core/fixture-messages.ts';
import { responseTimelineFixture } from '../tests/web/response-timeline-fixture.ts';
/**
 * 使用代表性固定夹具启动 WebApp，供前端开发与截图核验。
 * 不连接真实 API，不启动 core。
 *   npx tsx scripts/dev-console.ts          → http://127.0.0.1:8848/
 *   CORTICO_PORT=9000 npx tsx scripts/dev-console.ts
 *   CORTICO_DEV_MINIMAL=1 npx tsx scripts/dev-console.ts   → 只挂框架级那一套(见下方 MINIMAL)
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { loadConfig } from '../bots/corti-soulmate/assemble.ts';
import { assembleSystem, renderWorldEnvPrompt } from '../src/core/prefix.ts';
import { JsonlEventStore } from '../src/core/event-store.ts';
import { LogBlobStore, withBlobLines } from '../src/core/blobs.ts';
import type { BlobRef } from '../src/core/types.ts';
import { CortiSoulmate } from '../bots/corti-soulmate/persona/index.ts';
import { QQWorld } from '../src/worlds/qq/world.ts';
import { QQ_CONFIG_GROUP } from '../src/worlds/qq/config.ts';
import { TerminalWorld } from '../src/worlds/terminal/world.ts';
import { WebSearchWorld } from '../src/worlds/websearch/world.ts';
import type { Language } from '../src/core/language.ts';
import { WEBSEARCH_CONFIG_GROUP } from '../src/worlds/websearch/config.ts';
import { MINECRAFT_CLIENT_CONFIG_GROUP, MINECRAFT_CONFIG_GROUP, MINECRAFT_DEFAULTS, MINECRAFT_PLAYER_CONFIG_GROUP, MINECRAFT_RHYTHM_CONFIG_GROUP } from '../src/worlds/minecraft/config.ts';
import { MINECRAFT_PANEL_DECLS } from '../src/worlds/minecraft/world.ts';
import { FLAT_PRESETS, LEVEL_TYPE_LABELS } from '../src/worlds/minecraft/server-config.ts';
import { BILIBILI_CONFIG_GROUP, BILIBILI_DEFAULTS } from '../src/worlds/bilibili/config.ts';
import { BILIBILI_PANEL_DECLS } from '../src/worlds/bilibili/world.ts';
import { BUILTIN_OVERLAY_STYLES, normalizeOverlayDesign } from '../src/worlds/bilibili/overlay/model.ts';
import { OverlayAssetStore } from '../src/worlds/bilibili/overlay/assets.ts';
import { BilibiliOverlayServer, OverlayEditorConflictError } from '../src/worlds/bilibili/overlay/server.ts';
import type { AgentAnnouncementState, BilibiliOverlayDesign } from '../src/worlds/bilibili/overlay/types.ts';
import { PromptRevisionConflict, WebApp, type ExtensionInfo, type StoragePart, type ToolOwner } from '../src/web/server.ts';
import { pageIdFor } from '../src/web/shared/console-protocol.ts';
import { ioPageContribution } from '../src/bot.ts';
import { ConsoleFixtureWorld } from '../src/worlds/console-fixture/world.ts';
import { CORE_CONFIG_GROUP } from '../src/core/config.ts';
import { PERSONA_CONFIG_GROUP } from '../bots/corti-soulmate/persona/config.ts';
import { readGroupValues, setByPath, type ConfigGroup } from '../src/core/config-schema.ts';
import { WorkspaceGit, AUTHOR_SELF, AUTHOR_OPERATOR } from '../bots/cormini/persona/workspaceGit.ts';
import { aggregateUsage } from '../src/core/cost.ts';
import { nullLogger } from '../src/core/util.ts';
import type {
  World, WorldConsoleDecl, ToolSchema, ToolTag, UsageRecord,
} from '../src/core/types.ts';
import type { BotConfig } from '../bots/corti-soulmate/assemble.ts';
import type { SessionStats } from '../src/core/sessions.ts';

/** CORTICO_DEV_MINIMAL=1 仅挂载终端 World。 */
const MINIMAL = process.env.CORTICO_DEV_MINIMAL === '1';


const tmpDeploy = mkdtempSync(join(tmpdir(), 'devdeploy-'));
writeFileSync(join(tmpDeploy, 'config.json'), '{}\n', 'utf8');
const loaded = loadConfig(tmpDeploy);
const cfg = loaded.config;
const TZ = cfg.timezone;
const tmpData = mkdtempSync(join(tmpdir(), 'devweb-'));

const tmpPersona = mkdtempSync(join(tmpdir(), 'devpersona-'));
mkdirSync(join(tmpPersona, 'note'), { recursive: true });
mkdirSync(join(tmpPersona, 'people'), { recursive: true });
writeFileSync(join(tmpPersona, 'CONSTITUTION.md'), '# 宪法（示例）\n\n与世界相处的根本原则。\n第一版。\n', 'utf8');
writeFileSync(join(tmpPersona, 'WORLDVIEW.md'), '# 世界观（示例）\n\n由梦维护的长期世界模型。\n', 'utf8');
writeFileSync(join(tmpPersona, 'note', '第一篇笔记.md'), '一段示例笔记。\n', 'utf8');
writeFileSync(join(tmpPersona, 'people', '阿明.md'), '# 阿明\n\n群里常出现的人。\n', 'utf8');
const pg = new WorkspaceGit(tmpPersona);
pg.init();
writeFileSync(join(tmpPersona, 'CONSTITUTION.md'), '# 宪法（示例）\n\n与世界相处的根本原则。\n第二版：补了一条关于诚实的原则。\n', 'utf8');
pg.commitAll('本轮记忆改动', AUTHOR_SELF);
writeFileSync(join(tmpPersona, 'note', '第一篇笔记.md'), '一段示例笔记。\n控制台补了一行示例。\n', 'utf8');
pg.commitAll('控制台编辑 note/第一篇笔记.md', AUTHOR_OPERATOR);
pg.tag('里程碑-A', '第一个稳定存档点');

// 使用各模块声明的 ConfigGroup,仅修改临时部署的配置。
const devCfg = JSON.parse(JSON.stringify(cfg)) as BotConfig;

(devCfg.worlds as Record<string, unknown>).minecraft = JSON.parse(JSON.stringify(MINECRAFT_DEFAULTS));
(devCfg.worlds as Record<string, unknown>).bilibili = JSON.parse(JSON.stringify(BILIBILI_DEFAULTS));
const devConfigGroups: ConfigGroup[] = MINIMAL
  ? [CORE_CONFIG_GROUP]
  : [
      CORE_CONFIG_GROUP, PERSONA_CONFIG_GROUP, QQ_CONFIG_GROUP, WEBSEARCH_CONFIG_GROUP,
      MINECRAFT_CONFIG_GROUP, MINECRAFT_RHYTHM_CONFIG_GROUP, MINECRAFT_CLIENT_CONFIG_GROUP,
      MINECRAFT_PLAYER_CONFIG_GROUP,
      BILIBILI_CONFIG_GROUP,
    ];
function genUsage(): UsageRecord[] {
  const recs: UsageRecord[] = [];
  const roles: Array<[string, string, string]> = [
    ['main', '主意识', 'deepseek-v4-flash'], ['dream', '梦', 'deepseek-v4-pro'],
  ];
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const p2 = (n: number) => String(n).padStart(2, '0');

  const pickRole = () => roles[rnd() < 0.85 ? 0 : 1];
  const push = (day: string, hh: number, mm: number) => {
    const [role, label, model] = pickRole();
    const prompt = 8000 + Math.floor(rnd() * 6000);
    const hit = Math.floor(prompt * (0.85 + rnd() * 0.1));
    const comp = 200 + Math.floor(rnd() * 800);
    recs.push({
      ts: `${day}T${p2(hh)}:${p2(mm)}:00+08:00`,
      sessionId: role === 'main' ? 'main' : `${role}-${recs.length}`, role, label, model,
      promptTokens: prompt, completionTokens: comp, cacheHitTokens: hit, cacheMissTokens: prompt - hit,
      reasoningTokens: Math.floor(comp * 0.4),
    });
  };
// 日期按今天的 +08:00 日历日生成,覆盖分钟、周、月等聚合粒度。

  const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
  const END = new Date(`${today}T00:00:00Z`).getTime();
  for (let back = 40; back >= 0; back--) {
    const day = new Date(END - back * 86400000).toISOString().slice(0, 10);
    for (let hr = 8; hr < 24; hr++) {
      const n = Math.floor(rnd() * 4);
      for (let k = 0; k < n; k++) push(day, hr, Math.floor(rnd() * 60));
    }
  }

  for (let mm = 2; mm < 52; mm += 3) { const c = 1 + Math.floor(rnd() * 2); for (let k = 0; k < c; k++) push(today, 14, mm); }
  return recs;
}
const usageRecords = genUsage();

const qq = new QQWorld({ wsUrl: 'ws://127.0.0.1:0', groups: [424242, 998877], privates: [10086], token: '', timezone: TZ });
const terminal = new TerminalWorld({ timezone: TZ });
const websearch = new WebSearchWorld({ apiKey: loaded.secret('BRAVE_API_KEY') });
/** 使用独立 World 声明验证控制台自动发现。 */
const consoleFixture = new ConsoleFixtureWorld();
const worlds = MINIMAL ? [terminal] : [qq, terminal, websearch, consoleFixture];
const persona = new CortiSoulmate({ memoryDir: loaded.memoryDir, cfg, worlds });

const prefix = await assembleSystem({
  persona,
  worlds,
  now: new Date('2026-07-19T15:20:00+08:00'),
  timezone: TZ,
});

const store = new JsonlEventStore({ dataDir: tmpData, run: 'r-dev', log: nullLogger() });
// 终端消息与附件写入临时事件库,供回放和取图接口读取。

const devBlobs = new LogBlobStore(tmpData);
await terminal.start({
  pushEvent: async (e) => {
    const blobs: BlobRef[] | undefined = e.blobs?.map((b) => 'bytes' in b
      ? { handle: devBlobs.put(b.bytes, b.mime), mime: b.mime, ...(b.name ? { name: b.name } : {}), fallbackText: b.fallbackText }
      : { handle: b.handle, mime: 'application/octet-stream', fallbackText: b.fallbackText });
    const { blobs: _inputs, ...rest } = e;
    return store.append({ ...rest, text: withBlobLines(e.text, blobs), ...(blobs?.length ? { blobs } : {}), origin: e.origin ?? 'external' });
  },
  pushDeferred: () => {},
  store,
  drainPendingEvents: async () => [],
  modelFacts: { model: () => 'dev-model', accepts: (mime) => mime.startsWith('image/'), contextWindow: () => undefined },
  blob: (handle) => devBlobs.read(handle),
  reportUsage: () => {},
  log: nullLogger(),
});
const seed = (type: string, source: string, text: string, meta?: Record<string, unknown>) =>
  store.append({ type, ts: '2026-07-19T15:1' + (store.latestCursor() % 10) + ':00+08:00', source, origin: 'external', text, ...(meta ? { meta } : {}) });
const G1 = { kind: 'group', id: 424242 }; // 深夜茶话会
const G2 = { kind: 'group', id: 998877 }; // 学习小组
const P1 = { kind: 'private', id: 10086 }; // 老王
seed('qq.message', 'qq', '[群「深夜茶话会」 15:10] 阿明(20001): 在吗', { conv: G1, sender_name: '阿明', user_id: 20001, message_id: 101 });
seed('qq.message', 'qq', '[群「深夜茶话会」 15:11] 小李(20002): 可能在忙', { conv: G1, sender_name: '小李', user_id: 20002, message_id: 102 });
seed('qq.self', 'qq', '[群「深夜茶话会」 15:12] 你: 在的，刚看到', { conv: G1, sender_name: 'bot' });
seed('qq.message', 'qq', '[群「深夜茶话会」 15:13] 阿明(20001): 那就好，帮我记个事', { conv: G1, sender_name: '阿明', user_id: 20001, message_id: 103 });
seed('terminal.message', 'terminal', '[15:15] 访客: 你好呀，测试一下');
seed('terminal.self', 'terminal', '[15:16] 你: 你好，我在');
seed('qq.message', 'qq', '[群「学习小组」 15:18] 王工(30001): 周五的资料谁整理下', { conv: G2, sender_name: '王工', user_id: 30001, message_id: 201 });
seed('qq.message', 'qq', '[私聊 15:19] 老王(10086): 在么，问你个事', { conv: P1, sender_name: '老王', user_id: 10086, message_id: 301 });

const fixtureSession: FixtureMessage[] = [
  { role: 'system', content: prefix },
  { role: 'user', content: '[system] 2 new events arrived.' },
  {
    role: 'assistant',
    reasoning_content: '',
    content: '',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'external_event_frame', arguments: '{}' } }],
  } as FixtureMessage,
  { role: 'tool', tool_call_id: 'c1', content: '[2 new events]\n#3 [15:10] 阿明(20001): 在吗\n#4 [15:11] 小李(20002): 可能在忙' } as FixtureMessage,
  {
    role: 'assistant',
    reasoning_content: '就是阿明在叫我，回应一下，然后等他把事情说完。',
    content: '阿明找我，先应一声。',
    tool_calls: [
      { id: 'c2', type: 'function', function: { name: 'send_terminal', arguments: '{"text":"在的，刚看到，怎么啦"}' } },
    ],
  } as FixtureMessage,
  { role: 'tool', tool_call_id: 'c2', content: '[sent #5]' } as FixtureMessage,
  { role: 'assistant', content: '', reasoning_content: '' } as FixtureMessage,
];
const session = [...fixtureRecords(fixtureSession, 'dev-console'), ...responseTimelineFixture().session.slice(1)];


const worldLabels: Record<string, string> = {
  qq: 'QQ', terminal: '终端对话', websearch: 'WebSearch',
  minecraft: 'Minecraft', bilibili: 'B 站直播间',
};

const devTemplateDir = mkdtempSync(join(tmpdir(), 'cortico-dev-tpl-'));

/** 读取 World 的环境模板作为预览数据。 */
function promptDocPathOf(mod: World): string {
  const doc = mod.console?.()?.promptDocs?.find((d) => d.role === 'envPrompt');
  if (!doc) throw new Error(`${mod.id} 没有环境提示词模板`);
  return doc.path;
}
const toolOwner = new Map<string, ToolOwner>();
for (const m of worlds) {
  for (const t of m.tools()) toolOwner.set(t.name, { kind: 'world', id: m.id, label: worldLabels[m.id] ?? m.id });
}
const toolSchemas: Array<ToolSchema & { owner: ToolOwner; tags: readonly ToolTag[] }> = [
  ...persona.declareSessions()[0].tools(),
].map((t) => ({
  name: t.name,
  description: t.description,
  parameters: t.parameters,
  tags: t.tags,
  owner: toolOwner.get(t.name) ?? (t.tags.includes('flow') ? { kind: 'core' } : { kind: 'persona' }),
}));

const now = '2026-07-19T15:20:00+08:00';
const sessionsList: SessionStats[] = [
  { id: 'main', role: 'main', label: '主意识', startedAt: '2026-07-19T09:00:00+08:00', endedAt: null, calls: 42, promptTokens: 358000, completionTokens: 12400, cacheHitTokens: 322000, cacheMissTokens: 36000, reasoningTokens: 5200, cacheHitRate: 322000 / 358000, messageCount: 96 } as SessionStats,
  { id: 'dream-1', role: 'dream', label: '梦', startedAt: '2026-07-19T04:00:00+08:00', endedAt: '2026-07-19T04:06:00+08:00', calls: 8, promptTokens: 61000, completionTokens: 3400, cacheHitTokens: 40000, cacheMissTokens: 21000, reasoningTokens: 1200, cacheHitRate: 40000 / 61000, messageCount: 18 } as SessionStats,
];

const storage: StoragePart[] = [
  { key: 'events', label: '事件库(本次运行)', kind: 'disk', location: 'data/runs/r-dev/events.jsonl', danger: true, note: '清除本次运行的事件记录,保留此前记录;游标不回退', stat: () => `${store.latestCursor()}条 / 12.4KB`, clear: () => '(dev)不清除' },
  { key: 'session', label: '主session(当前对话上下文)', kind: 'disk', location: 'data/session-main.jsonl', danger: true, order: 10, note: '清除对话上下文并重新开场,保留 Memory 和事件库', stat: () => `${session.length}条 / ~90k tok`, clear: () => '(dev)不清除' },
  { key: 'runlog', label: '运行日志', kind: 'disk', location: 'data/runs/r-dev/log.jsonl', note: '运行日志不进入模型上下文', stat: () => '8.1KB', clear: () => '(dev)不清除' },
  { key: 'state', label: 'Core 状态', kind: 'disk', location: 'data/core-state.json', note: '清除 Persona 状态、交接时间和模型连续失败记录,保留投递游标与 World 可见性', stat: () => 'Persona 状态1项 / 上次交接刚刚', clear: () => '(dev)不清除' },
  { key: 'wakes', label: '定时唤醒', kind: 'disk', location: 'data/timers.json', note: '取消全部定时器,不产生通知', stat: () => '1个待触发', clear: () => '(dev)不清除' },
  { key: 'tracker', label: 'session统计(usage/缓存)', kind: 'memory', note: '清零统计,保留正在运行的 session 条目', stat: () => `${sessionsList.length}个session`, clear: () => '(dev)不清除' },
  { key: 'pending', label: '待投递事件', kind: 'memory', order: 9, note: '丢弃待投递的事件,保留事件库记录。延迟生成正文的队列项保留;已丢弃项不会在重启后补投', stat: () => '7条待投递', clear: () => '(dev)不清除' },

  { key: 'minecraft-log', label: 'World 日志(本次运行)', kind: 'disk', group: 'Minecraft World', location: 'data/runs/r-dev/log.jsonl', note: '清除本次运行的 World 日志,保留此前运行的日志', stat: () => '1594条 / 612.0KB', clear: () => '(dev)不清除' },
];

let watched = {
  groups: [{ id: 424242, enabled: true }, { id: 998877, enabled: true }, { id: 112233, enabled: false }],
  privates: [{ id: 10086, enabled: true }],
};
let paused = false;
let devDreaming = false;

const devLogT0 = Date.now() - 10_000;

/** 扫描线须包含 PNG filter 字节;colorType 为 2(RGB)或 6(RGBA)。 */
function encodePng(width: number, height: number, colorType: number, raw: Buffer): Buffer {
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (b: Buffer): number => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body), 0);
    return Buffer.concat([len, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 64×64 皮肤夹具;头部正面位于 (8,8) 至 (15,15)。 */
function devSkinPng(shirt: [number, number, number], hair: [number, number, number]): Buffer {
  const N = 64;
  const stride = N * 4 + 1;
  const raw = Buffer.alloc(stride * N);
  const put = (x: number, y: number, rgb: [number, number, number], a = 255): void => {
    const i = y * stride + 1 + x * 4;
    raw[i] = rgb[0]; raw[i + 1] = rgb[1]; raw[i + 2] = rgb[2]; raw[i + 3] = a;
  };
  const skin: [number, number, number] = [235, 195, 165];
  for (let y = 0; y < N; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < N; x++) put(x, y, shirt);
  }
  // 帽子层保持透明,以显示底层头部。
  for (let y = 0; y < 16; y++) for (let x = 32; x < 64; x++) put(x, y, shirt, 0);
  for (let y = 8; y < 16; y++) for (let x = 8; x < 16; x++) put(x, y, skin);
  for (let x = 8; x < 16; x++) { put(x, 8, hair); put(x, 9, hair); }
  put(10, 12, [40, 40, 60]); put(13, 12, [40, 40, 60]);
  put(11, 14, [170, 90, 90]); put(12, 14, [170, 90, 90]);
  return encodePng(N, N, 6, raw);
}


const devWorldVisible: Record<string, boolean> = {};
const devWorldDrift = new Set<string>();
const devPromptDocs = [
  { key: 'orientation', title: 'ORIENTATION', scope: 'persona' as const, description: 'Persona的存在方式与元认知说明。', content: persona.orientationText(), revision: 'dev-orientation-1' },
  { key: 'constitution', title: '宪法', scope: 'persona' as const, description: 'Persona的长期原则。', content: persona.constitutionText(), revision: 'dev-constitution-1' },
// 首轮对话字段按 firstTurn. 前缀识别。
  {
    key: 'firstTurn.user', title: '首轮·用户输入', scope: 'persona' as const,
    description: '合成首轮对话的 user 消息。与回复任一为空则整轮不注入。',
    content: '晚上好呀,今天过得怎么样?', revision: 'dev-ft-user-1',
  },
  {
    key: 'firstTurn.thinking', title: '首轮·思维链', scope: 'persona' as const,
    description: '合成首轮 assistant 的推理内容;为空时省略。',
    content: '普通的问候。放松地回,别端着。', revision: 'dev-ft-thinking-1',
  },
  {
    key: 'firstTurn.reply', title: '首轮·回复', scope: 'persona' as const,
    description: '合成首轮对话的 assistant 回复正文。',
    content: '晚上好——刚整理完今天的记事,你来得正好。', revision: 'dev-ft-reply-1',
  },
  {
    key: 'worlds.qq.envPrompt', title: 'QQ · 环境提示词', scope: 'world' as const,
    description: 'QQ 渠道的常驻事实。', revision: 'dev-qq-1', role: 'envPrompt' as const,
    content: '你在QQ上。\n\n下面是你正在参与的会话:\n{{qq.conversations | (还没有配置任何监听的群或私聊。)}}\n{{qq.identity | (与QQ的连接尚未建立,群名和你的账号信息暂时未知。)}}\n',
    vars: [
      { name: 'qq.conversations', description: '当前监听的群与私聊清单,每行一条。', multiline: true, value: '- 群「深夜食堂」(群号424242);你在这个群的昵称是「Yukima」' },
      { name: 'qq.identity', description: '你自己的 QQ 号;未连接时为空。', value: '你的QQ号是5000。' },
    ],
  },
  {
    key: 'persona.memory', title: '记忆', scope: 'persona' as const, revision: 'dev-memory-1',
    description: 'Memory 各层的标题、内容与空态文本。',
    content: '【MEMORY 0·地图】\nMemory 目录清单。\n{{memory.tree}}\n\n【MEMORY 4·当下】\n现在是 {{memory.now}}(时区 {{memory.timezone}})。\n',
    vars: [
      { name: 'memory.tree', description: 'persona/ 最外层目录清单。', multiline: true, value: 'persona/\n- note/\n- memo/' },
      { name: 'memory.now', description: '前缀构建时的时间,下次重建时更新。', value: '2026-08-16 17:45' },
      { name: 'memory.timezone', description: '时区名。', value: 'Asia/Shanghai' },
    ],
  },
  {
    key: 'persona.prefix', title: '前缀装配', scope: 'persona' as const, role: 'prefix' as const,
    description: '整份 system 前缀由哪几段、按什么顺序、用什么分隔线拼成。',
    revision: 'dev-prefix-1',
    content: '\n━━━ ORIENTATION ━━━\n{{persona.orientation}}\n\n━━━ 宪法 ━━━\n{{persona.constitution}}\n{{worlds.envPrompts}}\n\n━━━ Using your tools ━━━\n{{persona.toolUsage}}\n\n━━━ 记忆 ━━━\n{{memory.all}}\n',
    vars: [
      { name: 'persona.orientation', description: 'ORIENTATION.md 全文。', multiline: true },
      { name: 'persona.constitution', description: 'CONSTITUTION.md 全文。', multiline: true },
      { name: 'worlds.envPrompts', description: '各 World 的环境提示词,按 World id 序。', multiline: true },
      { name: 'persona.toolUsage', description: '代码生成的工具说明。', multiline: true },
      { name: 'memory.all', description: 'MEMORY 0~4 整块。', multiline: true },
    ],
  },
  { key: 'worlds.terminal.envPrompt', title: '终端 · 环境提示词', scope: 'world' as const, description: '终端对话环境的常驻事实。', content: readFileSync(promptDocPathOf(terminal), 'utf8'), revision: 'dev-web-1' },
  { key: 'worlds.websearch.envPrompt', title: 'WebSearch · 环境提示词', scope: 'world' as const, description: '搜索工具 World 的可选常驻环境。', content: readFileSync(promptDocPathOf(websearch), 'utf8'), revision: 'dev-search-1' },
];

const port = Number(process.env.CORTICO_PORT || 8848);
/** 模拟 starting 到 running 的异步状态变化。 */
function devMount(
  fixed: () => Record<string, unknown>,
  derived: (phase: string) => Record<string, unknown>,
): { state(): Promise<unknown>; start(): Promise<unknown>; stop(): Promise<unknown> } {
  let phase = 'stopped';
  let readyAt = 0;
  const snap = () => {
    if (phase === 'starting' && Date.now() > readyAt) phase = 'running';
    return { phase, detail: phase === 'starting' ? '启动中(dev 假数据,几秒后就绪)' : null, pid: phase === 'stopped' ? null : 4242, ...fixed(), ...derived(phase) };
  };
  return {
    state: async () => snap(),
    start: async () => { phase = 'starting'; readyAt = Date.now() + 6_000; return snap(); },
    stop: async () => { phase = 'stopped'; return snap(); },
  };
}


const devQqNames = (): unknown => ({
  groups: [
    { id: 424242, name: '深夜茶话会', card: 'bot' },
    { id: 998877, name: '学习小组', card: '午午' },
  ],
  privates: [{ id: 10086, name: '老王' }],
});

/** dev:B站 Overlay 使用真实回环渲染器，数据与操作仍全部是假数据。 */
let devBilibiliDesign: BilibiliOverlayDesign = structuredClone(BILIBILI_DEFAULTS.overlay.design);
let devBilibiliDesignRevision = 0;
let devBilibiliMutation: Promise<void> = Promise.resolve();
function runDevBilibiliMutation<T>(operation: () => Promise<T> | T): Promise<T> {
  const result = devBilibiliMutation.then(operation);
  devBilibiliMutation = result.then(() => undefined, () => undefined);
  return result;
}
devBilibiliDesign.groups.push({
  id: 'dev-guard',
  name: '舰队观众',
  enabled: true,
  priority: 10,
  rule: { op: 'leaf', field: 'guardLevel', compare: 'gte', value: 1 },
  username: { color: '#7dd3fcff', fontWeight: 800 },
  body: { color: '#f8fafcff' },
});
devBilibiliDesign.components.push(
  {
    id: 'dev-flying-danmaku',
    name: '横向弹幕机',
    kind: 'danmaku',
    styleId: 'builtin:minimal',
    axis: 'horizontal',
    admission: 'danmaku',
    showAvatar: false,
    speed: 150,
    gap: 12,
    maxItems: 8,
    usernameMaxChars: 24,
    bodyMaxChars: 80,
    edgeFadePx: 32,
  },
  {
    id: 'dev-scroll-notice',
    name: '横向公告',
    kind: 'scroll-notice',
    styleId: 'builtin:sky',
    axis: 'horizontal',
    text: '欢迎来到演示直播间\nOverlay 数据全部来自安全夹具\n多行公告会依次停留并切换',
    speed: 90,
    gap: 100,
    lineHoldMs: 1600,
    lineTransitionMs: 420,
    edgeFadePx: 32,
  },
  {
    id: 'dev-fixed-notice',
    name: '固定公告',
    kind: 'fixed-notice',
    styleId: 'builtin:white',
    text: '今日目标：完成 Overlay 联调',
  },
);
devBilibiliDesign.placements.push(
  {
    id: 'placement-dev-flying-danmaku', componentId: 'dev-flying-danmaku',
    x: 120, y: 420, width: 1000, height: 260, z: 12, visible: true, locked: false,
  },
  {
    id: 'placement-dev-scroll-notice', componentId: 'dev-scroll-notice',
    x: 120, y: 900, width: 1680, height: 100, z: 30, visible: true, locked: false,
  },
  {
    id: 'placement-dev-fixed-notice', componentId: 'dev-fixed-notice',
    x: 120, y: 220, width: 760, height: 120, z: 18, visible: true, locked: false,
  },
);
let devBilibiliAnnouncement: AgentAnnouncementState = {
  schemaVersion: 1,
  text: '正在测试新版直播 Overlay',
  revision: 1,
  updatedAt: new Date().toISOString(),
};
const devBilibiliAssets = new OverlayAssetStore(join(tmpData, 'bilibili-overlay-assets'));
const devBilibiliOverlay: BilibiliOverlayServer = new BilibiliOverlayServer({
  preferredPort: 0,
  assets: devBilibiliAssets,
  snapshot: () => ({
    design: structuredClone(devBilibiliDesign),
    designRevision: devBilibiliDesignRevision,
    builtinStyles: structuredClone(BUILTIN_OVERLAY_STYLES),
    agentAnnouncement: { ...devBilibiliAnnouncement },
  }),
  editor: {
    state: () => devBilibiliState(),
    saveDesign: (value, baseRevision) => runDevBilibiliMutation(
      () => devBilibiliOverlayPanel.saveDesign(value, baseRevision),
    ),
    importAsset: (value) => runDevBilibiliMutation(
      () => devBilibiliOverlayPanel.importAsset(String(value ?? '')),
    ),
    deleteAsset: (value) => runDevBilibiliMutation(
      () => devBilibiliOverlayPanel.deleteAsset(String(value ?? '')),
    ),
    setAgentAnnouncement: (value, expectedRevision) => runDevBilibiliMutation(
      () => devBilibiliOverlayPanel.setAgentAnnouncement(String(value ?? ''), expectedRevision),
    ),
  },
});
if (!MINIMAL) await devBilibiliOverlay.start(nullLogger());
const DEV_BILIBILI_OVERLAY_URL = MINIMAL ? null : devBilibiliOverlay.overlayUrl;

function devBilibiliState(): Record<string, unknown> {
  return {
    design: structuredClone(devBilibiliDesign),
    designRevision: devBilibiliDesignRevision,
    builtinStyles: structuredClone(BUILTIN_OVERLAY_STYLES),
    agentAnnouncement: { ...devBilibiliAnnouncement },
    maxAnnouncementChars: BILIBILI_DEFAULTS.overlay.agentNoticeMaxChars,
    assets: devBilibiliAssets.list(DEV_BILIBILI_OVERLAY_URL ? devBilibiliOverlay.baseUrl : null),
    url: DEV_BILIBILI_OVERLAY_URL,
    streamUp: !MINIMAL,
    error: null,
  };
}

const devBilibiliOverlayPanel = {
  state: () => devBilibiliState(),
  saveDesign: (value: unknown, baseRevision: unknown) => {
    if (!Number.isInteger(baseRevision) || Number(baseRevision) !== devBilibiliDesignRevision) {
      throw new OverlayEditorConflictError('Overlay 设计已被其他编辑会话更新');
    }
    devBilibiliDesign = normalizeOverlayDesign(value);
    devBilibiliDesignRevision += 1;
    devBilibiliOverlay.emitState();
    return { ...devBilibiliState(), message: 'Overlay 设计已保存并热更新 (dev,不真落盘)' };
  },
  importAsset: (base64: string): Record<string, unknown> => ({
    asset: devBilibiliAssets.import(base64),
    assets: devBilibiliAssets.list(devBilibiliOverlay.baseUrl),
  }),
  deleteAsset: (id: string) => ({
    deleted: devBilibiliAssets.delete(id),
    assets: devBilibiliAssets.list(devBilibiliOverlay.baseUrl),
  }),
  setAgentAnnouncement: (text: string, expectedRevision: unknown) => {
    if (!Number.isInteger(expectedRevision) || Number(expectedRevision) !== devBilibiliAnnouncement.revision) {
      throw new OverlayEditorConflictError('Agent 公告已被其他写入者更新');
    }
    const normalized = text.replace(/\r\n?/g, '\n');
    const chars = Array.from(normalized);
    const limit = BILIBILI_DEFAULTS.overlay.agentNoticeMaxChars;
    if (chars.length > limit) throw new Error(`公告最多 ${limit} 字，当前 ${chars.length} 字`);
    devBilibiliAnnouncement = {
      schemaVersion: 1,
      text: chars.join(''),
      revision: devBilibiliAnnouncement.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    devBilibiliOverlay.emitAnnouncement(devBilibiliAnnouncement);
    return { ...devBilibiliAnnouncement };
  },
};

/** 按 World id、面板局部 id、方法名组织假数据,返回最终接口响应形状。 */
const devPanels: Record<string, Record<string, Record<string, (...args: never[]) => unknown>>> = {
  qq: {
    roster: {
      names: devQqNames,
      get: () => watched,
      set: (groups: Array<{ id: number; enabled: boolean }>, privates: Array<{ id: number; enabled: boolean }>) => {
        watched = { groups, privates };
        const gOn = groups.filter((e) => e.enabled).length;
        const pOn = privates.filter((e) => e.enabled).length;
        return {
          ok: true,
          result: `监听名单已更新:群${groups.length}个(启用${gOn})、私聊${privates.length}个(启用${pOn}) (dev)`,
          config: watched,
        };
      },
    },
    gate: {
      state: () => ({
        enabled: true,
        wsUrl: 'ws://127.0.0.1:3001',
        tokenSet: false,
        connected: true,
        selfId: 88886666,
        nickname: 'bot',
        groups: [
          { id: 424242, name: '深夜茶话会', card: 'bot' },
          { id: 998877, name: '学习小组', card: '午午' },
        ],
        privates: [{ id: 10086, name: '老王' }],
      }),
      setEnabled: (enabled: boolean) => ({ ok: true, restarting: true, enabled }), // dev:不真重启
      setConnection: () => ({ ok: true, restarting: true }), // dev:不真重启
    },
    events: {
      names: devQqNames,
      list: (opts?: { conv?: string; limit?: number }) => devQqEvents(opts),
    },
  } as never,
  bilibili: {

    log: {
      state: () => ({
        status: {
          phase: 'connected', roomId: 42, realRoomId: 12345678,
          title: '演示直播间', living: true, selfUid: 87654321, lastError: null,
        },
        desensitized: false,
        aggregate: { enter: 7, like: 23, freeGift: 2, watched: 288429, online: 41, popularity: 1520, fans: 3187, likeTotal: 9042 },
        recent: [
          '[上舰|夜行的猫] 开通了舰长',
          '[SC|30元|阿明] 那个洞里有铁矿,往左挖',
          '[礼物|阿明] 送出 小花花 ×1',
          '[弹幕|夜行的猫] 别站在岩浆边上啊',
          '[弹幕|阿明] 在吗',
        ],
        total: 137,
        counts: [
          ['DANMU_MSG', 96], ['INTERACT_WORD_V2', 21], ['LIKE_INFO_V3_CLICK', 11],
          ['SEND_GIFT', 5], ['WATCHED_CHANGE', 3], ['SUPER_CHAT_MESSAGE', 1],
          ['GUARD_BUY', 1], ['SOME_NEW_CMD_2030', 1],
        ],
      }),
    },
  },
  minecraft: {
    log: {
      // 日志夹具覆盖类别过滤与任务号关联。
      entries: (after = 0) => {
        const rows: Array<[string, string, string, number | undefined]> = [
          ['tool', 'mc_do', 'mc_do → 已开始任务#1「采集 3 个橡木原木;合成 1 个木镐」', undefined],
          ['task', 'enqueue', '排进任务#2「去「工作台」」(前面还有 1 件)', 2],
          ['task', 'start', '开始任务#1「采集 3 个橡木原木;合成 1 个木镐」', 1],
          ['skill', 'begin', '第 1 步 采集 3 个橡木原木', 1],
          ['skill', 'done', '采集 3 个橡木原木: 挖了 3 块橡木原木,实际入包 3 个', 1],
          ['craft', 'plan', '合成 1 个木镐:3 步(附近没有工作台,要自己带一个)', 1],
          ['skill', 'place-vanished', '工作台放置没报错,回读 (5, 72, 24) 还是空气', 1],
          ['craft', 'table-fail', '工作台放置调用完成后,回读目标位置仍为空气', 1],
          ['landmark', 'resolve', '「工作台」→ 工作台 (-32, 64, 70),另有 2 条同名的没选', undefined],
          ['event', 'minecraft.task', '[执行器] 任务#1「去「工作台」」受阻于 走不过去: 路线算不出来', 1],
          ['reflex', 'drown-noland', '附近找不到能上去的岸,只能继续上浮换气', undefined],
        ];
        const entries = [];
        for (let seq = after + 1; seq <= rows.length; seq++) {
          const [lane, event, msg, taskId] = rows[seq - 1];
          entries.push({
            seq, lane, event, msg, taskId,
            ts: new Date(devLogT0 + seq * 2500).toISOString(),
            ...(lane === 'skill' && event === 'done' ? { durMs: 8420 } : {}),
          });
        }
        return { entries };
      },
    },
      // 面板方法的链路前缀与 MinecraftWorld.invokePanel 一致。

    server: devMount(
      () => ({ address: '127.0.0.1:25565', serverDir: 'C:\\mc\\server', configured: true }),
      (phase) => ({ reachable: phase === 'running' }),
    ),
    client: devMount(
      () => ({
        enabled: true, gameDir: 'C:\\mc\\.minecraft', versionId: '1.20.1-fabric-iris',
        username: 'CortiCam', configured: true, command: 'java -Xmx4G ... net.minecraft.client.main.Main',
      }),
      (phase) => ({ windowReady: phase === 'running' }),
    ),
    player: (() => {
      const lane = devMount(
        () => ({
          enabled: false, gameDir: 'C:\\mc\\.minecraft', versionId: '1.20.1-fabric-iris',
          username: 'Player', configured: true, command: 'java -Xmx4G ... net.minecraft.client.main.Main',
        }),
        (phase) => ({ windowReady: phase === 'running' }),
      );
      return {
        ...lane,
        teleport: async () => ({
          ...(await lane.state() as Record<string, unknown>),
          detail: '已把 Player 传送到 CortiV 旁边(dev)',
        }),
      };
    })(),

    skin: (() => {
      const picked = new Map<string, { bytes: Buffer; at: string }>([
        ['bot', { bytes: devSkinPng([86, 116, 196], [64, 48, 72]), at: new Date(devLogT0).toISOString() }],
      ]);

      const sizeOf = (b: Buffer): { width: number; height: number } | null =>
        b.length >= 24 && b[0] === 0x89 && b[1] === 0x50
          ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
          : null;
      const gameDir = 'C:\mc\.minecraft';
      const account: Record<string, string> = { bot: 'CortiV', player: 'Phant' };
      const state = (detail: string | null = null) => ({
        roles: (['bot', 'player'] as const).map((role) => {
          const cur = picked.get(role);
          return {
            role,
            username: account[role],
            skin: cur ? { ...sizeOf(cur.bytes)!, bytes: cur.bytes.length, at: cur.at } : null,
            installed: { camera: Boolean(cur), player: Boolean(cur) },
          };
        }),
        dirs: { camera: gameDir, player: gameDir },
        mod: { camera: true, player: true },
        live: { camera: true, player: false },
        detail,
      });
      const asRole = (role: string): string => {
        if (role !== 'bot' && role !== 'player') throw new Error(`没有这个角色: ${role}`);
        return role;
      };
      return {
        state: async () => state(),
        set: async (role: string, base64: string) => {
          const bytes = Buffer.from(base64, 'base64');
          const size = sizeOf(bytes);
          if (!size) throw new Error('不是 PNG 图片');
          if (size.width !== 64 || (size.height !== 64 && size.height !== 32)) {
            throw new Error(`皮肤材质得是 64x64(或 1.8 之前的 64x32),这张是 ${size.width}x${size.height}`);
          }
          picked.set(asRole(role), { bytes, at: new Date().toISOString() });
          return state('皮肤已保存,摄像机重新连接后生效 (dev)');
        },
        clear: async (role: string) => {
          const had = picked.delete(asRole(role));
          return state(had ? '已移除自定义皮肤 (dev)' : '本来就没选');
        },
        file: async (role: string) => {
          const cur = picked.get(asRole(role));
          if (!cur) throw new Error('这个角色还没选皮肤');
          return { $binary: { mime: 'image/png', base64: cur.bytes.toString('base64') } };
        },
      };
    })(),
    world: (() => {
      const settings = {
        gamemode: 'survival', difficulty: 'easy', hardcore: false, pvp: true,
        spawnMonsters: true, levelSeed: '', levelName: 'world',
        levelType: 'minecraft:normal', generatorSettings: '', generateStructures: true,
        allowNether: true, spawnProtection: 16, viewDistance: 10,
        simulationDistance: 10, maxWorldSize: 29_999_984,
      };
      const day = 86_400_000;

      const known = new Map<string, { ago: number; size: number; gen: string; seed: string; ver: string }>([
        ['world', { ago: 0.2, size: 412_000_000, gen: 'normal', seed: '-8601234567890123', ver: '1.20.6' }],
        ['flat-test', { ago: 0.6, size: 7_300_000, gen: 'flat', seed: '0', ver: '1.20.6' }],
        ['old-savanna', { ago: 5, size: 1_240_000_000, gen: 'large_biomes', seed: '77123', ver: '1.20.4' }],
        ['creative-build', { ago: 12, size: 96_000_000, gen: 'flat', seed: '1', ver: '1.20.4' }],
        ['第一次试玩', { ago: 64, size: 220_000_000, gen: 'amplified', seed: '55', ver: '1.20.1' }],
      ]);
      let detail: string | null = null;
      const state = async () => ({
        configured: true, serverDir: 'C:\\mc\\server', live: false, hosted: false,
        worlds: [...known].map(([name, w]) => ({
          name,
          generated: true,
          modified: new Date(Date.now() - w.ago * day).toISOString(),
          sizeBytes: w.size,
          dimensions: w.gen === 'flat' ? [] : ['nether', 'the_end'],
          info: {
            levelName: name, lastPlayed: Date.now() - w.ago * day, seed: w.seed,
            gameType: name === 'creative-build' ? 1 : 0, difficulty: 2, hardcore: false,
            version: w.ver, generator: w.gen, dayTime: 24_000 * (30 - w.ago),
          },
        })).concat(known.has(settings.levelName) ? [] : [{
          name: settings.levelName, generated: false, modified: null as never,
          sizeBytes: 0, dimensions: [], info: null as never,
        }]),
        settings: { ...settings },
        flatPresets: FLAT_PRESETS,
        levelTypes: LEVEL_TYPE_LABELS,
        detail,
      });
      return {
        state,
        select: async (name: string) => { settings.levelName = name; detail = `下次启动进「${name}」(dev)`; return state(); },
        create: async (name: string, gen: Record<string, unknown>) => {
          settings.levelName = name;
          settings.levelSeed = String(gen.seed ?? '');
          settings.levelType = String(gen.levelType ?? 'minecraft:normal');
          settings.generatorSettings = String(gen.generatorSettings ?? '');
          settings.generateStructures = gen.generateStructures !== false;
          detail = `下次启动会生成新世界「${name}」(dev)`;
          return state();
        },
        apply: async (patch: Record<string, unknown>) => {
          Object.assign(settings, patch);
          detail = '已写入 server.properties(dev,不真落盘)';
          return state();
        },
      };
    })(),
    access: (() => {
      const settings = {
        opPermissionLevel: 4, enableCommandBlock: true, allowFlight: false,
        onlineMode: false, whiteList: false,
      };

      const ops = new Map<string, number>([['CortiCam', 4], ['朋友甲', 4]]);
      const roles: Array<[string, string]> = [
        ['CortiV', 'bot'], ['CortiCam', 'camera'], ['Player', 'player'],
      ];
      let detail: string | null = null;
      const state = async () => ({
        configured: true, serverDir: 'C:\\mc\\server', live: false, hosted: false, autoOp: true,
        members: [
          ...roles.map(([name, role]) => ({
            name, role, op: ops.has(name), level: ops.get(name) ?? 0,
          })),
          ...[...ops.keys()].filter((n) => !roles.some(([r]) => r === n))
            .map((name) => ({ name, role: 'other', op: true, level: ops.get(name)! })),
        ],
        settings: { ...settings },
        detail,
      });
      return {
        state,
        setOp: async (name: string, on: boolean) => {
          if (on) ops.set(name, 4);
          else ops.delete(name);
          detail = `${on ? '已授权' : '已收回'} ${name} 的作弊权限(dev,不真落盘)`;
          return state();
        },
        apply: async (patch: Record<string, unknown>) => {
          Object.assign(settings, patch);
          detail = '已写入 server.properties(dev,不真落盘)';
          return state();
        },
      };
    })(),
  } as never,
};

function devPanelSurface(id: string): { invoke(panel: string, method: string, args: unknown[]): Promise<unknown> } | null {
  const mod = devPanels[id];
  if (!mod) return null;
  return {
    invoke: async (panel, method, args) => {
      let p = panel;
      let m = method;
      // minecraft「挂载」的方法名带链路前缀,拆法与 MinecraftWorld.invokePanel 一致
      if (id === 'minecraft' && p === 'mount') {
        const dot = m.indexOf('.');
        const lane = dot < 0 ? '' : m.slice(0, dot);
        if (!['server', 'client', 'player'].includes(lane)) {
          throw new Error(`未知面板方法: ${panel}.${method}`);
        }
        p = lane;
        m = m.slice(dot + 1);
      }
      const fn = mod[p]?.[m];
      if (typeof fn !== 'function') throw new Error(`未知面板方法: ${panel}.${method}`);
      return (fn as (...a: unknown[]) => unknown)(...args);
    },
  };
}

/** 复用 World 的面板声明,以 devPanels 提供方法结果。 */
function devFakeWorld(
  id: string,
  panels: WorldConsoleDecl['panels'],
  lamps: WorldConsoleDecl['lamps'],
  badges: WorldConsoleDecl['badges'],
  links: WorldConsoleDecl['links'],
  envPrompt: string,

  config: WorldConsoleDecl['config'] = [],
): World {
  const surface = devPanelSurface(id);

  const templatePath = join(devTemplateDir, `${id}.md`);
  writeFileSync(templatePath, envPrompt, 'utf8');
  return {
    id,
    envPromptVars: () => ({}),
    tools: () => [],
    console: () => ({
      lamps,
      badges,
      panels,
      links,
      ...(config.length ? { config } : {}),
      promptDocs: [
        {
          key: `worlds.${id}.envPrompt`,
          title: `${worldLabels[id] ?? id} · 环境提示词`,
          description: '(dev) 假模板。',
          path: templatePath,
          role: 'envPrompt' as const,
        },
      ],
      ...(surface ? { invoke: (panel, method, args) => surface.invoke(panel, method, args) } : {}),
    }),
    start: async () => { /* dev:不连任何东西 */ },
    stop: async () => { /* dev:同上 */ },
  };
}

const devMinecraftBadges: WorldConsoleDecl['badges'] = [
  { label: '服务器', value: '127.0.0.1:25565', tone: 'on' },
  { label: '任务', value: '采集 5 个 oak_log', tone: 'on' },
  { label: '画面', value: '客户端主视角', tone: 'on' },
];
const devBilibiliBadges: WorldConsoleDecl['badges'] = [
  { label: '接入', value: '已接入', tone: 'on' },
  { label: '直播间', value: '7734200 · 直播中', tone: 'on' },
  { label: '身份', value: '可认人', tone: 'on' },
  { label: 'Overlay', value: '1 个订阅', tone: 'on' },
];
const devFakeWorlds: World[] = MINIMAL ? [] : [
  devFakeWorld(
    'minecraft', [...MINECRAFT_PANEL_DECLS], [
      { label: '服务器', state: 'online', hint: '127.0.0.1:25565' },
      { label: '任务', state: 'online', hint: '采集 5 个 oak_log' },
      { label: '画面', state: 'online', hint: '客户端主视角' },
    ], devMinecraftBadges,
    [{ label: '打开画面', href: 'http://127.0.0.1:3007' }],
    '(dev) Minecraft World 的环境提示词假数据。',
    [
      MINECRAFT_CONFIG_GROUP, MINECRAFT_RHYTHM_CONFIG_GROUP, MINECRAFT_CLIENT_CONFIG_GROUP,
      MINECRAFT_PLAYER_CONFIG_GROUP,
    ],
  ),
  devFakeWorld(
    'bilibili', [...BILIBILI_PANEL_DECLS], [
      { label: '接入', state: 'online' },
      { label: '直播间', state: 'online', hint: '7734200 · 直播中' },
      { label: '身份', state: 'online', hint: '可认人' },
      { label: 'Overlay', state: 'online', hint: DEV_BILIBILI_OVERLAY_URL ?? undefined },
    ], devBilibiliBadges,
    DEV_BILIBILI_OVERLAY_URL
      ? [
          { label: '打开 Overlay 编辑器', href: devBilibiliOverlay.editorUrl, inheritTheme: true },
          { label: '打开 OBS Overlay', href: DEV_BILIBILI_OVERLAY_URL },
        ]
      : [],
    '(dev) B 站直播间的环境提示词假数据。',
    [BILIBILI_CONFIG_GROUP],
  ),
];

const devFakeWorldTools: Record<string, string[]> = {
  minecraft: ['mc_do', 'mc_queue', 'mc_check', 'mc_stop', 'mc_escape'],
  bilibili: ['bilibili_set_announcement'],
};

/** QQ 事件面板(dev):按会话分组读假事件库 */
function devQqEvents(opts?: { conv?: string; limit?: number }): unknown {
  const all = store.range({ source: 'qq' });
  const convMap = new Map<string, { kind: string; id: number; count: number; lastTs: string }>();
  for (const e of all) {
    const c = e.meta?.conv as { kind?: string; id?: number } | undefined;
    if (!c || (c.kind !== 'group' && c.kind !== 'private') || c.id === undefined) continue;
    const key = `${c.kind}:${Number(c.id)}`;
    const cur = convMap.get(key);
    if (cur) { cur.count++; cur.lastTs = e.ts; } else convMap.set(key, { kind: c.kind, id: Number(c.id), count: 1, lastTs: e.ts });
  }
  const conversations = [...convMap.values()].sort((a, b) => (a.lastTs < b.lastTs ? 1 : -1));
  const m = opts?.conv ? /^(group|private):(\d+)$/i.exec(opts.conv.trim()) : null;
  let events = all;
  if (opts?.conv && !m) events = [];
  else if (m) {
    const kind = m[1].toLowerCase();
    const id = Number(m[2]);
    events = all.filter((e) => {
      const c = e.meta?.conv as { kind?: string; id?: number } | undefined;
      return !!c && c.kind === kind && Number(c.id) === id;
    });
  }
  const limit = Math.max(1, Math.min(2000, Number(opts?.limit) || 300));
  if (events.length > limit) events = events.slice(events.length - limit);
  return {
    conversations,
    events: events.map((e) => ({
      cursor: e.cursor, type: e.type, ts: e.ts, text: e.text, senderKey: e.senderKey,
      senderName: (e.meta?.sender_name as string | undefined) ?? '', conv: e.meta?.conv ?? null,
    })),
    total: all.length,
  };
}


devCfg.providers={
 deepseek:{kind:'openai-responses-compat',baseUrl:'https://api.deepseek.com',secret:'DEEPSEEK_API_KEY',spec:{model:'deepseek-v4-pro',thinking:true,reasoningEffort:'low',temperature:1},pricing:defaultPricing()},
 openrouter:{kind:'openai-responses-compat',baseUrl:'https://openrouter.ai/api/v1',secret:'OPENROUTER_API_KEY',multimodal:true,spec:{model:'anthropic/claude-sonnet-5',thinking:true,reasoningEffort:'medium',contextWindow:200000},
  pricing:[{models:['*'],currency:'USD',basis:'marginal',source:'console',rules:[{meter:'cachedInput',perMillion:0.3},{meter:'uncachedInput',perMillion:3},{meter:'output',perMillion:15}]}]},
 custom:{kind:'openai-responses-compat',baseUrl:'http://127.0.0.1:8090/v1',spec:{model:'local',thinking:false},options:{extraBody:{service_tier:'flex'}},pricing:defaultPricing()},
 local:{kind:'llamacpp',baseUrl:'http://127.0.0.1:8090/v1',spec:{model:'ggml-org/Qwen3-8B-GGUF:Q4_K_M',thinking:true},
  options:{runtime:{release:'b10930',backend:'cuda-13.3'},launch:{contextSize:16384,nGpuLayers:99,parallel:1,extraArgs:''},autoStart:false},pricing:defaultPricing()},
 external:{kind:'llamacpp',baseUrl:'http://127.0.0.1:8080/v1',pricing:defaultPricing()},
};
devCfg.activeProvider='deepseek';
const devProvidersDir=join(tmpData,'providers');
const devProviders=new ProviderSettings(devCfg,new ProviderRegistry(()=>devCfg.providers,{stateRoot:devProvidersDir,readBlob:()=>null,keepThinking:()=>true,log:nullLogger()}),join(tmpData,'config.json'),devProvidersDir);
function devConsolePageSources(){return devProviders.sources();}

/** 扩展页的假清单(见下面 `extensions` 依赖)。kind 缺了会被归进「未识别」组。 */
const devExtensions: ExtensionInfo[] = [
  { name: '@acme/cortico-world-discord', spec: '^0.3.0', version: '0.3.1', description: 'Discord 频道接入 (dev 假数据)', kind: 'world', consoleClient: false, loaded: true, worldId: 'discord', label: 'Discord 频道', state: 'loaded' },
  { name: 'cortico-world-broken', spec: '^0.1.0', version: '0.1.4', kind: 'world', consoleClient: true, loaded: false, reason: '默认导出不是 WorldDefinition(需要 id / label / defaults() / create())。', state: 'failed' },
  { name: 'cortico-world-weather', spec: 'link:../cortico-world-weather', version: '0.0.1', kind: 'world', description: '本机开发中的天气播报 (dev 假数据)', consoleClient: false, loaded: false, state: 'pending-restart' },
];

const app = new WebApp({
  store,
  memoryDir: tmpPersona,
  dataDir: tmpData,
  botDir: tmpPersona,
  getStatus: () => ({
    loop: { estTokens: 90200, messageCount: session.length, roundsLastBatch: 3, batchesHandled: 37, paused, truncating: false, softNoticeSent: false, lastUsage: { promptTokens: 358000, cacheHitTokens: 322000, cacheMissTokens: 36000, completionTokens: 420, reasoningTokens: 180 } },
    chips: devDreaming ? [{ label: '梦中', tone: 'accent' }] : [],
    terminalOnline: terminal.onlineCount(),
    eventCount: store.latestCursor(),
    memo: { residentCap: cfg.memo.residentCap, activeCap: cfg.memo.activeCap },
    context: { maxTokens: cfg.context.maxTokens, softRatio: cfg.context.softRatio, keepPastThinking: cfg.context.keepPastThinking },
    displayName: devCfg.displayName,
    startedAt: '2026-07-19T09:00:00+08:00',
  }),
  sessions: { list: () => sessionsList, messages: (id) => (id === 'main' ? session : sessionsList.some((s) => s.id === id) ? session.slice(0, 4) : null), onChange: () => {} },
  storage: () => storage,
  usage: { aggregate: (opts) => aggregateUsage(usageRecords, opts) },

  config: {
    groups: () => [...devConfigGroups,...devProviders.groups()].map((group) => ({ group, values: group.owner.startsWith('provider:') ? devProviders.values(group.id) : readGroupValues(devCfg, group) })),
    set: (groupId, values) => {
      if(devProviders.groups().some(group=>group.id===groupId))return devProviders.setConfig(groupId,values);
      const root = devCfg as unknown as Record<string, unknown>;
      for (const [path, v] of Object.entries(values)) setByPath(root, path, v);
      return `${devConfigGroups.find((g) => g.id === groupId)?.schema.title ?? groupId}已更新 (dev,仅本次)`;
    },
  },
  // 通过 World 声明适配页面,invoke 使用假数据。
  consolePageSources: () => [...devConsolePageSources(), ...[...worlds, ...devFakeWorlds].map((m) => ({
    id: pageIdFor('world', m.id),
    contribute: (language: Language) => {
      const c = ioPageContribution(m.id, worldLabels[m.id] ?? m.id, {
        id: m.id,
        status: 'active',
        declared: true,
        workspace: `worlds/${m.id}`,
        tools: [],
        visible: devWorldVisible[m.id] !== false,
        prefixDrifted: devWorldDrift.has(m.id),
      }, m, language);
      const dev = devPanelSurface(m.id);
      if (dev) c.invoke = (panel, method, args) => dev.invoke(panel, method, args);
      return c;
    },
  }))],
  worlds: async () => [
    ...(await Promise.all([...worlds, ...devFakeWorlds].map(async (m) => {
      const decl = m.console?.();
      return {
        id: m.id,
        status: 'active' as const,
        label: worldLabels[m.id] ?? m.id,
        declared: true,
        envPrompt: (await renderWorldEnvPrompt(m)).text,
        workspace: `worlds/${m.id}`,
        tools: m.tools().map((t) => t.name).concat(devFakeWorldTools[m.id] ?? []),
        visible: devWorldVisible[m.id] !== false,
        prefixDrifted: devWorldDrift.has(m.id),
        ...(decl?.lamps ? { lamps: decl.lamps } : {}),
        ...(decl?.badges ? { badges: decl.badges } : {}),
      };
    }))),
// 模拟已安装但未激活的 World。
    {
      id: 'sandbox',
      status: 'inactive' as const,
      label: '沙盒 World',
      declared: false,
    },
    // 截图夹具覆盖Persona已声明但未安装的 World 状态。
    {
      id: 'phantom',
      status: 'missing' as const,
      label: '幻影 World',
      declared: true,
      reason: '本地没有找到 cortico-world-phantom 的实现 (dev 假数据)',
    },
  ],
  worldActivation: {
    set: async (id, enabled) => `worlds.${id}.enabled=${enabled} 已写回 config.json (dev,不真挂载)`,
    restart: async (id) => `${id} 已重启 (dev,不真重启)`,
  },
  worldVisibility: {
    state: () => ({ visibility: { ...devWorldVisible }, driftedWorlds: [...devWorldDrift] }),
    set: (id, visible) => {
      devWorldVisible[id] = visible;

      if (visible) devWorldDrift.add(id); else devWorldDrift.add(id);
      return `${id} 已${visible ? '对 agent 可见' : '对 agent 隐藏'} (dev)`;
    },
  },
  prompts: {
    list: () => devPromptDocs.map((doc) => ({ ...doc })),

    prefix: async () => [
      { title: 'ORIENTATION', text: '\n━━━ ORIENTATION ━━━\n' + persona.orientationText().trim(), sourceKey: 'orientation' },
      { title: '宪法', text: '\n\n━━━ 宪法 ━━━\n' + persona.constitutionText().trim(), sourceKey: 'constitution' },
      { title: '环境:qqWorld', text: '\n\n━━━ 环境:qqWorld ━━━\n你在QQ上。\n\n下面是你正在参与的会话:\n- 群「深夜食堂」(群号424242);你在这个群的昵称是「Yukima」\n你的QQ号是5000。', sourceKey: 'worlds.qq.envPrompt' },
      { title: 'Using your tools', text: '\n\n━━━ Using your tools ━━━\n(各工具的 usage,来自代码)', },
      { title: '记忆', text: '\n\n━━━ 记忆 ━━━\n【MEMORY 0·地图】\npersona/ 的最外层目录。…', sourceKey: 'persona.memory' },
    ],
    write: (key, content, baseRevision) => {
      const doc = devPromptDocs.find((item) => item.key === key);
      if (!doc) throw new Error(`未知提示词模板: ${key}`);
      if (baseRevision && baseRevision !== doc.revision) throw new PromptRevisionConflict(`${doc.title} 已在别处被修改，请重新载入后再保存`);
      doc.content = content; doc.revision = `dev-${Date.now()}`;
      return `已保存 ${doc.title} (dev)`;
    },
  },
  toolSchemas: {
    list: () => toolSchemas,
  },
  sessionControl: {
    reloadPrefix: async () => {
      devWorldDrift.clear();
      return '系统前缀与工具表已重载，保留当前session的既有消息 (dev)';
    },
  },
  // 扩展面的假数据:四种状态各一;装卸只改这张表,不跑 pnpm。
  extensions: {
    list: () => ({ dir: 'C:/dev/cortico/extensions', extensions: devExtensions.map((p) => ({ ...p })) }),
    search: async (q) => {
      await new Promise((r) => setTimeout(r, 300));
      return [
        { name: '@acme/cortico-world-discord', version: '0.3.1', description: 'Discord 频道接入 (dev 假数据)', publisher: 'acme', downloads: 412, links: { npm: 'https://www.npmjs.com/package/@acme/cortico-world-discord', repository: 'https://github.com/acme/cortico-world-discord' }, installed: devExtensions.some((p) => p.name === '@acme/cortico-world-discord' && p.state !== 'removed') },
        { name: 'cortico-world-rss', version: '1.0.0', description: `RSS 订阅轮询${q ? `(匹配「${q}」)` : ''} (dev 假数据)`, downloads: 38, links: { repository: 'https://github.com/example/cortico-world-rss' }, installed: false },
      ];
    },
    install: async (target) => {
      await new Promise((r) => setTimeout(r, 500));
      const name = 'name' in target ? target.name : `local-${target.path.split(/[\\/]/).filter(Boolean).pop() ?? 'module'}`;
      const spec = 'name' in target ? (target.version ?? '^1.0.0') : `link:${target.path}`;
      const existing = devExtensions.find((p) => p.name === name);
      if (existing) Object.assign(existing, { spec, state: 'pending-restart' });
      else devExtensions.push({ name, spec, version: '1.0.0', consoleClient: false, loaded: false, state: 'pending-restart' });
      return `已安装 ${name}@${spec}。重启进程后加载。\nProgress: resolved 12, reused 12, downloaded 0\n+ ${name} 1.0.0\nDone in 1.8s (dev,没真跑 pnpm)`;
    },
    uninstall: async (name) => {
      const p = devExtensions.find((item) => item.name === name);
      if (!p) throw new Error(`没有安装这个包: ${name}`);
      if (p.loaded) p.state = 'removed'; else devExtensions.splice(devExtensions.indexOf(p), 1);
      return `已卸载 ${name}。重启进程后生效。(dev)`;
    },
  },
  run: {
    pause: () => { paused = true; },
    resume: () => { paused = false; },
    isPaused: () => paused,

    restart: async () => {
      await new Promise((r) => setTimeout(r, 400));
      return {
        complete: true,
        steps: [
          { label: '暂停事件投递', ok: true, elapsedMs: 3 },
          { label: '停止 World', ok: true, elapsedMs: 1200 },
          { label: '保存 Core 状态', ok: true, elapsedMs: 5 },
        ],
      };
    },
    supervised: true,
// 返回关机报告,保留开发控制台进程。
// 模拟一个停止超时的步骤。
    shutdown: async () => {
      await new Promise((r) => setTimeout(r, 600));
      return {
        complete: false,
        steps: [
          { label: '暂停事件投递', ok: true, elapsedMs: 3 },
          { label: '停止 World', ok: true, elapsedMs: 4210 },
          { label: '托管 LLM server 停机', ok: false, elapsedMs: 3000, detail: '托管 LLM server 停机超时(3秒)' },
          { label: '保存 Core 状态', ok: true, elapsedMs: 6 },
        ],
      };
    },
  },
  debug: {
    sessionMessages: () => session,
    onSessionAppend: () => {},
    onSessionReset: () => {},
    onEvent: () => {},
    onRunlog: () => {},
    toolSchemas: () => toolSchemas,
  },
  log: nullLogger(),
});

const actual = await app.start(port);
console.log(`\n[dev-console] 假数据面板已启动: http://127.0.0.1:${actual}/`);
console.log('[dev-console] Ctrl-C 退出。数据全是假的,不连真 API/core。\n');
