<!-- Owner: src/providers/base.ts, src/providers/console/hub.ts, src/providers/hub-api.ts, src/providers/name.ts, src/providers/registry.ts, src/providers/console/settings.ts, src/providers/console/config.ts, src/providers/openai-responses-compat/config.ts, src/providers/openai-responses-compat/native.ts, src/providers/llamacpp/config.ts, src/providers/llamacpp/options.ts, src/providers/llamacpp/native.ts, src/providers/transport/responses-input.ts -->

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
没有 `spec` 就不能被设为 active。新环境端点表为空；已有端点目录与原 activeProvider 引用继续读取。

## 端点目录

同一部署根下的各部署共用端点配置。每个 `<部署根>/providers/<端点名>/` 目录包含端点的
`config.json` 和存放密钥的 `.env`，同名密钥优先读取进程环境。目录内其余文件由 provider
模块管理。各部署在自己的 `config.json` 中设置 `activeProvider`。

## 控制台

模型供应商页列出共享端点,一次编辑其中一条。选中一条不改变 `activeProvider`,「设为当前」只写
当前部署的那一项。字段改动暂存在浏览器,保存时整条端点一次写入配置与密钥;暂存不进共享配置,
API Key 不写入浏览器。保存带上读取时的 revision,配置或密钥已被别处改过就返回 409,重新加载后
再保存。改名连带目录和部署根内各部署的 `activeProvider` 引用一起改;还被引用的端点不能删。
`kind` 保存后不可更改。

模块自己的配置与面板照旧由 ConfigGroup 和 `instance` 插槽声明,面板的 `setConfig` 同样只进
暂存;运行时启停、安装与模型列表要求端点已保存。「测试连接」按磁盘上的配置发一次请求,不参与
可用性判断。

控制台保存的 `secret` 遵循环境变量名格式 `[A-Za-z_][A-Za-z0-9_]*`。
从磁盘直接加载的名字按字面匹配;密钥值写入端点 `.env` 的同名项。

## 可用性

一个端点可用,是指它此刻能发起一次生成:选了模型、声明的 `secret` 读得到,模块自己的条件
也满足。判断只看本地状态,不连上游——探活是操作员按出来的另一件事。模块的那部分由
`ProviderModule.availability` 回答,不实现就只有通用条件(`llamacpp` 用它回答托管运行时装没装)。

终端页从状态帧读取当前端点的名称、模型、模块与地址,点开就是那条端点;一条都不可用时,输入框
的灰字写明去哪儿设置。

## 内建 openai-responses-compat

`POST <baseUrl>/responses`,每次请求重放完整上下文。历史推理按 `options.reasoningReplay` 回传:
`encrypted`(默认)只回 `encrypted_content`,且只回来源实例、模块、兼容域与模型均匹配的项,受
`keepPastThinking` 控制;`plaintext` 把推理文字以 `reasoning_text` 回传,最后一条 user 消息之后的
那一轮不受 `keepPastThinking` 约束,没有记录来源的工具调用前补一项合成推理。模块的 `detect`
探测发两条诊断请求(合成调用不带 / 带明文推理),按上游接受哪种写回 `reasoningReplay`。
`options.endpointPath`、
`options.extraHeaders`、`options.extraBody` 分别改路径、加头、并进请求体(`extraBody` 最后
合并,能覆盖 `service_tier` 之类)。模型列表走 `GET <baseUrl>/models`。

模型上下文上限取服务探测值与配置的 `contextWindow` 中的较小者；Core 根据该上限限制请求
容量，阶段预算由 Persona 决定（见 [sessions.md](sessions.md)）。

## 内建 llamacpp

`POST <baseUrl>/chat/completions`,思维链是模板开关(`chat_template_kwargs.enable_thinking`),
回执里的 `reasoning_content` 归一成推理项,历史里的随每次请求照原样发回;
`keepPastThinking` 关时只留合成开头那一条,思维链关时一条不带。两种用法由 `options.runtime` 有无
决定:

- **外部**:连接独立运行的 llama-server。通过 `/health` 检查状态、`/props?model=`
  读上下文窗口、`/models` 列模型(带加载状态与输入模态)。
- **托管**:端点页的运行时段落点「开启托管」后,`options.runtime` 记版本 tag 与后端,`options.launch`
  记 `-c` / `-ngl` / `--parallel` 与附加参数,`options.autoStart` 决定 bot 启动时是否一并起。
  运行时和启动配置由模块的 `ConfigGroup` 声明,端点面板复用控制台 schema 渲染器,
  修改经 `setConfig` 校验并保存。
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
按成本基准覆盖。`pricing` 为空时仍使用模块价目;两者都没有适用价目时,调用只记用量,
不记金额。缺少所需计量的费用项记为未知。

## 添加 Provider

写一个 provider 扩展:`kind: 'provider'`,默认导出 `ProviderModule`。接口与注册流程见
[src/providers/README.md](../src/providers/README.md),打包见 [extensions.md](extensions.md)。
