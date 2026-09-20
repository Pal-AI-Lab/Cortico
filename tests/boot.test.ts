import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  announceDataDir,
  consoleUrlOf,
  consumeBootFlags,
  isSupervised,
  READY_MESSAGE,
  requestRestart,
  RESTART_FLAG_FILE,
  RESTART_MESSAGE,
  startsPaused,
} from '../src/boot.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cortico-boot-'));
  dirs.push(dir);
  return dir;
}


function captureMessages(run: () => void): unknown[] {
  const sent: unknown[] = [];
  const original = process.send;
  process.send = ((message: unknown) => { sent.push(message); return true; }) as typeof process.send;
  try {
    run();
  } finally {
    process.send = original;
  }
  return sent;
}

describe('重启请求', () => {
  it('requestRestart 落下标志;consumeBootFlags 把它清掉', () => {
    const dir = tempDir();
    requestRestart(dir, {});
    expect(existsSync(join(dir, RESTART_FLAG_FILE))).toBe(true);
    consumeBootFlags(dir);
    expect(existsSync(join(dir, RESTART_FLAG_FILE))).toBe(false);
  });

  it('被启动器管着时,标志与 IPC 消息都出去', () => {
    const dir = tempDir();
    const sent = captureMessages(() => requestRestart(dir, { CORTICO_SUPERVISED: '1' }));
    expect(sent).toEqual([{ type: RESTART_MESSAGE }]);
    expect(existsSync(join(dir, RESTART_FLAG_FILE))).toBe(true);
  });

  it('没被启动器管着就只落文件,不碰 IPC 通道', () => {
    const dir = tempDir();
    const sent = captureMessages(() => requestRestart(dir, {}));
    expect(sent).toEqual([]);
    expect(existsSync(join(dir, RESTART_FLAG_FILE))).toBe(true);
  });
});

describe('报出 data 目录', () => {
  it('被启动器管着时报一次,让它找得到兜底的标志文件', () => {
    const sent = captureMessages(() => announceDataDir('/deploy/data', { CORTICO_SUPERVISED: '1' }));
    expect(sent).toEqual([{ type: READY_MESSAGE, dataDir: '/deploy/data' }]);
  });

  it('未设置受监管环境变量时不发送 IPC 消息', () => {
    expect(captureMessages(() => announceDataDir('/deploy/data', {}))).toEqual([]);
  });
});

describe('isSupervised', () => {
  it('只认 1 与 true', () => {
    expect(isSupervised({ CORTICO_SUPERVISED: '1' })).toBe(true);
    expect(isSupervised({ CORTICO_SUPERVISED: 'true' })).toBe(true);
    expect(isSupervised({})).toBe(false);
    expect(isSupervised({ CORTICO_SUPERVISED: '0' })).toBe(false);
  });
});

describe('startsPaused', () => {
  it('认环境变量的 1 与 true,也认 --paused', () => {
    expect(startsPaused({ CORTICO_START_PAUSED: '1' }, [])).toBe(true);
    expect(startsPaused({ CORTICO_START_PAUSED: 'true' }, [])).toBe(true);
    expect(startsPaused({ CORTICO_START_PAUSED: '0' }, [])).toBe(false);
    expect(startsPaused({}, [])).toBe(false);
    expect(startsPaused({}, ['node', 'launcher.ts', '--paused'])).toBe(true);
  });
});

describe('consoleUrlOf', () => {
  it('监听所有网卡时给回环地址,具体地址原样,IPv6 加方括号', () => {
    expect(consoleUrlOf('0.0.0.0', 7777)).toBe('http://127.0.0.1:7777/');
    expect(consoleUrlOf('::', 7777)).toBe('http://127.0.0.1:7777/');
    expect(consoleUrlOf('192.168.1.20', 7777)).toBe('http://192.168.1.20:7777/');
    expect(consoleUrlOf('::1', 7777)).toBe('http://[::1]:7777/');
    expect(consoleUrlOf(null, 7777)).toBe('http://127.0.0.1:7777/');
  });
});
