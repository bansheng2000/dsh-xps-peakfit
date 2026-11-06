# -*- coding: utf-8 -*-
"""XPSPeak 4.1 的 MCP server（stdio，换行分隔 JSON-RPC，纯标准库）。

把 xpspeak_drive.py 的消息级驱动包成 MCP 工具，任何 MCP 客户端（DSH / Claude Code / ...）
都能像调用别的 MCP 工具一样驱动 XPSPeak 分峰。

自检（会真的开一次 XPSPeak、导出一次 ASCII，约 20s）:
  python xpspeak_mcp.py --selftest

手工联调:
  echo {"jsonrpc":"2.0","id":1,"method":"tools/list"} | python xpspeak_mcp.py

注意: 本进程只许往 stdout 写协议行，工具里的任何 print 都重定向到 stderr。
"""
import contextlib, ctypes, ctypes.wintypes, json, os, re, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import xpspeak_drive as D
import xps_fit as F          # 带约束拟合（纯 Python，不需要 GUI，见 xps_fit.py 顶部说明）

EXE = os.environ.get("XPSPEAK_EXE", D.EXE_DEFAULT)
PROTO = "2024-11-05"
S = {"type": "string"}


def _pid_of(h):
    p = ctypes.wintypes.DWORD()
    D.u.GetWindowThreadProcessId(h, ctypes.byref(p))
    return p.value


class TeachingMode(Exception):
    """教学模式：拒绝任何会改变界面的调用（见 SKILL.md「两档模式」）。

    它继承 Exception 而不是返回普通文本，是为了让客户端看到 isError —— 拒绝不能被读成成功。
    """


# 会改变界面的工具（点按钮 / 发菜单 / 开存文件 / 关进程 / 跑整条流水线）。
# xpspeak_status（读窗口与菜单）、xpspeak_fit（纯计算，不碰 GUI）不是写操作，教学模式照常可用。
MUTATING = {"xpspeak_open", "xpspeak_export", "xpspeak_save", "xpspeak_menu",
            "xpspeak_click", "xpspeak_close", "xpspeak_build"}
# 档位真源是 mode.json（侧栏与 MCP 读同一份），每次调用都重读，改完立刻生效。
# 顺序：文件存在且合法 → 用它；文件不存在 → XPSPEAK_MODE；坏文件/读写异常 → teach（fail-closed，绝不静默当 exec）。
STATE = {"owned": False, "mode": "exec", "mode_note": None}


def _mode_path():
    p = os.environ.get("XPSPEAK_MODE_FILE")
    if p:
        return p
    home = os.environ.get("DSH_HOME") or os.path.join(os.path.expanduser("~"), ".dsh")
    return os.path.join(home, "dsh-xps-peakfit", "mode.json")


def _env_mode():
    return "teach" if os.environ.get("XPSPEAK_MODE", "").strip().lower().startswith("teach") else "exec"


def load_mode():
    """读档位，返回 (mode, note)。note 非空 = 为什么按 teach 处理（原样写给用户看）。"""
    path = _mode_path()
    if not os.path.exists(path):
        return _env_mode(), None
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.loads(fh.read())
    except Exception as e:
        return "teach", "mode.json 损坏（%s: %s），已按教学模式处理：%s" % (type(e).__name__, e, path)
    mode = str(data.get("mode", "")).strip().lower() if isinstance(data, dict) else ""
    if mode not in ("teach", "exec"):
        return "teach", "mode.json 损坏（mode 不是 teach/exec，而是 %r），已按教学模式处理：%s" % (
            data.get("mode") if isinstance(data, dict) else data, path)
    return mode, None


def save_mode(mode, source="tool"):
    """落盘。写不进去返回错误说明，调用方如实报，不假装成功。"""
    path = _mode_path()
    try:
        d = os.path.dirname(path)
        if d:
            os.makedirs(d, exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"mode": mode, "updatedAt": int(time.time() * 1000), "source": source},
                      fh, ensure_ascii=False)
        os.replace(tmp, path)
        return None
    except Exception as e:
        return "写 mode.json 失败（%s: %s）：%s" % (type(e).__name__, e, path)


def _refresh_mode():
    STATE["mode"], STATE["mode_note"] = load_mode()


def _manual_hint(name, a):
    """把被拒绝的那次调用翻成一句「你自己该怎么点」，拒绝才不是一句空话。"""
    if name == "xpspeak_open":
        return "请你自己在 XPS Peak Processing 窗口点「Open XPS」（或 Data > Import (ASCII)）打开 %s" % a.get("path")
    if name == "xpspeak_click":
        where = "XPS Peak Processing 窗口" if a.get("form", "processing") == "processing" else "分峰窗（标题会随区域改名，就是带菜单那个）"
        return "请在 %s 里自己点「%s」按钮" % (where, a.get("caption"))
    if name == "xpspeak_menu":
        return "请你自己走菜单：%s%s" % (a.get("top"), (" > " + a["sub"]) if a.get("sub") else "")
    if name == "xpspeak_export":
        kind = "Export (Spectrum)" if a.get("what", "spectrum") == "spectrum" else "Export (Peak Parameters)"
        return "请你自己走 Data > %s，存到 %s" % (kind, a.get("path"))
    if name == "xpspeak_save":
        return "请你自己点 %s" % ("Save XPS（Processing 窗口）" if a.get("what", "xps") == "xps"
                                else "Parameters > Save Region Parameters")
    if name == "xpspeak_close":
        return "请你自己关掉 XPSPeak 窗口（我不替你关）"
    if name == "xpspeak_build":
        return ("这一步是整条流水线（载谱 → 扣背景 → 逐个 Add Peak → 导出 → Save XPS），"
                "教学模式要一步一步自己来；想让我一次做完就说「你来吧」")
    return ""


def _refuse_in_teach(name, a):
    why = ""
    if STATE.get("mode_note"):
        why = "\n（档位取自 %s：%s）" % (_mode_path(), STATE["mode_note"])
    raise TeachingMode(
        "教学模式：不替你点按钮 —— 这一步请你操作。\n%s%s\n"
        "（只读调用照常可用：xpspeak_status 看窗口/菜单/当前值，xpspeak_fit 做数值拟合。"
        "要我代做就说「你来吧」，我会先复述授权范围再动手。）" % (_manual_hint(name, a) or "（未知调用）", why))


def find_pid():
    """找已在运行的 XPSPeak（不管是本 server 还是用户手动启动的）；没有返回 None。

    按**进程名**筛，而不是「拿枚举到的第一个 VB6 窗体」：机器上还有别的 VB6 程序时，
    旧的写法会把 pid 认成别人，后面 xpspeak_close 就跟着杀错进程。
    """
    seen = []

    def cb(h, l):
        if D.cls(h) == "ThunderRT6FormDC":
            pid = _pid_of(h)
            if pid and pid not in seen:
                name = D.proc_name(pid)          # 查不到（权限不足）时只能放行，close 前会再校验一次
                if name is None or name.upper() == "XPSPEAK41.EXE":
                    seen.append(pid)
        return True

    D.u.EnumWindows(D.CB(cb), 0)
    return seen[0] if seen else None


