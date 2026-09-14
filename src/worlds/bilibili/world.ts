/**
 * BilibiliWorld — B 站直播间接入与本机 Overlay。
 *
 * 直播间协议仍然只入站，不向 B 站账号写入。唯一工具写本机 Agent 公告栏，
 * Overlay 通过回环 HTTP 服务交给 OBS browser source。
 *
 * 事件词表与投递分档(何时唤醒 × 何时成文):
 *   bilibili.superchat     醒目留言        flush     付费且限时展示
 *   bilibili.guard         上舰            flush
 *   bilibili.gift          礼物 ≥ 阈值     flush     阈值见 worlds.bilibili.giftFlushYuan
 *   bilibili.gift          礼物 < 阈值     debounce
 *   bilibili.guard-renew   大航海 TOAST    debounce  同 uid 短窗内与 GUARD_BUY 去重
 *   bilibili.danmaku       弹幕            debounce
 *   bilibili.enter-guard   舰长进场        debounce
 *   bilibili.block         观众被禁言      debounce
 *   bilibili.room          开播/下播/禁言  flush;标题变更 debounce
 *   bilibili.feed          弹幕接入中断/恢复 flush / debounce  中断超 FEED_OUTAGE_MS 才成文
 *   bilibili.warning       超管警告/切断   flush     只告诉她,不替她收嘴
 *   bilibili.superchat-del SC 被删         piggyback
 *   bilibili.audience      人流读数        piggyback + 投递成文(发车刻现渲染)
 *
 * 进场/点赞/免费礼物/看过/在线/人气/粉丝数这些**只有读数没有发生时刻**的东西
 * 不单独成事件:累加在本 World 里,搭下一班车带出去,正文在发车刻才成文。
 */
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
import { nowIso } from '../../core/util.ts';
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

/** 面板声明。导出是给 dev 截图器用的:它照这一份铺面板,不另抄一份措辞。 */
export const BILIBILI_PANEL_DECLS: readonly WorldPanelDecl[] = [
  {
    id: PANEL_LOG,
    title: '直播间事件',
    description: '最近事件的文本投影与各 cmd 计数;没见过的 cmd 也列在这里。',
  },
];

/** 控制台事件流保留条数 */
const RECENT_CAP = 200;
/** 判定"服务端在脱敏"要看的最近弹幕条数 */
const ANON_WINDOW = 20;
/**
 * 归并折叠诊断的汇总窗口；保留异常频次，同时限制常态折叠的日志量。
 */
const COALESCE_LOG_WINDOW_MS = 60_000;
/**
 * 直播间事件投递队列深度上限:超过则丢弃新到达,保护进程不被高频弹幕+宿主 I/O 瓶颈拖垮 OOM。
 * 1000 场覆盖一场大型直播的弹幕洪峰(每场被 coalescing 合并后通常远低于此)。
 */
const LIVE_WRITE_QUEUE_MAX = 1000;
const RAW_SAMPLE_QUEUE_MAX = 5000;
/**
 * 挂单超过此时限仍未渲染时允许重挂。渲染是正常复位点；陈旧窗口处理挂单被清空或隐藏期丢弃后无法复位的情况。
 */
const ARM_STALE_MS = 300_000;

/**
 * 原始 WS 帧采样名单，可由 rawSampleCmds 覆盖。名单内命令不设量控，普通弹幕不采样；SEND_GIFT 仅在礼物名未知或无法读取时另行采样。
 */
const RAW_SAMPLE_DEFAULT_CMDS: readonly string[] = [
  'GUARD_BUY',
  'USER_TOAST_MSG',
  'USER_TOAST_MSG_V2',
  'SUPER_CHAT_MESSAGE',
];
/** 本场已见过的礼物名集合的内存上限;超出后不再采新名字,防极端刷屏撑爆 */
const SEEN_GIFT_NAMES_CAP = 512;
/** 礼物名读不出来的帧,本场最多留这么多样。够定位一次布局变更,又不会写满盘 */
const UNNAMED_GIFT_SAMPLE_CAP = 16;

