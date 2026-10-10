/**
 * bot 连接的状态与失败原因。失败原因转述服务器的断开理由或网络错误原文,前面标出
 * 能从理由的翻译键或原版英文措辞认出的类别;认不出类别时只给原文。
 */

/** 一次连接所用的目标;连接开启时锁定,改配置要重新连接才采用。 */
export interface LinkTarget {
  host: string;
  port: number;
  username: string;
  version: string;
}

/**
 * stopped:连接未开启;connecting:已发起连接,还没进入世界;online:已进入世界;
 * retrying:上一次连接失败或断开,在等下一次自动重连。
 */
export type LinkPhase = 'stopped' | 'connecting' | 'online' | 'retrying';

export interface LinkState {
  phase: LinkPhase;
  target: LinkTarget;
  /** 进入世界之后的连续失败次数;进入世界时归零 */
  attempt: number;
  /** 最近一次失败的原因;开启连接与进入世界时清空 */
  failure: string | null;
}

export function sameTarget(a: LinkTarget, b: LinkTarget): boolean {
  return a.host === b.host && a.port === b.port && a.username === b.username && a.version === b.version;
}

export function targetAddress(t: Pick<LinkTarget, 'host' | 'port'>): string {
  return `${t.host}:${t.port}`;
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
]);

/** 断开理由的翻译键前缀或原版英文措辞 → 类别 */
const KICK_KINDS: ReadonlyArray<{ kind: string; keys: readonly string[]; text: RegExp }> = [
  { kind: '白名单', keys: ['multiplayer.disconnect.not_whitelisted'], text: /white-?listed/i },
  {
    kind: '认证',
    keys: ['multiplayer.disconnect.unverified_username', 'multiplayer.disconnect.authservers_down'],
    text: /failed to verify username|authentication servers/i,
  },
  {
    kind: '版本',
    keys: ['multiplayer.disconnect.outdated_client', 'multiplayer.disconnect.outdated_server', 'multiplayer.disconnect.incompatible'],
    text: /outdated (client|server)|incompatible client/i,
  },
  { kind: '封禁', keys: ['multiplayer.disconnect.banned'], text: /\bbanned\b/i },
  {
    kind: '同名在线',
    keys: ['multiplayer.disconnect.name_taken', 'multiplayer.disconnect.duplicate_login'],
    text: /logged in from another location|name.*taken/i,
  },
];

/** 网络库报出的版本不符(nmp 的版本检查与 mineflayer 的协议表) */
const VERSION_ERROR = /this server is version|is not supported/i;

/** 服务器 NBT 形式的文本组件化成普通对象(1.20.3 起断开理由走 NBT) */
function simplifyNbt(node: unknown): unknown {
  if (!node || typeof node !== 'object' || !('type' in node) || !('value' in node)) return node;
  const { type, value } = node as { type: unknown; value: unknown };
  if (type === 'compound' && value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, simplifyNbt(v)]));
  }
  if (type === 'list' && value && typeof value === 'object' && 'value' in value) {
    const { type: itemType, value: items } = value as { type: unknown; value: unknown };
    return Array.isArray(items) ? items.map((item) => simplifyNbt({ type: itemType, value: item })) : [];
  }
  return value;
}

interface ChatParts {
  text: string;
  keys: string[];
}

function collect(node: unknown, out: ChatParts, depth: number): void {
  if (depth > 8 || node === null || node === undefined) return;
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    out.text += String(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collect(item, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  const c = simplifyNbt(node) as Record<string, unknown>;
  if (typeof c.text === 'string') out.text += c.text;
  if (typeof c.translate === 'string') {
    out.keys.push(c.translate);
    const args: ChatParts = { text: '', keys: out.keys };
    const withArgs = Array.isArray(c.with) ? c.with : [];
    const rendered = withArgs.map((arg) => {
      args.text = '';
      collect(arg, args, depth + 1);
      return args.text;
    });
    out.text += rendered.length ? `${c.translate}(${rendered.join(', ')})` : c.translate;
  }
  if (Array.isArray(c.extra)) collect(c.extra, out, depth + 1);
}

/** 断开理由(JSON 文本、组件对象或 NBT)的纯文本与其中的翻译键。 */
export function kickReasonText(reason: unknown): ChatParts {
  let node = reason;
  if (typeof reason === 'string') {
    try {
      node = JSON.parse(reason);
    } catch {
      return { text: reason, keys: [] };
    }
  }
  const out: ChatParts = { text: '', keys: [] };
  collect(node, out, 0);
  return { text: out.text.trim() || (typeof reason === 'string' ? reason : JSON.stringify(reason)), keys: out.keys };
}

/** 被服务器断开时的原因:类别 + 服务器给的原文。 */
export function kickFailure(reason: unknown): string {
  const { text, keys } = kickReasonText(reason);
  const hit = KICK_KINDS.find((k) => keys.some((key) => k.keys.some((p) => key.startsWith(p))) || k.text.test(text));
  return `被服务器断开${hit ? `(${hit.kind})` : ''}:${text}`;
}

/** 连接或登录过程中的错误;`end` 是没有错误时连接关闭的理由。 */
export function errorFailure(err: Error | null, end?: string): string {
  if (!err) return `连接关闭:${end ?? '原因不明'}`;
  const code = (err as NodeJS.ErrnoException).code ?? '';
  if (NETWORK_CODES.has(code) || [...NETWORK_CODES].some((c) => err.message.includes(c))) return `网络:${err.message}`;
  if (VERSION_ERROR.test(err.message)) return `版本:${err.message}`;
  return err.message;
}