def _require_forms(pid):
    """窗体必须真的就绪；缺哪个就报哪个，不要返回 None 让调用方在后面超时。"""
    proc, fit = D.form(pid, D.FORM_PROC), D.menu_form(pid)
    if not (proc and fit):
        miss = [n for n, h in ((D.FORM_PROC, proc), ("带菜单的分峰窗", fit)) if not h]
        raise RuntimeError("XPSPeak 窗体没就绪（pid=%s，缺 %s）—— 程序可能还在启动，"
                           "或弹了没点掉的错误框" % (pid, " / ".join(miss)))
    return proc, fit


def app(launch=True):
    """确保程序在跑**且两个窗体都在**，返回 (pid, proc_form, fit_form)。

    慢机器上「进程出现」≠「窗体可用」：原实现等到任意一个 VB6 窗体就返回，pid 里拿到 None，
    接着要么静默取不到按钮、要么 15 秒超时收场。
    """
    pid = find_pid()
    if pid is None:
        if not launch:
            raise RuntimeError("XPSPeak 未运行")
        D.launch(EXE)
        STATE["owned"] = True
        t0 = time.time()
        while time.time() - t0 < 30:
            pid = find_pid()
            if pid and D.form(pid, D.FORM_PROC) and D.menu_form(pid):
                break
            time.sleep(0.5)
        if pid is None:
            raise RuntimeError("启动后 30 秒仍找不到 XPSPeak 窗体（%s）" % EXE)
    return (pid,) + _require_forms(pid)


def do_status(mode=None):
    persist = None
    if mode:
        m = str(mode).strip().lower()
        if m not in ("teach", "exec"):
            raise ValueError("mode 只支持 teach（教学模式）/ exec（代执行），收到 %r" % (mode,))
        STATE["mode"], STATE["mode_note"] = m, None
        persist = save_mode(m, "tool")      # 落盘后侧栏下次读到的就是新档位
    pid, proc, fit = app()
    out = ["pid=%s" % pid,
           "XPS Peak Processing = %s" % (hex(proc) if proc else "无"),
           "XPS Peak Fit        = %s" % (hex(fit) if fit else "无")]
    out.append("模式: %s" % ("教学模式（只读：会改界面的调用一律拒绝，由你自己点）"
                            if STATE["mode"] == "teach"
                            else "代执行（在授权范围内一次做完；扩大范围前先问）"))
    out.append("档位文件: %s%s" % (_mode_path(), "" if os.path.exists(_mode_path()) else "（不存在，按 env/默认）"))
    if STATE.get("mode_note"):
        out.append("注意: " + STATE["mode_note"])
    if persist:
        out.append("注意: " + persist)
    if proc:
        btns = [D.text(c) for c in D.kids(proc)
                if D.cls(c).startswith("ThunderRT6CommandButton") and D.text(c)]
        out.append("按钮: " + " | ".join(dict.fromkeys(btns)))
    if fit:
        for name, items in D.menu_tree(fit):
            out.append("菜单 %s: %s" % (name, " / ".join(items) or "(无子项)"))
    out.append("来源: %s" % ("本次启动" if STATE["owned"] else "接管已有实例"))
    return "\n".join(out)


def _import_failed(pid):
    """XPSPeak 导入失败会弹 #32770 'XPSPEAK41' + Static "Error Reading File"（SKILL.md 陷阱 11）。
    必须**先认出它再点掉** —— 否则 _kill_strays 会顺手关掉，失败就被读成成功。"""
    return [h for h in D.dialogs(pid) if D.has_text(h, "Error Reading File")]


def _count_points(pid, fit):
    """弱确认：导出一次谱图数数据行。返回 (点数|None, 说明)。

    导出本身可能不可用，所以失败不 hard-fail；但一定写进返回文本，
    不让「已载入」变成一句没验证的空话。
    """
    tmp = D.work_path("probe.dat")
    try:
        D.menu_click(fit, "Data", "Export (Spectrum)", settle=1.0)
        D.file_dialog(pid, D.DLG_SAVE, tmp)
        time.sleep(0.5)
        D._kill_strays(pid)
        n = 0
        with open(tmp, encoding="utf-8", errors="replace") as f:
            for ln in f:
                t = ln.split()
                if len(t) >= 2:
                    try:
                        float(t[0]); float(t[1]); n += 1
                    except ValueError:
                        pass
        return (n or None), ("%d 点" % n if n else "0 数据行")
    except Exception as e:
        return None, "%s: %s" % (type(e).__name__, e)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def do_open(path, source="auto"):
    path = os.path.normpath(path)          # 必须反斜杠：正斜杠会被文件对话框拒绝
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    kind = source if source != "auto" else ("xps" if path.lower().endswith((".xps", ".rpa")) else "ascii")
    pid, proc, fit = app()
    note = ""
    if kind == "ascii":
        fixed = D.ascii_crlf(path)      # LF-only 会被 XPSPeak 静默读错（点数减半、轴值错位）
        if fixed != path:
            note = "（原文行尾不规范（LF 或 \\r\\r\\n），已自动改用 CRLF 副本 %s）" % fixed
        D.menu_click(fit, "Data", "Import (ASCII)")
        D.file_dialog(pid, D.DLG_IMPORT, fixed)
    else:
        D.click(D.button(proc, "Open XPS"))
        D.file_dialog(pid, D.DLG_OPEN, path)
    bad = _import_failed(pid)
    if bad:
        titles = [D.text(h) or D.cls(h) for h in bad]
        killed = D._kill_strays(pid)     # 先把框点掉，否则后面的调用全无响应
        raise RuntimeError("XPSPeak 拒绝了这个谱（对话框 %s，已关掉 %s）：%s —— 常见原因是"
                           "ASCII 列数/行尾不对、不是两列数值表、或 .xps 损坏"
                           % (titles, killed or "无", path))
    killed = D._kill_strays(pid)
    fit = D.menu_form(pid) or fit
    n, how = _count_points(pid, fit)
    if n is None:
        return "已载入 %s（%s）%s；但点数确认失败：%s" % (path, kind, note, how)
    if n < 10:
        raise RuntimeError("已载入 %s，但谱图只有 %d 点 —— 基本可以断定没读进来（查列数与行尾）"
                           % (path, n))
    return "已载入 %s（%s）%s；确认载入 %s%s" % (
        path, kind, note, how,
        ("（顺手关掉消息框: %s）" % " / ".join(killed)) if killed else "")


def do_export(path, what="spectrum"):
    path = os.path.normpath(path)
    pid, proc, fit = app()
    if os.path.exists(path):
        os.remove(path)
    D.menu_click(fit, "Data", "Export (Spectrum)" if what == "spectrum" else "Export (Peak Parameters)")
    # Spectrum 的对话框标题已知；Peak Parameters 的标题未知 -> 传 None 自动挑带 Edit 的对话框
    D.file_dialog(pid, D.DLG_SAVE if what == "spectrum" else None, path)
    time.sleep(0.5)
    D._kill_strays(pid)                    # "Data file exported" 模态框
    if not os.path.exists(path):
        raise RuntimeError("对话框已关闭但没写出文件: %s" % path)
    with open(path, encoding="utf-8", errors="replace") as f:
        head = f.read(400)
    return "已导出 %s（%d 字节）\n--- 前几行 ---\n%s" % (path, os.path.getsize(path), head)


