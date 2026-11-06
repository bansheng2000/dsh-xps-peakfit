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

import { auditArtifacts, parseSpectrum } from './audit.js';

export const ROUTE_PREFIX = '/xps';

/** 模板 id：服务端生成（时间戳 + 随机），只含 [a-z0-9-]，同时是防目录穿越的唯一闸门。 */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const MAX_UPLOAD = 256 * 1024;
const MAX_BODY = 64 * 1024;

// file = 背景取自目标谱自带的 Background 列，插件不做模型假设。
// tougaard 已移除：XPSPeak 的类型下拉虽然有这一项，但插件无法保证兑现，声明了却做不到比不支持更误导。
const BACKGROUNDS = new Set(['shirley', 'linear', 'file']);

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
  const templateId = typeof v.templateId === 'string' && v.templateId !== '' ? v.templateId : null;
  // P2-10：模板被删/改名后 selection 仍指着它。读的时候校验一次，列表页要能看见「已失效」。
  const stale = templateId !== null && readJson(join(templatesDir(root), templateId, 'meta.json')) === null;
  return {
    templateId,
    spectrumPath: typeof v.spectrumPath === 'string' ? v.spectrumPath : '',
    chargeCorrection: v.chargeCorrection && typeof v.chargeCorrection === 'object' && !Array.isArray(v.chargeCorrection)
      ? v.chargeCorrection
      : null,
    updatedAt: Number(v.updatedAt) || 0,
    lastRun: v.lastRun && typeof v.lastRun === 'object' ? v.lastRun : null,
    stale,
    stale_reason: stale ? '选择的模板已不存在（可能被删除或改名）：这份选择已失效，请重新选模板' : '',
  };
}

/**
 * 荷电校正登记：{reference_peak, measured_ev, target_ev, shift_ev, method}。
 * 五个字段缺一不可 —— 只存 shift 的话，事后没人能判断它是怎么来的。
 */
export function validateChargeCorrection(raw) {
  // null = 未登记：路由层本来就放行，函数这里也必须接受，否则同一句 message 说「或 null」而实现报错。
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['chargeCorrection 必须是对象（null 表示未登记）'] };
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

/**
 * 记录「最近一次动作」（P1-5）：use / audit / runlog 都会调。以前 lastRun 只有读写定义、
 * 全仓没有一个写入者，选择态里的「上次跑的结果」永远是 null。写失败不影响主流程。
 */
