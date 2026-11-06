# -*- coding: utf-8 -*-
"""XPS 分峰拟合（纯标准库，不依赖 numpy/scipy）。

为什么需要它：XPSPeak 4.1 的 Optimise 是**无约束**优化 —— 实测（2026-10-22 MoS2/S 2p）
会把 2p1/2 伴线压到主峰面积的 1/6、FWHM 比主峰更窄，物理上错误；而且它把曲线数组存在
.xps 里，改参数不会重算曲线。要「带约束、可发表」的结果只能自己算；一次拟合是毫秒级，
比让 GUI 探针一步一步走（每步一次模型往返）快 3~4 个数量级。

模型：N 条自旋轨道双峰（2p/d 型）
  每条 = 主峰 + 伴峰（高结合能方向 +ds，面积 ratio 倍，同一 FWHM）
  线型 = 伪 Voigt（eta = %Lorentzian）；约束内建：Δ 固定、面积比固定、双峰等宽。
  自由参数只有每条的 (center, fwhm, height) —— 这就是可发表版本；放开约束的拟合
  可作为系统误差上界（--free 见 SKILL.md 的做法）。

用法：
  python xps_fit.py spec.dat --centers 162.09 --bg file
  python xps_fit.py spec.dat --centers 162.09,167.6 --scan 2 --csv curves.csv
  python xps_fit.py spec.dat --centers 162.09 --bg linear --csv out/curves.csv
自检（不需要谱图文件，合成数据回归；含「撞界」与「简并初值」两条回归）：
  python xps_fit.py --selftest

撞界：clamp 把参数夹到 ctol/wlo/whi/hmax 时，这些值就不再是「数据拟合出来的」。
发生时会进 res["bound"] 与每个组分的 res["comps"][i]["bounds"]，report() 打 * 并给汇总行 ——
出结论前必须先看这一行，否则会把边界值当成测量结果。
"""
import math, sys

LOG2 = math.log(2.0)
# 撞界判据：clamp 夹到边界时 |p-界| 精确为 0；没被夹住但落进 1e-6 相对容差的也算贴着边界。
# 1e-6*max(1,|界|) → whi=4 给 4e-6、hmax=120000 给 0.12，都远小于参数自身的打印精度，
# 所以正常收敛的参数不会被误判，而被夹住的参数一定命中。
BOUND_REL = 1e-6
BOUND_NAMES = ("center", "fwhm", "height")
BOUND_LABELS = ("峰位", "FWHM", "峰高")

# —— 拟合可信度的四道门（阈值依据见 SKILL.md「校验链」一节）——
# R²：0.90 / 0.85 这两档来自实测产物（模板搬移那种"只调高度"的拟合 R²≈0.874）。
#   0.90 以上才配叫"拟合得像"；0.85 以下残差已经和信号同量级，模型与数据不是一件事。
R2_WARN = 0.90
R2_BLOCK = 0.85
# 残差按窗口四段取均值：任一段 |均值| > 0.5×rms 说明残差不是随机的，是系统性偏移
#   （实测那份第二段 1.22×rms：四段均值 -1131 / -2590 / -808 / -174 cps，rms 2116）。
RESID_SEG_RATIO = 0.5
RESID_SEGMENTS = 4
# 峰顶缺口：max|data-fit| / 峰高。实测 6070/60963 = 10.0%，正好在阻断线上。
PEAK_GAP_WARN = 0.05
PEAK_GAP_BLOCK = 0.10
# 背景形状：linear 模板时，导出谱的 Background 列必须真的是一条直线。
#   容差 0.5% 峰高 —— 实测那份台阶背景偏离 +2567/-2872 = 峰高 26352 的 10.9%，远超这条线。
BG_SHAPE_TOL = 0.005


def load(path, bg_col=4):
    """读谱图：空白/逗号分隔的数值表。列序 = BE, Raw, [PeakSum], [Background], ...
    bg_col=4 表示第 4 列（1 起）是背景（XPSPeak 导出格式）。返回 (E, raw, bg|None)，
    E 按结合能**降序**排列（高 BE -> 低 BE，Shirley 累加方向）。"""
    rows = []
    for ln in open(path, encoding="utf-8", errors="replace"):
        t = ln.replace(",", " ").split()
        if not t:
            continue
        try:
            v = [float(x) for x in t]
        except ValueError:
            continue                      # 表头 / 文本行
        if len(v) >= 2:
            rows.append(v)
    if len(rows) < 10:
        raise ValueError("可用数据点太少: %d" % len(rows))
    ncol = min(len(r) for r in rows)
    rows.sort(key=lambda r: -r[0])
    E = [r[0] for r in rows]
    raw = [r[1] for r in rows]
    bg = [r[bg_col - 1] for r in rows] if (bg_col and ncol >= bg_col) else None
    return E, raw, bg, ncol


def linear_bg(E, raw):
    """两端点连线的线性背景（无 XPSPeak 背景列时的兜底）。"""
    y0, y1 = raw[0], raw[-1]
    span = (E[-1] - E[0]) or 1.0
    return [y0 + (y1 - y0) * (e - E[0]) / span for e in E]


