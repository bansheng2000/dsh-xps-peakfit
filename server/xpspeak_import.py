#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""XPSPeak .xps -> 模板草稿。

用法：
    py server/xpspeak_import.py --in <file.xps> --outdir <dir> --json
    py server/xpspeak_import.py --replay <dir> --in <name.xps> --outdir <dir> --json
    py server/xpspeak_import.py --stub-json <error.json> --json        # 仅供测试注入

设计约束（与插件侧约定）：
  * **不解析 .xps 二进制**。偏移随点数变，只信软件自己导出的文本。
  * 一切信息都来自 XPSPeak 的两次导出：
        Data > Export (Peak Parameters)  -> 峰位/面积/FWHM/%GL
        Data > Export (Spectrum)         -> B.E./Raw/Peak Sum/Background/Peak k/difference
  * GUI 只在 run_gui() 里；解析、背景判定、草稿生成都是纯函数，可用 --replay 夹具跑。
  * 背景判定复用 xps_fit.linear_bg / xps_fit.shirley_bg（lib/audit.js 的 shirleyBg 是同一算法的
    JS 移植，第九批逐点对拍过 0 差），不另写一套。

退出码（路由按 code 映射 HTTP）：
    0 ok / 3 xpspeak-not-found / 4 cannot-open / 5 no-peaks / 6 bad-export
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import xps_fit as F  # noqa: E402

# Windows 上把 stdout 接到管道时默认是 GBK/cp936，中文警告会抛 UnicodeEncodeError，
# 父进程只看到「没有输出可解析的 JSON」。这里把两条流钉成 UTF-8。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

BG_TOL_PCT = 0.5          # 与 audit 的 bg-shape 同一容差（量出来的：同类型最大 0.118%）
DRAFT_EXIT = {
    "xpspeak-not-found": 3,
    "cannot-open": 4,
    "no-peaks": 5,
    "bad-export": 6,
}

ELEMENT_RULES = [
    (re.compile(r"(?<![A-Za-z])Ni[\s_-]*2[\s_-]*p(?![A-Za-z])", re.I), "Ni", "2p"),
    (re.compile(r"(?<![A-Za-z])Co[\s_-]*2[\s_-]*p(?![A-Za-z])", re.I), "Co", "2p"),
    (re.compile(r"(?<![A-Za-z])Fe[\s_-]*2[\s_-]*p(?![A-Za-z])", re.I), "Fe", "2p"),
    (re.compile(r"(?<![A-Za-z])Mo[\s_-]*3[\s_-]*d(?![A-Za-z])", re.I), "Mo", "3d"),
    (re.compile(r"(?<![A-Za-z])S[\s_-]*2[\s_-]*p(?![A-Za-z])", re.I), "S", "2p"),
    (re.compile(r"(?<![A-Za-z])C[\s_-]*1[\s_-]*s(?![A-Za-z])", re.I), "C", "1s"),
    (re.compile(r"(?<![A-Za-z])O[\s_-]*1[\s_-]*s(?![A-Za-z])", re.I), "O", "1s"),
]


def suggest_from_name(name):
    """从文件名认元素与轨道（Ni2p / Ni 2p / ni2p 都认）；认不出就留空、由表单标红必填。"""
    stem = os.path.splitext(os.path.basename(name))[0]
    for rx, element, orbital in ELEMENT_RULES:
        if rx.search(stem):
            return {"element": element, "orbital": orbital, "category": "高分辨谱"}
    return {"element": "", "orbital": "", "category": ""}


# ---------------------------------------------------------------- 文本解析
def parse_peak_params(text):
    """解析 Export (Peak Parameters)：`idx  Position  Area  FWHM  %GL`。

    容错：表头被跳过；行内数值可以是空白分隔或制表符；多余列（如名字）忽略。
    返回 [{pos, area, fwhm, gl}]，按出现顺序。
    """
    out = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if line == "":
            continue
        tokens = re.split(r"[\s,;]+", line)
        nums = []
        bad = False
        for tok in tokens:
            try:
                nums.append(float(tok))
            except ValueError:
                bad = True
                break
        if bad or len(nums) < 4:
            continue
        # 有索引列时是 5 个：index position area fwhm gl
        if len(nums) >= 5:
            pos, area, fwhm, gl = nums[1], nums[2], nums[3], nums[4]
        else:
            pos, area, fwhm, gl = nums[0], nums[1], nums[2], nums[3]
        out.append({"pos": pos, "area": area, "fwhm": fwhm, "gl": gl})
    return out


