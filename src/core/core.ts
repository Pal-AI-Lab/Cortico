/** Composition root for framework services and the `Persona`/`CoreApi` boundary. */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  BlobInput,
  BlobRef,
  CognitionHost,
  CognitionRequest,
  CognitionResult,
  EventEnvelope,
  EventOrigin,
  CoreConfig,
  ForkOptions,
  CoreApi,
  World,
  WorldHost,
  LLMProviderEntry,
  LLMUsage,
  Logger,
  ModelFacts,
  ModelSpec,
  Persona,
  PushOptions,
  SessionDecl,
  SessionInfo,
} from './types.ts';
import type { LoadedConfig } from './config.ts';
import { Runlog, estimateMessagesTokens, nowIso, withDeadline } from './util.ts';
import { JsonlEventStore } from './event-store.ts';
import { WakeBus } from './bus.ts';
import { SessionLog } from './session.ts';
import { CoreState } from './state.ts';
import { ProviderRegistry } from '../providers/registry.ts';
import { runForkLoop } from './fork.ts';
import { providerModule, providerModules } from '../providers/registry.ts';
import { LogBlobStore, blobScheme, mimeOfHandle, withBlobLines } from './blobs.ts';
import { TimerStore } from './timers.ts';
import { SessionTracker, type SessionHandle } from './sessions.ts';
import { UsageLog } from './usage-log.ts';
import { ToolCallLog } from './tool-log.ts';
import { Transcript } from './transcript.ts';
import { openRun, writeRunJson, type RunInfo } from './run.ts';
import { currentAnchors } from './log-context.ts';
import { MainLoop, type ContextFacts } from './loop.ts';
import type { ResponseClient } from './generation.ts';

/** 单个 World 的停止期限；失败或超时写入结果，其他停止操作继续。 */
const MODULE_STOP_MS = 20_000;
/** 主循环收到 abort 后用于落完已外化片段的期限。 */
const LOOP_DRAIN_MS = 1_000;
/**
 * 隐藏 World 仍推送事件时，首条及每隔此周期报告一次。可见性开关跨重启保留。
 */
const HIDDEN_PUSH_NOTE_GAP_MS = 10 * 60_000;

export interface CoreDeps {
  persona: Persona;
  worlds: World[];
  llm?: ResponseClient;
}

export interface WorldStopFailure {
  worldId: string;
  detail: string;
}

export class Core<C extends CoreConfig = CoreConfig> {
  readonly loaded: LoadedConfig<C>;
  /** 本次进程运行的标识与日志目录。 */
  readonly run: RunInfo;
  readonly runlog: Runlog;
  readonly transcript: Transcript;
  readonly store: JsonlEventStore;
  readonly bus: WakeBus;
  readonly session: SessionLog;
  readonly state: CoreState;
  readonly timers: TimerStore;
  readonly loop: MainLoop;
  readonly llm: ResponseClient;
  /** 媒体库：字节保存在 data/media/，回执与事件只存引用。 */
  readonly logBlobs: LogBlobStore;
  /** 各agent session的观察注册表(web面板数据源) */
  readonly sessions: SessionTracker;
  /** 每次LLM调用的持久化流水(跨重启;用量·成本页数据源) */
  readonly usageLog: UsageLog;
  /** 主循环每次模型工具调用的持久化流水(工具名/原始参数/耗时/回执) */
  readonly toolLog: ToolCallLog;
  /** Persona注册的 session 声明;core 只按 id 查表,不对值分支 */
  readonly sessionDecls = new Map<string, SessionDecl>();
  /** 挂载表。与装配层共用同一个数组:运行中挂载/卸载就地增删。 */
  private worlds: World[];
  private persona: Persona;
  private log: Logger;
  private runPromise: Promise<void> | null = null;
  /** start() 已跑过 World 启动循环;之后挂载的 World 立即 start,之前的等 start() 统一起。 */
  private started = false;
  /** 每个声明当前运行的 fork 实例数，用于并发记账。 */
  private readonly forkRunning = new Map<string, number>();
  /** 各 World 在途的认知请求数；并发限制由 Persona 决定。 */
  private readonly cognitionRunning = new Map<string, number>();
  /** 接收事件的主 session 声明。 */
  private readonly mainDecl: SessionDecl;
  /** World 自愿上报用量的常驻仪表条目(每 World 一条) */
  private readonly moduleUsageTracks = new Map<string, SessionHandle>();
  /** 隐藏 World 照常落库的事件计数与上次回报时刻(每 World 一条) */
  private readonly hiddenPushes = new Map<string, { count: number; notedAtMs: number }>();
  readonly providers: ProviderRegistry;
  private readonly moduleHostLeases = new Map<World, { active: boolean }>();

