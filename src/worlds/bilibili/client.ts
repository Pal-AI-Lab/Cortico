/**
 * 直播间长连客户端(web 弹幕协议,只读)。
 *
 * 连接前的 HTTP 请求:
 *   1. `finger/spi` 取 buvid3
 *   2. `x/web-interface/nav` 取 WBI 密钥(未登录也返回,只是 code=-101)与自己的 uid
 *   3. `Room/get_info` 把短号换成真实房间号(认证包只认真实号)
 *   4. `getDanmuInfo`(WBI 签名)拿弹幕服务器列表与 token
 * 然后 wss 连上去发认证包,每 30 秒一个心跳。
 *
 */
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import type { Language } from '../../core/language.ts';
import type { Logger, ShutdownExternalCheck } from '../../core/types.ts';
import { text, type BilibiliText } from './strings.ts';
import { encodePacket, OP, parseFrame } from './wire.ts';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const HEARTBEAT_MS = 30_000;
const BACKOFF_MIN_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;
/**
 * WebSocket 的 TCP/TLS/Upgrade 握手时限，防止未产生 open/error/close 的挂起阻断重连。超时由 ws 发出 error、close，再经 close → fail() 恢复。
 */
export const HANDSHAKE_TIMEOUT_MS = 15_000;
/** 握手四步 HTTP 的总时限;超时同样走 fail() 排下一次重连 */
export const BOOTSTRAP_TIMEOUT_MS = 15_000;
/**
 * 重连看门狗阈值:平台在播而 phase 停在 connecting 超过这么久,由 live_status
 * 轮询强制 fail() 重来。retrying 且退避计时器还挂着的不算卡死(退避上限 60 秒,
 * 它自己会到点重连)。
 */
export const RECONNECT_WATCHDOG_MS = 60_000;
/**
 * 运行期 live_status 只读轮询，补充 WS 断连窗口或漏推的状态读数。此层仅更新状态，转沿成文与告警由 onStatus → onLiveStatus 处理。
 */
export const ROOM_POLL_MS = 100_000;
/** HTTP 412 后的状态轮询退避时间。 */
export const ROOM_POLL_RISK_HOLD_MS = 600_000;
/** 关机验证属于 World 停机预算的一小段，不新增全局关机步骤。 */
export const SHUTDOWN_VERIFY_TIMEOUT_MS = 2_500;

/** WBI 签名的 64 位重排表(B 站前端里的常量) */
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
  28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
  54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

export type LivePhase = 'stopped' | 'connecting' | 'connected' | 'retrying';

export interface LiveStatus {
  phase: LivePhase;
  /** 配置里填的房间号(可能是短号) */
  roomId: number;
  /** 换算出的真实房间号 */
  realRoomId: number | null;
  title: string;
  /** 主播是否正在直播 */
  living: boolean;
  /** 平台报告的本场开播时刻 */
  liveStartedAt: number | null;
  /** 登录态的 uid;0 = 匿名 */
  selfUid: number;
  lastError: string | null;
}

interface LiveClientOptions {
  roomId: number;
  /** 登录 cookie;空串=匿名连接(收得到弹幕,但认不出人) */
  sessdata: string;
  onCmd: (msg: Record<string, unknown>) => void;
  /** 状态变化(WebUI 徽标据此刷新) */
  onStatus?: (status: LiveStatus) => void;
  log: Logger;
}

export class LiveClient {
  private readonly opts: LiveClientOptions;
  private ws: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  /** 运行期 live_status 轮询(见 ROOM_POLL_MS);start 布防、stop 撤防 */
  private roomPoll: ReturnType<typeof setTimeout> | null = null;
  private backoff = BACKOFF_MIN_MS;
  private stopped = true;
  private status: LiveStatus;
  /** 当前 phase 的进入时刻;看门狗据此算 connecting 卡了多久 */
  private phaseSince = Date.now();
  /** 关机检查按请求语言成文。 */
  private shutdownCheck: (language: Language) => ShutdownExternalCheck;

  constructor(opts: LiveClientOptions) {
    this.opts = opts;
    this.status = {
      phase: 'stopped',
      roomId: opts.roomId,
      realRoomId: null,
      title: '',
      living: false,
      liveStartedAt: null,
      selfUid: 0,
      lastError: null,
    };
    this.shutdownCheck = this.unknownShutdownCheck((t) => t.roomPending);
  }