def shirley_bg(E, raw, iters=12):
    """迭代 Shirley 背景（自高 BE 向低 BE 累加剩余峰面积）。只用于没有文件自带背景时。"""
    lo, hi = min(raw), max(raw)
    bg = [min(hi, max(lo, y)) for y in raw]        # 初值 = 数据本身
    n = len(raw)
    for _ in range(iters):
        sig = [raw[i] - bg[i] for i in range(n)]
        acc, S = 0.0, []
        for i in range(n - 1, -1, -1):             # 高 BE -> 低 BE
            acc += max(0.0, sig[i])
            S.append(acc)
        S.reverse()
        tot = S[0] or 1.0
        a, b = raw[-1], raw[0]                     # 低 BE 端 / 高 BE 端强度
        bg = [a + (b - a) * (S[i] / tot) for i in range(n)]
    return bg


def gl(x, c, w, h, eta):
    """伪 Voigt（按高度归一）：h=峰高，w=FWHM，eta=Lorentzian 分数。"""
    t = (x - c) / w
    g = math.exp(-4.0 * LOG2 * t * t)
    l = 1.0 / (1.0 + 4.0 * t * t)
    return h * (eta * l + (1.0 - eta) * g)


def area_factor(eta):
    """高度 -> 面积（单位 FWHM*高度）的换算系数。"""
    return eta * math.pi / 2.0 + (1.0 - eta) * math.sqrt(math.pi / (4.0 * LOG2))


def eta_list(eta, nc):
    """eta 可以是标量（全部峰同值）或长度 nc 的序列（逐峰 %Lorentzian）。

    逐峰是必须的：实测谱里主峰 %GL 40–50%、卫星常到 100%，用一个标量会把卫星压成主峰的形状。
    """
    if isinstance(eta, (list, tuple)):
        if len(eta) != nc:
            raise ValueError("eta 序列长度 %d != 峰数 %d" % (len(eta), nc))
        out = []
        for i, v in enumerate(eta):
            if not (0.0 <= float(v) <= 1.0):
                raise ValueError("eta[%d]=%r 必须在 0–1" % (i, v))
            out.append(float(v))
        return out
    v = float(eta)
    if not (0.0 <= v <= 1.0):
        raise ValueError("eta=%r 必须在 0–1" % (eta,))
    return [v] * nc


def model_at(x, p, nc, ds, ratio, eta):
    et = eta_list(eta, nc)
    y = 0.0
    for k in range(nc):
        c, w, h = p[3 * k], p[3 * k + 1], p[3 * k + 2]
        y += gl(x, c, w, h, et[k]) + gl(x, c + ds, w, h * ratio, et[k])
    return y


def _solve(A, b):
    """高斯消元（部分选主元），A 为小方阵。"""
    n = len(b)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(M[r][col]))
        if abs(M[piv][col]) < 1e-300:
            return None
        M[col], M[piv] = M[piv], M[col]
        for r in range(col + 1, n):
            f = M[r][col] / M[col][col]
            if f:
                for k in range(col, n + 1):
                    M[r][k] -= f * M[col][k]
    x = [0.0] * n
    for i in range(n - 1, -1, -1):
        s = M[i][n] - sum(M[i][j] * x[j] for j in range(i + 1, n))
        x[i] = s / M[i][i]
    return x


def _inv(A):
    n = len(A)
    M = [list(A[i]) + [1.0 if i == j else 0.0 for j in range(n)] for i in range(n)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(M[r][col]))
        if abs(M[piv][col]) < 1e-300:
            return None
        M[col], M[piv] = M[piv], M[col]
        d = M[col][col]
        M[col] = [v / d for v in M[col]]
        for r in range(n):
            if r != col and M[r][col]:
                f = M[r][col]
                M[r] = [a - f * b for a, b in zip(M[r], M[col])]
    return [row[n:] for row in M]


def _widx(E, lo, hi):
    """拟合窗口的索引（按**结合能值**取，lo/hi 单位 eV，与 E 的升/降序无关）。

    lo=None 且 hi=None → 全谱（返回 None，向后兼容）。
    窗口必须两端都给：只给一端无法确定区间；lo>=hi 视为写反/写错，直接报错而不是猜一个方向。
    """
    if lo is None and hi is None:
        return None
    if lo is None or hi is None:
        raise ValueError("窗口必须同时给 lo 和 hi（eV）；只给一端无法确定区间")
    if lo >= hi:
        raise ValueError("窗口下界 lo=%.4f 必须小于上界 hi=%.4f（单位 eV）" % (lo, hi))
    idx = [i for i, e in enumerate(E) if lo <= e <= hi]
    if len(idx) < 10:
        raise ValueError("窗口 [%.4f, %.4f] eV 内只有 %d 个点，至少要 10 个；"
                         "检查 lo/hi 是否写反、或超出扫描范围 [%.3f, %.3f]"
                         % (lo, hi, len(idx), min(E), max(E)))
    return idx


def _constraint_warnings(centers, ds, ratio):
    """ds/ratio 与初值明显不匹配时的提示（只提示，不改默认值，也不改拟合结果）。"""
    L = []
    cs = sorted(centers)
    gaps = [b - a for a, b in zip(cs, cs[1:])]
    gap = min(gaps) if gaps else None
    if ds < 2.0 and gap is not None and gap >= 2.0:
        L.append("⚠ 初值最小间距 %.2f eV，但 ds=%.2f 是 2p 口径（1.16-1.20）：若这是 3d 双线（3.1-3.2）"
                 "或 4f（~5.2），请改 ds —— 否则伴线位置本身就放错了" % (gap, ds))
    if ds >= 2.5 and abs(ratio - 0.5) < 1e-9:
        L.append("⚠ ds=%.2f 像 d 轨道（3d 劈裂 3.1-3.2），但 ratio=0.50 是 p 轨道的 1:2 口径；"
                 "d 轨道分支比通常 2:3（0.667），请确认 ratio" % ds)
    return L


