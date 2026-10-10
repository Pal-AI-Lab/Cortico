/** B 站直播间接入与本机 Overlay。直播间协议仅入站；公告工具写本机公告栏，Overlay 通过回环 HTTP 服务供 OBS 读取。 */
import { mkdirSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CandidateProjector,
  ConfigGroup,
  World,
  WorldHost,
  WorldConsoleDecl,
  WorldPanelDecl,
  ShutdownExternalCheck,
  ToolDef,
} from '../../core/types.ts';
import { nowIso, SYSTEM_TIMEZONE } from '../../core/util.ts';
import {
  AudienceAdmission,
  type AudienceAdmissionCandidate,
  type AudienceAdmissionTuning,
  type ImportantAudienceParticipant,
} from './audience-admission.ts';
import { LiveClient, type LivePhase, type LiveStatus } from './client.ts';
import { CoalescingBuffer, type CoalescingGroup } from './coalescing-buffer.ts';
import { giftFrameData } from './gift-frame.ts';
import { normalize, type CountField, type GaugeField, type LiveEvent } from './normalize.ts';
import { AgentAnnouncementStore } from './overlay/announcement.ts';
import { OverlayAssetStore } from './overlay/assets.ts';
import {
  BILIBILI_OVERLAY_DEFAULTS,
  BUILTIN_OVERLAY_STYLES,
  cloneOverlayConfig,
  matchAudienceGroup,
  normalizeOverlayConfig,
  normalizeOverlayDesign,
} from './overlay/model.ts';
import { projectOverlayEvent } from './overlay/project.ts';
import { BilibiliOverlayServer, OverlayEditorConflictError } from './overlay/server.ts';
import type { BilibiliOverlayConfig, OverlayAudienceEvent } from './overlay/types.ts';
import { BILIBILI_DEFAULTS, BILIBILI_CONFIG_GROUP } from './config.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

const PANEL_LOG = 'log';

/** 开发控制台复用此面板声明。 */
export const BILIBILI_PANEL_DECLS: readonly WorldPanelDecl[] = [
  {
    id: PANEL_LOG,
    title: '直播间事件',
    description: '直播间事件与各 cmd 计数。',
  },
];

const RECENT_CAP = 200;
/** 最近弹幕的观众 uid 检查窗口。 */
const ANON_WINDOW = 20;

const COALESCE_LOG_WINDOW_MS = 60_000;
/** 延迟渲染的队列项被清除后不会复位 armedAt；超过此时限允许重新排队。 */
const ARM_STALE_MS = 300_000;

/** 名单内命令逐条采样；SEND_GIFT 另按礼物名采样，见 maybeSampleRaw。 */
const RAW_SAMPLE_DEFAULT_CMDS: readonly string[] = [
  'GUARD_BUY',
  'USER_TOAST_MSG',
  'USER_TOAST_MSG_V2',
  'SUPER_CHAT_MESSAGE',
];

const SEEN_GIFT_NAMES_CAP = 512;

const UNNAMED_GIFT_SAMPLE_CAP = 16;

/** GUARD_BUY 始终投递；同 uid、等级不冲突的后续 TOAST 在窗口内去重。 */
const GUARD_DEDUP_WINDOW_MS = 8_000;

/** WS 与轮询共用状态变化去重窗口；窗口长于轮询间隔。 */
const ROOM_EDGE_DEDUP_MS = 180_000;

/** 中断超过此窗口才告警并投递事件；每段中断只报告一次，恢复时报告持续时长。 */
const FEED_OUTAGE_MS = 60_000;

export interface BilibiliWorldOptions {
  roomId: number;
  /** 登录 cookie 的 SESSDATA;空串=匿名接入 */
  sessdata?: string;
  /** 热改：触发即时投递的礼物金额下限（元）。 */
  giftFlushYuan?: () => number;
  /** 热改:相同弹幕与常规礼物进入总线前的固定归并窗 */
  coalesceWindowMs?: () => number;
  /** 热改:归并池硬上限 */
  coalesceMaxItems?: () => number;
  audienceOnlineRankOn?: () => number;
  audienceOnlineRankOff?: () => number;
  audienceReleaseHoldSec?: () => number;
  audienceSignalFreshSec?: () => number;
  audienceActiveStaleHoldSec?: () => number;
  audienceEventLineBudget?: () => number;
  audienceEventTokenBudget?: () => number;
  audienceImportantShare?: () => number;
  /** World 私有观众准入账本；不存昵称或正文。 */
  audienceLedgerFile?: string;
  /** 原始帧 jsonl 路径；默认位于 audienceLedgerFile 上两级目录，两者都未提供时关闭采样。 */
  rawSampleFile?: string;
  overlay?: BilibiliOverlayConfig;
  onOverlayConfig?: (config: BilibiliOverlayConfig) => void | Promise<void>;
  agentNoticeMaxChars?: () => number;
  agentNoticeFile?: string;
  overlayAssetDir?: string;
  timezone?: string;
  /** 自定义直播源；默认使用 LiveClient。 */
  source?: (handlers: LiveHandlers) => LiveSource;
}

interface LiveSource {
  start(): Promise<void>;
  stop(): Promise<void>;
  current(): LiveStatus;
  /** 自定义 source 只有显式提供时才声明外部关机检查。 */
  shutdownVerification?(): readonly ShutdownExternalCheck[];
}

export interface LiveHandlers {
  onCmd(msg: Record<string, unknown>): void;
  onStatus(status: LiveStatus): void;
}

interface Aggregate {
  enter: number;
  like: number;
  freeGift: number;
  watched: number | null;
  online: number | null;
  popularity: number | null;
  fans: number | null;
  likeTotal: number | null;
}

interface PendingLiveEvent {
  item: LiveEvent;
  ts: string;
}

interface LiveCandidateValue {
  item: LiveEvent;
}

type LiveAdmissionCandidate = AudienceAdmissionCandidate<LiveCandidateValue>;

interface LiveEventParticipant {
  senderKey: string;
  uname?: string;
  count: number;
}

function emptyAggregate(): Aggregate {
  return {
    enter: 0,
    like: 0,
    freeGift: 0,
    watched: null,
    online: null,
    popularity: null,
    fans: null,
    likeTotal: null,
  };
}

export class BilibiliWorld implements World {
  readonly id = 'bilibili';

