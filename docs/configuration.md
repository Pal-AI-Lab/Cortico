<!-- Owner: src/deploy.ts, src/core/config.ts, src/core/config-schema.ts -->

# 配置

部署配置按以下顺序深合并,后者覆盖前者,数组整体替换:

1. `CORE_DEFAULTS`(`src/core/config.ts`)、bot 包的 `defaults()`,以及本机每个 World 实现的默认段
   (仓内目录加扩展;Persona 声明过的 `enabled: true`,其余 false);
2. 包里的 `bots/<名>/worlds/<id>/config.json`,只覆盖那个 World 的段;
3. 部署根 `providers/<端点名>/config.json` 汇成 `providers` 表;部署 `config.json` 里写的
   `providers` 段被丢弃;
4. 部署 `config.json`。

运行时各模块共享合并后的配置对象。控制台热改先修改对象,再写回部署 `config.json`。
写回时先读取原文件并生成临时文件,再将原文件改名为备份、临时文件改名为配置文件;
替换失败则恢复备份。原文件解析失败时拒绝写回。

## 顶层键

| 键 | 默认 | 含义 |
|---|---|---|
| `displayName` | `bot` | 控制台标题与终端消息的 bot 名称 |
| `timezone` | `Asia/Shanghai` | 时间戳与时刻表用的时区 |
| `providers` | `deepseek` 端点 | 共享端点配置,从部署根 `providers/` 读取(见 [providers.md](providers.md)) |
| `activeProvider` | `deepseek` | 当前端点 |
| `web.port` | `7777` | 控制台端口;三个参考 bot 各自改成 7777 / 7788 / 7789 |
| `paths.memory`、`paths.data` | `memory`、`data` | Memory 与运行数据目录,相对部署目录 |
| `batching` | `quietGapMs 2500`、`minBatchAgeMs 0`、`maxBatchAgeMs 15000`、`maxBatchSize 100` | 事件合批投递 |
| `context` | `keepPastThinking true` | 发给模型前的处理;阶段预算与首轮对话开关归 Persona 的段 |
| `logging` | `file debug`、`console info`、`areas ''` | 日志门槛与按区域覆盖,热改 |
| `worlds.<id>` | 各 World 自定 | `enabled` 控制是否启用;其余字段由 World 定义 |
| `language` | 系统区域 | 控制台默认语言 `zh` / `en`,浏览器可改(见 [console.md](console.md)) |

Persona 自己的段(如 CortiV 的 `context.maxTokens`、`context.firstTurn`、`rounds`、`cognition`、`tick`)由各 bot 的
`index.ts` 定义。

## 声明配置项

每个可调项在所属模块的 `ConfigGroup` 中声明为 JSON Schema 属性,键使用点分路径。
控制台按 schema 渲染表单。owner 是 `core`、`persona`、`world:<id>` 或 `provider:<kind>`。
支持的类型:integer、number、boolean、string(可 enum)、二元数组;其余降级为只读。扩展键:

| 键 | 作用 |
|---|---|
| `x-hot` | `false` 时前端标「重启生效」;Core 组每一项都是热改 |
| `x-scale`、`x-suffix` | 显示倍率与单位 |
| `x-options` | 下拉项 |
| `x-path` | 用本机路径选择器填 |
| `x-download` | 附下载动作 |

`POST /api/config` 按 schema 校验,忽略未声明的键。World 段通过 `WorldContext.persist` 写回,
同时更新共享配置对象与 `config.json` 的 `worlds.<id>`。World 的密钥写入部署 `.env` 和进程环境。
provider 组例外:端点值写 `providers/<端点名>/config.json`,`activeProvider` 写部署 `config.json`。

## 包与部署的配置分工

bot 包配置人格身份与演出选项,如 `minecraft.username`、`vtuber.delayedSources`。
部署配置凭证、程序路径、设备与启用状态。同一键同时存在时使用部署值。
