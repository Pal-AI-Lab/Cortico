import { pick } from '../../core/language.ts';

const zh = {
  // index.ts
  navLabel: '终端',
  ctxOpenAria: '查看 token 分类',
  ctxPanelAria: 'Token 分类',
  netConnecting: '连接中…',
  netOnline: '已连接',
  netOffline: '接口不可达',
  composerLabel: '终端消息输入',
  composerPlaceholder: "输入消息…",
  composerHint: 'Terminal · Enter 发送 · 可粘贴或拖入图片',
  composerNoProvider: '当前无可用 Provider,请前往「语言模型」页设置',
  composerQueued: '终端通道正在重连，消息已排队',
  emptyConnecting: '连接调试通道中…',
  ctxTitle: (total: string, max: string | null) =>
    `上下文 ${total}${max !== null ? ` / ${max}` : ''} tok · 点击查看分类`,
  ctxWaiting: '等待上下文数据',
  sessionResetNote: 'SESSION 已截断重建',
  debugUnavailable: '调试通道不可用',
  debugNotMounted: "调试通道不可用，无法显示时间线。",

  // status.ts
  docTitle: (name: string) => `控制台 · ${name}`,
  chipDisconnected: '未连接',
  chipMsgs: ' 条',
  chipCache: '缓存 ',
  chipBatchesPre: '累计 ',
  chipBatchesPost: ' 批',
  chipPaused: '⏸ 已暂停',
  chipScheduleBlocked: '◷ 闹钟阻断',
  chipTruncating: '截断中',
  chipOnline: '在线 ',

  // fork.ts
  mainLabel: "主 session",
  forkViewing: '◉ 正在查看 ',
  forkInfo: (count: number, tok: string, ended: boolean, sec: number) =>
    ` · ${count} 条 · ~${tok} tok · ` + (ended ? '已结束（定格）' : `进行中（${sec} 秒刷新）`),
  forkBack: '⏎ 返回主 session',
  forkEmpty: '（这个 session 还没有消息）',
  forkFetchFailed: (msg: string) => `(拉取失败: ${msg})`,

  // sessions.ts
  sessionBandTitle: "Session 本次运行累计用量",
  sessionCache: (pct: string) => `缓存${pct}`,
  sessionCardTitle: (
    label: string,
    id: string,
    running: boolean,
    endedAt: string,
    prompt: number,
    completion: number,
    hit: number,
  ) =>
    `${label} (${id})\n` +
    `${running ? '进行中' : `已结束 ${endedAt}`}\n` +
    `输入 ${prompt} / 输出 ${completion} / 命中 ${hit}`,

  // timeline.ts
  thinking: '思考中…',
  jumpBottom: '↓ 回到底部',
  foldHead: (open: boolean, n: number) => `${open ? '▾' : '▸'} ${n} 字`,
  ordinalTitle: (index: number) => `session 第 ${index} 条 Item`,
  userGlyphTitle: 'user 消息',
  empty: '（空）',
  visibleReasoning: (n: number) => `可见思考 ${n} 字`,
  encryptedReasoning: (n: number) => `加密思考 ${n} 字符`,
  summary: '摘要',
  monologTitle: (phase: string) => `assistant 正文${phase ? ` · ${phase}` : ''}`,
  refusal: '拒绝',
  synthetic: '合成',
  encryptedPayload: (n: number) => `加密载荷 ${n} 字符`,
  rawItems: '原始 Item',
  firstTurnStart: '合成首轮 · 不落盘',
  firstTurnEnd: '合成首轮 · 结束',
  sessionEmpty: 'session 为空',

  // context.ts
  groupPrefix: '系统前缀',
  groupTools: '工具',
  groupDialogue: '对话',
  catOrient: 'ORIENTATION',
  catConstitution: '宪法 CONSTITUTION',
  catEnv: '环境描述 · World',
  catToolsUsage: '工具用法说明',
  catMemory: '记忆 MEMORY',
  catPrefixMisc: '前言 / 分隔 / 结构',
  catToolsSchema: '工具表 schema',
  catFirstTurn: '首轮对话（合成）',
  catReasoning: '思维链',
  catDialogue: '对话往来 · 事件',
  catToolIO: '工具调用与结果',
  ctxNone: "暂无上下文数据。",
  ctxUsage: '上下文占用',
  ctxSub: (budgetPct: string | null, keepOn: boolean) =>
    `${budgetPct === null ? '预算未知' : `占预算 ${budgetPct}`}　·　保留历史思维链：${keepOn ? '开' : '关'}`,
  toolCount: (n: number) => `　${n} 个`,
  footCountedPre: '总数以上游计数为准（上一发已数 ',
  footCountedPost: '，之后新增的本地估算）；分类按本地估算等比分摊，只看比例。',
  footEstimated: '还没有上游计数，整份按字数估算（中文≈0.6、其余≈0.3 token/字，每条 +8 结构开销）；下一发调用后以上游计数为准。',
  footSchemaB: '工具表 schema',
  footSchemaPost: ' 作为 tools 参数随每次调用发送，与消息分开计。',
  footStrippedPre: '历史思维链已丢弃约 ',
  footStrippedPost: " tok，不发送。",
  footHardPre: '越过 ',
  footHardPost: '（模型物理上限）由 core 强制交接。',
  footSoftPre: 'Persona 软阈值：',
  footSoftPost: (max: string) => `；阶段预算 ${max}。`,
};

