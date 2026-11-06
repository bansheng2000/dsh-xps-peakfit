#!/usr/bin/env node
/**
 * dsh-xps-peakfit 自检（纯 node，无依赖，不碰用户真目录）
 * =========================================================
 * 跑：node test/selftest.mjs        （或 npm test）
 *
 * 覆盖 Chief 的验收项：
 *   模板 CRUD / /xps/* 各路由状态码 / 空态 0 张卡 / 非法扩展名与超大文件被拒 /
 *   教学档「用这个」服务端拒绝 / sha256 两分支 / tab 注册契约 / 服务端无 MCP 调用
 * 外加两条防回归：jsx-runtime 语义（第三参丢弃）与 pseudoVoigt ↔ python gl 对拍。
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as createHttpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createTemplate,
  createRoutes,
  listTemplates,
  pseudoVoigt,
  readFavorites,
  readMode,
  readSelection,
  removeTemplate,
  renameTemplate,
  sha256,
  selectionFile,
  validateChargeCorrection,
  stateRoot,
  thumbSvg,
  useInstruction,
  validateTemplate,
  writeSelection,
  writeFavorites,
} from '../lib/routes.js';
import { SERVER_FILES, packagedServerDir, syncServerFiles } from '../lib/index.js';
import { auditArtifacts, parsePeaks, parseSpectrum } from '../lib/audit.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (error) {
    failures.push(`${name}: ${error?.message ?? error}`);
    process.stdout.write(`  FAIL ${name}: ${error?.message ?? error}\n`);
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'xpk-selftest-'));
const root = join(tmp, 'root');
mkdirSync(root, { recursive: true });

/* ───────── 1. 档位真源（与 xpspeak_mcp.py 同口径） ───────── */

process.stdout.write('\n[1] mode.json 三情形\n');
const envNone = { ...process.env, XPSPEAK_ROOT: root, XPSPEAK_MODE: '', XPSPEAK_MODE_FILE: '' };
check('文件不存在且无 env → exec', () => assert.equal(readMode(envNone).mode, 'exec'));
check('无文件 + XPSPEAK_MODE=teach → teach', () => assert.equal(readMode({ ...envNone, XPSPEAK_MODE: 'teach' }).mode, 'teach'));
const modeFile = join(root, 'mode.json');
writeFileSync(modeFile, '{"mode": "teach", oops', 'utf8');
check('坏文件 → teach 且 note 写明损坏', () => {
  const r = readMode(envNone);
  assert.equal(r.mode, 'teach');
  assert.match(r.note ?? '', /mode\.json 损坏/);
});
writeFileSync(modeFile, '{"mode":"bogus"}', 'utf8');
check('mode 取值非法 → teach', () => {
  const r = readMode(envNone);
  assert.equal(r.mode, 'teach');
  assert.match(r.note ?? '', /不是 teach\/exec/);
});
writeFileSync(modeFile, '{"mode":"exec","updatedAt":1,"source":"tool"}', 'utf8');
check('合法 exec → exec', () => assert.equal(readMode(envNone).mode, 'exec'));

/* ───────── 2. 模板校验 ───────── */

process.stdout.write('\n[2] 模板校验（坏的一条都不落）\n');
const GOOD = {
  name: 'MoS2 S 2p',
  category: 'sulfur',
  element: 'Mo',
  orbital: '3d',
  doublet_delta_ev: 3.1,
  peak_windows: [{ label: 'Mo 3d5/2', center_ev: 229.0, search_ev: 0.5 }],
  fwhm_min: 0.6,
  fwhm_max: 1.6,
  background: 'shirley',
  constraints: { area_ratio: 1.5, equal_fwhm: true },
  note: '',
};
check('合法模板通过', () => assert.equal(validateTemplate(GOOD).ok, true));
check('缺字段被拒并逐条报错', () => {
  const r = validateTemplate({ name: 'x' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 5, `errors=${r.errors.length}`);
});
check('background 非法被拒', () => {
  const r = validateTemplate({ ...GOOD, background: 'voigt' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('background')));
});
check('fwhm_min >= fwhm_max 被拒', () => {
  const r = validateTemplate({ ...GOOD, fwhm_min: 2, fwhm_max: 1 });
  assert.equal(r.ok, false);
});
check('峰数 >10 被拒（XPSPeak 上限）', () => {
  const many = Array.from({ length: 11 }, (_, i) => ({ label: `p${i}`, center_ev: 160 + i, search_ev: 0.3 }));
  assert.equal(validateTemplate({ ...GOOD, peak_windows: many }).ok, false);
});

/* ───────── 3. CRUD ───────── */

process.stdout.write('\n[3] 模板 CRUD\n');
let created = null;
check('空目录 → 0 条', () => assert.equal(listTemplates(root).length, 0));
check('创建 → 1 条，id 由服务端生成', () => {
  const r = createTemplate(GOOD, root);
  assert.equal(r.ok, true);
  created = r.template;
  assert.match(created.id, /^[a-z0-9][a-z0-9-]{0,63}$/);
  assert.equal(listTemplates(root).length, 1);
});
check('改名只动 name，id 不变', () => {
  const r = renameTemplate(created.id, 'MoS2 S 2p（改）', root);
  assert.equal(r.ok, true);
  assert.equal(r.template.id, created.id);
  assert.equal(r.template.name, 'MoS2 S 2p（改）');
});
check('收藏写入并回读', () => {
  writeFavorites([created.id, 'nope-not-exist'], root);
  const favs = readFavorites(root);
  assert.deepEqual(favs, [created.id]);
});
check('删除同时从收藏里剔掉', () => {
  const r = removeTemplate(created.id, root);
  assert.equal(r.ok, true);
  assert.equal(listTemplates(root).length, 0);
  assert.deepEqual(readFavorites(root), []);
});
check('删不存在的 → not-found', () => assert.equal(removeTemplate('nope', root).code, 'not-found'));

/* ───────── 4. 缩略图 ───────── */

process.stdout.write('\n[4] 缩略图 SVG\n');
check('有参数 → 画折线', () => {
  const svg = thumbSvg(GOOD);
  assert.match(svg, /^<svg/);
  assert.match(svg, /<polyline/);
});
check('无参数 → 占位（不编谱）', () => {
  const svg = thumbSvg({ peak_windows: [], fwhm_min: 0.6, fwhm_max: 1.6, background: 'shirley' });
  assert.match(svg, /无参数/);
  assert.doesNotMatch(svg, /<polyline/);
});

/* ───────── 5. HTTP 路由 ───────── */

process.stdout.write('\n[5] /xps/* 路由（真 HTTP，真状态码）\n');

function request(port, path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    const req = createRequest({ port, path, method, headers, payload });
    req.then(resolve, reject);
  });
}
function createRequest({ port, path, method, headers, payload }) {
  return new Promise((resolve, reject) => {
    const req = createHttpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: { host: '127.0.0.1', ...headers, ...(payload === null ? {} : { 'content-length': payload.length }) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, type: String(res.headers['content-type'] ?? ''), text, json });
        });
      },
    );
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

const httpServer = createServer(createRoutes({ root, env: { ...process.env, XPSPEAK_ROOT: root, XPSPEAK_MODE: '', XPSPEAK_MODE_FILE: '' } }));
await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
const port = httpServer.address().port;

const empty = await request(port, '/xps/templates');
check('GET /templates → 200 且空态 0 张卡', () => {
  assert.equal(empty.status, 200);
  assert.equal(empty.json.templates.length, 0);
  assert.equal(empty.json.mode.mode, 'exec');
});
const nonLoop = await request(port, '/xps/templates', { headers: { host: 'evil.example' } });
check('非回环 Host → 403', () => {
  assert.equal(nonLoop.status, 403);
  assert.equal(nonLoop.json.code, 'not-loopback');
});
const badExt = await request(port, '/xps/templates?filename=a.txt', { method: 'POST', body: '{}' });
check('上传非 .json → 400', () => assert.equal(badExt.status, 400));
const tooBig = await request(port, '/xps/templates?filename=big.json', { method: 'POST', body: 'x'.repeat(300 * 1024) });
check('上传 >256KB → 413', () => assert.equal(tooBig.status, 413));
const badJson = await request(port, '/xps/templates?filename=a.json', { method: 'POST', body: '{not json' });
check('上传坏 JSON → 400', () => assert.equal(badJson.status, 400));
const badTemplate = await request(port, '/xps/templates?filename=a.json', { method: 'POST', body: JSON.stringify({ name: 'x' }) });
check('上传缺字段 → 400 且不落盘', () => {
  assert.equal(badTemplate.status, 400);
  assert.equal(listTemplates(root).length, 0);
});
const uploaded = await request(port, '/xps/templates?filename=a.json', { method: 'POST', body: JSON.stringify(GOOD) });
check('上传合法模板 → 201', () => {
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.json.template.name, GOOD.name);
});
const id = uploaded.json.template.id;
const thumb = await request(port, `/xps/thumb/${id}`);
check('GET /thumb/<id> → 200 image/svg+xml', () => {
  assert.equal(thumb.status, 200);
  assert.match(thumb.type, /image\/svg\+xml/);
  assert.match(thumb.text, /<svg/);
});
const thumb404 = await request(port, '/xps/thumb/t0-nope');
check('GET /thumb/<不存在> → 404', () => assert.equal(thumb404.status, 404));

// 教学档：「用这个」必须由**服务端**拒绝（前端 disabled 只是体验）
writeFileSync(modeFile, '{"mode":"teach","updatedAt":1,"source":"tool"}', 'utf8');
const useTeach = await request(port, `/xps/templates/${id}/use`, { method: 'POST', body: '{}' });
check('教学档 use → 403 且 code=teaching-mode', () => {
  assert.equal(useTeach.status, 403);
  assert.equal(useTeach.json.code, 'teaching-mode');
  assert.match(useTeach.json.message, /教学模式下不代执行/);
});
writeFileSync(modeFile, '{"mode":"exec","updatedAt":2,"source":"tool"}', 'utf8');
const useExec = await request(port, `/xps/templates/${id}/use`, { method: 'POST', body: '{}' });
check('代执行档 use → 200 且只给指令', () => {
  assert.equal(useExec.status, 200);
  assert.ok(Array.isArray(useExec.json.instruction.steps) && useExec.json.instruction.steps.length >= 4);
  assert.equal(useExec.json.instruction.fields.element, GOOD.element);
});
check('「用这个」的 steps 不含裸 Add Peak 菜单步（菜单通道不接收位置/宽度参数）', () => {
  const steps = useExec.json.instruction.steps;
  const bare = steps.filter((s) => s.tool === 'xpspeak_menu' && s.arguments !== undefined && s.arguments.top === 'Add Peak');
  assert.equal(bare.length, 0, `steps 里不能有裸 xpspeak_menu Add Peak（只会建空峰壳），实际 ${bare.length} 条`);
});
check('fit 步参数真来自模板：fwhm_max +0.5 → whi 跟着走，菜单步不承载参数', () => {
  const t2 = { ...GOOD, fwhm_max: GOOD.fwhm_max + 0.5 };
  const ins = useInstruction(t2, 'exec').instruction;
  const fits = ins.steps.filter((s) => s.tool === 'xpspeak_fit');
  assert.equal(fits.length, 1, 'steps 里必须恰有一个 xpspeak_fit');
  assert.equal(fits[0].arguments.whi, t2.fwhm_max, 'whi 必须取模板 fwhm_max');
  for (const s of ins.steps) {
    if (s.tool === 'xpspeak_menu') {
      assert.doesNotMatch(String(s.why), /[0-9]/, '菜单步不承载参数（峰位/宽度一律交给 xpspeak_fit）');
    }
  }
});
// B1：选择态（一键化的入口）
const selSet = await request(port, '/xps/selection', {
  method: 'POST',
  body: JSON.stringify({ templateId: id, spectrumPath: 'D:/data/Ni2p.dat' }),
});
check('POST /selection 写入并回读（templateId + spectrumPath）', () => {
  assert.equal(selSet.status, 200);
  assert.equal(selSet.json.selection.templateId, id);
  assert.equal(selSet.json.selection.spectrumPath, 'D:/data/Ni2p.dat');
  const back = readSelection(root);
  assert.equal(back.templateId, id);
  assert.ok(back.updatedAt > 0);
});
const selGet = await request(port, '/xps/selection');
check('GET /selection 回读一致', () => {
  assert.equal(selGet.status, 200);
  assert.equal(selGet.json.selection.templateId, id);
});
const selClear = await request(port, '/xps/selection', { method: 'POST', body: JSON.stringify({ templateId: null }) });
check('POST /selection templateId=null → 取消选择', () => {
  assert.equal(selClear.status, 200);
  assert.equal(selClear.json.selection.templateId, null);
  assert.equal(readSelection(root).templateId, null);
});
writeFileSync(modeFile, '{"mode":"teach","updatedAt":3,"source":"tool"}', 'utf8');
const selTeach = await request(port, '/xps/selection', { method: 'POST', body: JSON.stringify({ templateId: id }) });
check('教学档 POST /selection → 403 teaching-mode', () => {
  assert.equal(selTeach.status, 403);
  assert.equal(selTeach.json.code, 'teaching-mode');
});
writeFileSync(modeFile, '{"mode":"exec","updatedAt":4,"source":"tool"}', 'utf8');

