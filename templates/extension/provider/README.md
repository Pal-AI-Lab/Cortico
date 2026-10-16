# cortico-provider-example

Owner: `src/index.ts`

最小完整的 provider:讲 OpenAI Chat Completions 方言的端点。HTTP / SSE、重试退避、计量、流装配、
终态判定全在框架的 `providers/transport/`;这个包只回答两个问题:请求体长什么样,请求头带什么。
模块不记任何厂商事实,模型名、密钥、价目都在部署的端点条目里。

| 文件 | 内容 |
|---|---|
| `src/index.ts` | `ProviderModule`:id、title、档位表、连接配置组、`create()`、`describe`(协议、登录方式、输入类型) |
| `src/native.ts` | 继承 `OpenAIHttpClient` 的客户端:`buildBody()` 与 `headers()` |
| `tests/` | 干装载与请求体形状 |

改名清单:包名、`id: 'example'`、`EXAMPLE` / `Example` 前缀。规矩见
[docs/providers.md](../../../docs/providers.md) 与 [src/providers/README.md](../../../src/providers/README.md)。
先确认内建的 `openai-responses-compat` 配一条端点做不到你要的事,再写模块。