  constructor(loaded: LoadedConfig<C>, deps: CoreDeps) {
    this.loaded = loaded;
    const cfg = loaded.config;
    const dataDir = loaded.dataDir;
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

    this.run = openRun(dataDir, { timezone: cfg.timezone, bot: cfg.displayName, repoRoot: loaded.repoRoot });
    this.runlog = new Runlog(join(this.run.dir, 'log.jsonl'), {
      run: this.run.id,
      timezone: cfg.timezone,
      levels: () => cfg.logging,
      incidentsDir: join(this.run.dir, 'incidents'),
    });
    this.log = this.runlog.logger('core');
    this.store = new JsonlEventStore({ dataDir, run: this.run.id, log: this.log.child('store') });
    // WakeBus 持有只读配置引用，使 batching 热更新对后续 push 生效。
    this.bus = new WakeBus(cfg.batching, this.log.child('bus'));
    this.session = new SessionLog(dataDir, 'session-main.jsonl', () => nowIso(cfg.timezone));
    this.transcript = new Transcript(join(this.run.dir, 'transcript.jsonl'), { run: this.run.id, timezone: cfg.timezone });
    this.session.onAppend((record, index) => this.transcript.item(record, index));
    this.state = new CoreState(dataDir);
    // 先 load 再 attach：load 会整体替换状态对象，Persona首次调用 personaState() 时必须拿到已加载的状态。
    this.state.load();
    this.worlds = deps.worlds;
    this.persona = deps.persona;
    this.logBlobs = new LogBlobStore(dataDir);
    this.providers = new ProviderRegistry(() => cfg.providers, {
      // 同一部署根下的部署共享端点配置和状态目录。
      stateRoot: loaded.providersDir ?? join(loaded.rootDir, 'providers'),
      repoRoot: loaded.repoRoot ?? process.cwd(),
      readBlob: (handle) => {
        const bytes = this.resolveBlob(handle)?.bytes;
        return bytes ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
      },
      keepThinking: () => cfg.context.keepPastThinking,
      log: this.log.child('llm'),
    });
    this.llm = deps.llm ?? this.makeProviderRouter();

    // TimerStore 仅提供通用持久定时器；Persona定义心跳与闹钟语义。
    this.timers = new TimerStore(dataDir, this.log.child('timer'));

    this.usageLog = new UsageLog(join(dataDir, 'usage.jsonl'), message => this.log.error(message));
    this.toolLog = new ToolCallLog(join(this.run.dir, 'toolcalls.jsonl'), { timezone: cfg.timezone, run: this.run.id });
    this.sessions = new SessionTracker(cfg.timezone, (rec) => {
      const { round } = currentAnchors();
      this.usageLog.append({ ...rec, run: this.run.id, ...(round !== undefined ? { round } : {}) });
    });

    // attach 必须先于 declareSessions，后者会将工具 handler 绑定到 CoreApi。
    this.persona.attach(this.makeApi());
    const decls = this.persona.declareSessions();
    for (const decl of decls) this.sessionDecls.set(decl.id, decl);
    const main = decls.filter((d) => d.receivesEvents && d.persistent);
    if (main.length !== 1) {
      throw new Error(
        `Persona必须恰好声明一个接收事件投递的常驻session,当前${main.length}个`,
      );
    }

    this.mainDecl = main[0];
    this.loop = new MainLoop({
      cfg,

      llm: this.llm,
      persona: deps.persona,
      decl: main[0],
      spec: () => this.activeSpec(),
      context: this.contextFacts(),
      blobs: { intern: (inputs) => this.internBlobs(inputs) },
      worlds: {
        all: () => this.worlds,
        visible: () => this.worlds.filter((m) => this.isWorldVisible(m.id)),
      },
      dirs: { packageDir: loaded.packageDir ?? loaded.rootDir, deploymentDir: loaded.rootDir },
      bus: this.bus,
      session: this.session,
      store: this.store,
      state: this.state,
      log: this.log.child('loop'),
      tracker: this.sessions,
      toolLog: this.toolLog,
      transcript: this.transcript,
      toolOwner: (name) => this.worlds.find((m) => m.tools().some((t) => t.name === name))?.id,
    });
    this.bus.setPreemptHandler(() => {
      this.loop.abortCurrentRound();
    });
  }