def do_save(path, what="xps"):
    """保存当前状态。what=xps = Processing 窗 Save XPS（谱图+背景+已定峰参数，能被 xpspeak_open 载回）；
    what=rpa = Parameters > Save Region Parameters（只存区域峰参数，可 Load 到别的谱上套用）。"""
    path = os.path.normpath(path)          # 必须反斜杠，同 do_export
    pid, proc, fit = app()
    if os.path.exists(path):
        os.remove(path)
    if what == "xps":
        btn = D.button(proc, "Save XPS")
        if not btn:
            raise RuntimeError("找不到 Save XPS 按钮")
        D.click(btn)
        D.file_dialog(pid, D.DLG_OPEN, path)     # 坑：这个保存框标题就是 "Open file"
    elif what == "rpa":
        D.menu_click(fit, "Parameters", "Save Region Parameters")
        D.file_dialog(pid, D.DLG_SAVE_RPA, path)
    else:
        raise ValueError("what 只支持 xps / rpa")
    time.sleep(0.3)
    D._kill_strays(pid)
    if not os.path.exists(path):
        raise RuntimeError("对话框已关闭但没写出文件: %s" % path)
    with open(path, "rb") as f:
        head = f.read(24)
    return "已保存 %s（%d 字节，文件头 %r）" % (path, os.path.getsize(path), head)


def _parse_eta(v, nc=None):
    """eta 支持 number / 逗号串 / 数组；逐峰时个数必须等于峰数。"""
    if isinstance(v, str):
        parts = [x.strip() for x in v.replace(",", " ").split() if x.strip()]
        v = [float(x) for x in parts] if len(parts) > 1 else float(parts[0])
    if isinstance(v, (list, tuple)):
        out = [float(x) for x in v]
        if nc is not None and len(out) != nc:
            raise ValueError("eta 序列长度 %d != 峰数 %d" % (len(out), nc))
        return out
    return float(v)


def do_fit(a):
    """一次调用完成「拟合 -> 参数±σ -> 优度 -> 可选曲线 CSV」，不启动 GUI。

    XPSPeak 的 Optimise 是无约束优化（实测会把 2p1/2 压成面积 1/6，物理上错误），
    所以「要可发表的结果」必须走这里；GUI 只用于人工看/交付 .xps。"""
    win = a.get("window") or []
    lo = hi = None
    if win:
        if len(win) != 2:
            raise ValueError("window 必须是 [lo, hi] 两个值（eV），收到 %r" % (win,))
        lo, hi = float(win[0]), float(win[1])
    centers = [float(c) for c in a["centers"]]
    eta = _parse_eta(a.get("eta", 0.3), len(centers))
    res = F.run(a["path"], centers, a.get("bg", "file"),
                int(a.get("bg_col", 4)), float(a.get("ds", 1.18)),
                float(a.get("ratio", 0.5)), eta,
                a.get("csv"), int(a.get("scan", 0)),
                float(a.get("ctol", 1.0)), float(a.get("wlo", 0.6)),
                float(a.get("whi", 4.0)), float(a.get("hmax", 120000.0)),
                lo=lo, hi=hi)
    txt = F.report(res, head="文件: %s" % a["path"], include_bounds=False, include_warnings=False)
    pre = [t for t in (F.bound_text(res), "\n".join(res.get("warnings") or [])) if t]
    if pre:                         # 撞界 / 约束不匹配都置顶，别埋进正文让模型漏读
        txt = "\n".join(pre) + "\n" + txt
    pf = F.preflight(res, E=res["curves"]["E"], bg_used=a.get("bg", "file"),
                     expect_bg=a.get("expect_bg"))
    res["preflight"] = pf
    if pf["errors"]:
        txt = F.preflight_text(pf) + "\n⛔ 已阻断保存：不要调用 xpspeak_build / xpspeak_save。\n" + txt
    elif pf["warnings"]:
        txt = F.preflight_text(pf) + "\n" + txt
    for k in sorted(k for k in res if k.startswith("scan")):
        s = res[k]
        txt += "\n  对照 %s 条双线: rms=%.1f  AIC=%.1f  R²=%.6f%s" % (
            s["nc"], s["rms"], s["aic"], s["r2"],
            ("  ⚠ 撞界 %d 项" % len(s.get("bound") or [])) if s.get("bound") else "")
    if a.get("csv"):
        txt += "\n曲线已写入: %s" % a["csv"]
    return txt


def _spec_areas(path):
    """从导出的谱图里量出每条分峰的面积（梯形积分 (Peak_i - Background)），返回 (面积列表, 列判定说明)。

    列不能按「第 5 列起全是峰」数：导出表头最后一列是 difference（残差），它的积分会被当成一个"峰"，
    当前只是因为在 len(peaks) 以内取用才恰好没出错。按表头 `Peak N` 认峰列并显式跳过 difference；
    没有表头（第一行就是数字）时才退回列序兜底，并把「按列序兜底」写进说明。
    """
    with open(path, encoding="utf-8", errors="replace") as f:
        lines = f.read().splitlines()
    if not lines:
        return [], "空文件"
    head, data, note0 = "", lines, ""
    try:
        float(lines[0].split()[0])
        note0 = "无表头，按列序兜底"
    except (ValueError, IndexError):
        head, data = lines[0], lines[1:]
    rows = []
    for ln in data:
        t = ln.split()
        if len(t) >= 5:
            try:
                rows.append([float(v) for v in t])
            except ValueError:
                pass
    if len(rows) < 3:
        return [], "数据行不足 3 行"
    rows.sort(key=lambda r: -r[0])
    ncol = min(len(r) for r in rows)
    peaks = re.findall(r"Peak\s+(\d+)", head, re.I)
    if peaks:
        cols = list(range(4, min(4 + len(peaks), ncol)))      # B.E./Raw/Peak Sum/Background 之后
        note = "表头认出 %d 条峰列（difference 列已排除）" % len(cols)
    else:
        cols = list(range(4, ncol))
        if "difference" in head.lower() and cols:
            cols = cols[:-1]
            note = note0 + "（末列 difference 已跳过）"
        else:
            note = note0 or "按列序兜底"
    out = [0.0] * len(cols)
    for i in range(len(rows) - 1):
        a, b = rows[i], rows[i + 1]
        step = abs(a[0] - b[0])
        for k, j in enumerate(cols):
            if j >= len(b):
                break
            out[k] += (a[j] - a[3] + b[j] - b[3]) / 2.0 * step
    return out, note