  current(): LiveStatus {
    return { ...this.status };
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.shutdownCheck = this.unknownShutdownCheck((t) => t.roomPending);
    await this.connect();
    // 轮询独立于 WS 连接的死活:WS 断着的窗口恰恰是最需要它的时候
    this.scheduleRoomPoll(ROOM_POLL_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    if (this.roomPoll) clearTimeout(this.roomPoll);
    this.roomPoll = null;
    this.clearHeartbeat();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(1000, 'module stop');
      } catch {
        /* 已断 */
      }
    }
    this.patch({ phase: 'stopped' });
    this.shutdownCheck = await this.verifyRoomEnded();
  }

  shutdownVerification(language: Language): readonly ShutdownExternalCheck[] {
    return [{ ...this.shutdownCheck(language) }];
  }

  // ── 连接 ─────────────────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.patch({ phase: 'connecting', lastError: null });
    let plan: { url: string; auth: Record<string, unknown> };
    // 与 verifyRoomEnded 同一形制:到点既 abort 又 reject,不理会 abort 的上游也拖不住
    const controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | null = null;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          controller.abort();
          reject(new Error(`握手接口超时(${BOOTSTRAP_TIMEOUT_MS}ms)`));
        }, BOOTSTRAP_TIMEOUT_MS);
      });
      plan = await Promise.race([this.bootstrap(controller.signal), timeout]);
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
      return;
    } finally {
      if (deadline) clearTimeout(deadline);
    }
    if (this.stopped) return;

    const ws = new WebSocket(plan.url, {
      headers: { 'User-Agent': UA, Origin: 'https://live.bilibili.com' },
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    });
    this.ws = ws;
    ws.on('open', () => {
      ws.send(encodePacket(OP.AUTH, JSON.stringify(plan.auth)));
      this.clearHeartbeat();
      this.heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(encodePacket(OP.HEARTBEAT, ''));
      }, HEARTBEAT_MS);
      this.heartbeat.unref?.();
    });
    ws.on('message', (raw: WebSocket.RawData) => this.onFrame(toBuffer(raw)));
    // 两个回调都只认当前 socket:fail()/stop() 已放弃的 socket 在 terminate/close
    // 之后还会补一个 error + close,不能让它再触发一次 fail()。
    ws.on('error', (err: Error) => {
      if (this.ws === ws) this.opts.log.warn('直播长连出错', { err: err.message });
    });
    ws.on('close', (code: number, reason: Buffer) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearHeartbeat();
      if (this.stopped) return;
      this.fail('长连断开', { code, reason: reason.toString() });
    });
  }

  private onFrame(buf: Buffer): void {
    // 心跳回执里的人气值(kind:'popularity')无人消费,丢弃;面板那个读数走 POPULARITY_CHANGE 这条 JSON cmd。
    for (const frame of parseFrame(buf)) {
      if (frame.kind === 'auth') {
        if (frame.code === 0) {
          this.backoff = BACKOFF_MIN_MS;
          this.patch({ phase: 'connected' });
          this.opts.log.info(`已接入直播间 ${this.status.realRoomId}`, {
            登录态: this.status.selfUid ? String(this.status.selfUid) : '匿名',
          });
        } else {
          this.fail(`认证失败 code=${frame.code}`);
        }
      } else if (frame.kind === 'cmd') {
        try {
          this.opts.onCmd(frame.msg);
        } catch (e) {
          this.opts.log.warn('直播消息处理失败', { err: String(e) });
        }
      }
    }
  }

  /**
   * 断线/失败统一入口:记一笔,退避后重连(重连要重新取 token,它会过期)。
   * `data` 原样进日志(close 的 code/reason、看门狗的持续时长),断因事后可追。
   */
  private fail(reason: string, data?: Record<string, unknown>): void {
    this.clearHeartbeat();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.terminate();
      } catch {
        /* 已断 */
      }
    }
    if (this.stopped) return;
    this.patch({ phase: 'retrying', lastError: reason });
    this.opts.log.warn(`直播接入中断:${reason},${Math.round(this.backoff / 1000)} 秒后重连`, data);
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect().catch((e) => this.opts.log.warn('重连失败', { err: String(e) }));
    }, this.backoff);
    this.retry.unref?.();
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private patch(part: Partial<LiveStatus>): void {
    if (part.phase !== undefined && part.phase !== this.status.phase) this.phaseSince = Date.now();
    this.status = { ...this.status, ...part };
    this.opts.onStatus?.(this.current());
  }

  // ── 运行期 live_status 轮询 ──────────────────────────────────────────────

  private scheduleRoomPoll(delayMs: number): void {
    if (this.stopped) return;
    if (this.roomPoll) clearTimeout(this.roomPoll);
    this.roomPoll = setTimeout(() => {
      void this.pollRoomInfo();
    }, delayMs);
    this.roomPoll.unref?.();
  }

  /**
   * 只读一次 Room/get_info,把 live_status/live_time 的变化 patch 进状态
   * (变化才 patch,免得每 100 秒空转一次 onStatus)。不调用任何写接口,
   * 不在这里下任何"直播结束了"的结论——那是 World 侧转沿检测的事。
   * 读完顺带跑一次重连看门狗:它是 WS 回调之外唯一按时醒来的地方。
   */
  private async pollRoomInfo(): Promise<void> {
    if (this.stopped) return;
    let nextMs = ROOM_POLL_MS;
    try {
      const info = await this.getJson(
        `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${this.status.realRoomId ?? this.opts.roomId}`,
        '',
      );
      if (numOf(info.code) !== 0) {
        this.opts.log.warn('直播间状态轮询返回非零 code', { code: info.code, message: str(info.message) });
      } else {
        const room = obj(info.data);
        const rawLiveStatus = room.live_status;
        if (typeof rawLiveStatus === 'number' && Number.isFinite(rawLiveStatus)) {
          const living = rawLiveStatus === 1;
          const liveStartedAt = liveTimestamp(room.live_time);
          if (living !== this.status.living || liveStartedAt !== this.status.liveStartedAt) {
            this.opts.log.info('轮询读到 live_status 变化', { liveStatus: rawLiveStatus, living });
            this.patch({ living, liveStartedAt });
          }
        } else {
          this.opts.log.warn('直播间状态轮询响应缺少有效 live_status');
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('412')) {
        nextMs = ROOM_POLL_RISK_HOLD_MS;
        this.opts.log.warn(`直播间状态轮询失败(412),等待 ${Math.round(ROOM_POLL_RISK_HOLD_MS / 60_000)} 分钟后重试`);
      } else {
        this.opts.log.warn('直播间状态轮询失败', { err: msg });
      }
    }
    this.reconnectWatchdog();
    this.scheduleRoomPoll(nextMs);
  }

  /**
   * 重连看门狗(见 RECONNECT_WATCHDOG_MS)。握手停住时 ws 不会触发任何回调,
   * 这里按 phase 的进入时刻兜底,强制走 fail() 重来。只在平台在播时管——
   * 没开播的空窗没有弹幕可丢。
   */
  private reconnectWatchdog(): void {
    if (this.stopped || !this.status.living) return;
    const phase = this.status.phase;
    const stuck = phase === 'connecting' || (phase === 'retrying' && this.retry === null);
    if (!stuck) return;
    const elapsedMs = Date.now() - this.phaseSince;
    if (elapsedMs < RECONNECT_WATCHDOG_MS) return;
    this.fail(`重连看门狗:握手/重连 ${Math.round(elapsedMs / 1000)} 秒无结果`, { phase, elapsedMs });
  }

  // ── 握手四步 ─────────────────────────────────────────────────────────────

  private async bootstrap(signal: AbortSignal): Promise<{ url: string; auth: Record<string, unknown> }> {
    const spi = await this.getJson('https://api.bilibili.com/x/frontend/finger/spi', '', signal);
    const buvid3 = str(obj(spi.data).b_3);
    const cookie = [`buvid3=${buvid3}`, this.opts.sessdata ? `SESSDATA=${this.opts.sessdata}` : '']
      .filter(Boolean)
      .join('; ');

    const nav = await this.getJson('https://api.bilibili.com/x/web-interface/nav', cookie, signal);
    const navData = obj(nav.data);
    const wbi = obj(navData.wbi_img);
    const mixin = mixinKey(keyOf(str(wbi.img_url)), keyOf(str(wbi.sub_url)));
    const selfUid = numOf(navData.mid);

    const info = await this.getJson(
      `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${this.opts.roomId}`,
      cookie,
      signal,
    );
    if (numOf(info.code) !== 0) throw new Error(`取直播间信息失败:${str(info.message)}`);
    const room = obj(info.data);
    const realRoomId = numOf(room.room_id);
    this.patch({
      realRoomId,
      title: str(room.title),
      living: numOf(room.live_status) === 1,
      liveStartedAt: liveTimestamp(room.live_time),
      selfUid,
    });

    const dm = await this.getJson(
      `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${wbiQuery({ id: realRoomId, type: 0 }, mixin)}`,
      cookie,
      signal,
    );
    if (numOf(dm.code) !== 0) throw new Error(`取弹幕服务器失败:${numOf(dm.code)} ${str(dm.message)}`);
    const dmData = obj(dm.data);
    const hosts = Array.isArray(dmData.host_list) ? dmData.host_list : [];
    const first = obj(hosts[0]);
    const host = str(first.host);
    if (!host) throw new Error('弹幕服务器列表为空');

    return {
      url: `wss://${host}:${numOf(first.wss_port) || 443}/sub`,
      auth: {
        uid: selfUid,
        roomid: realRoomId,
        protover: 3,
        platform: 'web',
        type: 2,
        buvid: buvid3,
        key: str(dmData.token),
      },
    };
  }

  private async getJson(
    url: string,
    cookie: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const res = await fetch(url, {
      method: 'GET',
      signal,
      headers: {
        'User-Agent': UA,
        Referer: 'https://live.bilibili.com/',
        Origin: 'https://live.bilibili.com',
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    if (res.status === 412) throw new Error('HTTP 412');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: unknown = await res.json();
    return obj(body);
  }

  /** 只读 Room/get_info；不调用 StopStream、不关闭平台直播，也不管理推流进程。 */
  private async verifyRoomEnded(): Promise<(language: Language) => ShutdownExternalCheck> {
    const roomId = this.status.realRoomId ?? this.opts.roomId;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`只读探针超时(${SHUTDOWN_VERIFY_TIMEOUT_MS}ms)`));
        }, SHUTDOWN_VERIFY_TIMEOUT_MS);
      });
      const info = await Promise.race([
        this.getJson(
          `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`,
          '',
          controller.signal,
        ),
        timeout,
      ]);
      if (typeof info.code !== 'number' || !Number.isFinite(info.code) || info.code !== 0) {
        const code = String(info.code);
        const message = str(info.message);
        return this.unknownShutdownCheck((t) => t.roomInvalidCode(code, message));
      }
      const rawLiveStatus = obj(info.data).live_status;
      if (typeof rawLiveStatus !== 'number' || !Number.isFinite(rawLiveStatus)) {
        return this.unknownShutdownCheck((t) => t.roomMissingStatus);
      }
      const liveStatus = rawLiveStatus;
      if (liveStatus === 0) {
        return (language) => {
          const t = text(language);
          return {
            key: 'bilibili.live-room',
            label: t.roomLabel(roomId),
            status: 'verified-ended',
            detail: t.roomEnded,
            manualAction: t.noActionNeeded,
          };
        };
      }
      if (liveStatus === 1) {
        return (language) => {
          const t = text(language);
          return {
            key: 'bilibili.live-room',
            label: t.roomLabel(roomId),
            status: 'still-live',
            detail: t.roomStillLive,
            manualAction: t.endStreamManually,
          };
        };
      }
      return this.unknownShutdownCheck((t) => t.roomUnknownStatus(liveStatus));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.unknownShutdownCheck(() => message);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private unknownShutdownCheck(detail: (t: BilibiliText) => string): (language: Language) => ShutdownExternalCheck {
    const roomId = this.status.realRoomId ?? this.opts.roomId;
    return (language) => {
      const t = text(language);
      return {
        key: 'bilibili.live-room',
        label: t.roomLabel(roomId),
        status: 'unknown',
        detail: detail(t),
        manualAction: t.manualCheck,
      };
    };
  }
}

