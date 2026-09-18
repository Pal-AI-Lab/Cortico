/**
 * 控制台访问密码。密码为空时不启用，所有请求照常放行。
 * 登录令牌无状态：由密码与数据目录里的随机盐导出的 HMAC，进程重启后仍有效，改密码使它失效；
 * 令牌自身不设到期，有效到改密码或退出登录为止。令牌放在 HttpOnly Cookie 里，
 * WebSocket 升级与只能带 URL 的 GET 调用随之携带。
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const SESSION_COOKIE = 'cortico_session';
export const AUTH_KEY_FILE = 'web-auth.key';
/** Cookie 的 Max-Age：浏览器对 Cookie 寿命的上限是 400 天（RFC 6265bis），取它即一直保留。 */
export const SESSION_COOKIE_MAX_AGE_SEC = 400 * 24 * 60 * 60;
/**
 * 每次失败的登录等这么久才回应，且失败串行处理：并发再多，猜测的总速率也不超过每秒一次。
 * 八位随机字母数字的密码空间约 2.8e14，按此速率穷举以百万年计；不设延迟时局域网内每秒可试数千次。
 * 正确的密码不进这条队列。
 */
export const FAILED_LOGIN_DELAY_MS = 1000;

function sameText(a: string, b: string): boolean {
  const digest = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** 取 Cookie 头里的一个值；没有或头不是字符串时为 null。 */
export function cookieValue(header: unknown, name: string): string | null {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

export class ConsoleAuth {
  private token: string | null = null;
  private failures: Promise<void> = Promise.resolve();

  constructor(
    private readonly password: string,
    private readonly keyFile: string,
    private readonly failedDelayMs: number = FAILED_LOGIN_DELAY_MS,
  ) {}

  get enabled(): boolean {
    return this.password !== '';
  }

  /** 这个密码在这个数据目录下的登录令牌；盐文件在第一次用到时生成。 */
  issue(): string {
    if (this.token === null) {
      let salt: Buffer;
      if (existsSync(this.keyFile)) {
        salt = Buffer.from(readFileSync(this.keyFile, 'utf8').trim(), 'hex');
      } else {
        salt = randomBytes(32);
        mkdirSync(dirname(this.keyFile), { recursive: true });
        writeFileSync(this.keyFile, `${salt.toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 });
      }
      const key = createHmac('sha256', salt).update(this.password, 'utf8').digest();
      this.token = createHmac('sha256', key).update(SESSION_COOKIE, 'utf8').digest('hex');
    }
    return this.token;
  }

  verify(token: string | null): boolean {
    return token !== null && token !== '' && sameText(token, this.issue());
  }

  /** 密码正确立即返回 true；错误的排队等 failedDelayMs 后返回 false。 */
  async login(candidate: string): Promise<boolean> {
    if (sameText(candidate, this.password)) return true;
    const turn = this.failures.then(() => new Promise<void>((resolve) => setTimeout(resolve, this.failedDelayMs)));
    this.failures = turn;
    await turn;
    return false;
  }
}