def build_guard(peaks, expect_bg=None, actual_bg=None, wlo=None, whi=None):
    """保存前的硬前置（纯函数，便于单测）：不满足就抛 ValueError，调用方据此**不落盘**。

    两条：
      1. 背景不一致：`background` 字段只影响拟合，不改变保存文件里的背景，两者对不上时
         结论与图不是同一件事（tougaard 不在 xps_fit 支持内，按 file 处理并允许）。
      2. 撞界：峰 FWHM 正好顶在 wlo/whi 上时，这个值是约束决定的、不是拟合出来的。
    """
    if expect_bg and actual_bg and expect_bg != actual_bg:
        if not (expect_bg == "tougaard" and actual_bg == "file"):
            raise ValueError("⛔ 背景不一致：模板要求 %s，实际用的是 %s —— background 字段只管拟合，"
                             "不改变保存文件里的背景。先在软件里按模板扣好背景再重跑。" % (expect_bg, actual_bg))
    for i, pk in enumerate(peaks):
        fw = float(pk["fwhm"])
        for lim, name in ((wlo, "wlo"), (whi, "whi")):
            if lim is not None and abs(fw - float(lim)) <= 1e-6:
                raise ValueError("⛔ 撞界：峰%d 的 FWHM=%g 正好顶在 %s=%g 上，这个值是约束决定的、"
                                 "不是拟合出来的。先改初值 / 放宽 ctol 或 wlo/whi 后重跑，本次不落盘。"
                                 % (i + 1, fw, name, float(lim)))
    return True


def _edge_warnings(path, peaks, ratio=3.0):
    """峰心距谱两端 < ratio×FWHM → 尾部被截断，面积只是当前窗口的积分。"""
    try:
        E, _raw, _bg, _n = F.load(path)
    except Exception:
        return []
    if not E:
        return []
    lo, hi = min(E), max(E)
    out = []
    for i, pk in enumerate(peaks):
        fw = float(pk["fwhm"])
        if fw <= 0:
            continue
        near = min(abs(float(pk["pos"]) - lo), abs(hi - float(pk["pos"])))
        if near < ratio * fw:
            out.append("⚠ 峰%d（%.3f eV）距谱端不到 %.0f×FWHM（实测 %.2f×）：尾部被截断，面积只按当前窗口积分。"
                       % (i + 1, float(pk["pos"]), ratio, near / fw))
    return out


def _bg_guard_spec(spec):
    """linear 模板的收尾核对：导出谱里的 Background 列必须真是一条直线。

    拟合与报告用的是直线背景，但 XPSPeak 保存/建区域可能沿用源谱自带背景 ——
    实测那份 .xps 的背景是台阶（857.0 偏 +2567、851.0 偏 −2872 = 峰高 10.9%），
    图上是直线、文件里是台阶，别人重开会得到不同数字。容差 0.5% 峰高。
    返回 None 表示没有可核的背景列。
    """
    E, raw, bg, _ncol = F.load(spec)
    if not bg:
        return None
    height = max(raw[i] - bg[i] for i in range(len(raw)))
    bs = F.bg_shape_check(bg, height)
    if not bs.get("ok"):
        raise ValueError("⛔ 背景形状不符：模板是 linear，但导出谱的 Background 列偏离两端直线 %.0f cps"
                         "（= 峰高 %.1f%%，容差 %.2f%%）—— 文件里的背景不是拟合用的那条直线。"
                         "先在软件里重扣直线背景再 build。"
                         % (bs["max_dev"], bs["pct_of_height"] or 0.0, 100.0 * F.BG_SHAPE_TOL))
    return bs


# ── 背景口径：拟合区 Shirley ≠ 全谱 Shirley ───────────────────────────────
# 实测反例（2026-11-06，ni2p_cc.dat 401 点 844.8–884.8）：xps_fit 只在拟合窗口
# 845.68–866.9 内取 Shirley 端点，XPSPeak 建区却按整条谱算 —— 窗口内平均低 866 cps，
# 于是同一组峰参数直接 fit 的 R²=0.9923，经 build 建区后审计只剩 0.9682，残差四段
# 全正（+1037/+1227/+883/+58）。容差取平均差 ≤0.5% 扣背景峰高，并留 20 cps 绝对下限
# （低计数谱的百分比会把噪声放大）。
BG_SCOPE_TOL = 0.005
BG_SCOPE_FLOOR = 20.0


def _window_indices(E, window):
    lo, hi = min(window), max(window)
    idx = [i for i, v in enumerate(E) if lo - 1e-9 <= v <= hi + 1e-9]
    if len(idx) < 8:
        raise ValueError("拟合窗口 [%g, %g] eV 内只有 %d 点（<8）：无法核对背景" % (lo, hi, len(idx)))
    return idx, lo, hi


def bg_scope_check(path, window):
    """全谱 Shirley 与窗口 Shirley 在拟合区内的逐点差（模型谱侧）。

    XPSPeak 建区按整条谱算背景，xps_fit 只按拟合窗口算；两者在这段里的平均差就是
    Peak Sum 的系统性偏差。返回 {ok, mean_diff, max_abs_diff, pct_of_height, height,
    points, window}；ok=False 表示必须先把谱裁到拟合窗口（或改口径）再建区。
    """
    E, raw, _bg, _ncol = F.load(path, bg_col=0)
    idx, lo, hi = _window_indices(E, window)
    Ew = [E[i] for i in idx]
    rw = [raw[i] for i in idx]
    full = F.shirley_bg(E, raw)
    win = F.shirley_bg(Ew, rw)
    diffs = [full[idx[j]] - win[j] for j in range(len(idx))]   # 全谱背景 − 拟合区背景（负=文件里更低）
    mean_d = sum(diffs) / float(len(diffs))
    max_d = max(abs(d) for d in diffs)
    height = max(rw[j] - win[j] for j in range(len(idx)))
    pct = (abs(mean_d) / height) if height > 0 else 0.0
    ok = (pct <= BG_SCOPE_TOL) or (abs(mean_d) <= BG_SCOPE_FLOOR)
    return {"ok": ok, "mean_diff": mean_d, "max_abs_diff": max_d,
            "pct_of_height": pct, "height": height, "points": len(idx),
            "window": [lo, hi]}


def crop_to_window(path, window, dest):
    """把谱裁到拟合窗口，写成两列 ASCII（BE 降序），供 XPSPeak 建区用。"""
    E, raw, _bg, _ncol = F.load(path, bg_col=0)
    idx, lo, hi = _window_indices(E, window)
    with open(dest, "w", encoding="ascii", newline="\n") as fh:
        for i in idx:
            fh.write("%.4f %.6f\n" % (E[i], raw[i]))
    return {"used": os.path.normpath(dest), "kept": len(idx),
            "removed": len(E) - len(idx), "from_points": len(E),
            "range_ev": [E[idx[-1]], E[idx[0]]], "window": [lo, hi]}


