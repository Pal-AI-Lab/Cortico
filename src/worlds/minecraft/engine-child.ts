/** Minecraft 引擎子进程入口。创建 World 并通过 IPC 接收配置和工具请求，向主进程转发事件及 Core 请求。 */
import { createIpcLogger } from '../../core/ipc-logger.ts';
import { withAnchors } from '../../core/log-context.ts';
import { MinecraftWorld } from './world.ts';
import type {
  ChildToMain,
  CognitionReply,
  EngineInit,
  EngineRequest,
  HostRequest,
  MainToChild,
  StorageStat,
} from './engine-ipc.ts';
import type {
  EventEnvelope,
  EventStoreReader,
  WorldHost,
  Logger,
  StoragePart,
  DeferredRendered,
} from '../../core/types.ts';

function send(msg: ChildToMain): void {
  process.send?.(msg);
}

const makeLogger = (area: string): Logger => createIpcLogger((note) => send({ t: 'note', note }), area);

const log = makeLogger('');

const HOST_RPC_TIMEOUT_MS = 10_000;
/** 认知请求的 RPC 超时为 16 分钟。 */
const COGNITION_RPC_TIMEOUT_MS = 16 * 60_000;
let nextHostReqId = 1;
const pendingHost = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

function hostRpc(req: HostRequest, timeoutMs = HOST_RPC_TIMEOUT_MS): Promise<unknown> {
  const id = nextHostReqId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingHost.delete(id);
      reject(new Error(`主进程 ${timeoutMs / 1000}s 未回执宿主调用(${req.kind})`));
    }, timeoutMs);
    timer.unref?.();
    pendingHost.set(id, { resolve, reject, timer });
    send({ t: 'hreq', id, req });
  });
}

/** 同步 Core 接口不能经异步 IPC 调用，使用时抛错。 */
const unavailable = (what: string): never => {
  throw new Error(`${what} 在子进程宿主里不可用`);
};

const store: EventStoreReader = {
  get: () => unavailable('store.get'),
  latestCursor: () => unavailable('store.latestCursor'),
  range: () => unavailable('store.range'),
  around: () => unavailable('store.around'),
  grep: () => unavailable('store.grep'),
};

/** 按事件类型保存延迟渲染回调。 */
const textRender = (render: () => DeferredRendered | null | Promise<DeferredRendered | null>) =>
  async (): Promise<string | null> => {
    const out = await render();
    return out === null || typeof out === 'string' ? out : out.text;
  };
const deferredRenders = new Map<string, () => Promise<string | null>>();

let cognitionOn = false;

/** 跨进程请求失败返回含 error 的结果。 */
const cognitionHost: NonNullable<WorldHost['cognition']> = {
  request: async (req) => {
    try {
      return (await hostRpc({ kind: 'cognition', req }, COGNITION_RPC_TIMEOUT_MS)) as CognitionReply;
    } catch (e) {
      return { error: `后台思考没跑成:${e instanceof Error ? e.message : String(e)}` };
    }
  },
};

const host: WorldHost = {
  pushEvent: (e, opts) => hostRpc({ kind: 'push', evt: e as Parameters<typeof host.pushEvent>[0] & { blobs?: undefined }, opts }) as Promise<EventEnvelope>,
  pushDeferred: (e, opts) => {
    deferredRenders.set(e.type, textRender(e.render));
    send({
      t: 'note',
      note: {
        kind: 'arm-deferred',
        type: e.type,
        ...(e.senderKey !== undefined ? { senderKey: e.senderKey } : {}),
        ...(e.meta !== undefined ? { meta: e.meta } : {}),
        ...(e.tags !== undefined ? { tags: e.tags } : {}),
        ...(opts?.trigger !== undefined ? { trigger: opts.trigger } : {}),
      },
    });
  },
  store,
  drainPendingEvents: () => hostRpc({ kind: 'drain' }) as Promise<EventEnvelope[]>,
  modelFacts: {
    model: () => unavailable('modelFacts.model'),
    accepts: () => unavailable('modelFacts.accepts'),
    contextWindow: () => unavailable('modelFacts.contextWindow'),
  },
  blob: () => unavailable('blob'),
  reportUsage: (usage, opts) => send({ t: 'note', note: { kind: 'usage', usage, opts } }),
  /** 能力随配置消息更新。 */
  get cognition(): WorldHost['cognition'] {
    return cognitionOn ? cognitionHost : undefined;
  },
  log,
};

let mod: MinecraftWorld | null = null;
let cfg: EngineInit['cfg'] | null = null;
let statusTimer: ReturnType<typeof setInterval> | null = null;
let lastStatus = '';

function applyCfg(target: Record<string, unknown>, next: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(next)) {
    const cur = target[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      applyCfg(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      target[k] = v;
    }
  }
}

