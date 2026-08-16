/**
 * dsh-file-bridge — DSH 文件收发桥（host 端）
 *
 * 能力：
 * 1. 【附件上传】📎 附件按钮（client）：手机/浏览器选图片或文件；
 *    图片压缩后走官方原生预览条（随消息发送，识别交给 dsh-image-mmx 插件），
 *    非图片走 RPC 上传 + markdown 链接；
 * 2. 【文件下发】`send_files` 工具：agent 把服务器文件复制进共享目录，
 *    返回 markdown——图片渲染为可点击预览，其他文件为下载链接；
 * 3. 【explorer 跳转】`send_files` 声明 locations（presentCall）→ 回复正文用反引号
 *    包住源路径（`/abs/path`）→ 前端渲染为可点击按钮 → 调起侧边栏 explorer 打开；
 * 4. 【静态服务】`/dsh-files/*` 只读伺服共享目录（防穿越、中文文件名 RFC 5987）。
 *
 * 注意：图片的 mmx 自动识别由独立插件 dsh-image-mmx 提供（原生图片块识别），
 * 本插件 upload 接口对图片保留可选识别（依赖本机 mmx CLI，未装自动降级）。
 */

import {
  mkdirSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  statSync,
  createReadStream,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join, basename, resolve, extname } from "node:path";
import { spawn } from "node:child_process";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "dsh-file-bridge";

export const inject = ["connection", "webServer", "tools"];

const CHANNEL = "/files";

// ---------------------------------------------------------------- base64 / 工具

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToBase64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : -1;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : -1;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 === -1 ? 0 : b1 >> 4)];
    out += b1 === -1 ? "=" : B64[((b1 & 15) << 2) | (b2 === -1 ? 0 : b2 >> 6)];
    out += b2 === -1 ? "=" : B64[b2 & 63];
  }
  return out;
}

