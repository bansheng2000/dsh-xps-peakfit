/**
 * dsh-xps-peakfit — 模板页的服务端（纯逻辑 + 一个 raw-node HTTP handler）
 * =====================================================================
 *
 * 这层只做三件事：存模板 JSON、算缩略图、把「用这个」翻成一段**结构化指令**。
 * 它**不调 MCP、不驱动 XPSPeak、不跑 python** —— 指令交回 agent 执行，
 * 闸门单点在 MCP（xpspeak_mcp.py 的 _refuse_in_teach）。
 *
 * 路由（前缀 /xps，全部走回环校验）：
 *   GET    /xps/templates                  → {mode, templates, favorites}
 *   POST   /xps/templates?filename=a.json  → 上传（只收 .json，≤256KB，服务端生成 id）
 *   POST   /xps/templates/<id>/rename      → {name} 只改名，id 不动
 *   DELETE /xps/templates/<id>             → 删目录 + 从收藏里剔掉
 *   POST   /xps/favorites                  → {favorites:[id...]}
 *   POST   /xps/templates/<id>/use         → 结构化指令；教学档 403
 *   GET    /xps/thumb/<id>                 → 模拟谱 SVG（算不出来给占位）
 *
 * 档位真源与 xpspeak_mcp.py 同一份 `~/.dsh/dsh-xps-peakfit/mode.json`，语义一字不差：
 * 文件不存在 → XPSPEAK_MODE → exec；坏文件/读失败 → teach 并在响应里写明原因。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { auditArtifacts } from './audit.js';

export const ROUTE_PREFIX = '/xps';

/** 模板 id：服务端生成（时间戳 + 随机），只含 [a-z0-9-]，同时是防目录穿越的唯一闸门。 */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const MAX_UPLOAD = 256 * 1024;
const MAX_BODY = 64 * 1024;

const BACKGROUNDS = new Set(['shirley', 'linear', 'tougaard']);

/* ───────────────────────── 路径与档位 ───────────────────────── */

export function stateRoot(env = process.env) {
  return env.XPSPEAK_ROOT || join(env.DSH_HOME || join(env.USERPROFILE || homedir(), '.dsh'), 'dsh-xps-peakfit');
}

export function templatesDir(root = stateRoot()) {
  return join(root, 'templates');
}

export function selectionFile(root = stateRoot()) {
  return join(root, 'selection.json');
}

/** 当前选择：{templateId, spectrumPath, chargeCorrection, updatedAt, lastRun}。templateId 为 null = 未选。 */
export function readSelection(root = stateRoot()) {
  const v = readJson(selectionFile(root));
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return { templateId: null, spectrumPath: '', chargeCorrection: null, updatedAt: 0, lastRun: null };
  }
  return {
    templateId: typeof v.templateId === 'string' && v.templateId !== '' ? v.templateId : null,
    spectrumPath: typeof v.spectrumPath === 'string' ? v.spectrumPath : '',
    chargeCorrection: v.chargeCorrection && typeof v.chargeCorrection === 'object' && !Array.isArray(v.chargeCorrection)
      ? v.chargeCorrection
      : null,
    updatedAt: Number(v.updatedAt) || 0,
    lastRun: v.lastRun && typeof v.lastRun === 'object' ? v.lastRun : null,
  };
}

/**
 * 荷电校正登记：{reference_peak, measured_ev, target_ev, shift_ev, method}。
 * 五个字段缺一不可 —— 只存 shift 的话，事后没人能判断它是怎么来的。
 */
export function validateChargeCorrection(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['chargeCorrection 必须是对象（或 null 表示未登记）'] };
  }
  const errors = [];
  const text = (key, max) => {
    const v = raw[key];
    if (typeof v !== 'string' || v.trim() === '') {
      errors.push(`chargeCorrection.${key} 必须是非空字符串`);
      return '';
    }
    if (v.length > max) errors.push(`chargeCorrection.${key} 太长（>${max}）`);
    return v.trim();
  };
  const number = (key, min, max) => {
    const v = raw[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      errors.push(`chargeCorrection.${key} 必须是 [${min}, ${max}] 的数字`);
      return NaN;
    }
    return v;
  };
  const referencePeak = text('reference_peak', 40);
  const measured = number('measured_ev', 0, 1500);
  const target = number('target_ev', 0, 1500);
  const shift = number('shift_ev', -20, 20);
  const method = text('method', 300);
  if (Number.isFinite(measured) && Number.isFinite(target) && Number.isFinite(shift)) {
    if (Math.abs(shift - (target - measured)) > 0.01) {
      errors.push(`chargeCorrection.shift_ev 必须等于 target_ev − measured_ev（${(target - measured).toFixed(3)}），实际 ${shift}`);
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { reference_peak: referencePeak, measured_ev: measured, target_ev: target, shift_ev: shift, method } };
}

export function writeSelection(input, root = stateRoot()) {
  const cur = readSelection(root);
  // 部分更新：字段缺省 = 保持原值；显式 null（templateId）或空串（spectrumPath）= 清空。
  const templateId = input?.templateId === undefined
    ? cur.templateId
    : input.templateId === null || input.templateId === ''
      ? null
      : String(input.templateId);
  const spectrumPath = input?.spectrumPath === undefined
    ? cur.spectrumPath
    : typeof input.spectrumPath === 'string'
      ? input.spectrumPath
      : '';
  const chargeCorrection = input?.chargeCorrection === undefined ? cur.chargeCorrection : input.chargeCorrection;
  const next = {
    templateId,
    spectrumPath,
    chargeCorrection: chargeCorrection ?? null,
    updatedAt: Date.now(),
    lastRun: input?.lastRun === undefined ? cur.lastRun : input.lastRun,
  };
  mkdirSync(root, { recursive: true });
  writeFileSync(selectionFile(root), `${JSON.stringify(next, null, 1)}\n`, 'utf8');
  return next;
}

