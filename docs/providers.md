# Provider

Owner: `src/providers/base.ts`, `src/providers/registry.ts`, `src/providers/console/settings.ts`

Provider 是模型端点的方言。仓库内建两个:`openai-responses-compat`(原生 Responses API)与
`llamacpp`(本机 llama-server,可由 Cortico 下载并托管);别的方言是扩展包(如
`cortico-provider-grok`)。哪台机器上有哪些端点、用什么模型,是部署事实,Persona 看不见。

## 端点表

`config.providers` 是一张以端点名为键的表,`config.activeProvider` 指其中一个。每条端点:

| 字段 | 含义 |
|---|---|
| `kind` | 方言,对应一个 provider 模块的 id |
| `baseUrl` | 端点根 |
| `secret` | 密钥所在的环境变量名;值在端点目录的 `.env` 里 |
| `spec` | 模型事实:`model`、`thinking`、`reasoningEffort`、`temperature`、`maxTokens`、`contextWindow` |
| `multimodal` | 是否接受图片 |
| `serviceTier` / `pricing` / `options` | 服务档位、价目、模块自定义项 |

`activeProvider` 每次调用现读,控制台上切换即刻生效。provider 模块不预设任何模型名;端点
没有 `spec` 就不能被设为 active。代码里只有一条种子端点 `deepseek`(`deepseek-flash`),
部署根 `providers/` 里有同名目录时以那份为准。

## 端点目录

一台机器上的端点是全局事实,不随部署各存一份:`<部署根>/providers/<端点名>/` 一个端点一个
目录,里面 `config.json` 是整条 entry,`.env` 是密钥(进程环境里的同名变量优先)。目录内部
其余内容归 provider 模块自用。`activeProvider` 仍写在各份部署自己的 `config.json`。

## 控制台

每个 provider 模块一页,页 id `llm:<kind>`。页上能做的事:新建、复制、删除端点(当前端点不能
删),写模型与采样参数,填密钥(只写不读回),拉模型列表,探活(发一条 ping,回状态码、耗时、
是否带加密推理、这一次的费用),编辑价目。

## 内建 openai-responses-compat

`POST <baseUrl>/responses`,无状态重放:每次请求回放整份上下文,历史推理以签名
`encrypted_content` 回传,只在同一实例、同一模型内有效。`options.endpointPath`、
`options.extraHeaders`、`options.extraBody` 分别改路径、加头、并进请求体(`extraBody` 最后
合并,能覆盖 `service_tier` 之类)。模型列表走 `GET <baseUrl>/models`。

上下文物理上限取上游探到的值与手填 `contextWindow` 的较小者;Core 只守这条硬线,阶段预算
归 Persona(见 [sessions.md](sessions.md))。

## 内建 llamacpp

`POST <baseUrl>/chat/completions`,思维链是模板开关(`chat_template_kwargs.enable_thinking`),
回执里的 `reasoning_content` 归一成推理项,历史思维链不回传。两种用法由 `options.runtime` 有无
决定:

- **外部**:连一台已经在跑的 llama-server。多出来的只有探针:`/health` 探活、`/props?model=`
  读上下文窗口、`/models` 列模型(带加载状态与输入模态)。
- **托管**:「运行时」面板点「开启托管」后,`options.runtime` 记版本 tag 与后端,`options.launch`
  记 `-c` / `-ngl` / `--parallel` 与附加参数,`options.autoStart` 决定 bot 启动时是否一并起。
  「下载并安装」把钉住的官方 release 解压到 `<部署根>/runtimes/llama.cpp/<tag>/<平台-后端>/`;
  「启动」以 router 模式起 llama-server,不带模型,`LLAMA_CACHE` 与 `--models-dir` 指向
  `<部署根>/models/llamacpp/`。启动参数在下一次启动时生效,面板会标出待生效。
  端点上已经有别人起的 server 时不接管。

「模型」面板是 llama-server 自己的 `/models*` 端点的皮:填 HuggingFace 仓库 id 点「拉取」,
server 下到缓存里,进度与状态从列表回读;本机 GGUF 扔进 `local/` 目录后「重扫」。`spec.model`
填列表里的 id,首次请求时 router 自动加载。目录约定见 [runtimes.md](runtimes.md)。

llamacpp 讲的是 llama-server 的方言:思考开关走模板的 `chat_template_kwargs`。端点是只有
chat/completions、且对未知字段整单拒绝的网关时,可用 `options.omitTemplateKwargs: true` 省略该字段、
`options.extraBody` 按那个端点的方言自带思考参数;要不要让这类端点成为内建方言的一部分,由维护者定——
全新方言仍按 [extensions.md](extensions.md) 写成扩展。

## 传输

一次生成多次 attempt,退避 1s / 4s / 10s;只对状态 0、429、5xx 重试,401/403 先刷新一次凭证。
已提交不可逆增量之后不再重试。终态只接受 `completed` 与 `incomplete`:截断落成
`incomplete_details.reason`,被截断的工具调用由 Core 标成未执行。输出字符数超过
`max_output_tokens × 12` 判为跑飞,掐断。

## 计价

每次 attempt 按计量(输入、输出、缓存命中、推理)乘以报价得费用,币种默认 USD,落在
`data/usage.jsonl`;控制台「用量」页与 `/api/usage` 聚合。模块自带价目,端点条目的 `pricing`
可覆盖;缺计量的项记为未知而不是零。

## 换一种方言

写一个 provider 扩展:`kind: 'provider'`,默认导出 `ProviderModule`。接口与注册流程见
[src/providers/README.md](../src/providers/README.md),打包见 [extensions.md](extensions.md)。
