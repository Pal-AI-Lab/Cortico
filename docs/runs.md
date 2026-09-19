<!-- Owner: src/core/run.ts, src/core/types.ts (LogRecord), scripts/logq.ts -->

# Run 与日志

一个 run 对应一次进程运行。暂停沿用当前 run，重启创建新 run。`data/runs/index.jsonl`
每次启动与关机各记录一行，崩溃的 run 没有关机行。`data/runs/<run>/` 保存本次运行的记录，id 形如
`r-20260910-104402-c2ab`。

## 目录

| 文件 | 内容 |
|---|---|
| `run.json` | 这次运行的 World 清单与配置指纹 |
| `events.jsonl` | 事件库分片;cursor 跨 run 全局单调 |
| `log.jsonl` | 运行日志,64 MiB 轮转成 `log.1.jsonl`… |
| `transcript.jsonl` | 模型调用的上下文记录 |
| `toolcalls.jsonl` | 工具调用与回执 |
| `incidents/` | 事故包 |

`data/` 根下与 run 无关的:`session-main.jsonl`、`usage.jsonl`、`core-state.json`(投递水位、
模型停滞、Persona 的不透明状态、World 可见性)、`timers.json`、`instance.lock`、`web-auth.key`(控制台登录令牌的随机盐,设了访问密码才生成)。

## 日志格式

`log.jsonl` 一行一个 `LogRecord`:`ts`(部署时区的 ISO,毫秒)、`run`、`seq`、`level`、
`area`(`core.loop`、`worlds.minecraft`、`console`…)、`event?`、`msg`、`durMs?`、
`repeat?`（折叠汇总）、`data?`、`err?`。关联字段 `sess` / `round` / `resp` / `call` / `ev` /
`task` 分别标识 session、轮次、模型调用、工具调用、事件和任务；这些字段由 AsyncLocalStorage
在轮次与工具调用边界设置，写入日志时读取。子进程通过 IPC 发送使用自身时钟的 `LogNote`，
由父进程写入日志；sidecar 的 stdout / stderr 归入 `<world>.stdio`。

级别热改:`logging.file`、`logging.console`、`logging.areas`(按区域前缀最长匹配)都是热改项,
每次写入现读。30 秒内重复的行折叠成一条带 `repeat` 的汇总。

## 查询

```bash
pnpm logq --bot <部署名> [--run latest|<id>|<前缀>] [子命令] [过滤]
```

| 子命令 | 作用 |
|---|---|
| `runs` | 列 run |
| `log`(缺省) | 按旧到新读 `log.N.jsonl` 再 `log.jsonl` |
| `timeline` | 把 log / toolcalls / transcript / events / usage 按时间归并 |
| `turn <N>` | 一轮的全部记录 |
| `doctor` | 常见故障自检 |
| `bundle --out <dir>` | 将运行记录、用量、诊断结果和脱敏配置导出到指定目录 |

过滤:`--level warn+`、`--area <前缀>`、`--event`、`--grep <regex>`、`--since` / `--until`
(ISO、`10m` / `2h` / `1d`、`HH:MM[:SS]`;相对时刻从 run 结束往回数)、`--round`、`--call`、
`--resp`、`--task`、`--limit N`(默认 200)、`--format text|jsonl`、`--streams`、`--full`。

查询不修改源日志，大文件通过流式读取处理。`bundle` 将导出文件写入 `--out` 指定的目录。