function storageStats(parts: StoragePart[]): StorageStat[] {
  return parts.map((p) => {
    let stat = '';
    try {
      stat = p.stat();
    } catch {
      stat = '(取不到)';
    }
    return {
      key: p.key,
      label: p.label,
      kind: p.kind,
      location: p.location,
      danger: p.danger,
      note: p.note,
      order: p.order,
      stat,
    };
  });
}

function pushStatus(): void {
  if (!mod) return;
  const decl = mod.console();
  const note = {
    kind: 'status' as const,
    decl: { lamps: decl.lamps, badges: decl.badges, links: decl.links },
    storage: storageStats(decl.storage ?? []),
  };
  const key = JSON.stringify(note);
  if (key === lastStatus) return;
  lastStatus = key;
  send({ t: 'note', note });
}

async function handleRequest(req: EngineRequest): Promise<unknown> {
  if (req.kind === 'init') {
    if (mod) throw new Error('已经 init 过了');
    cfg = req.init.cfg;
    mod = new MinecraftWorld({
      cfg,
      timezone: req.init.timezone,
      botName: req.init.botName,
      ...(req.init.dataDir ? { dataDir: req.init.dataDir } : {}),
    });
    await mod.start(host);
    statusTimer = setInterval(pushStatus, 1000);
    statusTimer.unref?.();
    return null;
  }
  if (req.kind === 'shutdown') {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = null;
    await mod?.stop();
    mod = null;
    setImmediate(() => process.exit(0));
    return null;
  }
  if (req.kind === 'render-deferred') {
    /** 渲染失败返回 null。 */
    const render = deferredRenders.get(req.type);
    return render ? await render() : null;
  }
  if (!mod) throw new Error('Minecraft 引擎还没 init');
  if (req.kind === 'tool') {
    const tool = mod.tools().find((t) => t.name === req.name);
    if (!tool) throw new Error(`未知工具「${req.name}」`);
    return withAnchors({ sess: req.role, ...(req.callId ? { call: req.callId } : {}), ...(req.round !== null ? { round: req.round } : {}) }, () => tool.handler(req.args, {
      role: req.role,
      log,
      ...(req.callId ? { callId: req.callId } : {}),
      ...(req.round !== null ? { round: req.round } : {}),
    }));
  }
  if (req.kind === 'storage-clear') {
    const part = (mod.console().storage ?? []).find((p) => p.key === req.key);
    if (!part) throw new Error(`未知存储部分: ${req.key}`);
    return part.clear();
  }
  const invoke = mod.console().invoke;
  if (!invoke) throw new Error('World 没有面板调用面');
  return invoke(req.panel, req.method, req.args);
}

process.on('message', (msg: MainToChild) => {
  if (msg.t === 'req') {
    void Promise.resolve()
      .then(() => handleRequest(msg.req))
      .then(
        (value) => send({ t: 'rep', id: msg.id, ok: true, value }),
        (err: unknown) =>
          send({ t: 'rep', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
    return;
  }
  if (msg.t === 'hrep') {
    const p = pendingHost.get(msg.id);
    if (!p) return;
    pendingHost.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.value);
    else p.reject(new Error(msg.error ?? '宿主调用失败'));
    return;
  }
  const cast = msg.cast;
  if (cast.kind === 'caps') {
    cognitionOn = cast.cognition;
    return;
  }
  if (cast.kind === 'config' && cfg) {
    applyCfg(cfg as unknown as Record<string, unknown>, cast.cfg as unknown as Record<string, unknown>);
  }
});

/** 父进程关闭时停止 World 及其管理的进程。 */
process.on('disconnect', () => {
  const m = mod;
  if (!m) {
    process.exit(0);
  }
  void m.stop().finally(() => process.exit(0));
});

/** 未处理的 Promise 拒绝只记录日志。 */
process.on('unhandledRejection', (reason) => {
  log.emit('error', '引擎子进程未处理的 Promise 拒绝(已忽略)', { event: 'unhandled-rejection', err: reason });
});

/** 致命异常先尝试停止 World；8 秒后强制退出。 */
const FATAL_DRAIN_MS = 8_000;
let dying = false;
process.on('uncaughtException', (err) => {
  log.emit('error', '引擎子进程未捕获异常', { event: 'uncaught-exception', err });
  if (dying) return;
  dying = true;
  const m = mod;
  mod = null;
  if (!m) { process.exit(1); return; }
  log.emit('warn', '引擎子进程收尾中(给服务端存档 8 秒)', { event: 'fatal-drain' });
  const hard = setTimeout(() => process.exit(1), FATAL_DRAIN_MS);
  hard.unref?.();
  void m.stop().catch(() => undefined).finally(() => { clearTimeout(hard); process.exit(1); });
});
