/**
 * 产物审计（只读）：审「已经存在的导出文件」，不依赖插件是否跑过。
 *
 * 输入只认 XPSPeak 的**文本导出**：
 *   - `_spectrum.dat`：表头含 B.E.(eV) / Raw Intensity / Peak Sum / Background / difference
 *   - `_peaks.dat`：表头含 Peak / Position (eV) / Area / FWHM (eV) / %GL (%)
 * 不解析 `.xps`（XPSPeak 私有格式，实测不同点数文件偏移读出来是垃圾，不能承诺）。
 *
 * 七项检查与阈值同 `server/xps_fit.py` 的 preflight 保持一致（那边是保存前，这边是事后复核）：
 *   fit-quality / residual-structure / peak-gap / bg-shape / template-copied /
 *   window-applicability / boundary-truncation
 */

import { readFileSync } from 'node:fs';

export const R2_WARN = 0.9;
export const R2_BLOCK = 0.85;
export const RESID_SEG_RATIO = 0.5;
export const RESID_SEGMENTS = 4;
export const PEAK_GAP_WARN = 0.05;
export const PEAK_GAP_BLOCK = 0.1;
export const BG_TOL = 0.005;
// Shirley 重算的容差是量出来的，不是拍的：三份实测导出谱（ceshiqu run3 的 213 点与 401 点、
// XPS Peak v2 的 176 点）用同一算法重算后，与文件 Background 列的最大偏离分别是 25 / 3 / 31 cps，
// 占扣背景峰高 0.09% / 0.01% / 0.12%；取 0.5%（约 4 倍余量）—— 同一条背景的正常差异远小于它，
// 而换类型（直线 vs Shirley）的偏离是 6.7%–11.3%，量级差 50 倍以上，不会被这个阈值混淆。
export const SHIRLEY_TOL = 0.005;
export const WINDOW_RATIO = 0.9;
export const EDGE_FWHM = 3.0;

function numericRow(line) {
  // 至少 1 列就收下：列数不足要在 parseSpectrum 里报「读到几列」，
  // 不能在这里就把整行丢掉、最后误报成「0 行」（2 列谱曾因此被当成空文件）。
  const cols = line.trim().split(/[\s,;\t]+/).map((v) => Number(v));
  if (cols.length < 1 || cols.some((v) => !Number.isFinite(v))) return null;
  return cols;
}

/**
 * 解析 XPSPeak 导出的谱图文本。列按表头关键字定位（缺表头时退回位置约定）。
 * 返回 {be, raw, fit, bg, diff}；fit = Peak Sum（XPSPeak 的 Peak Sum 已含背景）。
 */
export function parseSpectrum(path) {
  const text = readFileSync(path, 'utf8');
  let header = null;
  const all = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t === '') continue;
    if (/[A-Za-z]/.test(t)) {
      if (header === null) header = t;
      continue;
    }
    const cols = numericRow(t);
    if (cols !== null) all.push(cols);
  }
  const columns = all.reduce((m, r) => Math.max(m, r.length), 0);
  const rows = all.filter((r) => r.length >= 2);
  // 列数问题必须报列数：2 列（B.E., 强度）是合法输入，1 列才是坏文件。
  if (columns < 2) {
    throw new Error(
      `谱图列数不足（读到 ${columns} 列）：需要 2 列（B.E., 强度）或 XPSPeak 导出文本（≥3 列，含 Background）——${path}`,
    );
  }
  if (rows.length < 8) throw new Error(`谱图行数不足（${rows.length} 行，读到 ${columns} 列）：${path}`);
  const h = (header ?? '').toLowerCase();
  const find = (needle, fallback) => {
    const i = h.indexOf(needle);
    if (i < 0) return fallback;
    const before = h.slice(0, i).trim();
    return before === '' ? 0 : before.split(/\s{2,}|\t/).filter((s) => s !== '').length;
  };
  const idx = {
    be: find('b.e', 0),
    raw: find('raw', 1),
    fit: find('peak sum', 2),
    bg: find('background', 3),
    diff: h.includes('difference') ? find('difference', -1) : -1,
  };
  // 表头索引可能指到实际列数之外（2 列谱没有 Peak Sum / Background）：
  // 越界一律当「没有该列」，绝不能返回一列 undefined 去参与算术。
  const col = (i) => (i >= 0 && i < columns ? rows.map((r) => r[i]) : null);
  const be = col(idx.be);
  const raw = col(idx.raw);
  let fit = col(idx.fit);
  const bg = col(idx.bg);
  const diff = idx.diff >= 0 ? col(idx.diff) : null;
  if (fit !== null && fit.some((v) => v === undefined)) fit = null;
  if (fit === null && diff !== null) fit = raw.map((v, i) => v - diff[i]);
  return { be, raw, fit, bg, diff, rows: rows.length, columns, header };
}

