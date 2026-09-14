/**
 * Minecraft 引擎子进程入口(经 proxy.ts fork,不手动运行)。
 *
 * 真正的 MinecraftWorld 原样跑在这里(含 mineflayer、寻路、执行器、反射层、
 * world tick、视觉、以及它托管的 java/llama 进程管理器);WorldHost 的各能力
 * 换成面向主进程的通道:事件走 hreq/hrep 往返拿真实信封,日志/用量/自省信号
 * 走单向通知。x-hot 配置以快照 cast 进来,就地改同一个 cfg 对象——World 的
 * getter 现读语义因此原样成立。
 */
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
/**
 * 认知外包那一条的死线:她那边一次构思整体 15 分钟(Persona自己的上限),
 * 这里给 16 分钟 —— 比它长一点,好让"她那边判超时"的结论走正门回来,
 * 而不是被这条管子先掐断成一句"主进程没回执"。
 */
const COGNITION_RPC_TIMEOUT_MS = 16 * 60_000;
let nextHostReqId = 1;
const pendingHost = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

/** 关机/断线/崩溃收尾:拒绝所有未回执的宿主调用,清掉它们的超时定时器,避免向已断的 IPC 通道写或漏成未处理拒绝。 */
function rejectAllPending(reason: Error): void {
  for (const [id, entry] of pendingHost) {
    clearTimeout(entry.timer);
    entry.reject(reason);
    pendingHost.delete(id);
  }
}

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

// 同步成员无法跨进程边界。不可用成员必须显式失败;占位返回会违反调用方依赖的
// 事实可用性契约。
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

/**
 * 投递成文的渲染回调过不了进程边界:回调本体按 type 登记在这里,
 * 主进程代挂总线项,发车刻经 render-deferred 请求回来现拿正文。
 */
// 渲染回调过进程边界只带文本:子进程侧的投递成文事件不带附件。
const textRender = (render: () => DeferredRendered | null | Promise<DeferredRendered | null>) =>
  async (): Promise<string | null> => {
    const out = await render();
    return out === null || typeof out === 'string' ? out : out.text;
  };
const deferredRenders = new Map<string, () => Promise<string | null>>();

/** 主进程那边此刻有没有 `host.cognition`(随 caps 投递更新) */
let cognitionOn = false;

/**
 * 认知外包的过界句柄。**不抛错**:一切失败都以 `{error}` 回去,与主进程侧那个
 * 端口的契约逐字一致(World 两种都要能如实转述给她)。
 */
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
  // 附件随记录过界要走字节序列化,子进程侧不推带附件的事件。
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
  // filter 函数过不了进程边界:主进程按"本 World 来源"筛,drain 语义只窄不宽
  drainPendingEvents: () => hostRpc({ kind: 'drain' }) as Promise<EventEnvelope[]>,
  modelFacts: {
    model: () => unavailable('modelFacts.model'),
    accepts: () => unavailable('modelFacts.accepts'),
    contextWindow: () => unavailable('modelFacts.contextWindow'),
  },
  // 附件库在主进程;子进程侧没有要落库的字节。
  blob: () => unavailable('blob'),
  reportUsage: (usage, opts) => send({ t: 'note', note: { kind: 'usage', usage, opts } }),
  /**
   * 认知外包:主进程侧有句柄时这里才出现(契约要求 World 能用 `if (host.cognition)`
   * 判断能力在不在)。可用性随 `caps` 投递现读 —— Persona那个全局开关是热的,
   * 关掉之后这个属性下一次读就该是 undefined。
   */
  get cognition(): WorldHost['cognition'] {
    return cognitionOn ? cognitionHost : undefined;
  },
  log,
};

let mod: MinecraftWorld | null = null;
let cfg: EngineInit['cfg'] | null = null;
let statusTimer: ReturnType<typeof setInterval> | null = null;
let lastStatus = '';

/** x-hot 快照就地并进活对象:World 各处持有的 cfg 引用立即看到新值 */
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
      group: p.group,
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
    rejectAllPending(new Error('引擎子进程正在关闭'));
    await mod?.stop();
    mod = null;
    setImmediate(() => process.exit(0));
    return null;
  }
  if (req.kind === 'render-deferred') {
    // 发车刻现拿:查 pushDeferred 时登记的回调;没登记(重启后旧挂单)→ null 蒸发
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
      // 主进程认好的轮号原样落到 ctx.round 上(见 round.ts)
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

// 父进程没了就跟着退,不留孤儿(mineflayer 连接与托管的 java/llama 进程一并收干净)
process.on('disconnect', () => {
  rejectAllPending(new Error('与主进程的 IPC 通道已断开'));
  const m = mod;
  if (!m) {
    process.exit(0);
  }
  void m.stop().finally(() => process.exit(0));
});

// 子进程是 MC 服务器和观察者客户端的父进程,它一死两者陪葬。库里漏出来的 Promise 拒绝
// (mineflayer 的 async 事件监听器就会漏)记一条日志即可,不值得赔上整局游戏。
// 注册了本监听器,Node 便不再把未处理拒绝提升成 uncaughtException。
process.on('unhandledRejection', (reason) => {
  log.emit('error', '引擎子进程未处理的 Promise 拒绝(已忽略)', { event: 'unhandled-rejection', err: reason });
});

// 致命退出先调用 mod.stop()，让自管服务端保存世界并关闭子进程。
// 八秒后强制退出，避免关闭流程无限等待。
const FATAL_DRAIN_MS = 8_000;
let dying = false;
process.on('uncaughtException', (err) => {
  log.emit('error', '引擎子进程未捕获异常', { event: 'uncaught-exception', err });
  if (dying) return; // 收尾途中又炸一次:让先来的那条把存档做完
  dying = true;
  const m = mod;
  mod = null;
  rejectAllPending(new Error('引擎子进程因未捕获异常退出'));
  if (!m) { process.exit(1); return; }
  log.emit('warn', '引擎子进程收尾中(给服务端存档 8 秒)', { event: 'fatal-drain' });
  const hard = setTimeout(() => process.exit(1), FATAL_DRAIN_MS);
  hard.unref?.();
  void m.stop().catch(() => undefined).finally(() => { clearTimeout(hard); process.exit(1); });
});
