# micro-opus（vendored）

本目录是 **esphome-libs/micro-opus v0.4.1** 的离线内置副本，供 `firmware-v2` 构建使用。
不要在这里改上游代码；要升级就整目录替换并重新核对本文件（见文末"升级方法"）。

## 来源

- 组件名：`esphome/micro-opus`
- 版本：**0.4.1**
- 上游仓库：<https://github.com/esphome-libs/micro-opus>
- 上游提交：`8354085908683c6130e32a832aeec8a7ca115c51`（取自 `idf_component.yml` 的 `repository_info.commit_sha`）
- 下载方式（ESP-IDF Component Registry 直链，2026-11-03）：
  `https://components.espressif.com/api/downloads/?object_type=component&object_id=b558122b-4187-43be-ae25-3fa05c5fe534`
  （本机 curl/Invoke-WebRequest 的 schannel 被拦，改用 Python `requests` 下载，字节原样解压）
- 解压后的组件根目录原样放在 `firmware-v2/components/micro-opus/`，由 ESP-IDF 的
  `components/` 自动发现机制编译，**不需要**改 `main/idf_component.yml`。

## 许可证（双层）

| 部分 | 许可证 | 文件 |
| --- | --- | --- |
| micro-opus 包装层（`src/`、Ogg 解码器、cmake、patches） | Apache-2.0 | `LICENSE` |
| 上游 libopus（`lib/opus/`，xiph/opus） | BSD 3-clause 风格 | `lib/opus/COPYING`、`lib/opus/LICENSE_PLEASE_READ.txt` |
| lib/micro-ogg-demuxer（上游子模块） | Apache-2.0 | `lib/micro-ogg-demuxer/LICENSE` |

## 裁剪内容（只删文件；另有 1 处 cmake 脚本修改见文末"与上游的差异"）

为了控制仓库体积与干扰，删除了以下**不参与固件编译**的目录/文件（合计约 510 个文件 / 约 3.9 MB）：

- 组件根：`examples/`、`host_examples/`、`script/`、`CLAUDE.md`、`.clang-tidy`、`.clang-format`、
  `.pre-commit-config.yaml`、`.markdownlint.yaml`、`.gitattributes`、`.gitignore`
- `lib/opus/`：`tests/`、`doc/`、`training/`、`dnn/`（含 torch/training_tf2 数据集脚本）、`m4/`、
  `scripts/`、`cmake/`、`celt/tests/`、`celt/mips/`、`celt/arm/`、`celt/x86/`、`celt/dump_modes/`、
  `silk/tests/`、`silk/mips/`、`silk/arm/`、`silk/x86/`
- `lib/micro-ogg-demuxer/`：`.git*`/`.clang-*` 等开发元数据、`script/`
- 所有 `.git`（上游子模块的 gitlink 文件）与 `.gitmodules`：vendored 副本必须是普通文件树，
  否则 git 会把 `lib/opus`、`lib/micro-ogg-demuxer` 当成嵌套子模块、无法提交内容。

保留的是 `cmake/sources.cmake` 实际引用到的 `lib/opus/{src,celt,silk,silk/float,silk/fixed,include}`、
Xtensa 补丁追加的 `celt/xtensa/`、`patches/`（staging 阶段要用 `patch` 应用）、`lib/micro-ogg-demuxer/`
（组件 `CMakeLists.txt` 会 `add_subdirectory` 它）以及两份 LICENSE/COPYING。

## 与上游的差异

- 源码与 Kconfig 未改；`lib/opus` 保持上游原样（补丁在构建时由 staging 应用到构建目录，
  见下）。唯一新增文件是本 `VENDORED.md`。
- **本地修改 1 处**：`cmake/staging.cmake` —— 把补丁应用方式从外部 GNU `patch` 改为
  `git apply --recount --binary --whitespace=nowarn -p1`（函数 `opus_apply_patch`，
  以及开头"Find git executable"段）。原因：
  1. 上游 0.4.1 打包的 `.patch` 文件被做过空白裁剪（空上下文行丢了行首空格、末尾上下文
     被截断），严格实现会报 `corrupt patch`；
  2. Windows 默认没有 `patch.exe`；Git for Windows 自带的 MSYS2 `patch.exe` 在受限沙箱/
     容器里会因创建 signal pipe 失败直接崩溃（`Win32 error 5`）；
  3. `git apply --recount` 会按实际行数重算 hunk、容忍上述空白差异；ESP-IDF 构建环境必有
     Git（IDF 自身也要用 git 取版本信息），因此不引入新的构建依赖。
  该修改已在 Windows + IDF v5.5.0 + 本机 Xtensa 工具链下做端到端验证：6 个补丁全部应用、
  Xtensa 附加文件拷入 staged 树，**staged 的 142 个 C/C++ 源文件用 xtensa gcc/g++
  `-fsyntax-only` 全部通过**（详见 `docs/迭代-2026-11-03-设备Opus.md` §7/§8）。
- 上表"裁剪内容"里删掉的是未参与编译的开发目录；`lib/opus` 的编译源文件、`patches/`、
  `cmake/`、`micro-ogg-demuxer` 均完整保留。
- 上游 libopus 版本：组件 `cmake/config.h.in` 内为 `PACKAGE_VERSION "1.4"`（xiph/opus 1.4，
  BSD）；组件 zip 未携带 `package_version` 文件，无法从包内读出 submodule 精确 commit。

## 升级方法

1. 从 Component Registry 下载新版本 zip，解压后按本文件"裁剪内容"重新裁剪；
2. 更新本文件里的版本/commit/下载 URL；
3. 重新把 `cmake/staging.cmake` 的补丁应用方式改成 `git apply --recount`（见上"本地修改"），
   否则构建机需自备 GNU patch；
4. `idf.py build` 全量重编（staging 有配置哈希，会重建 `opus-staged/`）；
5. 真机验证解码音质/CPU（见迭代文档"未验证项"）。
