<!-- Owner: src/paths.ts, src/providers/llamacpp/runtime-store.ts, src/providers/llamacpp/options.ts, src/providers/llamacpp/config.ts, src/providers/llamacpp/server.ts -->

# 运行时与模型文件

外部运行程序与模型权重保存在部署根下的共享目录,供多个部署使用。
内建 `llamacpp` provider 按以下约定管理文件,其他模块和扩展也应遵循该目录结构。

## 目录

```
<部署根>/
  runtimes/<运行时 id>/<版本>/…     可执行运行时,一个版本一个目录,可并存
  models/<owner>/…                  模型文件;owner 是 provider id 或 World id
```

`llamacpp` 用它们的方式:`runtimes/llama.cpp/<release tag>/<平台-后端-架构>/` 是解压后的官方
压缩包,目录里有 `cortico-runtime.json` 才算装好;`models/llamacpp/cache/` 是 llama-server 的
`LLAMA_CACHE`(拉取的模型落在这里),`models/llamacpp/local/` 是 `--models-dir`,手放的 GGUF
放这里(多模态或分片放子目录,mmproj 文件名以 `mmproj` 开头,这是 llama.cpp 自己的目录约定)。

## 运行时的四条约定

1. **固定版本。** 模块声明默认的上游 build tag 与各平台的下载文件名,配置可覆盖 tag。
   不同版本分别存储。
2. **模块自己下载。** 压缩包下到 `<目录>.partial/`、解压、写标记,最后整个目录改名到位;
   下次安装时清理未完成的临时目录。模块应校验上游提供的校验和;未提供时检查压缩包完整性。
3. **不代装系统依赖。** CUDA 版只搭配上游的 cudart 包;Cortico 不修改系统驱动、运行库和应用控制策略;
   启动失败时报告已知错误。
4. **自备目录优先。** 配置里给了运行时目录就不下载:自编译、Linux CUDA、签过名的构建走这里。

版本 tag 与自备目录去除首尾空白;自备目录为空时使用托管下载目录。

## 模型文件的两条约定

1. **能让运行时下载的,交给运行时。** llama-server 的 router 模式自己实现了 HuggingFace 拉取
   (`POST /models`)、进度(`GET /models` 里的 `status`)与取消;Cortico 面板调用这些接口。
2. **不能的,模块自己下,位置仍是 `models/<owner>/`。** 面板上给出来源链接与固定 revision。

## Windows 智能应用控制

Smart App Control 强制模式按应用信誉或可信证书判断是否允许程序运行,不能仅凭未签名断定会被拦截。
其规则见 [Microsoft Learn](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview)。
本模块读取注册表
`HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy\VerifiedAndReputablePolicyState`:
0 为关闭,1 为强制,2 为评估,读取失败为 null。面板在值为 1 时提示应用控制状态。

Windows 下的 `spawn UNKNOWN` 本身不能证明 Smart App Control 拦截。应核对 Windows 安全中心
的拦截记录;若确认被拦截,可提供符合信任要求的运行时目录,或由操作者决定是否更改应用控制设置。
自行签名不等于使用受信任 CA 签发的证书。单应用例外、关闭后的重新启用条件以本机系统版本和
[微软 FAQ](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions) 为准。

## 默认版本的发布文件(b10930)

每个 build 一个 tag,资产名 `llama-<tag>-bin-<os>-<后端>-<架构>.{zip,tar.gz}`:Windows 有
`cuda-13.3` / `cuda-12.4` / `vulkan` / `cpu`(x64)与 `cuda-13.4` / `cpu`(arm64),CUDA 版另配
`cudart-llama-bin-win-cuda-<版本>-<架构>.zip`;Ubuntu 有 `vulkan` / `rocm-10.0` / `cpu`,没有
CUDA;macOS 是 `macos-<架构>`。zip 是平铺的,tar.gz 套一层 `llama-<tag>/`。
