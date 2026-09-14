/**
 * MinecraftWorldProxy — 主进程侧的 Minecraft World。
 *
 * MinecraftWorld 在引擎子进程(engine-child.ts)中运行。mineflayer 的 20Hz
 * physicsTick、寻路 A* 同步搜索、执行器循环、world tick 与 viewer 抓帧均与
 * 主进程事件循环隔离。
 *
 * 装配层用它替换 MinecraftWorld,选项形状不变。x-hot 配置在这里定期采样成
 * 快照推给子进程(子进程就地改同一形状的 cfg 对象,现读语义原样成立);
 * 徽标、存储统计走推送缓存(1s 级新鲜度);世界快照走投递成文事件
 * (arm-deferred 代挂 + 发车刻 render-deferred 现拿)。
 */
import { fork, type ChildProcess, type Serializable } from 'node:child_process';
import { nowIso } from '../../core/util.ts';
import { emitLogNote, logChildStdio } from '../../core/ipc-logger.ts';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  World,
  WorldHost,
  WorldConsoleDecl,
  StoragePart,
  ToolDef,
} from '../../core/types.ts';
import { COGNITION_ABSENT, MINECRAFT_PANEL_DECLS, MINECRAFT_STORAGE_DECLS, MINECRAFT_TOOL_DECLS, type MinecraftWorldOptions } from './world.ts';
import { MINECRAFT_CLIENT_CONFIG_GROUP, MINECRAFT_CONFIG_GROUP, MINECRAFT_PLAYER_CONFIG_GROUP, MINECRAFT_RHYTHM_CONFIG_GROUP } from './config.ts';
import type {
  ChildToMain,
  EngineCast,
  EngineNote,
  EngineRequest,
  HostRequest,
  StorageStat,
} from './engine-ipc.ts';
import { roundTokenOf } from './round.ts';
import { loadExplored, renderExploredLedger } from './explored.ts';
import { loadPolicy, renderPolicyEnv } from './policy.ts';
import { worldEnvLine, worldIdentityOf } from './server-config.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
/** 只在开了观察者客户端时才进前缀的那一段;独立成文件才能让措辞归人。 */
const CAMERA_NOTE_FILE = fileURLToPath(new URL('./ENV_PROMPT_CAMERA.md', import.meta.url));
const CHILD_ENTRY = fileURLToPath(new URL('./engine-child.ts', import.meta.url));

