import { records } from '../core/fixture-protocol.ts';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from "../core/fixture-core.ts";
import { CORE_DEFAULTS, type LoadedConfig } from '../../src/core/config.ts';
import type { CoreConfig } from '../../src/core/types.ts';
import { TerminalWorld } from '../../src/worlds/terminal/world.ts';
import { Cormini } from '../../bots/cormini/persona/persona.ts';
import { makeCfg, FakeLLM, toolReply, sleep } from '../core/helpers.ts';

let dir: string;
let memoryDir: string;
let core: Core<CoreConfig>;
let persona: Cormini;
let llm: FakeLLM;

const waitFor = async (cond: () => boolean, ms = 4000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor 超时');
    await sleep(20);
  }
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cormini-'));
  memoryDir = join(dir, 'workspace');

  const config: CoreConfig = {
    ...CORE_DEFAULTS,
    providers: makeCfg().providers,
    activeProvider: makeCfg().activeProvider,
    displayName: 'Cormini',
    web: { ...CORE_DEFAULTS.web, port: 0 },
    paths: { memory: 'workspace', data: 'data' },
    batching: { quietGapMs: 30, minBatchAgeMs: 0, maxBatchAgeMs: 300, maxBatchSize: 100 },
    context: { ...CORE_DEFAULTS.context },
  };
  const loaded: LoadedConfig<CoreConfig> = {
    config,
    secret: () => 'fake-key',
    rootDir: dir,
    memoryDir,
    dataDir: join(dir, 'data'),
  };

  const terminal = new TerminalWorld({ timezone: config.timezone, botName: 'Cormini' });
  persona = new Cormini({
    memoryDir,
    worlds: [terminal],
  });
  writeFileSync(join(memoryDir, 'CONSTITUTION.md'), '# Who I am\n\nI am Cormini, a test.\n', 'utf8');

  llm = new FakeLLM();
  core = new Core(loaded, {
    persona: persona,
    worlds: [terminal],
    llm,
  });
  await core.start();
}, 15000);

