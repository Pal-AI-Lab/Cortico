/**
 * 控制台 HTTP 接口；面板通过 ctx.invoke、invokeBinary、pickPath、setConfig 调用。
 * 请求携带界面语言并接受取消信号；panelRoute 负责 page id 的编码。
 * 非 2xx 与解析失败抛 ConsoleInvokeError，消息优先使用服务端 error，附带响应片段。
 * AbortError 原样抛出；空成功响应返回 null，二进制接口返回 Blob。
 */

import {
  CONSOLE_AUTH_HEADER,
  CONSOLE_MANIFEST_ROUTE,
  panelRoute,
  type ConsoleManifest,
} from '../../shared/console-protocol.ts';
import { ConsoleInvokeError } from '../../shared/client-panel.ts';
import type { ConfigValue } from '../../../core/config-schema.ts';
import {
  PATH_PICKER_ROUTE,
  type PathPickerOptions,
  type PathPickerResponse,
} from '../../shared/path-picker.ts';
import { languageHeaders, pick } from './language.ts';

const zh = {
  httpStatus: (status: number, snippet: string) => `HTTP ${status}：${snippet}`,
  notJson: (status: number, snippet: string) => `响应不是合法 JSON（HTTP ${status}）：${snippet}`,
};
const en: typeof zh = {
  httpStatus: (status: number, snippet: string) => `HTTP ${status}: ${snippet}`,
  notJson: (status: number, snippet: string) => `Response is not valid JSON (HTTP ${status}): ${snippet}`,
};
const S = pick({ zh, en });

/** 所有请求都接受一个取消信号；面板一律传 `ctx.signal`。 */
export interface RequestOptions {
  signal?: AbortSignal;
  keepalive?: boolean;
}

/** 错误消息附带的响应片段长度上限。 */
const SNIPPET_MAX = 200;

function snippet(text: string): string {
  const s = text.trim();
  return s.length > SNIPPET_MAX ? `${s.slice(0, SNIPPET_MAX)}…` : s;
}

/** 按 name 识别 AbortError，兼容跨 realm 异常。 */
function isAbortError(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'AbortError';
}

/** 把任意异常收敛成 `ConsoleInvokeError`；abort 与已经归一化过的原样放行。 */
function normalizeError(err: unknown, status: number): never {
  if (isAbortError(err)) throw err;
  if (err instanceof ConsoleInvokeError) throw err;
  throw new ConsoleInvokeError(String(err), status);
}

async function send(path: string, init: RequestInit, opts?: RequestOptions): Promise<Response> {
  try {
    const res = await fetch(path, {
      ...init,
      headers: { ...languageHeaders(), ...(init.headers as Record<string, string> | undefined) },
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(opts?.keepalive ? { keepalive: true } : {}),
    });
    // 登录态失效:重新载入入口页,服务端在那里给出登录页。
    if (res.status === 401 && res.headers.get(CONSOLE_AUTH_HEADER) !== null) location.reload();
    return res;
  } catch (err) {
    // fetch reject = 网络层没走到 HTTP，没有状态码可言，记 0。
    normalizeError(err, 0);
  }
}

/** 读取响应体也可能抛出 AbortError，原样传递。 */
async function readText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    normalizeError(err, res.status);
  }
}

/** 非 2xx 的统一出口：优先服务端措辞，其次 `HTTP <status>`（带响应片段）。 */
async function throwHttpError(res: Response): Promise<never> {
  const text = await readText(res);
  let message = `HTTP ${res.status}`;
  try {
    const parsed = JSON.parse(text) as { error?: unknown } | null;
    const err = parsed?.error;
    if (typeof err === 'string' && err !== '') message = err;
  } catch {
    if (text.trim() !== '') message = S.httpStatus(res.status, snippet(text));
  }
  throw new ConsoleInvokeError(message, res.status);
}

/** 成功响应解析为 JSON；204 或空正文返回 null，解析失败抛 ConsoleInvokeError。 */
async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) await throwHttpError(res);
  if (res.status === 204) return null as T;
  const text = await readText(res);
  if (text.trim() === '') return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ConsoleInvokeError(S.notJson(res.status, snippet(text)), res.status);
  }
}

async function readBlob(res: Response): Promise<Blob> {
  if (!res.ok) await throwHttpError(res);
  try {
    return await res.blob();
  } catch (err) {
    normalizeError(err, res.status);
  }
}

// ---------------------------------------------------------------------------
// 通用动词
// ---------------------------------------------------------------------------

export async function get<T>(path: string, opts?: RequestOptions): Promise<T> {
  return readJson<T>(await send(path, { method: 'GET' }, opts));
}

/**
 * `post` 只负责序列化传进来的 body —— `{ args }` 这个形状是 panel RPC 的约定，
 * 由 `invokePanel` 负责，不在这里硬编码。
 */
export async function post<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  };
  return readJson<T>(await send(path, init, opts));
}

/** 上传二进制正文。 */
export async function postBlob<T>(
  path: string,
  body: Blob,
  opts?: RequestOptions,
): Promise<T> {
  return readJson<T>(await send(path, {
    method: 'POST',
    headers: { 'Content-Type': body.type || 'application/octet-stream' },
    body,
  }, opts));
}

/** 打开运行 WebApp 的主机上的本机路径选择器。 */
export async function pickPath(options: PathPickerOptions, opts?: RequestOptions): Promise<string | null> {
  const response = await post<PathPickerResponse>(PATH_PICKER_ROUTE, options, opts);
  return response.path;
}

/** 控制台页面板写配置的窄入口；服务端仍按组 schema 校验。 */
export async function setConfig(
  groupId: string,
  values: Record<string, ConfigValue>,
  opts?: RequestOptions,
): Promise<string> {
  const response = await post<{ result?: string }>('/api/config', { group: groupId, values }, opts);
  return response.result || groupId;
}

// ---------------------------------------------------------------------------
// Console 协议
// ---------------------------------------------------------------------------

export async function fetchManifest(opts?: RequestOptions): Promise<ConsoleManifest> {
  return get<ConsoleManifest>(CONSOLE_MANIFEST_ROUTE, opts);
}

/** 面板数据面调用。走 POST，body 形如 `{"args":[...]}`。 */
export async function invokePanel<T>(
  pageId: string,
  panelId: string,
  method: string,
  args?: unknown[],
  opts?: RequestOptions,
): Promise<T> {
  return post<T>(panelRoute(pageId, panelId, method), { args: args ?? [] }, opts);
}

/** 同上，但按二进制取回（音频试听、图片这类）。 */
export async function invokePanelBinary(
  pageId: string,
  panelId: string,
  method: string,
  args?: unknown[],
  opts?: RequestOptions,
): Promise<Blob> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ args: args ?? [] }),
  };
  return readBlob(await send(panelRoute(pageId, panelId, method), init, opts));
}
