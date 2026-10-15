import { describe, expect, it } from 'vitest';
import { renderSections, renderTemplate, templateVarNames, unknownVarNames } from '../../src/core/template.ts';

describe('renderTemplate', () => {
  it('取值:占位符换成值,模板其余部分逐字不动', () => {
    const tpl = '你在QQ上。\n\n下面是你正在参与的会话:\n{{qq.conversations}}\n{{qq.identity}}';
    expect(renderTemplate(tpl, {
      'qq.conversations': '- 群「摸鱼群」(群号12345)',
      'qq.identity': '你的QQ号是99。',
    })).toBe('你在QQ上。\n\n下面是你正在参与的会话:\n- 群「摸鱼群」(群号12345)\n你的QQ号是99。');
  });

  it('值带换行就是多行块,不做缩进跟随', () => {
    const out = renderTemplate('- {{list}}', { list: 'a\nb\nc' });
    expect(out).toBe('- a\nb\nc'); // 后两行不补 "- "
  });

  it('缺省文案:值为空串时用竖线后面那段', () => {
    const tpl = '{{qq.identity | (与QQ的连接尚未建立)}}';
    expect(renderTemplate(tpl, { 'qq.identity': '' })).toBe('(与QQ的连接尚未建立)');
    expect(renderTemplate(tpl, { 'qq.identity': '你的QQ号是99。' })).toBe('你的QQ号是99。');
  });

  it('值为空且没写缺省 = 空串', () => {
    expect(renderTemplate('a{{x}}b', { x: '' })).toBe('ab');
  });

  it('未知占位符原样保留——静默吞成空串会让人以为改生效了', () => {
    expect(renderTemplate('前{{qq.typo}}后', {})).toBe('前{{qq.typo}}后');
    // 未声明变量时保留完整占位符，包括缺省文案。
    expect(renderTemplate('{{qq.typo | 兜底}}', {})).toBe('{{qq.typo | 兜底}}');
  });

  it('容忍花括号内的空白', () => {
    expect(renderTemplate('{{ x }}', { x: 'v' })).toBe('v');
    expect(renderTemplate('{{ x | 缺省 }}', { x: '' })).toBe('缺省');
  });

  it('同一个占位符可以出现多次', () => {
    expect(renderTemplate('{{x}}-{{x}}', { x: 'v' })).toBe('v-v');
  });

  it('值里带 {{}} 不会被二次展开', () => {
    expect(renderTemplate('{{x}}', { x: '{{y}}', y: '不该出现' })).toBe('{{y}}');
  });

  it('没有占位符的模板原样返回', () => {
    expect(renderTemplate('你连接着一个控制台对话界面。', {})).toBe('你连接着一个控制台对话界面。');
  });
});

describe('templateVarNames', () => {
  it('按出现序列出用到的占位符,去重', () => {
    expect(templateVarNames('{{b}}{{a}}{{b}}')).toEqual(['b', 'a']);
  });

  it('带缺省文案的也算', () => {
    expect(templateVarNames('{{x | 缺省}}')).toEqual(['x']);
  });
});

describe('renderSections', () => {
  const TPL = '━━━ A ━━━\n{{a}}\n\n━━━ B ━━━\n{{b}}\n';

  it('切出来的段拼回去逐字等于完整渲染结果', () => {
    const out = renderSections(TPL, { a: '甲', b: '乙' });
    expect(out.sections.map((s) => s.text).join('')).toBe(out.text);
    expect(out.text).toBe('━━━ A ━━━\n甲\n\n━━━ B ━━━\n乙\n');
  });

  it('每段带上它前面那截字面文本,尾部归最后一段', () => {
    const out = renderSections(TPL, { a: '甲', b: '乙' });
    expect(out.sections).toEqual([
      { name: 'a', text: '━━━ A ━━━\n甲' },
      { name: 'b', text: '\n\n━━━ B ━━━\n乙\n' },
    ]);
  });

  it('段序跟着模板走:调换占位符就调换了段', () => {
    const out = renderSections('{{b}}|{{a}}', { a: '甲', b: '乙' });
    expect(out.sections.map((s) => s.name)).toEqual(['b', 'a']);
    expect(out.text).toBe('乙|甲');
  });

  it('删掉一个占位符,那一段就不在前缀里了', () => {
    const out = renderSections('{{a}}', { a: '甲', b: '乙' });
    expect(out.sections.map((s) => s.name)).toEqual(['a']);
    expect(out.text).not.toContain('乙');
  });

  it('没有占位符时整份内容是一段', () => {
    const out = renderSections('纯文本', {});
    expect(out.sections).toEqual([{ name: '', text: '纯文本' }]);
    expect(out.text).toBe('纯文本');
  });

  it('缺省文案照常生效,空段也还占一个位置', () => {
    const out = renderSections('{{a | (空)}}', { a: '' });
    expect(out.text).toBe('(空)');
  });
});

describe('unknownVarNames', () => {
  it('挑出模板里用了但没人声明的名字', () => {
    expect(unknownVarNames('{{qq.identity}}{{qq.typo}}', ['qq.identity'])).toEqual(['qq.typo']);
  });

  it('声明了但没用到的不算未知', () => {
    expect(unknownVarNames('{{a}}', ['a', 'b'])).toEqual([]);
  });
});
