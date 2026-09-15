import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { Logger } from '../../../src/core/types.ts';
import { nullLogger } from '../../../src/core/util.ts';
import { gzipSync } from 'node:zlib';
import {
  MinecraftServerManager, REALM_MARKER_FILE, parseDifficultyReply, planGameRuleAlignment, readRealmMarker,
} from '../../../src/worlds/minecraft/server.ts';

/**
 * 通过 commandOverride 运行 Node 服务端夹具，不启动 Java 或监听 MC 端口；就绪、进度和收尾使用 stdout/stdin。
 */

const SEP = String.fromCharCode(92);
const posix = (p: string): string => p.split(SEP).join('/');

/** 取一个没人用的端口:探测必须失败,否则 start() 会认成「外部服务器已在跑」 */
async function deadPort(): Promise<number> {
  return await new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 夹具骨架:body 之外统一接 stop(不接的话每次收尾都要空等满 15 秒优雅期限) */
function fixture(body: string, onStop = ''): string {
  return [
    `let _b='';`,
    `process.stdin.on('data',d=>{_b+=d;if(_b.includes('stop')){${onStop}process.exit(0);}});`,
    body,
    `setInterval(()=>{},1000);`,
  ].join('');
}

describe('MinecraftServerManager:就绪判据与存档退出', () => {
  let mgr: MinecraftServerManager | null = null;
  afterEach(async () => {
    await mgr?.stop();
    mgr = null;
  });

  function makeMgr(script: string, port: number, extra: Record<string, unknown> = {}): MinecraftServerManager {
    return new MinecraftServerManager({
      serverDir: () => '',
      javaPath: () => '',
      jvmArgs: () => '',
      host: () => '127.0.0.1',
      port: () => port,
      log: nullLogger(),
      commandOverride: { command: process.execPath, args: ['-e', script] },
      healthIntervalMs: 30,
      ...extra,
    });
  }

  it('关闭态拒绝启动进程，开启后才恢复托管启动', async () => {
    const port = await deadPort();
    const dir = mkdtempSync(join(tmpdir(), 'mcsrv-switch-'));
    const marker = join(dir, 'spawned.txt');
    let enabled = false;
    try {
      const script = fixture(
        `require('node:fs').writeFileSync(${JSON.stringify(posix(marker))},'yes');` +
        `console.log('Done (0.100s)! For help, type "help"');`,
      );
      mgr = makeMgr(script, port, { enabled: () => enabled });
      const probe = vi.spyOn(mgr as unknown as { probe(): Promise<boolean> }, 'probe');

      const disabled = await mgr.start();
      expect(disabled).toMatchObject({ enabled: false, phase: 'stopped' });
      expect(disabled.detail).toContain('开关已关闭');
      expect(existsSync(marker)).toBe(false);
      expect(probe).not.toHaveBeenCalled();

      enabled = true;
      const starting = await mgr.start();
      expect(starting.enabled).toBe(true);
      await waitFor(() => existsSync(marker));
    } finally {
      await mgr?.stop();
      mgr = null;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('启动健康探针在途时 stop，迟到的成功结果不能复活相位或存档定时器', async () => {
    vi.useFakeTimers();
    let enabled = true;
    const pending: { resolve: ((reachable: boolean) => void) | null } = { resolve: null };
    mgr = makeMgr('', 1, { enabled: () => enabled, healthIntervalMs: 30 });
    const internals = mgr as unknown as {
      phase: 'stopped' | 'starting' | 'running' | 'error';
      proc: object | null;
      saveTimer: ReturnType<typeof setInterval> | null;
      beginHealthPolling(): void;
      probe(): Promise<boolean>;
    };
    internals.phase = 'starting';
    internals.proc = {};
    vi.spyOn(internals, 'probe').mockImplementation(() => new Promise<boolean>((resolve) => {
      pending.resolve = resolve;
    }));
    internals.beginHealthPolling();
    await vi.advanceTimersByTimeAsync(30);
    expect(pending.resolve).not.toBeNull();

    enabled = false;
    await mgr.stop();
    pending.resolve?.(true);
    await Promise.resolve();

    expect(internals.phase).toBe('stopped');
    expect(internals.saveTimer).toBeNull();
    vi.useRealTimers();
  });

  it('初始端口探针在途时关闭开关，迟到结果不能在 stop 之后启动进程', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcsrv-cancel-start-'));
    const marker = join(dir, 'spawned.txt');
    let enabled = true;
    const pending: { resolve: ((reachable: boolean) => void) | null } = { resolve: null };
    try {
      const script = fixture(`require('node:fs').writeFileSync(${JSON.stringify(posix(marker))},'yes');`);
      mgr = makeMgr(script, 1, { enabled: () => enabled });
      vi.spyOn(mgr as unknown as { probe(): Promise<boolean> }, 'probe')
        .mockImplementation(() => new Promise<boolean>((resolve) => {
          pending.resolve = resolve;
        }));

      const starting = mgr.start();
      await Promise.resolve();
      expect(pending.resolve).not.toBeNull();
      enabled = false;
      await mgr.stop();
      pending.resolve?.(false);
      const cancelled = await starting;

      expect(cancelled).toMatchObject({ enabled: false, phase: 'stopped', pid: null });
      expect(existsSync(marker)).toBe(false);
    } finally {
      await mgr?.stop();
      mgr = null;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stdout 报 Done 即算就绪,不必等 TCP 探测通', async () => {
    const port = await deadPort();
    // 端口从头到尾没人监听,裸探测永远不会成功;就绪只能来自这一行
    const script = fixture(`console.log('[00:00:07] [Server thread/INFO]: Done (7.421s)! For help, type "help"');`);
    mgr = makeMgr(script, port);
    await mgr.start();
    await waitFor(async () => (await mgr!.state()).phase === 'running');
  });

  it('运行中锁存启动目录,停止后才采用新配置目录', async () => {
    const port = await deadPort();
    const launchDir = mkdtempSync(join(tmpdir(), 'mc-server-launch-'));
    const nextDir = mkdtempSync(join(tmpdir(), 'mc-server-next-'));
    let configuredDir = launchDir;

    try {
      writeFileSync(join(launchDir, 'server.jar'), '');
      writeFileSync(join(nextDir, 'server.jar'), '');
      const script = fixture(`console.log('Done (1.001s)! For help, type "help"');`);
      mgr = makeMgr(script, port, { serverDir: () => configuredDir });

      await mgr.start();
      await waitFor(async () => (await mgr!.state()).phase === 'running');
      configuredDir = nextDir;

      const running = await mgr.state();
      expect(running.serverDir).toBe(launchDir);
      expect(running.configured).toBe(true);

      const stopped = await mgr.stop();
      mgr = null;
      expect(stopped.serverDir).toBe(nextDir);
    } finally {
      await mgr?.stop();
      mgr = null;
      rmSync(launchDir, { recursive: true, force: true });
      rmSync(nextDir, { recursive: true, force: true });
    }
  });

  /**
   * 并发 start 在 await probe() 期间也须互斥，不能等 spawn 后设置 starting 才排除第二次启动。
   */
  it('并发两次 start 只起一个进程', async () => {
    const port = await deadPort();
    const log = posix(join(mkdtempSync(join(tmpdir(), 'mcsrv-')), 'pids.txt'));
    const script = [
      `require('node:fs').appendFileSync(${JSON.stringify(log)},process.pid+'\\n');`,
      `let _b='';process.stdin.on('data',d=>{_b+=d;if(_b.includes('stop'))process.exit(0);});`,
      `console.log('Done (1.001s)! For help, type "help"');`,
      // 漏起的第二个进程收不到 stop:自己到点退,别把它留给测试收尾
      `setTimeout(()=>process.exit(0),5000);`,
    ].join('');
    mgr = makeMgr(script, port);
    await Promise.all([mgr.start(), mgr.start()]);
    await waitFor(async () => (await mgr!.state()).phase === 'running');
    await new Promise((r) => setTimeout(r, 100));
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('世界生成有进度就把就绪期限往后推,不再误杀健康进程', async () => {
    const port = await deadPort();
    // 夹具每 100ms 输出进度而不就绪；1500ms 期限为并发负载下 Node 首次输出留余量，持续进度不应被判启动失败。
    const script = fixture(`setInterval(()=>console.log('[Server thread/INFO]: Preparing start region for dimension minecraft:the_nether'),100);`);
    mgr = makeMgr(script, port, { healthTimeoutMs: 1500 });
    await mgr.start();
    await new Promise((r) => setTimeout(r, 3500)); // 远超期限
    expect((await mgr.state()).phase).toBe('starting');
  });

  it('真超时走 stop 存档退出,不再 kill', async () => {
    const port = await deadPort();
    const marker = posix(join(mkdtempSync(join(tmpdir(), 'mcsrv-')), 'stopped.txt'));
    // 收到 stop 才落标记:这个标记就是「它被给过存档的机会」的唯一证据
    const script = fixture('', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ok');`);
    mgr = makeMgr(script, port, { healthTimeoutMs: 150 });
    await mgr.start();
    await waitFor(async () => (await mgr!.state()).phase === 'error');
    expect((await mgr.state()).detail).toContain('启动超时');
    await waitFor(() => existsSync(marker));
    expect(readFileSync(marker, 'utf8')).toBe('ok');
  });

  /** 退出码分流唯一看得见的地方就是日志级别 */
  function recordingLog(errs: string[], infos: string[]): Logger {
    return {
      ...nullLogger(),
      warn: (msg: string) => void errs.push(msg),
      error: (msg: string) => void errs.push(msg),
      info: (msg: string) => void infos.push(msg),
    };
  }

  /** 就绪后自己按给定退出码退,mgr.stop() 一次都没被调用过 —— 游戏内 /stop 就是这个形态 */
  function selfExitFixture(code: number): string {
    return [
      `console.log('Done (1.001s)! For help, type "help"');`,
      `setTimeout(()=>{console.log('[Server thread/INFO]: All chunks are saved');`,
      `process.exit(${code});},150);`,
      `setInterval(()=>{},1000);`,
    ].join('');
  }

  // 服务端 code=0 表示干净退出，即使退出回调前相位尚未切换到 stopped。
  it('code=0 是干净退出:相位 stopped、info 级、文案不含「异常」', async () => {
    const port = await deadPort();
    const warns: string[] = [];
    const infos: string[] = [];
    mgr = makeMgr(selfExitFixture(0), port, { log: recordingLog(warns, infos) });
    await mgr.start();
    await waitFor(async () => (await mgr!.state()).phase === 'stopped');

    expect((await mgr.state()).detail).toContain('code=0');
    expect(warns.join('\n')).not.toContain('异常');
    expect(infos.some((m) => m.includes('已退出'))).toBe(true);
  });

  // 服务端非零退出以 error 报告故障。
  it('非 0 退出仍是故障:相位 error,error 级报「MC 服务器异常」', async () => {
    const port = await deadPort();
    const errs: string[] = [];
    const infos: string[] = [];
    const levels: string[] = [];
    const log = { ...recordingLog(errs, infos), error: (msg: string) => { levels.push('error'); errs.push(msg); } };
    mgr = makeMgr(selfExitFixture(3), port, { log });
    await mgr.start();
    await waitFor(async () => (await mgr!.state()).phase === 'error');

    expect((await mgr.state()).detail).toContain('code=3');
    expect(errs.join('\n')).toContain('MC 服务器异常');
    expect(levels).toContain('error');
  });

  /** 把子进程收到的每一条 stdin 追加到一个文件里,收到 stop 才退。 */
  function recordingFixture(log: string): string {
    return [
      `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(log)},'');`,
      `process.stdin.on('data',d=>{fs.appendFileSync(${JSON.stringify(log)},String(d));`,
      `if(String(d).includes('stop'))process.exit(0);});`,
      `console.log('Done (1.001s)! For help, type "help"');`,
      `setInterval(()=>{},1000);`,
    ].join('');
  }

  it('收尾先 save-all flush 再 stop:15 秒收不掉时至少已经落过一次盘', async () => {
    const port = await deadPort();
    const log = posix(join(mkdtempSync(join(tmpdir(), 'mcsrv-')), 'cmds.txt'));
    mgr = makeMgr(recordingFixture(log), port);
    await mgr.start();
    await waitFor(async () => (await mgr!.state()).phase === 'running');
    await mgr.stop();
    mgr = null;
    const sent = readFileSync(log, 'utf8');
    expect(sent).toContain('save-all flush');
    // 次序不能反:先存再停
    expect(sent.indexOf('save-all flush')).toBeLessThan(sent.indexOf('stop'));
  });

  /**
   * 收到 SIGHUP 时立即发送 save-all 与 stop，为外部关闭提供存档机会。
   */
  it('收到 SIGHUP 立刻补一次 save-all + stop(手滑关窗的兜底)', async () => {
    const port = await deadPort();
    const log = posix(join(mkdtempSync(join(tmpdir(), 'mcsrv-')), 'cmds.txt'));
    mgr = makeMgr(recordingFixture(log), port);
    await mgr.start();
    await waitFor(async () => (await mgr!.state()).phase === 'running');
    // 直接触发监听器:不真发信号(会打死跑测试的这个进程)
    process.emit('SIGHUP');
    await waitFor(() => {
      const sent = readFileSync(log, 'utf8');
      return sent.includes('save-all flush') && sent.includes('stop');
    });
  });

  it('对端关掉 stdin 后再写指令:EPIPE 只进日志,不成为未处理错误', async () => {
    const port = await deadPort();
    const script = [
      `process.stdin.destroy();`,
      `console.log('Done (1.001s)! For help, type "help"');`,
      `setTimeout(()=>process.exit(0),600);`,
    ].join('');
    mgr = makeMgr(script, port);
    await mgr.start();
    await waitFor(async () => (await mgr!.state()).phase === 'running');
    // 流还标着可写,指令照发;错误在之后一拍才到
    expect(mgr.command('save-all')).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
  });

  it('没有托管进程时不占监听位:停掉之后信号不再有人接', async () => {
    const port = await deadPort();
    const before = process.listenerCount('SIGHUP');
    mgr = makeMgr(recordingFixture(posix(join(mkdtempSync(join(tmpdir(), 'mcsrv-')), 'cmds.txt'))), port);
    await mgr.start();
    await waitFor(async () => (await mgr!.state()).phase === 'running');
    expect(process.listenerCount('SIGHUP')).toBe(before + 1);
    await mgr.stop();
    mgr = null;
    // 反复起停不该攒下一堆指向已退出进程的死回调
    expect(process.listenerCount('SIGHUP')).toBe(before);
  });

  it('就绪后低频写 save-all;停掉后不再写', async () => {
    const port = await deadPort();
    const log = posix(join(mkdtempSync(join(tmpdir(), 'mcsrv-')), 'cmds.txt'));
    const script = [
      `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(log)},'');`,
      `process.stdin.on('data',d=>{fs.appendFileSync(${JSON.stringify(log)},String(d));`,
      `if(String(d).includes('stop'))process.exit(0);});`,
      `console.log('Done (1.001s)! For help, type "help"');`,
      `setInterval(()=>{},1000);`,
    ].join('');
    mgr = makeMgr(script, port, { autoSaveMs: 60 });
    await mgr.start();
    await waitFor(async () => (await mgr!.state()).phase === 'running');
    await waitFor(() => readFileSync(log, 'utf8').includes('save-all'));
    await mgr.stop();
    mgr = null;
    const atStop = readFileSync(log, 'utf8').length;
    await new Promise((r) => setTimeout(r, 300));
    // 停掉之后定时器必须一起停:除了收尾那条 stop,不该再冒出新的 save-all
    expect(readFileSync(log, 'utf8').slice(atStop)).not.toContain('save-all');
  });
});

/**
 * 服务端就绪后回读实际难度，不能仅沿用重启前的状态。
 */
describe('MinecraftServerManager:就绪后回读难度', () => {
  let mgr: MinecraftServerManager | null = null;
  afterEach(async () => {
    await mgr?.stop();
    mgr = null;
  });

  /** 收到 `difficulty` 就打一行回话的夹具;`reply` 是那一行的内容 */
  function difficultyFixture(reply: string): string {
    return [
      `let _b='';`,
      `process.stdin.on('data',d=>{_b+=d;`,
      `if(_b.includes('stop')){process.exit(0);}`,
      `if(_b.includes('difficulty')){console.log(${JSON.stringify(reply)});_b='';}});`,
      `console.log('Done (0.100s)! For help, type "help"');`,
      `setInterval(()=>{},1000);`,
    ].join('');
  }

  it.each([
    ['英文原版口径', '[12:00:00] [Server thread/INFO]: The difficulty is Easy', 'easy'],
    ['英文设置口径', 'The difficulty has been set to Hard', 'hard'],
    ['中文译文口径', '[12:00:00] [Server thread/INFO]: 难度为和平', 'peaceful'],
    ['中文设置口径', '游戏难度已设置为普通', 'normal'],
  ])('%s 都认得出来', async (_name, line, want) => {
    const port = await deadPort();
    const facts: Array<{ difficulty: string | null }> = [];
    mgr = new MinecraftServerManager({
      serverDir: () => '',
      javaPath: () => '',
      jvmArgs: () => '',
      host: () => '127.0.0.1',
      port: () => port,
      log: nullLogger(),
      commandOverride: { command: process.execPath, args: ['-e', difficultyFixture(line)] },
      healthIntervalMs: 30,
      onDifficulty: (fact) => facts.push(fact),
    });
    await mgr.start();
    await waitFor(() => facts.length === 1);
    expect(facts[0].difficulty).toBe(want);
  });

  it('服务端不回话:到期照样报一条「问了没问出来」,不静默', async () => {
    const port = await deadPort();
    const facts: Array<{ difficulty: string | null; raw: string | null }> = [];
    mgr = new MinecraftServerManager({
      serverDir: () => '',
      javaPath: () => '',
      jvmArgs: () => '',
      host: () => '127.0.0.1',
      port: () => port,
      log: nullLogger(),
      // 收到 difficulty 一声不吭的服务端
      commandOverride: { command: process.execPath, args: ['-e', fixture(`console.log('Done (0.100s)! For help, type "help"');`)] },
      healthIntervalMs: 30,
      difficultyTimeoutMs: 120,
      onDifficulty: (fact) => facts.push(fact),
    });
    await mgr.start();
    await waitFor(() => facts.length === 1);
    expect(facts[0]).toMatchObject({ difficulty: null, raw: null });
  });

  it('parseDifficultyReply 只认难度回话,别的日志行一概不认', () => {
    expect(parseDifficultyReply('Preparing spawn area: 40%')).toBeNull();
    expect(parseDifficultyReply('The difficulty is Peaceful')).toMatchObject({ difficulty: 'peaceful' });
    // 认得出是难度回话、但那个词不在四档里:照报 null,不猜
    expect(parseDifficultyReply('The difficulty is Nightmare')).toMatchObject({ difficulty: null });
  });
});

/**
 * Paper/Bukkit 各维度拥有独立 World 和 GameRules；启动后须检查跨维度规则并处理不一致。
 */
describe('MinecraftServerManager:跨维度 gamerule 对齐', () => {
  let mgr: MinecraftServerManager | null = null;
  afterEach(async () => {
    await mgr?.stop();
    mgr = null;
  });

  /** 只写得出 `Data/GameRules` 的最小 level.dat(真文件是 gzip NBT) */
  function levelDatWith(rules: Record<string, string>): Buffer {
    const name = (t: string): Buffer => {
      const body = Buffer.from(t, 'utf8');
      const head = Buffer.alloc(2);
      head.writeUInt16BE(body.length);
      return Buffer.concat([head, body]);
    };
    const str = (k: string, v: string): Buffer => Buffer.concat([Buffer.from([8]), name(k), name(v)]);
    const compound = (k: string, ...kids: Buffer[]): Buffer =>
      Buffer.concat([Buffer.from([10]), name(k), ...kids, Buffer.from([0])]);
    return gzipSync(Buffer.concat([
      Buffer.from([10]), name(''),
      compound('Data', compound('GameRules', ...Object.entries(rules).map(([k, v]) => str(k, v)))),
      Buffer.from([0]),
    ]));
  }

  /** 一份假存档:主世界 + 下界 + 末地各一份 level.dat(给 null 就不写那一份) */
  function serverDirWithRules(
    overworld: Record<string, string> | null,
    nether: Record<string, string> | null,
    end: Record<string, string> | null,
  ): string {
    const dir = mkdtempSync(join(tmpdir(), 'mcrule-'));
    writeFileSync(join(dir, 'server.properties'), 'level-name=w\nserver-port=25565\n', 'utf8');
    for (const [sub, rules] of [['w', overworld], ['w_nether', nether], ['w_the_end', end]] as const) {
      mkdirSync(join(dir, sub), { recursive: true });
      if (rules) writeFileSync(join(dir, sub, 'level.dat'), levelDatWith(rules));
    }
    return dir;
  }

  /** 就绪即回话的夹具(收到指令一概照收,写得进去就算发出去了) */
  const READY = fixture(`console.log('Done (0.100s)! For help, type "help"');`);

  /** 起到 running(对齐就发生在相位翻转那一刻)之后把 warn 交出来 */
  async function warnsAfterReady(dir: string): Promise<string[]> {
    const port = await deadPort();
    const warns: string[] = [];
    const base = nullLogger();
    const manager = new MinecraftServerManager({
      serverDir: () => dir,
      javaPath: () => '',
      jvmArgs: () => '',
      host: () => '127.0.0.1',
      port: () => port,
      log: { ...base, warn: (msg: string) => { warns.push(msg); } },
      commandOverride: { command: process.execPath, args: ['-e', READY] },
      healthIntervalMs: 30,
      difficultyTimeoutMs: 60,
    });
    mgr = manager;
    await manager.start();
    await waitFor(async () => (await manager.state()).phase === 'running');
    return warns;
  }

  it('下界那份对不上就按主世界补一条 execute in,并明说哪儿对不上', async () => {
    const dir = serverDirWithRules(
      { keepInventory: 'true' },
      { keepInventory: 'false' },
      { keepInventory: 'true' },
    );
    const warns = await warnsAfterReady(dir);
    const hit = warns.find((w) => w.includes('gamerule'));
    expect(hit).toContain('w_nether 的 keepInventory=false,主世界是 true');
    expect(hit).toContain('已发送 1 条 gamerule 修改指令');
    // 末地本来就一致,不该被点名
    expect(hit).not.toContain('w_the_end');
    rmSync(dir, { recursive: true, force: true });
  });

  it('三个维度一致就一句不报', async () => {
    const dir = serverDirWithRules(
      { keepInventory: 'true' },
      { keepInventory: 'true' },
      { keepInventory: 'true' },
    );
    const warns = await warnsAfterReady(dir);
    expect(warns.filter((w) => w.includes('gamerule'))).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

/** 对齐算什么、报什么:纯函数,不碰进程 */
describe('planGameRuleAlignment', () => {
  const nether = (rules: Record<string, string> | null) =>
    ({ id: 'minecraft:the_nether' as const, dir: 'w_nether', rules });

  it('对不上就出一条 execute in,并逐条说清差在哪', () => {
    const plan = planGameRuleAlignment({ keepInventory: 'true' }, [nether({ keepInventory: 'false' })]);
    expect(plan.commands).toEqual(['execute in minecraft:the_nether run gamerule keepInventory true']);
    expect(plan.drift).toEqual(['w_nether 的 keepInventory=false,主世界是 true']);
  });

  it('副维度压根没写那条也算对不上(原版默认值不是"设过")', () => {
    const plan = planGameRuleAlignment({ keepInventory: 'true' }, [nether({})]);
    expect(plan.commands).toHaveLength(1);
    expect(plan.drift[0]).toContain('keepInventory=(没写)');
  });

  it('主世界自己没写 = 没有要传播的意图,什么都不做', () => {
    expect(planGameRuleAlignment({}, [nether({ keepInventory: 'false' })])).toEqual({ commands: [], drift: [] });
    expect(planGameRuleAlignment(null, [nether({ keepInventory: 'false' })])).toEqual({ commands: [], drift: [] });
  });

  it('副维度读不到 = 说不清:只记一句,不猜也不发指令', () => {
    const plan = planGameRuleAlignment({ keepInventory: 'true' }, [nether(null)]);
    expect(plan.commands).toHaveLength(0);
    expect(plan.drift[0]).toContain('读不到');
  });

  it('一致就是空计划', () => {
    expect(planGameRuleAlignment({ keepInventory: 'true' }, [nether({ keepInventory: 'true' })]))
      .toEqual({ commands: [], drift: [] });
  });

  it('名单之外的规则各维度不同是常态,不管', () => {
    const plan = planGameRuleAlignment(
      { keepInventory: 'true', mobGriefing: 'true', doInsomnia: 'true' },
      [nether({ keepInventory: 'true', mobGriefing: 'false', doInsomnia: 'false' })],
    );
    expect(plan).toEqual({ commands: [], drift: [] });
  });
});

/**
 * 世界身份(realm)。全程只跟临时目录里的假存档打交道 —— 台架污染过一次真的
 * server.properties(--port/--world 被写回文件,前端卡在「启动中」),这里的写
 * 一律落在 mkdtemp 出来的目录里。
 */
describe('MinecraftServerManager:世界身份 realm', () => {
  let mgr: MinecraftServerManager | null = null;
  afterEach(async () => {
    await mgr?.stop();
    mgr = null;
  });

  function serverDirWith(levelName: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'mcrealm-'));
    setLevelName(dir, levelName);
    return dir;
  }

  function setLevelName(serverDir: string, levelName: string): void {
    writeFileSync(
      join(serverDir, 'server.properties'),
      `#Minecraft server properties\nlevel-name=${levelName}\nserver-port=25565\n`,
      'utf8',
    );
  }

  function recordingLog(): { log: Logger; warns: string[] } {
    const warns: string[] = [];
    const base = nullLogger();
    const log: Logger = { ...base, warn: (msg: string) => { warns.push(msg); } };
    return { log, warns };
  }

  function makeMgr(serverDir: string, log: Logger = nullLogger(), extra: Record<string, unknown> = {}): MinecraftServerManager {
    return new MinecraftServerManager({
      serverDir: () => serverDir,
      javaPath: () => '',
      jvmArgs: () => '',
      host: () => '127.0.0.1',
      port: () => 25565,
      log,
      ...extra,
    });
  }

  it('首次纳管往存档目录写 cortico-realm.json(uuid + 存档名 + 时刻)', () => {
    const dir = serverDirWith('世界甲');
    mgr = makeMgr(dir);
    const realm = mgr.realm();
    expect(realm?.levelName).toBe('世界甲');
    expect(realm?.uuid).toMatch(/^[0-9a-f-]{36}$/);
    const marker = readRealmMarker(join(dir, '世界甲'));
    expect(marker?.uuid).toBe(realm?.uuid);
    expect(marker?.levelName).toBe('世界甲');
    expect(Number.isFinite(Date.parse(marker?.createdAt ?? ''))).toBe(true);
  });

  it('已存在的 marker 原样沿用:换个管理器、换个进程都是同一个 uuid', () => {
    const dir = serverDirWith('世界甲');
    mgr = makeMgr(dir);
    const first = mgr.realm();
    const written = readFileSync(join(dir, '世界甲', REALM_MARKER_FILE), 'utf8');
    // 新管理器 = 新进程那一路:读盘拿回同一个身份,且文件一个字都没重写
    const again = makeMgr(dir).realm();
    expect(again?.uuid).toBe(first?.uuid);
    expect(readFileSync(join(dir, '世界甲', REALM_MARKER_FILE), 'utf8')).toBe(written);
  });

  it('目录改名不丢身份:marker 跟着搬,uuid 不变', () => {
    const dir = serverDirWith('世界甲');
    const before = makeMgr(dir).realm();
    renameSync(join(dir, '世界甲'), join(dir, '老家'));
    setLevelName(dir, '老家');
    mgr = makeMgr(dir);
    const after = mgr.realm();
    expect(after?.uuid).toBe(before?.uuid);
    // 对她只说存档名,而存档名以当下的 level-name 为准
    expect(after?.levelName).toBe('老家');
    // marker 里那个是首次纳管时的旧名,只作留痕
    expect(readRealmMarker(join(dir, '老家'))?.levelName).toBe('世界甲');
  });

  it('目录复制算同一个世界:两份同 uuid,不做防重', () => {
    const dir = serverDirWith('世界甲');
    const origin = makeMgr(dir).realm();
    // 手抄一份而不用 fs.cpSync:后者在 vitest 的 worker 线程里会把整个进程带走(exit 127,无摘要)
    mkdirSync(join(dir, '世界甲-备份'), { recursive: true });
    copyFileSync(join(dir, '世界甲', REALM_MARKER_FILE), join(dir, '世界甲-备份', REALM_MARKER_FILE));
    setLevelName(dir, '世界甲-备份');
    mgr = makeMgr(dir);
    expect(mgr.realm()?.uuid).toBe(origin?.uuid);
  });

  it('同名新建的存档是新身份:没有 marker 就重新发 uuid(缓存不认旧的)', () => {
    const dir = serverDirWith('世界甲');
    mgr = makeMgr(dir);
    const old = mgr.realm();
    // 删掉重开:目录名一样,世界是另一个
    rmSync(join(dir, '世界甲'), { recursive: true, force: true });
    const fresh = mgr.realm();
    expect(fresh?.levelName).toBe('世界甲');
    expect(fresh?.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(fresh?.uuid).not.toBe(old?.uuid);
  });

  it('写不进去只降级不报错:uuid 为 null、存档名照给,warn 只出一次', () => {
    const dir = serverDirWith('挡路');
    // 存档目录的位置上摆一个文件:建目录/写 marker 必失败(只读盘的等价物)
    writeFileSync(join(dir, '挡路'), 'not a directory', 'utf8');
    const { log, warns } = recordingLog();
    mgr = makeMgr(dir, log);
    expect(mgr.realm()).toEqual({ uuid: null, levelName: '挡路' });
    expect(mgr.realm()).toEqual({ uuid: null, levelName: '挡路' });
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain(REALM_MARKER_FILE);
  });

  it('没配服务器目录 = 不受管:realm() 为 null,弱身份归消费方拼', () => {
    expect(makeMgr('').realm()).toBeNull();
    expect(makeMgr(join(tmpdir(), 'mcrealm-不存在的目录')).realm()).toBeNull();
  });

  it('启动流程里就把世界纳管下来,且写失败不挡启动', async () => {
    const port = await deadPort();
    const dir = serverDirWith('世界甲');
    const script = fixture(`console.log('Done (1.001s)! For help, type "help"');`);
    mgr = makeMgr(dir, nullLogger(), {
      // 端口必须是没人听的:否则 start() 会认成「外部服务器已在跑」而不往下走
      port: () => port,
      commandOverride: { command: process.execPath, args: ['-e', script] },
      healthIntervalMs: 30,
    });
    await mgr.start();
    await waitFor(async () => (await mgr!.state()).phase === 'running');
    expect(existsSync(join(dir, '世界甲', REALM_MARKER_FILE))).toBe(true);
  });
});
