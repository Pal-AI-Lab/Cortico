/**
 * WebUiFormat 提供不依赖 DOM 的纯格式化函数，供各 WebUI 面板使用统一显示口径。
 */

import type { WebUiFormat } from '../../shared/client-panel.ts';

/** 补零到两位。`4` → `04` */
function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

const symbols = new Map<string, string>();
/**
 * A currency's symbol: ¥ for CNY, € for EUR, $ for USD. Other dollars keep their country (HK$, CA$) so they
 * are not read as US dollars; a code the runtime does not know stays as the code.
 */
export function currencySymbol(currency?: string): string {
  const code = currency || 'USD';
  let symbol = symbols.get(code);
  if (symbol === undefined) {
    const shown = (currencyDisplay: 'narrowSymbol' | 'symbol') => new Intl.NumberFormat('en', { style: 'currency', currency: code, currencyDisplay }).formatToParts(0).find(part => part.type === 'currency')?.value;
    try { symbol = shown('narrowSymbol'); if (symbol === '$' && code !== 'USD') symbol = shown('symbol'); } catch { symbol = undefined; }
    if (!symbol || symbol === code) symbol = code;
    symbols.set(code, symbol);
  }
  return symbol;
}

/** A currency named in a list or label: its symbol and code (¥ CNY), since ¥ alone is also JPY. */
export function currencyName(currency?: string): string {
  const code = currency || 'USD', symbol = currencySymbol(code);
  return symbol === code ? code : `${symbol} ${code}`;
}

/**
 * An amount with its currency's symbol (¥1.46, $0.13, -$0.20); a code without a symbol precedes it. Average costs may
 * request three decimals. An amount that rounds to zero is written without a sign.
 */
export function formatMoney(n: number | null | undefined, currency?: string, decimals: 2 | 3 = 2): string {
  const code = currency || 'USD', symbol = currencySymbol(code);
  const digits = Math.abs(n ?? 0).toFixed(decimals);
  const sign = (n ?? 0) < 0 && Number(digits) !== 0 ? '-' : '';
  return sign + (symbol === code ? code + ' ' : symbol) + digits;
}

export const webUiFormat: WebUiFormat = {
  /** **满 10000 才转 k**（9999 仍是 9999，不是 10.0k） */
  count(n) {
    return n == null ? '—' : n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  },

  /** null 给空串（不是 `—`），单位是 1024 进制的 `B/K/M` */
  bytes(n) {
    return n == null
      ? ''
      : n < 1024
        ? n + 'B'
        : n < 1048576
          ? (n / 1024).toFixed(1) + 'K'
          : (n / 1048576).toFixed(1) + 'M';
  },

  /** `0.42` → `42%`，四舍五入到整数 */
  percent(r) {
    return r == null ? '—' : Math.round(r * 100) + '%';
  },

  /**
   * ISO 串直接切 `11..19` 位拿 `HH:MM:SS`。
   * 不 `new Date()` 是有意的——服务端给的就是本地时间串，转一道反而会带上时区偏移。
   * 非字符串或长度不足 19 → 空串。
   */
  clock(ts) {
    return typeof ts === 'string' && ts.length >= 19 ? ts.slice(11, 19) : '';
  },

  money: formatMoney,

  /**
   * 毫秒时长，口径在这里定死：
   *
   * - `null` / 非有限数 → `—`（与 `count` / `percent` 一致，空值都是破折号）
   * - 负数按 0 处理
   * - `< 1s`：整毫秒，`999` → `999ms`
   * - `< 1min`：一位小数，`1200` → `1.2s`
   * - `< 1h`：`3m 04s`（秒补零，好竖排对齐）
   * - 更长：`1h 00m`
   *
   * 先把 1s 以上的值**量化到 0.1s** 再分档，免得 `59999` 落进秒档印出 `60.0s`
   * 这种自相矛盾的读数（量化后它是 `1m 00s`）。
   */
  duration(ms) {
    if (ms == null || !Number.isFinite(ms)) return '—';
    const raw = ms < 0 ? 0 : ms;
    const t = raw < 1000 ? Math.round(raw) : Math.round(raw / 100) * 100;
    if (t < 1000) return t + 'ms';
    if (t < 60_000) return (t / 1000).toFixed(1) + 's';
    if (t < 3_600_000) return Math.floor(t / 60_000) + 'm ' + pad2(Math.floor((t % 60_000) / 1000)) + 's';
    return Math.floor(t / 3_600_000) + 'h ' + pad2(Math.floor((t % 3_600_000) / 60_000)) + 'm';
  },
};