  private host: WorldHost | null = null;
  private client: LiveSource | null = null;
  private readonly opts: BilibiliWorldOptions;
  private readonly timezone: string;
  private overlayConfig: BilibiliOverlayConfig;
  private overlayDesignRevision = 0;
  private overlayEditorMutation: Promise<void> = Promise.resolve();
  private readonly announcement: AgentAnnouncementStore;
  private readonly assets: OverlayAssetStore | null;
  private overlayServer: BilibiliOverlayServer | null = null;
  private overlayError: string | null = null;
  private status: LiveStatus | null = null;
  private shutdownChecks: readonly ShutdownExternalCheck[] = [];
  private lifecycleGeneration = 0;
  private readonly coalescing: CoalescingBuffer<PendingLiveEvent>;
  private readonly admission: AudienceAdmission;
  private eventWrites: Promise<void> = Promise.resolve();
  private pendingEventWrites = 0;

  /** null 表示关闭原始帧采样。 */
  private readonly rawSampleFile: string | null;
  private rawSampleWrites: Promise<void> = Promise.resolve();
  private rawSampleDirReady = false;

  private rawSampleErrorReported = false;

  private readonly seenGiftNames = new Set<string>();

  private unnamedGiftSamples = 0;

  private readonly recentGuard = new Map<string, { at: number; guardLevel?: number }>();

  private lastRoomEdge: { living: boolean; at: number } | null = null;
  /** null 表示尚未取得有效房间状态。 */
  private lastKnownLiving: boolean | null = null;
  /** 中断开始的时间戳；null 表示已连接或未启动。 */
  private feedDownSince: number | null = null;
  private feedOutageTimer: ReturnType<typeof setTimeout> | null = null;

  private feedOutageReported = false;

  /** 渲染后清空的聚合读数。 */
  private agg = emptyAggregate();
  /** 延迟渲染事件的入队时间；null 表示尚未入队。 */
  private armedAt: number | null = null;

  private readonly recent: string[] = [];
  /** 累计事件数，包含已从 recent 移除的条目。 */
  private noteSeq = 0;
  /** 包含未识别命令。 */
  private readonly cmdCounts = new Map<string, number>();
  /** 最近弹幕是否具有观众 uid。 */
  private readonly identified: boolean[] = [];

  private anonymousLoginReported = false;
  /** 登录 uid；0 表示匿名。 */
  private loginUid = 0;

  private coalesceFolds = 0;
  private coalesceFoldedItems = 0;
  private coalesceLogAt = 0;

  private admissionDropped = 0;

  constructor(opts: BilibiliWorldOptions) {
    this.opts = opts;
    this.coalescing = new CoalescingBuffer((groups) => this.emitCoalesced(groups));
    this.admission = new AudienceAdmission({
      file: opts.audienceLedgerFile,
      roomId: opts.roomId,
      tuning: this.audienceTuning(),
      onPersistError: (error) => this.host?.log.warn('B站观众准入账本落盘失败', { err: error.message }),
    });
    this.timezone = opts.timezone ?? SYSTEM_TIMEZONE;

    this.rawSampleFile = opts.rawSampleFile
      ?? (opts.audienceLedgerFile
        ? join(dirname(dirname(opts.audienceLedgerFile)), 'bilibili-raw-samples.jsonl')
        : null);
    this.overlayConfig = opts.overlay
      ? normalizeOverlayConfig(opts.overlay)
      : { ...cloneOverlayConfig(), enabled: false };
    this.announcement = new AgentAnnouncementStore(opts.agentNoticeFile);
    this.assets = opts.overlayAssetDir ? new OverlayAssetStore(opts.overlayAssetDir) : null;
  }

  envPromptVars(): Record<string, string> {
    return {
      'bilibili.agentAnnouncement': this.announcement.current.text,
      'bilibili.agentAnnouncementLimit': String(this.agentNoticeLimit()),
    };
  }

