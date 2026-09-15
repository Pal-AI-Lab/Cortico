<!-- Owner: src/paths.ts, src/deploy.ts, src/launcher.ts, bin/cortico.mjs -->

# 部署

一份部署是一个目录，存放一个 bot 的配置、密钥、Memory 与运行数据，不纳入版本控制。
代码包来自仓库的 `bots/<名>/` 或安装的 bot 扩展；多份部署可以使用同一个代码包。

## 部署根

所有部署的父目录。解析链:进程环境 `CORTICO_HOME` > 仓库根 `.env` 里的 `CORTICO_HOME` >
`<主仓库根>/deployments/`。相对路径按主仓库根解析;未设置覆盖值的 git worktree 使用主仓库的部署根。

部署根下与各部署平级的还有三个共享目录,供该部署根下的部署共用。它们没有
`deployment.json`,启动器列不出它们:

| 目录 | 是什么 |
|---|---|
| `providers/` | 端点表(见 [providers.md](providers.md)) |
| `runtimes/<id>/<版本>/` | 可执行运行时,一个版本一个目录(见 [runtimes.md](runtimes.md)) |
| `models/<owner>/` | 模型文件;owner 是 provider id 或 World id |

## 建一份

```bash
mkdir deployments/mybot
echo '{ "bot": "cormini" }' > deployments/mybot/deployment.json
pnpm start mybot
```

`deployment.json` 只有一个字段 `bot`:引用哪个代码包。仓内 `bots/<名>/` 有它就是那个,否则是
`extensions/` 下装的同名 bot 包(见 [extensions.md](extensions.md))。其余文件按需出现:

| 路径 | 是什么 |
|---|---|
| `config.json` | 这份部署的配置,压过包里的默认值(见 [configuration.md](configuration.md)) |
| `.env` | 这份部署里 World 的密钥(`SESSDATA`、`BRAVE_API_KEY`…),一行一个 `NAME=value` |
| `memory/` | Memory。目录名由 Persona 的 `paths.memory` 定(Cormini 与 CortiV 用 `workspace/`) |
| `data/` | 事件、会话、用量和进程状态等运行数据；删除后可重新启动，但原有记录无法恢复 |
| `prompts/` | Persona 文本的部署侧覆盖:`ORIENTATION.md`;`FIRST_TURN_{USER,THINKING,REPLY}.md` 只有这一层 |
| `worlds/<id>/ENV_PROMPT.md` | 某个 World 环境提示词的部署侧覆盖,整份替换。控制台编辑写入此文件,「移除部署覆盖」删除此文件 |
| `avatar.png`、`voices/` | 头像与参考声线 |

`data/` 里:`runs/index.jsonl` 与 `runs/<run>/`(见 [runs.md](runs.md))、`session-main.jsonl`
等 session 文件(见 [sessions.md](sessions.md))、`usage.jsonl`、`core-state.json`、
`timers.json`、单实例锁 `instance.lock`、重启标志 `.restart-request`。

环境提示词三层:World 自带的 `src/worlds/<id>/ENV_PROMPT.md` → 代码包的
`bots/<名>/worlds/<id>/ENV_PROMPT.md` → 部署的 `worlds/<id>/ENV_PROMPT.md`。后一层整份覆盖前一层。

## 启动

```bash
pnpm start <部署名>
```

| 参数 / 变量 | 作用 |
|---|---|
| `--list`(`pnpm bots`) | 列出部署根下每个含 `deployment.json` 的目录 |
| 不给名字 | 取 `CORTICO_BOT`;只有一份部署时可省略 |
| `--paused`、`CORTICO_START_PAUSED=1` | 启动时暂停事件投递，事件仍写入事件库并排队 |
| `--open`、`CORTICO_OPEN_BROWSER=1` | 启动后打开控制台 |
| `--log-level=<级别>`、`CORTICO_LOG` | 写入日志文件的最低级别，覆盖 `config.json` |
| `--force-second-instance` | 绕过单实例锁 |

启动前校验 `activeProvider` 必须在端点表里,不在直接退出。它声明的 `secret` 读不到(进程环境
或 `providers/<端点名>/.env`)只警告，允许启动。可在控制台「语言模型」页修改密钥变量名或补填密钥，
保存后下一次模型调用生效，不必重启。

`pnpm start`、`start.bat` 与 `start.sh` 都调用 `bin/cortico.mjs`。它安装缺失的依赖、在控制台产物缺失或不完整时构建，
在有多份部署时提供方向键菜单，并创建和监管 bot 子进程。子进程设置 `CORTICO_SUPERVISED=1`；
`CORTICO_START_PAUSED` 未设置时默认为 `1`。首次启动默认打开控制台，
`CORTICO_OPEN_BROWSER=0` 可关闭此行为；重启不再打开浏览器。控制台的「重启进程」由此启动器执行。

`tsx src/launcher.ts <部署名>` 直接运行 bot 进程本身：不装依赖、不建产物、不重启。

子进程通过 IPC 消息或 `data/.restart-request` 文件请求重启，启动器接受任一方式。
没有重启请求时，崩溃、非零退出和信号退出均不触发自动重启。

## 关机

SIGINT / SIGTERM / SIGHUP（Windows 另加 SIGBREAK）和未捕获异常触发分步关机，
总时限为 35 秒。Windows 关闭终端窗口的处理时限通常为 5 秒，可能不足以完成关机；
正常退出使用控制台的「关机」。系统时限见 [Windows 控制台文档](https://learn.microsoft.com/en-us/windows/console/handlerroutine)。

## 多份部署

同一个包起两份:两个目录各有 `deployment.json` 指同一个 `bot`,各自的 `config.json` 给不同
`web.port`。单实例锁按 `data/` 目录隔离,互不影响。

## 迁移

磁盘布局改名时仓库附迁移脚本,`tsx scripts/migrate-rename.ts` 只列计划,`--apply` 才动:
`config.json` 先备份再原子替换,事件库、session 与游标不碰。
