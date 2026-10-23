/**
 * 换算币种是使用者的偏好，不属于某次挂载：记在这台机器的 localStorage，换页与重启后沿用。
 * 换键名或升版本号会让旧记录自然失效。
 */

const KEY = 'cortico:usage-currency:v1';

/** 上次选的币种；没有记录、读不到或存的不是字符串都算自动（空串）。 */
export function readCurrency(storage: Pick<Storage, 'getItem'> | null | undefined): string {
  if (!storage) return '';
  try {
    const raw = storage.getItem(KEY);
    return typeof raw === 'string' ? raw : '';
  } catch {
    // 无痕模式与沙箱 iframe 下读取会被拒，当作没记过。
    return '';
  }
}

/** 记下选的币种，空串表示自动。写不进去只影响下次启动，不影响本次会话。 */
export function writeCurrency(
  storage: Pick<Storage, 'setItem'> | null | undefined,
  value: string,
): void {
  if (!storage) return;
  try {
    storage.setItem(KEY, value);
  } catch {
    // 同读取。
  }
}

/** 从文档取 localStorage；离屏文档或沙箱里取不到时返回 null。 */
export function localStorageOf(doc: Document): Storage | null {
  try {
    return doc.defaultView?.localStorage ?? null;
  } catch {
    return null;
  }
}