  private makeApi(): CoreApi {
    return {
      injectInternal: (text, kind) => this.loop.injectInternal(text, kind),
      injectDeferred: (kind, render) => this.loop.injectDeferred(kind, render),
      injectExternal: (text, kind) => this.loop.injectExternal(text, kind),
      requestContextHandoff: () => this.loop.requestContextHandoff(),
      spawnFork: (opts) => this.spawnFork(opts),
      sessionInfo: (id) => this.sessionInfo(id),
      llm: this.llm,
      timers: this.timers,
      deliveryGate: {
        set: (gate) => this.bus.setDeliveryGate(gate),
        clear: (id, deliverQueued) => this.bus.clearDeliveryGate(id, deliverQueued),
        isBlocked: () => this.bus.isDeliveryBlocked(),
      },
      personaState: () => this.state.data.persona,
      savePersonaState: () => this.state.save(),
      toolsTagged: (tag) =>
        new Set(this.loop.getToolSchemas().filter((t) => t.tags.includes(tag)).map((t) => t.name)),
      blob: (handle) => this.resolveBlob(handle),
      log: this.log.child('persona'),
    };
  }

  /**
   * 按 scheme 解析句柄:`log:` 查日志附件库,`mem:` 问Persona的记忆。
   * 认不出或不在 → null。
   */
  resolveBlob(handle: string): { bytes: Uint8Array; mime: string } | null {
    const scheme = blobScheme(handle);
    if (scheme === 'log') return this.logBlobs.read(handle);
    if (scheme === 'mem') return this.persona.blobs.get(handle);
    return null;
  }

  /**
   * 新附件字节写入日志附件库并转换为 log: 句柄；已有句柄补充 mime 和名称。
   * 无附件时返回 undefined，避免保存空数组。
   */
  internBlobs(inputs: readonly (BlobInput | BlobRef)[] | undefined): BlobRef[] | undefined {
    if (!inputs || inputs.length === 0) return undefined;
    return inputs.map((input) => {
      if ('bytes' in input) {
        const handle = this.logBlobs.put(input.bytes, input.mime);
        return { handle, mime: input.mime, ...(input.name ? { name: input.name } : {}), fallbackText: input.fallbackText };
      }
      const known = 'mime' in input ? input : null;
      const resolved = known ? null : this.resolveBlob(input.handle);
      const mime = known?.mime ?? resolved?.mime ?? mimeOfHandle(input.handle);
      const name = known?.name ?? input.handle.slice(input.handle.lastIndexOf('/') + 1).replace(/^[a-z]+:/, '');
      return { handle: input.handle, mime, name, fallbackText: input.fallbackText };
    });
  }