def fit(E, raw, bg, centers, ds=1.18, ratio=0.5, eta=0.3,
        ctol=1.0, wlo=0.6, whi=4.0, hmax=120000.0, iters=400, lo=None, hi=None):
    """带约束的 LM 拟合。返回 dict（含每组分参数±σ、rms、R²、AIC、残差、撞界清单）。

    撞界见模块顶部说明：res["bound"] 列出顶到边界的参数，report()/MCP 文本都会显式写出。
    lo/hi（eV）限定拟合窗口；窗口内重取两端作为基线端点，窗口外完全不参与。
    """
    win = (lo, hi)          # lo/hi 下面会被参数上下界复用，先把窗口参数存下来
    idx = _widx(E, lo, hi)
    if idx is not None:
        E = [E[i] for i in idx]; raw = [raw[i] for i in idx]; bg = [bg[i] for i in idx]
    nc = len(centers)
    et = eta_list(eta, nc)
    # 初值间距 < 0.5×ctol（= 峰位自由区的半宽）时两个组分不可分辨：LM 会把同一个峰劈成两半、
    # 各报 50%，而 50/50 是初值造成的、不是数据支撑的。0.5 eV 也远小于任何有物理意义的化学态
    # 位移（2p 双线 1.18 eV、3d 3.2 eV），所以真双峰不会被误拒。直接报错，不给一个看着正常的假结果。
    min_sep = 0.5 * ctol
    cs = sorted(centers)
    for c1, c2 in zip(cs, cs[1:]):
        if c2 - c1 < min_sep:
            raise ValueError(
                "初值峰位 %.4f 与 %.4f 相距 %.4f eV < %.4f eV（= 0.5×ctol）：两个组分不可分离 —— "
                "拟合会把同一个峰劈成两半、各报 50%%，占比不能作化学态依据。"
                "请合并成一个 center，或显式放大 ctol 后再试。" % (c1, c2, c2 - c1, min_sep))
    target = [raw[i] - bg[i] for i in range(len(raw))]
    p = []
    for c in centers:
        p += [c, 1.0, 45000.0 / nc]
    lo, hi = [], []
    for c in centers:
        lo += [c - ctol, wlo, 0.0]
        hi += [c + ctol, whi, hmax]
    clamp = lambda q: [min(max(v, lo[i]), hi[i]) for i, v in enumerate(q)]
    # 初值也必须落进 [lo,hi]：默认初值 FWHM=1.0 遇到 wlo=1.5 时已经在界外，
    # 若 LM 一次都不接受步进，p 就停在界外、撞界检查（只比 p 与界）也发现不了 ——
    # 结果是「参数越界但 res["bound"] 为空」，preflight 会放行一份不可信的结果。
    p = clamp(p)
    p0 = list(p)            # 初值（clamp 之后）：preflight 用它抓「初值就是终值、参数根本没动」

    def resid(q):
        return [target[i] - model_at(E[i], q, nc, ds, ratio, eta) for i in range(len(E))]

    def jac(q):
        J = []
        cols = []
        for j in range(len(q)):
            d = max(1e-5, 1e-5 * abs(q[j]))
            qp = q[:]; qp[j] += d
            qm = q[:]; qm[j] -= d
            cols.append([(model_at(E[i], qp, nc, ds, ratio, eta) - model_at(E[i], qm, nc, ds, ratio, eta)) / (2 * d)
                         for i in range(len(E))])
        for i in range(len(E)):
            J.append([cols[j][i] for j in range(len(q))])
        return J

    r = resid(p)
    sse = sum(v * v for v in r)
    lam = 1e-3
    for _ in range(iters):
        J = jac(p)
        k = len(p)
        JtJ = [[sum(J[i][a] * J[i][b] for i in range(len(J))) for b in range(k)] for a in range(k)]
        Jtr = [sum(J[i][a] * r[i] for i in range(len(J))) for a in range(k)]
        damped = [[JtJ[a][b] + (lam * JtJ[a][a] if a == b and JtJ[a][a] > 0 else (lam if a == b else 0.0))
                   for b in range(k)] for a in range(k)]
        step = _solve(damped, Jtr)
        if step is None:
            break
        cand = clamp([p[i] + step[i] for i in range(k)])
        rc = resid(cand)
        sse_c = sum(v * v for v in rc)
        if sse_c < sse:
            moved = max(abs(cand[i] - p[i]) for i in range(k))
            prev = sse
            p, r, sse = cand, rc, sse_c
            lam = max(lam * 0.3, 1e-12)
            # 注意：判据必须用 prev，不能用已被覆盖的 sse（否则第一次迭代就误判"已收敛"）
            if moved < 1e-10 or (prev - sse) <= 1e-12 * prev:
                break
        else:
            lam *= 5.0
            if lam > 1e12:
                break

    n, k = len(E), len(p)
    J = jac(p)
    JtJ = [[sum(J[i][a] * J[i][b] for i in range(n)) for b in range(k)] for a in range(k)]
    inv = _inv(JtJ)
    s2 = sse / max(1, n - k)
    sig = [math.sqrt(abs(inv[j][j] * s2)) if inv else float("nan") for j in range(k)]
    # 撞界：p 与 lo/hi 比对（判据见模块顶部 BOUND_REL）。
    bound, atb = [], {}
    for j, v in enumerate(p):
        for side, lim in (("lo", lo[j]), ("hi", hi[j])):
            if abs(v - lim) <= BOUND_REL * max(1.0, abs(lim)):
                i, f = divmod(j, 3)
                bound.append(dict(comp=i + 1, param=BOUND_NAMES[f], label=BOUND_LABELS[f],
                                  side=side, value=float(v), limit=float(lim)))
                atb.setdefault(i, []).append(BOUND_NAMES[f])
                break
    # 未优化参数：终值与初值（clamp 后）完全一致、且不在边界上 —— 等于写死，不是拟合出来的。
    # 与撞界的区别：撞界的值由约束决定（已顶到界），这里抓的是 LM 一步都没接受、参数纹丝不动。
    not_opt = []
    for j, v in enumerate(p):
        if abs(v - p0[j]) >= 1e-6:
            continue
        at_bound = any(abs(v - lim) <= BOUND_REL * max(1.0, abs(lim)) for lim in (lo[j], hi[j]))
        if not at_bound:
            i, f = divmod(j, 3)
            not_opt.append(dict(comp=i + 1, param=BOUND_NAMES[f], label=BOUND_LABELS[f],
                                value=float(v), init=float(p0[j])))
    mean_t = sum(target) / n
    # 闸用扣背景口径：target = raw - bg（见上），sst 是「扣背景后的起伏」。
    # raw 口径只作信息：背景能占计数一大半，raw R² 天然接近 1 —— 同一份实测产物
    # raw 0.9152 判 pass，扣背景 0.8683 才与 XPSPeak 自己保存的 0.868272 同刻度。
    sst = sum((t - mean_t) ** 2 for t in target)
    mean_raw = sum(raw) / n
    sst_raw = sum((v - mean_raw) ** 2 for v in raw)
    comps = []
    for i in range(nc):
        c, w, h = p[3 * i], p[3 * i + 1], p[3 * i + 2]
        af = area_factor(et[i]) * (1.0 + ratio)
        area = h * w * af
        # σ_area 传播：area = h·w·af（af 只依赖 eta，与峰位无关）。只保留真正进公式的两项：
        #   · 补上 height 项 —— 原来漏了，σ 系统性偏小（本次修正的主项）；
        #   · 去掉 center 项 —— 峰位不参与面积公式，原来那一项是错项。
        # 两项按独立处理（不做协方差修正）：h 与 w 在 LM 里通常正相关，忽略协方差项得到的是
        # 偏大的保守上界；宁可报大一点，也不要报一个看起来更精的偏小 σ。
        s_area = area * math.sqrt((sig[3 * i + 1] / w if w else 0.0) ** 2
                                  + (sig[3 * i + 2] / h if h else 0.0) ** 2)
        comps.append(dict(center=round(c, 4), center_err=round(sig[3 * i], 4),
                          partner=round(c + ds, 4), fwhm=round(w, 4), fwhm_err=round(sig[3 * i + 1], 4),
                          height=round(h, 1), area=round(area, 1), area_err=round(s_area, 1),
                          eta=et[i], bounds=atb.get(i, [])))
    tot = sum(c["area"] for c in comps) or 1.0
    for c in comps:
        c["pct"] = round(100.0 * c["area"] / tot, 2)
        c["ratio"] = round(c["area"] / comps[0]["area"], 4) if comps[0]["area"] else None
    par = [c["center"] + ds for c in comps]
    for c, pv in zip(comps, par):
        c["partner"] = round(pv, 4)
    return dict(nc=nc, n=n, k=k, ds=ds, ratio=ratio, eta=(et if isinstance(eta, (list, tuple)) else et[0]), eta_list=et,
                rms=round(math.sqrt(sse / n), 2),
                r2=round(1.0 - sse / sst, 6) if sst else None,          # 扣背景口径：闸用这个
                r2_raw=round(1.0 - sse / sst_raw, 6) if sst_raw else None,  # 原始计数口径：只作信息
                aic=round(n * math.log(sse / n) + 2 * k, 2), sse=round(sse, 2),
                comps=comps, params=[float(v) for v in p], params_err=[round(v, 6) for v in sig], bound=bound,
                p0=[float(v) for v in p0], not_optimized=not_opt,
                warnings=_constraint_warnings(centers, ds, ratio),
                window=dict(lo=win[0], hi=win[1]), n_points=len(E),
                limits=dict(ctol=ctol, wlo=wlo, whi=whi, hmax=hmax), peak_max=round(max(target), 1),
                curves=dict(E=E, target=target, fit=[target[i] - r[i] for i in range(n)], resid=r))


