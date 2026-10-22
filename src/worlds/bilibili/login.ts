/**
 * 网页扫码登录换 SESSDATA。`start` 向 B 站要一个确认页链接，在已登录 B 站的浏览器里打开它点确认即完成登录。
 * 之后本模块每 2 秒轮询一次，把登录响应 `Set-Cookie` 里的 SESSDATA 交给 `onSessdata`。链接由 B 站在约 180 秒后作废。
 */
import { UA } from './client.ts';

const DEFAULT_PASSPORT = 'https://passport.bilibili.com';
const POLL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** 轮询请求连续失败超过这么久就放弃；B 站作废链接的时间与此相同。 */
const GIVE_UP_MS = 180_000;

const CODE_DONE = 0;
const CODE_WAITING = 86101;
const CODE_SCANNED = 86090;
const CODE_EXPIRED = 86038;

/** `scanned`:确认页已打开(或 App 已扫码),等待点确认。 */
export type LoginPhase = 'idle' | 'waiting' | 'scanned' | 'done' | 'expired' | 'failed';

export interface LoginState {
  phase: LoginPhase;
  /** 确认页链接，仅 waiting 与 scanned 时有值。 */
  url: string | null;
  /** 登录成功的账号 uid。 */
  uid: number | null;
  error: string | null;
}

export interface BrowserLoginOptions {
  onSessdata(sessdata: string): void;
  /** B 站账号接口的根地址；测试指向本机假服务。 */
  passportBase?: string;
  pollMs?: number;
}

const IDLE: LoginState = { phase: 'idle', url: null, uid: null, error: null };

export class BrowserLogin {
  private state: LoginState = { ...IDLE };
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: BrowserLoginOptions) {}

  get current(): LoginState {
    return { ...this.state };
  }

  /** 作废进行中的登录，换一个新链接。 */
  async start(): Promise<LoginState> {
    const generation = this.reset();
    const body = await this.request('/x/passport-login/web/qrcode/generate');
    const data = object(body.data);
    const url = typeof data.url === 'string' ? data.url : '';
    const key = typeof data.qrcode_key === 'string' ? data.qrcode_key : '';
    if (body.code !== 0 || !url || !key) {
      throw new Error(`B 站没有给出登录链接:code=${String(body.code)} ${String(body.message ?? '')}`);
    }
    if (generation !== this.generation) return this.current;
    this.state = { phase: 'waiting', url, uid: null, error: null };
    this.schedule(generation, key, Date.now());
    return this.current;
  }

  cancel(): LoginState {
    this.reset();
    return this.current;
  }

  private reset(): number {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.state = { ...IDLE };
    return ++this.generation;
  }

  private schedule(generation: number, key: string, lastOkAt: number): void {
    this.timer = setTimeout(() => {
      void this.poll(generation, key, lastOkAt).catch((error: unknown) => {
        if (generation === this.generation) this.state = { ...IDLE, phase: 'failed', error: errorText(error) };
      });
    }, this.opts.pollMs ?? POLL_MS);
    this.timer.unref?.();
  }

  private async poll(generation: number, key: string, lastOkAt: number): Promise<void> {
    let response: Response;
    let body: Record<string, unknown>;
    try {
      response = await this.fetch(`/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`);
      body = object(await response.json());
    } catch (error) {
      if (generation !== this.generation) return;
      if (Date.now() - lastOkAt > GIVE_UP_MS) {
        this.state = { ...IDLE, phase: 'failed', error: `查询登录状态失败:${errorText(error)}` };
        return;
      }
      this.schedule(generation, key, lastOkAt);
      return;
    }
    if (generation !== this.generation) return;
    const data = object(body.data);
    const code = data.code;
    if (code === CODE_WAITING || code === CODE_SCANNED) {
      this.state = { ...this.state, phase: code === CODE_SCANNED ? 'scanned' : 'waiting' };
      this.schedule(generation, key, Date.now());
      return;
    }
    if (code === CODE_EXPIRED) {
      this.state = { ...IDLE, phase: 'expired' };
      return;
    }
    if (code !== CODE_DONE) {
      this.state = { ...IDLE, phase: 'failed', error: `B 站返回 code=${String(code ?? body.code)} ${String(data.message ?? body.message ?? '')}` };
      return;
    }
    const cookies = response.headers.getSetCookie();
    const sessdata = cookieValue(cookies, 'SESSDATA');
    if (!sessdata) {
      this.state = { ...IDLE, phase: 'failed', error: 'B 站确认了登录，但响应里没有 SESSDATA' };
      return;
    }
    try {
      this.opts.onSessdata(sessdata);
    } catch (error) {
      this.state = { ...IDLE, phase: 'failed', error: `保存登录凭证失败:${errorText(error)}` };
      return;
    }
    const uid = Number(cookieValue(cookies, 'DedeUserID'));
    this.state = { ...IDLE, phase: 'done', uid: Number.isSafeInteger(uid) && uid > 0 ? uid : null };
  }

  private async request(path: string): Promise<Record<string, unknown>> {
    const response = await this.fetch(path);
    if (!response.ok) throw new Error(`B 站账号接口 HTTP ${response.status}`);
    return object(await response.json());
  }

  private fetch(path: string): Promise<Response> {
    return fetch(`${this.opts.passportBase ?? DEFAULT_PASSPORT}${path}`, {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }
}

/** Cookie 值原样返回;SESSDATA 里的 `%2C` 属于值本身，不解码。 */
function cookieValue(setCookies: readonly string[], name: string): string | null {
  for (const line of setCookies) {
    const pair = line.split(';', 1)[0];
    const eq = pair.indexOf('=');
    if (eq > 0 && pair.slice(0, eq).trim() === name) {
      const value = pair.slice(eq + 1).trim();
      if (value) return value;
    }
  }
  return null;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
