<!-- Owner: src/providers/base.ts, src/providers/registry.ts, src/providers/console/settings.ts -->

# Provider

Provider 适配模型服务的通信协议。仓库内建 `openai-responses-compat`（原生 Responses API）与
`llamacpp`（本机 llama-server，支持下载和进程托管）；其他实现通过扩展包安装，如
`cortico-provider-grok`。模型在端点配置中选择，Persona 不指定模型。

## 端点表

`config.providers` 是一张以端点名为键的表,`config.activeProvider` 指其中一个。每条端点:

| 字段 | 含义 |
|---|---|
| `kind` | provider 模块的 id，决定通信协议的实现 |
| `baseUrl` | 模型服务的基础 URL |
| `secret` | 自定义密钥环境变量名；优先读取进程环境，其次读取端点目录的 `.env` |
| `spec` | 模型与生成参数：`model`、`thinking`、`reasoningEffort`、`temperature`、`maxTokens`、`contextWindow` |
| `multimodal` | 是否接受图片 |
| `serviceTier` / `pricing` / `options` | 服务档位、价目、模块自定义项 |

主 session 每次模型调用读取当前 `activeProvider`;fork 在创建时固定端点与模型配置。
provider 模块不预设任何模型名;端点
没有 `spec` 就不能被设为 active。代码里只有一条默认端点 `deepseek`(`deepseek-flash`),
部署根 `providers/` 里有同名目录时以那份为准。

## 端点目录

同一部署根下的各部署共用端点配置。每个 `<部署根>/providers/<端点名>/` 目录包含端点的
`config.json` 和存放密钥的 `.env`，同名密钥优先读取进程环境。目录内其余文件由 provider
模块管理。各部署在自己的 `config.json` 中设置 `activeProvider`。

## 控制台

每个 provider 模块一页,页 id `llm:<kind>`。页顶选端点,以下都属于选中的那一条:新建、复制、
删除端点(当前端点不能删),连接与协议扩展,模块自己的段落(llamacpp 的运行时与模型),模型与
采样参数,价目,探活(发一条 ping,回状态码、耗时、是否带加密推理、这一次的费用)。

每格改完即写入端点条目,校验不过就不落盘、错误留在那一格。每次写入都重建该端点的客户端并
重读它的 `.env`,外部填的密钥随下一次请求生效,不必重启进程。地址或密钥变量名改过之后自动
取一次模型列表:取到就把模型格换成选单并带出上下文窗口,取不到就留在自由输入,原因写在格子
下面。新建的端点没有价目,在用量页记成未计价。

`secret` 遵循环境变量名格式 `[A-Za-z_][A-Za-z0-9_]*`。密钥值写入端点 `.env` 的同名项。

## 可用性

一个端点可用,是指它此刻能发起一次生成:选了模型、声明的 `secret` 读得到,模块自己的条件
也满足。判断只看本地状态,不连上游——探活是操作员按出来的另一件事。模块的那部分由
`ProviderModule.availability` 回答,不实现就只有通用条件(`llamacpp` 用它回答托管运行时装没装)。

模块页上的「可用端点」灯标这个模块的端点里有没有一个可用;左栏「语言模型」那一行的灯标
所有模块合起来有没有一个。一个都没有时,终端页的输入框灰字会写明去哪儿设置。

## 内建 openai-responses-compat

`POST <baseUrl>/responses`,每次请求重放完整上下文。历史推理通过 `encrypted_content` 回传;
本地仅保留来源实例、模块、兼容域与模型均匹配的推理项,并受 `keepPastThinking` 控制。
`options.endpointPath`、
`options.extraHeaders`、`options.extraBody` 分别改路径、加头、并进请求体(`extraBody` 最后
合并,能覆盖 `service_tier` 之类)。模型列表走 `GET <baseUrl>/models`。

模型上下文上限取服务探测值与配置的 `contextWindow` 中的较小者；Core 根据该上限限制请求
容量，阶段预算由 Persona 决定（见 [sessions.md](sessions.md)）。

## 内建 llamacpp

`POST <baseUrl>/chat/completions`,思维链是模板开关(`chat_template_kwargs.enable_thinking`),
回执里的 `reasoning_content` 归一成推理项,历史思维链不回传。两种用法由 `options.runtime` 有无
决定:

- **外部**:连接独立运行的 llama-server。通过 `/health` 检查状态、`/props?model=`
  读上下文窗口、`/models` 列模型(带加载状态与输入模态)。
- **托管**:端点页的运行时段落点「开启托管」后,`options.runtime` 记版本 tag 与后端,`options.launch`
  记 `-c` / `-ngl` / `--parallel` 与附加参数,`options.autoStart` 决定 bot 启动时是否一并起。
  这些格子都在同一段里改,改完即存。
  「下载并安装」把所选官方 release 解压到 `<部署根>/runtimes/llama.cpp/<tag>/<平台-后端-架构>/`;
  「启动」以 router 模式起 llama-server,不带模型,`LLAMA_CACHE` 与 `--models-dir` 指向
  `<部署根>/models/llamacpp/`。启动参数在下一次启动时生效,面板会标出待生效。
  端点已有外部服务时不接管该进程。

模型段落调用 llama-server 的 `/models*` 接口。输入 HuggingFace 仓库 id 后，由服务器
下载到缓存，面板从接口读取进度和状态。本机 GGUF 放入 `local/` 目录后需要重新扫描。
`spec.model` 使用模型列表中的 id，首次请求时由 router 自动加载。
目录约定见 [runtimes.md](runtimes.md)。

## 传输

一次生成可包含多次请求尝试,重试间隔为 1s / 4s / 10s;只对状态 0、429、5xx 重试,401/403 先刷新一次凭证。
已提交不可逆增量之后不再重试。终态只接受 `completed` 与 `incomplete`:截断落成
`incomplete_details.reason`,被截断的工具调用由 Core 标成未执行。输出字符数超过
`max_output_tokens × 12` 时终止请求并报告输出字符数超限。

## 计价

每次请求尝试按价目中声明的计量项计费,包括输入、输出、缓存命中与推理用量等,币种默认 USD,写入
`data/usage.jsonl`;控制台「用量」页与 `/api/usage` 聚合。模块自带价目,端点条目的 `pricing`
可覆盖;缺计量的项记为未知而不是零。`pricing` 为空表示没设价目,这条端点的调用只记 token,
不记金额。

## 添加 Provider

写一个 provider 扩展:`kind: 'provider'`,默认导出 `ProviderModule`。接口与注册流程见
[src/providers/README.md](../src/providers/README.md),打包见 [extensions.md](extensions.md)。