const renamed = await request(port, `/xps/templates/${id}/rename`, { method: 'POST', body: JSON.stringify({ name: '改过的名字' }) });
check('POST rename → 200', () => {
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.template.name, '改过的名字');
});
const favs = await request(port, '/xps/favorites', { method: 'POST', body: JSON.stringify({ favorites: [id] }) });
check('POST favorites → 200', () => {
  assert.equal(favs.status, 200);
  assert.deepEqual(favs.json.favorites, [id]);
});
const deleted = await request(port, `/xps/templates/${id}`, { method: 'DELETE' });
check('DELETE → 200 且收藏已剔掉', () => {
  assert.equal(deleted.status, 200);
  assert.equal(listTemplates(root).length, 0);
  assert.deepEqual(readFavorites(root), []);
});
const noRoute = await request(port, '/xps/nope');
check('未知子路由 → 404', () => assert.equal(noRoute.status, 404));
await new Promise((resolve) => httpServer.close(resolve));
/* ───────── 6. server/*.py 同步两分支 ───────── */

/* ── schema v2：ctol / eta / 老模板回落 / observed 只作参照 / 详情表 ── */

check('① search_ev → xpspeak_fit.ctol（取各峰最大值，模板只存一个标量）', () => {
  const t = {
    ...GOOD,
    peak_windows: [
      { label: 'Mo 3d5/2', center_ev: 229.0, search_ev: 0.6 },
      { label: 'Mo 3d3/2', center_ev: 232.1, search_ev: 0.4 },
    ],
  };
  const ins = useInstruction(t, 'exec').instruction;
  const fit = ins.steps.find((s) => s.tool === 'xpspeak_fit');
  assert.equal(fit.arguments.ctol, 0.6, 'ctol 必须取各峰 search_ev 的最大值（0.6）');
  assert.equal(ins.fields.ctol, 0.6, 'fields 也要带 ctol，人看到的和实际传的必须一致');
});

check('② eta → xpspeak_fit.eta（实测 %GL 45–48%，不许固定 0.3）', () => {
  const ins = useInstruction({ ...GOOD, eta: 0.45 }, 'exec').instruction;
  const fit = ins.steps.find((s) => s.tool === 'xpspeak_fit');
  assert.equal(fit.arguments.eta, 0.45);
  assert.equal(ins.fields.eta, 0.45);
});

check('③ 老模板（无 eta / 无 search_ev）→ ctol 1.0、eta 0.3，use 仍 ok', () => {
  const legacy = { ...GOOD, peak_windows: [{ label: 'Mo 3d5/2', center_ev: 229.0 }] };
  const r = useInstruction(legacy, 'exec');
  assert.equal(r.ok, true, '缺新字段不能把老模板挡在门外');
  const fit = r.instruction.steps.find((s) => s.tool === 'xpspeak_fit');
  assert.equal(fit.arguments.ctol, 1.0, 'ctol 回落到 xpspeak_fit 默认值 1.0');
  assert.equal(fit.arguments.eta, 0.3, 'eta 回落到默认 0.3');
});

check('⑦ 缺 eta 的模板 use 带非空 warnings；写了 eta 的不给警告', () => {  const noEta = { ...GOOD, peak_windows: [{ label: 'Mo 3d5/2', center_ev: 229.0 }] };
  const r1 = useInstruction(noEta, 'exec');
  assert.equal(r1.ok, true, '缺 eta 不是错误，不能拦');
  assert.ok(Array.isArray(r1.instruction.warnings) && r1.instruction.warnings.length > 0, '缺 eta 必须给非空 warnings');
  const r2 = useInstruction({ ...GOOD, eta: 0.45 }, 'exec');
  // 第五批起 warnings 里可能还有「老模板无 fit_window_ev」这类提示，只要求不再有 eta 相关的警告
  assert.deepEqual(r2.instruction.warnings.filter((w) => /eta/i.test(w)), [], '写了 eta 就不该再提示 eta');
});

check('④ observed 只作对照，绝不进 fit 参数（面积比不固定是用户决定）', () => {
  const t = {
    ...GOOD,
    peak_windows: [
      {
        label: 'Mo 3d5/2',
        center_ev: 229.0,
        search_ev: 0.5,
        observed: { center_ev: 229.12, fwhm_ev: 0.92, gl_pct: 46, area: 12000, share_pct: 62 },
      },
    ],
  };
  const ins = useInstruction(t, 'exec').instruction;
  const fit = ins.steps.find((s) => s.tool === 'xpspeak_fit');
  const keys = Object.keys(fit.arguments);
  for (const k of ['observed', 'area', 'share_pct', 'fwhm_ev', 'gl_pct']) {
    assert.ok(!keys.includes(k), `fit 参数里不能出现 ${k}（只做参照）`);
  }
  assert.equal(ins.fields.peak_windows[0].observed.share_pct, 62, 'observed 必须原样带进 fields 供对照');
});

/* ── 第二批：逐峰 eta 正式化 / 窗口适用性 ── */

check('W1 逐峰 eta 读 peak_windows[].eta；observed.gl_pct 不再进拟合', () => {
  const t = {
    ...GOOD,
    eta: 0.3,
    peak_windows: [
      { label: 'a', center_ev: 229.0, eta: 0.48, observed: { gl_pct: 64 } },
      { label: 'b', center_ev: 232.1, eta: 1.0 },
      { label: 'c', center_ev: 235.0 },
    ],
  };
  const ins = useInstruction(t, 'exec').instruction;
  const eta = ins.steps.find((s) => s.tool === 'xpspeak_fit').arguments.eta;
  assert.deepEqual(eta, [0.48, 1, 0.3], '逐峰 eta 必须取 peak_windows[].eta，缺的回落模板标量');
  assert.notEqual(eta[0], 0.64, 'observed.gl_pct 不许再进拟合（它只作对照）');
  assert.match(ins.notes.join('\n'), /peak_windows\[\]\.eta/, 'notes 要指向逐峰 eta 字段');
});

check('W2 老模板（只有标量 eta）→ 仍按标量拟合，notes 说明没有逐峰值', () => {
  const ins = useInstruction({ ...GOOD, eta: 0.45 }, 'exec').instruction;
  const fit = ins.steps.find((s) => s.tool === 'xpspeak_fit');
  assert.equal(fit.arguments.eta, 0.45);
  assert.match(ins.notes.join('\n'), /标量/, 'notes 要说明本次用的是模板标量');
});

check('W3 schema：peak_windows[].eta 与 applicable_window_ev 的范围校验', () => {
  const ok = validateTemplate({ ...GOOD, applicable_window_ev: 40, peak_windows: [{ label: 'a', center_ev: 229, eta: 0.5 }] });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(ok.template.applicable_window_ev, 40);
  assert.equal(ok.template.peak_windows[0].eta, 0.5);
  for (const bad of [
    { ...GOOD, peak_windows: [{ label: 'a', center_ev: 229, eta: 1.5 }] },
    { ...GOOD, peak_windows: [{ label: 'a', center_ev: 229, eta: -0.1 }] },
    { ...GOOD, applicable_window_ev: 0 },
    { ...GOOD, applicable_window_ev: -3 },
  ]) assert.equal(validateTemplate(bad).ok, false, JSON.stringify(bad));
});

check('W4 拟合区闸：17.5 拒绝；39.8/36.0 取交集放行；35.99 判死；36.01 放行；无交集拒绝；老模板只警告', () => {
  const t = {
    ...GOOD,
    fit_window_ev: { lo: 844.1, hi: 884.1 },
    applicable_window_ev: 40,
    peak_windows: [{ label: 'Ni 2p3/2', center_ev: 864, eta: 0.5 }],
  };
  const narrow = useInstruction(t, 'exec', { lo: 844.1, hi: 861.6 }); // 17.5 eV
  assert.equal(narrow.ok, false, '拟合区覆盖不够必须拒绝');
  assert.equal(narrow.code, 'window-too-narrow');
  assert.match(narrow.message, /844\.1–884\.1/, 'message 要写模板拟合区');
  assert.match(narrow.message, /17\.50 eV/, 'message 要写本次实际宽度');
  const near = useInstruction(t, 'exec', { lo: 844.1, hi: 883.9 }); // 39.8 eV
  assert.equal(near.ok, true, '39.8 对 40 只差 0.2 eV，必须放行（取交集）');
  const nw = near.instruction.warnings.join('\n');
  assert.match(nw, /交集/, '放行时要写 window 取了交集');
  assert.match(nw, /883\.90/, '交集上界要写出来');
  const exact = useInstruction(t, 'exec', { lo: 848.1, hi: 884.1 }); // 36.0 = 90%
  assert.equal(exact.ok, true, '恰好 90%（36.0）应放行（整数比较，不吃浮点误差）');
  assert.equal(useInstruction(t, 'exec', { lo: 848.2, hi: 884.1 }).ok, false, '35.9 判死');
  assert.equal(useInstruction(t, 'exec', { lo: 848.11, hi: 884.1 }).ok, false, '35.99 判死');
  assert.equal(useInstruction(t, 'exec', { lo: 848.09, hi: 884.1 }).ok, true, '36.01 放行');
  const wide = useInstruction(t, 'exec', { lo: 830, hi: 875 });
  assert.equal(wide.ok, true, '45 比 40 宽，直接放行');
  assert.deepEqual(wide.instruction.steps.find((x) => x.tool === 'xpspeak_fit').arguments.window, [844.1, 875]);
  const disjoint = useInstruction(t, 'exec', { lo: 900, hi: 960 });
  assert.equal(disjoint.ok, false, '谱与拟合区没有交集必须拒绝');
  assert.equal(disjoint.code, 'window-outside-spectrum');
  const unknown = useInstruction(t, 'exec', null);
  assert.equal(unknown.ok, true, '拿不到谱就不能拦');
  assert.match(unknown.instruction.warnings.join('\n'), /未核对/);
  const old = useInstruction({ ...GOOD }, 'exec', { lo: 830, hi: 875 });
  assert.equal(old.ok, true, '老模板没有 fit_window_ev 不能拦');
  assert.match(old.instruction.warnings.join('\n'), /未写 fit_window_ev/);
  assert.equal(old.instruction.steps.find((x) => x.tool === 'xpspeak_fit').arguments.window, undefined, '老模板不传 window');
  const shortData = useInstruction(t, 'exec', { lo: 850, hi: 875 }); // 25 eV，但拟合区 40
  assert.equal(shortData.ok, false, '数据宽度不足拟合区 90% 必须拒绝');
  // applicable_window_ev 只提示数据长度，不再当拟合窗口：数据 39.8 < 记录 40 只 warn
  const hint = useInstruction({ ...t, applicable_window_ev: 40 }, 'exec', { lo: 844.1, hi: 883.9 });
  assert.equal(hint.ok, true, 'applicable_window_ev 不再拦');
  assert.match(hint.instruction.warnings.join('\n'), /只作提示/);
  // applicable_window_ev（数据要够长）与 fit_window_ev（拟合区）分工：50 对 30 也只提示
  const split = useInstruction({ ...t, fit_window_ev: { lo: 850, hi: 880 }, applicable_window_ev: 50 }, 'exec', { lo: 830, hi: 870 });
  assert.equal(split.ok, true, '闸只看 fit_window_ev，applicable_window_ev 不参与判决');
  assert.deepEqual(split.instruction.steps.find((x) => x.tool === 'xpspeak_fit').arguments.window, [850, 870]);
  assert.match(split.instruction.warnings.join('\n'), /只作提示/);
});

const w5SpecNarrow = join(tmp, 'w5-narrow.txt');
const w5SpecWide = join(tmp, 'w5-wide.txt');
writeFileSync(w5SpecNarrow, '# BE  intensity\n844.4  100\n850  500\n861.9  120\n', 'utf8');
writeFileSync(w5SpecWide, '830  10\n850  500\n875  20\n', 'utf8');
const w5Created = createTemplate({ ...GOOD, applicable_window_ev: 40, fit_window_ev: { lo: 844.1, hi: 884.1 }, peak_windows: [{ label: 'Ni 2p3/2', center_ev: 864 }] }, root);
const w5Srv = createServer(createRoutes({ root, env: { ...process.env, XPSPEAK_ROOT: root, XPSPEAK_MODE: '', XPSPEAK_MODE_FILE: '' } }));
await new Promise((resolve) => w5Srv.listen(0, '127.0.0.1', resolve));
const w5Port = w5Srv.address().port;
const w5Bad = await request(w5Port, `/xps/templates/${w5Created.template.id}/use`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spectrumPath: w5SpecNarrow }) });
const w5Good = await request(w5Port, `/xps/templates/${w5Created.template.id}/use`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spectrumPath: w5SpecWide }) });
await new Promise((resolve) => w5Srv.close(resolve));
removeTemplate(w5Created.template.id, root);