// ── WBI 签名 ───────────────────────────────────────────────────────────────

/** `https://.../7cd084941338484aae1ad9425b84077c.png` → `7cd0…077c` */
function keyOf(url: string): string {
  return url.split('/').pop()?.split('.')[0] ?? '';
}

function mixinKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey;
  return MIXIN_TAB.map((i) => raw[i] ?? '').join('').slice(0, 32);
}

/** 参数按键排序、剔掉 `!'()*`、补 wts,再 md5(query + mixinKey) 得 w_rid */
function wbiQuery(params: Record<string, string | number>, mixin: string, nowSec?: number): string {
  const withTs: Record<string, string | number> = {
    ...params,
    wts: nowSec ?? Math.floor(Date.now() / 1000),
  };
  const query = Object.keys(withTs)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(withTs[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  return `${query}&w_rid=${createHash('md5').update(query + mixin).digest('hex')}`;
}

// ── 小工具 ─────────────────────────────────────────────────────────────────

function liveTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1_000_000_000_000 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(raw)) return liveTimestamp(Number(raw));
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)
    ? raw
    : `${raw.replace(' ', 'T')}+08:00`;
  const parsed = Date.parse(zoned);
  return Number.isFinite(parsed) ? parsed : null;
}

function toBuffer(raw: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function numOf(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