def bg_consistency(export_spec, model_spectrum, window):
    """回读导出谱的 Background 列，与建区所用谱的窗口 Shirley 在拟合区内逐点比。

    这是落盘后的第二道：XPSPeak 到底把哪条背景写进文件，只能从导出列看出来。
    """
    Ee, _rawe, bge, _n = F.load(export_spec)
    if not bge:
        return {"ok": False, "note": "导出谱没有 Background 列，无法核对建区背景",
                "mean_diff": 0.0, "max_abs_diff": 0.0, "pct_of_height": 0.0, "points": 0}
    Em, rawm, _b, _n = F.load(model_spectrum, bg_col=0)
    idx, lo, hi = _window_indices(Em, window)
    got = {}
    for i, v in enumerate(Ee):
        if lo - 1e-9 <= v <= hi + 1e-9:
            got[round(v, 3)] = bge[i]
    model = F.shirley_bg(Em, rawm)
    diffs = []
    for i in idx:
        v = got.get(round(Em[i], 3))
        if v is not None:
            diffs.append(v - model[i])
    if len(diffs) < 8:
        return {"ok": False, "note": "导出谱与模型谱在窗口内对不上（%d 点）" % len(diffs),
                "mean_diff": 0.0, "max_abs_diff": 0.0, "pct_of_height": 0.0, "points": len(diffs)}
    mean_d = sum(diffs) / float(len(diffs))
    max_d = max(abs(d) for d in diffs)
    height = max(rawm[i] - model[i] for i in idx)
    pct = (abs(mean_d) / height) if height > 0 else 0.0
    ok = (pct <= BG_SCOPE_TOL) or (abs(mean_d) <= BG_SCOPE_FLOOR)
    return {"ok": ok, "mean_diff": mean_d, "max_abs_diff": max_d,
            "pct_of_height": pct, "height": height, "points": len(diffs)}


def bg_plan(path, window, out_xps, crop=True):
    """决定建区用哪条谱：一致就用原谱；不一致默认裁谱，crop=False 直接拒绝（不静默）。"""
    chk = bg_scope_check(path, window)
    if chk["ok"]:
        return {"used": path, "scope": chk, "crop": None, "before": None}
    if not crop:
        raise ValueError(
            "⛔ 背景口径不一致：拟合区 Shirley 与全谱 Shirley 在窗口内平均差 %.0f cps"
            "（= 峰高 %.1f%%，容差 %.2f%%）。XPSPeak 建区按整条谱算背景，Peak Sum 会系统性偏低。"
            "修法：把 window 传进来由我裁谱重建（默认 crop=true），或先把谱裁到拟合窗口再 build。"
            % (chk["mean_diff"], 100.0 * chk["pct_of_height"], 100.0 * BG_SCOPE_TOL))
    dest = os.path.splitext(out_xps)[0] + "_fitwin.dat"
    info = crop_to_window(path, window, dest)
    chk2 = bg_scope_check(info["used"], window)
    if not chk2["ok"]:
        raise ValueError("⛔ 裁谱到拟合窗口后背景仍不一致（平均差 %.0f cps）：检查 window 与谱范围是否对得上"
                         % chk2["mean_diff"])
    return {"used": info["used"], "scope": chk2, "crop": info, "before": chk}


def do_build(a):
    """一次调用把一组峰参数落成可交付的 .xps（不需要人点 GUI）。

    与「先造 .rpa 再 Load Region Parameters」的区别：那条路首峰 Area 会被软件按 height 反算忽略，
    生成曲线比参数小约 25%；走 Add Peak 对话框则 Area 被真正采用（实测面积吻合）。"""
    peaks = a["peaks"]
    if not peaks:
        raise ValueError("peaks 不能为空")
    out = os.path.normpath(a.get("out") or D.work_path("built.xps"))

    build_guard(peaks, a.get("expect_bg"), a.get("actual_bg"), a.get("wlo"), a.get("whi"))
    spec = os.path.normpath(a["spec"]) if a.get("spec") else None
    par = os.path.normpath(a["par"]) if a.get("par") else None
    win = a.get("window")
    plan = None
    used = a["path"]
    if win and a.get("bg") is not False:
        plan = bg_plan(a["path"], [float(win[0]), float(win[1])], out, a.get("crop", True))
        used = plan["used"]
    verify = spec
    tmp_verify = None
    if plan is not None and not verify:
        tmp_verify = os.path.splitext(out)[0] + "_bgcheck.dat"
        verify = tmp_verify
    edge = _edge_warnings(used, peaks)
    r = D.build(EXE, used, peaks, out, verify, par, a.get("bg"))
    txt = "已生成 %s（%d 字节）" % (r["xps"], r["xps_bytes"])
    if plan is not None:
        cons = bg_consistency(verify, used, win)
        if not cons.get("ok"):
            try:
                os.remove(out)
            except OSError as rm_exc:
                raise ValueError("⛔ 建区背景与拟合背景不一致：%s（⚠ 本次写出的 %s 删除失败（%s）："
                                 "盘上仍有一份不可信的 .xps，请手动删）"
                                 % (cons.get("note") or "平均差超容差", out, rm_exc))
            raise ValueError("⛔ 建区背景与拟合背景不一致：导出谱 Background 与拟合窗口 Shirley 平均差 "
                             "%.0f cps（= 峰高 %.1f%%，容差 %.2f%%）—— Peak Sum 会系统性偏低。"
                             "修法：把谱裁到拟合窗口再 build（默认 crop=true 会自动裁）。本次已删除 %s。"
                             % (cons["mean_diff"], 100.0 * cons["pct_of_height"],
                                100.0 * BG_SCOPE_TOL, out))
        txt += "\n背景口径: 与拟合一致（平均差 %.0f cps、最大 %.0f cps，%d 点）" % (
            cons["mean_diff"], cons["max_abs_diff"], cons["points"])
        if plan.get("crop"):
            c = plan["crop"]
            txt += "\n已自动裁谱到拟合窗口 %.2f–%.2f eV（%d → %d 点，去掉 %d 点；临时谱 %s）" % (
                c["range_ev"][0], c["range_ev"][1], c["from_points"], c["kept"],
                c["removed"], c["used"])
        if plan.get("before"):
            b = plan["before"]
            txt += "\n（原谱全谱背景在窗口内平均低 %.0f cps，不裁谱就会让 Peak Sum 系统性偏低）" % b["mean_diff"]
        if tmp_verify:
            try:
                os.remove(tmp_verify)
            except OSError:
                pass
    bg_ok = None
    if spec and a.get("expect_bg") == "linear":
        try:
            bg_ok = _bg_guard_spec(spec)
        except ValueError as exc:
            try:                                   # 不落盘：刚写出的 .xps 立刻删掉
                os.remove(out)
            except OSError as rm_exc:
                raise ValueError("%s（⚠ 本次写出的 %s 删除失败（%s）：盘上仍有一份背景不符的 .xps，请手动删）"
                                 % (exc, out, rm_exc))
            raise ValueError("%s（已删除本次写出的 %s）" % (exc, out))
        if bg_ok:
            txt += "\n背景形状: 直线（最大偏离 %.0f cps，容差 %.0f cps）" % (bg_ok["max_dev"], bg_ok["limit"])
    if edge:
        txt = "\n".join(edge) + "\n" + txt
    if spec:
        txt += "\n谱图 %s" % spec
    if par:
        txt += "\n参数 %s" % par
    if spec:
        got, colnote = _spec_areas(spec)
        txt += "\n列判定: %s" % colnote
        for i, pk in enumerate(r["peaks"]):
            want = pk["area"]
            if i < len(got):
                txt += "\n  峰%d  %8.3f eV  FWHM %.3f  面积 要求 %.0f / 实测 %.0f  (%+.1f%%)" % (
                    i + 1, pk["pos"], pk["fwhm"], want, got[i], 100.0 * (got[i] / want - 1.0))
            else:
                txt += "\n  峰%d  %8.3f eV  FWHM %.3f  面积 %.0f（谱图里没找到对应峰列）" % (
                    i + 1, pk["pos"], pk["fwhm"], want)
    return txt


