/**
 * 包入口:默认导出 `ProviderModule`,加载器按 `cortico.kind === 'provider'` 认它。
 *
 * 模块不记任何厂商事实:模型名、价目、密钥都在部署的端点条目里。`reasoningTiers` 空表 = 开放,
 * `reasoningEffort` 收任意非空串;`serviceTiers` 空表 = 这种方言没有服务档。
 *
 * 地址、密钥变量名与图像开关由控制台的端点页编辑,模块不声明它们;`config` 留给这种方言
 * 自己的 `options.*`。
 */
import type { ProviderModule } from 'cortico/providers/base.ts';
import { isContextOverflow } from 'cortico/providers/transport/errors.ts';
import { ExampleChatProvider } from './native.ts';

const EXAMPLE = {
  id: 'example',
  title: 'Example (Chat Completions)',
  defaultBaseUrl: 'http://127.0.0.1:8080/v1',
  reasoningTiers: [],
  serviceTiers: [],
  contextOverflow: isContextOverflow,
  create(name, entry, host) {
    // 密钥按端点条目里写的环境变量名取:进程环境优先,否则读该端点目录的 .env。
    const apiKey = entry.secret ? host.secret(entry.secret) : undefined;
    return {
      compatibilityKey: () => [name],
      client: new ExampleChatProvider({
        baseUrl: entry.baseUrl,
        apiKey,
        log: host.log,
        media: { enabled: () => entry.multimodal === true, read: host.readBlob },
      }),
    };
  },
} satisfies ProviderModule;

export default EXAMPLE;
export { EXAMPLE };
