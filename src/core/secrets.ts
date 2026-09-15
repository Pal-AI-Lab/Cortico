/** 按名称同步读取密钥；可轮换凭据的生命周期由 provider 管理。 */
import { existsSync } from 'node:fs';
import { readTextFile } from './util.ts';

/**
 * 每次优先读取非空进程环境变量；否则使用首次读取后缓存的文件内容，缺失返回空串。
 * 文件值读取到首个空白字符，不解析引号。
 */
export function secretReader(file: string): (name: string) => string {
  let text: string | null = null;
  return (name: string): string => {
    const fromEnv = process.env[name];
    if (fromEnv) return fromEnv;
    if (text === null) text = existsSync(file) ? readTextFile(file) : '';
    const m = new RegExp(`^\\s*${name}\\s*=\\s*(\\S+)`, 'm').exec(text);
    return m ? m[1] : '';
  };
}