  /** 丢弃已发生的事件与候选票据；历史保留，重启不再补投。 */
  discardPendingEvents(): number {
    const dropped = this.bus.drainPending((item) =>
      item.event !== undefined || item.candidate !== undefined);
    this.loop.acknowledgeDiscarded(
      dropped.flatMap((item) => item.event ? [item.event] : []),
    );
    return dropped.length;
  }

  private sessionInfo(id: string): SessionInfo {
    const decl = this.sessionDecls.get(id);
    const isMainLoop = decl?.persistent === true && decl.receivesEvents;
    const gauge = isMainLoop ? this.loop.contextGauge() : null;
    return {
      id,
      running: this.forkRunning.get(id) ?? 0,
      // 包含合成首轮对话，使继承该快照的 fork 使用相同的请求前缀。
      snapshot: isMainLoop ? this.loop.outboundMessages() : null,
      estTokens: gauge?.estTokens ?? null,
      hardTokens: gauge?.hardTokens ?? null,
    };
  }

  /**
   * 生效上下文窗口:Provider 实例探到的上游自报值与档位手填值取小。两者都缺席时
   * undefined——core 不猜窗口。
   */
  private contextWindowOf(spec: ModelSpec): number | undefined {
    const { name } = this.activeProviderEntry();
    const detected = this.providers.resolve(name).contextWindow?.(spec.model);
    const manual = spec.contextWindow;
    if (detected === undefined) return manual;
    return manual === undefined ? detected : Math.min(detected, manual);
  }

  /** 按当前活跃端点读取模型上下文事实。 */
  private contextFacts(): ContextFacts {
    const module = () => {
      const entry = this.config.providers[this.config.activeProvider];
      return entry ? providerModules.find(module => module.id === entry.kind) : undefined;
    };
    return {
      hardTokens: () => {
        if (!module() || !this.config.providers[this.config.activeProvider]?.spec) return null;
        const spec = this.activeSpec();
        const window = this.contextWindowOf(spec);
        return window === undefined ? null : Math.max(0, window - (spec.maxTokens ?? 0));
      },
      estimateTokens: (records) => module()?.estimateTokens?.(records, this.activeSpec()) ?? estimateMessagesTokens(records),
      contextOverflow: (error) => module()?.contextOverflow?.(error) ?? false,
    };
  }

  /**
   * 创建临时 session；在创建时绑定当前活跃端点与模型，工具和轮数来自声明或调用参数。
   * 记录并发数与用量；并发限制由 Persona 决定。
   */
  async spawnFork(opts: ForkOptions): Promise<string> {
    const decl = this.sessionDecls.get(opts.id);
    if (!decl) throw new Error(`未声明的session: ${opts.id}`);
    let observedMessages = opts.messages;
    const track = this.sessions.open(decl.id, decl.label, {
      messagesRef: () => observedMessages,
    });
    this.forkRunning.set(decl.id, (this.forkRunning.get(decl.id) ?? 0) + 1);
    let bound: ResponseClient | undefined;
    try {
      bound = this.llm.bind?.() ?? this.llm;
      return await runForkLoop({
        id: decl.id,
        llm: bound,
        spec: this.activeSpec(),
        messages: opts.messages,
        tools: opts.tools ?? decl.tools(),
        maxRounds: decl.rounds().hard,
        softRounds: decl.rounds().soft,
        log: this.log.child(`fork.${decl.id}`),
        stopWhen: opts.stopWhen,
        wrapUpHint: opts.wrapUpHint,
        capNote: opts.capNote,
        nudge: opts.nudge,
        track,
        observeMessages: (messages) => {
          observedMessages = messages;
        },
      });
    } finally {
      bound?.release?.();
      this.forkRunning.set(decl.id, Math.max(0, (this.forkRunning.get(decl.id) ?? 1) - 1));
      track.close();
    }
  }

