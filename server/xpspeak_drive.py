# -*- coding: utf-8 -*-
"""XPSPeak 4.1 控件盘点 + Win32 消息级自动化（纯标准库，无第三方依赖）。

用法:
  python xpspeak_drive.py inventory                      # 打印窗口/菜单/控件清单
  python xpspeak_drive.py export <in.xps> <out.dat>      # 打开谱图并导出 ASCII（已实测）
  python xpspeak_drive.py importascii <in.txt> <out.dat> # Data>Import(ASCII) 后导出（同机制）

实测要点（2026-10-15 于 XPSPEAK41.exe / gaas.xps）:
  * VB6 程序：表单 ThunderRT6FormDC，控件 ThunderRT6CommandButton/TextBox，主窗口 ThunderRT6Main
  * 菜单是真 Win32 菜单 -> 按文字取 id 后 PostMessage WM_COMMAND，不需要鼠标坐标/前台焦点
  * 文件对话框统一这样走：WM_SETTEXT 填 Edit(0x47C=1148 或 1001) -> PostMessage WM_COMMAND IDOK；
    不要去点按钮 HWND（Open 对话框的按钮在 DirectUI 里根本没有 HWND，Save 对话框才有 Button id=1）
  * 必须用 PostMessage：BM_CLICK / IDOK 用 SendMessage 会同步等到模态框关闭，遇异常弹窗直接死锁
  * 导出成功后会弹 "XPSPEAK41 / Data file exported" 模态框，要顺手关掉才能继续
  * Import (ASCII) 只认 CRLF 行尾，LF-only 文件会被静默读错（点数减半、B.E. 列变成强度值）-> ascii_crlf()
  * 传给对话框的路径必须是反斜杠形式（"C:\a\b.dat"）：正斜杠会被 Save 对话框拒绝 -> 对话框不关、文件写不出
"""
import ctypes, itertools, os, re, subprocess, sys, time, shutil
from ctypes import wintypes as w

u = ctypes.windll.user32
__version__ = "1.2.2"        # 与仓库 tag 同步；MCP 的 serverInfo.version 读这里，别再各写一个
EXE_DEFAULT = r"E:\下载\XPS分峰软件XPSpeak41\XPS分峰软件XPSpeak41\XPSPEAK41.exe"
WORKDIR = os.path.join(os.path.expanduser("~"), "xpspeak_auto")
_SEQ = itertools.count(1)    # work_path 的唯一后缀
FORM_PROC, FORM_FIT = "XPS Peak Processing", "XPS Peak Fit"
DLG_OPEN, DLG_SAVE, DLG_IMPORT = "Open file", "Export Spectral", "Import Ascii format"   # 对话框标题按子串匹配
DLG_SAVE_RPA = "Save region parameters"
# 坑：Processing 窗的 "Save XPS" 按钮弹出的保存框标题仍是 "Open file"（VB6 CommonDialog 的 caption 没改），
# 所以保存 .xps 复用的就是 DLG_OPEN 这个匹配串；Parameters > Save Region Parameters 的框标题是 DLG_SAVE_RPA。
BM_CLICK, WM_SETTEXT, WM_COMMAND, WM_KEYDOWN = 0x00F5, 0x000C, 0x0111, 0x0100
CB_GETCOUNT, CB_GETCURSEL, CB_SETCURSEL, CB_GETLBTEXT = 0x0146, 0x0147, 0x014E, 0x0148
CBN_SELCHANGE = 1
# Background（标题 "Region"）对话框里的背景类型下拉：Items = Shirley / Linear / Tougaard。
BG_DLG_TITLE, BG_TYPE_COMBO_ID = "Region", 13
MF_BYPOSITION, IDOK = 0x400, 1
u.GetWindowTextW.argtypes = [w.HWND, w.LPWSTR, ctypes.c_int]
u.GetClassNameW.argtypes = [w.HWND, w.LPWSTR, ctypes.c_int]
u.SendMessageW.argtypes = [w.HWND, w.UINT, w.WPARAM, ctypes.c_void_p]
u.PostMessageW.argtypes = [w.HWND, w.UINT, w.WPARAM, ctypes.c_void_p]
CB = ctypes.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)