def do_close(pid=None):
    """关进程前校验进程名。pid 可能来自 find_pid，也可能被显式指定；
    但不能因为「窗口类名像 VB6」就 taskkill —— 杀错进程会丢别人没保存的分峰。"""
    pid = int(pid) if pid else find_pid()
    if not pid:
        return "XPSPeak 未在运行"
    name = D.proc_name(pid)
    if (name or "").upper() != "XPSPEAK41.EXE":
        return ("拒绝关闭 pid=%s：进程名是 %r，不是 XPSPEAK41.EXE"
                "（防止误杀别的 VB6 程序；确认无误可手工 taskkill）" % (pid, name))
    os.system("taskkill /PID %d /F >NUL 2>&1" % pid)
    time.sleep(0.6)
    return ("已关闭 pid=%d（%s）" % (pid, name)) if D.proc_name(pid) is None \
        else ("taskkill 已发出，但 pid=%d 仍存活 —— 请手工检查" % pid)


def do_call(name, a):
    # 教学模式闸门：在读窗口/动任何东西**之前**就判，连 app() 都不会去启动或接管进程。
    # 每次调用都从 mode.json 重读档位 —— 侧栏改完立刻生效，不用重启 MCP。
    _refresh_mode()
    if STATE["mode"] == "teach" and name in MUTATING:
        _refuse_in_teach(name, a)
    if name == "xpspeak_fit":
        return do_fit(a)
    if name == "xpspeak_build":
        return do_build(a)
    if name == "xpspeak_status":
        return do_status(a.get("mode"))
    if name == "xpspeak_open":
        return do_open(a["path"], a.get("source", "auto"))
    if name == "xpspeak_export":
        return do_export(a["path"], a.get("what", "spectrum"))
    if name == "xpspeak_save":
        return do_save(a["path"], a.get("what", "xps"))
    if name == "xpspeak_menu":
        pid, proc, fit = app()
        D.menu_click(fit, a["top"], a.get("sub"), settle=float(a.get("settle", 2)))
        return "已执行菜单: %s%s" % (a["top"], (" > " + a["sub"]) if a.get("sub") else "")
    if name == "xpspeak_click":
        pid, proc, fit = app()
        h = proc if a.get("form", "processing") == "processing" else fit
        b = D.button(h, a["caption"])
        if not b:
            raise KeyError("找不到按钮: %r" % a["caption"])
        D.click(b)
        return "已点击: %s" % a["caption"]
    if name == "xpspeak_close":
        return do_close(a.get("pid"))
    raise KeyError("unknown tool: " + name)