  /**
   * Persona 提供且启用 cognition 时，WorldHost 才提供该接口。
   * 请求只能列出该 World 的工具；不合法的请求返回错误，不调用 Persona。
   * Core 记录在途数供 Persona 决定并发策略。经 spawnFork 产生的用量在 fork 中记录，此处不重复计量。
   */
  private makeCognition(mod: World, active: () => boolean): CognitionHost | undefined {
    const impl = this.persona.cognition;
    if (!impl) return undefined;
    if (impl.enabled && !impl.enabled()) return undefined;
    const log = this.runlog.logger(`worlds.${mod.id}`);
    return {
      request: async (req: CognitionRequest): Promise<CognitionResult> => {
        if (!active()) return { error: '宿主生命周期已结束' };
        const brief = typeof req?.brief === 'string' ? req.brief.trim() : '';
        if (!brief) return { error: '认知请求没有 brief:要想的是什么,得由 World 自己说清楚' };
        const own = new Set(mod.tools().map((t) => t.name));
        const named = req.tools ?? [];
        const outsiders = named.filter((name) => !own.has(name));
        if (outsiders.length > 0) {
          log.warn('认知请求越权点名工具,已驳回', { tools: outsiders });
          return {
            error:
              `认知请求只能点名本 World 自己的工具,这些不是: ${outsiders.join(' / ')}` +
              `(本 World 现有: ${[...own].join(' / ') || '(无)'})`,
          };
        }
        const tools = named.map((name) => mod.tools().find((t) => t.name === name)!);
        const running = (this.cognitionRunning.get(mod.id) ?? 0) + 1;
        this.cognitionRunning.set(mod.id, running);
        try {
          return await impl.request({ ...req, brief }, { worldId: mod.id, tools, running });
        } catch (e) {
          // Persona 异常转换为请求错误，返回 World。
          log.warn('认知请求受理失败', { err: e });
          return { error: e instanceof Error ? e.message : String(e) };
        } finally {
          this.cognitionRunning.set(mod.id, Math.max(0, (this.cognitionRunning.get(mod.id) ?? 1) - 1));
        }
      },
    };
  }

