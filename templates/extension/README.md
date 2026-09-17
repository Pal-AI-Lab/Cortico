# templates/extension

Owner: `src/extensions/manifest.ts`, `tests/extensions/templates.test.ts`

三种 kind 各一个最小完整的扩展包,都是能直接装的真包:`pnpm check:extension` 通过,仓库的测试对
它们做干装载,所以它们不会落后于契约。

| 目录 | 包名 | 里面有什么 |
|---|---|---|
| `world/` | `cortico-world-example` | 一条挂载事件、一个工具、一段环境提示词、一个配置项 |
| `provider/` | `cortico-provider-example` | Chat Completions 协议端点；构造请求体与请求头，使用框架 transport |
| `bot/` | `cortico-bot-example` | 一个 Persona、一个 session、只有终端;Memory 是一份 MEMORY.md 加 blobs/ |

## 用法

1. 把对应的目录整个复制到仓库外面,放在哪里都行。
2. 改名:`package.json` 的 `name` 与 `description`,代码里的 id(`example`)与前缀(`EXAMPLE`、
   `Example`、`example_`)。三种 id 各有命名空间,但一份部署里同 kind 的 id 唯一。
3. 在包目录下:

```bash
corepack pnpm install
```

```bash
pnpm typecheck && pnpm test
```

4. 在 Cortico 仓库根下校验,再从控制台「扩展」页的「手动安装」填包目录的绝对路径,重启进程:

```bash
pnpm check:extension <包目录>
```

`cortico` 是模板的开发依赖:它只把框架源码给编辑器、类型检查与 vitest,没有入口,不启动任何东西。
装进实例后 `cortico/*` 由宿主的模块钩子解析到它自己运行的那份框架,包里这一份不参与运行。

## 装进实例后该看见什么

- **world**:扩展页卡片「已加载」;World 总览多一张 Example 卡;终端时间线里出现一条
  `example.started`;让 bot 调 `example_echo`,回执以配置里的开头一句起头。
- **provider**:「语言模型」页多一个 Example 方言;新建端点填 baseUrl、模型名与密钥,探活回状态码
  与耗时;终端里对话一轮。
- **bot**:部署的 `deployment.json` 写 `{ "bot": "cortico-bot-example" }`;起来后控制台标题是
  Example,终端里对话一轮,`memory/MEMORY.md` 多出 bot 写的行。

写法的规矩在 [docs/worlds.md](../../docs/worlds.md)、[docs/providers.md](../../docs/providers.md)、
[docs/personas.md](../../docs/personas.md);打包与校验在 [docs/extensions.md](../../docs/extensions.md)。
控制台面板模板里没有:要加面板看 `src/worlds/qq/console/client.ts` 与 [docs/console.md](../../docs/console.md)。