export function favoritesFile(root = stateRoot()) {
  return join(root, 'favorites.json');
}

export function modePath(env = process.env) {
  return env.XPSPEAK_MODE_FILE || join(stateRoot(env), 'mode.json');
}

/**
 * 读档位。返回 {mode, note}，note 非空 = 为什么按 teach 处理。
 * 与 xpspeak_mcp.py:load_mode() 完全同口径（文件缺失 → env → exec；坏文件 → teach）。
 */
export function readMode(env = process.env) {
  const path = modePath(env);
  if (!existsSync(path)) {
    const envMode = String(env.XPSPEAK_MODE ?? '').trim().toLowerCase().startsWith('teach') ? 'teach' : 'exec';
    return { mode: envMode, note: null, path };
  }
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return {
      mode: 'teach',
      note: `mode.json 损坏（${error?.name ?? 'Error'}: ${error?.message ?? error}），已按教学模式处理：${path}`,
      path,
    };
  }
  const mode = data !== null && typeof data === 'object' && !Array.isArray(data) ? String(data.mode ?? '').trim().toLowerCase() : '';
  if (mode !== 'teach' && mode !== 'exec') {
    return {
      mode: 'teach',
      note: `mode.json 损坏（mode 不是 teach/exec，而是 ${JSON.stringify(data?.mode ?? data)}），已按教学模式处理：${path}`,
      path,
    };
  }
  return { mode, note: null, path };
}

/* ───────────────────────── 模板存取 ───────────────────────── */