check('W5 HTTP：POST /templates/<id>/use 带谱图路径，窗口不足 → 422 window-too-narrow', () => {
  assert.equal(w5Created.ok, true, JSON.stringify(w5Created.errors));
  assert.equal(w5Bad.status, 422, JSON.stringify(w5Bad.json));
  assert.equal(w5Bad.json.code, 'window-too-narrow');
  assert.match(w5Bad.json.message, /17\.5/, '拒绝理由要写实际窗口宽度');
  assert.equal(w5Good.status, 200, JSON.stringify(w5Good.json));
  assert.equal(w5Good.json.ok, true);
  assert.deepEqual(
    w5Good.json.instruction.steps.find((x) => x.tool === 'xpspeak_fit').arguments.window,
    [844.1, 875],
    '谱比拟合区窄时要按交集传 window',
  );
});

/* ── 第三批：审计 / 荷电校正登记 / run.json ── */

const b3dir = join(tmp, 'b3');
mkdirSync(b3dir, { recursive: true });
const b3be = [];
for (let i = 0; i < 200; i += 1) b3be.push(Number((880 - i * 0.1).toFixed(3)));
const gauss = (x, c, fwhm, h) => h * Math.exp(-4 * Math.LN2 * ((x - c) / fwhm) ** 2);
const b3bg = b3be.map((x) => 500 + (880 - x) * 10);
const b3comp = b3be.map((x) => gauss(x, 870, 1.65, 20000) + gauss(x, 875, 1.05, 8000)); // 与峰表/模板窗口一致
const b3fit = b3comp.map((v, i) => v + b3bg[i]);
const b3raw = b3fit.map((v, i) => v + Math.sin(i));

function writeSpec(file, { be, raw, fit, bg }) {
  const head = 'B.E.(eV)\tRaw Intensity\tPeak Sum\tBackground\tdifference\n';
  const body = be.map((x, i) => [x, raw[i], fit[i], bg[i], raw[i] - fit[i]].map((v) => v.toFixed(3)).join('\t')).join('\n');
  writeFileSync(file, head + body + '\n', 'utf8');
  return file;
}

const b3spec = writeSpec(join(b3dir, 'good_spectrum.dat'), { be: b3be, raw: b3raw, fit: b3fit, bg: b3bg });
const b3peaks = join(b3dir, 'good_peaks.dat');
writeFileSync(
  b3peaks,
  ['Peak\tPosition (eV)\tArea\tFWHM (eV)\t%GL (%)', '0\t870.000\t90000\t1.650\t30', '1\t875.000\t40000\t1.050\t30'].join('\n') + '\n',
  'utf8',
);
const b3tpl = {
  ...GOOD,
  peak_windows: [{ label: 'a', center_ev: 870, observed: { fwhm_ev: 1.6, gl_pct: 30 } }, { label: 'b', center_ev: 875, observed: { fwhm_ev: 1.0, gl_pct: 30 } }],
  background: 'linear',
  applicable_window_ev: 18,
  fit_window_ev: { lo: 864, hi: 880 },
};

check('X1 审计好产物：R²/残差/峰顶缺口/窗口全过，verdict=pass', () => {
  const a = auditArtifacts({ spectrumPath: b3spec, peaksPath: b3peaks, template: b3tpl });
  assert.equal(a.checks.length, 7, JSON.stringify(a.checks));
  const byId = Object.fromEntries(a.checks.map((c) => [c.id, c]));
  assert.equal(byId['fit-quality'].status, 'pass', byId['fit-quality'].detail);
  assert.equal(byId['residual-structure'].status, 'pass', byId['residual-structure'].detail);
  assert.equal(byId['peak-gap'].status, 'pass', byId['peak-gap'].detail);
  assert.equal(byId['bg-shape'].status, 'pass', byId['bg-shape'].detail);
  assert.equal(byId['window-applicability'].status, 'pass', byId['window-applicability'].detail);
  assert.equal(a.verdict, 'pass');
});

check('X2 审计认得出「照搬模板」：FWHM 全等 + 峰位整体平移 → template-copied fail', () => {
  const copiedPeaks = join(b3dir, 'copied_peaks.dat');
  writeFileSync(
    copiedPeaks,
    ['Peak\tPosition (eV)\tArea\tFWHM (eV)\t%GL (%)', '0\t870.900\t90000\t1.600\t30', '1\t875.900\t40000\t1.000\t30'].join('\n') + '\n',
    'utf8',
  );
  const a = auditArtifacts({ spectrumPath: b3spec, peaksPath: copiedPeaks, template: b3tpl });
  const c = a.checks.find((x) => x.id === 'template-copied');
  assert.equal(c.status, 'fail', c.detail);
  assert.match(c.detail, /平移 0\.900 eV/);
  assert.equal(a.verdict, 'fail');
});

check('X3 审计认出 Fake 拟合与台阶背景：fit 差 10% + 背景列不是直线 → 双 fail', () => {
  const fake = join(b3dir, 'fake_spectrum.dat');
  const stepBg = b3be.map((x) => 500 + (880 - x) * 10 + (x < 870 ? 3000 : 0)); // 真实线性 + 台阶，偏离直线
  writeSpec(fake, { be: b3be, raw: b3fit, fit: b3fit.map((v) => v * 0.8), bg: stepBg });
  const a = auditArtifacts({ spectrumPath: fake, peaksPath: b3peaks, template: b3tpl });
  const byId = Object.fromEntries(a.checks.map((c) => [c.id, c]));
  assert.equal(byId['bg-shape'].status, 'fail', byId['bg-shape'].detail);
  assert.equal(byId['peak-gap'].status, 'fail', byId['peak-gap'].detail);
  assert.equal(a.verdict, 'fail');
});

check('X4 解析器只认文本导出：坏文件抛错，不静默给空结果', () => {
  const bad = join(b3dir, 'bad.dat');
  writeFileSync(bad, 'not a spectrum\n', 'utf8');
  // 「没有数字列」必须报列数，不能再说「行数不足 0 行」（2 列谱曾因此被误判为空文件）
  assert.throws(() => parseSpectrum(bad), /列数不足/);
  const ok = parseSpectrum(b3spec);
  assert.equal(ok.rows, 200);
  const pk = parsePeaks(b3peaks);
  assert.equal(pk.length, 2);
  assert.equal(pk[0].fwhm, 1.65);
});

const b3srv = createServer(createRoutes({ root, env: { ...process.env, XPSPEAK_ROOT: root, XPSPEAK_MODE: '', XPSPEAK_MODE_FILE: '' } }));
await new Promise((resolve) => b3srv.listen(0, '127.0.0.1', resolve));
const b3port = b3srv.address().port;
const b3created = createTemplate(b3tpl, root);
const auditOk = await request(b3port, '/xps/audit', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ spectrumPath: b3spec, peaksPath: b3peaks, templateId: b3created.template.id }),
});
const audit404 = await request(b3port, '/xps/audit', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ spectrumPath: b3spec, peaksPath: b3peaks, templateId: 'nope' }),
});
const useMissing = await request(b3port, `/xps/templates/${b3created.template.id}/use`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ spectrumPath: b3spec }),
});
const chargeOK = await request(b3port, '/xps/selection', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    templateId: b3created.template.id,
    spectrumPath: b3spec,
    chargeCorrection: { reference_peak: 'C 1s', measured_ev: 283.8, target_ev: 284.6, shift_ev: 0.8, method: 'linear 尾背景，C 1s 主峰单峰拟合' },
  }),
});
const chargeBad = await request(b3port, '/xps/selection', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    chargeCorrection: { reference_peak: 'C 1s', measured_ev: 283.8, target_ev: 284.6, shift_ev: 0.44, method: 'x' },
  }),
});
const selRead = await request(b3port, '/xps/selection');
const useWithCharge = await request(b3port, `/xps/templates/${b3created.template.id}/use`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ spectrumPath: b3spec }),
});
const runlog = await request(b3port, '/xps/runlog', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    dir: b3dir,
    templateId: b3created.template.id,
    fit: { ds: 0, ratio: 1, wlo: 0.6, whi: 1.6 },
    result: { r2: 0.99, rms: 1.2, bound: [], gates: [] },
    files: [b3spec, b3peaks],
    chargeCorrection: selRead.json.selection.chargeCorrection,
  }),
});
const runFile = join(b3dir, 'run.json');
const runJson = existsSync(runFile) ? JSON.parse(readFileSync(runFile, 'utf8')) : null;

check('X5 HTTP /xps/audit：200 带 verdict，模板不存在 404', () => {
  assert.equal(auditOk.status, 200, JSON.stringify(auditOk.json));
  assert.equal(auditOk.json.verdict, 'pass', JSON.stringify(auditOk.json.checks));
  assert.match(auditOk.json.scope, /不解析 \.xps/);
  assert.equal(audit404.status, 404);
});

check('X6 chargeCorrection 五字段：写入可回读，shift 与 target−measured 不自洽 → 400', () => {
  assert.equal(chargeOK.status, 200, JSON.stringify(chargeOK.json));
  assert.equal(chargeOK.json.selection.chargeCorrection.shift_ev, 0.8);
  assert.equal(selRead.json.selection.chargeCorrection.method.includes('linear'), true);
  assert.equal(chargeBad.status, 400, JSON.stringify(chargeBad.json));
  assert.equal(chargeBad.json.code, 'bad-charge-correction');
  assert.match(chargeBad.json.errors.join('\n'), /shift_ev 必须等于/);
  assert.equal(validateChargeCorrection({ reference_peak: 'C 1s' }).ok, false);
  assert.deepEqual(validateChargeCorrection(null), { ok: true, value: null }, 'null = 未登记，函数本身要放行（与路由 :911 一致）');
});

check('X7 use 缺荷电登记 → warnings 点名；登记后不再出现', () => {
  const missing = useMissing.json.instruction.warnings.join('\n');
  assert.match(missing, /缺 chargeCorrection/, '没登记时必须点名');
  const w = useWithCharge.json.instruction.warnings.join('\n');
  assert.doesNotMatch(w, /缺 chargeCorrection/, '已登记就不该再提示缺');
  assert.equal(selRead.json.selection.chargeCorrection.reference_peak, 'C 1s');
});

check('X8 /xps/runlog：写 run.json，产物 sha256 可复核；教学档 403', () => {
  assert.equal(runlog.status, 200, JSON.stringify(runlog.json));
  assert.equal(runJson.templateId, b3created.template.id);
  assert.equal(runJson.artifacts.length, 2);
  assert.equal(runJson.artifacts[0].sha256, sha256(readFileSync(b3spec)));
  assert.equal(runJson.artifacts[0].bytes, readFileSync(b3spec).length);
  assert.equal(runJson.result.r2, 0.99);
  assert.equal(runJson.chargeCorrection.shift_ev, 0.8);
  assert.match(runJson.createdAt, /^\d{4}-\d{2}-\d{2}T/);
});

// ---- 第六批：runlog 幂等 + 2 列/缺背景列的谱 ----
const runlogAgain = await request(b3port, '/xps/runlog', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    dir: b3dir,
    templateId: b3created.template.id,
    fit: { ds: 0, ratio: 1, wlo: 0.6, whi: 1.6 },
    result: { r2: 0.5 },
    files: [b3spec, b3peaks],
    chargeCorrection: selRead.json.selection.chargeCorrection,
  }),
});
const after409 = existsSync(runFile) ? JSON.parse(readFileSync(runFile, 'utf8')) : null;
await new Promise((resolve) => setTimeout(resolve, 5));
const runlogOver = await request(b3port, '/xps/runlog', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ dir: b3dir, files: [], overwrite: true }),
});
const runOverJson = existsSync(runFile) ? JSON.parse(readFileSync(runFile, 'utf8')) : null;

const twoColPath = join(b3dir, 'two_col.dat');
{
  const lines = ['B.E.(eV)\tIntensity'];
  for (let i = 0; i < 60; i++) lines.push(`${(900 - i * 0.1).toFixed(1)}\t${1000 + 10 * i}`);
  writeFileSync(twoColPath, lines.join('\n'), 'utf8');
}
const threeColPath = join(b3dir, 'three_col_nobg.dat');
{
  const lines = ['B.E.(eV)\tRaw Intensity\tPeak Sum'];
  for (let i = 0; i < 60; i++) {
    const raw = 1000 + 10 * i + 5 * Math.sin(i);
    lines.push(`${(900 - i * 0.1).toFixed(1)}\t${raw.toFixed(6)}\t${(raw - 3).toFixed(6)}`);
  }
  writeFileSync(threeColPath, lines.join('\n'), 'utf8');
}
const twoColPeaks = join(b3dir, 'two_col_peaks.dat');
writeFileSync(twoColPeaks, 'Peak\tPosition (eV)\tArea\tFWHM (eV)\t%GL\n1\t897.0\t100\t1.200\t30\n2\t894.0\t80\t1.100\t30\n', 'utf8');
const oneColPath = join(b3dir, 'one_col.dat');
writeFileSync(oneColPath, ['B.E.(eV)', ...Array.from({ length: 60 }, (_, i) => String(900 - i * 0.1))].join('\n'), 'utf8');