export function recordLastRun(patch, root = stateRoot()) {
  try {
    const cur = readSelection(root);
    const prev = cur.lastRun !== null && typeof cur.lastRun === 'object' ? cur.lastRun : {};
    const next = {
      ...prev,
      at: new Date().toISOString(),
      kind: 'use',
      status: 'ok',
      templateId: cur.templateId,
      reason: '',
      runPath: null,
      verdict: null,
      r2: null,
      ...patch,
    };
    writeSelection({ lastRun: next }, root);
    return next;
  } catch {
    return null;
  }
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
  // schema v4：拟合区 [lo, hi]（eV）。与 applicable_window_ev 分工不同 ——
  // 前者是 xpspeak_fit 实际吃的窗口，后者只是「数据够不够长」的提示。
  let fitWindow = null;
  if (raw.fit_window_ev !== undefined && raw.fit_window_ev !== null) {
    const fw = raw.fit_window_ev;
    if (typeof fw !== 'object' || Array.isArray(fw)) {
      errors.push('fit_window_ev 必须是 {lo, hi}');
    } else {
      const lo = fw.lo;
      const hi = fw.hi;
      if (typeof lo !== 'number' || !Number.isFinite(lo) || lo < 0 || lo > 1500) {
        errors.push('fit_window_ev.lo 必须是 0–1500 的数字');
      } else if (typeof hi !== 'number' || !Number.isFinite(hi) || hi < 0 || hi > 1500) {
        errors.push('fit_window_ev.hi 必须是 0–1500 的数字');
      } else if (!(lo < hi)) {
        errors.push(`fit_window_ev.lo (${lo}) 必须小于 hi (${hi})`);
      } else {
        fitWindow = { lo, hi };
      }
    }
  }
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
  if (fitWindow !== null && windows !== null && Array.isArray(windows) && Number.isFinite(fwhmMax)) {
    const centers = windows.map((w) => w?.center_ev).filter((v) => typeof v === 'number' && Number.isFinite(v));
    if (centers.length > 0) {
      const needLo = Math.min(...centers) - fwhmMax;
      const needHi = Math.max(...centers) + fwhmMax;
      if (fitWindow.lo > needLo || fitWindow.hi < needHi) {
        errors.push(
          `fit_window_ev [${fitWindow.lo}, ${fitWindow.hi}] 没覆盖所有峰：至少要 [${needLo.toFixed(2)}, ${needHi.toFixed(2)}]（各峰 center ± fwhm_max=${fwhmMax}）`,
        );
      }
    }
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
      fit_window_ev: fitWindow,
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
    if (meta !== null && typeof meta === 'object' && typeof meta.id === 'string') {
      // 老模板（schema v1）里可能写着 tougaard：插件无法保证兑现该类型，读出来归一成 file，
      // 并把原文写进 note —— 不静默改写历史，用户还看得到它当初声明过什么。
      if (meta.background === 'tougaard') {
        const line = '原 background=tougaard，插件无法设置该类型，已按 file 处理（背景取自目标谱自带的 Background 列）';
        out.push({ ...meta, background: 'file', legacy_background: 'tougaard', note: meta.note ? `${meta.note} ${line}` : line });
      } else {
        out.push(meta);
      }
    }
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
  // file 的缩略图按 shirley 形状画：它只是示意图，不代表真实数据形状。
  if (background === 'linear') return t;
  return Math.sqrt(t); // shirley / file：更陡的台阶
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
/** 模板背景 → xpspeak_fit.bg。三者同名映射；file = 用谱图自带的 Background 列。 */
function fitBackground(background) {
  if (background === 'linear') return 'linear';
  if (background === 'file') return 'file';
  return 'shirley';
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
  let colsSeen = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t === '' || t.startsWith('#') || t.startsWith('//')) continue;
    const cols = t.split(/[\s,;\t]+/);
    if (cols.length < 2) continue;
    const v = Number(cols[0]);
    if (!Number.isFinite(v)) continue;
    if (n === 0) colsSeen = cols.length;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    n += 1;
  }
  // columns/has_background 只服务于「file 背景需要谱自带 Background 列」的前置检查（P1-7）。
  return n >= 2
    ? { lo, hi, columns: colsSeen, has_background: colsSeen >= 3, kind: /\.(xps|rpa)$/i.test(path) ? 'xps' : 'ascii' }
    : null;
}