  /** 各 World 当下在途的认知外包请求数(控制台/诊断用;没有在途的 World 不出现) */
  cognitionInFlight(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, n] of this.cognitionRunning) if (n > 0) out[id] = n;
    return out;
  }

  get config() {
    return this.loaded.config;
  }


  /**
   * World 隐藏后继续运行，事件仅归档且重新显示时不补投。
   * 事件投递立即停止；环境前缀与工具表在下一次前缀重建时一同更新。
   */
  setWorldVisible(id: string, visible: boolean): void {
    if (!this.worlds.some((m) => m.id === id)) throw new Error(`未挂载的 World: ${id}`);
    this.state.data.worldVisibility[id] = visible;
    this.state.save();
    this.log.warn(`World 对 agent ${visible ? '可见' : '隐藏'}: ${id}`);
  }

  isWorldVisible(id: string): boolean {
    return this.state.data.worldVisibility[id] !== false;
  }

  /** 隐藏 World 的推送按 HIDDEN_PUSH_NOTE_GAP_MS 限频报告，计数保留在日志中。 */
  private noteHiddenPush(id: string): void {
    const note = this.hiddenPushes.get(id) ?? { count: 0, notedAtMs: 0 };
    note.count += 1;
    this.hiddenPushes.set(id, note);
    const now = Date.now();
    if (note.notedAtMs > 0 && now - note.notedAtMs < HIDDEN_PUSH_NOTE_GAP_MS) return;
    note.notedAtMs = now;
    this.log.warn(
      `隐藏 World 的事件仅归档: ${id}(本轮第 ${note.count} 条)。需要投递时请开启该 World 的可见性`,
    );
  }

  /** 全部已挂载 World 的可见性 + 前缀是否已经跟上 */
  worldVisibility(): { visibility: Record<string, boolean>; driftedWorlds: string[] } {
    const visibility: Record<string, boolean> = {};
    for (const mod of this.worlds) visibility[mod.id] = this.isWorldVisible(mod.id);
    return { visibility, driftedWorlds: this.loop.modulePrefixDrift() };
  }

  /** 用于控制台状态和启动信息的当前模型配置。 */
  mainSessionSpec(): ModelSpec {
    return this.activeSpec();
  }

  /** 按 activeProvider 读取模型配置；端点未配置模型时抛错。 */
  activeSpec(): ModelSpec {
    const { name, entry } = this.activeProviderEntry();
    if (!entry.spec) {
      throw new Error(`LLM provider ${name} 还没选模型(去控制台该 Provider 的「实例与模型」面板填模型名并保存)`);
    }
    return entry.spec;
  }

  activeProviderEntry(): { name: string; entry: LLMProviderEntry } {
    const cfg = this.loaded.config;
    const name = cfg.activeProvider;
    const entry = cfg.providers?.[name];
    if (!entry) {
      const known = Object.keys(cfg.providers ?? {}).join(' / ') || '(空)';
      throw new Error(`没有这个 LLM provider: ${name}(config.json providers 段现有: ${known})`);
    }
    return { name, entry };
  }

  /** The selected instance is resolved once at the start of each request. */
  private makeProviderRouter(): ResponseClient {
    const bind = (): ResponseClient => this.providers.bind(this.activeProviderEntry().name);
    return { bind, respond: async (request, options) => {
      const client = bind();
      try { return await client.respond(request, options); } finally { client.release?.(); }
    } };
  }

  /** 模型事实(按当前活跃端点实时读,不做启动期快照) */
  private modelFacts(): ModelFacts {
    const spec = (): ModelSpec => this.activeSpec();
    return {
      model: () => spec().model,
      accepts: (mime) => {
        if (!this.loaded.config.activeProvider) return false;
        const {entry} = this.activeProviderEntry();
        if (!entry.spec) return false;
        return providerModule(entry.kind).accepts?.(entry,entry.spec,mime) ?? (entry.multimodal === true && mime.startsWith('image/'));
      },
      contextWindow: () => this.contextWindowOf(spec()),
    };
  }

  /** World 宿主接口;每个 World 使用以自身 id 命名的子 logger。 */
  private makeHost(mod: World): WorldHost {
    const previous = this.moduleHostLeases.get(mod);
    if (previous) previous.active = false;
    const lease = { active: true };
    this.moduleHostLeases.set(mod, lease);
    // getter 的 this 是 WorldHost；通过 self 访问 Core。
    const self = this;
    return {
      // origin 由 World 指定，默认 external；决定后续投递方式。
      pushEvent: async (
        e: Omit<EventEnvelope, 'cursor' | 'origin' | 'contextDelivery'> & { origin?: EventOrigin },
        opts?: PushOptions,
      ): Promise<EventEnvelope> => {
        if (!lease.active) throw new Error(`World ${mod.id} 的宿主生命周期已结束`);
        const deliver = opts?.deliver !== false && this.isWorldVisible(mod.id);
        const blobs = this.internBlobs(e.blobs);
        const envelope = this.store.append({
          ...e,
          text: withBlobLines(e.text, blobs),
          ...(blobs ? { blobs } : {}),
          origin: e.origin ?? 'external',
          contextDelivery: deliver ? 'deliver' : 'archive-only',
        });
        // 隐藏 World 的事件仍归档，不投递。
        if (deliver) {
          this.bus.push({ event: envelope }, { trigger: opts?.trigger });
        } else {
          // 仅归档事件不会经过候选处理，必须在此标记已处理以推进投递水位。
          this.loop.acknowledgeDiscarded([envelope]);
          if (opts?.deliver !== false) this.noteHiddenPush(mod.id);
        }
        return envelope;
      },
      pushDeferred: (e, opts) => {
        if (!lease.active) return;
        // 隐藏 World 的延迟渲染项没有正文，直接丢弃。
        if (!this.isWorldVisible(mod.id)) return;
        this.bus.push(
          { deferred: { ...e, source: mod.id, origin: e.origin ?? 'external' } },
          { trigger: opts?.trigger },
        );
      },
      pushCandidate: async (spec, opts) => {
        if (!lease.active) throw new Error(`World ${mod.id} 的宿主生命周期已结束`);
        if (spec.sourceEvents.length === 0) throw new Error('候选票据至少需要一条原始事件');
        const origin = spec.origin ?? 'external';
        const sourceEvents = spec.sourceEvents.map((event) => this.store.append({
          ...event,
          source: mod.id,
          origin,
          contextDelivery: 'archive-only',
        }));
        if (this.isWorldVisible(mod.id)) {
          this.bus.push({
            candidate: {
              source: mod.id,
              origin,
              sourceEvents,
              gateText: spec.gateText,
              value: spec.value,
              project: spec.project,
            },
          }, { trigger: opts?.trigger });
        } else {
          // 隐藏的候选不再生成投递内容，立即标记归档事件已处理。
          this.loop.acknowledgeDiscarded(sourceEvents);
        }
        return sourceEvents;
      },
      store: this.store,
      drainPendingEvents: async (filter) => {
        if (!lease.active) return [];
        const taken = this.bus
          .drainPending((it) => it.event?.origin === 'external' && filter(it.event))
          .map((it) => it.event as EventEnvelope);
        // 被消费的事件须标记已处理，避免投递水位停留在此并在重启后补投。
        if (taken.length > 0) this.loop.acknowledgeDiscarded(taken);
        return taken;
      },
      modelFacts: this.modelFacts(),
      blob: (handle) => this.resolveBlob(handle),
      reportUsage: (usage, opts) => {
        if (lease.active) this.reportWorldUsage(mod.id, usage, opts);
      },
      llmStalls: async (withinMs) => this.loop.llmStalls(withinMs),
      // 每次访问重新检查 Persona 开关，关闭后 getter 立即返回 undefined。
      get cognition(): CognitionHost | undefined {
        return lease.active ? self.makeCognition(mod, () => lease.active) : undefined;
      },
      log: this.runlog.logger(`worlds.${mod.id}`),
    };
  }

  /**
   * World 上报的用量按 `worlds.<World>` 仪表项计入 session 统计和 usage.jsonl。
   * 用量标签不携带模型用途语义。
   */
  private reportWorldUsage(
    worldId: string,
    usage: LLMUsage,
    opts?: { model?: string; label?: string; charges?: import('./generation.ts').Charge[] },
  ): void {
    const id = `worlds.${worldId}`;
    let track = this.moduleUsageTracks.get(id);
    if (!track) {
      track = this.sessions.open(id, opts?.label ?? `${worldId}World 自带模型`, { id });
      this.moduleUsageTracks.set(id, track);
    }
    track.record(usage, undefined, opts?.model, { charges: opts?.charges });
  }

  async start(): Promise<void> {
    const dataDir = this.loaded.dataDir;
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    // 构造期已加载状态；此处再次 load 会覆盖装配后、启动前的修改。
    const repair = this.session.load();
    if (repair) {
      this.log.warn(
        repair.kind === 'torn-tail' ? 'session 末行未写完,已截掉' : 'session 末行缺换行,已补上',
        { ...repair, file: 'session-main.jsonl' },
      );
    }
    for (const mod of this.worlds) {
      try {
        await mod.start(this.makeHost(mod));
      } catch (error) {
        const lease = this.moduleHostLeases.get(mod);
        if (lease) lease.active = false;
        try { await withDeadline(mod.stop(), MODULE_STOP_MS); } catch (cleanup) { this.log.warn(`World 启动失败后的清理未完成: ${mod.id}`, { err: String(cleanup) }); }
        throw error;
      }
      this.log.info(`World 已启动: ${mod.id}`);
    }
    this.started = true;
    if (this.worlds.length === 0) this.log.warn('没有挂载任何 World:agent 收不到外部事件');
    this.timers.start();
    this.runPromise = this.loop.run().catch((e) => {
      this.timers.stop();
      this.log.error('主循环异常退出', { err: e });
    });
    writeRunJson(this.run, {
      bot: this.loaded.config.displayName,
      worlds: this.worlds.map((m) => m.id),
      activeProvider: this.loaded.config.activeProvider,
    });
    this.log.emit('info', 'core已启动', { event: 'started', data: { run: this.run.id } });
  }

  /** 先终止主循环，再并发停止 World；各步骤有独立期限，失败写入返回结果。 */
  /**
   * 运行中挂载一个 World:入表,core 已启动则立即 start,并重建 system 前缀
   * (环境提示词段与工具表同属缓存前缀,挂载必须连带换掉)。start 抛错时不入表。
   */
  async mountWorld(mod: World): Promise<void> {
    if (this.worlds.some((m) => m.id === mod.id)) throw new Error(`World 已挂载: ${mod.id}`);
    if (this.started) {
      try {
        await mod.start(this.makeHost(mod));
      } catch (error) {
        const lease = this.moduleHostLeases.get(mod);
        if (lease) lease.active = false;
        try { await withDeadline(mod.stop(), MODULE_STOP_MS); } catch (cleanup) { this.log.warn(`World 启动失败后的清理未完成: ${mod.id}`, { err: String(cleanup) }); }
        throw error;
      }
      this.log.info(`World 已启动: ${mod.id}`);
    }
    this.worlds.push(mod);
    if (this.started) await this.loop.reloadSystemPrefix();
  }

  /** 停止 World 后使租约失效、移出挂载表并重建前缀；停止失败或超时仍继续卸载。 */
  async unmountWorld(id: string): Promise<WorldStopFailure | null> {
    const index = this.worlds.findIndex((m) => m.id === id);
    if (index < 0) throw new Error(`未挂载的 World: ${id}`);
    const mod = this.worlds[index];
    let failure: WorldStopFailure | null = null;
    if (this.started) {
      try {
        await withDeadline(mod.stop(), MODULE_STOP_MS);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        this.log.warn(`World 停止失败: ${mod.id}`, { err: detail });
        failure = { worldId: mod.id, detail };
      }
    }
    const lease = this.moduleHostLeases.get(mod);
    if (lease) lease.active = false;
    this.worlds.splice(this.worlds.indexOf(mod), 1);
    this.log.info(`World 已卸载: ${mod.id}`);
    if (this.started) await this.loop.reloadSystemPrefix();
    return failure;
  }

  async stop(): Promise<WorldStopFailure[]> {
    this.started = false;
    this.loop.stop();
    this.timers.stop();
    const failures: WorldStopFailure[] = [];
    if (this.runPromise) {
      try {
        await withDeadline(this.runPromise, LOOP_DRAIN_MS, '主循环终止');
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        this.log.warn('主循环未在关机期限内结束', { err: detail });
        failures.push({ worldId: 'core.loop', detail });
      } finally {
        this.loop.seal();
        this.runPromise = null;
      }
    } else {
      this.loop.seal();
    }
    const moduleFailures = (await Promise.all(this.worlds.map(async (mod): Promise<WorldStopFailure | null> => {
      try {
        await withDeadline(mod.stop(), MODULE_STOP_MS);
        return null;
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        this.log.warn(`World 停止失败: ${mod.id}`, { err: detail });
        return { worldId: mod.id, detail };
      } finally {
        const lease = this.moduleHostLeases.get(mod);
        if (lease) lease.active = false;
      }
    }))).filter((failure): failure is WorldStopFailure => failure !== null);
    failures.push(...moduleFailures);
    this.usageLog.flush();
    const ledger = this.usageLog.status();
    if (ledger.pending) failures.push({ worldId: 'core.usage', detail: `${ledger.pending} usage records remain unwritten: ${ledger.error}` });
    this.log.info('core已停止');
    return failures;
  }
}