def text(h, n=512):
    b = ctypes.create_unicode_buffer(n); u.GetWindowTextW(h, b, n); return b.value


def cls(h):
    b = ctypes.create_unicode_buffer(256); u.GetClassNameW(h, b, 256); return b.value


def tops(pid):
    o = []
    def cb(h, l):
        p = w.DWORD(); u.GetWindowThreadProcessId(h, ctypes.byref(p))
        if p.value == pid: o.append(h)
        return True
    u.EnumWindows(CB(cb), 0); return o


def kids(h):
    o = []
    def cb(c, l):
        o.append(c); return True
    u.EnumChildWindows(h, CB(cb), 0); return o


def form(pid, title):
    for h in tops(pid):
        if cls(h) == "ThunderRT6FormDC" and text(h) == title: return h


def menu_form(pid):
    """带菜单的那个窗体 = 分峰窗。标题会随区域改名（"XPS Peak Fit" → "Region 4"），只能靠「有菜单」认。"""
    for h in tops(pid):
        if cls(h) == "ThunderRT6FormDC" and u.GetMenu(h):
            return h


def button(hwnd, caption):
    """按标题找按钮（唯一实现；原来的 _btn 是同一份代码，已合并过来）"""
    for c in kids(hwnd):
        if cls(c).startswith("ThunderRT6CommandButton") and text(c) == caption: return c


def dialogs(pid):
    return [h for h in tops(pid) if cls(h) == "#32770"]


def menu_label(m, i):
    b = ctypes.create_unicode_buffer(128); u.GetMenuStringW(m, i, b, 128, MF_BYPOSITION)
    return b.value.replace("&", "")


def menu_tree(hwnd):
    """[(顶层项文字, [子项文字...]), ...] —— inventory 与 MCP 的 status 共用这一份，不再各写一遍。"""
    m = u.GetMenu(hwnd)
    out = []
    for i in range(u.GetMenuItemCount(m) if m else 0):
        sm = u.GetSubMenu(m, i)
        out.append((menu_label(m, i),
                    [menu_label(sm, j) for j in range(u.GetMenuItemCount(sm) if sm else 0)]))
    return out


def menu_id(f, top, sub):
    """按菜单文字取命令 id（比下标稳）。

    顶层项带子菜单时**必须**显式给 sub：省略 sub 不能猜成「第一项」——
    那会把 xpspeak_menu(top="Data") 变成真的去执行 Export (Spectrum) 并弹保存框。
    """
    items = dict(menu_tree(f))
    if top not in items:
        raise KeyError("没有顶层菜单 %r（有：%s）" % (top, " / ".join(items)))
    children = items[top]
    m = u.GetMenu(f)
    idx = [n for n, _ in menu_tree(f)].index(top)
    if not children:                     # 顶层项本身就是命令（Background / Add Peak / Optimise Region / ReDisplay）
        return u.GetMenuItemID(m, idx)
    if sub is None:
        raise KeyError("%r 有子项，必须显式给 sub（可选：%s）" % (top, " / ".join(children)))
    if sub not in children:
        raise KeyError("%r 下没有子项 %r（可选：%s）" % (top, sub, " / ".join(children)))
    return u.GetMenuItemID(u.GetSubMenu(m, idx), children.index(sub))


def click(hwnd, settle=1.5):
    u.PostMessageW(hwnd, BM_CLICK, 0, 0); time.sleep(settle)


def menu_click(f, top, sub, settle=2.0):
    u.PostMessageW(f, WM_COMMAND, menu_id(f, top, sub), 0); time.sleep(settle)


OK_CAPTIONS = ("ok", "确定", "yes", "是", "&ok", "&yes")


