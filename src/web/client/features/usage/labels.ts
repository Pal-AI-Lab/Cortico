/**
 * 用量页的配色与主题读取。角色 id 是人格定义的不透明字符串；标签由 UsageGroupStat.label 提供，缺席时显示 id。
 * 命中、未命中与输出为框架 UsageAccum 字段，使用固定记账口径和固定颜色。
 */

import { readThemeColor } from '../../theme/palette.ts';
import { S } from './strings.ts';
import type { ColorResolver, UsageTypeKey } from './types.ts';

/** 通用系列色，由 chart.ts 的 paletteSeats 分给各键。 */
export const U_PALETTE = [
  'chart-1', 'chart-2', 'chart-3', 'chart-4',
  'chart-5', 'chart-6', 'chart-7', 'chart-8',
] as const;

export interface UsageTypeSpec {
  key: UsageTypeKey;
  label: string;
  color: string;
}

/** 自下而上堆叠：缓存命中 → 未缓存输入 → 输出。 */
export const U_TYPES: readonly UsageTypeSpec[] = [
  { key: 'cacheHit', label: S.typeCacheHit, color: 'chart-hit' },
  { key: 'cacheMiss', label: S.typeCacheMiss, color: 'chart-miss' },
  { key: 'output', label: S.typeOutput, color: 'chart-output' },
  { key: 'other', label: S.typeOther, color: 'chart-4' },
];

const HEX6 = /^#[0-9a-f]{6}$/i;

/** 最后一道兜底。见下面 `themeColor` 的注释。 */
const FALLBACK_INK = '#8a8a8a';

/**
 * 通过 readThemeColor 读取主题颜色，并验证为 hex。compositeColors/hexToHsl 需要 hex，而主题变量或 --ink-dim 可为空或采用 rgb 格式，因此此处补充格式回落。
 */
export function themeColor(doc: Document, key: string): string {
  const hit = readThemeColor(doc, key);
  return HEX6.test(hit) ? hit : FALLBACK_INK;
}

/** 绑好 `doc` 的解析器，交给图表那一层用。 */
export function themeColorResolver(doc: Document): ColorResolver {
  return (token) => themeColor(doc, token);
}