/**
 * 大航海族按同 uid 作短窗去重，guardLevel 可比时还须相同。GUARD_BUY 始终投递并记账，以保留金额与开通语义；后到且匹配的 TOAST 抑制。guard 仍作为 flush trigger，不进入归并缓冲。
 */
const GUARD_DEDUP_WINDOW_MS = 8_000;

/**
 * 直播状态沿(开播/下播)的双源短窗去重。弹幕 WS 的 LIVE/PREPARING 与 client 的
 * live_status 轮询(见 client.ts ROOM_POLL_MS)是同一张网的两根线:正常情况下
 * WS 实时到、轮询最迟 100 秒后跟着确认同一件事,不去重就是每个沿双报。
 * 同一状态的沿在这个窗内只成文一次;窗取轮询间隔 + 余量。
 */
const ROOM_EDGE_DEDUP_MS = 180_000;

/**
 * 接入离开 connected 超过此窗口才成文、告警并转红；窗口内的重连抖动不报告。一段中断只成文一次，已报告的中断恢复时再报告恢复及持续时长。
 */
const FEED_OUTAGE_MS = 60_000;



export interface BilibiliWorldOptions {
  roomId: number;
  /** 登录 cookie 的 SESSDATA;空串=匿名接入 */
  sessdata?: string;
  /** 热改:礼物插队门槛(元) */
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
  /**
   * 原始 WS 帧采样落盘路径(jsonl)。不给时从 audienceLedgerFile 推导
   * dataDir 下的 bilibili-raw-samples.jsonl;两者都没有(纯内存测试)则不采样。
   */
  rawSampleFile?: string;
  overlay?: BilibiliOverlayConfig;
  onOverlayConfig?: (config: BilibiliOverlayConfig) => void | Promise<void>;
  agentNoticeMaxChars?: () => number;
  agentNoticeFile?: string;
  overlayAssetDir?: string;
  timezone?: string;
  /** 测试替身:不给就连真直播间 */
  source?: (handlers: LiveHandlers) => LiveSource;
}