export function useInstruction(template, mode, spectrum = null) {
  if (mode === 'teach') {
    return { ok: false, code: 'teaching-mode', message: '教学模式下不代执行 —— 这一步请你自己按下面顺序操作。' };
  }
  // P1-7：file = 用谱自带 Background 列。没有这一列的谱到 fit 中段才报「没有背景列」，
  // 前面几步（建区、加峰）已经白跑；所以在出指令前就拦下，并写清缺哪一列。
  if (template.background === 'file' && spectrum !== null && spectrum.kind === 'ascii'
    && spectrum.has_background === false) {
    return {
      ok: false,
      code: 'background-file-needs-column',
      message: `模板背景是 file（用目标谱自带的 Background 列），但这条谱只读到 ${spectrum.columns} 列：缺 Background 列。`
        + '需要 XPSPeak 导出的 3 列文本（B.E. / 强度 / Background），或换 shirley/linear 模板；'
        + '别先建区再等 fit 报「没有背景列」。',
      template: template.id,
      columns: spectrum.columns,
    };
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
  // 拟合区才是 xpspeak_fit 该吃的窗口；applicable_window_ev 只提示「数据够不够长」。
  // 实测反例：Ni 2p 模板 884.37–844.37（40 eV 全窗）拟合，R²=0.5869、4 项撞界；
  // 同一模板把窗口收窄到 844.37–866 后 R²=0.9481、无撞界 —— 40 eV 里 868–878 的 2p1/2 峰没建模，
  // 一进窗口就把优度拉低并逼着峰往边界跑。所以「文件扫描宽度」不能当拟合窗口用。
  const fw = template.fit_window_ev ?? null;
  let fitWindowArg = null;
  if (fw !== null) {
    const fwWidth = fw.hi - fw.lo;
    if (spectrum !== null && Number.isFinite(spectrum.lo) && Number.isFinite(spectrum.hi)) {
      const span = Math.abs(spectrum.hi - spectrum.lo);
      // 数据必须覆盖拟合区的 ≥90%（整数比较，避开 IEEE754：40*0.9 = 36.000000000000004）。
      if (span * 10 + 1e-9 < fwWidth * 9) {
        return {
          ok: false,
          code: 'window-too-narrow',
          message: `模板拟合区 ${fw.lo}–${fw.hi} eV（${fwWidth.toFixed(2)} eV），本次谱只有 ${span.toFixed(2)} eV（不足 90%）：数据覆盖不了拟合区，拒绝套用。请换足够宽的谱，或另建该宽度的模板。`,
          template: template.id,
          fit_window_ev: fw,
          spectrum_window_ev: span,
          min_window_ev: fwWidth * 0.9,
        };
      }
      const lo = Math.max(fw.lo, spectrum.lo);
      const hi = Math.min(fw.hi, spectrum.hi);
      if (!(lo < hi)) {
        return {
          ok: false,
          code: 'window-outside-spectrum',
          message: `模板拟合区 [${fw.lo}, ${fw.hi}] 与谱范围 [${spectrum.lo}, ${spectrum.hi}] 没有交集：拟合区上取不到数。`,
          template: template.id,
          fit_window_ev: fw,
          spectrum_window: [spectrum.lo, spectrum.hi],
        };
      }
      // P1-6：只判交集非空的话，交集剩 1–2 eV 也照跑，出来一个很难看但没人拦的 R²。
      // 下限 = max(3×fwhm_max, 5 eV)：小于 3 个最宽峰的半高宽，峰形就不可分辨；5 eV 是绝对下限。
      const fwhmMax = typeof template.fwhm_max === 'number' && Number.isFinite(template.fwhm_max)
        ? template.fwhm_max
        : 1.0;
      const minWin = Math.max(3 * fwhmMax, 5);
      if ((hi - lo) + 1e-9 < minWin) {
        return {
          ok: false,
          code: 'window-too-narrow',
          message: `拟合区与谱范围的交集只有 ${(hi - lo).toFixed(2)} eV（[${lo.toFixed(2)}, ${hi.toFixed(2)}]），`
            + `低于下限 ${minWin.toFixed(2)} eV（3×fwhm_max=${(3 * fwhmMax).toFixed(2)} eV 与 5 eV 取大）：`
            + '这么窄的窗口算出来的 R²/面积没有意义，拒绝套用。请换覆盖更全的谱，或把模板的 fit_window_ev 与谱对齐。',
          template: template.id,
          fit_window_ev: fw,
          window: [lo, hi],
          window_ev: hi - lo,
          min_window_ev: minWin,
        };
      }
      fitWindowArg = [lo, hi];
      if (Math.abs(lo - fw.lo) > 1e-9 || Math.abs(hi - fw.hi) > 1e-9) {
        warnings.push(`谱范围只覆盖拟合区的一部分：window 取交集 [${lo.toFixed(2)}, ${hi.toFixed(2)}]（模板 [${fw.lo.toFixed(2)}, ${fw.hi.toFixed(2)}]），边界峰的面积只按交集积分。`);
      }
    } else {
      fitWindowArg = [fw.lo, fw.hi];
      warnings.push(`没拿到目标谱范围：window 按模板 [${fw.lo.toFixed(2)}, ${fw.hi.toFixed(2)}] 原样传入，未核对谱是否覆盖。`);
    }
  } else {
    warnings.push('模板未写 fit_window_ev：本次按整条谱拟合，窗口外的峰（如 2p1/2）若未建模会把 R² 拉低、并把峰逼向边界。请补 fit_window_ev —— 记的是拟合区，不是文件扫描宽度。');
  }
  // applicable_window_ev 降级为「数据够不够长」的提示，不再当拟合窗口。
  if (typeof template.applicable_window_ev === 'number') {
    if (spectrum !== null && Number.isFinite(spectrum.lo) && Number.isFinite(spectrum.hi)) {
      const span = Math.abs(spectrum.hi - spectrum.lo);
      if (span < template.applicable_window_ev) {
        warnings.push(`数据宽度 ${span.toFixed(2)} eV 比模板记录的 ${template.applicable_window_ev} eV 短：边界峰不可比（只作提示，不拦）。`);
      }
    } else {
      warnings.push(`模板记的数据宽度 ${template.applicable_window_ev} eV，但没拿到目标谱范围，未核对。`);
    }
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
  // 荷电校正：插件没有平移能量的能力（XPSPeak 的 Region Shift 是手工菜单，插件不代跑）。
  // 模板记了非 0 的 charge_correction_ev，就说明「拟合前目标谱必须已经按参考峰校正过」；
  // 这里只把它写成一条前置步骤 + 预期基准，绝不当成已经施加。
  const chargeEv = typeof template.charge_correction_ev === 'number' ? template.charge_correction_ev : null;
  const chargeNeeded = chargeEv !== null && Math.abs(chargeEv) > 1e-9;
  const referencePeak = typeof template.reference_peak === 'string' ? template.reference_peak : '';
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
        fit_window_ev: template.fit_window_ev ?? null,
        charge_correction_ev: template.charge_correction_ev ?? null,
        // 显式标注「未施加」：下游 agent 必须自己核对目标谱是否已校正，不能把这串数当既成事实。
        charge_correction: chargeNeeded
          ? {
            ev: chargeEv,
            reference_peak: referencePeak,
            applied: false,
            note: `插件不平移能量：目标谱必须已按 ${referencePeak || '参考峰'} 校正（模板记录 ${chargeEv > 0 ? '+' : ''}${chargeEv.toFixed(2)} eV）。applied=false 表示本流程没有施加这一步。`,
          }
          : null,
        reference_peak: template.reference_peak ?? '',
        provenance: template.provenance ?? null,
        peak_windows: win,
      },
      warnings,
      steps: [
        { tool: 'xpspeak_status', arguments: {}, why: '确认软件在跑、看当前档位与窗口' },
        { tool: 'xpspeak_open', arguments: { path: '<你的谱图路径>' }, why: '载入谱图' },
        // 先校正再拟合：插件不平移能量，这一步只能由人或上游脚本完成，所以写成前置条件而不是工具步。
        ...(chargeNeeded
          ? [{
            tool: null,
            kind: 'precondition',
            arguments: { charge_correction_ev: chargeEv, reference_peak: referencePeak || null },
            why: `先校正再拟合：插件不平移能量。目标谱必须已按 ${referencePeak || '参考峰'} 校正（模板记录的是 ${chargeEv > 0 ? '+' : ''}${chargeEv.toFixed(2)} eV）；载入后先核对参考峰峰位是否已是校正后的值，未校正就不许往下做 fit，否则峰位差多少无从复算。`,
          }]
          : []),
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
            bg: fitBackground(template.background),
            ...(fitWindowArg === null ? {} : { window: fitWindowArg }),
          },
          why: '全部参数交给 xpspeak_fit（Δ 固定、面积比固定、双峰等宽）；撞界按提示调参后重拟合',
        },
        // 关键顺序：fit 是纯 Python 拟合，不往 GUI 里加峰；xpspeak_save 存的是 GUI 当前状态，
        // 所以「fit → save」会得到一份没有峰的 .xps。必须用 build 把 fit 的参数真正落进软件。
        {
          tool: 'xpspeak_build',
          arguments: {
            path: '<你的谱图路径>',
            peaks: '<把 xpspeak_fit 返回的每峰 {pos, fwhm, area} 按峰序逐条填进来；gl 取该峰 eta×100。面积必须用本次 fit 的返回值，不要用模板里供对照的实测面积>',
            out: '<产物 .xps 的路径>',
            spec: '<导出的谱图 .dat>',
            par: '<导出的峰参数表 .dat>',
            expect_bg: template.background,
            actual_bg: template.background,
            wlo: template.fwhm_min,
            whi: template.fwhm_max,
            ...(fitWindowArg === null ? {} : { window: fitWindowArg }),
          },
          why: 'fit 只算不写；build 才把参数加到 Region 并保存 .xps。build 一次写出 .xps + 导出谱图 + 峰参数，不要再让 xpspeak_export / xpspeak_save 写同一个文件',
        },
      ],
      notes: [
        'Add Peak 是菜单命令，不接收位置/宽度参数：要手工加峰壳请在软件里点（xpspeak_menu {top:"Add Peak"} 只会建空峰壳）。',
        '流程是 fit → build：xpspeak_fit 只算不写 GUI（Region 里不会有峰），xpspeak_build 才把峰参数加进软件并保存 .xps。build 自己会导出谱图与峰参数，别再用 xpspeak_export / xpspeak_save 写同一个文件。',
        fitWindowArg === null
          ? '本次没有 window 参数：xpspeak_fit 会吃整条谱（见上面关于 fit_window_ev 的警告）。'
          : `window=[${fitWindowArg.map((v) => v.toFixed(2)).join(', ')}]：只在拟合区内取数（模板 fit_window_ev 与谱范围取交集），R² 与残差也按这个窗口算。`,
        `peak_windows[].center_ev 是拟合初值；search_ev 是窗口半宽，已折算成 ctol=${ctol}（xpspeak_fit 只收一个标量，取各峰 search_ev 的最大值，缺省 1.0）。`,
        `eta=${Array.isArray(etaArg) ? etaArg.map((v) => v.toFixed(2)).join('/') + '（逐峰，来自 peak_windows[].eta）' : etaArg + '（模板标量：各峰未写 peak_windows[].eta，全部按这一个值拟合）'}（%Lorentzian；缺省 0.3 是老模板回落值，实测谱主峰常 0.4–0.5、卫星 1.0，能填就填）。`,
        'peak_windows[].observed 只记这一次的实测值（峰位/宽/GL/面积/占比），供换样品时对照，绝不传给 xpspeak_fit —— 要让它影响拟合，必须显式写 peak_windows[].eta；面积比固定与否由你决定。',
        ...(template.background === 'file'
          ? ['模板背景是 file：用目标谱自带的 Background 列，插件不做模型假设；目标谱没有背景列（纯两列 ASCII）就用不了这个模板，请换带背景列的谱或改用 shirley/linear 模板。']
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
        // 上传的老模板同理：tougaard → file，并留下原文，不静默改写。
        if (raw !== null && typeof raw === 'object' && raw.background === 'tougaard') {
          const line = '原 background=tougaard，插件无法设置该类型，已按 file 处理（背景取自目标谱自带的 Background 列）';
          raw = { ...raw, background: 'file', note: raw.note ? `${raw.note} ${line}` : line };
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
            // 失败的 use 也要留痕：否则「上次跑的结果」永远停留在上一次成功。
            recordLastRun({ kind: 'use', status: 'blocked', templateId: template.id, reason: `${result.code}: ${result.message}` }, root);
            return sendJson(res, status, { ...result, mode: mode.mode, note: mode.note, selection: readSelection(root) });
          }
          recordLastRun({ kind: 'use', status: 'ok', templateId: template.id, spectrumPath }, root);
          return sendJson(res, 200, { ...result, mode: mode.mode, note: mode.note, selection: readSelection(root) });
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
        // P0-3：审计必须和 fit 同口径——按拟合区算 R²/残差。窗口来源 body.window 优先，
        // 其次模板 fit_window_ev，再与谱范围取交集；两者都没有就是整条谱，回包里标 window_mode=full。
        let auditWindow = null;
        let windowMode = 'full';
        const rawWin = body.window ?? (template !== null ? template.fit_window_ev ?? null : null);
        if (rawWin !== null && rawWin !== undefined) {
          const lo = Array.isArray(rawWin) ? Number(rawWin[0]) : Number(rawWin.lo);
          const hi = Array.isArray(rawWin) ? Number(rawWin[1]) : Number(rawWin.hi);
          if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) {
            return sendJson(res, 400, { ok: false, code: 'bad-window', message: 'window 必须是 [lo, hi] 或 {lo, hi} 且 lo≠hi' });
          }
          windowMode = body.window !== undefined && body.window !== null ? 'body' : 'template';
          let sp = null;
          try {
            sp = parseSpectrum(body.spectrumPath);
          } catch (error) {
            return sendJson(res, 400, { ok: false, code: 'bad-spectrum', message: String(error?.message ?? error) });
          }
          const sLo = Math.min(...sp.be);
          const sHi = Math.max(...sp.be);
          const iLo = Math.max(Math.min(lo, hi), sLo);
          const iHi = Math.min(Math.max(lo, hi), sHi);
          if (!(iHi - iLo > 0)) {
            return sendJson(res, 422, {
              ok: false,
              code: 'window-outside-spectrum',
              message: `拟合区 [${Math.min(lo, hi)}, ${Math.max(lo, hi)}] 与谱范围 [${sLo}, ${sHi}] 没有交集：无法按拟合区审`,
            });
          }
          auditWindow = [iLo, iHi];
        }
        try {
          const out = auditArtifacts({
            spectrumPath: body.spectrumPath,
            peaksPath: body.peaksPath,
            template,
            window: auditWindow,
            runPath: typeof body.runPath === 'string' && body.runPath !== '' ? body.runPath : null,
          });
          recordLastRun({
            kind: 'audit',
            status: out.verdict ?? 'unknown',
            verdict: out.verdict ?? null,
            templateId: body.templateId ?? null,
            r2: typeof out.summary?.r2 === 'number' ? out.summary.r2 : null,
            runPath: typeof body.runPath === 'string' && body.runPath !== '' ? body.runPath : null,
            reason: '',
          }, root);
          return sendJson(res, 200, { ok: true, window_mode: windowMode, window: auditWindow, ...out });
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
        const runPath = join(body.dir, 'run.json');
        // run.json 是交付凭证：同一个目录第二次写必须显式要求覆盖，否则 409 并把旧内容
        // 原样带回——否则静默覆盖 createdAt，事后无法判断这份产物是哪一次跑出来的。
        if (existsSync(runPath) && body.overwrite !== true) {
          let existing = null;
          try {
            existing = JSON.parse(readFileSync(runPath, 'utf8'));
          } catch {
            existing = null;
          }
          return sendJson(res, 409, {
            ok: false,
            code: 'runlog-exists',
            message: `${runPath} 已存在；要覆盖请显式传 overwrite:true`,
            path: runPath,
            run: existing,
          });
        }
        const run = {
          templateId: typeof body.templateId === 'string' && body.templateId !== '' ? body.templateId : null,
          createdAt: new Date().toISOString(),
          fit: body.fit && typeof body.fit === 'object' ? body.fit : null,
          result: body.result && typeof body.result === 'object' ? body.result : null,
          chargeCorrection: body.chargeCorrection && typeof body.chargeCorrection === 'object' ? body.chargeCorrection : null,
          // build 的强制放行必须留痕：forced=true 与未过门槛明细原样进 run.json，
          // 否则「force 过了」这件事只能靠回包文本回忆，事后无法核对。
          forced: body.forced === true,
          preflight: body.preflight && typeof body.preflight === 'object' ? body.preflight : null,
          artifacts,
        };
        writeFileSync(runPath, `${JSON.stringify(run, null, 1)}\n`, 'utf8');
        // runlog 是整条链唯一「真跑完了」的证据，顺手把结果写回选择态。
        recordLastRun({
          kind: 'runlog',
          status: 'delivered',
          templateId: run.templateId,
          runPath,
          r2: run.result && typeof run.result.r2 === 'number' ? run.result.r2 : null,
          reason: '',
        }, root);
        return sendJson(res, 200, { ok: true, path: runPath, run, selection: readSelection(root) });
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
        writeSelection({ templateId: body.templateId, spectrumPath: body.spectrumPath, chargeCorrection }, root);
        // 回包必须走 readSelection：writeSelection 的返回是写盘对象，没有 stale/stale_reason，
        // 直接回它会让「模板已失效」在这个接口上看不见。
        return sendJson(res, 200, { ok: true, selection: readSelection(root) });
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
