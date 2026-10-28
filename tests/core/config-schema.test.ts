/** 配置声明的读取、值校验与原位写入。 */
import { describe, it, expect } from 'vitest';
import {
  coerceGroupValues, readGroupValues, getByPath, setByPath,
  type ConfigGroup,
} from '../../src/core/config-schema.ts';
import type { BotConfig } from '../../bots/corti-soulmate/assemble.ts';

const GROUP: ConfigGroup = {
  id: 'test',
  owner: 'core',
  schema: {
    type: 'object',
    title: '测试组',
    properties: {
      'a.count': { type: 'integer', title: '个数', minimum: 1, maximum: 10 },
      'a.ratio': { type: 'number', title: '比例', minimum: 0, maximum: 1 },
      'a.on': { type: 'boolean', title: '开关' },
      'a.mode': { type: 'string', title: '模式', enum: ['off', 'moderate', 'strict'] },
      'a.name': { type: 'string', title: '名字' },
      'a.range': { type: 'array', title: '区间', items: { type: 'integer', minimum: 1 }, minItems: 2, maxItems: 2 },
      'a.cap': { type: 'integer', title: '上限', minimum: 0, nullable: true },
      'a.weird': { type: 'object' as never, title: '不认识的类型' },
    },
  },
};

const coerce = (body: Record<string, unknown>) => coerceGroupValues(GROUP, body);

describe('coerceGroupValues', () => {
  it('部分更新只包含 body 中提供的键', () => {
    const r = coerce({ 'a.count': 3 });
    expect(r).toEqual({ values: { 'a.count': 3 } });
  });

  it('含未声明的键时整体拒绝，末段唯一命中声明键时附上该键', () => {
    const r = coerce({ 'a.count': 3, count: 4, 'api.key': 'stolen' });
    expect(r).toEqual({
      error: `配置组 test 没有声明 count(是否指 a.count), api.key;可写的键: ${Object.keys(GROUP.schema.properties).join(', ')}`,
    });
  });

  it('整数取整,小数保留;越界按 minimum/maximum 拒', () => {
    expect(coerce({ 'a.count': 3.7 })).toEqual({ values: { 'a.count': 3 } });
    expect(coerce({ 'a.ratio': 0.85 })).toEqual({ values: { 'a.ratio': 0.85 } });
    expect(coerce({ 'a.count': 0 })).toEqual({ error: '个数 不能小于 1' });
    expect(coerce({ 'a.count': 11 })).toEqual({ error: '个数 不能大于 10' });
    expect(coerce({ 'a.ratio': 'abc' })).toEqual({ error: '比例 必须是数值' });
  });

  it('布尔值只接受严格 true,不做真值转换', () => {
    expect(coerce({ 'a.on': true })).toEqual({ values: { 'a.on': true } });
    expect(coerce({ 'a.on': 'true' })).toEqual({ values: { 'a.on': false } });
    expect(coerce({ 'a.on': 1 })).toEqual({ values: { 'a.on': false } });
  });

  it('enum 之外的字符串被拒;无 enum 的字符串照收', () => {
    expect(coerce({ 'a.mode': 'strict' })).toEqual({ values: { 'a.mode': 'strict' } });
    expect(coerce({ 'a.mode': 'nope' })).toEqual({ error: '模式 只能是 off / moderate / strict' });
    expect(coerce({ 'a.name': 'text' })).toEqual({ values: { 'a.name': 'text' } });
  });

  it('2 元数组:长度、元素范围、first<=second 三道都查', () => {
    expect(coerce({ 'a.range': [30, 90] })).toEqual({ values: { 'a.range': [30, 90] } });
    expect(coerce({ 'a.range': [90, 30] })).toEqual({ error: '区间 的第一项不能大于第二项' });
    expect(coerce({ 'a.range': [30] })).toEqual({ error: '区间 需要两个数' });
    expect(coerce({ 'a.range': 30 })).toEqual({ error: '区间 需要两个数' });
    expect(coerce({ 'a.range': [0, 5] })).toEqual({ error: '区间 第一项 不能小于 1' });
  });

  it('nullable 的项可以写 null;不声明 nullable 的不行', () => {
    expect(coerce({ 'a.cap': null })).toEqual({ values: { 'a.cap': null } });
    expect(coerce({ 'a.count': null })).toEqual({ error: '个数 不能为空' });
  });

  it('不认识的 type 不参与写回(降级成只读)', () => {
    expect(coerce({ 'a.weird': { x: 1 } })).toEqual({ values: {} });
  });
});

describe('readGroupValues', () => {
  it('按声明的类型从活配置里读;缺失叶子给类型的空值', () => {
    const cfg = {
      a: { count: 5, ratio: 0.4, on: true, mode: 'strict', range: [30, 90] },
    } as unknown as BotConfig;
    const v = readGroupValues(cfg, GROUP);
    expect(v['a.count']).toBe(5);
    expect(v['a.on']).toBe(true);
    expect(v['a.mode']).toBe('strict');
    expect(v['a.range']).toEqual([30, 90]);
    expect(v['a.name']).toBe(''); // 缺失的字符串
    expect(v['a.cap']).toBe(null); // 缺失且 nullable
  });
});

describe('setByPath / getByPath', () => {
  it("写入叶子属性时保留父对象引用", () => {
    const root: Record<string, unknown> = { a: { count: 1 } };
    const a = root.a;
    setByPath(root, 'a.count', 9);
    expect(root.a).toBe(a);
    expect(getByPath(root, 'a.count')).toBe(9);
  });

  it('缺失的中间段补普通对象', () => {
    const root: Record<string, unknown> = {};
    setByPath(root, 'x.y.z', 3);
    expect(getByPath(root, 'x.y.z')).toBe(3);
  });

  it('读不存在的路径给 undefined,不抛', () => {
    expect(getByPath({ a: 1 }, 'a.b.c')).toBeUndefined();
    expect(getByPath({}, 'nope')).toBeUndefined();
  });
});