afterAll(async () => {
  await core.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('Cormini', () => {
  it('只实现 Persona 就能 bootstrap 出一个 session', async () => {
    await waitFor(() => core.session.messages.length >= 3);
    const msgs = core.session.messages;
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toContain('session 已开始');
    await waitFor(() => llm.calls.length >= 1);
  });

  it('宪法文件逐字进系统前缀,改文件就改行为', async () => {
    const prefix = core.session.messages[0].content;
    expect(prefix).toContain('I am Cormini, a test.');
    // 段的顺序与标题由Persona定,core 只按序拼
    expect(prefix.indexOf('ORIENTATION')).toBeLessThan(prefix.indexOf('CONSTITUTION'));
    // 工作区清单也在前缀里,使"工作区即记忆"对 bot 可见
    expect(prefix).toContain('CONSTITUTION.md');
  });

  it('文件工具真的落盘:写进工作区的内容活过这一轮', async () => {
    llm.script(
      toolReply([{ name: 'write_file', args: { path: 'notes/first.md', content: 'remembered\n' } }]),
    );
    // urgent 终端消息立即投递。
    core.store.append({
      type: 'terminal.message',
      ts: new Date().toISOString(),
      source: 'terminal',
      origin: 'external',
      text: '[10:00] tester: remember this',
    });
    core.loop.injectInternal('[system] poke', 'test');

    await waitFor(() => existsSync(join(memoryDir, 'notes', 'first.md')), 6000);
    expect(readFileSync(join(memoryDir, 'notes', 'first.md'), 'utf8')).toBe('remembered\n');
  });

  it('工具集=文件工具 + 已挂载 IO 工具 + end_turn,没有 fork、也没有保留帧名', () => {
    const names = persona.declareSessions()[0].tools().map((t) => t.name).sort();
    expect(names).toEqual([
      'append_file', 'delete_file', 'edit_file', 'end_turn', 'glob_files', 'grep_files', 'list_files', 'read_file', 'save_blob', 'terminal_send', 'write_file',
    ]);
    expect(names).not.toContain('fork');
    // 外部正文由 core 以保留帧投递;session 不声明同名(含旧名)工具。
    expect(names).not.toContain('external_event_frame');
    expect(names).not.toContain('observe');
  });

  it('只声明一个 session:常驻、收事件', () => {
    const decls = persona.declareSessions();
    expect(decls).toHaveLength(1);
    expect(decls[0]).toMatchObject({ id: 'main', persistent: true, receivesEvents: true });
  });

  it('list_files:指定目录全量,其余每个子目录只列前 10 项并折叠计数', async () => {
    mkdirSync(join(memoryDir, 'archive', 'sub'), { recursive: true });
    for (let i = 0; i < 12; i++) {
      writeFileSync(join(memoryDir, 'archive', `a${String(i).padStart(2, '0')}.md`), 'x', 'utf8');
    }
    writeFileSync(join(memoryDir, 'archive', 'sub', 's.md'), 'x', 'utf8');
    const list = persona.declareSessions()[0].tools().find((t) => t.name === 'list_files')!;
    const ctx = { role: 'main', log: core.runlog.logger('test') };

    // 根:顶层文件全列;archive/ 有 13 项(12 个文件 + sub/),只列前 10 项,sub/ 折进计数里
    const root = String(await list.handler({}, ctx));
    expect(root).toContain('Files in your workspace:');
    expect(root).toContain('- CONSTITUTION.md');
    expect(root).toContain('- archive/a09.md');
    expect(root).not.toContain('archive/a10.md');
    expect(root).not.toContain('archive/sub/');
    expect(root).toContain('archive/ … 共 13 项,以上只列了前 10 项;list_files 指定 dir 为 archive 可列出全部');

    // 指定目录:全量,子目录 sub/ 只有一项,不折叠
    const full = String(await list.handler({ dir: 'archive' }, ctx));
    expect(full).toContain('Files in archive/:');
    expect(full).toContain('- archive/a11.md');
    expect(full).toContain('- archive/sub/s.md');
    expect(full).not.toContain('共 13 项');

    expect(String(await list.handler({ dir: 'nope' }, ctx))).toBe('[not found] nope');
    expect(String(await list.handler({ dir: 'archive/a00.md' }, ctx))).toBe('[not a directory] archive/a00.md');
    expect(String(await list.handler({ dir: '..' }, ctx))).toContain('[list failed]');
  });

  it('工作区之外的路径写不进去', async () => {
    const write = persona.declareSessions()[0].tools().find((t) => t.name === 'write_file')!;
    const out = await write.handler(
      { path: '../escaped.md', content: 'nope' },
      { role: 'main', log: core.runlog.logger('test') },
    );
    expect(out).toContain('[write failed]');
    expect(existsSync(join(dir, 'escaped.md'))).toBe(false);
  });

  it('交接交回空尾,笔记写进 handoffs/,醒来消息经注入原语进新 session', async () => {
    const r = await persona.onHandoff!(records([{ role: 'user', content: 'x' }]), { hardTokens: null });
    expect(r.tail).toEqual([]);
    expect(existsSync(join(memoryDir, 'handoffs'))).toBe(true);
    await waitFor(
      () =>
        core.session.messages.some(
          (m) => m.role === 'user' && m.content.includes('交接完了'),
        ),
      6000,
    );
  });

  it('主 session 带 end_turn(endsTurn+barrierAfter+flow),排在 World 工具之后', async () => {
    const tools = persona.declareSessions()[0].tools();
    const endTurn = tools[tools.length - 1];
    expect(endTurn.name).toBe('end_turn');
    expect(endTurn.endsTurn).toBe(true);
    expect(endTurn.barrierAfter).toBe(true);
    expect(endTurn.tags).toEqual(['flow']);
  });

  it('World 自报的内部事件原样进 user 区(通道已融合,Persona不再措辞)', async () => {
    const event = core.store.append({
      type: 'worlds.note',
      ts: new Date().toISOString(),
      source: 'probe',
      origin: 'internal',
      text: '[probe] 队列见底',
    });
    core.bus.push({ event });
    await waitFor(
      () =>
        core.session.messages.some(
          (m) => m.role === 'user' && m.content.includes('[probe] 队列见底'),
        ),
      6000,
    );
  });
});
