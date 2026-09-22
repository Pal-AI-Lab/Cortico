# Security Policy

## Reporting a vulnerability

Report it through [private vulnerability reporting](https://github.com/Pal-AI-Lab/Cortico/security/advisories/new).
Only the maintainers can read the report. Do not open a public issue for it.

Include the affected npm version or commit, the steps that reproduce it, and what an attacker
gains.

## Supported versions

Fixes land on `main` and ship in the next npm version of `cortico`. Earlier versions are not
patched.

## Scope

In scope: everything in this repository, including the launcher, Core, the console, the
extension loader, the bundled Worlds and providers, and the `cortico` npm package.

Out of scope:

- External extension packages. Report those to their own repository.
- A key leaked from your own deployment. Revoke it with its provider.

## 中文

发现安全问题请通过[私密漏洞报告](https://github.com/Pal-AI-Lab/Cortico/security/advisories/new)提交,
只有维护者能看到内容。不要开公开 issue。

报告里写明受影响的 npm 版本或 commit、复现步骤、攻击者能得到什么。

修复合进 `main`,随下一个 npm 版本发布;旧版本不单独打补丁。

范围是本仓库的全部内容。外部扩展包的问题报给它自己的仓库;自己部署里泄露的密钥请到对应服务商处吊销。
