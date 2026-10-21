/**
 * Windows 上杀毒软件、索引器、同步盘会在文件刚写完时短暂独占打开它，这时 rename 与 open
 * 报 EBUSY、EPERM 或 EACCES。做法同 graceful-fs:只在 Windows 上对这三种错误退避重试，
 * 这里是同步调用，总共等约半秒;仍失败就照原样抛出。其他平台与其他错误立即抛出。
 */
const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const BACKOFF_MS = [10, 30, 60, 120, 250];
const sleeper = new Int32Array(new SharedArrayBuffer(4));

export function retryBusy<T>(op: () => T): T {
  for (const ms of BACKOFF_MS) {
    try {
      return op();
    } catch (e) {
      if (process.platform !== 'win32' || !BUSY_CODES.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
      Atomics.wait(sleeper, 0, 0, ms);
    }
  }
  return op();
}