/** 解析导出的峰表。列约定：Peak / Position / Area / FWHM / %GL。 */
export function parsePeaks(path) {
  const text = readFileSync(path, 'utf8');
  const peaks = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t === '' || /[A-Za-z]/.test(t)) continue;
    const cols = t.split(/[\s,;\t]+/).map(Number);
    if (cols.length < 4 || cols.some((v) => !Number.isFinite(v))) continue;
    peaks.push({ index: peaks.length, center: cols[1], area: cols[2], fwhm: cols[3], gl: cols[4] ?? null });
  }
  if (peaks.length === 0) throw new Error(`峰表里没有可解析的行：${path}`);
  return peaks;
}

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * 与 `server/xps_fit.py:shirley_bg()` 同源的迭代 Shirley：初始值钳在 [min,max]，
 * 每轮自高 BE 向低 BE 累加正信号，再用两端强度线性插值。能量按降序参与计算，
 * 与文件里的行序无关。只依赖 raw 与 be，不读文件自带背景。
 */
export function shirleyBg(be, raw, iters = 12) {
  const order = be.map((_, i) => i).sort((a, b) => be[b] - be[a]);
  const y = order.map((i) => raw[i]);
  const n = y.length;
  const lo = Math.min(...y);
  const hi = Math.max(...y);
  let bg = y.map((v) => Math.min(hi, Math.max(lo, v)));
  for (let it = 0; it < iters; it += 1) {
    const sig = y.map((v, i) => v - bg[i]);
    const S = new Array(n);
    let acc = 0;
    for (let i = n - 1; i >= 0; i -= 1) {
      acc += Math.max(0, sig[i]);
      S[i] = acc;
    }
    const tot = S[0] || 1;
    const a = y[n - 1];
    const b = y[0];
    bg = y.map((_, i) => a + (b - a) * (S[i] / tot));
  }
  const out = new Array(n);
  order.forEach((src, k) => { out[src] = bg[k]; });
  return out;
}

function fBr(v) { return v.length; }

/** 两端点连线（linear 背景应当就是这条）。 */
function endLine(y) {
  const n = y.length;
  const x0 = 0;
  const x1 = n - 1;
  return y.map((_, i) => y[x0] + ((y[x1] - y[x0]) * (i - x0)) / (x1 - x0));
}

