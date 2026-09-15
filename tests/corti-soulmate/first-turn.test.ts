/**
 * CortiSoulmate 的首轮对话接入:部署目录 prompts/ 下三份源文件 + 开关 context.firstTurn → sessionHead(),
 * consoleSurface 把基类给出的三份 firstTurn.* promptDocs 收进自己的声明。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CortiSoulmate } from '../../bots/corti-soulmate/persona/index.ts';
import { makeCfg } from '../core/helpers.ts';
import { tmpPersona, cleanup } from './helpers.ts';

describe('CortiSoulmate 首轮对话', () => {
  let dir: string;
  beforeEach(() => (dir = tmpPersona()));
  afterEach(() => cleanup(dir));

  it('不给 firstTurnDir = 没有首轮对话:不注入、console() 不列源', () => {
    const cfg = makeCfg();
    cfg.context.firstTurn = true;
    const core = new CortiSoulmate({ memoryDir: dir, cfg });
    expect(core.sessionHead()).toEqual([]);
    const docs = core.console().promptDocs ?? [];
    expect(docs.some((d) => d.key.startsWith('firstTurn.'))).toBe(false);
  });

  it('给了部署侧 prompts/:开关开着 sessionHead() 读那里,关着回空;console() 自报三份源指向同一目录', () => {
    const ftDir = join(dir, 'prompts');
    mkdirSync(ftDir, { recursive: true });
    writeFileSync(join(ftDir, 'FIRST_TURN_USER.md'), '早', 'utf8');
    writeFileSync(join(ftDir, 'FIRST_TURN_REPLY.md'), '早呀', 'utf8');
    const cfg = makeCfg();
    const core = new CortiSoulmate({ memoryDir: dir, cfg, firstTurnDir: ftDir });
    expect(core.sessionHead()).toEqual([]);
    cfg.context.firstTurn = true;
    expect(core.sessionHead().map((item) => item.type)).toEqual(['message', 'message']);
    expect(core.sessionHead()[0]).toMatchObject({ role: 'user', content: [{ type: 'input_text', text: '早' }] });
    expect(core.sessionHead()[1]).toMatchObject({ role: 'assistant', content: [{ type: 'output_text', text: '早呀' }] });
    const docs = core.console().promptDocs ?? [];
    for (const name of ['user', 'thinking', 'reply']) {
      const doc = docs.find((d) => d.key === `firstTurn.${name}`);
      expect(doc, `firstTurn.${name} 应在 promptDocs 里`).toBeTruthy();
      expect(doc!.path.startsWith(ftDir)).toBe(true);
      expect(doc!.role).toBeUndefined();
    }
  });
});
