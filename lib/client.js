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

    /**
     * 图片压缩 + 长截图切片：手机相册图太大，上传前缩到每边上限内、JPEG 0.85。
     *
     * ⚠️ DSH 图片 admission 限制每边 ≤ 2000px（dsh-attachment-local
     *    maxImageDimension 默认 2000，超出抛 IMAGE_DIMENSION_TOO_LARGE，
     *    提示「图片宽高不能超过2000」）。早期实现按「最长边≤1600」压缩，
     *    会把手机长截图（比如 810×14400）的宽度压到 810×(1600/14400)≈91px，
     *    文字全糊、VLM 识别不出（症状：图片能上传但「识别不对/看不清」）。
     *    后来放宽到最长边 4096 又让长截图超 2000 被 DSH 拒绝。
     *
     * 正确做法：长截图**切片**成多段，每段高度 ≤ 1900px（避开 2000 上限），
     *    宽度保持 ≥ 360px（文字可读），分别上传——既满足 DSH 每边 ≤2000，
     *    又让文字清晰可读。
     * @returns {Promise<File[]>} 切片后的图片文件数组（普通图返回单元素数组）。
     */
    function compressImage(file) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
          try {
            const MAX_SIDE = 1900; // 每片最长边上限（<2000，避开 DSH maxImageDimension）
            const MIN_WIDTH = 360; // 宽度下限，保证文字可读
            let w = img.naturalWidth || img.width;
            let h = img.naturalHeight || img.height;
            if (w <= 0 || h <= 0) throw new Error("bad image");
            // 目标宽度：只缩不放（不超过 MAX_SIDE）；原图本就窄（< MIN_WIDTH）时不放大，
            // 窄图无法通过放大提升清晰度，保留原宽即可。
            const targetW = Math.min(MAX_SIDE, w);
            const scale = targetW / w;
            const sliceW = Math.max(1, Math.round(w * scale));
            const totalH = Math.round(h * scale);
            const sliceCount = Math.max(1, Math.ceil(totalH / MAX_SIDE));
            const clips = [];
            let done = 0;

            const finish = () => {
              URL.revokeObjectURL(url);
              resolve(clips);
            };
            const fail = () => {
              URL.revokeObjectURL(url);
              reject(new Error("compress failed"));
            };
            const base = (file.name || "image").replace(/\.[^.]+$/, "");

            for (let i = 0; i < sliceCount; i++) {
              const offsetY = i * MAX_SIDE;
              const destH = Math.min(MAX_SIDE, totalH - offsetY);
              if (destH <= 0) {
                finish();
                return;
              }
              const canvas = document.createElement("canvas");
              canvas.width = sliceW;
              canvas.height = destH;
              const g = canvas.getContext("2d");
              if (!g) {
                fail();
                return;
              }
              // 从原图切出对应源区域：源 y = offsetY/scale，源高 = destH/scale
              const srcY = offsetY / scale;
              const srcH = Math.min(h, destH / scale);
              g.drawImage(img, 0, srcY, w, srcH, 0, 0, sliceW, destH);
              canvas.toBlob((blob) => {
                if (!blob) {
                  fail();
                  return;
                }
                const name = sliceCount > 1 ? `${base}-${i + 1}.jpg` : `${base}.jpg`;
                clips.push(new File([blob], name, { type: "image/jpeg" }));
                done += 1;
                if (done === sliceCount) finish();
              }, "image/jpeg", 0.85);
            }
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

    /**
     * 图片走官方原生机制：派发 drop 事件 → 输入框预览条（随消息发送，image-mmx 自动识别）。
     *
     * ⚠️ 兼容性：不能把多个文件一次性 `dt.items.add()` 进同一个 DataTransfer ——
     * 某些浏览器（尤其手机 WebView / 部分 Chromium）对 DataTransferItemList.add
     * 的内存 File 检查很严格，且多文件一次 add 会抛
     * “Failed to execute 'add' ... parameter 1 is not of type 'File'”。
     * 单文件 add 之前验证可用，所以改为**每个文件独立构造一个 DataTransfer +
     * 派发一次 drop**，逐个注入；对非 File 的元素先防御性重建为标准 File。
     */
    function addImagesNative(files) {
      const list = Array.isArray(files) ? files : [files];
      for (let f of list) {
        // 防御：个别浏览器 new File([blob]) 产生的对象不满足 add 的 File 检查，
        // 尝试以标准参数重建一次。
        if (!(f instanceof File) && f && typeof f === "object") {
          try {
            f = new File([f], f.name || "image.jpg", { type: f.type || "image/jpeg" });
          } catch (_) {
            /* keep original */
          }
        }
        if (!(f instanceof File)) {
          console.warn("file-bridge: skip non-File image", f);
          continue;
        }
        try {
          const dt = new DataTransfer();
          dt.items.add(f);
          const ev = new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
          });
          document.dispatchEvent(ev);
        } catch (err) {
          console.warn("file-bridge: add native image failed:", err);
          // 兜底：实在加不进原生预览条时，把该切片降级为非图片走 RPC 上传链接
          // （由调用方 onFiles 的 others 分支处理——这里仅记录，避免整体失败）
        }
      }
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
                      // compressImage 返回切片数组（长截图切多段，普通图单元素）
                      const ready = await compressImage(f);
                      images.push(...ready);
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