const tryCall = (fn) => {
  try { return { ok: true, value: fn() }; } catch (e) { return { ok: false, err: String(e?.message ?? e) }; }
};
const twoColParse = tryCall(() => parseSpectrum(twoColPath));
const twoColAudit = tryCall(() => auditArtifacts({ spectrumPath: twoColPath }));
const threeColAudit = tryCall(() => auditArtifacts({ spectrumPath: threeColPath }));
const oneColParse = tryCall(() => parseSpectrum(oneColPath));
const auditTwo = await request(b3port, '/xps/audit', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ spectrumPath: twoColPath, peaksPath: twoColPeaks }),
});
const auditOne = await request(b3port, '/xps/audit', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ spectrumPath: oneColPath, peaksPath: twoColPeaks }),
});

writeFileSync(join(root, 'mode.json'), '{"mode":"teach"}', 'utf8');
const runlogTeach = await request(b3port, '/xps/runlog', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ dir: b3dir, files: [] }),
});
try { rmSync(join(root, 'mode.json')); } catch { /* 无文件即可 */ }
await new Promise((resolve) => b3srv.close(resolve));
removeTemplate(b3created.template.id, root);

check('X9 教学档：/xps/runlog 也 403（不能被当成「只是写个日志」绕过）', () => {
  assert.equal(runlogTeach.status, 403, JSON.stringify(runlogTeach.json));
  assert.equal(runlogTeach.json.code, 'teaching-mode');
});

check('Z1 /xps/runlog 已有 run.json → 409 runlog-exists（旧 createdAt 原样带回、409 不落盘）；overwrite:true 才覆盖', () => {
  assert.equal(runlogAgain.status, 409, JSON.stringify(runlogAgain.json));
  assert.equal(runlogAgain.json.code, 'runlog-exists');
  assert.equal(runlogAgain.json.run.createdAt, runJson.createdAt, '旧 createdAt 必须原样带回');
  assert.equal(after409.createdAt, runJson.createdAt, '409 不能改盘上的 run.json');
  assert.equal(runlogOver.status, 200, JSON.stringify(runlogOver.json));
  assert.notEqual(runOverJson.createdAt, runJson.createdAt, 'overwrite:true 必须重写 createdAt');
});

check('Z2 2 列谱（BE + 强度）可解析：bg/fit 为 null，fit-quality skip 且标「无背景列」，bg-shape skip', () => {
  assert.equal(twoColParse.ok, true, twoColParse.err);
  assert.equal(twoColParse.value.rows, 60);
  assert.equal(twoColParse.value.bg, null);
  assert.equal(twoColParse.value.fit, null);
  assert.equal(twoColAudit.ok, true, twoColAudit.err);
  const fq = twoColAudit.value.checks.find((c) => c.id === 'fit-quality');
  assert.equal(fq.status, 'skip', JSON.stringify(fq));
  assert.match(fq.detail, /无背景列/, '2 列谱要明说没有背景列，不能只说行数');
  assert.equal(twoColAudit.value.checks.find((c) => c.id === 'bg-shape').status, 'skip');
  assert.equal(auditTwo.status, 200, JSON.stringify(auditTwo.json));
});

check('Z3 3 列但缺 Background：R² 只算 raw 口径并标注，bg-shape skip', () => {
  assert.equal(threeColAudit.ok, true, threeColAudit.err);
  const fq = threeColAudit.value.checks.find((c) => c.id === 'fit-quality');
  assert.notEqual(fq.status, 'skip', '有 Peak Sum 就该真算 R²');
  assert.match(fq.detail, /无背景列/, '缺背景列要标注口径');
  assert.match(fq.detail, /R²/);
  assert.equal(threeColAudit.value.checks.find((c) => c.id === 'bg-shape').status, 'skip');
});

check('Z4 列数不足（1 列）：报列数并写明需要 2 列或 XPSPeak 导出，不报「行数不足」', () => {
  assert.equal(oneColParse.ok, false, '单列谱必须拒绝');
  assert.match(oneColParse.err, /列/, `错误文案要看得出是列数问题：${oneColParse.err}`);
  assert.equal(auditOne.status, 400, JSON.stringify(auditOne.json));
  assert.match(auditOne.json.message, /列/);
  assert.match(auditOne.json.message, /2 列/);
});

check('Z5 全 skip 判 insufficient（不叫通过），summary 给四项计数', () => {
  assert.equal(twoColAudit.value.verdict, 'insufficient', JSON.stringify(twoColAudit.value.checks.map((c) => c.status)));
  assert.deepEqual(
    twoColAudit.value.summary.counts,
    { pass: 0, warn: 0, fail: 0, skip: 5 },
    JSON.stringify(twoColAudit.value.summary.counts),
  );
});

check('Z6 有实质检查且无 fail/warn → 仍判 pass，并带 counts', () => {
  const good = auditArtifacts({ spectrumPath: b3spec, peaksPath: b3peaks });
  assert.equal(good.verdict, 'pass', JSON.stringify(good.checks));
  assert.equal(good.summary.counts.pass + good.summary.counts.warn + good.summary.counts.fail > 0, true, '必须真有检查跑过');
  assert.equal(good.summary.counts.skip + good.summary.counts.pass + good.summary.counts.warn + good.summary.counts.fail, good.checks.length);
});