  console(): WorldConsoleDecl {
    const s = this.status;
    const phase = s?.phase ?? 'stopped';
    const phaseLabel: Record<string, string> = {
      stopped: '未接入',
      connecting: '连接中',
      connected: '已接入',
      retrying: '重连中',
    };
    return {

      lamps: [
        {
          label: '接入',
          ...(phase === 'connected'
            ? { state: 'online' as const }
            : phase === 'stopped'
              ? { state: 'offline' as const, hint: s?.lastError ?? '未接入' }
              : this.feedOutageReported && this.feedDownSince !== null
                ? {
                    state: 'error' as const,
                    hint: `弹幕接入中断 ${Math.round((Date.now() - this.feedDownSince) / 1000)} 秒,重连中`
                      + (s?.lastError ? `:${s.lastError}` : ''),
                  }
                : { state: 'loading' as const, hint: s?.lastError ?? phaseLabel[phase] ?? phase }),
        },
        {
          label: '直播间',
          ...(s?.living
            ? { state: 'online' as const, hint: `${s.realRoomId ?? s.roomId} · 直播中` }
            : { state: 'offline' as const, hint: s?.realRoomId ? `${s.realRoomId} · 未开播` : '未知' }),
        },
        {
          label: '身份',
          ...(this.desensitized()
            ? { state: 'offline' as const, hint: '匿名(认不出人)' }
            : { state: 'online' as const, hint: this.identityLabel() }),
        },
        {
          label: 'Overlay',
          ...(this.overlayError
            ? { state: 'error' as const, hint: this.overlayError }
            : this.overlayServer?.running
              ? { state: 'online' as const, hint: this.overlayServer.overlayUrl }
              : { state: 'offline' as const, hint: this.overlayConfig.enabled ? '未启动' : '未启用' }),
        },
      ],
      badges: [
        {
          label: '接入',
          value: phaseLabel[phase] ?? phase,
          tone: phase === 'connected' ? 'on' : phase === 'stopped' ? 'off' : 'plain',
        },
        {
          label: '直播间',
          value: s?.realRoomId ? `${s.realRoomId}${s.living ? ' · 直播中' : ' · 未开播'}` : '—',
          tone: s?.living ? 'on' : 'plain',
        },
        {
          label: '身份',
          value: this.identityLabel(),
          tone: this.desensitized() ? 'off' : 'on',
        },
        {
          label: 'Overlay',
          value: this.overlayServer?.running
            ? `${this.overlayServer.subscriberCount} 个订阅`
            : this.overlayConfig.enabled ? '未启动' : '未启用',
          tone: this.overlayServer?.running ? 'on' : 'plain',
        },
      ],
      panels: [...BILIBILI_PANEL_DECLS],
      invoke: async (panel, method, args) => {
        if (panel !== PANEL_LOG) throw new Error(`未知面板: ${panel}`);
        if (method === 'state') return this.logState();
        throw new Error(`未知方法: ${method}`);
      },
      ...(this.overlayServer?.running
        ? {
            links: [
              { label: '打开 Overlay 编辑器', href: this.overlayServer.editorUrl, inheritTheme: true },
              { label: '打开 OBS Overlay', href: this.overlayServer.overlayUrl },
            ],
          }
        : {}),
      config: [BILIBILI_CONFIG_GROUP],
      promptDocs: [
        {
          key: 'worlds.bilibili.envPrompt',
          title: 'B 站直播间 · 环境提示词',
          description: '直播间这个场所的常驻事实。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            {
              name: 'bilibili.agentAnnouncement',
              description: 'Agent 公告栏当前保存的纯文本。',
              multiline: true,
            },
            {
              name: 'bilibili.agentAnnouncementLimit',
              description: 'Agent 公告工具当前允许的最大字数。',
            },
          ],
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    const generation = ++this.lifecycleGeneration;
    this.host = host;
    this.armedAt = null;
    this.agg = emptyAggregate();
    this.coalescing.reset();
    this.eventWrites = Promise.resolve();
    this.pendingEventWrites = 0;
    this.rawSampleWrites = Promise.resolve();
    this.rawSampleErrorReported = false;
    this.seenGiftNames.clear();
    this.unnamedGiftSamples = 0;
    this.recentGuard.clear();
    this.lastRoomEdge = null;
    this.lastKnownLiving = null;
    this.clearFeedOutage();
    this.feedOutageReported = false;
    this.shutdownChecks = [];
    this.anonymousLoginReported = false;
    this.loginUid = 0;
    this.coalesceFolds = 0;
    this.coalesceFoldedItems = 0;
    this.coalesceLogAt = Date.now();
    this.admissionDropped = 0;
    await this.startOverlay(host);
    if (!this.opts.roomId && !this.opts.source) {
      host.log.warn('B 站直播间未配置房间号(worlds.bilibili.roomId),不接入');
      return;
    }
    if (!host.pushCandidate) {
      this.host = null;
      throw new Error('B 站直播间需要宿主提供候选投递能力');
    }
    if (!this.opts.sessdata && !this.opts.source) {
      host.log.warn('未配置 worlds.bilibili.sessdata,将以匿名接入——观众 uid 会被服务端抹成 0');
    }
    const handlers: LiveHandlers = {
      onCmd: (msg) => {
        if (generation === this.lifecycleGeneration) this.onCmd(msg);
      },
      onStatus: (s) => {
        if (generation === this.lifecycleGeneration) this.onLiveStatus(s);
      },
    };
    this.client = this.opts.source
      ? this.opts.source(handlers)
      : new LiveClient({
          roomId: this.opts.roomId,
          sessdata: this.opts.sessdata ?? '',
          log: host.log,
          onCmd: handlers.onCmd,
          onStatus: handlers.onStatus,
        });
    this.onLiveStatus(this.client.current());
    this.shutdownChecks = [this.unknownSourceShutdownCheck('直播源尚未执行关机核验')];
    await this.client.start();
  }

  async stop(): Promise<void> {
    ++this.lifecycleGeneration;
    this.coalescing.flush('stop');

    this.flushCoalesceLog(true);
    await this.eventWrites;

    if (this.rawSampleFile) await this.rawSampleWrites;
    const client = this.client;
    const overlay = this.overlayServer;
    this.client = null;
    this.overlayServer = null;
    this.armedAt = null;
    this.clearFeedOutage();
    this.status = null;
    this.host = null;

    const [clientStop, overlayStop, admissionStop] = await Promise.all([
      client
        ? Promise.resolve().then(() => client.stop()).then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          )
        : Promise.resolve({ ok: true as const }),
      overlay
        ? Promise.resolve().then(() => overlay.stop()).then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          )
        : Promise.resolve({ ok: true as const }),
      Promise.resolve().then(() => this.admission.stop()).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    ]);

