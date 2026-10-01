/**
 * `/api/usage` 的范围查询串。日期一律按部署时区解释:预设档只发 `days`,由服务端取部署时区
 * 的今天往前数;自定义档发两个日期框里的 `YYYY-MM-DD`。浏览器时区不参与。
 */

export interface UsageRange {
  from: string;
  to: string;
}

/** `days === 0` 是自定义档,读 `custom`,空串不出现在 URL 里;其余档是含今天的最近 N 天。 */
export function usageQuery(bucket: string, days: number, custom: UsageRange): string {
  const q = new URLSearchParams();
  q.set('bucket', bucket);
  if (days > 0) {
    q.set('days', String(days));
    return q.toString();
  }
  if (custom.from) q.set('from', custom.from);
  if (custom.to) q.set('to', custom.to);
  return q.toString();
}
