<!-- Owner: src/providers/base.ts, src/providers/registry.ts -->

# src/providers

`ProviderModule` 实现一种模型通信协议,`ProviderInstance` 对应一个端点,
`ProviderHost` 提供实例所需的配置、密钥、资源与日志接口。Core 通过 `ProviderRegistry.bind(name)`
获取带报价与来源信息的客户端,Persona 通过 Core 调用模型。

## 文件

| 文件 | 管什么 |
|---|---|
| `base.ts` | 三个接口与 `BaseProvider`(抽象 `respond`) |
| `registry.ts` | 目录扫描发现内建模块、`registerProviderModules()` 收扩展、实例缓存与 `bind()` |
| `configuration.ts` | `validateSpec` / `validateEntry`:外部配置校验 |
| `pricebook.ts` | 价目定义、快照、报价合并 |
| `console/` | provider 页的服务端:`ProviderSettings`(落盘、密钥、探活) |
| `openai-responses-compat/` | 内建模块:Responses 协议客户端与模型目录 |
| `llamacpp/` | 内建模块:llama-server 的 Chat 客户端、router 目录、官方 release 的下载安装与进程托管 |
| `transport/` | HTTP/SSE 引擎、Chat 与 Responses 请求转换、事件装配、计量、错误 |

## ProviderModule

`id` 必须等于目录名(扩展包里则是包声明的 id)。必填:`title`、`reasoningTiers`(空表 = 开放,
effort 收任意非空串)、`serviceTiers`、`create(name, entry, host)`。可选:`defaultBaseUrl` 与
`baseUrlSuggestions`、`effortSuggestions`、`temperatureNote`、`localize()`、`normalize()`、
`validateEntry()`、`validateModel()`、`accepts()`(多模态判定)、`config()` 与 `console()`
(附加配置组与面板)、`prices()`、`estimateTokens()`、`contextOverflow()`。

地址、密钥变量名与图像开关由控制台的端点面板编辑,模块不为它们声明配置组。模块自己的
`options.*` 要么走 `config()` 的配置组,要么由 `console()` 声明一块挂进 `instance` 插槽的面板——
内建 llamacpp 的运行时与模型两段走的是后者。

`create()` 返回 `ProviderInstance`:`client`(实现 `respond`)、`listModels?`、`control?`、
`compatibilityKey?`、`start?` / `stop?`、`contextWindow?(model)`。

`ProviderHost` 给实例:`stateDir`(`<部署根>/providers/<端点名>/`,归实例独占)、`repoRoot`、
`resource()`、`currentEntry()`、`secret(name)`(进程环境优先,否则读 `stateDir/.env` 一次)、
`readBlob()`、`keepThinking()`、`log`。

## 注册与解析

内建模块由 `providers/<module>/index.ts` 的默认导出自动发现。扩展模块由启动器在 `createBot`
之前通过 `registerProviderModules()` 注册,id 重复时抛错。

`ProviderRegistry.resolve(name)`:按 `entry.kind` 找模块,`normalize`,以去掉 `pricing` 与
`spec` 的条目 JSON 为缓存键(改模型或价格不重建实例),填 `stateDir` 与 `secret`。
`bind(name)` 在实例外包一层:注入 `quote`(报价快照)与 `origin`(实例、模块、模型、
`compatibilityDomain` = sha256(kind + baseUrl + `compatibilityKey()`))。Responses 历史推理仅在实例、
模块、兼容域与模型均匹配时回传。`invalidate()` 清除缓存;写入 `.env` 后必须调用,每个实例仅缓存一次文件内容。

## 配置形状

`LLMProviderEntry`:`kind`、`baseUrl`、`secret?`、`multimodal?`、`serviceTier?`、`pricing?`、
`options?`、`spec?: ModelSpec`。`ModelSpec`:`model`、`thinking`、`reasoningEffort?`、
`temperature?`、`maxTokens?`、`contextWindow?`。`providerSchemaVersion` 现在是 3。

Core 侧:`activeProviderEntry()` / `activeSpec()` 每次现读;`contextWindowOf()` 取上游探到值与
手填 `contextWindow` 的较小者;`contextFacts()` 优先用模块的 `estimateTokens` /
`contextOverflow`,没有则回落到 Core 的字符比估算。

## transport

`response-http.ts` 处理 HTTP/SSE:一次生成可包含多次请求尝试,重试间隔为 `[1s, 4s, 10s]`;超时
四档(流式首包 300s、非流式 120s、帧空闲 120s、内容空闲 300s);只对状态 0 / 429 / 5xx 重试,
401 / 403 先 `transport.refresh()` 一次;已提交不可逆增量后不再重试;输出字符超过
`max_output_tokens × 12` 时终止请求并报告超限;终态只接受 `completed` / `incomplete`,`failed` 抛
`LLMError`;每次请求尝试记录 `meters` 与 `charges`。

`responses-input.ts` 是原生 Responses 的无状态重放(system / developer 上提为
`instructions`);`chat.ts` + `native-input.ts` / `history.ts` 转换 Chat Completions 请求(历史
思维链不回传);`response-assembly.ts` 把两种流归一成 Open Responses 的 Item 流,
`finish_reason` 的 `length` / `content_filter` 落成 `incomplete_details.reason`;
`response-meters.ts` 把两种 usage 归一成 `TokenMeters`,缺项保持 null。

线协议类型在 `src/protocol/open-responses/`(规范 2026-04-24 生成),`ResponseAccumulator`
逐事件强校验:序号递增、终态自洽、已关闭的 Item 不得再变。

## pricebook

`PriceDefinition`:`models`、`currency`、`basis`(`marginal` | `equivalent`)、`rules`、
`inputBands`、`serviceTiers`、`source`。`quotePrices()` 在同一 basis 下让实例的 `pricing` 覆盖
模块默认,快照带 sha256 id 与 `capturedAt`。计量键:`input` / `output` / `total` /
`cachedInput` / `uncachedInput` / `reasoning` 与 `detail:*`,单价按每百万 token。实际扣费在
`src/core/generation.ts` 的 `priceUsage()`,缺计量记 `amount: null`。