def ok_button(cands):
    """从 [(caption, hwnd)] 里挑「确认」键：白名单优先，命中不到退回第一个（= 原来的行为）。
    纯函数、不碰窗口，便于自检；覆盖确认类对话框的默认键未必是「是」，盲点第一个有风险。"""
    for want in OK_CAPTIONS:
        for cap, h in cands:
            if (cap or "").strip().lower() == want:
                return h
    return cands[0][1] if cands else None


def _kill_strays(pid, keep=()):
    """关掉模态消息框（"Data file exported" / "Error Reading File" 等），返回被关掉的标题列表。
    实测坑：这类框的确定按钮 CtrlID=2、WM_COMMAND IDOK(1) 打不掉，必须直接 BM_CLICK 真按钮。"""
    killed = []
    for h in dialogs(pid):
        if h in keep:
            continue
        btn = ok_button([(text(c), c) for c in kids(h) if cls(c) == "Button"])
        if btn:
            u.PostMessageW(btn, BM_CLICK, 0, 0)
        else:
            u.PostMessageW(h, WM_COMMAND, IDOK, 0)
        killed.append(text(h) or cls(h))
    return killed


def has_text(hwnd, needle):
    """窗口（含子控件）里有没有这段文字 —— 用来认 XPSPeak 的 "Error Reading File"。"""
    if needle.lower() in (text(hwnd) or "").lower():
        return True
    return any(needle.lower() in (text(c) or "").lower() for c in kids(hwnd))


def work_path(name):
    """每次调用给一个唯一文件名（pid + 递增序号），并顺手清掉 30 分钟前的旧产物。
    固定文件名（in.xps / crlf_xxx.dat）会让两次重跑互相覆盖，CRLF 副本还可能被当成这次的输入。"""
    os.makedirs(WORKDIR, exist_ok=True)
    now = time.time()
    try:
        for f in os.listdir(WORKDIR):
            p = os.path.join(WORKDIR, f)
            if os.path.isfile(p) and now - os.path.getmtime(p) > 30 * 60:
                os.remove(p)
    except OSError:
        pass
    stem, ext = os.path.splitext(name)
    return os.path.join(WORKDIR, "%s_%d_%d%s" % (stem, os.getpid(), next(_SEQ), ext))


def _set_window_text(h, s):
    u.SendMessageW(h, WM_SETTEXT, 0, ctypes.cast(ctypes.c_wchar_p(s), ctypes.c_void_p))


def file_dialog(pid, title, path, timeout=15, keep_open_ok=()):
    """Vista 风格文件对话框：填文件名 -> IDOK -> 等它关闭（顺手关掉覆盖确认/信息框）"""
    t0, d = time.time(), None
    while time.time() - t0 < timeout:
        # title=None 时自动挑“带 Edit 的文件对话框”，避开 "Data file exported" 之类的消息框
        hits = [h for h in dialogs(pid)
                if (title in text(h) if title else any(cls(c) == "Edit" for c in kids(h)))]
        if hits: d = hits[0]; break
        _kill_strays(pid)
        time.sleep(0.3)
    if d is None:
        raise TimeoutError("dialog not found: %r (strays: %r)" % (title or "<auto>", [text(h) for h in dialogs(pid)]))
    eds = [c for c in kids(d) if cls(c) == "Edit"]
    ed = ([e for e in eds if u.GetDlgCtrlID(e) in (0x47C, 1001)] or eds)[0]
    _set_window_text(ed, path)
    time.sleep(0.3)
    u.PostMessageW(d, WM_COMMAND, IDOK, 0)
    t0 = time.time()
    while time.time() - t0 < timeout:
        cur = dialogs(pid)
        if d not in cur: return True
        for h in cur:
            if h != d: u.PostMessageW(h, WM_COMMAND, IDOK, 0)   # 覆盖确认等
        time.sleep(0.3)
    raise TimeoutError("dialog stuck: %r" % title)


