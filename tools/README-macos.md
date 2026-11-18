# macOS 首版打包

在 **macOS 本机**安装 Node **24.x**，并确保系统 `curl`、`ditto`、`sips`、`iconutil`、`codesign`、`lipo` 可用（必要时安装 Xcode Command Line Tools）。无需 npm 安装或新增依赖。`package.json` 与 `version.js` 的版本须一致，Electron 必须精确锁定版本。

```sh
node tools/build-macos-test.js                  # 离线契约测试
bash -n tools/build-macos.sh                   # Bash 语法检查
bash tools/build-macos.sh --arch arm64          # Apple Silicon
bash tools/build-macos.sh --arch x64 --dmg      # Intel，额外生成 DMG
# 可用 --node-version 24.x.y 指定真实存在的精确版本；默认使用本机 Node 版本。
```

脚本联网下载官方 Electron darwin ZIP、Node 24 darwin tar.gz 与各自 `SHASUMS256.txt`，逐一验证 SHA256 后组装。未指定架构时使用当前 shell 架构（Rosetta 下可能是 x64）。输出到新建的 `dist/macos-<版本>-<架构>-<随机串>/Notidea.app.zip`，可选 `Notidea.dmg`；不覆盖旧包，不发布。ZIP 使用 `ditto` 保留权限和符号链接。应用仅复制脚本内白名单源码，内置同架构 `Resources/app/runtime/node`；不会携带 node_modules 或用户数据库。源码白名单内的符号链接会被拒绝。

**仅 ad-hoc 签名，未 Developer ID 签名、未 Apple 公证，不能视作可公开分发的签名发行版。** Gatekeeper 可能阻止打开；正式对外分发前须另行完成 Developer ID 签名及公证。不建议全局关闭 Gatekeeper。

真实 Mac 验收：用 `ditto -x -k Notidea.app.zip <新建目录>` 解包，执行 `codesign --verify --deep --strict Notidea.app`，在对应架构 Mac 启动应用，确认服务启动、窗口及存储正常；验证重新打开和退出不会遗留进程。DMG 需挂载并拖入 Applications 后复验。跨架构组包不执行目标 Node；两种架构的启动必须分别实机验证。离线测试仅覆盖打包契约与校验解析，不代表已通过 macOS 构建、签名或运行测试。
