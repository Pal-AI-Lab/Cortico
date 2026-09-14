/**
 * OneBotDriver — 薄驱动层。协议扩展动作失败时隔离为局部错误。
 *
 * core作WS客户端连协议端(NapCat等)的正向WS;事件推送与API调用
 * 走同一条双工连接。只依赖OneBot v11标准动作;扩展动作(表情回应等)
 * 走callExtension单独隔离——失败优雅降级返回错误,不抛崩。
 * 协议端切换=改一行WS地址,协议端是消耗品。
 */
import WebSocket from 'ws';
import type { Logger } from '../../core/types.ts';
import { nullLogger } from '../../core/util.ts';

/** OneBot事件的最小形状(驱动层不解释语义,原样交给 World) */
export interface OneBotEvent {
  post_type?: string;
  [key: string]: unknown;
}

/** 连接后探测到的自身身份信息(envPrompt的数据源) */
interface DriverIdentity {
  selfId: number;
  nickname: string;
  /** 每个监听群:群名 + 自己在该群的群昵称(card||nickname) */
  groups: Map<number, { groupName: string; card: string }>;
}

interface OneBotDriverOptions {
  wsUrl: string;
  /** 监听的群号集合(身份初始化时逐群查群名/自己的群昵称) */
  groups: number[];
  /** OneBot access token,空串=不带 */
  token?: string;
  log?: Logger;
  /** 重连退避起点,默认1000ms */
  reconnectBaseMs?: number;
  /** 重连退避封顶,默认30000ms */
  reconnectMaxMs?: number;
  /** API调用默认超时,默认10000ms */
  apiTimeoutMs?: number;
}

interface PendingCall {
  action: string;
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 扩展动作的结果:不抛错,调用方按ok分支降级 */
type ExtensionResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

export class OneBotDriver {
  private readonly opts: OneBotDriverOptions;
  private readonly log: Logger;
  /** 监听群号(可热改;身份初始化按此逐群查) */
  private groups: number[];
  private ws?: WebSocket;
  private stopped = true;
  private echoSeq = 0;
  private pending = new Map<string, PendingCall>();
  private backoffMs: number;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private eventCbs: Array<(ev: OneBotEvent) => void> = [];
  private readyCbs: Array<() => void> = [];

  /** 连接并初始化身份后可用;断线期间保留上次值 */
  identity?: DriverIdentity;
  connected = false;

  constructor(opts: OneBotDriverOptions) {
    this.opts = opts;
    this.log = opts.log ?? nullLogger();
    this.backoffMs = opts.reconnectBaseMs ?? 1000;
    this.groups = [...opts.groups];
  }

