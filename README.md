# dsh-file-bridge

DSH（DeepSeek Harness）文件收发桥：在对话里**双向交换文件**——📎 附件按钮上传、`send_files` 工具下发、反引号路径一键调起侧边栏 explorer 打开。

## 能力

| 方向 | 功能 |
|---|---|
| 📥 **用户 → agent** | 输入框 📎 附件按钮：手机/浏览器选图或文件；图片压缩后走官方原生预览条（随消息发送），非图片上传为可访问链接 |
| 📤 **agent → 用户** | `send_files` 工具：图片渲染为可点击预览（打开原图/右键另存为），其他文件为 📎 下载链接 |
| 📤 **explorer 跳转** | `send_files` 回复正文用反引号包住**源文件绝对路径**（`` `/root/proj/a.md` ``）→ 前端渲染为可点击按钮 → 点击调起**侧边栏 explorer** 打开文件 |
| 🗂️ **静态服务** | `/dsh-files/*` 只读伺服共享目录（防路径穿越、中文文件名 RFC 5987 编码） |

> 图片内容的**自动 mmx 识别**由配套插件 [dsh-image-mmx](https://github.com/fengs2021/dsh-image-mmx) 提供（原生图片块识别，文本模型也能看图）。

## 安装

前置：DeepSeek Harness `0.1.0-rc.6+`、Node.js 18+。

```bash
dsh plugin --profile web add 'github:fengs2021/dsh-file-bridge'
systemctl restart dsh-web   # 或重启 dsh web
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

## 使用

### 用户 → agent（📎 附件按钮）

1. 输入框上方点 **📎 附件** → 系统文件选择器
2. 图片：压缩（最长边 1600px）→ 原生预览条 → 随消息发送（agent 可看图，识别交给 dsh-image-mmx）
3. 其他文件：上传 → 输入框插入 `📎 [文件名](url)` → 发送

### agent → 用户（send_files）

agent 调用 `send_files` 工具后，回复正文应包含：

```
[![封面.png](http://host/dsh-files/封面.png)](http://host/dsh-files/封面.png)   ← 图片可点开
📎 [报告.pdf](http://host/dsh-files/报告.pdf)                                    ← 文件可下载
```

**explorer 跳转**：同一轮回复里用反引号包住**传给 send_files 的源路径**（不是复制后的产物路径）：

```
文件在 `/root/proj/a.md`，点击可在 explorer 打开。
```

## 架构

```
浏览器/App ──📎 选文件──▶ 图片:原生预览条(官方 drop 管线) / 文件:RPC POST /files/upload
浏览器/App ◀──GET /dsh-files/*── 静态服务（只读，防穿越）
agent ──send_files(presentCall 声明 locations)──▶ 复制到共享目录 ──▶ markdown + 反引号路径
反引号路径 ──fileMentions──▶ 前端可点击按钮 ──openFile──▶ 侧边栏 explorer
```

- client 模块 `immediately: true`（boot 即注册附件按钮）
- RPC 返回符合 dsh 协议：`{ ok: true, value }` / `{ ok: false, error }`
- 上传走 `/files` 通道，nginx 需放宽 `client_max_body_size`（默认 1m 会 413，建议 25m）

## 常见问题

| 现象 | 原因 / 解决 |
|---|---|
| 附件按钮点击无反应（Android WebView） | App 端需实现 `WebChromeClient.onShowFileChooser`（标准 WebView 文件选择支持） |
| 上传报 HTTP 413 | nginx `client_max_body_size` 太小，设为 25m |
| `dir is not defined` / crash loop | 插件目录 `node_modules/@deepseek-ai/dsh-tools` 缺失——桥接到 dsh 主装包：`ln -s /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools <插件目录>/node_modules/@deepseek-ai/dsh-tools` |
| 反引号路径不可点击 | 必须是**工具调用**的源路径 + 与回复同轮（turn 级生效） |

## License

MIT