def resid_segments(res, nseg=RESID_SEGMENTS):
    """残差按窗口等分 nseg 段，返回每段均值（最后一段吃掉除不尽的余数）。"""
    r = (res.get("curves") or {}).get("resid") or []
    if len(r) < nseg:
        return []
    step = len(r) // nseg
    out = []
    for k in range(nseg):
        seg = r[k * step:(k + 1) * step] if k < nseg - 1 else r[k * step:]
        out.append(sum(seg) / len(seg))
    return out


def peak_gap_ratio(res):
    """峰顶缺口：max|data − fit| / 峰高（扣背景后的峰顶）。峰高未知返回 None。"""
    resid = (res.get("curves") or {}).get("resid") or []
    pm = res.get("peak_max")
    if not resid or not pm:
        return None
    return max(abs(v) for v in resid) / float(pm)


def bg_shape_check(bgcol, height, tol=BG_SHAPE_TOL):
    """linear 模板专用：导出的 Background 列是否真是一条直线（两端点连线）。

    只看「拟合用了哪种背景」不够：XPSPeak 保存/建区域时可能沿用源谱自带背景，
    于是图上是直线、文件里是台阶（实测 857.0 偏 +2567、851.0 偏 −2872 = 峰高 26352 的 10.9%）。
    容差 tol×峰高；超了就是「文件里的背景与拟合用的不是同一件事」。
    """
    vals = [float(v) for v in (bgcol or [])]
    n = len(vals)
    if n < 3:
        return dict(ok=True, reason="背景列不足 3 点，跳过")
    y0, y1 = vals[0], vals[-1]
    devs = [abs(vals[i] - (y0 + (y1 - y0) * i / (n - 1))) for i in range(n)]
    mx = max(devs)
    lim = tol * max(1.0, float(height or 0.0))
    return dict(ok=mx <= lim, max_dev=round(mx, 1), at_index=devs.index(mx), limit=round(lim, 1),
                pct_of_height=round(100.0 * mx / float(height), 2) if height else None)


