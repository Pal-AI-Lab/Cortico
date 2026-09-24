<!-- Owner: src/paths.ts, bin/cortico.mjs, src/launcher.ts, src/core/secrets.ts -->

# 环境变量

| 变量 | 读取处 | 作用 |
|---|---|---|
| `CORTICO_HOME` | `src/paths.ts` | 部署根。也可写在仓库根 `.env`;相对路径按主仓库根解析,绝对路径不调 git |
| `CORTICO_BOT` | `bin/cortico.mjs`、`src/launcher.ts` | `pnpm start` 不给名字时的部署名 |
| `CORTICO_LOG` | `src/launcher.ts` | 文件日志级别,次于 `--log-level=`,高于 `config.json` |
| `CORTICO_START_PAUSED` | `src/launcher.ts` | `1` / `true`:启动即暂停 |
| `CORTICO_OPEN_BROWSER` | `src/launcher.ts` | `1` / `true`:启动后打开控制台 |
| `CORTICO_SUPERVISED` | `src/boot.ts` | 由 `bin/cortico.mjs` 设置,表示由父进程处理重启;启用子进程的重启 IPC 通知和控制台重启功能 |
| `CORTICO_LANGUAGE` | `src/core/language.ts` | 控制台默认语言,次于 `config.json` 的 `language` |
| `CORTICO_WEB_PASSWORD` | `src/bot.ts` | 控制台访问密码,按密钥读取(进程环境或 `<部署>/.env`);非空时优先于 `config.json` 的 `web.password` |
| 任意密钥名 | `src/core/secrets.ts` | 进程环境里有就用它,否则读对应 `.env` |

密钥优先读取非空的进程环境变量，否则现读对应文件。

| 文件 | 放什么 |
|---|---|
| 仓库根 `.env` | 只放 `CORTICO_HOME`。密钥写在这里读不到 |
| `<部署>/.env` | World 的密钥:`SESSDATA`、`BRAVE_API_KEY`、`OPENROUTER_API_KEY`、`VTS_AUTH_TOKEN`… |
| `<部署根>/providers/<端点名>/.env` | 该端点的密钥,名字由端点条目的 `secret` 字段定 |

密钥文件一行一个 `NAME=value`,值不能含空格。仓库根 `.env` 的 `CORTICO_HOME` 可用引号包住含空格的路径。
控制台写密钥只写不读回。

安装扩展时向子进程传入 `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`;本机路径选择器使用
`CORTICO_PICKER_*` 传参。`CORTICO_DEV_MINIMAL=1` 使 `pnpm dev:console` 只挂载终端 World,`CORTICO_DEV_PASSWORD` 给开发控制台设访问密码,`CORTICO_PORT` 设置开发控制台端口
(默认 8848)。