check('X10 客户端「审计这份」：调 /audit、传两条路径与模板、教学档禁用', () => {
  const src = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8');
  assert.match(src, /api\("\/audit"/, '必须调 POST /xps/audit');
  assert.match(src, /"审计这份"/, '按钮文案要是「审计这份」');
  assert.match(src, /spectrumPath: specPath[\s\S]{0,60}peaksPath: peaksPath/, '必须把谱图与峰表路径一起送审');
  assert.match(src, /disabled: isTeach \|\| busy \|\| specPath\.trim\(\) === ""/, '教学档与空路径时按钮要禁用');
  assert.match(src, /不解析 \.xps/, '审计结论要写明只审文本导出');
});

/* ── 第五批：拟合区 fit_window_ev 真正传进 xpspeak_fit ── */

check('Y1 fit 步骤带 window=[fit_window.lo, fit_window.hi]（不再吃整条谱）', () => {
  const t = { ...GOOD, fit_window_ev: { lo: 844.1, hi: 884.1 }, peak_windows: [{ label: 'Ni 2p3/2', center_ev: 864 }] };
  const ins = useInstruction(t, 'exec', { lo: 830, hi: 900 });
  const fitStep = ins.instruction.steps.find((x) => x.tool === 'xpspeak_fit');
  assert.deepEqual(fitStep.arguments.window, [844.1, 884.1], 'window 必须原样来自模板');
  assert.equal(ins.instruction.fields.fit_window_ev.lo, 844.1);
});

check('Y2 谱比拟合区窄 → window 取交集并 warning；无交集 → 拒绝', () => {
  const t = { ...GOOD, fit_window_ev: { lo: 844.1, hi: 884.1 }, peak_windows: [{ label: 'Ni 2p3/2', center_ev: 864 }] };
  const ins = useInstruction(t, 'exec', { lo: 850, hi: 900 });
  assert.equal(ins.ok, true);
  assert.deepEqual(ins.instruction.steps.find((x) => x.tool === 'xpspeak_fit').arguments.window, [850, 884.1]);
  assert.match(ins.instruction.warnings.join('\n'), /交集/);
  const none = useInstruction(t, 'exec', { lo: 900, hi: 950 });
  assert.equal(none.ok, false);
  assert.equal(none.code, 'window-outside-spectrum');
});

check('Y3 老模板没有 fit_window_ev → 不传 window，且必须警告「按整条谱拟合」', () => {
  const t = { ...GOOD, peak_windows: [{ label: 'Ni 2p3/2', center_ev: 864 }] };
  const ins = useInstruction(t, 'exec', { lo: 830, hi: 900 });
  assert.equal(ins.ok, true);
  assert.equal(ins.instruction.steps.find((x) => x.tool === 'xpspeak_fit').arguments.window, undefined);
  assert.match(ins.instruction.warnings.join('\n'), /按整条谱拟合/);
  assert.match(ins.instruction.warnings.join('\n'), /fit_window_ev/);
});

check('Y4 schema：fit_window_ev 必须 lo<hi、0–1500，且覆盖各峰 center ± fwhm_max', () => {
  const base = { ...GOOD, peak_windows: [{ label: 'Ni 2p3/2', center_ev: 864 }], fwhm_max: 2.0 };
  const ok = validateTemplate({ ...base, fit_window_ev: { lo: 844.1, hi: 884.1 } });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.deepEqual(ok.template.fit_window_ev, { lo: 844.1, hi: 884.1 });
  for (const bad of [
    { ...base, fit_window_ev: { lo: 884.1, hi: 844.1 } },
    { ...base, fit_window_ev: { lo: 844.1 } },
    { ...base, fit_window_ev: { lo: 844.1, hi: 2000 } },
    { ...base, fit_window_ev: { lo: 866, hi: 872 } }, // 只盖到 866±2，没包住 864±2？lo 866 > 862
    { ...base, fit_window_ev: { lo: 864, hi: 866 } },
  ]) {
    const r = validateTemplate(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.errors.join('\n'), /fit_window_ev/);
  }
});

/* ── 第四批：R² 双口径，闸按扣背景 ── */

const b4dir = join(tmp, 'b4');
mkdirSync(b4dir, { recursive: true });
const b4be = [];
for (let i = 0; i < 200; i += 1) b4be.push(Number((880 - i * 0.1).toFixed(3)));
const b4bg = b4be.map((x) => 6000 + (880 - x) * 300);
const b4comp = b4be.map((x) => gauss(x, 872, 1.4, 3000) + gauss(x, 866, 1.0, 1200));
const b4raw = b4comp.map((v, i) => v + b4bg[i] + Math.sin(i) * 8);
const b4fit = b4comp.map((v, i) => 0.7 * v + b4bg[i]);
const b4spec = writeSpec(join(b4dir, 'r2_spectrum.dat'), { be: b4be, raw: b4raw, fit: b4fit, bg: b4bg });

const r2nums = (detail) => {
  const bg = /R²\(扣背景\)=([\d.]+)/.exec(detail);
  const raw = /R²\(raw\)=([\d.]+)/.exec(detail);
  assert.ok(bg && raw, `detail 必须同时写两个口径：${detail}`);
  return { bg: Number(bg[1]), raw: Number(raw[1]) };
};

check('X11 审计 R² 双口径：raw 0.9857 会放过、扣背景 0.8933 必须 warn（闸按扣背景）', () => {
  const a = auditArtifacts({ spectrumPath: b4spec, peaksPath: null, template: null });
  const c = a.checks.find((x) => x.id === 'fit-quality');
  assert.ok(c, '必须给出 fit-quality');
  const v = r2nums(c.detail);
  assert.ok(v.raw >= 0.97, `raw 口径应接近 1：${v.raw}`);
  assert.ok(v.bg >= 0.85 && v.bg < 0.90, `扣背景口径应落在 0.85–0.90：${v.bg}`);
  assert.equal(c.status, 'warn', `扣背景 ${v.bg} < 0.90 必须 warn，不许被 raw ${v.raw} 抬成 pass`);
  assert.match(c.detail, /闸按扣背景/, 'detail 要写明闸用哪个口径');
});

check('X11b 真产物双口径：扣背景 0.8683 / raw 0.9152（容差 1e-3）', () => {
  const dir = 'E:/文档/deepseek-harness/XPS Peak/out/2_Ni2p_v2';
  if (!existsSync(join(dir, '2_Ni2p_NiMoS284.6_spectrum.dat'))) {
    process.stdout.write('  skip 本机没有 v2 真产物，跳过双口径数值核对（如实标记 skipped）\n');
    return;
  }
  const a = auditArtifacts({
    spectrumPath: join(dir, '2_Ni2p_NiMoS284.6_spectrum.dat'),
    peaksPath: join(dir, '2_Ni2p_NiMoS284.6_peaks.dat'),
    template: null,
  });
  const v = r2nums(a.checks.find((x) => x.id === 'fit-quality').detail);
  assert.ok(Math.abs(v.bg - 0.868272) <= 1e-3, `扣背景 R²=${v.bg}，应为 0.868272`);
  assert.ok(Math.abs(v.raw - 0.915217) <= 1e-3, `raw R²=${v.raw}，应为 0.915217`);
});

const resolvePy = () => {
  const candidates = [
    process.env.XPSPEAK_PYTHON,
    'C:/Users/12576/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe',
    'python',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['-c', 'import sys;print(sys.version_info[0])'], { stdio: 'pipe', timeout: 15000 });
      return candidate;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
};

check('X12 xps_fit 双口径：r2 扣背景、r2_raw 原始；preflight 闸读 r2 不读 raw', () => {
  const pyBin = resolvePy();
  if (pyBin === null) {
    process.stdout.write('  skip 找不到 python，跳过 xps_fit 双口径核对\n');
    return;
  }
  const script = `import sys, json
sys.path.insert(0, ${JSON.stringify(join(REPO, 'server'))})
import xps_fit
E, raw, bg, ncol = xps_fit.load(${JSON.stringify(b4spec)})
res = xps_fit.fit(E, raw, bg, [872, 866], ds=0, ratio=0.5, eta=0.3)
out = {"keys": [k for k in ("r2", "r2_raw") if k in res], "r2": res["r2"], "r2_raw": res["r2_raw"]}
fake = dict(res, r2=0.80, r2_raw=0.99, bound=[], not_optimized=[])
pf = xps_fit.preflight(fake, E=E, bg_used="file", expect_bg="file", edge_ratio=0)
out["errors"] = pf["errors"]
print(json.dumps(out))`;
  const out = JSON.parse(execFileSync(pyBin, ['-c', script], { stdio: 'pipe', timeout: 60000 }).toString('utf8').trim());
  assert.deepEqual(out.keys.sort(), ['r2', 'r2_raw'], '两个口径的键都要有');
  assert.ok(out.r2_raw > out.r2, `背景非零时 raw 门槛更松：r2=${out.r2} r2_raw=${out.r2_raw}`);
  const joined = out.errors.join('\n');
  assert.match(joined, /R²\(扣背景\)=0\.8000/, `闸必须按扣背景判：${joined}`);
  const selftestOut = execFileSync(pyBin, [join(REPO, 'server', 'xps_fit.py'), '--selftest'], {
    stdio: 'pipe',
    timeout: 60000,
  }).toString('utf8');
  assert.match(selftestOut, /R²\(扣背景\)/);
  assert.match(selftestOut, /r2_raw/);
});

check('⑤ 详情表：卡片能开详情，含 GL 与「模板值 vs 实测值」两列', () => {
  const src = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8');
  assert.match(src, /模板值[\s\S]{0,40}实测值/, '详情表必须有模板值/实测值两列');
  assert.match(src, /`GL \$\{/, 'meta 行要显示 GL 百分比');
  assert.match(src, /openDetail/, '卡片要能打开详情');
});

check('⑥ schema v2 非法值整条拒绝（eta/charge/provenance/observed 范围）', () => {
  const bad = [
    { ...GOOD, eta: 1.5 },
    { ...GOOD, eta: -0.1 },
    { ...GOOD, charge_correction_ev: 30 },
    { ...GOOD, provenance: { source_file: 'a.dat', points: 0, step_ev: 0.1, range_ev: 20 } },
    { ...GOOD, provenance: { source_file: 'a.dat', points: 100, step_ev: -1, range_ev: 20 } },
    {
      ...GOOD,
      peak_windows: [{ label: 'Mo 3d5/2', center_ev: 229, search_ev: 0.5, observed: { share_pct: 120 } }],
    },
  ];
  for (const t of bad) assert.equal(validateTemplate(t).ok, false, JSON.stringify(t));
  assert.equal(
    validateTemplate({
      ...GOOD,
      eta: 0.45,
      charge_correction_ev: -1.2,
      reference_peak: 'C 1s 284.6 eV',
      provenance: { source_file: 'a.dat', points: 700, step_ev: 0.1, range_ev: 60 },
      peak_windows: [
        {
          label: 'Mo 3d5/2',
          center_ev: 229,
          search_ev: 0.5,
          observed: { center_ev: 229.1, fwhm_ev: 0.9, gl_pct: 46, area: 12000, share_pct: 62 },
        },
      ],
    }).ok,
    true,
    '合法的新字段不能被误杀',
  );
});

process.stdout.write('\n[6] 包内 ↔ 安装位 sha256\n');
const from = join(tmp, 'pkg');
const to = join(tmp, 'inst');
mkdirSync(from, { recursive: true });
mkdirSync(to, { recursive: true });
for (const file of SERVER_FILES) {
  writeFileSync(join(from, file), `# ${file}\n`, 'utf8');
  writeFileSync(join(to, file), `# ${file}\n`, 'utf8'); // 安装位先有同源副本，才谈得上「一致」
}

const sameRun = syncServerFiles({ from, to, copy: () => { throw new Error('一致时不该复制'); } });
check('一致 → 不复制', () => {
  assert.equal(sameRun.length, SERVER_FILES.length);
  assert.ok(sameRun.every((r) => r.action === 'same'), JSON.stringify(sameRun));
});
writeFileSync(join(to, 'xps_fit.py'), '# old\n', 'utf8');
const copied = [];
const diffRun = syncServerFiles({ from, to, copy: (s, d) => { copied.push(d); writeFileSync(d, readFileSync(s)); } });
check('不一致 → 以包内为准复制并给 old→new', () => {
  const item = diffRun.find((r) => r.file === 'xps_fit.py');
  assert.equal(item.action, 'copied');
  assert.notEqual(item.from, item.to);
  assert.equal(copied.length, 1);
  assert.equal(readFileSync(join(to, 'xps_fit.py'), 'utf8'), '# xps_fit.py\n');
});
check('包内缺文件 → missing-in-package（不反向覆盖）', () => {
  const partial = join(tmp, 'pkg2');
  mkdirSync(partial, { recursive: true });
  writeFileSync(join(partial, 'xpspeak_mcp.py'), '# only one\n', 'utf8');
  const copiedFiles = [];
  const run = syncServerFiles({ from: partial, to, copy: (_s, d) => { copiedFiles.push(d); } });
  const missing = run.filter((r) => r.action === 'missing-in-package').map((r) => r.file).sort();
  assert.deepEqual(missing, ['xps_fit.py', 'xpspeak_drive.py']);
  // 缺的那两个绝不能被安装位反向覆盖：复制只可能发生在包内确实有的那个文件上
  assert.deepEqual(copiedFiles.map((d) => d.split(/[\\/]/).pop()), ['xpspeak_mcp.py']);
});
check('包内真实三 py 都在且与安装位同源', () => {
  const pkg = packagedServerDir();
  const installed = join(stateRoot({ ...process.env }), 'server');
  for (const file of SERVER_FILES) {
    assert.ok(existsSync(join(pkg, file)), `包内缺 ${file}`);
    if (existsSync(join(installed, file))) {
      assert.equal(sha256(readFileSync(join(pkg, file))), sha256(readFileSync(join(installed, file))), `${file} 包内与安装位不一致`);
    }
  }
});

/* ───────── 7. tab 注册契约 + jsx 语义 ───────── */

process.stdout.write('\n[7] 客户端契约\n');
const clientSrc = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8');
const num = (name) => {
  const m = new RegExp(`const ${name} = "([^"]*)";`).exec(clientSrc);
  return m === null ? null : m[1];
};
check('TAB_ID === TAB_KIND === "xps"（槽位 key 同一字符串）', () => {
  assert.equal(num('TAB_ID'), 'xps');
  // TAB_KIND 直接赋成 TAB_ID（不是另一个字面量）——这正是 id/kind/槽位 key 同一字符串的写法
  assert.match(clientSrc, /const TAB_KIND = TAB_ID;/);
});
check('兼容别名不带 guide（否则「+」菜单多一个入口）', () => {
  assert.match(clientSrc, /guide: null/);
});
check('兼容别名 COMPAT_ID === COMPAT_KIND === "xps-templates"（id/kind/槽位 key 同一字符串）', () => {
  assert.match(clientSrc, /const COMPAT_ID = "xps-templates";/);
  assert.match(clientSrc, /const COMPAT_KIND = COMPAT_ID;/);
});
check('用 createElement，不用 jsx-runtime', () => {
  assert.match(clientSrc, /const \{ createElement: jsx \} = React;/);
  // 只禁真的 require；注释里解释这个坑不算违规
  assert.doesNotMatch(clientSrc, /require\("react\/jsx-runtime"\)/);
});
check('jsx-runtime 语义（第三参是 key，children 会丢）', () => {
  const createElement = (type, props, ...children) => ({ type, props, children });
  const runtimeJsx = (type, props, key) => ({ type, props, key });
  const child = { type: 'img' };
  assert.equal(createElement('div', {}, [child]).children.length, 1);
  assert.equal(runtimeJsx('div', {}, [child]).children, undefined);
});
check('tab 注册带 id/kind 且主类型才有 guide', () => {
  assert.match(clientSrc, /id: spec\.id,/);
  assert.match(clientSrc, /kind: spec\.kind,/);
  assert.match(clientSrc, /\.\.\.\(spec\.guide === null \? \{\} : \{ guide: spec\.guide \}\)/);
});
check('「XPS 模板」在「+」菜单里排在 Origin 模板（order 45）之上：order = 44', () => {
  const m = /guide: \[\{ order: (\d+), title: \(\) => TAB_TITLE \}\]/.exec(clientSrc);
  assert.ok(m !== null, '找不到主类型 guide 的 order 声明');
  assert.equal(Number(m[1]), 44, 'order 必须是 44（45 = Origin 模板，44 紧贴其上方）');
});
check('「用这个」在教学档被前端禁用', () => {
  assert.match(clientSrc, /disabled: isTeach/);
  assert.match(clientSrc, /教学模式下不代执行/);
});
check('面板主按钮改走选择态：选这个 / 已选 / 取消选择，教学档两处禁用', () => {
  assert.match(clientSrc, /api\("\/selection"/, '客户端必须打 POST /selection');
  assert.match(clientSrc, /JSON\.stringify\(\{ templateId: null \}\)/, '取消选择要把 templateId 写成 null');
  assert.match(clientSrc, /"取消选择"/, '顶部已选条要有取消选择按钮');
  assert.match(clientSrc, /disabled: isTeach \|\| selectedId === null/, '教学档禁用取消选择');
  assert.match(clientSrc, /className: `xpk-card\$\{template\.id === selectedId \? " on" : ""\}`/, '选中的卡片要高亮');
});
check('A5 字段语义四态：未记录 / 约束夹出 / 近似 / 实测（默认值不许伪装成实测）', () => {
  assert.match(clientSrc, /\["项目", "模板值", "实测值", "来源"\]/, '详情表要有「来源」列');
  assert.match(clientSrc, /约束夹出/, '约束性字段要标「约束夹出」');
  assert.match(clientSrc, /未记录/, '没记录的要标「未记录」');
  assert.match(clientSrc, /近似/, 'eta 回落默认值要标「近似」');
  const routesSrc = readFileSync(join(REPO, 'lib', 'routes.js'), 'utf8');
  assert.match(routesSrc, /doubletRaw === null \? null/, 'doublet_delta_ev 允许 null（=不做双线约束）');
  assert.match(routesSrc, /charge_correction_ev === null/, 'charge_correction_ev 允许 null（=未记录）');
});

/* ───────── 8. 服务端不许有 MCP 调用 ───────── */

process.stdout.write('\n[8] 服务端无 MCP 调用（闸门单点在 MCP）\n');
check('lib/*.js 不含 child_process / 连接器 API / 工具调用', () => {
  for (const file of readdirSync(join(REPO, 'lib'))) {
    if (!file.endsWith('.js')) continue;
    const src = readFileSync(join(REPO, 'lib', file), 'utf8');
    assert.doesNotMatch(src, /child_process/, `${file} 里有 child_process`);
    assert.doesNotMatch(src, /mcp-connector\/api/, `${file} 里调了连接器 API`);
    assert.doesNotMatch(src, /xpspeak_[a-z]+\s*\(/, `${file} 里直接调了 MCP 工具`);
  }
});

/* ───────── 9. package.json files 覆盖运行期文件 ───────── */

process.stdout.write('\n[9] files 字段不漏文件（漏一个就是装完 ERR_MODULE_NOT_FOUND）\n');
check('每个运行期文件都被 files 的某个模式覆盖', () => {
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  const patterns = pkg.files;
  const covered = (rel) => patterns.some((p) => {
    if (p.endsWith('/**')) return rel.startsWith(p.slice(0, -3) + '/');
    if (p.includes('**/*')) {
      const [dir, rest] = p.split('/**/');
      return rel.startsWith(`${dir}/`) && rel.endsWith(rest.replace('*', ''));
    }
    if (p.includes('*')) {
      const [dir, rest] = p.split('/*');
      return rel.startsWith(`${dir}/`) && rel.endsWith(rest);
    }
    return rel === p;
  });
  const required = [
    ...readdirSync(join(REPO, 'lib')).filter((f) => f.endsWith('.js')).map((f) => `lib/${f}`),
    ...SERVER_FILES.map((f) => `server/${f}`),
    'cordis.patch.yml',
    'README.md',
  ];
  const missing = required.filter((rel) => !covered(rel));
  assert.deepEqual(missing, []);
});

/* ───────── 10. pseudoVoigt ↔ python gl 对拍 ───────── */

process.stdout.write('\n[10] 缩略图公式与 xps_fit.gl 对拍\n');
const pyCandidates = [
  process.env.XPSPEAK_PYTHON,
  'C:/Users/12576/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe',
  'python',
].filter(Boolean);
let py = null;
for (const candidate of pyCandidates) {
  try {
    execFileSync(candidate, ['-c', 'import sys;print(sys.version_info[0])'], { stdio: 'pipe', timeout: 15000 });
    py = candidate;
    break;
  } catch {
    /* 试下一个 */
  }
}
if (py === null) {
  process.stdout.write('  skip 找不到 python，跳过公式对拍（不静默通过，如实标记 skipped）\n');
} else {
  const points = [1.0, 1.7, 2.4];
  const script = `import sys, json
sys.path.insert(0, ${JSON.stringify(join(REPO, 'server'))})
import xps_fit
print(json.dumps([xps_fit.gl(x, 2.0, 1.2, 1000.0, 0.3) for x in ${JSON.stringify(points)}]))`;
  const raw = execFileSync(py, ['-c', script], { stdio: 'pipe', timeout: 30000 }).toString('utf8').trim();
  const expected = JSON.parse(raw);
  check('pseudoVoigt == xps_fit.gl（同 eta/同 FWHM）', () => {
    points.forEach((x, i) => {
      const got = pseudoVoigt(x, 2.0, 1.2, 1000.0, 0.3);
      assert.ok(Math.abs(got - expected[i]) < 1e-6, `x=${x} got=${got} want=${expected[i]}`);
    });
  });
}

check('Y5 audit 与 xps_fit 对同一份 CSV 的 R² 差 < 1e-3（同一拟合区、同一扣背景口径）', () => {
  if (!py) {
    process.stdout.write('  skip 找不到 python，跳过 audit↔fit R² 对拍\n');
    return;
  }
  const d = join(tmp, 'b5');
  mkdirSync(d, { recursive: true });
  const be = [];
  for (let i = 0; i < 401; i += 1) be.push(Number((884.37 - i * 0.1).toFixed(3)));
  const bg = be.map((x) => 6000 + (884.37 - x) * 12);
  // 数据必须按 xps_fit 同一模型（pseudo-Voigt，eta=0.3）生成，否则比的是模型差不是口径差
  const comp = be.map((x) => pseudoVoigt(x, 862, 1.4, 3000, 0.3) + pseudoVoigt(x, 856, 1.2, 1400, 0.3));
  const extra = be.map((x) => pseudoVoigt(x, 873, 1.6, 2600, 0.3)); // 2p1/2 区未建模
  const raw = comp.map((v, i) => v + bg[i] + extra[i]);
  const fitcol = comp.map((v, i) => v + bg[i]);
  const spec = writeSpec(join(d, 'window_spectrum.dat'), { be, raw, fit: fitcol, bg });
  const win = { lo: 844.4, hi: 866.4 };
  const script = `import sys, json
sys.path.insert(0, ${JSON.stringify(join(REPO, 'server'))})
import xps_fit
E, raw, bg, ncol = xps_fit.load(${JSON.stringify(spec)})
res = xps_fit.fit(E, raw, bg, [862, 856], ds=0, ratio=0.5, eta=0.3, ctol=0.5, lo=${win.lo}, hi=${win.hi})
print(json.dumps({"r2": res["r2"], "n": res["n"]}))`;
  const out = JSON.parse(execFileSync(py, ['-c', script], { stdio: 'pipe', timeout: 60000 }).toString('utf8').trim());
  const whole = auditArtifacts({ spectrumPath: spec, peaksPath: null, template: null });
  const wholeR2 = Number(/R²\(扣背景\)=([\d.]+)/.exec(whole.checks.find((c) => c.id === 'fit-quality').detail)[1]);
  assert.ok(wholeR2 < 0.9, `整条谱算 R² 应被窗口外的 2p1/2 拉低，实际 ${wholeR2}`);
  const part = auditArtifacts({ spectrumPath: spec, peaksPath: null, template: null, window: [win.lo, win.hi] });
  const partR2 = Number(/R²\(扣背景\)=([\d.]+)/.exec(part.checks.find((c) => c.id === 'fit-quality').detail)[1]);
  assert.ok(Math.abs(partR2 - out.r2) < 1e-3, `audit ${partR2} 对 fit ${out.r2}，差必须 < 1e-3`);
  // audit 记的是实际切到的数据边界（网格可能差半格），不是请求值本身
  assert.ok(Math.abs(part.summary.fit_window_ev[0] - win.lo) < 0.2, JSON.stringify(part.summary.fit_window_ev));
  assert.ok(Math.abs(part.summary.fit_window_ev[1] - win.hi) < 0.2, JSON.stringify(part.summary.fit_window_ev));
});

/* ───────── 11. 拟合参数与保存前硬前置（纯 python 侧） ───────── */

process.stdout.write('\n[11] 撞界不保存 / 逐峰 eta / 背景一致 / 边界截断\n');

const pyForGuards = pyCandidates.find((c) => {
  try {
    execFileSync(c, ['-c', 'import sys'], { stdio: 'pipe', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
});

const runPy = (code) => execFileSync(pyForGuards, ['-c', code], {
  stdio: 'pipe',
  timeout: 120000,
  cwd: REPO,
  env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
}).toString('utf8').trim();

const MCP_SRC = readFileSync(join(REPO, 'server', 'xpspeak_mcp.py'), 'utf8');

check('⑧ 撞界 → preflight 判失败、保存前置抛错、build_guard 在 D.build 之前', () => {
  const out = runPy(`
import json, math, os, sys, tempfile
sys.path.insert(0, 'server')
import xps_fit as F
from xpspeak_mcp import build_guard
E = [880 - 0.05 * i for i in range(600)]
raw = [F.model_at(e, [856.7, 1.177, 30000.0], 1, 0.0, 0.0, 0.3) + 10.0 for e in E]
res = F.fit(E, raw, [10.0] * len(E), [856.5], ds=0.0, ratio=0.0, eta=0.3, wlo=1.5, whi=2.4, ctol=1.0)
pf = F.preflight(res, E=E)
out = os.path.join(tempfile.mkdtemp(), 'should-not-exist.xps')
blocked = False
try:
    build_guard([{'pos': 856.5, 'fwhm': 1.5}], None, None, 1.5, 2.4)
except ValueError as e:
    blocked = '撞界' in str(e)
print(json.dumps({'bound': [b['param'] + ':' + b['side'] for b in res['bound']],
                  'ok': pf['ok'], 'blocked': blocked, 'exists': os.path.exists(out),
                  'r2': res['r2']}))
`);
  const r = JSON.parse(out);
  assert.ok(r.bound.includes('fwhm:lo'), `这段谱必须把 FWHM 顶到 wlo，实际 bound=${r.bound}`);
  assert.equal(r.ok, false, 'preflight 必须判失败');
  assert.equal(r.blocked, true, 'build_guard 必须抛「撞界」');
  assert.equal(r.exists, false, '被拦下时不许有输出文件');
  assert.ok(r.r2 > 0.9, `这个样本拟合本身是像样的（R²=${r.r2}），所以才必须靠撞界拦，而不是靠优度`);
  const body = MCP_SRC.slice(MCP_SRC.indexOf('def do_build('), MCP_SRC.indexOf('def do_close('));
  assert.ok(body.indexOf('build_guard(') > 0 && body.indexOf('build_guard(') < body.indexOf('D.build('),
    'build_guard 必须在 D.build 之前调用（否则先落盘再报错 = 撞界仍存了一份）');
});

check('⑨ 逐峰 eta 生效（两个峰不同 %GL → fit 里 eta 是数组且逐峰对得上）', () => {
  const out = runPy(`
import json, math, sys
sys.path.insert(0, 'server')
import xps_fit as F
E = [880 - 0.05 * i for i in range(600)]
raw = [(45000 * math.exp(-((e - 856.5) ** 2) / (2 * 0.5 ** 2))
        + 20000 * math.exp(-((e - 862.0) ** 2) / (2 * 0.5 ** 2)) + 10) for e in E]
res = F.fit(E, raw, [10.0] * len(E), [856.5, 862.0], ds=0.0, ratio=0.0, eta=[0.48, 1.0], ctol=1.0)
print(json.dumps({'eta_list': res['eta_list'], 'eta': res['eta'],
                  'comps': [c['eta'] for c in res['comps']], 'r2': res['r2']}))
`);
  const r = JSON.parse(out);
  assert.deepEqual(r.eta_list, [0.48, 1.0], 'eta 序列必须原样进模型');
  assert.deepEqual(r.comps, [0.48, 1.0], '每个组分要带自己的 eta');
  assert.deepEqual(r.eta, [0.48, 1.0], 'res.eta 在逐峰时也应是序列（report 要逐峰显示）');
});

check('⑩ 背景不一致 → build_guard 拒绝；file 必须配 file（不再有 tougaard 特例）', () => {
  const out = runPy(`
import json, math, sys
sys.path.insert(0, 'server')
import xps_fit as F
from xpspeak_mcp import build_guard
peaks = [{'pos': 856.5, 'fwhm': 1.1}]
bad = False
try:
    build_guard(peaks, 'linear', 'file', None, None)
except ValueError as e:
    bad = '背景不一致' in str(e)
same = build_guard(peaks, 'file', 'file', None, None)
E = [880 - 0.05 * i for i in range(600)]
raw = [F.model_at(e, [856.7, 1.177, 30000.0], 1, 0.0, 0.0, 0.3) + 10.0 for e in E]
res = F.fit(E, raw, [10.0] * len(E), [856.5], ds=0.0, ratio=0.0, eta=0.3, wlo=0.6, whi=4.0, ctol=1.0)
pf = F.preflight(res, bg_used='shirley', expect_bg='file')
ok_same = F.preflight(res, bg_used='linear', expect_bg='linear')['ok']
print(json.dumps({'bad': bad, 'same': same, 'file_warn': pf['warnings'],
                  'file_errors': pf['errors'],
                  'file_ok_preflight': pf['ok'], 'same_bg_ok': ok_same}, ensure_ascii=False))
`);
  const r = JSON.parse(out);
  assert.equal(r.bad, true, 'linear 模板 + file 背景必须拒绝');
  assert.equal(r.same, true, 'file↔file 必须放行');
  assert.equal(r.file_ok_preflight, false, 'file 模板 + 实际 shirley 必须阻断');
  assert.equal(r.same_bg_ok, true, '背景一致时不许乱拦');
  const msg = (r.file_errors || []).concat(r.file_warn || []).join('\n');
  assert.match(msg, /file/, '必须点名 file 不一致');
});

check('⑪ 峰心距谱端 < 3×FWHM → 边界截断警告（远离的不报）', () => {
  const out = runPy(`
import json, math, os, sys, tempfile
sys.path.insert(0, 'server')
from xpspeak_mcp import _edge_warnings
p = os.path.join(tempfile.mkdtemp(), 'spec.dat')
with open(p, 'w', encoding='utf-8') as fh:
    for i in range(600):
        e = 880 - 0.05 * i
        fh.write('%.2f %.1f' % (e, 10 + 100 * math.exp(-((e - 856.5) / 0.5) ** 2)) + chr(10))
print(json.dumps({'near': _edge_warnings(p, [{'pos': 850.4, 'fwhm': 1.0}]),
                  'far': _edge_warnings(p, [{'pos': 866.0, 'fwhm': 1.0}])}))
`);
  const r = JSON.parse(out);
  assert.ok(r.near.length > 0, '贴近边界必须警告');
  assert.ok(r.near[0].includes('尾部被截断'), '警告要说明尾部被截断');
  assert.deepEqual(r.far, [], '远离边界不该报');
});

/* ───────── 12. 背景口径：拟合区 Shirley ≠ 全谱 Shirley ───────── */

process.stdout.write('\n[12] 背景口径：拟合区 Shirley 与全谱 Shirley 必须统一\n');

const niSrc = 'E:\\文档\\deepseek-harness\\ceshiqu\\out\\20261106-ni2p-scan\\ni2p_cc.dat';
const niAvail = existsSync(niSrc);
if (niAvail) process.env.XPS_NI_PATH = niSrc;

check('Z7 全谱 vs 拟合区 Shirley：实测平均差 ≈ −866 cps（该谱必须判不一致）', () => {
  if (!niAvail) {
    process.stdout.write('  skip 缺少 ni2p_cc.dat，跳过实测复现（不静默通过）\n');
    return;
  }
  const r = JSON.parse(runPy(`
import json, os, sys
sys.path.insert(0, 'server')
try:
    import xpspeak_mcp as M
    out = M.bg_scope_check(os.environ['XPS_NI_PATH'], [845.68, 866.9])
except Exception as e:
    out = {'error': type(e).__name__ + ': ' + str(e)}
print(json.dumps(out))`));
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.ok(r.mean_diff < -500, `拟合区背景必须明显低于全谱，实际平均差 ${r.mean_diff} cps`);
  assert.equal(r.points, 213, '845.7–866.9 应切到 213 点');
  assert.ok(r.pct_of_height > 0.005, `占峰高比例要超容差，实际 ${r.pct_of_height}`);
});

check('Z8 裁到拟合窗口后：213 点、背景口径一致（平均差 < 20 cps）', () => {
  if (!niAvail) {
    process.stdout.write('  skip 缺少 ni2p_cc.dat\n');
    return;
  }
  const r = JSON.parse(runPy(`
import json, os, sys, tempfile
sys.path.insert(0, 'server')
try:
    import xpspeak_mcp as M
    dest = os.path.join(tempfile.mkdtemp(), 'cropped.dat')
    info = M.crop_to_window(os.environ['XPS_NI_PATH'], [845.68, 866.9], dest)
    chk = M.bg_scope_check(info['used'], [845.68, 866.9])
    out = {'info': info, 'chk': chk}
except Exception as e:
    out = {'error': type(e).__name__ + ': ' + str(e)}
print(json.dumps(out))`));
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.info.kept, 213, JSON.stringify(r.info));
  assert.equal(r.info.from_points, 401);
  assert.equal(r.info.removed, 188);
  assert.equal(r.chk.ok, true, JSON.stringify(r.chk));
  assert.ok(Math.abs(r.chk.mean_diff) < 20, `裁完后应基本为 0，实际 ${r.chk.mean_diff}`);
});

check('Z9 导出谱 Background 对模型：用全谱背景判失败（−866），用窗口背景判通过', () => {
  if (!niAvail) {
    process.stdout.write('  skip 缺少 ni2p_cc.dat\n');
    return;
  }
  const r = JSON.parse(runPy(`
import json, os, sys, tempfile
sys.path.insert(0, 'server')
try:
    import xps_fit as F
    import xpspeak_mcp as M
    d = tempfile.mkdtemp()
    E, raw, _b, _n = F.load(os.environ['XPS_NI_PATH'], bg_col=0)
    full = F.shirley_bg(E, raw)
    idx = [i for i, v in enumerate(E) if 845.68 <= v <= 866.9]
    Ew = [E[i] for i in idx]
    rw = [raw[i] for i in idx]
    wb = F.shirley_bg(Ew, rw)
    wmap = {i: wb[j] for j, i in enumerate(idx)}
    def write(name, pick):
        p = os.path.join(d, name)
        with open(p, 'w', encoding='utf-8', newline=chr(10)) as fh:
            fh.write('B.E.' + chr(9) + 'Raw Intensity' + chr(9) + 'Peak Sum' + chr(9) + 'Background' + chr(10))
            for i, e in enumerate(E):
                fh.write('%.4f%s%.4f%s%.4f%s%.4f%s' % (e, chr(9), raw[i], chr(9), raw[i], chr(9), pick(i), chr(10)))
        return p
    bad = write('bad.dat', lambda i: full[i])
    good = write('good.dat', lambda i: wmap.get(i, full[i]))
    cropped = os.path.join(d, 'model.dat')
    M.crop_to_window(os.environ['XPS_NI_PATH'], [845.68, 866.9], cropped)
    out = {'bad': M.bg_consistency(bad, cropped, [845.68, 866.9]),
           'good': M.bg_consistency(good, cropped, [845.68, 866.9])}
except Exception as e:
    out = {'error': type(e).__name__ + ': ' + str(e)}
print(json.dumps(out))`));
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.bad.ok, false, JSON.stringify(r.bad));
  assert.ok(r.bad.mean_diff < -500, `全谱背景应低约 866 cps，实际 ${r.bad.mean_diff}`);
  assert.equal(r.good.ok, true, JSON.stringify(r.good));
  assert.ok(Math.abs(r.good.mean_diff) < 5, `窗口背景应吻合，实际 ${r.good.mean_diff}`);
});

check('Z10 不一致且 crop=false → 拒绝（写明 cps 与修法）；crop=true 才裁谱', () => {
  if (!niAvail) {
    process.stdout.write('  skip 缺少 ni2p_cc.dat\n');
    return;
  }
  const r = JSON.parse(runPy(`
import json, os, sys, tempfile
sys.path.insert(0, 'server')
try:
    import xpspeak_mcp as M
    out_xps = os.path.join(tempfile.mkdtemp(), 'x.xps')
    try:
        M.bg_plan(os.environ['XPS_NI_PATH'], [845.68, 866.9], out_xps, crop=False)
        refused = None
    except ValueError as e:
        refused = str(e)
    plan = M.bg_plan(os.environ['XPS_NI_PATH'], [845.68, 866.9], out_xps, crop=True)
    out = {'refused': refused, 'crop': plan['crop'], 'used': os.path.basename(plan['used'])}
except Exception as e:
    out = {'error': type(e).__name__ + ': ' + str(e)}
print(json.dumps(out))`));
  assert.equal(r.error, undefined, r.error);
  assert.ok(r.refused, 'crop=false 时不一致必须抛错，不能静默建区');
  assert.match(r.refused, /cps/, '错误必须写差多少 cps');
  assert.match(r.refused, /裁/, '错误必须给出「先裁谱」的修法');
  assert.equal(r.crop.kept, 213, JSON.stringify(r.crop));
  const src = readFileSync(join(REPO, 'server', 'xpspeak_mcp.py'), 'utf8');
  assert.ok(src.indexOf('plan = bg_plan(') > 0, 'do_build 必须走 bg_plan');
  assert.ok(src.indexOf('plan = bg_plan(') < src.indexOf('r = D.build('), 'bg_plan 必须在 D.build 之前');
  assert.ok(src.indexOf('cons = bg_consistency(') > src.indexOf('r = D.build('), '建区后必须回读导出谱背景');
});

check('⑫ 未优化参数（初值=终值且不在界上）→ preflight 阻断；真拟合不会误报', () => {
  const out = runPy(`
import json, math, sys
sys.path.insert(0, 'server')
import xps_fit as F
E = [880 - 0.05 * i for i in range(600)]
raw = [F.model_at(e, [856.7, 1.177, 30000.0], 1, 0.0, 0.0, 0.3) + 10.0 for e in E]
res = F.fit(E, raw, [10.0] * len(E), [856.5], ds=0.0, ratio=0.0, eta=0.3, ctol=1.0)
fake = dict(res)
fake['not_optimized'] = [{'comp': 1, 'param': 'height', 'label': 'height', 'value': 45000.0, 'init': 45000.0}]
pf = F.preflight(fake, E=E)
print(json.dumps({'p0_len': len(res.get('p0') or []), 'real_not_opt': res['not_optimized'],
                  'pf_ok': pf['ok'], 'errs': pf['errors'], 'real_pf_ok': F.preflight(res, E=E)['ok']}))
`);
  const r = JSON.parse(out);
  assert.equal(r.p0_len, 3, 'fit 必须记下每个参数的初值（3 个/组分）');
  assert.deepEqual(r.real_not_opt, [], '真拟合里参数都动过，不该误报未优化');
  assert.equal(r.pf_ok, false, '参数没动必须阻断');
  assert.ok(r.errs.some((e) => e.includes('未被优化')), '错误里要写明「参数未被优化」');
  assert.equal(r.real_pf_ok, true, '同一份真拟合不许被这条误拦');
});

check('⑬ 优度：R² 0.874 → 警告；0.80 → 阻断', () => {
  const out = runPy(`
import json, math, sys
sys.path.insert(0, 'server')
import xps_fit as F
E = [880 - 0.05 * i for i in range(600)]
raw = [F.model_at(e, [856.7, 1.177, 30000.0], 1, 0.0, 0.0, 0.3) + 10.0 for e in E]
res = F.fit(E, raw, [10.0] * len(E), [856.5], ds=0.0, ratio=0.0, eta=0.3, ctol=1.0)
lo = dict(res); lo['r2'] = 0.874
bad = dict(res); bad['r2'] = 0.80
p1, p2 = F.preflight(lo, E=E), F.preflight(bad, E=E)
print(json.dumps({'warn_ok': p1['ok'], 'warn': [w for w in p1['warnings'] if 'R' in w],
                  'block_ok': p2['ok'], 'errs': p2['errors']}))
`);
  const r = JSON.parse(out);
  assert.equal(r.warn_ok, true, '0.874 落在警告区，不该阻断');
  assert.ok(r.warn.length > 0, '0.874 必须给 R² 警告');
  assert.equal(r.block_ok, false, '0.80 必须阻断');
  assert.ok(r.errs.some((e) => e.includes('R²')), '阻断理由要写 R²');
});

check('⑭ 残差四段结构：某段 |均值| > 0.5×rms → 系统性偏移阻断', () => {
  const out = runPy(`
import json, sys
sys.path.insert(0, 'server')
import xps_fit as F
def mk(resid, rms):
    return {'bound': [], 'not_optimized': [], 'r2': 0.99, 'rms': rms, 'peak_max': 100000.0,
            'comps': [], 'curves': {'E': [0, 1], 'target': [1, 0], 'fit': [], 'resid': resid}}
n = 400
flat = [0.0] * n
flat[100:200] = [3000.0] * 100          # 第二段整体偏 3000，rms=1000 → 3×rms
ok = F.preflight(mk([1.0 if i % 2 else -1.0 for i in range(n)], 1.0))
bad = F.preflight(mk(flat, 1000.0))
print(json.dumps({'rand_ok': ok['ok'], 'bad_ok': bad['ok'], 'errs': bad['errors'],
                  'segs': F.resid_segments(mk(flat, 1000.0))}))
`);
  const r = JSON.parse(out);
  assert.equal(r.rand_ok, true, '随机残差不该报结构问题');
  assert.equal(r.bad_ok, false, '某段整体偏移必须阻断');
  assert.ok(r.errs.some((e) => e.includes('系统性偏移')), '错误里要写「系统性偏移」');
  assert.equal(r.segs.length, 4, '残差要按四段统计');
  assert.ok(Math.abs(r.segs[1]) > 2000, `第二段均值应≈3000，实测 ${r.segs[1]}`);
});

check('⑮ 峰顶缺口：max|data−fit|/峰高 6% → 警告；12% → 阻断', () => {
  const out = runPy(`
import json, sys
sys.path.insert(0, 'server')
import xps_fit as F
def mk(spike, rms):
    resid = [0.0] * 400
    resid[200] = spike
    return {'bound': [], 'not_optimized': [], 'r2': 0.99, 'rms': rms, 'peak_max': 100000.0,
            'comps': [], 'curves': {'E': [0, 1], 'target': [1, 0], 'fit': [], 'resid': resid}}
w = F.preflight(mk(6000.0, 300.0))
b = F.preflight(mk(12000.0, 600.0))
print(json.dumps({'warn_ok': w['ok'], 'w': w['warnings'], 'block_ok': b['ok'], 'errs': b['errors'],
                  'ratio': F.peak_gap_ratio(mk(6000.0, 300.0))}))
`);
  const r = JSON.parse(out);
  assert.equal(r.warn_ok, true, '6% 只是警告，不该阻断');
  assert.ok(r.w.some((x) => x.includes('峰顶缺口')), '6% 必须给峰顶缺口警告');
  assert.equal(r.block_ok, false, '12% 必须阻断');
  assert.ok(r.errs.some((x) => x.includes('峰顶缺口')), '阻断理由要写峰顶缺口');
  assert.ok(Math.abs(r.ratio - 0.06) < 1e-6, '缺口比 = max|resid|/峰高');
});

check('⑯ 背景形状：linear 模板下 Background 列必须是直线（台阶 → 阻断）', () => {
  const out = runPy(`
import json, sys
sys.path.insert(0, 'server')
import xps_fit as F
n = 200
lin = [30000.0 + 100.0 * i for i in range(n)]
step = [30000.0 if i < 100 else 35000.0 for i in range(n)]
a = F.bg_shape_check(lin, 26000.0)
b = F.bg_shape_check(step, 26000.0)
res = {'bound': [], 'not_optimized': [], 'r2': 0.99, 'rms': 1.0, 'peak_max': 26000.0,
       'comps': [], 'curves': {'E': [0, 1], 'target': [1, 0], 'fit': [], 'resid': [0.0, 0.0]}}
p_lin = F.preflight(res, expect_bg='linear', bg_col=lin)
p_step = F.preflight(res, expect_bg='linear', bg_col=step)
print(json.dumps({'lin_ok': a['ok'], 'step_ok': b['ok'], 'step_dev': b['max_dev'],
                  'step_pct': b['pct_of_height'], 'p_lin_ok': p_lin['ok'], 'p_step_ok': p_step['ok'],
                  'errs': p_step['errors']}))
`);
  const r = JSON.parse(out);
  assert.equal(r.lin_ok, true, '真直线背景不许被拦');
  assert.equal(r.step_ok, false, '台阶背景必须判不符');
  assert.ok(r.step_dev > 2400, `台阶最大偏离应≈4950，实测 ${r.step_dev}`);
  assert.ok(r.step_pct > 9, '偏离应写成峰高的百分比（实测 10.9%）');
  assert.equal(r.p_lin_ok, true, 'preflight 里直线背景放行');
  assert.equal(r.p_step_ok, false, 'preflight 里台阶背景阻断');
  assert.ok(r.errs.some((e) => e.includes('背景形状')), '错误里要写「背景形状不符」');
  const body = MCP_SRC.slice(MCP_SRC.indexOf('def do_build('), MCP_SRC.indexOf('def do_close('));
  assert.ok(body.indexOf('_bg_guard_spec(') > 0 && body.indexOf('os.remove(out)') > 0,
    'build 收尾必须核背景形状，不符即删掉刚写出的 .xps（不落盘）');
});

/* ───────── 13. 背景形状：Shirley 重算与类型识别 ───────── */

process.stdout.write('\n[13] bg-shape：Shirley 重算（与 xps_fit 同源）与背景类型识别\n');

const bgDir = runPy("import tempfile; print(tempfile.mkdtemp(prefix='xpsbg-'))").trim();
process.env.XPS_BG_DIR = bgDir;

runPy(`
import os, sys
sys.path.insert(0, 'server')
import xps_fit as F
d = os.environ['XPS_BG_DIR']
E = [880 - 0.1 * i for i in range(301)]
raw = [F.model_at(e, [870.0, 1.5, 20000.0], 1, 0.0, 0.0, 0.3)
       + F.model_at(e, [860.0, 1.2, 8000.0], 1, 0.0, 0.0, 0.3) + 800 + (880 - e) * 30 for e in E]
sh = F.shirley_bg(E, raw)
n = len(E)
line = [raw[0] + (raw[-1] - raw[0]) * i / (n - 1.0) for i in range(n)]
for name, bg in (('shirley.dat', sh), ('line.dat', line)):
    p = os.path.join(d, name)
    with open(p, 'w', encoding='utf-8', newline=chr(10)) as fh:
        fh.write('B.E.' + chr(9) + 'Raw Intensity' + chr(9) + 'Peak Sum' + chr(9) + 'Background' + chr(10))
        for i, e in enumerate(E):
            fh.write('%.4f%s%.4f%s%.4f%s%.4f%s' % (e, chr(9), raw[i], chr(9), raw[i], chr(9), bg[i], chr(10)))
`);

const bgTpl = (background) => ({ background, peak_windows: [], fit_window_ev: null, applicable_window_ev: null });
const bgCheck = (name, background) => auditArtifacts({
  spectrumPath: join(bgDir, name), peaksPath: null, template: bgTpl(background),
}).checks.find((c) => c.id === 'bg-shape');

check('① Shirley 模板 + Shirley 文件（背景由 xps_fit.shirley_bg 生成）→ pass', () => {
  const c = bgCheck('shirley.dat', 'shirley');
  assert.equal(c.status, 'pass', c.detail);
  assert.match(c.detail, /shirley/i);
});

check('② Shirley 模板 + 背景被换成两端直线 → fail（类型或偏离）', () => {
  const c = bgCheck('line.dat', 'shirley');
  assert.equal(c.status, 'fail', c.detail);
  assert.match(c.detail, /直线型背景|背景类型|偏离/);
});

check('③ linear 模板 + 文件里是 Shirley 背景 → fail 且点名「背景类型」', () => {
  const c = bgCheck('shirley.dat', 'linear');
  assert.equal(c.status, 'fail', c.detail);
  assert.match(c.detail, /背景类型/);
});

check('④ file 模板（背景取自谱图）→ skip，reason 写明「不做模型重算」', () => {
  const c = bgCheck('shirley.dat', 'file');
  assert.equal(c.status, 'skip', c.detail);
  assert.match(c.detail, /不做模型重算|谱图自带/);
});

/* ───────── 14. 背景类型改名（tougaard → file）与 build 按模板选类型 ───────── */

process.stdout.write('\n[14] 背景类型 file / build 按模板选背景 / 建区背景回读\n');

check('A① 老模板 background=tougaard 读出归一成 file，note 保留原文', () => {
  const legacyRoot = join(tmp, 'legacy-root');
  mkdirSync(join(legacyRoot, 'templates', 'tlegacy'), { recursive: true });
  writeFileSync(join(legacyRoot, 'templates', 'tlegacy', 'meta.json'), JSON.stringify({
    id: 'tlegacy', name: '老模板', element: 'Ni', orbital: '2p', background: 'tougaard',
    note: '这是旧说明', peak_windows: [{ label: 'Ni 2p3/2', center_ev: 856.0 }],
  }), 'utf8');
  const t = listTemplates(legacyRoot)[0];
  assert.equal(t.background, 'file', 'tougaard 必须归一成 file');
  assert.match(t.note, /原 background=tougaard/, 'note 必须保留原文，不许静默改写历史');
  assert.match(t.note, /这是旧说明/, '原有 note 不能丢');
});

check('A② validateTemplate 拒收 tougaard（声明了却兑现不了的类型不再进库）', () => {
  const r = validateTemplate({ ...GOOD, background: 'tougaard' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /background 只能是/.test(e)), JSON.stringify(r.errors));
});

check('A③ use 对 file 背景给明确提示：用谱自带 Background 列，无背景列就用不了', () => {
  const t = { ...GOOD, background: 'file', fit_window_ev: null };
  const r = useInstruction(t, 'exec', null);
  assert.equal(r.ok, true);
  assert.equal(r.instruction.fields.background, 'file');
  const notes = r.instruction.notes.join('\n');
  assert.match(notes, /file/);
  assert.match(notes, /Background 列/);
  assert.match(notes, /没有背景列/);
});

check('A④ build_guard：file↔file 放行；file↔shirley 拒绝（不再有 tougaard 特例）', () => {
  const out = runPy(`
import json, sys
sys.path.insert(0, 'server')
from xpspeak_mcp import build_guard
ok = build_guard([{'pos': 856.0, 'fwhm': 1.8}], 'file', 'file', 1.0, 3.0)
bad = ''
try:
    build_guard([{'pos': 856.0, 'fwhm': 1.8}], 'file', 'shirley', 1.0, 3.0)
except ValueError as e:
    bad = str(e)
print(json.dumps({'ok': ok, 'bad': bad}, ensure_ascii=False))
`);
  const r = JSON.parse(out);
  assert.equal(r.ok, true, 'file↔file 必须放行');
  assert.match(r.bad, /背景不一致/, 'file 模板配 shirley 实际背景必须拒绝');
});

check('B① expect_bg=linear → 真的在 Background 对话框选 Linear（bg_type 传下去，不是一律 Shirley）', () => {
  const out = runPy(`
import json, os, sys, tempfile
sys.path.insert(0, 'server')
import xps_fit as F
import xpspeak_mcp as M
d = tempfile.mkdtemp()
src = os.path.join(d, 'src.dat')
E = [880 - 0.1 * i for i in range(201)]
raw = [F.model_at(e, [870.0, 1.5, 20000.0], 1, 0.0, 0.0, 0.3) + 800 + (880 - e) * 20 for e in E]
with open(src, 'w', encoding='ascii', newline=chr(10)) as fh:
    for i, e in enumerate(E):
        fh.write('%.4f %.6f' % (e, raw[i]) + chr(10))
out_xps = os.path.join(d, 'b.xps')
spec = os.path.join(d, 'b.dat')
cap = {}
def fake(exe, s, peaks, out, spec2=None, par=None, background=None, bg_type=None):
    cap['background'], cap['bg_type'] = background, bg_type
    open(out, 'wb').write(b'x')
    n = len(E)
    line = [raw[0] + (raw[-1] - raw[0]) * i / (n - 1.0) for i in range(n)]
    with open(spec2, 'w', encoding='utf-8', newline=chr(10)) as fh:
        fh.write('B.E.\\tRaw Intensity\\tPeak Sum\\tBackground' + chr(10))
        for i, e in enumerate(E):
            fh.write('%.4f\\t%.4f\\t%.4f\\t%.4f' % (e, raw[i], raw[i] - line[i], line[i]) + chr(10))
    return {'xps': out, 'xps_bytes': 1, 'peaks': [{'pos': p['pos'], 'fwhm': p['fwhm'], 'area': p['area']} for p in peaks]}
M.D.build = fake
M.do_build({'path': src, 'peaks': [{'pos': 870.0, 'fwhm': 1.5, 'area': 20000.0, 'gl': 30}],
            'out': out_xps, 'spec': spec, 'expect_bg': 'linear', 'wlo': 1.0, 'whi': 3.0})
print(json.dumps(cap, ensure_ascii=False))
`);
  const r = JSON.parse(out);
  assert.equal(r.background, true, 'linear 模板必须打开 Background 对话框');
  assert.equal(r.bg_type, 'linear', '必须按模板选 Linear，不能一律 Shirley');
});

check('B② expect_bg=file + ASCII 源谱 → 在 D.build 之前拒绝（ASCII 没有背景列）', () => {
  const out = runPy(`
import json, os, sys, tempfile
sys.path.insert(0, 'server')
import xps_fit as F
import xpspeak_mcp as M
d = tempfile.mkdtemp()
src = os.path.join(d, 'src.dat')
E = [880 - 0.1 * i for i in range(201)]
with open(src, 'w', encoding='ascii', newline=chr(10)) as fh:
    for e in E:
        fh.write('%.4f %.6f' % (e, 800 + (880 - e) * 20) + chr(10))
called = {'build': False}
def fake(*a, **k):
    called['build'] = True
    return {}
M.D.build = fake
out_xps = os.path.join(d, 'b.xps')
msg = ''
try:
    M.do_build({'path': src, 'peaks': [{'pos': 870.0, 'fwhm': 1.5, 'area': 20000.0, 'gl': 30}],
                'out': out_xps, 'expect_bg': 'file'})
except ValueError as e:
    msg = str(e)
print(json.dumps({'msg': msg, 'built': called['build'], 'exists': os.path.exists(out_xps)}, ensure_ascii=False))
`);
  const r = JSON.parse(out);
  assert.match(r.msg, /ASCII/, '必须在建区前说明源谱没有背景列');
  assert.equal(r.built, false, '不许先建出来再靠 audit 兜');
});

check('C 建区后的背景回读是真行为断言：导出谱 Background 整体偏移 → 抛错且盘上无 .xps', () => {
  const out = runPy(`
import json, os, sys, tempfile
sys.path.insert(0, 'server')
import xps_fit as F
import xpspeak_mcp as M
d = tempfile.mkdtemp()
src = os.path.join(d, 'src.dat')
E = [880 - 0.1 * i for i in range(201)]
raw = [F.model_at(e, [870.0, 1.5, 20000.0], 1, 0.0, 0.0, 0.3) + 800 + (880 - e) * 20 for e in E]
with open(src, 'w', encoding='ascii', newline=chr(10)) as fh:
    for i, e in enumerate(E):
        fh.write('%.4f %.6f' % (e, raw[i]) + chr(10))
out_xps = os.path.join(d, 'c.xps')
spec = os.path.join(d, 'c.dat')
def fake(exe, s, peaks, out, spec2=None, par=None, background=None, bg_type=None):
    open(out, 'wb').write(b'x')
    with open(spec2, 'w', encoding='utf-8', newline=chr(10)) as fh:
        fh.write('B.E.\\tRaw Intensity\\tPeak Sum\\tBackground' + chr(10))
        for i, e in enumerate(E):
            fh.write('%.4f\\t%.4f\\t%.4f\\t%.4f' % (e, raw[i], raw[i], 800 + (880 - e) * 20 + 5000.0) + chr(10))
    return {'xps': out, 'xps_bytes': 1, 'peaks': [{'pos': p['pos'], 'fwhm': p['fwhm'], 'area': p['area']} for p in peaks]}
M.D.build = fake
msg = ''
try:
    M.do_build({'path': src, 'peaks': [{'pos': 870.0, 'fwhm': 1.5, 'area': 20000.0, 'gl': 30}],
                'out': out_xps, 'spec': spec, 'expect_bg': 'shirley', 'window': [865.0, 875.0],
                'wlo': 1.0, 'whi': 3.0})
except ValueError as e:
    msg = str(e)
print(json.dumps({'msg': msg, 'exists': os.path.exists(out_xps)}, ensure_ascii=False))
`);
  const r = JSON.parse(out);
  assert.match(r.msg, /建区背景与拟合背景不一致/, '必须点名背景口径不一致');
  assert.equal(r.exists, false, '被拦下时盘上不许留下 .xps');
});

/* ───────── 结果 ───────── */

if (failures.length > 0) {
  process.stdout.write(`\nselftest FAILED: ${failures.length} 条不过（passed ${passed}）\n`);
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.stdout.write(`\nselftest OK: ${passed} 项全过（模板 CRUD / 路由状态码 / 空态 / 拒绝路径 / sha256 两分支 / tab 契约 / 无 MCP 调用 / files 覆盖 / 公式对拍）\n`);