def preflight(res, E=None, bg_used=None, expect_bg=None, edge_ratio=3.0, bg_col=None):
    """保存/建区域前的**硬前置**：不通过就不许落盘。

    六条（缺一条都可能存出一份「看着完整、其实不可信」的 .xps）：
      1. 撞界：res["bound"] 非空 → 参数顶在边界上，值是约束决定的、不是数据拟合出来的；
      2. 背景不一致：模板说 linear、实际用了谱图自带（或反之）→ `background` 字段只影响拟合，
         不影响保存文件里的背景，两者对不上时结论与图就不是一件事；
      3. 边界截断：峰心距谱两端 < edge_ratio×FWHM → 尾部被切掉，面积只是当前窗口的积分；
      4. 未优化参数：终值 = 初值且不在界上 → 参数根本没动，等于写死；
      5. 优度与残差结构：R² < 0.85 阻断、< 0.90 警告；残差四段任一段 |均值| > 0.5×rms 阻断（系统性偏移）；
      6. 峰顶缺口：max|data−fit|/峰高 > 10% 阻断、> 5% 警告；linear 模板还要核「文件里的背景列是不是直线」。

    返回 {"ok": bool, "errors": [...], "warnings": [...]}。errors 非空 → 调用方必须中止、不写文件。
    """
    errors, warnings = [], []
    b = res.get("bound") or []
    if b:
        lines = ["组分%d %s=%g（%s 边界）" % (x["comp"], x["param"], x["value"], x["side"]) for x in b]
        errors.append("撞界 %d 项：%s。先改初值、放宽 ctol 或 wlo/whi 后重跑，别拿这份参数保存。"
                      % (len(b), "；".join(lines)))

    if expect_bg and bg_used and expect_bg != bg_used:
        if expect_bg == "tougaard" and bg_used == "file":
            warnings.append("模板背景是 tougaard，xps_fit 没有这一项，实际按 file（谱图自带背景）处理 —— 报告里必须写明。")
        else:
            errors.append("背景不一致：模板要求 %s，实际用了 %s。`background` 字段只管拟合，不改变保存文件里的背景。"
                          % (expect_bg, bg_used))

    if res.get("not_optimized"):
        items = "；".join("组分%d %s=%g（初值 %g）" % (x["comp"], x["label"], x["value"], x["init"])
                          for x in res["not_optimized"])
        errors.append("参数未被优化（初值=终值且不在界上）：%s —— 这几项等于写死，不是拟合出来的，不能出结论。"
                      % items)

    r2 = res.get("r2")
    if r2 is not None:
        if r2 < R2_BLOCK:
            errors.append("R²(扣背景)=%.4f < %.2f：残差与信号同量级，模型与数据不是一件事，不能出结论。"
                          "（raw 口径 %.4f 只作参考：背景占比越高它越虚高，不能拿来判优劣）"
                          % (r2, R2_BLOCK, res.get("r2_raw") if res.get("r2_raw") is not None else float("nan")))
        elif r2 < R2_WARN:
            warnings.append("R²(扣背景)=%.4f < %.2f：优度不足，结论只能标「不足以判定」并写清缺什么。"
                            "（raw 口径 %.4f 只作参考）"
                            % (r2, R2_WARN, res.get("r2_raw") if res.get("r2_raw") is not None else float("nan")))

    segs = resid_segments(res)
    rms = float(res.get("rms") or 0.0)
    if segs and rms > 0:
        bad = [i + 1 for i, m in enumerate(segs) if abs(m) > RESID_SEG_RATIO * rms]
        if bad:
            errors.append("残差按窗口 %d 段取均值：%s；第 %s 段 |均值| > %.1f×rms(%.1f) —— 系统性偏移，"
                          "模型与数据不是一件事。"
                          % (len(segs), " / ".join("%.0f" % m for m in segs),
                             "、".join(str(i) for i in bad), RESID_SEG_RATIO, rms))

    gap = peak_gap_ratio(res)
    if gap is not None:
        if gap > PEAK_GAP_BLOCK:
            errors.append("峰顶缺口 %.1f%% > %.0f%%：max|data−fit| / 峰高 过大，峰形没对上"
                          "（常见于把模板峰形搬过去只调高度）。" % (100.0 * gap, 100.0 * PEAK_GAP_BLOCK))
        elif gap > PEAK_GAP_WARN:
            warnings.append("峰顶缺口 %.1f%% > %.0f%%：峰顶差得偏多，面积与峰高要打折看。"
                            % (100.0 * gap, 100.0 * PEAK_GAP_WARN))

    if expect_bg == "linear" and bg_col:
        bs = bg_shape_check(bg_col, res.get("peak_max"))
        if not bs.get("ok"):
            errors.append("背景形状不符：模板是 linear，但导出谱 Background 列偏离两端直线 %.0f cps"
                          "（第 %d 点，= 峰高 %.1f%%，容差 %.2f%%）—— 文件里的背景不是拟合用的那条直线。"
                          % (bs["max_dev"], bs["at_index"], bs["pct_of_height"] or 0.0, 100.0 * BG_SHAPE_TOL))

    if E:
        lo, hi = min(E), max(E)
        for i, c in enumerate(res.get("comps") or []):
            fw = float(c.get("fwhm") or 0.0)
            if fw <= 0:
                continue
            left = float(c["center"]) - lo
            right = hi - float(c.get("partner", c["center"]))
            near = min(left, right)
            if near < edge_ratio * fw:
                warnings.append("组分%d（%.2f eV）峰心距谱端不到 %.0f×FWHM（实测 %.2f×）：尾部被截断，面积只按当前窗口积分。"
                                % (i + 1, float(c["center"]), edge_ratio, near / fw))
    return {"ok": not errors, "errors": errors, "warnings": warnings}


