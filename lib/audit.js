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
export const WINDOW_RATIO = 0.9;
export const EDGE_FWHM = 3.0;

function numericRow(line) {
  const cols = line.trim().split(/[\s,;\t]+/).map((v) => Number(v));
  if (cols.length < 3 || cols.some((v) => !Number.isFinite(v))) return null;
  return cols;
}

/**
 * 解析 XPSPeak 导出的谱图文本。列按表头关键字定位（缺表头时退回位置约定）。
 * 返回 {be, raw, fit, bg, diff}；fit = Peak Sum（XPSPeak 的 Peak Sum 已含背景）。
 */
export function parseSpectrum(path) {
  const text = readFileSync(path, 'utf8');
  let header = null;
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t === '') continue;
    if (/[A-Za-z]/.test(t)) {
      if (header === null) header = t;
      continue;
    }
    const cols = numericRow(t);
    if (cols !== null) rows.push(cols);
  }
  if (rows.length < 8) throw new Error(`谱图行数不足（${rows.length} 行）：${path}`);
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
  const col = (i) => (i >= 0 ? rows.map((r) => r[i]) : null);
  const be = col(idx.be);
  const raw = col(idx.raw);
  let fit = col(idx.fit);
  const bg = col(idx.bg);
  const diff = idx.diff >= 0 ? col(idx.diff) : null;
  if (fit !== null && fit.some((v) => v === undefined)) fit = null;
  if (fit === null && diff !== null) fit = raw.map((v, i) => v - diff[i]);
  return { be, raw, fit, bg, diff, rows: rows.length, header };
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

/** 两端点连线（linear 背景应当就是这条）。 */
function endLine(y) {
  const n = y.length;
  const x0 = 0;
  const x1 = n - 1;
  return y.map((_, i) => y[x0] + ((y[x1] - y[x0]) * (i - x0)) / (x1 - x0));
}

export function auditArtifacts({ spectrumPath, peaksPath, template = null }) {
  const sp = parseSpectrum(spectrumPath);
  const peaks = peaksPath ? parsePeaks(peaksPath) : [];
  const raw = sp.raw;
  const fit = sp.fit;
  const n = raw.length;
  const checks = [];
  const push = (id, name, status, detail) => checks.push({ id, name, status, detail });

  if (fit === null) {
    push('fit-quality', '拟合优度 R²', 'fail', '导出谱里没有 Peak Sum / difference 列，无法复算 R²');
  } else {
    const resid = raw.map((v, i) => v - fit[i]);
    const ssres = resid.reduce((a, v) => a + v * v, 0);
    const ybar = mean(raw);
    const sstot = raw.reduce((a, v) => a + (v - ybar) ** 2, 0);
    const r2 = sstot > 0 ? 1 - ssres / sstot : 0;
    const rms = Math.sqrt(ssres / n);
    const status = r2 < R2_BLOCK ? 'fail' : r2 < R2_WARN ? 'warn' : 'pass';
    push('fit-quality', '拟合优度 R²', status, `R²=${r2.toFixed(4)}、rms=${rms.toFixed(1)} cps（<${R2_BLOCK} 阻断、<${R2_WARN} 警告）`);
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
    const bgForHeight = sp.bg ?? fit.map(() => 0);
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

  if (sp.bg === null) {
    push('bg-shape', '背景形状（导出文件里的 Background 列）', 'skip', '导出谱没有 Background 列，无法核对');
  } else if (template === null || template.background !== 'linear') {
    push('bg-shape', '背景形状（导出文件里的 Background 列）', 'skip', `模板背景是 ${template === null ? '（未给模板）' : template.background}，本条只审 linear`);
  } else {
    const line = endLine(sp.bg);
    const dev = Math.max(...sp.bg.map((v, i) => Math.abs(v - line[i])));
    const peakTop = Math.max(...raw);
    const bgForHeight = sp.bg;
    const peakHeight = Math.max(...raw.map((v, i) => v - bgForHeight[i])) || peakTop;
    const pct = dev / peakHeight;
    push(
      'bg-shape',
      '背景形状（导出文件里的 Background 列）',
      pct > BG_TOL ? 'fail' : 'pass',
      `Background 列与两端直线最大偏离 ${dev.toFixed(0)} cps = 扣背景峰高 ${(pct * 100).toFixed(1)}%（容差 ${(BG_TOL * 100).toFixed(1)}%）；图上的背景与存进文件里的背景必须是同一条`,
    );
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

  const lo = Math.min(...sp.be);
  const hi = Math.max(...sp.be);
  const windowEv = Math.abs(hi - lo);
  if (template === null || typeof template.applicable_window_ev !== 'number') {
    push('window-applicability', '窗口适用性', 'skip', `本次窗口 ${windowEv.toFixed(2)} eV；模板未标 applicable_window_ev，无法判断`);
  } else {
    const need = template.applicable_window_ev * WINDOW_RATIO;
    const status = windowEv <= need ? 'fail' : windowEv < template.applicable_window_ev ? 'warn' : 'pass';
    push(
      'window-applicability',
      '窗口适用性',
      status,
      `本次窗口 ${windowEv.toFixed(2)} eV，模板标定 ${template.applicable_window_ev} eV（下限 ${need.toFixed(2)} eV）：${status === 'fail' ? '不足 90%，峰形不可比' : status === 'warn' ? '90%–100%，只能当窄窗结果用' : '够宽'}`,
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

  const verdict = checks.some((c) => c.status === 'fail')
    ? 'fail'
    : checks.some((c) => c.status === 'warn')
      ? 'warn'
      : 'pass';
  return {
    verdict,
    scope: '只审文本导出（_spectrum.dat + _peaks.dat）；不解析 .xps',
    checks,
    summary: {
      spectrumPath,
      peaksPath: peaksPath ?? null,
      templateId: template?.id ?? null,
      window_ev: Number(windowEv.toFixed(3)),
      peaks: peaks.length,
      rows: sp.rows,
    },
  };
}
