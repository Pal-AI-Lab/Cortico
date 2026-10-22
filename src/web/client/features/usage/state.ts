/**
 * 用量页状态由每次 mount 的工厂创建，保存在该次挂载闭包，卸载后释放，避免继承其他 bot、范围或数据的选择。
 */

import type { UsageAggregate, UsageBucketOption, UsageDimFlags, UsageMetric } from './types.ts';

export interface UsageState {
  /** 预设天数；0 = 自定义范围（此时读 `from` / `to`）。 */
  days: number;
  from: string;
  to: string;
  bucket: UsageBucketOption;
  metric: UsageMetric;
  /** 拆分维度；指标为调用次数时不按"类型"拆。 */
  splitDims: UsageDimFlags;
  sortByShare: boolean;
  /** 最近一次取回的数据。重绘（换指标、换拆分、主题换色、窗口改宽）不重取。 */
  data: UsageAggregate | null;
}

export function createUsageState(): UsageState {
  return {
    days: 7,
    from: '',
    to: '',
    bucket: 'auto',
    metric: 'cost',
    splitDims: { type: false, role: false, model: false },
    sortByShare: false,
    data: null,
  };
}
