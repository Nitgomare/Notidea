# 拾念 Notidea

**还没想好，也值得记下。**

拾念是一款本地优先的卡片笔记应用。随手记录想法，用标签和搜索整理内容，再借助 AI 回看记录、发现联系。面向 Windows，支持独立桌面窗口。

## 核心功能

- **轻松记录**：卡片式笔记，支持图片、视频、语音附件与基础 Markdown。
- **整理与查找**：多级标签、全文搜索、筛选、置顶和双向链接。
- **回看与思考**：记录热力图、随机漫步、相关笔记、批注和提醒。
- **AI 辅助**：笔记问答、每日回顾、周期总结，以及 28 个洞察视角；可配置 OpenAI 兼容模型服务。
- **本地掌控**：笔记与附件保存在本机，支持导出和自定义数据目录。不配置 AI 也能使用笔记功能。

## 下载与使用

前往 **[最新版本](https://github.com/Nitgomare/Notidea/releases/latest)**：

- **一键安装**：下载 `install-notidea.exe`，选择安装位置后安装。
- **完整包**：下载 `notidea-<版本>-win-x64.zip`，解压后运行 `Notidea.exe`。
- **已有用户**：在设置中检查更新。升级前建议备份数据目录。

AI 功能需在设置中填写服务地址、模型和 API Key。使用 AI 时，相关笔记内容会发送至你配置的模型服务；检查更新及下载安装包也需要联网。

## 常用快捷键

| 快捷键 | 操作 |
| --- | --- |
| `Ctrl + Enter` | 保存笔记 |
| `Ctrl + K` | 搜索 |
| `Ctrl + Shift + N` | 聚焦记录输入框 |
| `Esc` | 关闭当前浮层或取消操作 |

## 本地开发

使用支持 `node:sqlite` 的 Node.js 22.13+（推荐 Node.js 24 LTS）。

```sh
npm install
npm start
```

仅启动网页服务：`node server.js`，打开 `http://127.0.0.1:7777`。

## 开源与致谢

采用 [MIT License](LICENSE)。欢迎提交 [Issue](https://github.com/Nitgomare/Notidea/issues) 或改进建议。

感谢 [AkaRhenium](https://github.com/AkaRhenium) 的界面与交互反馈，以及所有参与改进的人。