    const failures: Array<{ part: string; error: unknown }> = [];
    if (client) {
      if (!clientStop.ok) {
        failures.push({ part: '直播源', error: clientStop.error });
        this.shutdownChecks = [this.unknownSourceShutdownCheck(
          `直播源停止失败:${clientStop.error instanceof Error ? clientStop.error.message : String(clientStop.error)}`,
        )];
      } else {
        try {
          this.shutdownChecks = this.sourceShutdownChecks(client);
        } catch (error) {
          failures.push({ part: '关机核验', error });
          this.shutdownChecks = [this.unknownSourceShutdownCheck(
            `读取直播源关机核验失败:${error instanceof Error ? error.message : String(error)}`,
          )];
        }
      }
    }
    if (!overlayStop.ok) failures.push({ part: 'Overlay', error: overlayStop.error });
    if (!admissionStop.ok) failures.push({ part: '观众准入账本', error: admissionStop.error });
    if (failures.length > 0) {
      const details = failures.map(({ part, error }) => (
        `${part}:${error instanceof Error ? error.message : String(error)}`
      ));
      throw new AggregateError(failures.map((failure) => failure.error), `B 站 World 停止不完整:${details.join('；')}`);
    }
  }

  shutdownVerification(): readonly ShutdownExternalCheck[] {
    return this.shutdownChecks.map((check) => ({ ...check }));
  }

  private sourceShutdownChecks(source: LiveSource): readonly ShutdownExternalCheck[] {
    if (source.shutdownVerification) {
      const checks = source.shutdownVerification().map((check) => ({ ...check }));
      return checks.length > 0
        ? checks
        : [this.unknownSourceShutdownCheck('关机核验未返回任何检查项')];
    }
    return [this.unknownSourceShutdownCheck('已挂载的 LiveSource 未提供关机状态验证')];
  }

  private unknownSourceShutdownCheck(detail: string): ShutdownExternalCheck {
    return {
      key: 'bilibili.live-source',
      label: 'B 站直播源',
      status: 'unknown',
      detail,
      manualAction: '立即打开 B 站主播后台或直播伴侣人工确认直播状态；在确认前不要假定直播已经结束。',
    };
  }

  tools(): ToolDef[] {
    return [
      {
        name: 'bilibili_set_announcement',
        description:
          'Write plain text to the Bilibili Overlay Agent announcement board. '
          + 'Empty or whitespace-only text is rejected and the board keeps its current content. '
          + 'The result reports the active character limit.',
        tags: ['speak'],
        parameters: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              maxLength: this.agentNoticeLimit(),
              description:
                `Announcement text, at most ${this.agentNoticeLimit()} characters. `
                + 'Must contain visible characters; empty or whitespace-only text is rejected.',
            },
          },
          required: ['text'],
          additionalProperties: false,
        },
        handler: async (args) => {
          if (typeof args.text !== 'string') return '[bad input] text must be a string';

          if (args.text.trim() === '') {
            this.host?.log.warn('bilibili_set_announcement 拒绝空白 text', {
              limit: this.agentNoticeLimit(),
              textLength: args.text.length,
            });
            return (
              '[not executed] 传入的 text 是空串或纯空白,这次调用没有执行,公告板保持原样。'
              + '要写公告就把正文写进 text 再调一次;这个工具不接受用空串清空公告板。'
            );
          }
          try {
            const state = this.setAgentAnnouncement(args.text);
            const count = Array.from(state.text).length;
            return `[announcement updated] ${count}/${this.agentNoticeLimit()} chars: ${state.text}`;
          } catch (error) {
            return `[bad input] ${error instanceof Error ? error.message : String(error)}`;
          }
        },
      },
    ];
  }

  private onCmd(msg: Record<string, unknown>): void {
    const cmd = String(msg.cmd ?? '').split(':')[0] || '(无 cmd)';
    this.cmdCounts.set(cmd, (this.cmdCounts.get(cmd) ?? 0) + 1);
    this.maybeSampleRaw(cmd, msg);
    const item = normalize(msg, {
      giftFlushYuan: this.giftFlushYuan(),
      warn: (message, extra) => this.host?.log.warn(message, extra),
    });
    const overlayEvent = projectOverlayEvent(msg, item);

    const guardFamily = item !== null && item.kind === 'event'
      && (item.type === 'bilibili.guard' || item.type === 'bilibili.guard-renew');
    if (overlayEvent && !guardFamily) this.emitOverlayAudience(overlayEvent);
    const host = this.host;
    if (!host) return;
    if (!item) return;

    if (cmd === 'LIVE') {
      this.admission.startStream({ roomId: this.status?.realRoomId ?? this.opts.roomId });
      this.lastKnownLiving = true;

      if (!this.markRoomEdge(true, '弹幕服务器 LIVE 指令')) return;
    } else if (cmd === 'PREPARING') {
      this.admission.endStream();
      this.lastKnownLiving = false;
      if (!this.markRoomEdge(false, '弹幕服务器 PREPARING 指令')) return;
    }

    if (item.kind === 'count') {
      if (item.field === 'freeGift') this.coalescing.breakRun('bilibili.gift');
      this.agg[item.field] += item.by;
      this.armAggregate();
      return;
    }
    if (item.kind === 'gauge') {
      if (item.field === 'online') {
        this.admission.updateTuning(this.audienceTuning());
        this.admission.observeOnlineRank(item.value);
      }
      this.agg[item.field] = item.value;
      this.armAggregate();
      return;
    }

    if (item.type === 'bilibili.guard' || item.type === 'bilibili.guard-renew') {
      if (this.suppressDuplicateGuard(item)) return;
      if (overlayEvent) this.emitOverlayAudience(overlayEvent);
    }
    if (item.type === 'bilibili.danmaku') this.noteIdentity(item.senderKey !== undefined);
    this.observeAudience(item);
    this.note(item.text);
    const pending = { item, ts: nowIso(this.timezone) };
    if (item.coalesce && item.trigger !== 'flush') {
      if (item.coalesce.kind === 'gift' && !item.senderKey) {
        this.coalescing.flush('barrier');
        this.pushLiveEvent([pending], pending);
        return;
      }
      // 归并 key 包含身份，避免不同观众在同一窗口的相同正文丢失各自姓名。匿名接入没有稳定身份键时按正文归并。
      const identity = `\0${item.senderKey ?? ''}`;
      this.coalescing.add(`${item.type}${identity}\0${item.coalesce.key}`, pending, {
        windowMs: this.coalesceWindowMs(),
        maxItems: this.coalesceMaxItems(),
        ...(item.coalesce.kind === 'gift' ? { runScope: 'bilibili.gift' } : {}),
      });
      return;
    }
    this.coalescing.flush('barrier');
    this.pushLiveEvent([pending], pending);
  }

  /** 名单内命令逐条保存原帧；礼物仅采样新名字或无名帧，分别受集合与计数上限约束。 */
  private maybeSampleRaw(cmd: string, msg: Record<string, unknown>): void {
    if (!this.rawSampleFile) return;
    const listed = RAW_SAMPLE_DEFAULT_CMDS.includes(cmd);
    if (!listed) {
      if (cmd !== 'SEND_GIFT' && cmd !== 'SEND_GIFT_V2') return;
      const raw = msg.data !== null && typeof msg.data === 'object'
        ? (msg.data as Record<string, unknown>)
        : {};
      // V2 礼物名须先从 protobuf 中读取。
      const data = giftFrameData(raw);
      const name = typeof data.giftName === 'string' && data.giftName
        ? data.giftName
        : typeof data.gift_name === 'string' ? data.gift_name : '';
      if (name && this.seenGiftNames.has(name)) return;
      if (name) {
        if (this.seenGiftNames.size >= SEEN_GIFT_NAMES_CAP) return;
        this.seenGiftNames.add(name);
      } else {

        if (this.unnamedGiftSamples >= UNNAMED_GIFT_SAMPLE_CAP) return;
        this.unnamedGiftSamples += 1;
      }
    }
    const file = this.rawSampleFile;
    const line = `${JSON.stringify({ ts: nowIso(this.timezone), cmd, msg })}\n`;
    this.rawSampleWrites = this.rawSampleWrites
      .then(async () => {
        if (!this.rawSampleDirReady) {
          mkdirSync(dirname(file), { recursive: true });
          this.rawSampleDirReady = true;
        }
        await appendFile(file, line, 'utf8');
      })
      .catch((error) => {
        if (this.rawSampleErrorReported) return;
        this.rawSampleErrorReported = true;
        this.host?.log.warn('B站原始帧采样落盘失败', {
          file,
          err: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private suppressDuplicateGuard(item: LiveEvent): boolean {
    if (!item.senderKey) return false;
    const now = Date.now();
    for (const [key, entry] of this.recentGuard) {
      if (now - entry.at > GUARD_DEDUP_WINDOW_MS) this.recentGuard.delete(key);
    }
    const level = typeof item.meta?.guardLevel === 'number' ? item.meta.guardLevel : undefined;
    if (item.type === 'bilibili.guard') {
      this.recentGuard.set(item.senderKey, { at: now, guardLevel: level });
      return false;
    }
    const recent = this.recentGuard.get(item.senderKey);
    const duplicate = recent !== undefined
      && (recent.guardLevel === undefined || level === undefined || recent.guardLevel === level);
    if (duplicate) {
      this.host?.log.info('已过滤重复的大航海 TOAST', {
        senderKey: item.senderKey,
        text: item.text,
        windowMs: GUARD_DEDUP_WINDOW_MS,
      });
      return true;
    }
    this.recentGuard.set(item.senderKey, { at: now, guardLevel: level });
    return false;
  }

  private async startOverlay(host: WorldHost): Promise<void> {
    this.overlayError = null;
    if (!this.overlayConfig.enabled) return;
    if (!this.assets) {
      this.overlayError = '未配置 Overlay 素材目录';
      host.log.warn(this.overlayError);
      return;
    }
    const server = new BilibiliOverlayServer({
      preferredPort: this.overlayConfig.port,
      assets: this.assets,
      snapshot: () => this.overlaySnapshot(),
      editor: {
        state: () => this.overlayState(),
        saveDesign: (value, baseRevision) => this.runOverlayEditorMutation(
          () => this.saveOverlayDesign(value, baseRevision),
        ),
        importAsset: (value) => this.runOverlayEditorMutation(() => this.importOverlayAsset(value)),
        deleteAsset: (value) => this.runOverlayEditorMutation(() => this.deleteOverlayAsset(value)),
        setAgentAnnouncement: (value, expectedRevision) => this.runOverlayEditorMutation(
          () => this.setEditorAnnouncement(value, expectedRevision),
        ),
      },
    });
    try {
      await server.start(host.log);
      this.overlayServer = server;
    } catch (error) {
      this.overlayError = error instanceof Error ? error.message : String(error);
      host.log.warn('B站 Overlay 启动失败', { err: this.overlayError });
    }
  }

  private logState(): Record<string, unknown> {
    return {
      status: this.status,
      desensitized: this.desensitized(),
      aggregate: this.agg,
      recent: [...this.recent].reverse(),
      total: this.noteSeq,
      counts: [...this.cmdCounts.entries()].sort((a, b) => b[1] - a[1]),
      coalescing: this.coalescing.state(),
      audienceAdmission: this.admission.snapshot(),
    };
  }

  private overlaySnapshot(): Record<string, unknown> {
    return {
      design: structuredClone(this.overlayConfig.design),
      designRevision: this.overlayDesignRevision,
      builtinStyles: structuredClone(BUILTIN_OVERLAY_STYLES),
      agentAnnouncement: this.announcement.current,
    };
  }

  private overlayState(): Record<string, unknown> {
    return {
      ...this.overlaySnapshot(),
      url: this.overlayServer?.running ? this.overlayServer.overlayUrl : null,
      streamUp: this.overlayServer?.running ?? false,
      error: this.overlayError,
      maxAnnouncementChars: this.agentNoticeLimit(),
      assets: this.assets?.list(this.overlayServer?.running ? this.overlayServer.baseUrl : null) ?? [],
    };
  }

  private async saveOverlayDesign(value: unknown, baseRevision: unknown): Promise<Record<string, unknown>> {
    if (!Number.isInteger(baseRevision) || Number(baseRevision) !== this.overlayDesignRevision) {
      throw new OverlayEditorConflictError('Overlay 设计已被其他编辑会话更新');
    }
    const design = normalizeOverlayDesign(value);
    for (const style of design.styles) {
      if (style.nineSlice && !this.assets?.path(style.nineSlice.assetId)) {
        throw new Error(`样式「${style.name}」引用的 Nine-slice 素材不存在`);
      }
    }
    for (const component of design.components) {
      if (component.kind === 'image' && component.source === 'upload' && !this.assets?.path(component.assetId)) {
        throw new Error(`图片组件「${component.name}」引用的上传素材不存在`);
      }
    }
    const next = { ...this.overlayConfig, design };
    await this.opts.onOverlayConfig?.(cloneOverlayConfig(next));
    this.overlayConfig = next;
    this.overlayDesignRevision += 1;
    this.overlayServer?.emitState();
    return { ...this.overlayState(), message: 'Overlay 设计已保存并热更新' };
  }

  private importOverlayAsset(value: unknown): Record<string, unknown> {
    if (!this.assets) throw new Error('未配置 Overlay 素材目录');
    const base64 = typeof value === 'string' ? value : '';
    const asset = this.assets.import(base64);
    return { asset, assets: this.assets.list(this.overlayServer?.running ? this.overlayServer.baseUrl : null) };
  }

  private deleteOverlayAsset(value: unknown): Record<string, unknown> {
    if (!this.assets) throw new Error('未配置 Overlay 素材目录');
    const id = typeof value === 'string' ? value : '';
    const style = this.overlayConfig.design.styles.find((item) => item.nineSlice?.assetId === id);
    if (style) throw new Error(`素材仍被样式「${style.name}」使用`);
    const component = this.overlayConfig.design.components.find(
      (item) => item.kind === 'image' && item.source === 'upload' && item.assetId === id,
    );
    if (component) throw new Error(`素材仍被组件「${component.name}」使用`);
    const deleted = this.assets.delete(id);
    return {
      deleted,
      assets: this.assets.list(this.overlayServer?.running ? this.overlayServer.baseUrl : null),
    };
  }

  private setAgentAnnouncement(value: unknown) {
    if (typeof value !== 'string') throw new Error('公告必须是纯文本');
    const state = this.announcement.set(value, this.agentNoticeLimit());
    this.overlayServer?.emitAnnouncement(state);
    return state;
  }

  private setEditorAnnouncement(value: unknown, expectedRevision: unknown): Record<string, unknown> {
    if (!Number.isInteger(expectedRevision) || Number(expectedRevision) !== this.announcement.current.revision) {
      throw new OverlayEditorConflictError('Agent 公告已被其他写入者更新');
    }
    return { ...this.setAgentAnnouncement(value) };
  }

  private runOverlayEditorMutation<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.overlayEditorMutation.then(operation);
    this.overlayEditorMutation = result.then(() => undefined, () => undefined);
    return result;
  }

  private emitOverlayAudience(event: OverlayAudienceEvent): void {
    const group = matchAudienceGroup(this.overlayConfig.design.groups, event.facts);
    const projected = { ...event, ...(group ? { groupId: group.id } : {}) };
    this.overlayServer?.emitAudience(projected);
  }

  private agentNoticeLimit(): number {
    const value = this.opts.agentNoticeMaxChars?.() ?? this.overlayConfig.agentNoticeMaxChars;
    return Number.isFinite(value) ? Math.min(5000, Math.max(1, Math.round(value))) : 200;
  }

  /** `piggyback` 随下一批事件投递，不触发唤醒或重置合批计时器。 */
  private armAggregate(): void {
    if (!this.host) return;
    const now = Date.now();
    if (this.armedAt !== null && now - this.armedAt < ARM_STALE_MS) return;
    this.armedAt = now;
    this.host.pushDeferred(
      {
        type: 'bilibili.audience',
        tags: ['snapshot'],
        render: () => {
          this.armedAt = null;
          const line = renderAggregate(this.agg);
          this.agg = emptyAggregate();
          if (line) this.note(line);
          return line;
        },
      },
      { trigger: 'piggyback' },
    );
  }

  private giftFlushYuan(): number {
    const v = this.opts.giftFlushYuan?.() ?? BILIBILI_DEFAULTS.giftFlushYuan;
    return Number.isFinite(v) && v >= 0 ? v : BILIBILI_DEFAULTS.giftFlushYuan;
  }

  private coalesceWindowMs(): number {
    const value = this.opts.coalesceWindowMs?.() ?? BILIBILI_DEFAULTS.coalesceWindowMs;
    return Number.isFinite(value)
      ? Math.min(2000, Math.max(0, Math.round(value)))
      : BILIBILI_DEFAULTS.coalesceWindowMs;
  }

  private coalesceMaxItems(): number {
    const value = this.opts.coalesceMaxItems?.() ?? BILIBILI_DEFAULTS.coalesceMaxItems;
    return Number.isFinite(value)
      ? Math.min(1000, Math.max(1, Math.round(value)))
      : BILIBILI_DEFAULTS.coalesceMaxItems;
  }

  private emitCoalesced(groups: readonly CoalescingGroup<PendingLiveEvent>[]): void {
    for (const group of groups) {
      const pending = group.items.length === 1
        ? group.items[0]
        : { ts: group.items[0].ts, item: mergeLiveEvents(group.items.map((entry) => entry.item)) };
      if (group.items.length >= 2) {
        this.coalesceFolds += 1;
        this.coalesceFoldedItems += group.items.length;
      }
      this.pushLiveEvent(group.items, pending);
    }
    this.flushCoalesceLog(false);
  }

  /** force 在停止时输出尚未满统计窗口的累计值。 */
  private flushCoalesceLog(force: boolean): void {
    if (this.coalesceFolds === 0) return;
    const now = Date.now();
    if (this.coalesceLogAt === 0) this.coalesceLogAt = now;
    if (!force && now - this.coalesceLogAt < COALESCE_LOG_WINDOW_MS) return;
    this.host?.log.info('直播间归并折叠', {
      folds: this.coalesceFolds,
      sourceItems: this.coalesceFoldedItems,
      windowMs: now - this.coalesceLogAt,
    });
    this.coalesceFolds = 0;
    this.coalesceFoldedItems = 0;
    this.coalesceLogAt = now;
  }

  private pushLiveEvent(sources: readonly PendingLiveEvent[], { item }: PendingLiveEvent): void {
    const host = this.host;
    if (!host) return;
    const write = async (): Promise<void> => {
      await host.pushCandidate!(
        {
          sourceEvents: sources.map(({ item: source, ts }) => ({
            ts,
            type: source.type,
            text: source.text,
            ...(source.senderKey ? { senderKey: source.senderKey } : {}),
            ...(source.meta ? { meta: source.meta } : {}),
          })),
          gateText: item.text,
          value: { item } satisfies LiveCandidateValue,
          project: this.projectAudienceCandidates,
        },
        { trigger: item.trigger },
      );
    };
    this.pendingEventWrites += 1;
    const queued = this.pendingEventWrites === 1 ? write() : this.eventWrites.then(write);
    this.eventWrites = queued
      .catch((error) => host.log.warn('直播间事件投递失败', { err: String(error) }))
      .finally(() => {
        this.pendingEventWrites -= 1;
      });
  }

  private readonly projectAudienceCandidates: CandidateProjector = (sourceCandidates) => {
    this.admission.updateTuning(this.audienceTuning());
    const candidates: LiveAdmissionCandidate[] = sourceCandidates.map((source) => {
      const value = source.value as LiveCandidateValue;
      return {
        stableKey: source.sourceEvents.map((event) => event.cursor).join(','),
        text: value.item.text,
        type: value.item.type,
        senderKeys: audienceSenderKeys(value.item),
        critical: criticalAudienceEvent(value.item),
        meta: value,
      };
    });
    const projected = this.admission.project(candidates);
    const dropped = candidates.length - projected.selected.length;
    if (dropped > 0) {
      // 记录未投递给 agent 的筛除事件，供诊断。
      this.admissionDropped += dropped;
      this.host?.log.warn('直播间准入筛除', {
        dropped,
        candidates: candidates.length,
        selected: projected.selected.length,
        limitingActive: projected.metrics.limitingActive,
        totalDropped: this.admissionDropped,
      });
    }
    return projected.selected.map((selection) => {
      const item = selection.candidate.meta!.item;
      const importantParticipants = audienceParticipantDetails(item, selection.importantParticipants);
      return {
        candidateIndexes: [selection.index],
        event: {
          type: item.type,
          text: item.text,
          ...(item.senderKey ? { senderKey: item.senderKey } : {}),
          meta: {
            ...item.meta,
            audienceAdmission: {
              limitingActive: projected.metrics.limitingActive,
              lane: selection.lane,
              importantParticipants,
            },
          },
        },
      };
    });
  };

  private observeAudience(item: LiveEvent): void {
    if (!item.senderKey) return;
    const guardLevel = typeof item.meta?.guardLevel === 'number' ? item.meta.guardLevel : 0;
    this.admission.observe({
      senderKey: item.senderKey,
      interaction: item.type === 'bilibili.danmaku',
      ...(item.type === 'bilibili.superchat' && typeof item.meta?.yuan === 'number'
        ? { superchatYuan: item.meta.yuan }
        : {}),
      guard: item.type === 'bilibili.guard' || item.type === 'bilibili.guard-renew',
      guardLevel,
    });
  }

  private onLiveStatus(status: LiveStatus): void {
    this.status = status;
    this.loginUid = status.selfUid;
    this.checkAnonymousLogin(status);
    this.trackFeedPhase(status.phase);
    const roomId = status.realRoomId ?? status.roomId;
    // 首个有效房间状态仅建立基线；后续状态变化参与去重。

    if (status.realRoomId !== null) {
      const prev = this.lastKnownLiving;
      this.lastKnownLiving = status.living;
      if (prev !== null && prev !== status.living
        && this.markRoomEdge(status.living, `接口 live_status=${status.living ? 1 : 0}`)) {
        this.announceRoomEdge(status.living);
      }
    }
    if (status.living) {
      this.admission.startStream({ roomId, liveStartedAt: status.liveStartedAt });
    } else if (status.realRoomId !== null) {
      this.admission.endStream();
    }
  }

  /** 记录状态变化并去重；新变化写日志并返回 true。 */
  private markRoomEdge(living: boolean, via: string): boolean {
    const now = Date.now();
    const last = this.lastRoomEdge;
    this.lastRoomEdge = { living, at: now };
    if (last && last.living === living && now - last.at <= ROOM_EDGE_DEDUP_MS) {
      this.host?.log.info('已过滤重复的直播状态通知', {
        living,
        via,
        sinceMs: now - last.at,
      });
      return false;
    }
    const roomId = this.status?.realRoomId ?? this.opts.roomId;
    if (living) {
      this.host?.log.warn(`平台侧直播间已开播(${via})`, { roomId });
    } else {
      this.host?.log.error(
        `平台侧直播间未开播(${via})`,
        { roomId },
      );
    }
    return true;
  }

  /** 投递轮询发现的状态变化；WS 状态事件由 normalize 生成。 */
  private announceRoomEdge(living: boolean): void {
    this.pushNotice(living
      ? {
          kind: 'event',
          type: 'bilibili.room',
          trigger: 'flush',
          text: '[直播间] 平台确认已开播(接口 live_status=1):直播画面已对观众可见',
        }
      : {
          kind: 'event',
          type: 'bilibili.room',
          trigger: 'flush',
          text: '[直播间] 平台确认已下播(接口 live_status=0):观众已经看不到直播画面;'
            + '此后的弹幕来自仍留在房间页的人,不代表直播还在进行',
        });
  }

  /** 投递本 World 生成的通知前，先输出归并缓冲中的事件。 */
  private pushNotice(item: LiveEvent): void {
    if (!this.host) return;
    this.note(item.text);
    const pending: PendingLiveEvent = { item, ts: nowIso(this.timezone) };
    this.coalescing.flush('barrier');
    this.pushLiveEvent([pending], pending);
  }

  /** connecting/retrying 连续计时；connected 报告已记录中断的恢复，stopped 仅清除计时。 */
  private trackFeedPhase(phase: LivePhase): void {
    if (phase === 'connecting' || phase === 'retrying') {
      if (this.feedDownSince !== null) return;
      this.feedDownSince = Date.now();
      this.feedOutageTimer = setTimeout(() => this.reportFeedOutage(), FEED_OUTAGE_MS);
      this.feedOutageTimer.unref?.();
      return;
    }
    const since = this.feedDownSince;
    this.clearFeedOutage();
    if (phase !== 'connected' || !this.feedOutageReported || since === null) return;
    this.feedOutageReported = false;
    const outageSec = Math.round((Date.now() - since) / 1000);
    this.host?.log.warn('弹幕接入已恢复', { outageSec });
    this.pushNotice({
      kind: 'event',
      type: 'bilibili.feed',
      trigger: 'debounce',
      text: `[直播间] 弹幕接入已恢复,中断 ${outageSec} 秒`,
    });
  }

  private reportFeedOutage(): void {
    this.feedOutageTimer = null;
    const since = this.feedDownSince;
    if (since === null || !this.host) return;
    const outageSec = Math.round((Date.now() - since) / 1000);
    this.feedOutageReported = true;
    this.host.log.warn(`弹幕接入中断已持续 ${outageSec} 秒,仍在重连:这段的弹幕收不到`, {
      outageSec,
      phase: this.status?.phase,
      lastError: this.status?.lastError,
    });
    this.pushNotice({
      kind: 'event',
      type: 'bilibili.feed',
      trigger: 'flush',
      text: `[直播间] 弹幕接入中断 ${outageSec} 秒,重连中,这段的弹幕收不到`,
    });
  }

  private clearFeedOutage(): void {
    if (this.feedOutageTimer) clearTimeout(this.feedOutageTimer);
    this.feedOutageTimer = null;
    this.feedDownSince = null;
  }

  private checkAnonymousLogin(status: LiveStatus): void {
    if (status.phase !== 'connected') return;
    if (!this.opts.sessdata) return;
    if (status.selfUid > 0) {
      this.anonymousLoginReported = false;
      return;
    }
    if (this.anonymousLoginReported) return;
    this.anonymousLoginReported = true;
    this.host?.log.error(
      '已配置 worlds.bilibili.sessdata,登录接口仍返回匿名状态(selfUid=0)',
      { roomId: status.realRoomId ?? status.roomId },
    );
  }

  private audienceTuning(): Partial<AudienceAdmissionTuning> {
    const on = integerOption(this.opts.audienceOnlineRankOn, BILIBILI_DEFAULTS.audienceOnlineRankOn, 1, 100000);
    const off = integerOption(this.opts.audienceOnlineRankOff, BILIBILI_DEFAULTS.audienceOnlineRankOff, 0, on - 1);
    const freshMs = integerOption(
      this.opts.audienceSignalFreshSec,
      BILIBILI_DEFAULTS.audienceSignalFreshSec,
      1,
      3600,
    ) * 1000;
    return {
      onlineRankCrowdedOn: on,
      onlineRankCrowdedOff: off,
      onlineRankReleaseMs: integerOption(
        this.opts.audienceReleaseHoldSec,
        BILIBILI_DEFAULTS.audienceReleaseHoldSec,
        1,
        1800,
      ) * 1000,
      onlineRankFreshMs: freshMs,
      onlineRankStaleHoldMs: Math.max(freshMs, integerOption(
        this.opts.audienceActiveStaleHoldSec,
        BILIBILI_DEFAULTS.audienceActiveStaleHoldSec,
        1,
        3600,
      ) * 1000),
      lineBudget: integerOption(
        this.opts.audienceEventLineBudget,
        BILIBILI_DEFAULTS.audienceEventLineBudget,
        1,
        5000,
      ),
      tokenBudget: integerOption(
        this.opts.audienceEventTokenBudget,
        BILIBILI_DEFAULTS.audienceEventTokenBudget,
        1,
        100000,
      ),
      importantBudgetShare: numberOption(
        this.opts.audienceImportantShare,
        BILIBILI_DEFAULTS.audienceImportantShare,
        0.01,
        1,
      ),
    };
  }

  private note(text: string): void {
    this.noteSeq++;
    this.recent.push(text);
    if (this.recent.length > RECENT_CAP) this.recent.shift();
  }

  private noteIdentity(identified: boolean): void {
    this.identified.push(identified);
    if (this.identified.length > ANON_WINDOW) this.identified.shift();
  }

  private desensitized(): boolean {
    return this.identified.length > 0 && !this.identified.includes(true);
  }

  private identityLabel(): string {
    if (this.identified.length === 0) return '待观察';
    return this.desensitized() ? '近期弹幕缺少观众 uid' : '可认人';
  }
}

function audienceSenderKeys(item: LiveEvent): string[] {
  const keys = new Set<string>();
  if (item.senderKey) keys.add(item.senderKey);
  const participants = item.meta?.participants;
  if (Array.isArray(participants)) {
    for (const value of participants) {
      if (value === null || typeof value !== 'object') continue;
      const senderKey = (value as Record<string, unknown>).senderKey;
      if (typeof senderKey === 'string' && senderKey) keys.add(senderKey);
    }
  }
  return [...keys];
}

function audienceParticipantDetails(
  item: LiveEvent,
  important: readonly ImportantAudienceParticipant[],
): Array<{ senderKey: string; uname?: string; count: number; reasons: ImportantAudienceParticipant['reasons'] }> {
  const details = new Map<string, { uname?: string; count: number }>();
  if (item.senderKey) {
    const uname = typeof item.meta?.uname === 'string' && item.meta.uname ? item.meta.uname : undefined;
    details.set(item.senderKey, { ...(uname ? { uname } : {}), count: 1 });
  }
  const participants = item.meta?.participants;
  if (Array.isArray(participants)) {
    for (const value of participants) {
      if (value === null || typeof value !== 'object') continue;
      const raw = value as Record<string, unknown>;
      if (typeof raw.senderKey !== 'string' || !raw.senderKey) continue;
      const uname = typeof raw.uname === 'string' && raw.uname ? raw.uname : undefined;
      const count = typeof raw.count === 'number' && Number.isInteger(raw.count) && raw.count > 0 ? raw.count : 1;
      details.set(raw.senderKey, { ...(uname ? { uname } : {}), count });
    }
  }
  return important.map((participant) => {
    const detail = details.get(participant.senderKey);
    return {
      senderKey: participant.senderKey,
      ...(detail?.uname ? { uname: detail.uname } : {}),
      count: detail?.count ?? 1,
      reasons: participant.reasons,
    };
  });
}

function criticalAudienceEvent(item: LiveEvent): boolean {
  return item.trigger === 'flush' || item.type === 'bilibili.guard-renew';
}

function integerOption(
  read: (() => number) | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = read?.() ?? fallback;
  const candidate = Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, Math.round(candidate)));
}

function numberOption(
  read: (() => number) | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = read?.() ?? fallback;
  const candidate = Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, candidate));
}

