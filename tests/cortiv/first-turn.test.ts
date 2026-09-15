/**
 * CortiV 的首轮对话:继承 Cormini 的机制;源文件是部署目录 prompts/ 下的三份,
 * 装配层经 firstTurnDir 传入,代码包里不带。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CortiV } from '../../bots/cortiv/persona/persona.ts';
import { CORMINI_CONTEXT_DEFAULTS, FIRST_TURN_FILES } from '../../bots/cormini/persona/persona.ts';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cortiv-firstturn-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('CortiV 首轮对话', () => {
  it('firstTurnDir 覆写生效:promptDocs 与 sessionHead() 都指向传入目录', () => {
    const ftDir = join(dir, 'ft');
    mkdirSync(ftDir, { recursive: true });
    writeFileSync(join(ftDir, FIRST_TURN_FILES.user), '晚上好', 'utf8');
    writeFileSync(join(ftDir, FIRST_TURN_FILES.reply), '晚上好呀', 'utf8');
    const p = new CortiV({
      memoryDir: join(dir, 'ws'),
      firstTurnDir: ftDir,
      context: () => ({ ...CORMINI_CONTEXT_DEFAULTS, firstTurn: true }),
    });
    expect(p.sessionHead().map((item) => item.type)).toEqual(['message', 'message']);
    expect(p.sessionHead()[0]).toMatchObject({ role: 'user', content: [{ type: 'input_text', text: '晚上好' }] });
    const doc = (p.console().promptDocs ?? []).find((d) => d.key === 'firstTurn.reply');
    expect(doc?.path).toBe(join(ftDir, FIRST_TURN_FILES.reply));
  });

  it('代码包里不带首轮对话源文件:它们是部署数据', () => {
    const cortivCore = resolve(import.meta.dirname, '../../bots/cortiv/persona');
    for (const name of Object.values(FIRST_TURN_FILES)) {
      expect(existsSync(join(cortivCore, name))).toBe(false);
    }
  });
});