def preflight_text(pf):
    """把 preflight 结果排成人读的两行：⛔ 逐条错误 / ⚠ 逐条警告。"""
    out = []
    for e in pf.get("errors") or []:
        out.append("⛔ " + e)
    for w in pf.get("warnings") or []:
        out.append("⚠ " + w)
    return "\n".join(out)


def bound_text(res):
    """撞界的汇总文本。report()（CLI）与 MCP 的 xpspeak_fit 都走它，保证两条路都会显式写出来。"""
    b = res.get("bound") or []
    if not b:
        return ""
    def _v(x):
        return ("%.0f" % x) if abs(x) >= 1000 else ("%.4g" % x)
    items = "、".join("组分%d %s=%s（%s %s）" % (x["comp"], x["label"], _v(x["value"]),
                                              "下限" if x["side"] == "lo" else "上限", _v(x["limit"]))
                     for x in b)
    L = ["⚠ 撞界: %d 个参数顶到上下界 —— %s" % (len(b), items),
         "⚠ 顶界的参数由约束决定、不是数据拟合出来的 —— 结论不可信（先改初值/放宽 ctol，或减少峰数）"]
    lim, pm = res.get("limits") or {}, res.get("peak_max") or 0.0
    if any(x["param"] == "height" and x["side"] == "hi" for x in b) and pm > (lim.get("hmax") or 0):
        L.append("⚠ 输入峰值 %.0f 超过 hmax=%.0f（默认上限）：曲线被截断，R²/面积此刻不可用，"
                 "请显式提高 hmax 再拟合" % (pm, lim["hmax"]))
    if any(x["param"] == "fwhm" and x["side"] == "lo" for x in b):
        L.append("⚠ FWHM 顶到 wlo=%.2f：谱里可能有更窄的峰，请降低 wlo（否则 FWHM 只是被压平的假值）"
                 % (lim.get("wlo") or 0))
    return "\n".join(L)


def report(res, head="", include_bounds=True, include_warnings=True):
    L = [head] if head else []
    et = res.get("eta_list") or [res.get("eta", 0.3)]
    eta_txt = "%.2f" % et[0] if len(set(et)) == 1 else "/".join("%.2f" % v for v in et)
    L.append("模型: %d 条双峰（Δ=%.3f eV, 面积比 1:%.2f, 等宽, eta=%s）  n=%d  k=%d"
             % (res["nc"], res["ds"], res["ratio"], eta_txt, res["n"], res["k"]))
    L.append("拟合优度: rms=%.2f cps   R²(扣背景)=%s   R²(raw)=%s   AIC=%.2f"
             % (res["rms"], res["r2"], res.get("r2_raw"), res["aic"]))
    w = res.get("window") or {}
    if w.get("lo") is not None:
        L.append("窗口: %.3f – %.3f eV（%d 点，基线的两个端点在窗口内重取）"
                 % (w["lo"], w["hi"], res.get("n_points") or res["n"]))
    if include_warnings:
        for msg in (res.get("warnings") or []):
            L.append(msg)
    for i, c in enumerate(res["comps"], 1):
        bd = set(c.get("bounds") or ())
        st = lambda nm: "*" if nm in bd else ""
        L.append("  组分%d: %.3f%s±%.3f eV (伴线 %.3f)  FWHM %.3f%s±%.3f  area %.0f±%.0f (%.1f%%)  h=%.0f%s"
                 % (i, c["center"], st("center"), c["center_err"], c["partner"],
                    c["fwhm"], st("fwhm"), c["fwhm_err"],
                    c["area"], c["area_err"], c["pct"], c["height"], st("height")))
    rs = res["curves"]["resid"]
    L.append("残差: 均值 %.1f  sd %.1f  最大 |%.0f|" % (sum(rs) / len(rs), math.sqrt(sum(v * v for v in rs) / len(rs)),
                                                     max(abs(v) for v in rs)))
    if res.get("bound"):
        L.append("（* = 该参数顶到了上下界，不是数据拟合出来的值）")
    if include_bounds:
        bt = bound_text(res)
        if bt:
            L.append(bt)
    return "\n".join(L)