export function auditArtifacts({ spectrumPath, peaksPath, template = null, window = null }) {
  const sp = parseSpectrum(spectrumPath);
  const peaks = peaksPath ? parsePeaks(peaksPath) : [];
  // 与 fit 同口径：R² / 残差 / 峰顶缺口都只在**拟合区**上算。整条谱上算会把窗口外的峰
  // （如 2p1/2 未建模）算进优度，audit 与 fit 就会给出两套 R²（实测差 0.3 以上）。
  const rawWin = window ?? (template !== null ? template.fit_window_ev ?? null : null);
  // window 既接受 {lo, hi}，也接受 [lo, hi]（路由与测试两种写法都要能用）
  const fitWin = Array.isArray(rawWin) ? { lo: rawWin[0], hi: rawWin[1] } : rawWin;
  let be = sp.be;
  let raw = sp.raw;
  let fit = sp.fit;
  let bg = sp.bg;
  let rows = sp.rows;
  if (fitWin !== null) {
    const lo = Math.min(fitWin.lo, fitWin.hi);
    const hi = Math.max(fitWin.lo, fitWin.hi);
    const keep = [];
    sp.be.forEach((v, i) => {
      if (v >= lo && v <= hi) keep.push(i);
    });
    if (keep.length < 8) throw new Error(`拟合区 [${lo}, ${hi}] 内只有 ${keep.length} 点（<8）：无法复算 R²/${spectrumPath}`);
    be = keep.map((i) => sp.be[i]);
    raw = keep.map((i) => sp.raw[i]);
    fit = sp.fit === null ? null : keep.map((i) => sp.fit[i]);
    bg = sp.bg === null ? null : keep.map((i) => sp.bg[i]);
    rows = keep.length;
  }
  const n = raw.length;
  const checks = [];
  const push = (id, name, status, detail) => checks.push({ id, name, status, detail });

  if (fit === null) {
    // 2 列谱（B.E.+强度）没有拟合列，R² 无从算起：这是 skip，不是失败。
    push(
      'fit-quality',
      '拟合优度 R²',
      'skip',
      `导出谱只有 ${sp.columns ?? 2} 列（无背景列、也没有 Peak Sum / difference 列），无法复算 R²；要审优度请从 XPSPeak 导出含 Background 与 Peak Sum 的文本`,
    );
  } else {
    const resid = raw.map((v, i) => v - fit[i]);
    const ssres = resid.reduce((a, v) => a + v * v, 0);
    const r2of = (base) => {
      const bbar = mean(base);
      const sstot = base.reduce((a, v) => a + (v - bbar) ** 2, 0);
      return sstot > 0 ? 1 - ssres / sstot : 0;
    };
    // 闸以**扣背景**口径为准：背景能占计数一大半，raw 口径下 R² 天然接近 1（同一份 v2 产物
    // raw 0.9152 判 pass，扣背景 0.8683 才与 XPSPeak 保存的 0.868272 同刻度）。
    // 残差 (Raw−PeakSum) 在两种口径下相同，差别全在分母的起伏量。
    const sub = bg === null ? null : raw.map((v, i) => v - bg[i]);
    const r2 = sub === null ? r2of(raw) : r2of(sub);
    const r2raw = r2of(raw);
    const rms = Math.sqrt(ssres / n);
    const status = r2 < R2_BLOCK ? 'fail' : r2 < R2_WARN ? 'warn' : 'pass';
    push(
      'fit-quality',
      '拟合优度 R²',
      status,
      sub === null
        ? `R²(raw，无背景列)=${r2.toFixed(4)}、rms=${rms.toFixed(1)} cps（没有 Background 列，只能按 raw 口径判；带背景导出才能按 XPSPeak 刻度判）`
        : `R²(扣背景)=${r2.toFixed(4)}、R²(raw)=${r2raw.toFixed(4)}（raw 只作参考，背景占比越高越虚高）、rms=${rms.toFixed(1)} cps（闸按扣背景：<${R2_BLOCK} 阻断、<${R2_WARN} 警告）`,
    );
    const seg = Math.max(1, Math.floor(n / RESID_SEGMENTS));
    const segMeans = [];
    for (let s = 0; s < RESID_SEGMENTS; s += 1) {
      const part = resid.slice(s * seg, s === RESID_SEGMENTS - 1 ? n : (s + 1) * seg);
      if (part.length > 0) segMeans.push(mean(part));
    }
    const worst = segMeans.reduce((acc, v) => (Math.abs(v) > Math.abs(acc) ? v : acc), 0);
    const ratio = rms > 0 ? Math.abs(worst) / rms : 0;
    push(
      'residual-structure',
      '残差结构（四段均值）',
      ratio > RESID_SEG_RATIO ? 'fail' : 'pass',
      `段均值 ${segMeans.map((v) => v.toFixed(0)).join(' / ')} cps，最大 |均值|/rms=${ratio.toFixed(2)}（>${RESID_SEG_RATIO} 判系统性偏移）`,
    );

    const dev = Math.max(...raw.map((v, i) => Math.abs(v - fit[i])));
    const peakTop = Math.max(...raw);
    const bgForHeight = bg ?? fit.map(() => 0);
    const peakHeight = Math.max(...raw.map((v, i) => v - bgForHeight[i]));
    const ratioTop = peakTop > 0 ? dev / peakTop : 0;
    const ratioHeight = peakHeight > 0 ? dev / peakHeight : 0;
    const gapStatus = ratioTop > PEAK_GAP_BLOCK || ratioHeight > PEAK_GAP_BLOCK
      ? 'fail'
      : ratioTop > PEAK_GAP_WARN || ratioHeight > PEAK_GAP_WARN
        ? 'warn'
        : 'pass';
    push(
      'peak-gap',
      '峰顶缺口',
      gapStatus,
      `max|data−fit|=${dev.toFixed(0)} cps；占原始峰顶 ${(ratioTop * 100).toFixed(1)}%、占扣背景峰高 ${(ratioHeight * 100).toFixed(1)}%（>5% 警告、>10% 阻断）`,
    );
  }

  if (bg === null) {
    push('bg-shape', '背景形状（导出文件里的 Background 列）', 'skip', '导出谱没有 Background 列，无法核对');
  } else if (template === null) {
    push('bg-shape', '背景形状（导出文件里的 Background 列）', 'skip', '未给模板：不知道声明的背景类型，本条无法判类型');
  } else {
    // 审的是**文件里存下来的**那条背景，所以按整份文件（不按拟合区切片）算：
    // 端点、峰高、重算范围都取文件自己的。
    const fBe = sp.be;
    const fRaw = sp.raw;
    const fBg = sp.bg;
    const peakTop = Math.max(...fRaw);
    const height = Math.max(...fRaw.map((v, i) => v - fBg[i])) || peakTop;
    const line = endLine(fBg);
    const devLine = Math.max(...fBg.map((v, i) => Math.abs(v - line[i])));
    const pctLine = devLine / height;
    const sh = shirleyBg(fBe, fRaw);
    const devSh = Math.max(...fBg.map((v, i) => Math.abs(v - sh[i])));
    const pctSh = devSh / height;
    const declared = template.background;
    if (declared === 'shirley') {
      if (pctSh <= SHIRLEY_TOL) {
        push(
          'bg-shape',
          '背景形状（导出文件里的 Background 列）',
          'pass',
          `模板 shirley：文件 Background 与按文件端点重算的 Shirley 最大偏离 ${devSh.toFixed(0)} cps = 扣背景峰高 ${(pctSh * 100).toFixed(2)}%（容差 ${(SHIRLEY_TOL * 100).toFixed(1)}%，同源算法 12 次迭代、${fBr(fBe)} 点）`,
        );
      } else if (pctLine < pctSh / 10) {
        push(
          'bg-shape',
          '背景形状（导出文件里的 Background 列）',
          'fail',
          `模板声明 shirley，文件里是直线型背景（背景类型不符）：按端点重算的 Shirley 偏差 ${devSh.toFixed(0)} cps = 峰高 ${(pctSh * 100).toFixed(1)}%，而 Background 列对两端直线只差 ${devLine.toFixed(0)} cps = ${(pctLine * 100).toFixed(1)}% —— 建区时换了背景类型`,
        );
      } else {
        push(
          'bg-shape',
          '背景形状（导出文件里的 Background 列）',
          'fail',
          `同类型背景被改动：模板声明 shirley，但文件 Background 与按端点重算的 Shirley 最大偏离 ${devSh.toFixed(0)} cps = 扣背景峰高 ${(pctSh * 100).toFixed(1)}%（容差 ${(SHIRLEY_TOL * 100).toFixed(1)}%）—— 图上的背景与存进文件里的不是同一条`,
        );
      }
    } else if (declared === 'linear') {
      if (pctLine <= BG_TOL) {
        push(
          'bg-shape',
          '背景形状（导出文件里的 Background 列）',
          'pass',
          `模板 linear：Background 列与两端直线最大偏离 ${devLine.toFixed(0)} cps = 扣背景峰高 ${(pctLine * 100).toFixed(2)}%（容差 ${(BG_TOL * 100).toFixed(1)}%）`,
        );
      } else if (pctSh <= SHIRLEY_TOL) {
        push(
          'bg-shape',
          '背景形状（导出文件里的 Background 列）',
          'fail',
          `模板声明 linear，文件里是 shirley 背景（背景类型不符）：Background 列对两端直线偏离 ${devLine.toFixed(0)} cps = 峰高 ${(pctLine * 100).toFixed(1)}%，但对按端点重算的 Shirley 只差 ${devSh.toFixed(0)} cps = ${(pctSh * 100).toFixed(2)}% —— 建区时换了背景类型`,
        );
      } else {
        push(
          'bg-shape',
          '背景形状（导出文件里的 Background 列）',
          'fail',
          `同类型背景被改动：模板声明 linear，但 Background 列与两端直线最大偏离 ${devLine.toFixed(0)} cps = 扣背景峰高 ${(pctLine * 100).toFixed(1)}%（容差 ${(BG_TOL * 100).toFixed(1)}%）`,
        );
      }
    } else {
      push(
        'bg-shape',
        '背景形状（导出文件里的 Background 列）',
        'skip',
        `模板背景是 ${declared}：不支持该背景类型的重算（tougaard 在 xps_fit 里按 file 处理），本条不审`,
      );
    }
  }

  if (peaks.length === 0) {
    push('template-copied', '峰形是否照搬模板', 'skip', '未提供峰表，无法比对');
  } else {
    const fwhms = peaks.map((p) => p.fwhm);
    const equalFwhm = Math.max(...fwhms) - Math.min(...fwhms) <= 0.01;
    let copied = false;
    let why = '';
    if (template !== null && template.peak_windows.length === peaks.length) {
      const tw = template.peak_windows;
      const shifts = peaks.map((p, i) => p.center - tw[i].center_ev);
      const shiftSpread = Math.max(...shifts) - Math.min(...shifts);
      const fwhmMatch = tw.every((w, i) => w.observed && typeof w.observed.fwhm_ev === 'number'
        && Math.abs(peaks[i].fwhm - w.observed.fwhm_ev) <= 0.01);
      const glMatch = tw.every((w, i) => w.observed && typeof w.observed.gl_pct === 'number'
        && peaks[i].gl !== null && Math.abs(peaks[i].gl - w.observed.gl_pct) <= 1);
      if (fwhmMatch && shiftSpread <= 0.05) {
        copied = true;
        why = `各峰 FWHM 全等于模板 observed.fwhm，峰位整体平移 ${mean(shifts).toFixed(3)} eV（离散 ${shiftSpread.toFixed(3)} eV）`;
      } else if (fwhmMatch && glMatch && shiftSpread <= 0.2) {
        copied = true;
        why = `各峰 FWHM/%GL 与模板 observed 一致，峰位平移 ${mean(shifts).toFixed(3)} eV`;
      }
    }
    if (copied) {
      push('template-copied', '峰形是否照搬模板', 'fail', `${why} —— 这是把模板峰形搬过去只调高度，不是拟合`);
    } else if (equalFwhm && peaks.length >= 3) {
      push('template-copied', '峰形是否照搬模板', 'warn', `所有峰 FWHM 完全相同（${fwhms[0].toFixed(3)} eV）：真实谱极少如此，检查是否写死了峰宽`);
    } else {
      push('template-copied', '峰形是否照搬模板', 'pass', `各峰 FWHM ${fwhms.map((v) => v.toFixed(3)).join(' / ')}`);
    }
  }

  const lo = Math.min(...be);
  const hi = Math.max(...be);
  const windowEv = Math.abs(hi - lo);
  const fitWinWidth = fitWin === null ? null : Math.abs(fitWin.hi - fitWin.lo);
  if (fitWinWidth === null) {
    push(
      'window-applicability',
      '窗口适用性',
      'skip',
      `本次窗口 ${windowEv.toFixed(2)} eV；模板未标 fit_window_ev，无法判断拟合区是否被覆盖`,
    );
  } else {
    const need = fitWinWidth * WINDOW_RATIO;
    // 90% 用整数比较（×10 与 ×9），避免 40*0.9 = 36.000000000000004 把恰好 90% 判死。
    const tooNarrow = Math.round(windowEv * 1000) * 10 < Math.round(fitWinWidth * 1000) * 9;
    const status = tooNarrow ? 'fail' : windowEv + 1e-9 < fitWinWidth ? 'warn' : 'pass';
    push(
      'window-applicability',
      '窗口适用性',
      status,
      `本次窗口 ${windowEv.toFixed(2)} eV，模板拟合区 ${fitWinWidth.toFixed(2)} eV（下限 ${need.toFixed(2)} eV）：${status === 'fail' ? '不足 90%，拟合区没被覆盖' : status === 'warn' ? '90%–100%，边界峰只按交集积分' : '覆盖完整'}`,
    );
  }

  if (peaks.length === 0) {
    push('boundary-truncation', '峰尾是否被截断', 'skip', '未提供峰表');
  } else {
    const hits = peaks.filter((p) => Math.min(Math.abs(p.center - lo), Math.abs(p.center - hi)) < EDGE_FWHM * p.fwhm);
    push(
      'boundary-truncation',
      '峰尾是否被截断',
      hits.length > 0 ? 'warn' : 'pass',
      hits.length > 0
        ? hits.map((p) => `峰 ${p.center.toFixed(1)} eV 距端点 ${Math.min(Math.abs(p.center - lo), Math.abs(p.center - hi)).toFixed(2)} eV < ${EDGE_FWHM}×FWHM(${(EDGE_FWHM * p.fwhm).toFixed(2)})`).join('；') + '：面积只按当前窗口积分'
        : '所有峰心距端点 ≥ 3×FWHM',
    );
  }

  // 全 skip ≠ 通过：一份只有 B.E.+强度的谱，五项检查都无从做起，
  // 落到 pass 会让用户把「没审」当成「审过了」。只有真有检查跑过（pass/warn/fail）
  // 才可能给 pass；一条实质检查都没有时判 insufficient。
  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) {
    if (Object.hasOwn(counts, c.status)) counts[c.status] += 1;
  }
  const verdict = counts.fail > 0
    ? 'fail'
    : counts.warn > 0
      ? 'warn'
      : counts.pass > 0
        ? 'pass'
        : 'insufficient';
  return {
    verdict,
    scope: '只审文本导出（_spectrum.dat + _peaks.dat）；不解析 .xps',
    checks,
    summary: {
      spectrumPath,
      peaksPath: peaksPath ?? null,
      templateId: template?.id ?? null,
      window_ev: Number(windowEv.toFixed(3)),
      fit_window_ev: fitWin === null ? null : [lo, hi],
      peaks: peaks.length,
      rows,
      counts,
    },
  };
}