TOOLS = [
    ("xpspeak_fit", "带约束的多峰双线拟合（纯 Python，毫秒级，不启动 GUI）。输入 XPSPeak 导出的谱图（BE/Raw/.../Background）或两列 ASCII，返回每条组分的 center/FWHM/面积±σ、rms、R²、AIC，可一次扫 1..N 条模型做对比。约束内建：自旋轨道劈裂 Δ 固定、面积比固定、双峰等宽 —— 这就是可发表的版本；XPSPeak 自带的 Optimise 是无约束的，会把伴线压到物理上错误的宽度，别用它出结论。输出里一旦出现「⚠ 撞界」= 有参数顶到 ctol/wlo/whi/hmax 的边界，那些值由约束决定、不是拟合出来的，此时 R²/面积不可用于下结论（按提示调参后重拟合）。",
     {"path": dict(S, description="谱图文件绝对路径（XPSPeak 导出的 .dat 或两列 BE+Intensity）"),
      "centers": {"type": "array", "items": {"type": "number"},
                  "description": "各组分主峰初值（eV，低结合能那条），如 [162.09]；多条如 [162.09, 167.6]"},
      "bg": {"type": "string", "enum": ["file", "linear", "shirley", "none"],
             "description": "背景来源：file=用文件自带背景列（默认，最稳）；linear/shirley=自己算；none=不扣"},
      "bg_col": {"type": "number", "description": "背景列序号（1 起），默认 4"},
      "ds": {"type": "number", "description": "自旋轨道劈裂 ΔBE（eV）：S 2p=1.18，其他元素按文献值，默认 1.18"},
      "ratio": {"type": "number", "description": "伴线/主峰面积比，2p=0.5，d 轨道=2/3，默认 0.5"},
      "eta": {"type": ["number", "array", "string"], "description": "%Lorentzian（0-1）：一个数=全部峰同值；数组或逗号串（如 0.48,1.0,1.0）=逐峰。实测谱常是主峰 0.4–0.5、卫星 1.0，别用标量糊过去"},
      "expect_bg": {"type": "string", "enum": ["shirley", "linear", "tougaard", "file", "none"], "description": "模板要求的背景；给了就与实际 bg 比对，不一致判失败（tougaard 按 file 处理并警告）"},
      "ctol": {"type": "number", "description": "峰位初值允许移动的半宽 eV，默认 1.0；两个初值间距 < 0.5×ctol 会被直接拒绝（不可分离）"},
      "wlo": {"type": "number", "description": "FWHM 下限 eV，默认 0.6；谱里有更窄的峰必须调小，否则 FWHM 被压平在 0.6 这个假值上"},
      "whi": {"type": "number", "description": "FWHM 上限 eV，默认 4.0"},
      "hmax": {"type": "number", "description": "峰高上限 cps，默认 120000；峰高超过 12 万的谱必须显式调大，否则曲线被截断、R²/面积不可用"},
      "scan": {"type": "number", "description": "同时扫 1..N 条双线做 AIC 对比（N ≤ centers 个数）"},
      "window": {"type": "array", "items": {"type": "number"},
                 "description": "拟合窗口 [lo, hi]（eV，结合能，需 lo<hi）：只拟合这一段，Shirley 的两个端点也按窗口两端重取；省略=全谱"},
      "csv": dict(S, description="可选：把 BE/Signal/Fit/Resid 曲线写到这个 CSV")}, ["path", "centers"]),
    ("xpspeak_build", "一次调用生成可交付的 .xps：载谱 -> 扣背景 -> 按给定峰参数逐个 Add Peak -> 导出谱图/参数 -> Save XPS，全程不用人点界面，并回读谱图复核每峰面积。典型用法：先 xpspeak_fit 出可发表参数，再用本工具把同一组参数落成 XPSPeak 原生文件（给人工看/存档/交付）。注意别用「造 .rpa 再 Load Region Parameters」那条路：实测首峰 Area 会被软件按 height 反算忽略，曲线比参数小约 25%。",
     {"path": dict(S, description="源谱图绝对路径（两列 ASCII 或 .xps）"),
      "peaks": {"type": "array", "description": "分峰参数，按顺序 Add Peak",
                "items": {"type": "object", "properties": {
                    "pos": {"type": "number", "description": "峰位 eV"},
                    "fwhm": {"type": "number", "description": "半高宽 eV"},
                    "area": {"type": "number", "description": "面积（会被真正采用）"},
                    "gl": {"type": "number", "description": "%Lorentzian，默认 30"}},
                    "required": ["pos", "fwhm", "area"]}},
      "out": dict(S, description="输出 .xps 绝对路径；省略则写 ~/xpspeak_auto/built.xps"),
      "spec": dict(S, description="可选：同时导出谱图 ASCII 到这个路径（用于复核面积）"),
      "par": dict(S, description="可选：同时导出峰参数表到这个路径"),
      "bg": {"type": "boolean", "description": "是否先扣背景建区域；ASCII 源默认 true，.xps 源默认 false"},
      "expect_bg": {"type": "string", "enum": ["shirley", "linear", "tougaard", "file", "none"], "description": "模板要求的背景类型；与 actual_bg 不一致拒绝保存"},
      "actual_bg": {"type": "string", "enum": ["shirley", "linear", "tougaard", "file", "none"], "description": "这一次实际用的背景类型；与 expect_bg 不一致拒绝保存"},
      "wlo": {"type": "number", "description": "拟合时用的 FWHM 下界；峰 FWHM 顶在该值上即判撞界、拒绝保存"},
      "whi": {"type": "number", "description": "拟合时用的 FWHM 上界；同上"},
      "window": {"type": "array", "items": {"type": "number"},
                 "description": "本次 xpspeak_fit 用的拟合窗口 [lo, hi]（eV）：给了就核对「全谱 Shirley」与「窗口 Shirley」，不一致时默认自动裁谱到该窗口再建区，避免 Peak Sum 系统性偏低"},
      "crop": {"type": "boolean",
               "description": "背景口径不一致时是否自动裁谱到拟合窗口（默认 true）；false = 直接拒绝，不静默建区"}},
     ["path", "peaks"]),
    ("xpspeak_status",
     "启动（若未运行）并返回进程号、窗体、按钮、全部菜单项和当前模式。任何操作前先调它。"
     "mode=teach 切到教学模式：只读，open/export/save/menu/click/close/build 一律拒绝并回「这一步请你操作」"
     "（用户想学软件时用这档）；mode=exec 切到代执行：在授权范围内一次做完（用户说「你来吧」才切）。",
     {"mode": {"type": "string", "enum": ["teach", "exec"],
               "description": "切模式：teach=教学模式（只读）/ exec=代执行；省略则只读当前模式"}}, []),
    ("xpspeak_open", "载入谱图。source=auto 按扩展名判断（.xps/.rpa 走 Open XPS，其余走 Data>Import (ASCII)，ASCII 若是 LF 换行会自动改用 CRLF 副本）。",
     {"path": dict(S, description="谱图文件绝对路径（.xps / .rpa / 两列 BE+Intensity 的 ASCII）"),
      "source": {"type": "string", "enum": ["auto", "xps", "ascii"], "description": "默认 auto"}}, ["path"]),
    ("xpspeak_export", "导出数据到文件。what=spectrum 导出 B.E./Raw Intensity/Peak Sum/Background/各峰/difference；what=peaks 导出峰参数表。",
     {"path": dict(S, description="输出的绝对路径"),
      "what": {"type": "string", "enum": ["spectrum", "peaks"], "description": "默认 spectrum"}}, ["path"]),
    ("xpspeak_save", "保存当前状态为 XPSPeak 原生文件。what=xps 走 Processing 窗 Save XPS（谱图+背景+已定峰参数，xpspeak_open 可原样载回）；what=rpa 走 Parameters>Save Region Parameters（只存区域峰参数，可套用到别的谱上）。",
     {"path": dict(S, description="输出绝对路径（.xps / .rpa）"),
      "what": {"type": "string", "enum": ["xps", "rpa"], "description": "默认 xps"}}, ["path"]),
    ("xpspeak_menu", "执行任意菜单命令：Add Peak / Background / Optimise Region / Load|Save Region Parameters / Clear Parameters / Delete Region / Region Shift / ReDisplay / Import (Kratos|Leybold|Phi|VAMAS)。",
     {"top": dict(S, description="顶层菜单名，如 Data、Parameters、Add Peak、Background"),
      "sub": dict(S, description="子项名；顶层项本身是命令时省略"),
      "settle": {"type": "number", "description": "命令后等待秒数，默认 2"}}, ["top"]),
    ("xpspeak_click", "按标题点击窗体按钮：Open XPS / Save XPS / Optimise All / Close / Options / 区域号 1..10。",
     {"caption": dict(S, description="按钮标题，精确匹配"),
      "form": {"type": "string", "enum": ["processing", "fit"], "description": "默认 processing"}}, ["caption"]),
    ("xpspeak_close", "关闭 XPSPeak 进程。关之前校验进程名必须是 XPSPEAK41.EXE（不是就拒绝，防止误杀别的 VB6 程序）。",
     {"pid": {"type": "number", "description": "可选：只关这个 pid（默认关当前找得到的那个）"}}, []),
]


def handle(req):
    m, rid = req.get("method"), req.get("id")
    if m == "initialize":
        return {"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": req.get("params", {}).get("protocolVersion") or PROTO,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "xpspeak", "version": D.__version__}}}
    if m == "tools/list":
        return {"jsonrpc": "2.0", "id": rid, "result": {"tools": [
            {"name": n, "description": d,
             "inputSchema": {"type": "object", "properties": p, "required": r}}
            for n, d, p, r in TOOLS]}}
    if m == "tools/call":
        p = req.get("params") or {}
        try:
            with contextlib.redirect_stdout(sys.stderr):
                txt = do_call(p.get("name"), p.get("arguments") or {})
            return {"jsonrpc": "2.0", "id": rid,
                    "result": {"content": [{"type": "text", "text": str(txt)}]}}
        except Exception as e:
            return {"jsonrpc": "2.0", "id": rid, "result": {
                "content": [{"type": "text", "text": "%s: %s" % (type(e).__name__, e)}], "isError": True}}
    if m == "ping":
        return {"jsonrpc": "2.0", "id": rid, "result": {}}
    if rid is None:
        return None
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "method not found: %s" % m}}


def serve():
    # MCP 规定 UTF-8；Windows 管道默认 cp936，必须显式改，否则中文描述会解码失败
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": None,
                                         "error": {"code": -32700, "message": "parse error: %s" % e}}) + "\n")
            sys.stdout.flush()
            continue
        resp = handle(req)
        if resp is not None:
            sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
            sys.stdout.flush()