def ascii_crlf(path):
    """Import (ASCII) 只认 CRLF 行尾：LF-only 文件会被静默读错（点数减半、X/Y 轴值错位），
    实测 181 点的谱读成 91 点且 B.E. 列变成强度值。原文件不动，需要时返回一份 CRLF 副本路径。"""
    with open(path, "rb") as f:
        b = f.read()
    # 本轮补的坑：按「\r\n→\n、\r→\n、\n→\r\n」顺序替换会把 '\r\r\n' 变成「一行数据+一个空行」
    # （实测 20 行变 40 行），XPSPeak 直接弹 Error Reading File。改成「按任意换行切分、丢空行、统一重连」。
    lines = [ln for ln in re.split(rb"\r\n|\r|\n", b) if ln.strip()]
    crlf = b"\r\n".join(lines) + (b"\r\n" if lines else b"")
    if crlf == b:
        return path
    out = work_path("crlf_" + os.path.basename(path))
    with open(out, "wb") as f:
        f.write(crlf)
    return out


def _vis(pid):
    return set(h for h in tops(pid) if u.IsWindowVisible(h))


def wait_new(pid, before, timeout=10.0):
    """等一个「之前不可见、现在可见」的窗体 —— XPSPeak 的对话框都是预先建好再 Show 的，
    所以不能按句柄是否存在判断，只能比可见性。"""
    t0 = time.time()
    while time.time() - t0 < timeout:
        for h in tops(pid):
            # 只认 VB6 窗体：ComboLBox 之类的弹出列表也会「新可见」，抢到它就会找不到控件
            if u.IsWindowVisible(h) and h not in before and cls(h) == "ThunderRT6FormDC":
                return h
        time.sleep(0.2)
    return None


def _fill(hwnd, pairs):
    for cid, val in pairs:
        c = next((c for c in kids(hwnd) if u.GetDlgCtrlID(c) == cid), None)
        if c is None:
            raise KeyError("对话框 %r 没有控件 id=%s" % (text(hwnd), cid))
        _set_window_text(c, val)
        time.sleep(0.15)


def combo(hwnd, cid):
    for c in kids(hwnd):
        if u.GetDlgCtrlID(c) == cid and cls(c) == "ThunderRT6ComboBox":
            return c
    return None


def combo_items(c):
    n = u.SendMessageW(c, CB_GETCOUNT, 0, 0)
    out = []
    for i in range(n):
        buf = ctypes.create_unicode_buffer(128)
        u.SendMessageW(c, CB_GETLBTEXT, i, ctypes.byref(buf))
        out.append(buf.value)
    return out


def set_combo(hwnd, cid, label, settle=0.8):
    """按文字选中下拉项，并给父窗体发 CBN_SELCHANGE。

    VB6 的 Change/Click 事件不会因为 CB_SETCURSEL 自己触发，必须补一条 WM_COMMAND
    （HIWORD = CBN_SELCHANGE，LOWORD = 控件 id）——只设选中值，软件内部仍按旧类型算背景。
    返回实际选中的序号；控件/条目不存在时抛 KeyError（不静默用默认值）。
    """
    c = combo(hwnd, cid)
    if c is None:
        raise KeyError("对话框 %r 没有下拉框 id=%s" % (text(hwnd), cid))
    items = combo_items(c)
    want = label.strip().lower()
    idx = next((i for i, s in enumerate(items) if s.strip().lower() == want), None)
    if idx is None:
        raise KeyError("下拉框没有 %r（有：%s）" % (label, " / ".join(items)))
    u.SendMessageW(c, CB_SETCURSEL, idx, 0)
    u.PostMessageW(hwnd, WM_COMMAND, (CBN_SELCHANGE << 16) | cid, c)
    time.sleep(settle)
    got = u.SendMessageW(c, CB_GETCURSEL, 0, 0)
    return {"index": idx, "items": items, "selected": got}