function templateDir(root, id) {
  if (!ID_RE.test(String(id ?? ''))) return null;
  return join(templatesDir(root), String(id));
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 逐字段校验上传的模板。返回 {ok, errors, template}；errors 非空就整条拒绝，不落半条。 */
export function validateTemplate(raw) {
  const errors = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['body 必须是 JSON 对象'] };
  const str = (key, max) => {
    const v = raw[key];
    if (typeof v !== 'string' || v.trim() === '') errors.push(`${key} 必须是非空字符串`);
    else if (v.length > max) errors.push(`${key} 太长（>${max}）`);
    else return v.trim();
    return '';
  };
  const num = (key, { min = -Infinity, max = Infinity } = {}) => {
    const v = raw[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`${key} 必须是数字`);
    else if (v < min || v > max) errors.push(`${key} 超出范围 [${min}, ${max}]`);
    else return v;
    return NaN;
  };
  const name = str('name', 80);
  const category = str('category', 40);
  const element = str('element', 8);
  const orbital = str('orbital', 8);
  const note = typeof raw.note === 'string' ? raw.note.slice(0, 500) : '';
  /** schema v2 可选字段：缺省给默认值，给了就必须合法（老模板照样能过）。 */
  const optNum = (key, range, def) => {
    const v = raw[key];
    if (v === undefined || v === null) return def;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      errors.push(`${key} 必须是数字`);
      return def;
    }
    const { min = -Infinity, max = Infinity, int = false } = range ?? {};
    if (int && !Number.isInteger(v)) {
      errors.push(`${key} 必须是整数`);
      return def;
    }
    if (v < min || v > max) {
      errors.push(`${key} 超出范围 [${min}, ${max}]`);
      return def;
    }
    return v;
  };
  const optStr = (key, max, def) => {
    const v = raw[key];
    if (v === undefined || v === null || v === '') return def;
    if (typeof v !== 'string') {
      errors.push(`${key} 必须是字符串`);
      return def;
    }
    if (v.length > max) {
      errors.push(`${key} 太长（>${max}）`);
      return def;
    }
    return v.trim();
  };
  const eta = optNum('eta', { min: 0, max: 1 }, 0.3);
  const chargeCorrection = raw.charge_correction_ev === null
    ? null
    : optNum('charge_correction_ev', { min: -20, max: 20 }, 0);
  const referencePeak = optStr('reference_peak', 40, '');
  // schema v3：模板标定时用的窗口宽度（eV）。目标谱比它窄就拒绝 —— 峰形与边界截断都不可比。
  const applicableWindow = raw.applicable_window_ev === undefined || raw.applicable_window_ev === null
    ? null
    : optNum('applicable_window_ev', { min: 0.001, max: 1000 }, null);
  let provenance = null;
  if (raw.provenance !== undefined && raw.provenance !== null) {
    const p = raw.provenance;
    if (typeof p !== 'object' || Array.isArray(p)) {
      errors.push('provenance 必须是对象');
    } else {
      const pNum = (key, lo, hi, int) => {
        const v = p[key];
        if (v === undefined) return 0;
        if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi || (int && !Number.isInteger(v))) {
          errors.push(`provenance.${key} 必须是 [${lo}, ${hi}] 的${int ? '整数' : '数字'}`);
          return 0;
        }
        return v;
      };
      if (p.source_file !== undefined && typeof p.source_file !== 'string') errors.push('provenance.source_file 必须是字符串');
      else if (typeof p.source_file === 'string' && p.source_file.length > 120) errors.push('provenance.source_file 太长（>120）');
      provenance = {
        source_file: typeof p.source_file === 'string' ? p.source_file.slice(0, 120) : '',
        points: pNum('points', 1, 1000000, true),
        step_ev: pNum('step_ev', Number.MIN_VALUE, 100, false),
        range_ev: pNum('range_ev', Number.MIN_VALUE, 100000, false),
      };
    }
  }
  // null = 明确「不做双线约束 / 未记录」；0 才是实测值。含糊的 0 会被当实测读，所以两者必须分开。
  const doubletRaw = raw.doublet_delta_ev;
  const doublet = doubletRaw === null ? null : num('doublet_delta_ev', { min: 0, max: 40 });
  const fwhmMin = num('fwhm_min', { min: 0.01, max: 20 });
  const fwhmMax = num('fwhm_max', { min: 0.01, max: 20 });
  if (Number.isFinite(fwhmMin) && Number.isFinite(fwhmMax) && fwhmMin >= fwhmMax) {
    errors.push(`fwhm_min (${fwhmMin}) 必须小于 fwhm_max (${fwhmMax})`);
  }
  const background = typeof raw.background === 'string' ? raw.background.trim().toLowerCase() : '';
  if (!BACKGROUNDS.has(background)) errors.push(`background 只能是 ${[...BACKGROUNDS].join('/')}`);
  const constraints = raw.constraints;
  let areaRatio = NaN;
  let equalFwhm = false;
  if (constraints === null || typeof constraints !== 'object' || Array.isArray(constraints)) {
    errors.push('constraints 必须是 {area_ratio, equal_fwhm}');
  } else {
    areaRatio = constraints.area_ratio;
    if (typeof areaRatio !== 'number' || !Number.isFinite(areaRatio) || areaRatio <= 0 || areaRatio > 10) {
      errors.push('constraints.area_ratio 必须是 (0,10] 的数字');
    }
    if (typeof constraints.equal_fwhm !== 'boolean') errors.push('constraints.equal_fwhm 必须是布尔值');
    else equalFwhm = constraints.equal_fwhm;
  }
  const windows = Array.isArray(raw.peak_windows) ? raw.peak_windows : null;
  if (windows === null) errors.push('peak_windows 必须是数组');
  else if (windows.length < 1 || windows.length > 10) errors.push('peak_windows 要有 1–10 项（XPSPeak 峰数上限 10）');
  else {
    windows.forEach((w, i) => {
      if (w === null || typeof w !== 'object' || Array.isArray(w)) {
        errors.push(`peak_windows[${i}] 必须是对象`);
        return;
      }
      if (typeof w.label !== 'string' || w.label.trim() === '') errors.push(`peak_windows[${i}].label 必须是非空字符串`);
      if (typeof w.center_ev !== 'number' || !Number.isFinite(w.center_ev) || w.center_ev < 0 || w.center_ev > 1500) {
        errors.push(`peak_windows[${i}].center_ev 必须是 0–1500 的数字`);
      }
      if (w.search_ev !== undefined) {
        if (typeof w.search_ev !== 'number' || !Number.isFinite(w.search_ev) || w.search_ev <= 0 || w.search_ev > 20) {
          errors.push(`peak_windows[${i}].search_ev 必须是 (0,20] 的数字`);
        }
      }
      // schema v3：逐峰 eta（%Lorentzian 比例）。缺省不写 = 用模板标量；observed.gl_pct 只作对照，不进拟合。
      if (w.eta !== undefined) {
        if (typeof w.eta !== 'number' || !Number.isFinite(w.eta) || w.eta < 0 || w.eta > 1) {
          errors.push(`peak_windows[${i}].eta 必须是 [0,1] 的数字（%Lorentzian 比例）`);
        }
      }
      if (w.observed !== undefined && w.observed !== null) {
        const o = w.observed;
        if (typeof o !== 'object' || Array.isArray(o)) {
          errors.push(`peak_windows[${i}].observed 必须是对象`);
        } else {
          const oNum = (key, lo, hi) => {
            const v = o[key];
            if (v === undefined) return;
            if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) {
              errors.push(`peak_windows[${i}].observed.${key} 超出范围 [${lo}, ${hi}]`);
            }
          };
          oNum('center_ev', 0, 1500);
          oNum('fwhm_ev', 0.001, 20);
          oNum('gl_pct', 0, 100);
          oNum('area', Number.MIN_VALUE, 1e12);
          oNum('share_pct', 0, 100);
        }
      }
    });
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    template: {
      name,
      category,
      element,
      orbital,
      doublet_delta_ev: doublet === null ? null : doublet,
      peak_windows: windows.map((w) => {
        const out = { label: w.label.trim(), center_ev: w.center_ev };
        if (typeof w.search_ev === 'number') out.search_ev = w.search_ev;
        if (typeof w.eta === 'number') out.eta = w.eta;
        if (w.observed !== null && typeof w.observed === 'object' && !Array.isArray(w.observed)) {
          const o = {};
          for (const key of ['center_ev', 'fwhm_ev', 'gl_pct', 'area', 'share_pct']) {
            if (typeof w.observed[key] === 'number') o[key] = w.observed[key];
          }
          if (Object.keys(o).length > 0) out.observed = o;
        }
        return out;
      }),
      fwhm_min: fwhmMin,
      fwhm_max: fwhmMax,
      background,
      constraints: { area_ratio: areaRatio, equal_fwhm: equalFwhm },
      eta,
      charge_correction_ev: chargeCorrection,
      reference_peak: referencePeak,
      applicable_window_ev: applicableWindow,
      provenance,
      note,
    },
  };
}

export function newId(now = Date.now(), rand = Math.random) {
  return `t${now.toString(36)}-${rand().toString(36).slice(2, 8)}`;
}