def selftest():
    """端到端自检：协议握手 -> tools/list -> 启动 -> 载入样例 -> 导出 -> 校验字节数 -> 关闭"""
    import subprocess, tempfile
    pr = subprocess.Popen([sys.executable, os.path.abspath(__file__)],
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                          text=True, encoding="utf-8", bufsize=1)
    n = [0]

    def rpc(method, params=None):
        n[0] += 1
        pr.stdin.write(json.dumps({"jsonrpc": "2.0", "id": n[0], "method": method, "params": params}) + "\n")
        pr.stdin.flush()
        return json.loads(pr.stdout.readline())

    ini = rpc("initialize", {"protocolVersion": PROTO})
    assert ini["result"]["serverInfo"]["name"] == "xpspeak", ini
    assert ini["result"]["serverInfo"]["version"] == D.__version__, ini
    names = [t["name"] for t in rpc("tools/list")["result"]["tools"]]
    assert len(names) == 9 and "xpspeak_build" in names and "xpspeak_save" in names, names
    props = {t["name"]: t["inputSchema"]["properties"] for t in rpc("tools/list")["result"]["tools"]}
    assert "window" in props["xpspeak_fit"] and "hmax" in props["xpspeak_fit"], props["xpspeak_fit"]
    # 不依赖 GUI 的拟合自检：合成一条双峰谱，验证 xpspeak_fit 能把峰位/半宽拟合回来
    syn = os.path.join(tempfile.gettempdir(), "xpspeak_fit_check.dat")
    with open(syn, "w", encoding="utf-8") as fh:
        fh.write("BE Raw PeakSum Background\n")
        for i in range(121):
            e = 175.0 - 0.1 * i
            fh.write("%.4f %.2f %.2f %.2f\n" % (e, 3000 + F.model_at(e, [163.0, 1.0, 200.0], 1, 0.0, 0.0, 0.3),
                                                 3000.0, 3000.0))
    fr = rpc("tools/call", {"name": "xpspeak_fit",
                            "arguments": {"path": syn, "centers": [163.05], "bg": "file",
                                          "ds": 0.0, "ratio": 0.0, "eta": 0.3}})
    assert not fr["result"].get("isError"), fr
    txt = fr["result"]["content"][0]["text"]
    assert "162.9" in txt or "163.0" in txt, txt
    os.remove(syn)
    st = rpc("tools/call", {"name": "xpspeak_status", "arguments": {}})
    stxt = st["result"]["content"][0]["text"]
    assert "pid=" in stxt, st
    owned = "本次启动" in stxt          # 用户手工开着的实例不能被我 taskkill
    pid_val = int(re.search(r"pid=(\d+)", stxt).group(1))
    sample = os.path.join(os.path.dirname(EXE), "gaas.xps")
    out = os.path.join(tempfile.gettempdir(), "xpspeak_mcp_check.dat")
    for method, args in (("xpspeak_open", {"path": sample}), ("xpspeak_export", {"path": out})):
        r = rpc("tools/call", {"name": method, "arguments": args})
        assert not r["result"].get("isError"), r
        if method == "xpspeak_open":      # S1：载入必须带「确认载入 N 点」的弱确认
            otxt = r["result"]["content"][0]["text"]
            assert "确认载入" in otxt, otxt
    size = os.path.getsize(out) if os.path.exists(out) else 0
    if size:
        os.remove(out)
    xps = os.path.join(tempfile.gettempdir(), "xpspeak_mcp_save.xps")
    r = rpc("tools/call", {"name": "xpspeak_save", "arguments": {"path": xps}})
    assert not r["result"].get("isError"), r
    saved = os.path.getsize(xps) if os.path.exists(xps) else 0
    head = open(xps, "rb").read(12) if saved else b""
    if saved:
        os.remove(xps)
    bspec = os.path.join(tempfile.gettempdir(), "xpspeak_build_check.dat")
    bxps = os.path.join(tempfile.gettempdir(), "xpspeak_build_check.xps")
    br = rpc("tools/call", {"name": "xpspeak_build", "arguments": {
        "path": sample, "peaks": [{"pos": 40.0, "fwhm": 1.2, "area": 5000.0}],
        "out": bxps, "spec": bspec}})
    assert not br["result"].get("isError"), br
    btxt = br["result"]["content"][0]["text"]
    assert "实测" in btxt, btxt
    built = os.path.getsize(bxps) if os.path.exists(bxps) else 0
    for f in (bspec, bxps):
        if os.path.exists(f):
            os.remove(f)
    # 教学模式闸门：写操作必须被拒绝，而且不能"看起来拒绝、其实点了"
    rpc("tools/call", {"name": "xpspeak_status", "arguments": {"mode": "teach"}})
    st2 = rpc("tools/call", {"name": "xpspeak_status", "arguments": {}})["result"]["content"][0]["text"]
    assert "教学模式" in st2, st2                      # 只读调用在教学模式下照常可用
    tr = rpc("tools/call", {"name": "xpspeak_click", "arguments": {"caption": "Open XPS"}})
    ttxt = tr["result"]["content"][0]["text"]
    assert tr["result"].get("isError") and "教学模式" in ttxt and "请你操作" in ttxt, tr
    assert "Open XPS" in ttxt, ttxt                    # 拒绝里要写清「你自己该点哪个」
    assert not D.dialogs(pid_val), "教学模式竟然点出了对话框: %r" % [D.text(h) for h in D.dialogs(pid_val)]
    tr2 = rpc("tools/call", {"name": "xpspeak_menu", "arguments": {"top": "Add Peak"}})
    assert tr2["result"].get("isError") and "教学模式" in tr2["result"]["content"][0]["text"], tr2
    # mode.json 真源：坏文件必须 fail-closed 到教学模式（解析失败不许放开写操作）
    mp = _mode_path()
    bak = open(mp, encoding="utf-8").read() if os.path.exists(mp) else None
    d = os.path.dirname(mp)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(mp, "w", encoding="utf-8") as fh:
        fh.write('{"mode": "teach", oops')
    br2 = rpc("tools/call", {"name": "xpspeak_click", "arguments": {"caption": "Open XPS"}})
    btxt2 = br2["result"]["content"][0]["text"]
    assert br2["result"].get("isError") and "mode.json 损坏" in btxt2, br2
    assert not D.dialogs(pid_val), "坏 mode.json 竟然放行了写操作"
    if bak is None:
        os.remove(mp)
    else:
        with open(mp, "w", encoding="utf-8") as fh:
            fh.write(bak)
    rpc("tools/call", {"name": "xpspeak_status", "arguments": {"mode": "exec"}})

    if owned:
        cr = rpc("tools/call", {"name": "xpspeak_close", "arguments": {"pid": pid_val}})
        assert "已关闭" in cr["result"]["content"][0]["text"], cr
    pr.stdin.close()
    pr.wait(timeout=10)
    assert size > 1000, "导出不到 1KB: %d" % size
    assert saved > 1000 and head.startswith(b"XPSPEAK"), "存 .xps 异常: %d %r" % (saved, head)
    assert built > 1000, "xpspeak_build 产物异常: %d" % built
    print("selftest OK: %d 个工具，initialize/tools-list/fit/status/open/save/export/build/close 全通，"
          "导出 %d 字节、存 .xps %d 字节、生成 .xps %d 字节%s"
          % (len(names), size, saved, built,
             "" if owned else "（XPSPeak 原本就在运行，按纪律没关它）"))


if __name__ == "__main__":
    selftest() if "--selftest" in sys.argv else serve()