const CONFIG_SAMPLE_MS = 1000;
const RESTART_DELAY_MS = 3000;
/** Windows 关控制台窗口/Ctrl+C 把整组进程打死时的退出码(STATUS_CONTROL_C_EXIT) */
const CONSOLE_KILL_EXIT_CODE = 3221225786;
/** 工具回执死线:受理类工具同步回执,放宽只为覆盖子进程繁忙时的排队 */
const RPC_TIMEOUT_MS = 150_000;
/** 投递成文渲染的 IPC 死线:必须小于 loop 侧 RENDER_DEADLINE_MS(3s),先于它干净地失败 */
const DEFERRED_RENDER_TIMEOUT_MS = 2500;
const PANEL_RPC_TIMEOUT_MS = 150_000;
/** init 含连服与世界加载的前置,不等它们(start() 只等子进程收到 init) */
const INIT_TIMEOUT_MS = 30_000;

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class MinecraftWorldProxy implements World {
  readonly id = 'minecraft';

  private host: WorldHost | null = null;
  private child: ChildProcess | null = null;
  private ready = false;
  private stopping = false;
  private nextReqId = 1;
  private readonly pending = new Map<number, PendingRpc>();
  private declCache: Pick<WorldConsoleDecl, 'lamps' | 'badges' | 'links'> = {};
  private storageCache: StorageStat[] = [];
  private lastConfigJson = '';
  /** 上一次推给子进程的「认知外包在不在」;null = 还没推过 */
  private lastCaps: boolean | null = null;
  private configTimer: ReturnType<typeof setInterval> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: MinecraftWorldOptions) {}

  /**
   * 前缀从子进程持有的落盘文件读取探索摘要与常驻规则，并从 server.properties 读取世界身份。
   * 快照锚点由子进程设置。
   */
  envPromptVars(): Record<string, string> {
    return {
      'minecraft.world': worldEnvLine(worldIdentityOf(
        this.opts.cfg.local.serverDir,
        `${this.opts.cfg.host}:${this.opts.cfg.port}`,
      )),
      'minecraft.explored': renderExploredLedger(loadExplored(this.storageFileOf('minecraft-explored'))),
      'minecraft.policy': renderPolicyEnv(loadPolicy(this.storageFileOf('minecraft-policy'))),
      'minecraft.camera': this.opts.cfg.client.enabled
        ? readFileSync(CAMERA_NOTE_FILE, 'utf8').trim()
        : '',
    };
  }

  tools(): ToolDef[] {
    return MINECRAFT_TOOL_DECLS.map((decl) => ({
      ...decl,
      handler: async (args, ctx) => {
        try {
          return (await this.rpc(
            {
              kind: 'tool', name: decl.name, args, role: ctx.role,
              callId: ctx.callId ?? null,
              // 引擎将此轮号写入工具 ctx.round。
              round: roundTokenOf(ctx),
            },
            RPC_TIMEOUT_MS,
          )) as string;
        } catch (err) {
          return `[${decl.name} 失败] 引擎进程不可用:${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }));
  }

  console(): WorldConsoleDecl {
    return {
      // 子进程报上来之前只有一件事是确定的:引擎在不在。真 World 那排灯一到就盖掉这颗。
      lamps: this.declCache.lamps ?? [this.child
        ? { label: '引擎', state: 'loading' as const, hint: '启动中' }
        : { label: '引擎', state: 'offline' as const, hint: '未启动' }],
      badges: this.declCache.badges ?? [
        { label: '引擎', value: this.child ? '启动中' : '未启动', tone: 'off' },
      ],
      // 与真 World 共用同一份声明:控制台隔着代理看到的表面必须与直连时一模一样。
      panels: [...MINECRAFT_PANEL_DECLS],
      invoke: (panel, method, args) => {
        // 路径选择保存后紧接着会读状态或启动；同一 IPC 通道先投最新配置，
        // 让这次面板调用看到刚写入的值。
        this.pushConfigIfChanged();
        return this.rpc({ kind: 'panel', panel, method, args }, PANEL_RPC_TIMEOUT_MS);
      },
      promptDocs: [
        {
          key: 'worlds.minecraft.envPrompt',
          title: 'Minecraft · 环境提示词',
          description: 'Minecraft World 的常驻事实（技能序列、世界观察、反射层）。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            {
              name: 'minecraft.world',
              description: '世界身份:本地托管=「当前存档:名字」,外部服务器=「当前服务器:地址」。她的位置类记忆按它划界。',
            },
            {
              name: 'minecraft.explored',
              description: '探索覆盖摘要(8 方向历史最远与末端群系);一处没探过时为空。',
            },
            {
              name: 'minecraft.policy',
              description: 'mc_policy 六格里与默认不同的那几条;全默认时为空。',
            },
            {
              name: 'minecraft.camera',
              description: '观察者摄像机说明;没开客户端时为空。措辞在「摄像机说明」那份里改。',
              multiline: true,
            },
          ],
        },
        {
          key: 'worlds.minecraft.cameraNote',
          title: 'Minecraft · 摄像机说明',
          description: '开了观察者客户端时,追加到环境提示词末尾的那一段。',
          path: CAMERA_NOTE_FILE,
        },
      ],
      // 存储项在装配期注册，以纳入清除数据清单。
      // stat 优先使用子进程缓存，缺少缓存时读取文件；clear 由 storageClear 处理。
      storage: MINECRAFT_STORAGE_DECLS.map((d): StoragePart => ({
        ...d,
        stat: () =>
          this.storageCache.find((s) => s.key === d.key)?.stat ?? this.storageStatOffline(d.key),
        clear: async () => this.storageClear(d.key),
      })),
      links: this.declCache.links ?? [],
      config: [
        MINECRAFT_CONFIG_GROUP,
        MINECRAFT_RHYTHM_CONFIG_GROUP,
        MINECRAFT_CLIENT_CONFIG_GROUP,
        MINECRAFT_PLAYER_CONFIG_GROUP,
      ],
    };
  }

  private storageFileOf(key: string): string | null {
    if (!this.opts.dataDir) return null;
    if (key === 'minecraft-chests') return join(this.opts.dataDir, 'minecraft-chests.json');
    if (key === 'minecraft-deaths') return join(this.opts.dataDir, 'minecraft-deaths.json');
    if (key === 'minecraft-explored') return join(this.opts.dataDir, 'minecraft-explored.json');
    if (key === 'minecraft-policy') return join(this.opts.dataDir, 'minecraft-policy.json');
    if (key === 'minecraft-blueprints') return join(this.opts.dataDir, 'minecraft-blueprints.json');
    return null;
  }

  /** 子进程没起时的存储统计:直接看文件 */
  private storageStatOffline(key: string): string {
    const file = this.storageFileOf(key);
    if (!file || !existsSync(file)) return '(无文件)';
    try {
      return `${(statSync(file).size / 1024).toFixed(1)}KB(引擎未启动)`;
    } catch {
      return '(读不了)';
    }
  }

  /**
   * 清除一个存储项。子进程活着必须走 RPC(它内存里还有一份,直清文件会被下一次
   * flush 复活);正在启动时拒绝(子进程可能已把旧数据读进内存);没起就直清文件
   * ——之后启动会从清过的文件重读,旧数据不会复活。
   */
  private async storageClear(key: string): Promise<string> {
    if (this.child?.connected) {
      if (!this.ready) throw new Error('引擎子进程正在启动,稍后再清');
      return String(await this.rpc({ kind: 'storage-clear', key }, RPC_TIMEOUT_MS));
    }
    const file = this.storageFileOf(key);
    if (!file || !existsSync(file)) return '没有落盘文件,无需清除';
    writeFileSync(file, '{}\n', 'utf8');
    return '已清空(引擎未启动,直清文件)';
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.stopping = false;
    await this.spawn();
    this.configTimer = setInterval(() => this.pushConfigIfChanged(), CONFIG_SAMPLE_MS);
    this.configTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.configTimer) clearInterval(this.configTimer);
    this.configTimer = null;
    const child = this.child;
    if (child) {
      try {
        await this.rpc({ kind: 'shutdown' }, 15_000);
      } catch {
        /* 停机死线内没回执就直接杀 */
      }
      await waitExit(child, 5000);
      if (child.exitCode === null && !child.killed) child.kill();
    }
    this.teardownChild();
    this.host = null;
  }


  private async spawn(): Promise<void> {
    const child = fork(CHILD_ENTRY, [], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.child = child;
    if (this.host) logChildStdio(child, this.host.log);
    child.on('message', (msg) => this.onMessage(msg as ChildToMain));
    child.on('exit', (code) => this.onExit(code));
    child.on('error', (err) => this.host?.log.error('Minecraft 引擎子进程出错', { err: String(err) }));
    this.lastConfigJson = JSON.stringify(this.opts.cfg);
    await this.rpc(
      {
        kind: 'init',
        init: {
          timezone: this.opts.timezone ?? 'Asia/Shanghai',
          botName: this.opts.botName ?? 'bot',
          dataDir: this.opts.dataDir ?? null,
          cfg: JSON.parse(this.lastConfigJson) as MinecraftWorldOptions['cfg'],
        },
      },
      INIT_TIMEOUT_MS,
    );
    this.ready = true;
    // 能力位赶在第一次工具调用之前到位(采样线要等 1s,而 init 之后随时可能来一单)
    this.lastCaps = null;
    this.pushCapsIfChanged();
    this.host?.log.info(`Minecraft 引擎子进程已就绪 pid=${child.pid}`);
  }

  private teardownChild(): void {
    this.child = null;
    this.ready = false;
    this.declCache = {};
    this.storageCache = [];
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Minecraft 引擎子进程已退出'));
    }
    this.pending.clear();
  }

  private onExit(code: number | null): void {
    const wasStopping = this.stopping;
    this.teardownChild();
    if (wasStopping) return;
    if (code === CONSOLE_KILL_EXIT_CODE) {
      // 子进程随控制台窗口一起被打死:这是人为关停不是崩溃,整机跟着退,别对着空气重启
      this.host?.log.warn('Minecraft 引擎子进程随控制台关闭退出(0xC000013A),判定人为关停,整机退出');
      if (process.listenerCount('SIGINT') > 0) process.emit('SIGINT');
      else process.exit(0);
      return;
    }
    this.host?.log.error(`Minecraft 引擎子进程意外退出(code=${code}),${RESTART_DELAY_MS / 1000}s 后重启`);
    // 子进程死了自己发不了讣告,这条只能由主进程侧来说——上一场收播时她对
    // "世界已下线"一无所知,整段只有运行日志一行可见
    this.host?.pushEvent(
      {
        ts: nowIso(this.opts.timezone ?? 'Asia/Shanghai'),
        source: this.id,
        type: 'minecraft.event',
        text: '[Minecraft] 游戏引擎崩了,正在自动重启;重新连上之前,游戏里的动作都不会生效。',
        senderKey: 'minecraft',
      },
      { trigger: 'flush' },
    ).catch((err) => {
      // 投递失败时记录日志,便于排查引擎崩溃。
      this.host?.log?.warn('Minecraft 引擎崩溃告警投递失败', { err: String(err) });
    });
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.stopping) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      void this.spawn().catch((err: unknown) => {
        this.host?.log.error('Minecraft 引擎子进程重启失败,继续重试', { err: String(err) });
        this.teardownChild();
        this.scheduleRestart();
      });
    }, RESTART_DELAY_MS);
    this.restartTimer.unref?.();
  }


  private onMessage(msg: ChildToMain): void {
    if (msg.t === 'rep') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new Error(msg.error ?? '子进程报错'));
      return;
    }
    if (msg.t === 'hreq') {
      void this.onHostRequest(msg.id, msg.req);
      return;
    }
    this.onNote(msg.note);
  }

  private async onHostRequest(id: number, req: HostRequest): Promise<void> {
    const child = this.child;
    try {
      const host = this.host;
      if (!host) throw new Error('宿主未接线');
      let value: unknown;
      if (req.kind === 'push') {
        value = await host.pushEvent(req.evt, req.opts);
      } else if (req.kind === 'drain') {
        value = await host.drainPendingEvents((e) => e.source === this.id);
      } else if (req.kind === 'cognition') {
        // 句柄是 core 上的 getter,Persona的开关一关它就没了 —— 每次现取。
        // 工具白名单由那一侧按本 World tools() 校验(与真 World 共用同一份声明)。
        const port = host.cognition;
        value = port
          ? await port.request(req.req)
          : { error: `${COGNITION_ABSENT}(问的时候句柄已经不在了)` };
      }
      this.sendToChild(child, { t: 'hrep', id, ok: true, value });
    } catch (err) {
      this.sendToChild(child, { t: 'hrep', id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** child.send 可能返回 false(通道断开)或抛异常(序列化失败);失败时记日志,子进程侧超时兜底。 */
  private sendToChild(child: ChildProcess | null, msg: unknown): void {
    if (!child || !child.connected) return;
    try {
      if (!child.send(msg as Serializable)) {
        this.host?.log?.warn('Minecraft 引擎子进程 IPC send 返回 false(通道已断),子进程侧 RPC 将由其超时兜底', { kind: String((msg as { t?: string }).t) });
      }
    } catch (err) {
      this.host?.log?.warn('Minecraft 引擎子进程 IPC send 抛异常', { err: String(err) });
    }
  }

  private onNote(note: EngineNote): void {
    const host = this.host;
    if (!host) return;
    switch (note.kind) {
      case 'log':
        emitLogNote(host.log, note, this.opts.timezone ?? 'Asia/Shanghai');
        return;
      case 'usage':
        host.reportUsage(note.usage, note.opts);
        return;
      case 'arm-deferred': {
        // 渲染回调留在子进程登记表;这里代挂,发车刻 IPC 回去现拿正文。
        // rpc 失败(子进程没了/超时)按 null 处理 → 该项蒸发,与契约一致。
        const type = note.type;
        host.pushDeferred(
          {
            type,
            ...(note.senderKey !== undefined ? { senderKey: note.senderKey } : {}),
            ...(note.meta !== undefined ? { meta: note.meta } : {}),
            ...(note.tags !== undefined ? { tags: note.tags } : {}),
            render: async () => {
              try {
                return (await this.rpc(
                  { kind: 'render-deferred', type },
                  DEFERRED_RENDER_TIMEOUT_MS,
                )) as string | null;
              } catch {
                return null;
              }
            },
          },
          note.trigger !== undefined ? { trigger: note.trigger } : undefined,
        );
        return;
      }
      case 'status':
        this.declCache = note.decl;
        this.storageCache = note.storage;
        return;
    }
  }

  private rpc(req: EngineRequest, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (!child || !child.connected) return Promise.reject(new Error('Minecraft 引擎子进程未运行'));
    const id = this.nextReqId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`子进程 ${timeoutMs / 1000}s 未回执(${req.kind})`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      // send 失败(通道断/序列化抛异常)由超时兜底;sendToChild 内部已 try/catch 不会让 executor 抛出。
      this.sendToChild(child, { t: 'req', id, req });
    });
  }

  private cast(cast: EngineCast): void {
    this.sendToChild(this.child, { t: 'cast', cast });
  }

  /** x-hot 配置的采样推送:控制台热改最迟 1s 到达子进程 */
  private pushConfigIfChanged(): void {
    if (!this.ready) return;
    this.pushCapsIfChanged();
    const json = JSON.stringify(this.opts.cfg);
    if (json === this.lastConfigJson) return;
    this.lastConfigJson = json;
    this.cast({ kind: 'config', cfg: JSON.parse(json) as MinecraftWorldOptions['cfg'] });
  }

  /**
   * 可选宿主能力的可用位。`host.cognition` 是 getter(Persona的全局开关热改),
   * 而子进程那边的 World 要能用 `if (host.cognition)` 判断能力在不在 —— 搭配置那条
   * 采样线走,最迟 1s 到位;真正调用时主进程还会再现取一次句柄。
   */
  private pushCapsIfChanged(): void {
    const on = this.host?.cognition !== undefined;
    if (on === this.lastCaps) return;
    this.lastCaps = on;
    this.cast({ kind: 'caps', cognition: on });
  }
}

function waitExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