def write_csv(path, res):
    E, t, f, r = res["curves"]["E"], res["curves"]["target"], res["curves"]["fit"], res["curves"]["resid"]
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write("BE_eV,Signal,Fit,Resid\n")
        for i in range(len(E)):
            fh.write("%.4f,%.2f,%.2f,%.2f\n" % (E[i], t[i], f[i], r[i]))
    return path


def run(path, centers, bg_kind="file", bg_col=4, ds=1.18, ratio=0.5, eta=0.3, csv=None, scan=0,
        ctol=1.0, wlo=0.6, whi=4.0, hmax=120000.0, lo=None, hi=None):
    E, raw, bgcol, ncol = load(path, bg_col)
    # 窗口在算背景之前就切：linear/shirley 的端点必须取窗口两端，否则窗口外的峰肩会把基线带飞。
    idx = _widx(E, lo, hi)
    if idx is not None:
        E = [E[i] for i in idx]; raw = [raw[i] for i in idx]
        bgcol = [bgcol[i] for i in idx] if bgcol else None
    if bg_kind == "file":
        if bgcol is None:
            raise ValueError("文件只有 %d 列，没有背景列；请用 --bg linear|shirley|none" % ncol)
        bg = bgcol
    elif bg_kind == "linear":
        bg = linear_bg(E, raw)
    elif bg_kind == "shirley":
        bg = shirley_bg(E, raw)
    elif bg_kind == "none":
        bg = [0.0] * len(raw)
    else:
        raise ValueError("bg 只支持 file / linear / shirley / none")
    res = fit(E, raw, bg, centers, ds, ratio, eta, ctol, wlo, whi, hmax, lo=lo, hi=hi)
    if scan:
        for nc in range(1, min(scan, len(centers)) + 1):
            res["scan%d" % nc] = {k: v for k, v in
                                  fit(E, raw, bg, centers[:nc], ds, ratio, eta, ctol, wlo, whi, hmax,
                                      lo=lo, hi=hi).items()
                                  if k in ("nc", "n", "k", "rms", "r2", "aic", "bound")}
    if csv:
        write_csv(csv, res)
    return res      # 保留 curves（report/写图要用）；序列化前自行剔除


