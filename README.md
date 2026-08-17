# dsh-file-bridge

> Two-way file bridge for DeepSeek Harness conversations: 📎 attachment-button uploads, `send_files` tool delivery, and backtick paths that open in the sidebar explorer.
>
> DSH 文件收发桥：在对话里**双向交换文件**——📎 附件按钮上传、`send_files` 工具下发、反引号路径一键调起侧边栏 explorer 打开。

---

## English

### Capabilities

| Direction | Feature |
|---|---|
| 📥 **user → agent** | 📎 attachment button in the input bar: pick images or files from phone/browser; images are compressed and go through the official native preview rail (sent with the message); non-image files upload as accessible links |
| 📤 **agent → user** | `send_files` tool: images render as clickable previews (open original / save-as), other files as 📎 download links |
| 📤 **explorer jump** | When the agent wraps a **source absolute path** in backticks (`` `/root/proj/a.md` ``) in the same reply, the frontend renders a clickable button that opens the sidebar explorer at that file |
| 🗂️ **static serving** | `/dsh-files/*` read-only serving of the shared directory (path-traversal protected, RFC 5987 encoding for Chinese filenames) |

> Automatic **mmx image recognition** is provided by the companion plugin [dsh-image-mmx](https://github.com/fengs2021/dsh-image-mmx) (native image blocks, so text-only models can see images too).

### Install

Prereqs: DeepSeek Harness `0.1.0-rc.6+`, Node.js 18+.

```bash
dsh plugin --profile web add 'github:fengs2021/dsh-file-bridge'
systemctl restart dsh-web
```

### Config (cordis.patch.yml)

```yaml
- insert:
    - id: file-bridge
      name: dsh-file-bridge
      config:
        publicBase: "http://your-public-address:port"  # base URL for generated file links — REQUIRED
        filesDir: "/root/.dsh/files"                    # shared file directory (default ~/.dsh/files)
```

- `publicBase`: URL prefix for `send_files`/uploads — **change it to your public address on deployment**
- `filesDir`: optional, where files land

### Usage

**user → agent (📎 button)**: click 📎 in the input bar → pick a file. Images: compressed (max 1600px long edge) → native preview rail → sent with the message. Other files: uploaded → `📎 [filename](url)` inserted into the input.

**agent → user (`send_files`)**: the agent reply should include markdown links, e.g.

```
[![封面.png](http://host/dsh-files/封面.png)](http://host/dsh-files/封面.png)   ← clickable image
📎 [报告.pdf](http://host/dsh-files/报告.pdf)                                    ← downloadable file
```

**explorer jump**: wrap the **source path passed to `send_files`** (not the copied artifact path) in backticks in the same reply:

```
文件在 `/root/proj/a.md`，点击可在 explorer 打开。
```

### Architecture

```
Browser/App ──📎 pick──▶ image: native preview rail (official drop pipeline) / file: RPC POST /files/upload
Browser/App ◀──GET /dsh-files/*── static serving (read-only, traversal-safe)
agent ──send_files(presentCall locations)──▶ copy to shared dir ──▶ markdown + backtick path
backtick path ──fileMentions──▶ clickable button ──openFile──▶ sidebar explorer
```

- client module `immediately: true` (attachment button registered at boot)
- RPC responses follow the dsh protocol: `{ ok: true, value }` / `{ ok: false, error }`
- Uploads go through the `/files` channel — nginx needs a larger `client_max_body_size` (default 1m → 413; use 25m)

### FAQ

| Symptom | Cause / fix |
|---|---|
| Attachment button does nothing (Android WebView) | App must implement `WebChromeClient.onShowFileChooser` |
| HTTP 413 on upload | nginx `client_max_body_size` too small — set 25m |
| `dir is not defined` / crash loop | missing `node_modules/@deepseek-ai/dsh-tools` in the plugin dir — symlink from the dsh main install |
| Backtick path not clickable | must be the **tool-call source path** + same turn as the reply |

## 中文

### 能力

| 方向 | 功能 |
|---|---|
| 📥 **用户 → agent** | 输入框 📎 附件按钮：手机/浏览器选图或文件；图片压缩后走官方原生预览条（随消息发送），非图片上传为可访问链接 |
| 📤 **agent → 用户** | `send_files` 工具：图片渲染为可点击预览（打开原图/右键另存为），其他文件为 📎 下载链接 |
| 📤 **explorer 跳转** | `send_files` 回复正文用反引号包住**源文件绝对路径** → 前端渲染为可点击按钮 → 点击调起**侧边栏 explorer** 打开文件 |
| 🗂️ **静态服务** | `/dsh-files/*` 只读伺服共享目录（防路径穿越、中文文件名 RFC 5987 编码） |

> 图片内容的**自动 mmx 识别**由配套插件 [dsh-image-mmx](https://github.com/fengs2021/dsh-image-mmx) 提供（原生图片块识别，文本模型也能看图）。

### 安装

前置：DeepSeek Harness `0.1.0-rc.6+`、Node.js 18+。

```bash
dsh plugin --profile web add 'github:fengs2021/dsh-file-bridge'
systemctl restart dsh-web
```

### 配置（cordis.patch.yml）

```yaml
- insert:
    - id: file-bridge
      name: dsh-file-bridge
      config:
        publicBase: "http://你的公网地址:端口"   # 生成文件 URL 的基础地址，必须配置
        filesDir: "/root/.dsh/files"             # 共享文件目录（默认 ~/.dsh/files）
```

- `publicBase`：send_files/上传生成的 URL 前缀，**部署时必须改成你的公网访问地址**
- `filesDir`：可选，文件落盘目录

### 使用

**用户 → agent（📎 附件按钮）**：输入框上方点 📎 → 系统文件选择器 → 图片压缩（最长边 1600px）走原生预览条随消息发送；其他文件上传后插入 `📎 [文件名](url)`。

**agent → 用户（send_files）**：回复正文包含 markdown 链接（图片可点开、文件可下载），同轮回复用反引号包住传给 send_files 的源路径即可在 explorer 打开。

### 架构

```
浏览器/App ──📎 选文件──▶ 图片:原生预览条(官方 drop 管线) / 文件:RPC POST /files/upload
浏览器/App ◀──GET /dsh-files/*── 静态服务（只读，防穿越）
agent ──send_files(presentCall 声明 locations)──▶ 复制到共享目录 ──▶ markdown + 反引号路径
反引号路径 ──fileMentions──▶ 前端可点击按钮 ──openFile──▶ 侧边栏 explorer
```

- client 模块 `immediately: true`（boot 即注册附件按钮）
- RPC 返回符合 dsh 协议：`{ ok: true, value }` / `{ ok: false, error }`
- 上传走 `/files` 通道，nginx 需放宽 `client_max_body_size`（默认 1m 会 413，建议 25m）

### 常见问题

| 现象 | 原因 / 解决 |
|---|---|
| 附件按钮点击无反应（Android WebView） | App 端需实现 `WebChromeClient.onShowFileChooser` |
| 上传报 HTTP 413 | nginx `client_max_body_size` 太小，设为 25m |
| `dir is not defined` / crash loop | 插件目录 `node_modules/@deepseek-ai/dsh-tools` 缺失——桥接到 dsh 主装包（symlink） |
| 反引号路径不可点击 | 必须是**工具调用**的源路径 + 与回复同轮（turn 级生效） |

## License

MIT