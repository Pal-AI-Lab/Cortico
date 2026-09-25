import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { PackageOperation } from './package-store.ts';

export type ValidatedPackage = Required<Pick<PackageOperation, 'name' | 'version' | 'kind' | 'moduleId'>>;
/** No deployment secrets or runtime startup are passed to the declaration check. */
export function validatePackage(dir: string): Promise<ValidatedPackage> {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|TEMP|TMP|HOME|USERPROFILE)$/i.test(key)));
    const child = fork(fileURLToPath(new URL('./validate-child.ts', import.meta.url)), [dir], {
      execArgv: ['--import', 'tsx'], env, silent: true,
    });
    let result: (ValidatedPackage & { ok: boolean; error?: string }) | undefined;
    let output = '';
    child.stderr?.on('data', chunk => { output = (output + String(chunk)).slice(-4000); });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('扩展校验超时。')); }, 30_000);
    child.on('message', message => { result = message as typeof result; });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => {
      clearTimeout(timeout);
      if (code === 0 && result?.ok) resolve(result);
      else reject(new Error(result?.error || output || '扩展校验失败。'));
    });
  });
}