def launch(exe=EXE_DEFAULT):
    if not os.path.exists(exe):
        raise FileNotFoundError(
            "找不到 XPSPEAK41.exe: %s\n请设环境变量 XPSPEAK_EXE 指向本机真实的 XPSPEAK41.exe" % exe)
    p = subprocess.Popen([exe], cwd=os.path.dirname(exe))
    time.sleep(4)
    return p


def proc_name(pid):
    """进程可执行文件名（QueryFullProcessImageNameW，纯 ctypes，不装 psutil）。
    用途：关进程前确认真的是 XPSPEAK41.exe，别把别的 VB6 程序 / 用户别的实例杀掉。"""
    k32 = ctypes.windll.kernel32
    h = k32.OpenProcess(0x1000, False, pid)          # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return None
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = ctypes.c_ulong(1024)
        if not k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return None
        return os.path.basename(buf.value)
    finally:
        k32.CloseHandle(h)


def inventory(pid):
    for h in tops(pid):
        if not u.IsWindowVisible(h): continue
        print("TOP", hex(h), cls(h), repr(text(h)))
        for i, (name, items) in enumerate(menu_tree(h)):
            print("   MENU", i, name, items)
        seen = {}
        for c in kids(h):
            k = (cls(c), text(c)); seen[k] = seen.get(k, 0) + 1
        for (k, t), n in seen.items():
            print("   CH", k, repr(t), ("x%d" % n) if n > 1 else "")


def export(exe, src, out, import_ascii=False):
    """打开(或导入)谱图 -> Data>Export(Spectrum) 导出 ASCII。返回写出的字节数。

    注意：传给文件对话框的路径必须是反斜杠形式，正斜杠会被 Save 对话框拒绝（对话框不关、也写不出文件）。
    """
    src, out = os.path.normpath(src), os.path.normpath(out)
    inp = work_path("in" + os.path.splitext(src)[1])
    shutil.copy(src, inp)
    if os.path.exists(out): os.remove(out)
    p = launch(exe)
    try:
        pid = p.pid
        proc, fit = form(pid, FORM_PROC), form(pid, FORM_FIT)
        if not (proc and fit): raise RuntimeError("forms not found")
        if import_ascii:
            menu_click(fit, "Data", "Import (ASCII)")
            file_dialog(pid, DLG_IMPORT, ascii_crlf(inp))   # 标题实为 "Import Ascii format (BE  Intensity)"
        else:
            click(button(proc, "Open XPS"))
            file_dialog(pid, DLG_OPEN, inp)
        menu_click(fit, "Data", "Export (Spectrum)")
        file_dialog(pid, DLG_SAVE, out)
        time.sleep(0.5); _kill_strays(pid)          # "Data file exported"
        return os.path.getsize(out) if os.path.exists(out) else 0
    finally:
        p.terminate()


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "inventory"
    exe = os.environ.get("XPSPEAK_EXE", EXE_DEFAULT)
    if mode == "inventory":
        p = launch(exe)
        try: inventory(p.pid)
        finally: p.terminate()
    elif mode in ("export", "importascii"):
        n = export(exe, sys.argv[2], sys.argv[3], import_ascii=(mode == "importascii"))
        print("bytes:", n)
        if n: print(open(sys.argv[3], encoding="utf-8", errors="replace").read()[:300])
    else:
        raise SystemExit(__doc__)