export function listTemplates(root = stateRoot()) {
  const dir = templatesDir(root);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const meta = readJson(join(dir, name, 'meta.json'));
    if (meta !== null && typeof meta === 'object' && typeof meta.id === 'string') out.push(meta);
  }
  return out.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
}

export function createTemplate(raw, root = stateRoot()) {
  const checked = validateTemplate(raw);
  if (!checked.ok) return { ok: false, errors: checked.errors };
  const id = newId();
  const dir = templateDir(root, id);
  mkdirSync(dir, { recursive: true });
  const template = { id, ...checked.template, createdAt: new Date().toISOString() };
  writeFileSync(join(dir, 'meta.json'), `${JSON.stringify(template, null, 1)}\n`, 'utf8');
  return { ok: true, template };
}

export function renameTemplate(id, name, root = stateRoot()) {
  const dir = templateDir(root, id);
  if (dir === null || !existsSync(join(dir, 'meta.json'))) return { ok: false, code: 'not-found' };
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed === '' || trimmed.length > 80) return { ok: false, code: 'bad-name', errors: ['name 必须是 1–80 字符'] };
  const meta = readJson(join(dir, 'meta.json'));
  meta.name = trimmed; // id 不动：缩略图与收藏按 id 对齐
  writeFileSync(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 1)}\n`, 'utf8');
  return { ok: true, template: meta };
}

export function removeTemplate(id, root = stateRoot()) {
  const dir = templateDir(root, id);
  if (dir === null || !existsSync(dir)) return { ok: false, code: 'not-found' };
  rmSync(dir, { recursive: true, force: true });
  // 收藏里也要剔掉，否则下次读收藏会指向已删模板（复刻踩过的坑）
  const favs = readFavorites(root);
  if (favs.includes(id)) writeFavorites(favs.filter((x) => x !== id), root);
  return { ok: true, id };
}

export function readFavorites(root = stateRoot()) {
  const data = readJson(favoritesFile(root), []);
  return Array.isArray(data) ? data.filter((x) => typeof x === 'string') : [];
}

export function writeFavorites(ids, root = stateRoot()) {
  const clean = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && ID_RE.test(x)))];
  const existing = new Set(listTemplates(root).map((t) => t.id));
  const kept = clean.filter((id) => existing.has(id));
  mkdirSync(root, { recursive: true });
  writeFileSync(favoritesFile(root), `${JSON.stringify(kept, null, 1)}\n`, 'utf8');
  return kept;
}

/* ───────────────────────── 缩略图（模拟谱 SVG） ───────────────────────── */

/**
 * 伪 Voigt，与 server/xps_fit.py:model_at 同一公式（gauss/lorentz 按 eta 混合）。
 * 缩略图只求形似，但公式不许另发明一套：test/selftest.mjs 会拿 python 的
 * model_at 抽样对拍，公式一漂就红。
 */
export function pseudoVoigt(x, center, fwhm, height, eta = 0.3) {
  const sigma = fwhm / (2 * Math.sqrt(2 * Math.log(2)));
  const g = Math.exp(-(((x - center) / sigma) ** 2) / 2);
  const l = 1 / (1 + ((2 * (x - center)) / fwhm) ** 2);
  return height * (eta * l + (1 - eta) * g);
}

function bgAt(t, background) {
  // t: 0（低 BE 端）→ 1（高 BE 端）。XPS 背景在高 BE 侧更高。
  if (background === 'linear') return t;
  if (background === 'tougaard') return t ** 2;
  return Math.sqrt(t); // shirley：更陡的台阶
}

export function thumbSvg(template) {
  const W = 160;
  const H = 96;
  const windows = Array.isArray(template?.peak_windows) ? template.peak_windows : [];
  const centers = windows.map((w) => Number(w?.center_ev)).filter((v) => Number.isFinite(v));
  const ok = centers.length > 0 && Number.isFinite(template?.fwhm_min) && Number.isFinite(template?.fwhm_max)
    && template.fwhm_max > template.fwhm_min && template.fwhm_max > 0;
  if (!ok) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`
      + `<rect width="${W}" height="${H}" fill="#f2f3f5"/><text x="${W / 2}" y="${H / 2 + 4}" font-size="11" fill="#8a8f98" text-anchor="middle" font-family="system-ui,sans-serif">无参数</text></svg>`;
  }
  const lo = Math.min(...centers) - 4;
  const hi = Math.max(...centers) + 4;
  const fwhm = (template.fwhm_min + template.fwhm_max) / 2;
  const eta = 0.3;
  const n = 120;
  const ys = [];
  for (let i = 0; i < n; i += 1) {
    const x = lo + ((hi - lo) * i) / (n - 1);
    let y = 0.18 * bgAt(i / (n - 1), String(template.background ?? 'shirley'));
    windows.forEach((w, k) => {
      y += pseudoVoigt(x, Number(w.center_ev), fwhm, 1 - 0.12 * k, eta);
    });
    ys.push(y);
  }
  const yMax = Math.max(...ys) || 1;
  const pad = 6;
  const pts = ys.map((y, i) => {
    const px = pad + ((W - 2 * pad) * i) / (n - 1);
    const py = H - pad - ((H - 2 * pad) * y) / yMax;
    return `${px.toFixed(1)},${py.toFixed(1)}`;
  });
  const label = `${String(template.element ?? '').trim()} ${String(template.orbital ?? '').trim()}`.trim();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`
    + `<rect width="${W}" height="${H}" fill="#ffffff"/>`
    + `<polyline points="${pts.join(' ')}" fill="none" stroke="#2f6feb" stroke-width="1.6" stroke-linejoin="round"/>`
    + `<line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="#d6d9de" stroke-width="1"/>`
    + (label ? `<text x="${pad}" y="14" font-size="10" fill="#5b6270" font-family="system-ui,sans-serif">${escapeXml(label)}</text>` : '')
    + '</svg>';
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

/* ───────────────────────── 「用这个」的结构化指令 ───────────────────────── */

/**
 * 只产出**数据**：模板字段 + 建议的调用顺序。服务端绝不执行它。
 * 教学档在这里也拒绝一次（前端禁用只是体验，不是闸门）。
 */
const MCP_BG = { shirley: 'shirley', linear: 'linear' };

/** 模板背景 → xpspeak_fit.bg。tougaard 在 fit 里没有对应项，退回 file（谱图自带背景）。 */
function mcpBackground(background) {
  return MCP_BG[background] ?? 'file';
}

/**
 * 读一份文本谱图的首列（结合能）范围，用于窗口适用性核对。
 * 只做「够不够宽」的判断，不参与拟合；读不出/格式不认识就返回 null（调用方只警告不拦）。
 */
export function spectrumRange(path) {
  if (typeof path !== 'string' || path === '') return null;
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let lo = Infinity;
  let hi = -Infinity;
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t === '' || t.startsWith('#') || t.startsWith('//')) continue;
    const cols = t.split(/[\s,;\t]+/);
    if (cols.length < 2) continue;
    const v = Number(cols[0]);
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    n += 1;
  }
  return n >= 2 ? { lo, hi } : null;
}

export function useInstruction(template, mode, spectrum = null) {
  if (mode === 'teach') {
    return { ok: false, code: 'teaching-mode', message: '教学模式下不代执行 —— 这一步请你自己按下面顺序操作。' };
  }
  const win = template.peak_windows;
  const sers = win.map((w) => w.search_ev).filter((v) => typeof v === 'number' && Number.isFinite(v));
  // xpspeak_fit 只接受标量 ctol：取各峰 search_ev 的最大值；一个都没有就回落到 fit 默认 1.0 eV。
  const ctol = sers.length > 0 ? Math.max(...sers) : 1.0;
  const etaScalar = typeof template.eta === 'number' ? template.eta : 0.3;
  // 逐峰 eta：只认模板显式写的 peak_windows[].eta；observed.gl_pct 是事后对照，不进拟合。
  const etaPerPeak = win.map((w) => (typeof w.eta === 'number' ? w.eta : etaScalar));
  const etaArg = etaPerPeak.every((v) => v === etaScalar) ? etaScalar : etaPerPeak;
  const warnings = [];
  // 窗口适用性：模板按多宽的窗口标定，目标谱就得多宽。拿不到谱范围时只能提示「未核对」。
  if (typeof template.applicable_window_ev === 'number') {
    if (spectrum !== null && Number.isFinite(spectrum.lo) && Number.isFinite(spectrum.hi)) {
      const windowEv = Math.abs(spectrum.hi - spectrum.lo);
      // 90% 容差：模板标定宽度是「参考宽」，不是硬下限。实测反例——Ni 2p 模板 40 eV，
      // 同一条谱 401 点 884.0→844.0 = 40.000，厂商 Peak Table 自己的拟合区是 883.9→844.1 = 39.8，
      // 差 0.2 eV 就判死不合理；真正该拦的是 17.5 对 40 这种 2.3 倍的差。
      const need = template.applicable_window_ev * 0.9;
      // 判据用整数比较，避开 IEEE754：40*0.9 = 36.000000000000004 会把「恰好 90%」判死。
      // 乘 10 后比较 windowEv*10 < applicable*9；1e-9 只吸收谱端点读数的末位噪声。
      if (windowEv * 10 + 1e-9 < template.applicable_window_ev * 9) {
        return {
          ok: false,
          code: 'window-too-narrow',
          message: `模板标定于 ${template.applicable_window_ev} eV，本次只有 ${windowEv.toFixed(2)} eV（不足 90% = ${need.toFixed(2)} eV）：峰形与边界截断都不可比，拒绝套用。请改用与模板同宽的窗口，或另建一份该宽度的模板。`,
          template: template.id,
          window_ev: windowEv,
          applicable_window_ev: template.applicable_window_ev,
          min_window_ev: need,
        };
      }
      if (windowEv < template.applicable_window_ev) {
        warnings.push(`窗口 ${windowEv.toFixed(2)} eV 比模板标定 ${template.applicable_window_ev} eV 窄 ${(template.applicable_window_ev - windowEv).toFixed(2)} eV（≥90%），边界截断按常规检查。`);
      }
    } else {
      warnings.push(`模板要求窗口 ≥ ${template.applicable_window_ev} eV，但没拿到目标谱路径 / 读不出范围，未核对。`);
    }
  } else if (spectrum !== null && Number.isFinite(spectrum.lo) && Number.isFinite(spectrum.hi)) {
    // 老模板没有这个字段：只提示「这项没核对」，不拦。
    warnings.push('模板未标 applicable_window_ev，窗口适用性未核对（拿不到模板标定宽度）。');
  }
  // 缺 eta 不拦（老模板照样能用），但必须让调用方看见「这是回落值，不是实测」。
  if (typeof template.eta !== 'number') {
    warnings.push('模板未写 eta，已按 0.3 拟合；实测 %GL 不同的谱请补 eta');
  }
  if (etaArg !== etaScalar && Array.isArray(etaArg)) {
    warnings.push('本次拟合用了逐峰 eta（' + etaArg.map((v) => v.toFixed(2)).join('/') + '）：来自各峰 peak_windows[].eta，不是模板标量。');
  }
  if (template.doublet_delta_ev === null) {
    warnings.push('模板未做双线约束（doublet_delta_ev=null），本次 ds=0：单峰模型，不是双线拟合。');
  }
  return {
    ok: true,
    instruction: {
      template: template.id,
      name: template.name,
      fields: {
        element: template.element,
        orbital: template.orbital,
        doublet_delta_ev: template.doublet_delta_ev,
        fwhm_min: template.fwhm_min,
        fwhm_max: template.fwhm_max,
        background: template.background,
        constraints: template.constraints,
        eta: etaArg,
        eta_per_peak: etaPerPeak,
        ctol,
        applicable_window_ev: template.applicable_window_ev ?? null,
        charge_correction_ev: template.charge_correction_ev ?? 0,
        reference_peak: template.reference_peak ?? '',
        provenance: template.provenance ?? null,
        peak_windows: win,
      },
      warnings,
      steps: [
        { tool: 'xpspeak_status', arguments: {}, why: '确认软件在跑、看当前档位与窗口' },
        { tool: 'xpspeak_open', arguments: { path: '<你的谱图路径>' }, why: '载入谱图' },
        {
          tool: 'xpspeak_fit',
          arguments: {
            path: '<你的谱图路径>',
            centers: win.map((w) => w.center_ev),
            ds: template.doublet_delta_ev ?? 0,
            ratio: template.constraints.area_ratio,
            wlo: template.fwhm_min,
            whi: template.fwhm_max,
            ctol,
            eta: etaArg,
            bg: mcpBackground(template.background),
          },
          why: '全部参数交给 xpspeak_fit（Δ 固定、面积比固定、双峰等宽）；撞界按提示调参后重拟合',
        },
        { tool: 'xpspeak_export', arguments: { path: '<导出谱图 .dat>', what: 'spectrum' }, why: '导出谱图复核面积' },
        { tool: 'xpspeak_save', arguments: { path: '<存 .xps>', what: 'xps' }, why: '存档可编辑的 XPSPeak 状态' },
      ],
      notes: [
        'Add Peak 是菜单命令，不接收位置/宽度参数：要手工加峰壳请在软件里点（xpspeak_menu {top:"Add Peak"} 只会建空峰壳）。',
        '程序路径的参数一律由 xpspeak_fit 定（centers / ds / ratio / wlo / whi / bg）；也可改用 xpspeak_build，但它要求每峰 area，模板不提供面积，别自己编。',
        `peak_windows[].center_ev 是拟合初值；search_ev 是窗口半宽，已折算成 ctol=${ctol}（xpspeak_fit 只收一个标量，取各峰 search_ev 的最大值，缺省 1.0）。`,
        `eta=${Array.isArray(etaArg) ? etaArg.map((v) => v.toFixed(2)).join('/') + '（逐峰，来自 peak_windows[].eta）' : etaArg + '（模板标量：各峰未写 peak_windows[].eta，全部按这一个值拟合）'}（%Lorentzian；缺省 0.3 是老模板回落值，实测谱主峰常 0.4–0.5、卫星 1.0，能填就填）。`,
        'peak_windows[].observed 只记这一次的实测值（峰位/宽/GL/面积/占比），供换样品时对照，绝不传给 xpspeak_fit —— 要让它影响拟合，必须显式写 peak_windows[].eta；面积比固定与否由你决定。',
        ...(template.background === 'tougaard'
          ? ['模板背景是 tougaard，xpspeak_fit 没有这一项：已传 bg=file（用谱图自带背景列），要 tougaard 请在软件里先扣背景再拟合。']
          : []),
      ],
    },
  };
}

/* ───────────────────────── HTTP ───────────────────────── */

/**
 * 插件路由绕过宿主鉴权墙：Host 挡隧道/DNS rebinding，peer 地址挡同网段直连。
 * 两道都过才放行（宿主实测监听 0.0.0.0，Host 头可以伪造）。
 */
export function isLoopbackRequest(req) {
  const rawHost = String(req?.headers?.host ?? '');
  const hostname = rawHost.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  const peer = String(req?.socket?.remoteAddress ?? '');
  const hostOk = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  const peerOk = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  return hostOk && peerOk;
}

function sendJson(res, status, value) {
  const body = `${JSON.stringify(value, null, 1)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendSvg(res, status, svg) {
  res.writeHead(status, {
    'content-type': 'image/svg+xml; charset=utf-8',
    'content-length': Buffer.byteLength(svg),
    'cache-control': 'no-store',
  });
  res.end(svg);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        // 不 destroy：销毁 socket 会让客户端收到 ECONNRESET 而不是 413（状态码才是契约）。
        // 丢掉已收的块、把余下的 body 排空，然后正常回 413。
        chunks.length = 0;
        req.resume();
        reject(Object.assign(new Error(`body too large (>${limit} bytes)`), { code: 'too-large' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 建 handler。root 可注入（自检用临时目录，绝不碰用户真目录）。 */
export function createRoutes({ root = stateRoot(), env = process.env } = {}) {
  return async function handler(req, res) {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      return sendJson(res, 400, { ok: false, code: 'bad-url' });
    }
    if (!url.pathname.startsWith(ROUTE_PREFIX)) return undefined; // 不是本插件的路由
    if (!isLoopbackRequest(req)) {
      return sendJson(res, 403, { ok: false, code: 'not-loopback', message: '只接受本机回环请求' });
    }
    const sub = url.pathname.slice(ROUTE_PREFIX.length) || '/';
    const mode = readMode(env);

    try {
      if (sub === '/templates' && req.method === 'GET') {
        return sendJson(res, 200, {
          ok: true,
          mode: { mode: mode.mode, note: mode.note, path: mode.path },
          templates: listTemplates(root),
          favorites: readFavorites(root),
        });
      }

      if (sub === '/templates' && req.method === 'POST') {
        const filename = String(url.searchParams.get('filename') ?? '');
        if (!/\.json$/i.test(filename)) {
          return sendJson(res, 400, { ok: false, code: 'bad-extension', message: '只接受 .json 模板文件' });
        }
        let bytes;
        try {
          bytes = await readBody(req, MAX_UPLOAD);
        } catch (error) {
          return sendJson(res, 413, { ok: false, code: 'too-large', message: `模板文件不能超过 ${MAX_UPLOAD} 字节` });
        }
        let raw;
        try {
          raw = JSON.parse(bytes.toString('utf8'));
        } catch (error) {
          return sendJson(res, 400, { ok: false, code: 'bad-json', message: `不是合法 JSON：${error?.message ?? error}` });
        }
        const created = createTemplate(raw, root);
        if (!created.ok) return sendJson(res, 400, { ok: false, code: 'bad-template', errors: created.errors });
        return sendJson(res, 201, { ok: true, template: created.template });
      }

      const m = /^\/templates\/([^/]+)(?:\/(rename|use))?$/.exec(sub);
      if (m !== null) {
        const id = m[1];
        const action = m[2];
        if (action === 'rename' && req.method === 'POST') {
          let body;
          try {
            body = JSON.parse((await readBody(req, MAX_BODY)).toString('utf8') || '{}');
          } catch (error) {
            return sendJson(res, 400, { ok: false, code: 'bad-json', message: String(error?.message ?? error) });
          }
          const renamed = renameTemplate(id, body?.name, root);
          if (!renamed.ok) return sendJson(res, renamed.code === 'not-found' ? 404 : 400, renamed);
          return sendJson(res, 200, renamed);
        }
        if (action === 'use' && req.method === 'POST') {
          const template = listTemplates(root).find((t) => t.id === id);
          if (template === undefined) return sendJson(res, 404, { ok: false, code: 'not-found' });
          let useBody = {};
          try {
            useBody = JSON.parse((await readBody(req, MAX_BODY)).toString('utf8') || '{}') || {};
          } catch (error) {
            const status = error?.code === 'too-large' ? 413 : 400;
            return sendJson(res, status, { ok: false, code: 'bad-body', message: String(error?.message ?? error) });
          }
          // 谱图路径：请求里给的优先，其次用选择态里记的（面板「选这个」时填的）。
          const selection = readSelection(root);
          const spectrumPath = typeof useBody.spectrumPath === 'string' && useBody.spectrumPath !== ''
            ? useBody.spectrumPath
            : selection.spectrumPath;
          const result = useInstruction(template, mode.mode, spectrumRange(spectrumPath));
          if (result.ok && (selection.chargeCorrection === null || selection.chargeCorrection === undefined)) {
            result.instruction.warnings.push(
              '选择态缺 chargeCorrection（reference_peak / measured_ev / target_ev / shift_ev / method）：第 1 步应先把荷电校正做掉并把五个字段写回 /xps/selection，否则下游峰位差多少、怎么来的都无从复算。',
            );
          }
          if (!result.ok) {
            const status = result.code === 'teaching-mode' ? 403 : result.code === 'window-too-narrow' ? 422 : 400;
            return sendJson(res, status, { ...result, mode: mode.mode, note: mode.note });
          }
          return sendJson(res, 200, { ...result, mode: mode.mode, note: mode.note });
        }
        if (action === undefined && req.method === 'DELETE') {
          const removed = removeTemplate(id, root);
          if (!removed.ok) return sendJson(res, 404, removed);
          return sendJson(res, 200, removed);
        }
        return sendJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'DELETE /templates/<id> 或 POST /templates/<id>/{rename,use}' });
      }

      if (sub === '/audit' && req.method === 'POST') {
        let body;
        try {
          body = JSON.parse((await readBody(req, MAX_BODY)).toString('utf8') || '{}');
        } catch (error) {
          const status = error?.code === 'too-large' ? 413 : 400;
          return sendJson(res, status, { ok: false, code: 'bad-body', message: String(error?.message ?? error) });
        }
        if (typeof body.spectrumPath !== 'string' || body.spectrumPath === '') {
          return sendJson(res, 400, { ok: false, code: 'bad-spectrum-path', message: 'spectrumPath 必须是文本导出（_spectrum.dat）的路径' });
        }
        if (typeof body.peaksPath !== 'string' || body.peaksPath === '') {
          return sendJson(res, 400, { ok: false, code: 'bad-peaks-path', message: 'peaksPath 必须是文本导出（_peaks.dat）的路径' });
        }
        let template = null;
        if (body.templateId !== undefined && body.templateId !== null) {
          template = listTemplates(root).find((t) => t.id === body.templateId) ?? null;
          if (template === null) return sendJson(res, 404, { ok: false, code: 'not-found', message: '模板不存在' });
        }
        try {
          const out = auditArtifacts({ spectrumPath: body.spectrumPath, peaksPath: body.peaksPath, template });
          return sendJson(res, 200, { ok: true, ...out });
        } catch (error) {
          return sendJson(res, 400, { ok: false, code: 'audit-failed', message: String(error?.message ?? error) });
        }
      }

      if (sub === '/runlog' && req.method === 'POST') {
        if (mode.mode === 'teach') {
          return sendJson(res, 403, { ok: false, code: 'teaching-mode', message: '教学模式下不代执行（也不代写 run.json）' });
        }
        let body;
        try {
          body = JSON.parse((await readBody(req, MAX_BODY)).toString('utf8') || '{}');
        } catch (error) {
          const status = error?.code === 'too-large' ? 413 : 400;
          return sendJson(res, status, { ok: false, code: 'bad-body', message: String(error?.message ?? error) });
        }
        if (typeof body.dir !== 'string' || body.dir === '' || !existsSync(body.dir) || !statSync(body.dir).isDirectory()) {
          return sendJson(res, 400, { ok: false, code: 'bad-dir', message: 'dir 必须是已存在的产物目录' });
        }
        const files = Array.isArray(body.files) ? body.files : [];
        const artifacts = [];
        for (const f of files) {
          if (typeof f !== 'string' || f === '' || !existsSync(f) || !statSync(f).isFile()) {
            return sendJson(res, 400, { ok: false, code: 'bad-artifact', message: `产物不存在或不是文件：${f}` });
          }
          const buf = readFileSync(f);
          artifacts.push({ path: f, bytes: buf.length, sha256: sha256(buf) });
        }
        const run = {
          templateId: typeof body.templateId === 'string' && body.templateId !== '' ? body.templateId : null,
          createdAt: new Date().toISOString(),
          fit: body.fit && typeof body.fit === 'object' ? body.fit : null,
          result: body.result && typeof body.result === 'object' ? body.result : null,
          chargeCorrection: body.chargeCorrection && typeof body.chargeCorrection === 'object' ? body.chargeCorrection : null,
          artifacts,
        };
        const out = join(body.dir, 'run.json');
        writeFileSync(out, `${JSON.stringify(run, null, 1)}\n`, 'utf8');
        return sendJson(res, 200, { ok: true, path: out, run });
      }

      if (sub === '/selection' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, selection: readSelection(root), mode: mode.mode });
      }

      if (sub === '/selection' && req.method === 'POST') {
        if (mode.mode === 'teach') {
          return sendJson(res, 403, { ok: false, code: 'teaching-mode', message: '教学模式下不代执行' });
        }
        let body;
        try {
          body = JSON.parse((await readBody(req, MAX_BODY)).toString('utf8') || '{}');
        } catch (error) {
          const status = error?.code === 'too-large' ? 413 : 400;
          return sendJson(res, status, { ok: false, code: 'bad-body', message: String(error?.message ?? error) });
        }
        if (body.templateId !== undefined && body.templateId !== null
          && (typeof body.templateId !== 'string' || body.templateId === '')) {
          return sendJson(res, 400, { ok: false, code: 'bad-template-id', message: 'templateId 必须是字符串或 null（null = 取消选择）' });
        }
        if (body.templateId !== undefined && body.templateId !== null) {
          const meta = readJson(join(templatesDir(root), body.templateId, 'meta.json'));
          if (meta === null) {
            return sendJson(res, 404, { ok: false, code: 'not-found', message: '模板不存在' });
          }
        }
        if (body.spectrumPath !== undefined && typeof body.spectrumPath !== 'string') {
          return sendJson(res, 400, { ok: false, code: 'bad-spectrum-path', message: 'spectrumPath 必须是字符串' });
        }
        let chargeCorrection;
        if (body.chargeCorrection !== undefined) {
          if (body.chargeCorrection === null) chargeCorrection = null;
          else {
            const checked = validateChargeCorrection(body.chargeCorrection);
            if (!checked.ok) {
              return sendJson(res, 400, { ok: false, code: 'bad-charge-correction', errors: checked.errors });
            }
            chargeCorrection = checked.value;
          }
        }
        return sendJson(res, 200, {
          ok: true,
          selection: writeSelection({ templateId: body.templateId, spectrumPath: body.spectrumPath, chargeCorrection }, root),
        });
      }

      if (sub === '/favorites' && req.method === 'POST') {
        let body;
        try {
          body = JSON.parse((await readBody(req, MAX_BODY)).toString('utf8') || '{}');
        } catch (error) {
          return sendJson(res, 400, { ok: false, code: 'bad-json', message: String(error?.message ?? error) });
        }
        if (body === null || typeof body !== 'object' || !Array.isArray(body.favorites)) {
          return sendJson(res, 400, { ok: false, code: 'bad-body', message: 'body 需要 {favorites:[id...]}' });
        }
        return sendJson(res, 200, { ok: true, favorites: writeFavorites(body.favorites, root) });
      }

      const t = /^\/thumb\/([^/]+)$/.exec(sub);
      if (t !== null && req.method === 'GET') {
        const template = listTemplates(root).find((x) => x.id === t[1]);
        if (template === undefined) return sendJson(res, 404, { ok: false, code: 'not-found' });
        return sendSvg(res, 200, thumbSvg(template));
      }

      return sendJson(res, 404, { ok: false, code: 'no-route', path: url.pathname });
    } catch (error) {
      return sendJson(res, 500, { ok: false, code: 'internal', message: String(error?.message ?? error) });
    }
  };
}

/** 供 lib/index.js 与自检共用：包内 server/ 三个 py 的目标目录。 */
export function installedServerDir(root = stateRoot()) {
  return join(root, 'server');
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}
