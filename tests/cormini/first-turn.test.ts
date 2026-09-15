/**
 * Cormini 的首轮对话(风格锚):三份源文件 + 开关 context.firstTurn → sessionHead() 的 item 列表;
 * promptDocs 自报三份源(Persona 页提示词页签经 /api/prompts 读写的就是它们)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cormini, CORMINI_CONTEXT_DEFAULTS, FIRST_TURN_FILES } from '../../bots/cormini/persona/persona.ts';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cormini-firstturn-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const on = () => ({ ...CORMINI_CONTEXT_DEFAULTS, firstTurn: true });

describe('Cormini 首轮对话', () => {
  it('开关开着:读三份文件,回 user / reasoning / assistant 三个 item,id 固定', () => {
    const ftDir = join(dir, 'ft');
    mkdirSync(ftDir, { recursive: true });
    writeFileSync(join(ftDir, FIRST_TURN_FILES.user), '早呀\n', 'utf8');
    writeFileSync(join(ftDir, FIRST_TURN_FILES.thinking), '轻快地回\n', 'utf8');
    writeFileSync(join(ftDir, FIRST_TURN_FILES.reply), '早——\n', 'utf8');
    const p = new Cormini({ memoryDir: join(dir, 'ws1'), firstTurnDir: ftDir, context: on });
    const head = p.sessionHead();
    expect(head.map((item) => item.type)).toEqual(['message', 'reasoning', 'message']);
    expect(head[0]).toMatchObject({ id: 'msg_first_turn_user', role: 'user', content: [{ type: 'input_text', text: '早呀' }] });
    expect(head[1]).toMatchObject({ id: 'rs_first_turn', content: [{ type: 'reasoning_text', text: '轻快地回' }] });
    expect(head[2]).toMatchObject({ id: 'msg_first_turn_reply', role: 'assistant', content: [{ type: 'output_text', text: '早——' }] });
    // 内容不变时两次取到的逐字相同:请求前缀的缓存靠这个。
    expect(JSON.stringify(p.sessionHead())).toBe(JSON.stringify(head));
  });

  it('thinking 文件为空就没有 reasoning 项;文件缺失当空串', () => {
    const ftDir = join(dir, 'ft2');
    mkdirSync(ftDir, { recursive: true });
    writeFileSync(join(ftDir, FIRST_TURN_FILES.user), 'u', 'utf8');
    writeFileSync(join(ftDir, FIRST_TURN_FILES.reply), 'r', 'utf8');
    const p = new Cormini({ memoryDir: join(dir, 'ws2'), firstTurnDir: ftDir, context: on });
    expect(p.sessionHead().map((item) => item.type)).toEqual(['message', 'message']);
  });

  it('user 或 reply 为空白:整轮不送', () => {
    const ftDir = join(dir, 'ft3');
    mkdirSync(ftDir, { recursive: true });
    writeFileSync(join(ftDir, FIRST_TURN_FILES.user), '  \n', 'utf8');
    writeFileSync(join(ftDir, FIRST_TURN_FILES.reply), '有回复', 'utf8');
    const p = new Cormini({ memoryDir: join(dir, 'ws3'), firstTurnDir: ftDir, context: on });
    expect(p.sessionHead()).toEqual([]);
  });

  it('开关关着回空,缺省就是关着;不传 firstTurnDir 也回空', () => {
    const ftDir = join(dir, 'ft4');
    mkdirSync(ftDir, { recursive: true });
    writeFileSync(join(ftDir, FIRST_TURN_FILES.user), 'u', 'utf8');
    writeFileSync(join(ftDir, FIRST_TURN_FILES.reply), 'r', 'utf8');
    expect(CORMINI_CONTEXT_DEFAULTS.firstTurn).toBe(false);
    expect(new Cormini({ memoryDir: join(dir, 'ws4a'), firstTurnDir: ftDir }).sessionHead()).toEqual([]);
    expect(new Cormini({ memoryDir: join(dir, 'ws4b'), context: on }).sessionHead()).toEqual([]);
  });

  it('promptDocs 自报三份 firstTurn.* 源,路径指向 firstTurnDir', () => {
    const ftDir = join(dir, 'ft5');
    mkdirSync(ftDir, { recursive: true });
    const p = new Cormini({ memoryDir: join(dir, 'ws5'), firstTurnDir: ftDir });
    const docs = p.console().promptDocs ?? [];
    const keys = docs.map((d) => d.key);
    expect(keys).toContain('firstTurn.user');
    expect(keys).toContain('firstTurn.thinking');
    expect(keys).toContain('firstTurn.reply');
    const userDoc = docs.find((d) => d.key === 'firstTurn.user')!;
    expect(userDoc.path).toBe(join(ftDir, FIRST_TURN_FILES.user));
    // 不是前缀段也不是环境提示词:不标 role,不进前缀装配
    expect(userDoc.role).toBeUndefined();
  });

  it('不传 firstTurnDir = 没有首轮对话:不自报源', () => {
    const p = new Cormini({ memoryDir: join(dir, 'ws6') });
    expect((p.console().promptDocs ?? []).some((d) => d.key.startsWith('firstTurn.'))).toBe(false);
  });

  it('目录给了但文件还没写:回空,源照常自报好让控制台能创建它们', () => {
    const ftDir = join(dir, 'ft7');
    const p = new Cormini({ memoryDir: join(dir, 'ws7'), firstTurnDir: ftDir, context: on });
    expect(existsSync(ftDir)).toBe(false);
    expect(p.sessionHead()).toEqual([]);
    const docs = (p.console().promptDocs ?? []).filter((d) => d.key.startsWith('firstTurn.'));
    expect(docs).toHaveLength(3);
    for (const d of docs) expect(d.path.startsWith(ftDir)).toBe(true);
  });
});