def selftest():
    """合成一条双峰谱（真值 162.00 / FWHM 0.95 / 面积 80000），验证能拟合回来。"""
    ds, ratio, eta = 1.18, 0.5, 0.3
    E = [175.9 - 0.1 * i for i in range(181)]
    truth = [162.0, 0.95, 54000.0]
    raw, bg = [], []
    for e in E:
        b = 5900.0 - 3.0 * (e - 158.0)
        bg.append(b)
        raw.append(b + model_at(e, truth, 1, ds, ratio, eta))
    res = fit(E, raw, bg, [162.05], ds, ratio, eta)
    c = res["comps"][0]
    area_truth = 54000.0 * 0.95 * area_factor(eta) * (1 + ratio)
    assert abs(c["center"] - 162.0) < 0.01, c
    assert abs(c["fwhm"] - 0.95) < 0.02, c
    assert abs(c["area"] - area_truth) / area_truth < 0.03, (c["area"], area_truth)
    # 两个 R² 都必须出：r2 是扣背景口径（闸用），r2_raw 是原始计数口径（只作信息）。
    assert "r2" in res and "r2_raw" in res, sorted(res)
    assert res["r2"] > 0.9999, res["r2"]
    assert res["r2_raw"] >= res["r2"], (res["r2_raw"], res["r2"])  # 背景非零时 raw 门槛更松
    print("selftest OK: center %.3f (真值 162.000)  FWHM %.3f (0.950)  area %.0f (%.0f)  R²(扣背景) %.6f  r2_raw %.6f"
          % (c["center"], c["fwhm"], c["area"], area_truth, res["r2"], res["r2_raw"]))

    # --- P0-1/P0-3 回归：撞界必须显式标出（峰高超默认 hmax + FWHM 低于默认 wlo）---
    E2 = [166.0 - 0.02 * i for i in range(301)]
    raw2 = [model_at(e, [163.0, 0.35, 200000.0], 1, ds, ratio, eta) for e in E2]
    r2 = fit(E2, raw2, [0.0] * len(E2), [163.05], ds, ratio, eta)
    bt = bound_text(r2)
    assert bt, "峰高 200000 / FWHM 0.35 明明顶到 hmax/wlo，却没有撞界标注"
    assert "结论不可信" in bt and "hmax" in bt and "wlo" in bt, bt
    assert r2["comps"][0]["bounds"], r2["comps"]
    assert "*" in report(r2), report(r2)

    # --- P0-1 反向：正常谱不许误报撞界 ---
    E3 = [175.9 - 0.1 * i for i in range(181)]
    bg3 = [5900.0 - 3.0 * (e - 158.0) for e in E3]
    raw3 = [bg3[i] + model_at(E3[i], [162.0, 0.95, 54000.0], 1, ds, ratio, eta) for i in range(len(E3))]
    r3 = fit(E3, raw3, bg3, [162.05], ds, ratio, eta)
    assert not r3["bound"], r3["bound"]

    # --- P0-2 回归：简并初值必须被拒绝 ---
    try:
        fit(E3, raw3, bg3, [162.0, 162.0], ds, ratio, eta)
    except ValueError as e:
        assert "不可分离" in str(e), e
    else:
        raise AssertionError("简并初值（162.0 / 162.0）没有被拒绝，会静默给出 50/50 的假组分")

    # --- S3 回归：σ_area 必须含 height 项（原来漏掉 → σ 系统性偏小）---
    # 无噪声谱的 σ 恒为 0，检验不出漏项；加一份确定性"噪声"让 σh 真的出现。
    nz = [1200.0 * (((i * 7919) % 97) / 97.0 - 0.5) for i in range(len(E))]
    rn = fit(E, [raw[i] + nz[i] for i in range(len(E))], bg, [162.05], ds, ratio, eta)
    cn = rn["comps"][0]
    se = cn["area_err"] / cn["area"]
    need = math.hypot(rn["params_err"][2] / cn["height"], rn["params_err"][1] / cn["fwhm"])
    assert rn["params_err"][2] > 0, "有噪声时 σh 应当 > 0"
    assert abs(se - need) < 1e-4, ("σ_area 与 h·w 两项传播不符（height 项可能又漏了）", se, need)

    # --- S2 回归：拟合窗口 lo/hi（窗口外的强峰不得参与；边界必须报错）---
    E4 = [169.0 - 0.05 * i for i in range(121)]                    # 169 -> 163 eV
    bg4 = [500.0 if e > 165.0 else 100.0 for e in E4]
    raw4 = [bg4[i] + model_at(E4[i], [165.0, 1.0, 8000.0], 1, 0.0, 0.0, eta)
            + model_at(E4[i], [168.2, 0.8, 6000.0], 1, 0.0, 0.0, eta) for i in range(len(E4))]
    r_all = fit(E4, raw4, bg4, [165.05], ds=0.0, ratio=0.0, eta=eta)
    r_win = fit(E4, raw4, bg4, [165.05], ds=0.0, ratio=0.0, eta=eta, lo=163.0, hi=166.2)
    assert r_all["n"] == 121 and r_win["n"] == 65, (r_all["n"], r_win["n"])
    assert r_all["r2"] < 0.90 and r_win["r2"] > 0.99, (r_all["r2"], r_win["r2"])
    for bad_lo, bad_hi in ((166.2, 163.0), (165.0, 165.0)):
        try:
            fit(E4, raw4, bg4, [165.05], ds=0.0, ratio=0.0, eta=eta, lo=bad_lo, hi=bad_hi)
        except ValueError as e:
            assert "必须小于" in str(e), e
        else:
            raise AssertionError("lo>=hi 没有被拒绝: %r" % ((bad_lo, bad_hi),))
    try:
        fit(E4, raw4, bg4, [165.05], ds=0.0, ratio=0.0, eta=eta, lo=166.0, hi=166.1)
    except ValueError as e:
        assert "至少要 10" in str(e), e
    else:
        raise AssertionError("窗口内点太少没有被拒绝")

    # --- S12 回归：ds/ratio 与初值明显不匹配必须提示出来 ---
    r12 = fit(E3, raw3, bg3, [162.0, 165.2], ds, ratio, eta)      # 初值间距 3.2 但 ds=1.18
    assert "2p 口径" in report(r12), report(r12)
    assert any("2:3" in m for m in _constraint_warnings([233.05], 3.2, 0.5)), "d 轨道 ratio 不匹配没提示"
    assert not _constraint_warnings([162.05], 1.18, 0.5), "2p 正常参数不该有提示"

    print("selftest P0: 撞界标注 + 简并初值拒绝 OK")


def main(argv):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")   # cp936 控制台打不出 R²/真值
    except Exception:
        pass
    if "--selftest" in argv:
        return selftest()
    a = argv[1:]
    if not a:
        return print(__doc__)
    path, opt = a[0], {}
    i = 1
    while i < len(a):
        k = a[i].lstrip("-")
        v = a[i + 1] if i + 1 < len(a) and not a[i + 1].startswith("--") else "1"
        opt[k] = v
        i += 2 if v != "1" or (i + 1 < len(a) and not a[i + 1].startswith("--")) else 1
    centers = [float(x) for x in opt.get("centers", "162.0").replace(",", " ").split()]
    res = run(path, centers, opt.get("bg", "file"), int(opt.get("bg-col", 4)),
              float(opt.get("ds", 1.18)), float(opt.get("ratio", 0.5)),
              float(opt.get("eta", 0.3)), opt.get("csv"), int(opt.get("scan", 0)))
    print(report(res, head="文件: %s" % path))
    for key in sorted(k for k in res if k.startswith("scan")):
        s = res[key]
        print("  参考 %s 条: rms=%.1f  AIC=%.1f  R²=%.6f" % (s["nc"], s["rms"], s["aic"], s["r2"]))


if __name__ == "__main__":
    main(sys.argv)