function base64ToBytes(b64) {
  const out = [];
  let b = 0;
  let bits = 0;
  for (const ch of String(b64 || "")) {
    if (ch === "=") break;
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    b = (b << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((b >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function extFor(mediaType) {
  if (mediaType === "image/jpeg") return ".jpg";
  if (mediaType === "image/webp") return ".webp";
  if (mediaType === "image/gif") return ".gif";
  return ".png";
}

function shaOf(ref) {
  const id = String(ref && ref.attachmentId ? ref.attachmentId : "");
  return id.indexOf("sha256:") === 0 ? id.slice(7) : id;
}

function toPosix(p) {
  return String(p).replace(/\\/g, "/");
}

const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json",
  ".csv": "text/csv; charset=utf-8",
  ".zip": "application/zip",
  ".apk": "application/vnd.android.package-archive",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function mimeFor(name) {
  return MIME[extname(name).toLowerCase()] || "application/octet-stream";
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

function isImage(name) {
  return IMAGE_EXT.has(extname(name).toLowerCase());
}

// ---------------------------------------------------------------- mmx 识别

/** mmx 不支持的格式（gif 等）直接跳过识别，降级为路径文本。 */
const MMX_SUPPORTED = new Set(["image/jpeg", "image/png", "image/webp"]);

/** 单张图片识别超时（毫秒）。 */
const MMX_TIMEOUT_MS = 60_000;

/** 识别提示词：要求详细中文描述，保留文字信息（报错/代码/界面文本）。 */
const MMX_PROMPT =
  "请用中文详细描述这张图片的内容，包括画面元素、布局、以及图片中的全部文字信息（如报错信息、代码、界面文案）。如果图片里有代码或错误信息，请逐字保留。";

/** mmx 可执行文件候选（systemd 环境 PATH 可能不含 /usr/local/bin）。 */
const MMX_BIN_CANDIDATES = ["mmx", "/usr/local/bin/mmx"];

/**
 * 调用本机 mmx CLI 识别图片。
 * @param {string} imagePath 本地图片路径（jpg/png/webp）
 * @returns {Promise<{ok:boolean, text:string}>}
 */
function runMmxVision(imagePath) {
  return new Promise((resolve) => {
    let binIndex = 0;
    let child = null;
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (ok, text) => {
      if (settled) return;
      settled = true;
      resolve({ ok, text });
    };

    const timer = setTimeout(() => {
      try {
        child && child.kill("SIGKILL");
      } catch (_) {
        /* ignore */
      }
      finish(false, "");
    }, MMX_TIMEOUT_MS);

    const wire = () => {
      child.stdout.on("data", (d) => {
        stdout += d;
      });
      child.stderr.on("data", (d) => {
        stderr += d;
      });
      child.on("error", () => {
        // 第一个候选找不到时尝试绝对路径
        if (binIndex < MMX_BIN_CANDIDATES.length - 1) {
          binIndex += 1;
          try {
            child = spawn(
              MMX_BIN_CANDIDATES[binIndex],
              ["vision", "describe", "--image", imagePath, "--prompt", MMX_PROMPT, "--quiet"],
              { stdio: ["ignore", "pipe", "pipe"] }
            );
            stdout = "";
            stderr = "";
            wire();
          } catch (err) {
            finish(false, "");
          }
        } else {
          finish(false, "");
        }
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        let text = stdout.trim();
        if (code === 0 && text.length > 0) {
          // mmx --quiet 输出 JSON（content + base_resp），提取 content 纯文本
          if (text.startsWith("{")) {
            try {
              const parsed = JSON.parse(text);
              if (typeof parsed.content === "string" && parsed.content.length > 0) {
                text = parsed.content;
              }
            } catch (_) {
              /* 非 JSON 则原样使用 */
            }
          }
          finish(true, text);
        } else {
          if (stderr) {
            console.warn(`file-bridge: mmx vision failed (exit ${code}): ${stderr.slice(0, 300)}`);
          }
          finish(false, "");
        }
      });
    };

    try {
      child = spawn(
        MMX_BIN_CANDIDATES[binIndex],
        ["vision", "describe", "--image", imagePath, "--prompt", MMX_PROMPT, "--quiet"],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      wire();
    } catch (err) {
      finish(false, "");
    }
  });
}

// ---------------------------------------------------------------- 配置

/** 共享文件目录；config.filesDir 可覆盖，默认 ~/.dsh/files。 */
function filesDir(config) {
  const cfg = config || {};
  if (cfg.filesDir && cfg.filesDir.length > 0) return cfg.filesDir;
  return join(process.env.DSH_HOME || join(process.env.HOME || "/root", ".dsh"), "files");
}

/** 对外访问基础 URL；config.publicBase 可覆盖（默认 localhost 占位，务必配置为你的公网地址）。 */
function publicBase(config) {
  const cfg = config || {};
  if (cfg.publicBase && cfg.publicBase.length > 0) {
    return String(cfg.publicBase).replace(/\/+$/, "");
  }
  return "http://localhost:3080";
}

/** 生成共享目录内唯一文件名（同名加 -1/-2）。 */
function uniqueName(dir, name) {
  const safe = basename(String(name || "file")).replace(/[\\/]/g, "_").slice(0, 120);
  let candidate = safe || "file";
  let i = 1;
  while (existsSync(join(dir, candidate))) {
    const dot = safe.lastIndexOf(".");
    if (dot > 0) {
      candidate = safe.slice(0, dot) + "-" + i + safe.slice(dot);
    } else {
      candidate = safe + "-" + i;
    }
    i += 1;
  }
  return candidate;
}

// ---------------------------------------------------------------- 主逻辑

export function apply(ctx, config) {
  const connection = ctx.connection;
  const webServer = ctx.webServer;
  const tools = ctx.tools;

  // 注意：dsh 的 cordis 把插件配置作为 apply 第二参数传入（constructor(ctx, config) 模式），
  // 不能访问 ctx.config（未注入属性，proxy 抛 "cannot get property without inject"）
  // dir 必须在 apply 顶层定义：静态路由、RPC handler、send_files 工具三处共享
  const dir = filesDir(config);
  mkdirSync(dir, { recursive: true });

  // ──────────────────────────── 4) agent 工具：send_files ────────────────────────────
  const textSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      text: { type: "string", required: true },
    },
  };
  const text = (value) => [{ type: "text", text: value }];

  ctx.effect(() => {
    const disposeTool = tools.register(
      defineTool({
        name: "send_files",
        description:
          "把服务器上的文件（图片/PDF/文档等）发送到当前对话给用户：文件被复制到共享目录并生成可访问 URL，" +
          "返回的 markdown 直接嵌入你的回复正文即可——图片会以可点击预览形式显示（用户可点击打开原图、右键另存为），" +
          "其他文件显示为可点击下载链接。发送后，回复正文里再用反引号包住源文件绝对路径（如 `/root/proj/a.md`），" +
          "用户点击即可在侧边栏 explorer 中打开该文件。Triggers: 发文件给用户、把生成的文件/图片给用户看、交付附件。",
        parameters: {
          paths: {
            type: "string",
            required: true,
            description: "要发送的文件绝对路径列表，多个用英文逗号分隔。也可传单个路径。",
          },
          caption: {
            type: "string",
            description: "可选：附在文件前的说明文字（如文件用途）。不要与 markdown 重复。",
          },
        },
        output: { schema: textSchema, render: (_args, value) => text(value.text) },
        // call 卡片声明 locations（diff/edit 意图）→ 文件被会话记为"产出文件"，
        // 回复正文里用反引号包路径（`/abs/path`）即可渲染成可点击按钮 → 调起侧边栏 explorer
        presentCall(args) {
          const paths = String((args && args.paths) || "")
            .split(",")
            .map((p) => p.trim())
            .filter((p) => p.length > 0 && existsSync(p));
          return {
            card: "generic",
            title: "发送文件到对话",
            kind: "edit",
            locations: paths.map((p) => ({ path: p })),
          };
        },
        presentResult() {
          return { card: "generic", title: "已发送文件" };
        },
        async execute(args) {
          const raw = String(args.paths || "").trim();
          if (!raw) return { text: "send_files: paths 不能为空" };
          const paths = raw
            .split(",")
            .map((p) => p.trim())
            .filter((p) => p.length > 0);
          const lines = [];
          if (args.caption) lines.push(String(args.caption));
          for (const p of paths) {
            if (!existsSync(p) || !statSync(p).isFile()) {
              lines.push(`⚠️ 文件不存在：${p}`);
              continue;
            }
            try {
              const fileName = uniqueName(dir, basename(p));
              copyFileSync(p, join(dir, fileName));
              const url = publicBase(config) + "/dsh-files/" + encodeURIComponent(fileName);
              if (isImage(fileName)) {
                lines.push(`[![${fileName}](${url})](${url})`);
              } else {
                lines.push(`📎 [${fileName}](${url})`);
              }
            } catch (err) {
              lines.push(`⚠️ 发送失败 ${p}: ${String(err && err.message ? err.message : err)}`);
            }
          }
          if (lines.length === 0) return { text: "send_files: 没有可发送的文件" };
          return { text: lines.join("\n") };
        },
      })
    );
    return disposeTool;
  }, "file-bridge: tools");
}
