<!-- Owner: bin/cortico.mjs, start.bat, src/launcher.ts -->

# Windows

参考 bot 在 Windows 11 上开发与运行;框架本身不依赖 Windows,下面是平台分支所在。

## 启动

`start.bat` 设置 UTF-8 代码页、调用 `bin/cortico.mjs`,并在退出后等待按键。
部署选择菜单及 ↑↓ / Enter / Esc 按键处理由跨平台启动器提供。
关闭终端窗口的处理时限通常为 5 秒,可能不足以完成关机;正常退出使用控制台的「关机」。
时限由系统参数决定,见 [Windows 控制台文档](https://learn.microsoft.com/en-us/windows/console/handlerroutine)。

## Ctrl+C

Windows 把控制台事件发给前台进程组里的每一个进程。`bin/cortico.mjs` 收到后不做处理,
等子进程走完关机再退出,所以走 `start.bat` 或 `node bin/cortico.mjs <部署名>` 时提示符在关机
打完之后才回来。

经 `pnpm start` 启动时,链路上多一层 `pnpm.cmd`。cmd.exe 自己也响应同一个控制台事件,
弹出 `Terminate batch job (Y/N)?` 并可能在 bot 关机完成前把提示符交还给 shell;
此后 PSReadLine 的退格与方向键会打出控制字符,开新窗口即恢复。这一层不在 Cortico 的进程链内。

改动关机或启动器后按以下步骤手工验证:PowerShell 里启动 → Ctrl+C → 等关机输出打完 →
输入一行字并用退格和方向键编辑,行为应与启动前一致。

## 平台分支

| 位置 | 行为 |
|---|---|
| `src/launcher.ts` | 开浏览器用 `cmd /c start`;多监听一个 SIGBREAK(Ctrl+Break) |
| `src/extensions.ts` | 经 shell 调用 corepack 的 `.cmd` 启动文件,参数逐个加引号 |
| `src/web/path-picker.ts` | 本机路径选择器用 PowerShell 起 WinForms 对话框;没有 PowerShell 时报不可用 |
| `src/worlds/minecraft/` | 硬信号集 SIGHUP / SIGBREAK,收到即 `save-all` + `stop`;窗口探测与改标题走 `client-window.ps1`;便携 JDK 找 `bin/java.exe` |

## 运行限制

- 外部程序可能受到 Smart App Control 限制;诊断与运行时目录设置见 [runtimes.md](runtimes.md)。
- Minecraft 的 Java 版本约定与客户端兼容限制见 [Minecraft README](../src/worlds/minecraft/README.md)。
- 在 `extensions/` 下跑 pnpm 必须带 `--ignore-workspace`,否则根 lockfile 会多出一个 importer。

## 文本文件编码

手写的配置与密钥文件(`deployment.json`、`config.json`、`.env`)按 BOM 解码:UTF-8、
带 BOM 的 UTF-8 与 UTF-16 LE 都读得出来。PowerShell 5.1 的 `>` 与 `Out-File` 默认写 UTF-16 LE,
`Set-Content` 默认写当前代码页的 ANSI;非 ASCII 内容用 `-Encoding utf8` 指明。
