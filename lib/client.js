// dsh-xps-peakfit — 右侧栏「XPS 模板」标签（免构建，直接注入宿主 ModuleLoader）
//
// 挂载点：sidebar.right.pane.tab + sidebarRightTabs 的 tab type 注册。
// 数据全部走插件自己的路由（lib/routes.js，前缀 /xps），页面**从不**直接驱动 XPSPeak：
// 「用这个」只拿到一段结构化指令，执行在 agent 侧，档位闸门在 MCP。
window.__ModuleLoader__.load({
  id: "dsh-xps-peakfit",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const React = require("react");
    const { useEffect, useRef, useState } = React;
    // 必须用 createElement，不用 react/jsx-runtime 的 jsx：后者的第三个参数是 **key**，
    // 而本文件所有调用都是 jsx(type, props, [子元素]) —— children 会被整个丢掉，
    // 面板只剩空壳（0 张卡）。createElement 的 (type, props, ...children) 与这个形态兼容。
    const { createElement: jsx } = React;

    const BASE = "/xps";
    // 宿主按 tab 的 kind 去槽位里查内容体：id / kind / 槽位 key 必须是同一个字符串，
    // 否则标签按钮出现、内容却查不到（表现为空白面板）。
    const TAB_ID = "xps";
    const TAB_KIND = TAB_ID;
    // kind 兼容别名：早期标签实例会把自己的 kind 一起持久化，留一个同套槽位的别名让它自愈。
    // **不给 guide**，否则「+」菜单会多出一个入口。
    const COMPAT_ID = "xps-templates";
    const COMPAT_KIND = COMPAT_ID;
    const TAB_TITLE = "XPS 模板";
    const STYLE_ID = "dsh-xps-peakfit-tab-style";
    const LOG = "[dsh-xps-peakfit]";
    const SERVICES = ["sidebarRightTabs", "sidebarRight"];
    const ZOOM_Z = 2147483000;
    const ZOOM_DELAY = 150;

    const CATEGORIES = [
      ["all", "全部"],
      ["sulfur", "硫化物"],
      ["oxide", "氧化物"],
      ["metal", "金属"],
      ["carbon", "碳"],
      ["custom", "自定义"],
    ];

    const CSS = `
.xpk-wrap{display:flex;flex-direction:column;gap:8px;padding:8px;height:100%;min-height:0;font-size:12px;color:inherit}
.xpk-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.xpk-chip{padding:3px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-color,rgba(128,128,128,.35));background:transparent;color:inherit;font-size:11px;cursor:pointer}
.xpk-chip.on{border-color:var(--dsw-alias-state-business-primary,#3b6ef6);color:var(--dsw-alias-state-business-primary,#3b6ef6)}
.xpk-search{flex:1 1 130px;min-width:0;padding:5px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-color,rgba(128,128,128,.35));background:transparent;color:inherit;font-size:12px}
.xpk-list{flex:1 1 auto;min-height:0;overflow:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:8px;align-content:start}
.xpk-card{position:relative;border:1px solid var(--dsw-alias-border-color,rgba(128,128,128,.3));border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-card,transparent);display:flex;flex-direction:column}
.xpk-card img{display:block;width:100%;height:auto;cursor:zoom-in;background:#fff}
.xpk-card .xpk-name{padding:4px 6px 0;font-weight:600;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.xpk-card .xpk-meta{padding:0 6px 4px;opacity:.7;font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.xpk-card .xpk-acts{display:flex;gap:4px;padding:0 6px 6px;flex-wrap:wrap}
.xpk-btn{padding:2px 6px;border-radius:5px;border:1px solid var(--dsw-alias-border-color,rgba(128,128,128,.35));background:transparent;color:inherit;font-size:10.5px;cursor:pointer}
.xpk-btn:disabled{opacity:.45;cursor:not-allowed}
.xpk-btn.primary{border-color:var(--dsw-alias-state-business-primary,#3b6ef6);color:var(--dsw-alias-state-business-primary,#3b6ef6)}
.xpk-btn.on{border-color:#e0a020;color:#e0a020}
.xpk-empty{grid-column:1/-1;padding:18px 10px;text-align:center;opacity:.7;line-height:1.6}
.xpk-mode{font-size:10.5px;opacity:.75}
.xpk-overlay{position:fixed;inset:0;z-index:${ZOOM_Z};background:rgba(0,0,0,.62);display:flex;align-items:center;justify-content:center;padding:24px}
.xpk-sheet{background:var(--dsw-alias-bg-card,#fff);color:inherit;border-radius:10px;max-width:min(760px,92vw);max-height:82vh;overflow:auto;padding:14px;font-size:12px}
.xpk-sheet pre{white-space:pre-wrap;word-break:break-word;font-size:11px;line-height:1.5;margin:8px 0 0}
`;

    function ensureStyle() {
      if (typeof document === "undefined" || document === null) return;
      if (document.getElementById(STYLE_ID) !== null) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      (document.head ?? document.body)?.appendChild(style);
    }

    async function api(path, options) {
      const response = await fetch(`${BASE}${path}`, {
        headers: { "content-type": "application/json" },
        ...options,
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { status: response.status, ok: response.ok, body };
    }

    /* ───────────────── 悬停放大（原生 div + body，固定定位） ───────────────── */

    function makeZoomLayer() {
      if (typeof document === "undefined" || document.body === null) return null;
      const layer = document.createElement("div");
      layer.setAttribute("data-xpk-zoom", "hover");
      layer.style.cssText = `position:fixed;left:0;top:0;z-index:${ZOOM_Z};pointer-events:none;border-radius:10px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.45);background:#fff;display:none`;
      const img = document.createElement("img");
      img.setAttribute("alt", "");
      img.setAttribute("draggable", "false");
      img.style.cssText = "display:block;width:320px;height:auto";
      layer.appendChild(img);
      document.body.appendChild(layer);
      return { layer, img };
    }

    function placeZoom(layer, x, y, w, h) {
      const margin = 8;
      const vw = typeof window !== "undefined" ? Number(window.innerWidth) || 800 : 800;
      const vh = typeof window !== "undefined" ? Number(window.innerHeight) || 600 : 600;
      let left = x + 16;
      if (left + w + margin > vw) left = x - w - 16;
      if (left < margin) left = margin;
      let top = y - h / 2;
      if (top + h + margin > vh) top = vh - h - margin;
      if (top < margin) top = margin;
      layer.style.left = `${Math.round(left)}px`;
      layer.style.top = `${Math.round(top)}px`;
      layer.style.display = "block";
    }

    /* ───────────────── 面板 ───────────────── */

    function TemplatesPanel() {
      ensureStyle();
      const [state, setState] = useState({ templates: [], favorites: [], mode: "exec", note: null, error: null, loading: true });
      const [query, setQuery] = useState("");
      const [category, setCategory] = useState("all");
      const [busy, setBusy] = useState(false);
      const [sheet, setSheet] = useState(null);
      const fileRef = useRef(null);
      const zoomRef = useRef({ hover: null, timer: 0, at: null });

      const refresh = async () => {
        const result = await api("/templates");
        if (!result.ok || result.body === null) {
          setState((prev) => ({ ...prev, loading: false, error: `读取模板失败（HTTP ${result.status}）` }));
          return;
        }
        setState({
          templates: Array.isArray(result.body.templates) ? result.body.templates : [],
          favorites: Array.isArray(result.body.favorites) ? result.body.favorites : [],
          mode: result.body.mode?.mode ?? "exec",
          note: result.body.mode?.note ?? null,
          error: null,
          loading: false,
        });
      };

      useEffect(() => {
        refresh();
        // 档位可能被 agent/MCP 改掉：切回标签时重读一次真源
        const onFocus = () => refresh();
        if (typeof window !== "undefined") window.addEventListener("focus", onFocus);
        return () => {
          if (typeof window !== "undefined") window.removeEventListener("focus", onFocus);
        };
      }, []);

      // 悬停层收尾：卸载时必须收，否则节点会留在 body 上
      useEffect(() => {
        const onScroll = () => closeHover();
        const onKey = (event) => {
          if (event?.key === "Escape") closeHover();
        };
        const onResize = () => closeHover();
        if (typeof window !== "undefined") {
          window.addEventListener("scroll", onScroll, true);
          window.addEventListener("resize", onResize);
          window.addEventListener("keydown", onKey);
        }
        return () => {
          if (typeof window !== "undefined") {
            window.removeEventListener("scroll", onScroll, true);
            window.removeEventListener("resize", onResize);
            window.removeEventListener("keydown", onKey);
          }
          closeHover();
        };
      }, []);

      const closeHover = () => {
        const ref = zoomRef.current;
        if (ref.timer !== 0) {
          clearTimeout(ref.timer);
          ref.timer = 0;
        }
        const hover = ref.hover;
        ref.hover = null;
        if (hover !== null && hover.layer?.parentNode) hover.layer.parentNode.removeChild(hover.layer);
      };

      const openHover = (id, event) => {
        const ref = zoomRef.current;
        ref.at = { x: Number(event?.clientX) || 0, y: Number(event?.clientY) || 0 };
        if (ref.timer !== 0) clearTimeout(ref.timer);
        ref.timer = setTimeout(() => {
          ref.timer = 0;
          const made = makeZoomLayer();
          if (made === null) return;
          made.img.src = `${BASE}/thumb/${encodeURIComponent(id)}`;
          ref.hover = made;
          placeZoom(made.layer, ref.at.x, ref.at.y, 320, 200);
        }, ZOOM_DELAY);
      };

      const isTeach = state.mode === "teach";
      const visible = state.templates.filter((t) => {
        if (category !== "all" && String(t.category ?? "").toLowerCase() !== category) return false;
        const q = query.trim().toLowerCase();
        if (q === "") return true;
        return [t.name, t.element, t.orbital, t.category, t.note].some((v) => String(v ?? "").toLowerCase().includes(q));
      });

      const upload = async (file) => {
        if (!file) return;
        if (!/\.json$/i.test(file.name)) {
          setState((prev) => ({ ...prev, error: "只接受 .json 模板文件" }));
          return;
        }
        setBusy(true);
        try {
          const text = await file.text();
          const response = await fetch(`${BASE}/templates?filename=${encodeURIComponent(file.name)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: text,
          });
          const body = await response.json().catch(() => null);
          if (!response.ok || body?.ok !== true) {
            setState((prev) => ({ ...prev, error: `上传被拒：${(body?.errors ?? [body?.message ?? `HTTP ${response.status}`]).join("；")}` }));
          } else {
            setState((prev) => ({ ...prev, error: null }));
            await refresh();
          }
        } finally {
          setBusy(false);
        }
      };

      const rename = async (template) => {
        const next = typeof window !== "undefined" ? window.prompt("新名称", template.name) : null;
        if (next === null || next.trim() === "" || next.trim() === template.name) return;
        const result = await api(`/templates/${encodeURIComponent(template.id)}/rename`, { method: "POST", body: JSON.stringify({ name: next }) });
        if (!result.ok) setState((prev) => ({ ...prev, error: `改名失败（HTTP ${result.status}）` }));
        else await refresh();
      };

      const remove = async (template) => {
        const yes = typeof window !== "undefined" ? window.confirm(`删除模板「${template.name}」？`) : false;
        if (!yes) return;
        const result = await api(`/templates/${encodeURIComponent(template.id)}`, { method: "DELETE" });
        if (!result.ok) setState((prev) => ({ ...prev, error: `删除失败（HTTP ${result.status}）` }));
        else await refresh();
      };

      const toggleFav = async (template) => {
        const has = state.favorites.includes(template.id);
        const next = has ? state.favorites.filter((id) => id !== template.id) : [...state.favorites, template.id];
        const result = await api("/favorites", { method: "POST", body: JSON.stringify({ favorites: next }) });
        if (result.ok) await refresh();
      };

      const use = async (template) => {
        const result = await api(`/templates/${encodeURIComponent(template.id)}/use`, { method: "POST", body: "{}" });
        if (result.status === 403) {
          setSheet({ title: "教学模式下不代执行", text: result.body?.message ?? "教学模式下不代执行" });
          return;
        }
        if (!result.ok) {
          setState((prev) => ({ ...prev, error: `生成指令失败（HTTP ${result.status}）` }));
          return;
        }
        setSheet({ title: `指令：${template.name}`, text: JSON.stringify(result.body.instruction, null, 1) });
      };

      const header = jsx("div", { className: "xpk-bar" }, [
        jsx("input", {
          key: "q",
          className: "xpk-search",
          type: "search",
          placeholder: "搜索模板…",
          value: query,
          onChange: (event) => setQuery(event.target.value),
        }),
        jsx("button", { key: "up", className: "xpk-btn primary", disabled: busy, onClick: () => fileRef.current?.click() }, busy ? "上传中…" : "上传"),
        jsx("input", {
          key: "f",
          ref: fileRef,
          type: "file",
          accept: ".json",
          style: { display: "none" },
          onChange: (event) => {
            upload(event.target.files?.[0]);
            event.target.value = "";
          },
        }),
      ]);

      const chips = jsx(
        "div",
        { className: "xpk-bar" },
        CATEGORIES.map(([key, label]) =>
          jsx("button", { key, className: `xpk-chip${category === key ? " on" : ""}`, onClick: () => setCategory(key) }, label),
        ),
      );

      const cards = visible.map((template) =>
        jsx("div", { key: template.id, className: "xpk-card", "data-template-id": template.id }, [
          jsx("img", {
            key: "img",
            src: `${BASE}/thumb/${encodeURIComponent(template.id)}`,
            alt: template.name,
            onMouseEnter: (event) => openHover(template.id, event),
            onMouseMove: (event) => {
              zoomRef.current.at = { x: Number(event.clientX) || 0, y: Number(event.clientY) || 0 };
              const hover = zoomRef.current.hover;
              if (hover !== null) placeZoom(hover.layer, zoomRef.current.at.x, zoomRef.current.at.y, 320, 200);
            },
            onMouseLeave: () => closeHover(),
          }),
          jsx("div", { key: "n", className: "xpk-name", title: template.name }, template.name),
          jsx(
            "div",
            { key: "m", className: "xpk-meta" },
            [template.element, template.orbital, template.doublet_delta_ev ? `Δ${template.doublet_delta_ev}` : null, template.background]
              .filter(Boolean)
              .join(" · "),
          ),
          jsx("div", { key: "a", className: "xpk-acts" }, [
            jsx(
              "button",
              {
                key: "use",
                className: "xpk-btn primary",
                disabled: isTeach,
                title: isTeach ? "教学模式下不代执行" : "生成调用指令（由 agent 执行）",
                onClick: () => use(template),
              },
              "用这个",
            ),
            jsx(
              "button",
              { key: "fav", className: `xpk-btn${state.favorites.includes(template.id) ? " on" : ""}`, onClick: () => toggleFav(template) },
              state.favorites.includes(template.id) ? "★" : "☆",
            ),
            jsx("button", { key: "rn", className: "xpk-btn", onClick: () => rename(template) }, "改名"),
            jsx("button", { key: "rm", className: "xpk-btn", onClick: () => remove(template) }, "删除"),
          ]),
        ]),
      );

      const body = state.loading
        ? jsx("div", { className: "xpk-empty" }, "读取中…")
        : cards.length > 0
          ? cards
          : jsx("div", { className: "xpk-empty" }, state.templates.length === 0 ? "还没有模板，上传一个 JSON 预设或从零新建" : "没有匹配的模板");

      return jsx("div", { className: "xpk-wrap" }, [
        jsx(
          "div",
          { key: "mode", className: "xpk-mode" },
          `档位：${isTeach ? "教学模式（只读）" : "代执行"}${state.note ? ` —— ${state.note}` : ""}`,
        ),
        header,
        chips,
        state.error !== null ? jsx("div", { key: "err", className: "xpk-mode" }, `⚠ ${state.error}`) : null,
        jsx("div", { key: "list", className: "xpk-list" }, body),
        sheet === null
          ? null
          : jsx("div", { key: "sheet", className: "xpk-overlay", onClick: () => setSheet(null) }, [
              jsx("div", { className: "xpk-sheet", onClick: (event) => event.stopPropagation() }, [
                jsx("div", { key: "t", style: { fontWeight: 600 } }, sheet.title),
                jsx("pre", { key: "b" }, sheet.text),
                jsx("div", { key: "c", style: { marginTop: 10, display: "flex", gap: 6 } }, [
                  jsx(
                    "button",
                    {
                      key: "copy",
                      className: "xpk-btn",
                      onClick: () => {
                        try {
                          navigator.clipboard?.writeText(sheet.text);
                        } catch {
                          /* 复制失败不影响展示 */
                        }
                      },
                    },
                    "复制",
                  ),
                  jsx("button", { key: "close", className: "xpk-btn", onClick: () => setSheet(null) }, "关闭"),
                ]),
              ]),
            ]),
      ]);
    }

    function PanelTitle() {
      return jsx("span", null, TAB_TITLE);
    }

    /* ───────────────── 注册 ───────────────── */

    function disposerOf(value) {
      if (typeof value === "function") return value;
      if (value !== null && typeof value === "object" && typeof value.dispose === "function") return () => value.dispose();
      return null;
    }

    function apply(ctx) {
      try {
        return applyInner(ctx);
      } catch (error) {
        console.warn(`${LOG} apply 异常：`, error);
        return () => {};
      }
    }

    function applyInner(ctx) {
      if (ctx === undefined || ctx === null || typeof ctx.inject !== "function") {
        console.warn(`${LOG} ctx.inject 不可用，模板标签未注册`);
        return;
      }
      let seat = null;
      try {
        seat = ctx.inject(SERVICES, (injected) => {
          const tabs = typeof injected?.get === "function" ? injected.get("sidebarRightTabs") : undefined;
          if (tabs === undefined || tabs === null || typeof tabs.register !== "function") {
            console.warn(`${LOG} 宿主没有 sidebarRightTabs.register，模板标签未注册`);
            return;
          }
          const disposers = [];
          let registered = 0;
          const specs = [
            { id: TAB_ID, kind: TAB_KIND, guide: [{ order: 44, title: () => TAB_TITLE }] },
            { id: COMPAT_ID, kind: COMPAT_KIND, guide: null },
          ];
          for (const spec of specs) {
            let result;
            try {
              result = tabs.register({
                id: spec.id,
                kind: spec.kind,
                priority: "extension",
                title: () => TAB_TITLE,
                ...(spec.guide === null ? {} : { guide: spec.guide }),
              });
            } catch (error) {
              console.warn(`${LOG} 注册 tab type 失败（${spec.id}）：`, error);
              continue;
            }
            const disposer = disposerOf(result);
            if (disposer !== null) disposers.push(disposer);
            registered += 1;
          }
          if (registered === 0) return;
          const slots = ctx.slots;
          if (slots === undefined || slots === null || typeof slots.inject !== "function") {
            console.warn(`${LOG} ctx.slots 不可用，标签体未注册`);
            return;
          }
          const seatSpecs = [
            ["sidebar.right.pane.tab", TemplatesPanel],
            ["sidebar.right.pane.tab.title", PanelTitle],
          ];
          for (const key of [TAB_ID, COMPAT_ID]) {
            for (const [name, component] of seatSpecs) {
              disposers.push(
                slots.inject(name, () => {
                  let handle;
                  try {
                    handle = slots.register({ name, key, inject: () => ({}) }, component);
                  } catch (error) {
                    console.warn(`${LOG} 注册槽位失败（${name}/${key}）：`, error);
                    throw error;
                  }
                  const dispose = disposerOf(handle);
                  return dispose === null ? undefined : dispose;
                }),
              );
            }
          }
          return () => {
            for (const dispose of disposers.reverse()) {
              try {
                dispose();
              } catch {
                /* 卸载阶段异常不往上抛 */
              }
            }
          };
        });
      } catch (error) {
        console.warn(`${LOG} 等待 sidebarRightTabs 失败：`, error);
      }
      return () => {
        try {
          seat?.dispose?.();
        } catch {
          /* 同上 */
        }
      };
    }

    exports.apply = apply;
    exports.inject = ["slots", "sidebarRightTabs", "sidebarRight"];
    exports.TemplatesPanel = TemplatesPanel;
    exports.PanelTitle = PanelTitle;
    exports.TAB_ID = TAB_ID;
    exports.TAB_KIND = TAB_KIND;
    exports.COMPAT_ID = COMPAT_ID;
    exports.COMPAT_KIND = COMPAT_KIND;
    exports.TAB_TITLE = TAB_TITLE;
    exports.BASE = BASE;
    exports.SERVICES = SERVICES;
    return module.exports;
  },
});