function renderAggregate(agg: Aggregate): string | null {
  const events: string[] = [];
  if (agg.enter > 0) events.push(`${agg.enter} 人进场`);
  if (agg.like > 0) events.push(`${agg.like} 次点赞`);
  if (agg.freeGift > 0) events.push(`${agg.freeGift} 个免费礼物`);
  const gauges: string[] = [];
  if (agg.online !== null) gauges.push(`高能榜 ${agg.online} 人`);
  if (agg.watched !== null) gauges.push(`看过 ${agg.watched}`);
  if (agg.popularity !== null) gauges.push(`人气 ${agg.popularity}`);
  if (agg.likeTotal !== null) gauges.push(`累计点赞 ${agg.likeTotal}`);
  if (agg.fans !== null) gauges.push(`粉丝 ${agg.fans}`);
  if (events.length === 0 && gauges.length === 0) return null;
  const parts = [events.length ? `刚才 ${events.join('、')}` : '', gauges.join(',')].filter(Boolean);
  return `[直播间] ${parts.join(';')}`;
}

function mergeLiveEvents(items: readonly LiveEvent[]): LiveEvent {
  const first = items[0];
  const spec = first.coalesce!;
  const participants = mergeParticipants(items);
  const senderKeys = participants.map((participant) => participant.senderKey);
  const commonParticipant = participants.length === 1 && participants[0].count === items.length
    ? participants[0]
    : undefined;
  if (spec.kind === 'danmaku') {
    // 归并正文携带昵称；meta 是驱动层私有数据，不渲染给 agent。
    const names = participants.map((participant) => participant.uname).filter((name) => !!name);
    const label = names.length > 0 ? `|${names.join('、')}` : '';
    return {
      kind: 'event',
      type: first.type,
      trigger: first.trigger,
      text: `[弹幕×${items.length}${label}] ${spec.body}`,
      ...(commonParticipant ? { senderKey: commonParticipant.senderKey } : {}),
      meta: {
        body: spec.body,
        mergedCount: items.length,
        senderKeys,
        participants,
        ...(commonParticipant?.uname ? { uname: commonParticipant.uname } : {}),
      },
    };
  }
  const giftSpecs = items.map((item) => item.coalesce as typeof spec);
  // 任一礼物金额未知时，合并正文省略总金额。
  const yuan = giftSpecs.some((item) => item.yuan === null)
    ? null
    : roundedMoney(giftSpecs.reduce((sum, item) => sum + (item.yuan ?? 0), 0));
  const num = giftSpecs.reduce((sum, item) => sum + item.num, 0);
  const contributor = participants[0]!;
  const uname = contributor.uname ?? '某位观众';
  const money = yuan === null ? '' : ` ¥${formatNumber(yuan)}`;
  return {
    kind: 'event',
    type: first.type,
    trigger: first.trigger,
    text: `[礼物×${items.length}笔${money}|${uname}] ${spec.gift}×${num}`,
    senderKey: contributor.senderKey,
    meta: {
      gift: spec.gift,
      num,
      ...(yuan === null ? {} : { yuan }),
      mergedCount: items.length,
      senderKeys,
      participants,
      contributors: [{ uname, count: items.length }],
      ...(contributor.uname ? { uname: contributor.uname } : {}),
    },
  };
}

function mergeParticipants(items: readonly LiveEvent[]): LiveEventParticipant[] {
  const participants = new Map<string, LiveEventParticipant>();
  for (const item of items) {
    if (!item.senderKey) continue;
    const current = participants.get(item.senderKey);
    if (current) {
      current.count += 1;
      continue;
    }
    const uname = typeof item.meta?.uname === 'string' ? item.meta.uname : '';
    participants.set(item.senderKey, {
      senderKey: item.senderKey,
      ...(uname ? { uname } : {}),
      count: 1,
    });
  }
  return [...participants.values()];
}

function roundedMoney(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function formatNumber(value: number): string {
  return value.toFixed(3).replace(/\.?0+$/, '');
}

export type { CountField, GaugeField };
