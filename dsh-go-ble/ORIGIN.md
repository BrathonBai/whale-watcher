# 上游来源与覆盖集纪律（ORIGIN）

## 上游

| 项 | 值 |
|---|---|
| 项目 | dsh-Go（DSH 的 Android 客户端，Flutter + Kotlin，AGPL-3.0） |
| 版本 | **1.0.16**（`app/pubspec.yaml: version: 1.0.16+1`） |
| 拿到的方式 | 用户提供的 `dsh-Go-main.zip` |
| zip SHA-256 | `2628ddd96966d7e157a7a285520d641b661a4ca8cfc6127b453ccfd7776555be` |
| 本工作区解压位置 | `reference/dsh-go-main/`（只读，`.gitignore` 已排除；只作为对照和生成 manifest 用） |
| 接触时间 | 2026-11-13 |

上游仓库地址（README 里写的）：<https://github.com/ccch1mneyyy/dsh-go>。
授权边界见上游 `LICENSE`（AGPL-3.0，`sdk/`、`examples/` 为 MIT）与 `ASSETS.md`（名称、标识、
Deepy/鲸娘素材不在开源授权内）；上游 `AGENTS.md` 声明**暂不接受外部 PR**。本覆盖集是自用 fork
的补丁集，不是向上游提交的改动。

## 覆盖集是什么

`dsh-go-ble/files/` 是「**新增文件 + 被替换文件的完整内容**」的目录树，路径与上游仓库一致。
`apply.ps1` / `apply.sh` 把它拷到一份 dsh-Go 源码树上；**不删除**目标里的任何文件，回滚就是
`git checkout -- .`。

为什么不直接给完整 fork：完整仓库 ~385 MB（主要是 assets/字体/运行时），而改动只有十几个文件；
覆盖集 + `apply` 脚本更小、diff 可读、跟随上游升级的成本也低。

## 漂移检查

`tooling/make-manifest.mjs` 会对每个「替换」文件记录上游原始 SHA-256；`apply` 时：

- 目标文件哈希 == 上游原版 → 安全替换；
- 目标文件哈希 == 本补丁 → 已经应用过，跳过；
- 两者都不是 → **报漂移、不覆盖**（除非显式 `-Force` / `--force`）。

因此换了上游版本后，先跑一次 `make-manifest.mjs --upstream <新源码根>`，看哪些文件报漂移，
再逐个 `git diff` 决定怎么合，不要盲目 `-Force`。

## 生成方式

```powershell
# 1) 从 bridge/ 同步手机端要注入的插件（assets/engine/embodied/）
node dsh-go-ble/tooling/sync-embodied-assets.mjs

# 2) 生成覆盖集清单（新增/替换 + 上游哈希）
node dsh-go-ble/tooling/make-manifest.mjs

# 3) 应用到一份 dsh-Go 源码树
powershell -NoProfile -ExecutionPolicy Bypass -File .\dsh-go-ble\apply.ps1 -Target C:\path\to\dsh-go
```

> `files/app/assets/engine/embodied/` 是**生成物**（来自 `bridge/`），不要手改；改桥 → 重跑
> `sync-embodied-assets.mjs` → 重跑 `make-manifest.mjs`。`bridge/` 是唯一事实源。