/** 长连的最小接口。真实实现是 `LiveClient`,测试注入假的。 */
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
  /** 投递队列溢出告警只报一次,排空后复位以便下次溢出可见。 */
  private liveDropReported = false;
  private rawSampleDropReported = false;

  /** 原始 WS 帧采样落盘路径;null = 不采样(见 rawSampleFile 选项注释) */
  private readonly rawSampleFile: string | null;
  private rawSampleWrites: Promise<void> = Promise.resolve();
  private rawSamplePending = 0;
  private rawSampleDirReady = false;
  /** 落盘失败只报一次,别把一场日志刷满 */
  private rawSampleErrorReported = false;
  /** 本场见过的礼物名;没见过的 SEND_GIFT 采一帧原始 cmd */
  private readonly seenGiftNames = new Set<string>();
  /** 本场已经为"读不出礼物名"留过几帧样(见 UNNAMED_GIFT_SAMPLE_CAP) */
  private unnamedGiftSamples = 0;
  /** 大航海族短窗去重的 recent-map:uid → 最近一条的时刻与档位 */
  private readonly recentGuard = new Map<string, { at: number; guardLevel?: number }>();
  /** 最近一次见过的直播状态沿(WS 指令与轮询双源共用,见 ROOM_EDGE_DEDUP_MS) */
  private lastRoomEdge: { living: boolean; at: number } | null = null;
  /** 最近一次观察到的 living;null = 还没拿到过带 realRoomId 的状态(转沿检测的基线) */
  private lastKnownLiving: boolean | null = null;
  /** 接入 phase 离开 connected 的时刻;null = 已接入或未起。见 FEED_OUTAGE_MS */
  private feedDownSince: number | null = null;
  private feedOutageTimer: ReturnType<typeof setTimeout> | null = null;
  /** 这段中断已成文过;恢复时据此补一条恢复 */
  private feedOutageReported = false;

  /** 待带出的人流读数;发车刻成文后清空 */
  private agg = emptyAggregate();
  /** 已布置的待成文事件挂在总线上的时刻;null = 没挂单。见 ARM_STALE_MS */
  private armedAt: number | null = null;

  /** 控制台用:最近事件的文本投影 */
  private readonly recent: string[] = [];
  /** 记过的总条数(含已被 RECENT_CAP 挤掉的);控制台据此只取自己没见过的那一截 */
  private noteSeq = 0;
  /** 控制台用:各 cmd 计数,没见过的 cmd 也在里面 */
  private readonly cmdCounts = new Map<string, number>();
  /** 最近若干条弹幕是否带 uid;全 false = 服务端在脱敏(多半是 cookie 过期) */
  private readonly identified: boolean[] = [];
  /** 配了 sessdata 却拿到匿名登录态时只报一次,别每次状态回调都刷一条 */
  private anonymousLoginReported = false;
  /** 服务端自报的登录 uid;0 = 匿名。控制台面板据此说清"当前为匿名" */
  private loginUid = 0;
  /** 归并折叠埋点的分钟汇总(见 COALESCE_LOG_WINDOW_MS) */
  private coalesceFolds = 0;
  private coalesceFoldedItems = 0;
  private coalesceLogAt = 0;
  /** 准入筛除累计;控制台面板与日志共用同一份数 */
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
    this.timezone = opts.timezone ?? 'Asia/Shanghai';
    // 装配层没有专门的采样路径入参时,借 audienceLedgerFile(dataDir/bilibili-audience/
    // ledger.json)往上推一层拿 dataDir。纯内存测试两者都不给,自然不落盘。
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
      // 接入、开播、身份与 Overlay 各报一颗灯。
      //
      // 重连中先报黄:抖动会自己回来。超过 FEED_OUTAGE_MS 仍没回来才转红——握手
      // 挂死时它不会自己回来。开播与否不是故障,所以「直播间」那颗在未开播时是灰——
      // 房间在那儿,只是没人在播。
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
    this.liveDropReported = false;
    this.rawSampleWrites = Promise.resolve();
    this.rawSamplePending = 0;
    this.rawSampleErrorReported = false;
    this.rawSampleDropReported = false;
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
    // 最后不满一分钟的那一段折叠账要落下来,不然收尾前的那一批永远没有日志。
    this.flushCoalesceLog(true);
    await this.eventWrites;
    // 只在采样启用时等队列:别给未启用采样的收尾路径平添一个微任务拍
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
          /*
           * 公告板拒绝空串或纯空白，保持内容不变；清空通过 Overlay 编辑器完成。拒绝回执点明入参并保留 warn 计数。
           */
          if (args.text.trim() === '') {
            this.host?.log.warn('bilibili_set_announcement 传入空串,已拒绝执行,公告板未动', {
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

  // ── 消息处理 ─────────────────────────────────────────────────────────────

  private onCmd(msg: Record<string, unknown>): void {
    const cmd = String(msg.cmd ?? '').split(':')[0] || '(无 cmd)';
    this.cmdCounts.set(cmd, (this.cmdCounts.get(cmd) ?? 0) + 1);
    this.maybeSampleRaw(cmd, msg);
    const item = normalize(msg, {
      giftFlushYuan: this.giftFlushYuan(),
      warn: (message, extra) => this.host?.log.warn(message, extra),
    });
    const overlayEvent = projectOverlayEvent(msg, item);
    // 大航海族弹窗经过同 uid 短窗去重后发送，其余事件立即发送。
    const guardFamily = item !== null && item.kind === 'event'
      && (item.type === 'bilibili.guard' || item.type === 'bilibili.guard-renew');
    if (overlayEvent && !guardFamily) this.emitOverlayAudience(overlayEvent);
    const host = this.host;
    if (!host) return;
    if (!item) return;

    if (cmd === 'LIVE') {
      this.admission.startStream({ roomId: this.status?.realRoomId ?? this.opts.roomId });
      this.lastKnownLiving = true;
      // 与轮询短窗去重:轮询先确认过同一个沿时,这条 WS 指令不再重复成文
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

  /**
   * 原始 WS 帧采样:RAW_SAMPLE_DEFAULT_CMDS 名单内的 cmd 每条都采;
   * SEND_GIFT 族只在礼物名读不出或本场没见过时采。原样落盘,不做任何字段裁剪——
   * 这份 jsonl 是「照着猜字段」类修复唯一的回归依据。
   */
  private maybeSampleRaw(cmd: string, msg: Record<string, unknown>): void {
    if (!this.rawSampleFile) return;
    const listed = RAW_SAMPLE_DEFAULT_CMDS.includes(cmd);
    if (!listed) {
      if (cmd !== 'SEND_GIFT' && cmd !== 'SEND_GIFT_V2') return;
      const raw = msg.data !== null && typeof msg.data === 'object'
        ? (msg.data as Record<string, unknown>)
        : {};
      // 礼物名从 protobuf 归一化后的帧读取，避免将 V2 的 data.giftName 缺席误判为每笔都需留样。
      const data = giftFrameData(raw);
      const name = typeof data.giftName === 'string' && data.giftName
        ? data.giftName
        : typeof data.gift_name === 'string' ? data.gift_name : '';
      if (name && this.seenGiftNames.has(name)) return;
      if (name) {
        if (this.seenGiftNames.size >= SEEN_GIFT_NAMES_CAP) return;
        this.seenGiftNames.add(name);
      } else {
        // 读不出名字的照采——那是"布局又变了"唯一的回归依据,但要有量控
        if (this.unnamedGiftSamples >= UNNAMED_GIFT_SAMPLE_CAP) return;
        this.unnamedGiftSamples += 1;
      }
    }
    const file = this.rawSampleFile;
    // 采样落盘队列深度保护:磁盘 I/O 变慢 + 高频弹幕时链会无限增长,超限丢弃新帧并告警一次。
    if (this.rawSamplePending >= RAW_SAMPLE_QUEUE_MAX) {
      if (!this.rawSampleDropReported) {
        this.rawSampleDropReported = true;
        this.host?.log.warn(`原始帧采样落盘队列超过 ${RAW_SAMPLE_QUEUE_MAX},丢弃新帧直到排空`, { cmd });
      }
      return;
    }
    const line = `${JSON.stringify({ ts: nowIso(this.timezone), cmd, msg })}\n`;
    this.rawSamplePending += 1;
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
      })
      .finally(() => {
        this.rawSamplePending -= 1;
        if (this.rawSamplePending === 0) this.rawSampleDropReported = false;
      });
  }

  /**
   * 大航海族同 uid 短窗去重(见 GUARD_DEDUP_WINDOW_MS 注释)。
   * 返回 true = 这条该吞掉。GUARD_BUY 永不吞、永远刷新记账;TOAST 在窗内撞上
   * 同 uid 且 guardLevel 不冲突(任一侧没读出档位也算不冲突)就吞。
   */
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
      this.host?.log.info('大航海 TOAST 与近窗事件同 uid,吞掉', {
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

  /**
   * 布置一条待成文的人流读数。`piggyback` 不叫醒她,也不刷新计时器——搭下一班车,
   * 正文在发车刻才渲染,所以带出去的永远是那一刻的新鲜数。
   * 同时最多布置一条,免得安静期堆一叠陈旧观察;挂单超过 ARM_STALE_MS 没被渲染
   * 视为失踪,允许重挂——渲染是唯一的复位点,丢单不该换来永久沉默。
   * 挂单其实还在(只是久等没发车)时会多出一份:发车刻第一条把读数带走,
   * 余下的渲染出空正文,按投递成文契约整条蒸发,不会重复播报。
   */
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

  /**
   * 归并折叠埋点。`force` 只在收尾时给 true——不然最后不满一分钟的那一段永远不落。
   * 只报数,不作判断:几条原始被折成几条投影,是唯一能事后对上账的事实。
   */
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
    // 队列深度保护:宿主变慢(事件库 I/O 瓶颈)+高频弹幕会让 pendingEventWrites 无限增长致 OOM。
    // 超过上限时丢弃本条并告警一次,保留已排队的投递完成。丢的是最早积压的余量,不是当前这场。
    if (this.pendingEventWrites >= LIVE_WRITE_QUEUE_MAX) {
      if (!this.liveDropReported) {
        this.liveDropReported = true;
        host.log.warn(`直播间事件投递队列超过 ${LIVE_WRITE_QUEUE_MAX},丢弃新到达事件直到排空`, { sourceType: item.type });
      }
      return;
    }
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
        if (this.pendingEventWrites === 0) this.liveDropReported = false;
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
    // 转沿检测只认带 realRoomId 的状态——那才是真读过 Room/get_info 的观察,
    // 接入前的默认 living:false 不算。首个观察只定基线不成文:开播中启动
    // 不该被当成"刚开播"。
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

  /**
   * 记录直播状态沿并按 ROOM_EDGE_DEDUP_MS 去重；返回 true 表示新沿需要成文，同时发送操作员告警。仅报告事实，不自动停止演出或推流。
   */
  private markRoomEdge(living: boolean, via: string): boolean {
    const now = Date.now();
    const last = this.lastRoomEdge;
    this.lastRoomEdge = { living, at: now };
    if (last && last.living === living && now - last.at <= ROOM_EDGE_DEDUP_MS) {
      this.host?.log.info('直播状态沿与近窗已报信号重复,略过成文', {
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
        `[事故] 平台侧直播间已关播(${via}):观众已看不到画面。只报事实,演出与推流的处置留给人`,
        { roomId },
      );
    }
    return true;
  }

  /**
   * 成文投递轮询发现的状态沿；WS 路径由 normalize 的 LIVE/PREPARING 分支成文。明确平台状态及其可观测后果：下播后观众看不到画面，留场聊天不代表仍在播；不添加行为指令。
   */
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

  /** World 自己成文的一条事实(状态沿、接入中断):进控制台面板,再作为顺序屏障投递 */
  private pushNotice(item: LiveEvent): void {
    if (!this.host) return;
    this.note(item.text);
    const pending: PendingLiveEvent = { item, ts: nowIso(this.timezone) };
    this.coalescing.flush('barrier');
    this.pushLiveEvent([pending], pending);
  }

  /**
   * 接入 phase 的中断计时(见 FEED_OUTAGE_MS)。connecting/retrying 之间的往复
   * 不重新计时——一段中断从离开 connected 起算,到回到 connected 为止。
   * stopped 只清计时,不算恢复:停机不是「弹幕又收得到了」。
   */
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

  /** 中断持续到 FEED_OUTAGE_MS 才跑到这里;只报事实:断了多久、在重连、这段弹幕收不到 */
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

  /**
   * 已配置 sessdata 但服务端仍返回匿名登录态时告警。报告认证未生效的事实，不将配置存在视为认证成功。
   */
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
      '配了 worlds.bilibili.sessdata,但服务端返回的登录态是匿名(selfUid=0):观众 uid 会被抹成 0、昵称打码,去更新 sessdata',
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

  /** 最近这一窗弹幕全都没有 uid = 服务端在脱敏 */
  private desensitized(): boolean {
    return this.identified.length > 0 && !this.identified.includes(true);
  }

  private identityLabel(): string {
    if (this.identified.length === 0) return '待观察';
    return this.desensitized() ? '脱敏中(登录凭证可能已过期)' : '可认人';
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

/** 没有任何可报的东西时返回 null——整条蒸发,不占一行 */
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
  // 有一笔金额读不出来,合并后的总额就是不可信的:整条不写 ¥,别拿部分和冒充总额
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
