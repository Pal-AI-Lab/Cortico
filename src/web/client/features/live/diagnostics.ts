import { get } from '../../core/api.ts';

/** `cortico-diagnostics-r-20260917-104402-c2ab-20260917-142530.json`;没有 run id 时写 norun。 */
export function diagnosticsFileName(runId: string | null, at: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}`
    + `-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  const run = (runId ?? 'norun').replace(/[^\w.-]/g, '_');
  return `cortico-diagnostics-${run}-${stamp}.json`;
}

/** 交给浏览器下载。对象 URL 在同一轮事件循环之后撤掉。 */
export function downloadJson(doc: Document, name: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = doc.createElement('a');
  link.href = url;
  link.download = name;
  doc.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export interface DiagnosticsDeps {
  doc: Document;
  signal: AbortSignal;
}

export async function exportDiagnostics(deps: DiagnosticsDeps): Promise<void> {
  const bundle = await get<{ run?: { id?: string | null } }>('/api/diagnostics', { signal: deps.signal });
  downloadJson(deps.doc, diagnosticsFileName(bundle?.run?.id ?? null, new Date()), bundle);
}
