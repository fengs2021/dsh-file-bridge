// dsh-file-bridge — client 端
// 在输入框左侧注入 📎 附件按钮：点击打开系统文件选择器，
// 选中文件上传到服务器共享目录，图片自动 mmx 识别，
// 返回的 markdown（图片 [![名](url)](url) / 文件 [名](url)）插入输入框，随消息发送。
window.__ModuleLoader__.load({
  id: "dsh-file-bridge",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let React = require("react");

    const CHANNEL = "/files";
    const call = (connection, method, args) =>
      connection.rpc.call(CHANNEL, method, args);

    function bytesToBase64(bytes) {
      const CHARS =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      let out = "";
      for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i];
        const b = bytes[i + 1];
        const c = bytes[i + 2];
        out += CHARS[a >> 2];
        out += CHARS[((a & 3) << 4) | ((b === undefined ? 0 : b) >> 4)];
        out += b === undefined ? "=" : CHARS[((b & 15) << 2) | ((c === undefined ? 0 : c) >> 6)];
        out += c === undefined ? "=" : CHARS[c & 63];
      }
      return out;
    }

    /** 图片压缩：手机相册原图太大，上传前缩到最长边 1600px、JPEG 0.85，体积降 10 倍+。 */
    function compressImage(file) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
          try {
            const MAX = 1600;
            let w = img.naturalWidth || img.width;
            let h = img.naturalHeight || img.height;
            if (w <= 0 || h <= 0) throw new Error("bad image");
            const scale = Math.min(1, MAX / Math.max(w, h));
            w = Math.max(1, Math.round(w * scale));
            h = Math.max(1, Math.round(h * scale));
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            const g = canvas.getContext("2d");
            if (!g) throw new Error("no canvas ctx");
            g.drawImage(img, 0, 0, w, h);
            canvas.toBlob(
              (blob) => {
                URL.revokeObjectURL(url);
                if (blob) {
                  // 保留原扩展名语义：压缩后统一 jpeg 输出，但文件名后缀保持原样
                  resolve(new File([blob], file.name, { type: "image/jpeg" }));
                } else {
                  reject(new Error("compress failed"));
                }
              },
              "image/jpeg",
              0.85
            );
          } catch (e) {
            URL.revokeObjectURL(url);
            reject(e);
          }
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error("image decode failed"));
        };
        img.src = url;
      });
    }

    /** 图片走官方原生机制：派发 drop 事件 → 输入框预览条（随消息发送，image-mmx 自动识别）。 */
    function addImagesNative(files) {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);
      const ev = new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
      });
      document.dispatchEvent(ev);
    }

    /** 把 markdown 追加进输入框（React 受控组件 hack：走原生 setter + input 事件）。 */
    function appendToComposer(text) {
      const ta = document.querySelector('textarea[data-input-editor="true"], .uV2eYG_input');
      if (!ta) return false;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      ).set;
      const cur = ta.value;
      const next = cur.length === 0 ? text : cur.replace(/\s*$/, "") + "\n" + text;
      setter.call(ta, next);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.focus();
      return true;
    }

    return {
      name: "dsh-file-bridge",
      inject: ["slots", "connection"],
      apply(ctx) {
        const slots = ctx.get("slots");
        const connection = ctx.get("connection");
        if (!slots || !connection) return;

        // 输入框上方 dock 注入附件按钮（紧挨输入框卡片）
        ctx.effect(() =>
          slots.inject("conversation.input.dock", () =>
          slots.register({ name: "conversation.input.dock", id: "file-bridge-attach", order: 5 },
            (props) => {
              const [busy, setBusy] = React.useState(false);
              const [error, setError] = React.useState(null);
              const inputRef = React.useRef(null);
              const sessionId =
                (props && (props.sessionId || (props.session && props.session.id))) || "";

              const onFiles = async (event) => {
                const files = Array.from(event.target.files || []);
                if (files.length === 0) return;
                setBusy(true);
                setError(null);
                try {
                  // 分流：图片 → 压缩 → 官方原生预览条（随消息发送，image-mmx 自动识别）
                  //       非图片 → RPC 上传 → markdown 链接插入输入框
                  const images = [];
                  const others = [];
                  for (const f of files) {
                    if (/^image\/(png|jpe?g|webp|gif)$/i.test(f.type || "")) {
                      const ready = await compressImage(f);
                      images.push(ready);
                    } else {
                      others.push(f);
                    }
                  }
                  if (images.length > 0) {
                    addImagesNative(images);
                  }
                  if (others.length > 0) {
                    const results = await Promise.allSettled(
                      others.map(async (file) => {
                        const buffer = await file.arrayBuffer();
                        return call(connection, "upload", {
                          sessionId,
                          name: file.name || "file",
                          mediaType: file.type || "application/octet-stream",
                          dataBase64: bytesToBase64(new Uint8Array(buffer)),
                        });
                      })
                    );
                    for (const r of results) {
                      if (r.status !== "fulfilled") {
                        setError(String(r.reason && r.reason.message ? r.reason.message : r.reason));
                        continue;
                      }
                      const res = r.value;
                      if (!res || !res.ok) {
                        const e = res && res.error;
                        setError((e && (e.message || e.code)) || "上传失败");
                        continue;
                      }
                      const v = res.value || {};
                      const url = v.url;
                      const md = `📎 [${v.name}](${url})`;
                      if (!appendToComposer(md)) {
                        setError("无法写入输入框，请手动粘贴：" + url);
                      }
                    }
                  }
                } catch (err) {
                  setError(String(err && err.message ? err.message : err));
                } finally {
                  setBusy(false);
                }
              };

              const btnStyle = {
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
                height: 26,
                borderRadius: 8,
                border: "1px solid var(--dsw-alias-border-l2-darkmode-thin, #333)",
                background: "var(--dsw-specific-input-major, transparent)",
                color: "var(--dsw-alias-label-secondary, #888)",
                cursor: "pointer",
                flex: "none",
                fontSize: 13,
                lineHeight: 1,
                padding: "0 8px",
                margin: "2px 0",
              };

              const pickFiles = () => {
                const input = inputRef.current;
                if (!input) return;
                input.value = "";
                // showPicker() 不需要 input 可见/聚焦，Android WebView 99+ 直接可用；
                // 不支持时降级 click()。
                if (typeof input.showPicker === "function") {
                  try {
                    input.showPicker();
                    return;
                  } catch (_) {
                    /* fall through to click() */
                  }
                }
                input.click();
              };

              return React.createElement(
                React.Fragment,
                null,
                React.createElement(
                  "button",
                  {
                    type: "button",
                    style: { ...btnStyle, opacity: busy ? 0.6 : 1 },
                    title: busy ? "上传中…" : "附件（图片/文件）",
                    disabled: busy,
                    onClick: pickFiles,
                  },
                  busy ? "⏳ 上传中" : "📎 附件"
                ),
                React.createElement("input", {
                  ref: inputRef,
                  type: "file",
                  multiple: true,
                  style: {
                    position: "fixed",
                    left: "-9999px",
                    top: "-9999px",
                    width: 1,
                    height: 1,
                    opacity: 0,
                  },
                  onChange: onFiles,
                }),
                error
                  ? React.createElement(
                      "span",
                      {
                        style: {
                          fontSize: 11,
                          color: "var(--dsw-alias-state-error-primary, #e5484d)",
                          marginLeft: 4,
                        },
                      },
                      error
                    )
                  : null
              );
            }
          )
        )
      );
      },
    };
  },
});
