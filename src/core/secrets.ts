/** 按名称同步读取密钥；可轮换凭据的生命周期由 provider 管理。 */
import { existsSync } from 'node:fs';
import { readTextFile } from './util.ts';

/**
 * 每次优先读取非空进程环境变量；否则现读文件，缺失返回空串。
 * 文件值读取到首个空白字符，不解析引号。
 */
export function secretReader(file: string): (name: string) => string {
  return (name: string): string => {
    const fromEnv = process.env[name];
    if (fromEnv) return fromEnv;
    const m = new RegExp(`^\\s*${name}\\s*=\\s*(\\S+)`, 'm').exec(existsSync(file) ? readTextFile(file) : '');
    return m ? m[1] : '';
  };
}