def build(exe, src, peaks, out_xps, out_spec=None, out_par=None, background=None, bg_type=None):
    """一次调用：载谱 -> (扣背景) -> 逐个 Add Peak -> 导出谱图/参数 -> 存 .xps。

    peaks: [{"pos": 162.059, "fwhm": 0.952, "area": 53963.0, "gl": 30}, ...]
    关键实测：Add Peak 对话框里的 Area 会被真正采用（存出来的曲线面积与之一致）；
    而用 .rpa 载入参数时首峰 Area 被软件按 height 反算忽略 —— 所以生成 .xps 必须走这条路。
    background=None 时：ASCII 谱自动扣背景（需要它来建 Region），.xps 谱默认不动。
    bg_type：background=True 时在下拉里选 Shirley / Linear / Tougaard —— 不选就是软件默认
    （实测默认 Shirley，模板写 linear 也只能造出台阶背景，所以必须显式选）。
    """
    src, out_xps = os.path.normpath(src), os.path.normpath(out_xps)
    if bg_type is not None:
        bg_type = str(bg_type).strip().lower()
        if bg_type not in ("shirley", "linear", "tougaard"):
            raise ValueError("bg_type 只能是 shirley/linear/tougaard，收到 %r" % bg_type)
    if not os.path.exists(src):
        raise FileNotFoundError(src)
    ascii_src = not src.lower().endswith((".xps", ".rpa"))
    if background is None:
        background = ascii_src
    os.makedirs(WORKDIR, exist_ok=True)
    for f in (out_xps, out_spec, out_par):
        if f and os.path.exists(f):
            os.remove(f)
    type_info = None
    p = launch(exe)
    try:
        pid = p.pid
        proc = form(pid, FORM_PROC)
        fit = menu_form(pid)
        if ascii_src:
            menu_click(fit, "Data", "Import (ASCII)", settle=1.0)
            file_dialog(pid, None, ascii_crlf(src))
        else:
            click(button(proc, "Open XPS"))
            file_dialog(pid, DLG_OPEN, src)
        time.sleep(1.5)
        _kill_strays(pid)
        fit = menu_form(pid)
        type_info = None
        if background:
            before = _vis(pid)
            menu_click(fit, "Background", None, settle=1.5)
            dlg = wait_new(pid, before)
            if dlg is None:
                raise TimeoutError("Background 对话框没出现")
            if bg_type is not None:
                type_info = set_combo(dlg, BG_TYPE_COMBO_ID,
                                      {"shirley": "Shirley", "linear": "Linear",
                                       "tougaard": "Tougaard"}[bg_type])
            click(button(dlg, "Accept"), settle=2.5)
        for pk in peaks:
            before = _vis(pid)
            menu_click(fit, "Add Peak", None, settle=1.5)
            dlg = wait_new(pid, before)
            if dlg is None:
                raise TimeoutError("Add Peak 对话框没出现（%s）" % text(fit))
            _fill(dlg, [(32, "%.4f" % float(pk["pos"])),
                        (25, "%.4f" % float(pk["fwhm"])),
                        (20, "%.2f" % float(pk["area"])),
                        (13, "%d" % int(pk.get("gl", 30)))])
            click(button(dlg, "Accept"), settle=2.0)
        for path, kind in ((out_par, "Export (Peak Parameters)"), (out_spec, "Export (Spectrum)")):
            if not path:
                continue
            menu_click(fit, "Data", kind, settle=1.0)
            file_dialog(pid, None, path)
            time.sleep(0.8)
            _kill_strays(pid)
        u.SetForegroundWindow(int(proc))
        time.sleep(0.4)
        click(button(proc, "Save XPS"), settle=1.2)
        file_dialog(pid, DLG_OPEN, out_xps)
        time.sleep(1.0)
        _kill_strays(pid)
    finally:
        p.terminate()
    for f, name in ((out_xps, "xps"), (out_spec, "spectrum"), (out_par, "params")):
        if f and not os.path.exists(f):
            raise RuntimeError("%s 没写出: %s" % (name, f))
    return {"xps": out_xps, "xps_bytes": os.path.getsize(out_xps),
            "spectrum": out_spec, "params": out_par,
            "bg_type": bg_type, "bg_type_select": type_info,
            "peaks": [{"pos": float(k["pos"]), "fwhm": float(k["fwhm"]),
                       "area": float(k["area"]), "gl": int(k.get("gl", 30))} for k in peaks]}