const en: typeof zh = {
  // index.ts
  navLabel: 'Terminal',
  ctxOpenAria: 'View token breakdown',
  ctxPanelAria: 'Token breakdown',
  netConnecting: 'Connecting…',
  netOnline: 'Connected',
  netOffline: 'API unreachable',
  composerLabel: 'Terminal message input',
  composerPlaceholder: "Enter a message…",
  composerHint: 'Terminal · Enter to send · paste or drop images',
  composerNoProvider: 'No usable provider. Set one up on the Language models page.',
  composerQueued: 'Terminal channel is reconnecting; message queued',
  emptyConnecting: 'Connecting to the debug channel…',
  ctxTitle: (total: string, max: string | null) =>
    `Context ${total}${max !== null ? ` / ${max}` : ''} tok · click for breakdown`,
  ctxWaiting: 'Waiting for context data',
  sessionResetNote: 'SESSION truncated and rebuilt',
  debugUnavailable: 'Debug channel unavailable',
  debugNotMounted: "Debug channel unavailable; the timeline cannot be displayed.",

  // status.ts
  docTitle: (name: string) => `Console · ${name}`,
  chipDisconnected: 'Disconnected',
  chipMsgs: ' msgs',
  chipCache: 'cache ',
  chipBatchesPre: 'total ',
  chipBatchesPost: ' batches',
  chipPaused: '⏸ Paused',
  chipScheduleBlocked: '◷ Schedule blocked',
  chipTruncating: 'Truncating',
  chipOnline: 'online ',

  // fork.ts
  mainLabel: "Main session",
  forkViewing: '◉ Viewing ',
  forkInfo: (count: number, tok: string, ended: boolean, sec: number) =>
    ` · ${count} msgs · ~${tok} tok · ` + (ended ? 'ended (frozen)' : `running (refreshes every ${sec} s)`),
  forkBack: '⏎ Back to main session',
  forkEmpty: '(This session has no messages yet)',
  forkFetchFailed: (msg: string) => `(fetch failed: ${msg})`,

  // sessions.ts
  sessionBandTitle: "Session usage for this run",
  sessionCache: (pct: string) => `cache ${pct}`,
  sessionCardTitle: (
    label: string,
    id: string,
    running: boolean,
    endedAt: string,
    prompt: number,
    completion: number,
    hit: number,
  ) =>
    `${label} (${id})\n` +
    `${running ? 'running' : `ended ${endedAt}`}\n` +
    `input ${prompt} / output ${completion} / cache hits ${hit}`,

  // timeline.ts
  thinking: 'Thinking…',
  jumpBottom: '↓ Back to bottom',
  foldHead: (open: boolean, n: number) => `${open ? '▾' : '▸'} ${n} chars`,
  ordinalTitle: (index: number) => `Item #${index} in session`,
  userGlyphTitle: 'user message',
  empty: '(empty)',
  visibleReasoning: (n: number) => `Visible reasoning ${n} chars`,
  encryptedReasoning: (n: number) => `Encrypted reasoning ${n} chars`,
  summary: 'Summary',
  monologTitle: (phase: string) => `assistant text${phase ? ` · ${phase}` : ''}`,
  refusal: 'Refusal',
  synthetic: 'synthetic',
  encryptedPayload: (n: number) => `Encrypted payload ${n} chars`,
  rawItems: 'Raw Items',
  firstTurnStart: 'Synthetic first turn · not persisted',
  firstTurnEnd: 'Synthetic first turn · end',
  sessionEmpty: 'session is empty',

  // context.ts
  groupPrefix: 'System prefix',
  groupTools: 'Tools',
  groupDialogue: 'Conversation',
  catOrient: 'ORIENTATION',
  catConstitution: 'CONSTITUTION',
  catEnv: 'Environment · World',
  catToolsUsage: 'Tool usage notes',
  catMemory: 'MEMORY',
  catPrefixMisc: 'Preamble / separators / structure',
  catToolsSchema: 'Tool schemas',
  catFirstTurn: 'First turn (synthetic)',
  catReasoning: 'Reasoning',
  catDialogue: 'Dialogue · events',
  catToolIO: 'Tool calls and results',
  ctxNone: "No context data yet.",
  ctxUsage: 'Context usage',
  ctxSub: (budgetPct: string | null, keepOn: boolean) =>
    `${budgetPct === null ? 'Budget unknown' : `${budgetPct} of budget`} · Keep past reasoning: ${keepOn ? 'on' : 'off'}`,
  toolCount: (n: number) => ` (${n})`,
  footCountedPre: 'The total follows the upstream count (the last call counted ',
  footCountedPost: '; later additions are local estimates); categories are prorated from local estimates — read them as ratios only.',
  footEstimated: 'No upstream count yet; the whole context is estimated by characters (CJK ≈ 0.6, others ≈ 0.3 token/char, +8 structural overhead per item); the upstream count takes over after the next call.',
  footSchemaB: 'Tool schemas',
  footSchemaPost: ' are sent as the tools parameter with every call and counted separately from messages.',
  footStrippedPre: 'About ',
  footStrippedPost: " tok of past reasoning is excluded from requests.",
  footHardPre: 'Beyond ',
  footHardPost: ' (the model\'s hard limit) the core forces a handoff.',
  footSoftPre: 'Persona soft threshold: ',
  footSoftPost: (max: string) => `; stage budget ${max}.`,
};

export const S = pick({ zh, en });