def parse_spectrum(text):
    """解析 Export (Spectrum)。返回 {be, raw, peak_sum, bg, comps, diff, points, step_ev, range_ev}。

    表头形如 `B.E.(eV)  Raw Intensity  Peak Sum  Background  Peak 1 .. difference`；
    数据行列数固定，按空白切即可（数值里不会出现空格）。
    """
    be, raw, peak_sum, bg, diff = [], [], [], [], []
    comps = []  # 每列一条
    header_cols = None
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if line == "":
            continue
        low = line.lower()
        if header_cols is None and ("b.e" in low or "binding" in low or "raw" in low):
            header_cols = re.split(r"\s{2,}", line)
            continue
        toks = line.split()
        try:
            vals = [float(t) for t in toks]
        except ValueError:
            continue
        if len(vals) < 4:
            continue
        be.append(vals[0])
        raw.append(vals[1])
        peak_sum.append(vals[2])
        bg.append(vals[3])
        middle = vals[4:-1] if len(vals) >= 6 else []
        comps.append(middle)
        diff.append(vals[-1])
    if not be:
        return None
    ncomp = max((len(c) for c in comps), default=0)
    columns = [[c[i] for c in comps if len(c) > i] for i in range(ncomp)]
    steps = [abs(be[i] - be[i - 1]) for i in range(1, len(be))]
    steps = [s for s in steps if s > 0]
    step_ev = sorted(steps)[len(steps) // 2] if steps else 0.0
    return {
        "be": be,
        "raw": raw,
        "peak_sum": peak_sum,
        "bg": bg,
        "comps": columns,
        "diff": diff,
        "points": len(be),
        "step_ev": round(step_ev, 6),
        "range_ev": round(abs(be[0] - be[-1]), 6),
        "header_cols": header_cols or [],
    }


def classify_background(spec):
    """Background 列 vs 过两端点直线 / 重算 Shirley，按扣背景峰高归一取最大偏离。

    谁 < 0.5% 判谁；都不过 -> file（建区沿用谱自带背景），warnings 里写两个百分数。
    算法与 audit 的 bg-shape 同源：linear 用两端点连线的弦，shirley 用 xps_fit.shirley_bg
    （12 次迭代、端点线性插值）。
    """
    E = spec["be"]
    raw = spec["raw"]
    bg = spec["bg"]
    peak_h = 0.0
    for r, b in zip(raw, bg):
        peak_h = max(peak_h, r - b)
    if peak_h <= 0:
        peak_h = max(raw) - min(raw)
    peak_h = abs(peak_h) if peak_h else 1.0
    line = F.linear_bg(E, raw)
    shir = F.shirley_bg(E, raw)
    dev_lin = max(abs(bg[i] - line[i]) for i in range(len(bg)))
    dev_shir = max(abs(bg[i] - shir[i]) for i in range(len(bg)))
    pct_lin = 100.0 * dev_lin / peak_h
    pct_shir = 100.0 * dev_shir / peak_h
    if pct_lin < BG_TOL_PCT:
        kind = "linear"
    elif pct_shir < BG_TOL_PCT:
        kind = "shirley"
    else:
        kind = "file"
    return {
        "kind": kind,
        "dev_linear_cps": round(dev_lin, 3),
        "dev_shirley_cps": round(dev_shir, 3),
        "dev_linear_pct": round(pct_lin, 4),
        "dev_shirley_pct": round(pct_shir, 4),
        "peak_height_cps": round(peak_h, 3),
        "tolerance_pct": BG_TOL_PCT,
    }


def build_draft(peaks, spec, src_name, sha256=None):
    """按约定生成模板草稿（字段与 validateTemplate 对齐，不直接落库）。"""
    warnings = []
    if not peaks:
        return None, [{"code": "no-peaks", "message": "这份 .xps 里没有已定义的峰：先在 XPSPeak 里拟合并加峰，再上传。"}]
    centers = [p["pos"] for p in peaks]
    fwhms = [p["fwhm"] for p in peaks]
    max_fwhm = max(fwhms)
    total_area = sum(max(p["area"], 0.0) for p in peaks) or 1.0
    bg = classify_background(spec)
    if bg["kind"] == "file":
        warnings.append(
            "背景列既不像直线也不像 Shirley（对直线偏离 %.1f%%、对重算 Shirley 偏离 %.1f%%，容差 %.1f%%）："
            "按 file 保存，建区沿用谱自带背景。" % (bg["dev_linear_pct"], bg["dev_shirley_pct"], BG_TOL_PCT)
        )
    lo = min(centers) - 3.0 * max_fwhm
    hi = max(centers) + 3.0 * max_fwhm
    spec_lo = min(spec["be"])
    spec_hi = max(spec["be"])
    clipped = (lo < spec_lo) or (hi > spec_hi)
    lo = max(lo, spec_lo)
    hi = min(hi, spec_hi)
    if clipped:
        warnings.append(
            "拟合区按「首峰−3×FWHM、末峰+3×FWHM」推出来是 %.3f–%.3f eV，超出谱范围 %.3f–%.3f，已取交集。"
            % (min(centers) - 3.0 * max_fwhm, max(centers) + 3.0 * max_fwhm, spec_lo, spec_hi)
        )
    stem = os.path.splitext(os.path.basename(src_name))[0]
    peak_windows = []
    for p in peaks:
        share = 100.0 * max(p["area"], 0.0) / total_area
        peak_windows.append({
            "label": "峰 %d" % (len(peak_windows) + 1),
            "center_ev": round(p["pos"], 4),
            "eta": round(min(max(p["gl"] / 100.0, 0.0), 1.0), 4),
            "observed": {
                "fwhm_ev": round(p["fwhm"], 4),
                "gl_pct": round(p["gl"], 2),
                "area": round(p["area"], 3),
                "share_pct": round(share, 3),
            },
        })
    draft = {
        "name": stem,
        "element": "",
        "orbital": "",
        "category": "",
        "background": bg["kind"],
        "peak_windows": peak_windows,
        "fit_window_ev": {"lo": round(lo, 4), "hi": round(hi, 4)},
        "applicable_window_ev": round(spec["range_ev"], 4),
        "fwhm_min": max(round(min(fwhms) * 0.75, 4), 0.01),
        "fwhm_max": max(round(max_fwhm * 1.25, 4), 0.01),
        "constraints": {"area_ratio": 1, "equal_fwhm": False},
        "doublet_delta_ev": None,
        "charge_correction_ev": None,
        "provenance": {
            "source_file": os.path.basename(src_name),
            "points": spec["points"],
            "step_ev": spec["step_ev"],
            "range_ev": round(spec["range_ev"], 4),
            "sha256": sha256,
        },
    }
    # 让面板直接能填：认出来的元素/轨道/分类预填，认不出就留空由表单必填
    draft.update({k: v for k, v in suggest_from_name(src_name).items() if v})
    return draft, warnings


def draft_from_paths(peaks_path, spec_path, src_name, sha256=None):
    peaks = parse_peak_params(open(peaks_path, "r", encoding="utf-8", errors="replace").read())
    spec = parse_spectrum(open(spec_path, "r", encoding="utf-8", errors="replace").read())
    if spec is None:
        return None, [{"code": "bad-export", "message": "导出的 Spectrum 文本里没有可解析的数据行"}]
    return build_draft(peaks, spec, src_name, sha256)


# ---------------------------------------------------------------- GUI 层
def _error_dialog_text(D, pid):
    texts = []
    for h in D.dialogs(pid):
        try:
            t = D.text(h) or ""
        except Exception:
            continue
        if t and any(k in t.lower() for k in ("error", "cannot", "invalid", "fail", "not ")):
            texts.append(t)
        elif t and any(k in t for k in ("错误", "无法", "失败", "不是")):
            texts.append(t)
    return "\n".join(texts)


def run_gui(src, outdir, exe=None):
    """打开 .xps -> 导出 Peak Parameters 与 Spectrum。返回 (peaks_path, spec_path)。"""
    import xpspeak_drive as D  # 只在 GUI 路径上 import：--replay 时完全不碰 Win32

    exe = exe or os.environ.get("XPSPEAK_EXE") or D.EXE_DEFAULT
    if not exe or not os.path.exists(exe):
        raise ScriptError("xpspeak-not-found", "找不到 XPSPEAK41.exe：%s（设 XPSPEAK_EXE 指向真实可执行文件）" % exe)
    peaks_path = os.path.join(outdir, "peaks.dat")
    spec_path = os.path.join(outdir, "spectrum.dat")
    for p in (peaks_path, spec_path):
        if os.path.exists(p):
            os.remove(p)
    p = D.launch(exe)
    try:
        pid = p.pid
        proc = D.form(pid, D.FORM_PROC)
        fit = D.menu_form(pid)
        if not (proc and fit):
            raise ScriptError("cannot-open", "XPSPeak 窗体没起来（找不到 Processing/分峰窗口）")
        D.click(D.button(proc, "Open XPS"))
        D.file_dialog(pid, D.DLG_OPEN, os.path.normpath(src))
        time.sleep(1.5)
        D._kill_strays(pid)
        fit = D.menu_form(pid)
        if fit is None:
            raise ScriptError("cannot-open", "打开后找不到分峰窗口；可能的报错框：" + (_error_dialog_text(D, pid) or "（无）"))
        err = _error_dialog_text(D, pid)
        if err:
            raise ScriptError("cannot-open", "XPSPeak 报错：" + err)
        for path, kind in ((peaks_path, "Export (Peak Parameters)"), (spec_path, "Export (Spectrum)")):
            D.menu_click(fit, "Data", kind, settle=1.0)
            D.file_dialog(pid, None, path)
            time.sleep(0.8)
            D._kill_strays(pid)
    finally:
        try:
            p.terminate()
        except Exception:
            pass
    missing = [p for p in (peaks_path, spec_path) if not os.path.exists(p) or os.path.getsize(p) == 0]
    if missing:
        raise ScriptError("bad-export", "导出文件没写出：" + "、".join(os.path.basename(m) for m in missing))
    return peaks_path, spec_path


class ScriptError(Exception):
    def __init__(self, code, message):
        Exception.__init__(self, message)
        self.code = code
        self.message = message


# ---------------------------------------------------------------- CLI
def main(argv=None):
    ap = argparse.ArgumentParser(description="XPSPeak .xps -> 模板草稿")
    ap.add_argument("--in", dest="src", required=True, help="输入的 .xps（或原始文件名，用于 provenance）")
    ap.add_argument("--outdir", default=None, help="中间文件目录（导出文本落这里，用完由调用方删）")
    ap.add_argument("--replay", default=None, help="测试用：直接读这个目录里的 peaks.dat/spectrum.dat，跳过 GUI")
    ap.add_argument("--stub-json", default=None, help="测试用：跳过 GUI，直接输出这个 JSON 文件的内容")
    ap.add_argument("--exe", default=None, help="XPSPEAK41.exe 路径（默认取 XPSPEAK_EXE 或内置默认）")
    ap.add_argument("--source-name", dest="source_name", default=None,
                    help="原始文件名（写进 provenance；不给就用 --in 的 basename）")
    ap.add_argument("--json", action="store_true", help="stdout 最后一行输出单个 JSON")
    a = ap.parse_args(argv)

    def fail(code, message, extra=None):
        payload = {"ok": False, "code": code, "message": message}
        if extra:
            payload.update(extra)
        if a.json:
            print(json.dumps(payload, ensure_ascii=False))
        else:
            sys.stderr.write("%s: %s\n" % (code, message))
        return DRAFT_EXIT.get(code, 1)

    if a.stub_json:
        with open(a.stub_json, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
        print(json.dumps(payload, ensure_ascii=False))
        return 0 if payload.get("ok") else DRAFT_EXIT.get(payload.get("code", ""), 1)

    outdir = a.outdir or os.path.dirname(os.path.abspath(a.src)) or "."
    try:
        os.makedirs(outdir, exist_ok=True)
        sha = None
        if os.path.exists(a.src):
            h = hashlib.sha256()
            with open(a.src, "rb") as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b""):
                    h.update(chunk)
            sha = h.hexdigest()
        if a.replay:
            peaks_path = os.path.join(a.replay, "peaks.dat")
            spec_path = os.path.join(a.replay, "spectrum.dat")
            for p in (peaks_path, spec_path):
                if not os.path.exists(p):
                    return fail("bad-export", "夹具缺文件：%s" % p)
        else:
            peaks_path, spec_path = run_gui(a.src, outdir, a.exe)
        src_name = a.source_name or os.path.basename(a.src)
        draft, warnings = draft_from_paths(peaks_path, spec_path, src_name, sha)
        if draft is None:
            w = warnings[0] if warnings else {"code": "bad-export", "message": "草稿生成失败"}
            return fail(w["code"], w["message"])
        payload = {"ok": True, "draft": draft, "warnings": warnings, "sha256": sha}
        if a.json:
            print(json.dumps(payload, ensure_ascii=False))
        else:
            print("峰数 %d，背景 %s，拟合区 %.3f–%.3f eV"
                  % (len(draft["peak_windows"]), draft["background"],
                     draft["fit_window_ev"]["lo"], draft["fit_window_ev"]["hi"]))
            for w in warnings:
                print("WARN", w)
        return 0
    except ScriptError as exc:
        return fail(exc.code, exc.message)


if __name__ == "__main__":
    sys.exit(main())