  /** 热改监听群号:更新列表,已连接则后台刷新身份(新群补群名/群昵称) */
  setGroups(groups: number[]): void {
    this.groups = [...groups];
    if (this.connected) {
      void this.initIdentity().catch((err) => {
        this.log.warn('热改后身份刷新失败', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  /** 注册原始事件回调(不带echo的服务端推送) */
  onEvent(cb: (ev: OneBotEvent) => void): void {
    this.eventCbs.push(cb);
  }

  /** 每次(重)连成功并完成身份初始化后回调 */
  onReady(cb: () => void): void {
    this.readyCbs.push(cb);
  }

  /**
   * 启动连接。首次连接尝试结束(成功就绪或失败)后resolve;
   * 失败时后台按指数退避(1s起倍增,30s封顶)持续重连,不reject。
   */
  start(): Promise<void> {
    this.stopped = false;
    this.backoffMs = this.opts.reconnectBaseMs ?? 1000;
    return new Promise((resolve) => {
      this.connectAttempt(resolve);
    });
  }

  /** 等待连接就绪(已就绪则立即返回);超时reject。测试/联调辅助。 */
  waitReady(timeoutMs = 10000): Promise<void> {
    if (this.connected && this.identity) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        remove();
        reject(new Error(`等待WS就绪超时(${timeoutMs}ms)`));
      }, timeoutMs);
      const cb = () => {
        clearTimeout(timer);
        remove();
        resolve();
      };
      const remove = () => {
        const i = this.readyCbs.indexOf(cb);
        if (i >= 0) this.readyCbs.splice(i, 1);
      };
      this.readyCbs.push(cb);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.rejectAllPending(new Error('驱动已停止'));
    const ws = this.ws;
    this.ws = undefined;
    this.connected = false;
    if (ws) {
      ws.terminate();
    }
  }

  /**
   * OneBot标准API调用:echo关联响应,超时reject。
   * retcode非0或status为failed → reject。
   */
  callApi(
    action: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<unknown> {
    const timeout = timeoutMs ?? this.opts.apiTimeoutMs ?? 10000;
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`${action}: WS未连接`));
        return;
      }
      const echo = `ob-${++this.echoSeq}`;
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`${action}: 调用超时(${timeout}ms)`));
      }, timeout);
      this.pending.set(echo, { action, resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ action, params, echo }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * 扩展动作隔离通道:set_msg_emoji_like等非OneBot v11标准动作
   * 从这里走。任何失败(不支持/超时/断线)都不抛,返回{ok:false,error}
   * 由 World 优雅降级成文本。
   */
  async callExtension(
    action: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<ExtensionResult> {
    try {
      const data = await this.callApi(action, params, timeoutMs);
      return { ok: true, data };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`扩展动作失败: ${action}`, { error: message });
      return { ok: false, error: message };
    }
  }


  private connectAttempt(onSettled?: () => void): void {
    if (this.stopped) {
      onSettled?.();
      return;
    }
    let settled = false;
    const settle = () => {
      if (!settled) {
        settled = true;
        onSettled?.();
      }
    };

    const token = this.opts.token;
    const ws = new WebSocket(this.opts.wsUrl, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    this.ws = ws;

    ws.on('open', () => {
      if (this.stopped || this.ws !== ws) {
        ws.terminate();
        settle();
        return;
      }
      this.connected = true;
      this.backoffMs = this.opts.reconnectBaseMs ?? 1000;
      this.log.info('WS已连接', { wsUrl: this.opts.wsUrl });
      void (async () => {
        try {
          await this.initIdentity();
        } catch (err) {
          this.log.warn('身份初始化失败(连接仍可用)', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (this.stopped || this.ws !== ws) {
          settle();
          return;
        }
        for (const cb of [...this.readyCbs]) cb();
        settle();
      })();
    });

    ws.on('message', (data) => {
      if (!this.stopped && this.ws === ws) this.handleMessage(String(data));
    });

    ws.on('error', (err) => {
      this.log.warn('WS错误', { error: err.message });
    });

    ws.on('close', () => {
      const isCurrent = this.ws === ws;
      const wasConnected = this.connected;
      if (isCurrent) {
        this.ws = undefined;
        this.connected = false;
        this.rejectAllPending(new Error('WS连接已断开'));
        if (wasConnected) this.log.info('WS已断开');
      }
      settle();
      if (isCurrent && !this.stopped) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(
      this.backoffMs * 2,
      this.opts.reconnectMaxMs ?? 30000,
    );
    this.log.info(`${delay}ms后重连`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.stopped) this.connectAttempt();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /** 连上后查 自身账号→逐个监听群的群名/自己的群昵称,填identity */
  private async initIdentity(): Promise<void> {
    const login = (await this.callApi('get_login_info')) as {
      user_id?: number;
      nickname?: string;
    };
    const selfId = Number(login?.user_id);
    const nickname = String(login?.nickname ?? '');

    const groups = new Map<number, { groupName: string; card: string }>();
    for (const gid of this.groups) {
      let groupName = this.identity?.groups.get(gid)?.groupName ?? String(gid);
      try {
        const gi = (await this.callApi('get_group_info', { group_id: gid })) as {
          group_name?: string;
        };
        if (gi?.group_name) groupName = String(gi.group_name);
      } catch (err) {
        this.log.warn('get_group_info失败', {
          gid,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      let card = nickname;
      try {
        const mi = (await this.callApi('get_group_member_info', {
          group_id: gid,
          user_id: selfId,
        })) as { card?: string; nickname?: string };
        card = String(mi?.card || mi?.nickname || nickname);
      } catch (err) {
        this.log.warn('get_group_member_info失败', {
          gid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      groups.set(gid, { groupName, card });
    }

    this.identity = { selfId, nickname, groups };
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.log.warn('收到非JSON消息,已忽略');
      return;
    }

    // API响应:带echo
    if (msg.echo !== undefined && msg.echo !== null) {
      const call = this.pending.get(String(msg.echo));
      if (!call) return; // 已超时/已清理
      this.pending.delete(String(msg.echo));
      clearTimeout(call.timer);
      const retcode = Number(msg.retcode ?? -1);
      const status = String(msg.status ?? '');
      if (retcode === 0 || status === 'ok' || status === 'async') {
        call.resolve(msg.data);
      } else {
        call.reject(
          new Error(
            `${call.action}: retcode=${retcode}${msg.message ? ` ${String(msg.message)}` : ''}`,
          ),
        );
      }
      return;
    }

    // 事件推送
    if (msg.post_type !== undefined) {
      for (const cb of this.eventCbs) {
        try {
          cb(msg as OneBotEvent);
        } catch (err) {
          this.log.error('事件回调抛错', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  private rejectAllPending(err: Error): void {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error(`${call.action}: ${err.message}`));
    }
    this.pending.clear();
  }
}
