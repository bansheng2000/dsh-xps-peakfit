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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as createHttpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cleanupImportArtifacts,
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
  spectrumRange,
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

// P0-4 后审计多了「交付凭证」一项：不关心哈希的用例给一份 artifacts 为空的 run.json，
// 这样 artifacts-modified 落 skip、不会把 pass 降成 warn。
const emptyRunPath = join(b3dir, 'run_empty.json');
writeFileSync(emptyRunPath, JSON.stringify({ createdAt: '2026-01-01T00:00:00.000Z', artifacts: [] }), 'utf8');

check('X1 审计好产物：R²/残差/峰顶缺口/窗口全过，verdict=pass', () => {
  const a = auditArtifacts({ spectrumPath: b3spec, peaksPath: b3peaks, template: b3tpl, runPath: emptyRunPath });
  assert.equal(a.checks.length, 8, JSON.stringify(a.checks));
  assert.equal(a.checks.find((c) => c.id === 'artifacts-modified').status, 'skip', 'run.json 没登记产物 → 没有可复核哈希，判 skip 而不是 pass');
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
  body: JSON.stringify({ spectrumPath: b3spec, peaksPath: b3peaks, templateId: b3created.template.id, runPath: emptyRunPath }),
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
// 全 skip 判 insufficient 的前提是「没有任何实质检查」；给一份空凭证避免 uncontrolled 的 warn 把它变成 warn。
const twoColNoCreds = tryCall(() => auditArtifacts({ spectrumPath: twoColPath, runPath: emptyRunPath }));
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
  assert.equal(twoColNoCreds.ok, true, twoColNoCreds.err);
  assert.equal(twoColNoCreds.value.verdict, 'insufficient', JSON.stringify(twoColNoCreds.value.checks.map((c) => c.status)));
  assert.deepEqual(
    twoColNoCreds.value.summary.counts,
    { pass: 0, warn: 0, fail: 0, skip: 6 },
    JSON.stringify(twoColNoCreds.value.summary.counts),
  );
  // 不给 runPath 时必须是 warn（有一条指名「没有交付凭证」），不能静默当成审过
  assert.equal(twoColAudit.value.verdict, 'warn', JSON.stringify(twoColAudit.value.checks.map((c) => c.status)));
});

check('Z6 有实质检查且无 fail/warn → 仍判 pass，并带 counts', () => {
  const good = auditArtifacts({ spectrumPath: b3spec, peaksPath: b3peaks, runPath: emptyRunPath });
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
  assert.deepEqual(missing, ['xps_fit.py', 'xpspeak_drive.py', 'xpspeak_import.py']);
  // 缺的那两个绝不能被安装位反向覆盖：复制只可能发生在包内确实有的那个文件上
  assert.deepEqual(copiedFiles.map((d) => d.split(/[\\/]/).pop()), ['xpspeak_mcp.py']);
});
check('包内真实四 py 都在且与安装位同源', () => {
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
check('lib/*.js 不含连接器 API / MCP 工具调用；child_process 只许跑导入脚本这一条', () => {
  for (const file of readdirSync(join(REPO, 'lib'))) {
    if (!file.endsWith('.js')) continue;
    const src = readFileSync(join(REPO, 'lib', file), 'utf8');
    assert.doesNotMatch(src, /mcp-connector\/api/, `${file} 里调了连接器 API`);
    assert.doesNotMatch(src, /xpspeak_[a-z]+\s*\(/, `${file} 里直接调了 MCP 工具`);
    if (/child_process/.test(src)) {
      // 「闸门单点在 MCP」管的是拟合/建区这类会改数据的动作。模板导入（打开 .xps -> 导出两份文本）
      // 不产生也不修改任何谱或峰，允许它起一个只跑 server/xpspeak_import.py 的子进程；
      // 除此之外 lib/ 里不许再出现别的 spawn（尤其不许 shell:true 拼命令行）。
      assert.equal(file, 'routes.js', `${file} 不许用 child_process（只有模板导入需要跑 python）`);
      const spawns = src.match(/spawn\(\s*[^,]+,\s*[A-Za-z_$][\w$]*/g) ?? [];
      assert.equal(spawns.length, 1, 'routes.js 只允许一处 spawn：' + JSON.stringify(spawns));
      assert.match(src, /const args = \[importScriptPath\(env\), '--in'/, 'spawn 的参数必须是导入脚本');
      assert.doesNotMatch(src, /shell:\s*true/, '不许 shell:true（拼命令行会把路径当命令）');
    }
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
M.build_quality = lambda *a, **k: (None, {'ok': True, 'errors': [], 'warnings': []})
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
M.build_quality = lambda *a, **k: (None, {'ok': True, 'errors': [], 'warnings': []})
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

/* ───────── 15. D 系列：steps 里的 build / charge / audit 的 window 与 run.json ───────── */

process.stdout.write('\n[15] D 系列缺口：build 进步骤 / charge 不静默归零 / audit 传 window / audit 核 run.json\n');

// b3srv 已在 [13] 收尾时关掉，这里单开一个，避免后面的 HTTP 断言打空端口
// b3created 那份模板在前面 CRUD 用例里已被删，这里新建一份专供 D3
const d15tpl = createTemplate({ ...b3tpl, name: 'D15 audit window' }, root);
const d15srv = createServer(createRoutes({ root, env: { ...process.env, XPSPEAK_ROOT: root, XPSPEAK_MODE: '', XPSPEAK_MODE_FILE: '' } }));
await new Promise((resolve) => d15srv.listen(0, '127.0.0.1', resolve));
const d15port = d15srv.address().port;
const auditWithWindow = await request(d15port, '/xps/audit', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ spectrumPath: b3spec, peaksPath: b3peaks, templateId: d15tpl.template.id, runPath: emptyRunPath }),
});
const auditWithBodyWin = await request(d15port, '/xps/audit', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ spectrumPath: b3spec, peaksPath: b3peaks, templateId: d15tpl.template.id, window: [866, 878], runPath: emptyRunPath }),
});
const auditOutOfSpectrum = await request(d15port, '/xps/audit', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ spectrumPath: b3spec, peaksPath: b3peaks, templateId: d15tpl.template.id, window: [700, 710] }),
});

await new Promise((resolve) => d15srv.close(resolve));
rmSync(join(root, 'templates', d15tpl.template.id), { recursive: true, force: true });

// P0-4 的夹具：一份登记了 sha256 的 run.json 与它登记的两个产物（复制自 b3 好产物，不污染后续用例）
const crDir = join(b3dir, 'creds');
mkdirSync(crDir, { recursive: true });
const crSpec = join(crDir, 'spectrum.dat');
const crPeaks = join(crDir, 'peaks.dat');
writeFileSync(crSpec, readFileSync(b3spec));
writeFileSync(crPeaks, readFileSync(b3peaks));
const crRun = join(crDir, 'run.json');
writeFileSync(crRun, JSON.stringify({
  createdAt: '2026-01-01T00:00:00.000Z',
  artifacts: [
    { path: crSpec, sha256: sha256(readFileSync(crSpec)), bytes: readFileSync(crSpec).length },
    { path: crPeaks, sha256: sha256(readFileSync(crPeaks)), bytes: readFileSync(crPeaks).length },
  ],
}), 'utf8');


check('D1 fit 之后必须有 build，且不许再把同一份 .xps 交给 save；build 的面积占位不写模板对照值', () => {
  const t = {
    ...GOOD,
    fit_window_ev: { lo: 227.5, hi: 231.5 },
    charge_correction_ev: null,
    peak_windows: [{ label: 'Mo 3d5/2', center_ev: 229.0, search_ev: 0.5, observed: { fwhm_ev: 1.2, gl_pct: 30, area: 77777 } }],
  };
  const ins = useInstruction(t, 'exec', null).instruction;
  const tools = ins.steps.map((x) => x.tool);
  assert.ok(tools.includes('xpspeak_build'), `steps 必须有 build：${JSON.stringify(tools)}`);
  assert.ok(tools.indexOf('xpspeak_build') > tools.indexOf('xpspeak_fit'), 'build 必须在 fit 之后（fit 只算不写 GUI）');
  assert.equal(tools.includes('xpspeak_save'), false, 'save 存的是 GUI 当前状态，与 build 抢同一个文件，必须删掉');
  const b = ins.steps.find((x) => x.tool === 'xpspeak_build');
  assert.deepEqual(b.arguments.window, [227.5, 231.5], 'build 也要按拟合区建');
  assert.equal(b.arguments.expect_bg, 'shirley');
  assert.equal(b.arguments.actual_bg, 'shirley');
  const ph = String(b.arguments.peaks);
  assert.equal(ph.includes('77777'), false, `build 的 peaks 占位不许出现模板对照面积：${ph}`);
  assert.match(ph, /\{pos, fwhm, area\}/, '占位必须说清要填哪三个数');
});

check('D2 charge_correction_ev：null 不许变回 0；非 0 时必须出「先校正再拟合」前置步且 applied=false', () => {
  const none = useInstruction({ ...GOOD, charge_correction_ev: null }, 'exec', null).instruction;
  assert.equal(none.fields.charge_correction_ev, null, 'null 是「未登记」，不许 ?? 0');
  assert.equal(none.fields.charge_correction, null);
  assert.equal(none.steps.some((x) => x.kind === 'precondition'), false, '未登记就不该有校正步');

  const zero = useInstruction({ ...GOOD, charge_correction_ev: 0 }, 'exec', null).instruction;
  assert.equal(zero.fields.charge_correction_ev, 0);
  assert.equal(zero.steps.some((x) => x.kind === 'precondition'), false, '0 表示无需校正');

  const need = useInstruction({ ...GOOD, charge_correction_ev: 0.8, reference_peak: 'C 1s' }, 'exec', null).instruction;
  assert.equal(need.fields.charge_correction.ev, 0.8);
  assert.equal(need.fields.charge_correction.applied, false, '插件不平移能量，必须标未施加');
  assert.equal(need.fields.charge_correction.reference_peak, 'C 1s');
  const pre = need.steps.find((x) => x.kind === 'precondition');
  assert.ok(pre, '非 0 校正必须进 steps');
  assert.ok(need.steps.findIndex((x) => x.kind === 'precondition') < need.steps.findIndex((x) => x.tool === 'xpspeak_fit'), '校正步必须在 fit 之前');
  assert.match(pre.why, /先校正再拟合/);
  assert.match(pre.why, /\+0\.80 eV/);
  assert.match(pre.why, /C 1s/);
});

check('D3 /xps/audit 按模板 fit_window_ev 切片（body.window 优先），回包带 window 与 window_mode', () => {
  const ssp = parseSpectrum(b3spec);
  const sLo = Math.min(...ssp.be);
  const sHi = Math.max(...ssp.be);
  const byTpl = auditWithWindow;   // 不传 window → 用模板 fit_window_ev 864–880
  assert.equal(byTpl.status, 200, JSON.stringify(byTpl.json));
  assert.equal(byTpl.json.window_mode, 'template');
  assert.deepEqual(byTpl.json.window, [Math.max(864, sLo), Math.min(880, sHi)]);
  assert.equal(byTpl.json.summary.fit_window_ev !== undefined, true, 'summary 要记录实际切到的边界');

  assert.equal(auditWithBodyWin.status, 200, JSON.stringify(auditWithBodyWin.json));
  assert.equal(auditWithBodyWin.json.window_mode, 'body', 'body.window 优先于模板');
  assert.deepEqual(auditWithBodyWin.json.window, [866, 878]);
  // 只断言回包里的 window 会漏掉「路由算了窗口却没传给审计」这种错：summary 记的是审计真正切到的边界。
  assert.deepEqual(auditWithBodyWin.json.summary.fit_window_ev, [866, 878], '审计必须真的按 body.window 切片，不是只把数字回显');
  assert.match(
    auditWithBodyWin.json.checks.find((c) => c.id === 'window-applicability').detail,
    /本次窗口 12\.00 eV/,
    '窗宽要按 866–878 = 12 eV 算，说明切片真的生效',
  );

  assert.equal(auditOutOfSpectrum.status, 422, JSON.stringify(auditOutOfSpectrum.json));
  assert.equal(auditOutOfSpectrum.json.code, 'window-outside-spectrum');
});

check('D4 审计核 run.json：产物改一个字节 → artifacts-modified fail；删 run.json → uncontrolled warn', () => {
  const pass = auditArtifacts({ spectrumPath: crSpec, peaksPath: crPeaks, template: b3tpl, runPath: crRun });
  const pm = pass.checks.find((c) => c.id === 'artifacts-modified');
  assert.equal(pm.status, 'pass', pm.detail);

  writeFileSync(crSpec, readFileSync(crSpec, 'utf8') + ' ');
  const bad = auditArtifacts({ spectrumPath: crSpec, peaksPath: crPeaks, template: b3tpl, runPath: crRun });
  const bm = bad.checks.find((c) => c.id === 'artifacts-modified');
  assert.equal(bm.status, 'fail', bm.detail);
  assert.match(bm.detail, /改过/);
  assert.match(bm.detail, /spectrum\.dat/);
  assert.equal(bad.verdict, 'fail', '产物被改动必须让整体 verdict 落 fail');

  rmSync(crPeaks);
  const gone = auditArtifacts({ spectrumPath: crSpec, peaksPath: b3peaks, template: b3tpl, runPath: crRun });
  assert.match(gone.checks.find((c) => c.id === 'artifacts-modified').detail, /已不存在/);

  const noCreds = auditArtifacts({ spectrumPath: b3spec, peaksPath: b3peaks });
  const uc = noCreds.checks.find((c) => c.id === 'uncontrolled');
  assert.equal(uc.status, 'warn', uc.detail);
  assert.match(uc.detail, /没有交付凭证/);
  assert.equal(noCreds.verdict, 'warn');
});


/* ── 第十一批：P1-5/6/7/8、P2-9/10 ── */

const e16root = join(tmp, 'e16');
mkdirSync(e16root, { recursive: true });
const e16tpl = createTemplate({
  ...GOOD,
  name: 'E16 lastRun',
  fit_window_ev: { lo: 227, hi: 232 },
  charge_correction_ev: null,
}, e16root);
const e16srv = createServer(createRoutes({ root: e16root, env: { ...process.env, XPSPEAK_ROOT: e16root, XPSPEAK_MODE: '', XPSPEAK_MODE_FILE: '' } }));
await new Promise((r) => e16srv.listen(0, '127.0.0.1', r));
const e16port = e16srv.address().port;

const e16be = [];
for (let x = 227; x <= 232.01; x += 0.2) e16be.push(Number(x.toFixed(2)));
const e16lines = e16be.map((x) => `${x} ${(1000 + 800 * Math.exp(-((x - 229) ** 2) / 0.1)).toFixed(3)}`);
const e16spec2 = join(e16root, 'two.dat');
writeFileSync(e16spec2, `${e16lines.join('\n')}\n`, 'utf8');
const e16spec3 = join(e16root, 'three.dat');
writeFileSync(e16spec3, `${e16lines.map((l) => `${l} 120.000`).join('\n')}\n`, 'utf8');

const e16use = await request(e16port, `/xps/templates/${e16tpl.template.id}/use`, {
  method: 'POST',
  body: JSON.stringify({ spectrumPath: e16spec2 }),
});
const e16sel1 = await request(e16port, '/xps/selection');
const e16run = await request(e16port, '/xps/runlog', {
  method: 'POST',
  body: JSON.stringify({ dir: e16root, templateId: e16tpl.template.id, files: [e16spec2], result: { r2: 0.9876 } }),
});
const e16sel2 = await request(e16port, '/xps/selection');
const e16aud = await request(e16port, '/xps/audit', {
  method: 'POST',
  body: JSON.stringify({ spectrumPath: b3spec, peaksPath: b3peaks }),
});
const e16sel3 = await request(e16port, '/xps/selection');

check('E1 P1-5 lastRun 真有写入者：use→audit→runlog 各写一次，字段可读', () => {
  assert.equal(e16use.status, 200, JSON.stringify(e16use.json));
  const l1 = e16sel1.json.selection.lastRun;
  assert.ok(l1, 'use 之后 lastRun 不许还是 null');
  assert.equal(l1.kind, 'use');
  assert.equal(l1.status, 'ok');
  assert.equal(l1.templateId, e16tpl.template.id);
  assert.equal(Number.isFinite(Date.parse(l1.at)), true, `at 必须是可解析时间：${l1.at}`);

  assert.equal(e16aud.status, 200, JSON.stringify(e16aud.json));
  const l2 = e16sel3.json.selection.lastRun;
  assert.equal(l2.kind, 'audit', JSON.stringify(l2));
  assert.equal(l2.status, e16aud.json.verdict);
  assert.equal(l2.templateId, null, '没带 templateId 的审计，lastRun 不许挂上一个猜出来的模板');

  assert.equal(e16run.status, 200, JSON.stringify(e16run.json));
  const l3 = e16sel2.json.selection.lastRun;
  assert.equal(l3.kind, 'runlog', JSON.stringify(l3));
  assert.equal(l3.runPath, join(e16root, 'run.json'));
  assert.equal(l3.r2, 0.9876, 'runlog 的 result.r2 要落进 lastRun');
  assert.equal(l3.status, 'delivered');
});

check('E2 P1-6 窗口交集有下限：18 eV 交集对 3×fwhm_max=19.5 eV 必须 422 并报两个数', () => {
  const t = {
    ...GOOD,
    fwhm_max: 6.5,
    fit_window_ev: { lo: 0, hi: 20 },
    peak_windows: [{ label: 'x', center_ev: 10 }],
  };
  const r = useInstruction(t, 'exec', { lo: 2, hi: 20 });
  assert.equal(r.ok, false, '这么窄的交集不许放行');
  assert.equal(r.code, 'window-too-narrow');
  assert.match(r.message, /18\.00 eV/, '要写交集宽度');
  assert.match(r.message, /19\.50 eV/, '要写下限（3×6.5）');
  assert.equal(r.min_window_ev, 19.5);
  assert.deepEqual(r.window, [2, 20]);
});

check('E3 P1-7 file 背景 + 无 Background 列的 ASCII：出指令前就拒，文案点名缺哪一列', () => {
  const two = spectrumRange(e16spec2);
  const three = spectrumRange(e16spec3);
  assert.equal(two.has_background, false, JSON.stringify(two));
  assert.equal(two.columns, 2);
  assert.equal(three.has_background, true, JSON.stringify(three));

  const bad = useInstruction({ ...GOOD, background: 'file' }, 'exec', two);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'background-file-needs-column');
  assert.match(bad.message, /Background 列/, '文案要写明缺 Background 列');
  assert.match(bad.message, /2 列/, '要写实际读到几列');

  assert.equal(useInstruction({ ...GOOD, background: 'file' }, 'exec', three).ok, true, '3 列谱要放行');
});

check('E4 P1-8 裁剪谱落临时目录且用完即删（源码锚点）', () => {
  assert.match(
    MCP_SRC,
    /dest = os\.path\.join\(tempfile\.gettempdir\(\), "xpspeak_fitwin_%d\.dat"/,
    '裁剪谱必须落在 tempfile.gettempdir()',
  );
  assert.equal(MCP_SRC.includes('os.path.dirname(out_xps)'), false, '不许再把临时谱写到交付目录');
  assert.match(MCP_SRC, /os\.remove\(plan\["crop"\]\["used"\]\)/, '裁剪谱用完要删');
});

check('E5 P2-9 notes 与「fit → build」一致，不许再出现别用 build 的说法', () => {
  const notes = useInstruction({ ...GOOD, background: 'shirley' }, 'exec', null).instruction.notes.join('\n');
  assert.match(notes, /流程是 fit → build/, 'notes 要写清 fit 只算、build 才写 GUI');
  assert.match(notes, /别再用 xpspeak_export \/ xpspeak_save/);
  assert.equal(/别用 xpspeak_build|也可改用 xpspeak_build/.test(notes), false, `notes 里还有矛盾说法：${notes}`);
});

const e16selSet = await request(e16port, '/xps/selection', {
  method: 'POST',
  body: JSON.stringify({ templateId: e16tpl.template.id }),
});
rmSync(join(e16root, 'templates', e16tpl.template.id), { recursive: true, force: true });
const e16selStale = await request(e16port, '/xps/selection');
await request(e16port, '/xps/selection', { method: 'POST', body: JSON.stringify({ templateId: null }) });

check('E6 P2-10 选中的模板被删 → selection 标 stale 并给原因', () => {
  assert.equal(e16selSet.status, 200, JSON.stringify(e16selSet.json));
  assert.equal(e16selSet.json.selection.stale, false, '模板还在时不许说失效');
  const st = e16selStale.json.selection;
  assert.equal(st.stale, true, JSON.stringify(st));
  assert.equal(st.templateId, e16tpl.template.id, '失效也要保留原 templateId，别静默清空');
  assert.match(st.stale_reason, /已不存在/);
  // 只出 JSON 不够：面板选择条要真读 stale / stale_reason（test 里已有 clientSrc 可查）。
  assert.match(clientSrc, /stale_reason/, '列表页选择条要显示失效原因');
  assert.match(clientSrc, /lastRun/, '列表页要能看见上次结果');
});

await new Promise((r) => e16srv.close(r));

process.stdout.write('\n[17] build 自己复算 fit 的门槛（B：fit 阻断的，build 也不许建）\n');

check('G1 按给定峰参数复算：同参数 R²≈1 过闸，峰位整体 +3 eV 判阻断', () => {
  if (!pyForGuards) {
    process.stdout.write('  skip 找不到 python，跳过 build 优度复算\n');
    return;
  }
  const out = JSON.parse(runPy(`
import json, os, sys, tempfile
sys.path.insert(0, 'server')
import xps_fit as F, xpspeak_mcp as M
E = [884.0 - 0.1 * i for i in range(391)]
peaks = [dict(pos=852.884, fwhm=1.6, area=180000.0, gl=30),
         dict(pos=855.6, fwhm=1.8, area=120000.0, gl=30),
         dict(pos=859.5, fwhm=2.0, area=90000.0, gl=30),
         dict(pos=861.0, fwhm=2.2, area=70000.0, gl=30)]
model = [0.0] * len(E)
for pk in peaks:
    af = F.area_factor(pk["gl"] / 100.0)
    h = pk["area"] / (pk["fwhm"] * af)
    for i, e in enumerate(E):
        model[i] += F.gl(e, pk["pos"], pk["fwhm"], h, pk["gl"] / 100.0)
base = [5200.0 + (3000.0 - 5200.0) * (E[0] - e) / (E[0] - E[-1]) for e in E]
raw = [base[i] + model[i] for i in range(len(E))]
p = os.path.join(tempfile.gettempdir(), "bq_selftest.dat")
with open(p, "w", encoding="utf-8", newline="\\n") as fh:
    fh.write("BE Raw PeakSum Background\\n")
    for i in range(len(E)):
        fh.write("%.4f %.3f %.3f %.3f\\n" % (E[i], raw[i], model[i], base[i]))
res, pf = M.build_quality(p, peaks, [845.68, 866.90], "file")
bad = [dict(x, pos=x["pos"] + 3.0) for x in peaks]
res2, pf2 = M.build_quality(p, bad, [845.68, 866.90], "file")
# 背景口径：do_build 默认先把谱裁到窗口再载入，背景端点也要在窗口内重取。
# 用一个弯曲的基线让「全谱弦」和「窗口弦」明显不同，钉住 build_quality 用的是窗口弦。
curved = [base[i] + 900.0 * ((E[i] - 845.68) / 21.22) ** 2 for i in range(len(E))]
raw2 = [curved[i] + model[i] for i in range(len(E))]
p2 = os.path.join(tempfile.gettempdir(), "bq_selftest_curved.dat")
with open(p2, "w", encoding="utf-8", newline="\\n") as fh:
    fh.write("BE Raw\\n")
    for i in range(len(E)):
        fh.write("%.4f %.3f\\n" % (E[i], raw2[i]))
res3, pf3 = M.build_quality(p2, peaks, [845.68, 866.90], "linear")
idx = F._widx(E, 845.68, 866.90)
Ew = [E[i] for i in idx]
rw = [raw2[i] for i in idx]
exp = F.assess_peaks(Ew, rw, F.linear_bg(Ew, rw), peaks, min(Ew), max(Ew))
res4, pf4 = M.build_quality(p2, peaks, None, "linear")
print(json.dumps({"r2": res["r2"], "ok": pf["ok"], "rms": res["rms"],
                  "bad_r2": res2["r2"], "bad_ok": pf2["ok"],
                  "bad_errs": pf2["errors"], "path": p,
                  "win_rms": res3["rms"], "exp_rms": exp["rms"], "full_rms": res4["rms"]}))
`));
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  assert.ok(out.r2 > 0.999, `同参数复算 R² 必须≈1，实测 ${out.r2}`);
  assert.strictEqual(out.bad_ok, false, '峰位整体偏 3 eV 必须判阻断');
  assert.ok(out.bad_r2 < 0.85, `偏 3 eV 的 R² 必须 <0.85，实测 ${out.bad_r2}`);
  assert.ok(out.bad_errs.some((e) => e.includes('R²(扣背景)')), JSON.stringify(out.bad_errs));
  // 背景必须按窗口重取端点（与 do_build 裁谱后的实际谱同口径），不是全谱弦
  assert.ok(Math.abs(out.win_rms - out.exp_rms) < 1e-6,
    `裁剪后复算必须用窗口弦：build_quality ${out.win_rms} vs 期望 ${out.exp_rms}`);
  assert.ok(Math.abs(out.full_rms - out.exp_rms) > 20,
    `这组夹具必须让全谱弦与窗口弦拉开，否则断言没意义：${out.full_rms} vs ${out.exp_rms}`);
});

check('G2 do_build 复算到阻断：不驱动 XPSPeak、盘上不留 .xps；force=true 才放行并写 forced', () => {
  if (!pyForGuards) {
    process.stdout.write('  skip 找不到 python，跳过 do_build 接线\n');
    return;
  }
  const out = JSON.parse(runPy(`
import json, os, sys, tempfile
sys.path.insert(0, 'server')
import xpspeak_mcp as M
p = os.path.join(tempfile.gettempdir(), "bq_selftest.dat")
out = os.path.join(tempfile.gettempdir(), "bq_selftest.xps")
for f in (out,):
    if os.path.exists(f):
        os.remove(f)
calls = []
def fake(exe, used, peaks, out_path, verify, par, bg_flag, bg_type):
    calls.append(1)
    with open(out_path, "wb") as fh:
        fh.write(b"x")
    return {"xps": out_path, "xps_bytes": 1, "peaks": peaks}
M.D.build = fake
M.build_quality = lambda *a, **k: (None, {"ok": False,
    "errors": ["R²(扣背景)=0.4000 < 0.85：残差与信号同量级"], "warnings": []})
peaks = [dict(pos=852.884, fwhm=1.6, area=180000.0, gl=30)]
args = dict(path=p, peaks=peaks, out=out, bg=False, window=[845.68, 866.90],
            wlo=1.0, whi=5.0)
blocked, tf = "NO-RAISE", None
try:
    M.do_build(dict(args))
except ValueError as exc:
    blocked = str(exc)
n_block, exists_block = len(calls), os.path.exists(out)
try:
    tf = M.do_build(dict(args, force=True))
except ValueError as exc:
    tf = "RAISE:" + str(exc)
print(json.dumps({"blocked": blocked, "calls_block": n_block, "exists_block": exists_block,
                  "forced_calls": len(calls), "forced_exists": os.path.exists(out),
                  "forced_txt": tf if isinstance(tf, str) else ""}))
`));
  assert.ok(out.blocked.includes('已阻断保存'), out.blocked);
  assert.ok(out.blocked.includes('XPSPeak 未被驱动'), out.blocked);
  assert.strictEqual(out.calls_block, 0, '阻断时不许调用 D.build');
  assert.strictEqual(out.exists_block, false, '阻断时盘上不许有 .xps');
  assert.strictEqual(out.forced_calls, 1, 'force=true 才允许驱动 XPSPeak');
  assert.ok(out.forced_txt.includes('forced: true'), out.forced_txt);
  assert.ok(out.forced_txt.includes('R²(扣背景)'), 'force 回包必须原样列出未过门槛');
});

check('G3 源码顺序与 schema：build_quality 在 D.build 之前，工具含 force 参数', () => {
  const iQuality = MCP_SRC.indexOf('build_quality(used, peaks, win, expect, crop_used)');
  const iBuild = MCP_SRC.indexOf('r = D.build(');
  assert.ok(iQuality > 0, '找不到 build_quality 调用');
  assert.ok(iBuild > 0, '找不到 D.build 调用');
  assert.ok(iQuality < iBuild, '优度复算必须在 D.build 之前');
  assert.ok(/"force": \{"type": "boolean"/.test(MCP_SRC), 'xpspeak_build schema 必须暴露 force');
  assert.ok(MCP_SRC.includes('forced: true（未过门槛'), 'force 回包必须带可核对的 forced 行');
});

check('G4 linear 背景的两条警告：2 列谱没有独立参照；带背景列偏离超 0.5% 要写数值（都不阻断）', () => {
  if (!pyForGuards) {
    process.stdout.write('  skip 找不到 python，跳过 linear 背景警告\n');
    return;
  }
  const out = JSON.parse(runPy(`
import json, os, sys, tempfile
sys.path.insert(0, 'server')
import xps_fit as F, xpspeak_mcp as M
E = [884.0 - 0.1 * i for i in range(391)]
peaks = [dict(pos=852.884, fwhm=1.6, area=180000.0, gl=0)]
model = [0.0] * len(E)
for pk in peaks:
    af = F.area_factor(pk["gl"] / 100.0)
    h = pk["area"] / (pk["fwhm"] * af)
    for i, e in enumerate(E):
        model[i] += F.gl(e, pk["pos"], pk["fwhm"], h, pk["gl"] / 100.0)
base = [5200.0 + (3000.0 - 5200.0) * (E[0] - e) / (E[0] - E[-1]) for e in E]
raw = [base[i] + model[i] for i in range(len(E))]
p2 = os.path.join(tempfile.gettempdir(), "bq_lin_2col.dat")
with open(p2, "w", encoding="utf-8", newline="\\n") as fh:
    fh.write("BE Raw\\n")
    for i in range(len(E)):
        fh.write("%.4f %.3f\\n" % (E[i], raw[i]))
res2, pf2 = M.build_quality(p2, peaks, [845.68, 866.90], "linear")
stepbg = [base[i] + (3000.0 if E[i] > 860.0 else 0.0) for i in range(len(E))]
p4 = os.path.join(tempfile.gettempdir(), "bq_lin_step.dat")
with open(p4, "w", encoding="utf-8", newline="\\n") as fh:
    fh.write("BE Raw PeakSum Background\\n")
    for i in range(len(E)):
        fh.write("%.4f %.3f %.3f %.3f\\n" % (E[i], raw[i], model[i], stepbg[i]))
res4, pf4 = M.build_quality(p4, peaks, [845.68, 866.90], "linear")
print(json.dumps({"ok2": pf2["ok"], "w2": pf2["warnings"],
                  "ok4": pf4["ok"], "w4": pf4["warnings"], "err4": pf4["errors"]}))
`));
  assert.strictEqual(out.ok2, true, '警告不是闸：2 列谱不该被阻断 ' + JSON.stringify(out.w2));
  assert.ok(out.w2.some((w) => w.includes('没有自带背景列')), JSON.stringify(out.w2));
  assert.ok(out.w2.some((w) => w.includes('台阶')), '警告要说清什么时候该换 shirley/file：' + JSON.stringify(out.w2));
  // 4 列谱这一档：偏离 0.5% 在第九批已经是 bg-shape 的硬闸（同一阈值、同一比较），
  // 所以看到的是「警告带着具体数值 + 老闸阻断」，不是新警告单独阻断。
  assert.strictEqual(out.ok4, false, '带背景列且偏离超 0.5% 时，第九批的 bg-shape 硬闸仍会阻断');
  assert.ok(out.err4.some((e) => e.includes('背景形状不符')), JSON.stringify(out.err4));
  assert.ok(out.w4.some((w) => /Background 列与窗口两端直线最大偏离 \d+ cps/.test(w)), JSON.stringify(out.w4));
  assert.ok(out.w4.some((w) => w.includes('扣背景峰高')), '偏离要写成占峰高百分比：' + JSON.stringify(out.w4));
});

/* ── 第十四批 I1/I2：同源谱降 warn、runlog 未知字段 400 ── */

const i1dir = join(tmp, 'i1');
mkdirSync(i1dir, { recursive: true });
const i1be = [];
for (let i = 0; i < 200; i += 1) i1be.push(Number((880 - i * 0.1).toFixed(3)));
const i1bg = i1be.map((x) => 500 + (880 - x) * 10);
const i1comp = i1be.map((x) => gauss(x, 870, 1.65, 20000) + gauss(x, 875, 1.05, 8000));
const i1fit = i1comp.map((v, i) => v + i1bg[i]);
const i1raw = i1fit.map((v, i) => v + (i % 2 === 0 ? -0.3 : 0.3)); // 零均值残差：别把 fixture 自己的常数偏移算成系统性偏差
const i1spec = writeSpec(join(i1dir, 'src_spec.dat'), { be: i1be, raw: i1raw, fit: i1fit, bg: i1bg });
const i1peaks = join(i1dir, 'src_peaks.dat');
writeFileSync(
  i1peaks,
  ['Peak\tPosition (eV)\tArea\tFWHM (eV)\t%GL (%)', '0\t870.000\t80000\t1.600\t30', '1\t875.000\t40000\t1.000\t30'].join('\n') + '\n',
  'utf8',
);
// 模板就是由这条谱拟合出来的：峰位/FWHM/%GL 与 observed 完全一致、平移 0
const i1tpl = {
  ...b3tpl,
  background: 'linear',
  provenance: { source_file: i1spec },
  peak_windows: [
    { label: 'a', center_ev: 870, observed: { fwhm_ev: 1.6, gl_pct: 30 } },
    { label: 'b', center_ev: 875, observed: { fwhm_ev: 1.0, gl_pct: 30 } },
  ],
};
const i1sha = sha256(readFileSync(i1spec));
const i1run = join(i1dir, 'run.json');
writeFileSync(i1run, JSON.stringify({ createdAt: '2026-01-01T00:00:00.000Z', spectrumSha256: i1sha, artifacts: [] }), 'utf8');

const i1a = auditArtifacts({ spectrumPath: i1spec, peaksPath: i1peaks, template: i1tpl, runPath: i1run });
// 兜底判据：模板只记了文件名、来源谱被挪到别的目录（哈希拿不到），靠 basename + 平移 0
const i1movedDir = join(i1dir, 'moved');
mkdirSync(i1movedDir, { recursive: true });
const i1moved = join(i1movedDir, 'src_spec.dat');
writeFileSync(i1moved, readFileSync(i1spec));
const i1tplNameOnly = { ...i1tpl, provenance: { source_file: 'D:/old/exp/src_spec.dat' } };
const i1b = auditArtifacts({ spectrumPath: i1moved, peaksPath: i1peaks, template: i1tplNameOnly });
// 非同源：换了文件名的另一条谱，峰位/FWHM 仍然照搬模板 → 必须 fail
const i1otherTmp = writeSpec(join(i1dir, '_other_tmp.dat'), {
  be: i1be, raw: i1raw.map((v) => v + 120), fit: i1fit.map((v) => v + 120), bg: i1bg.map((v) => v + 120),
});
const i1other = join(i1dir, 'other_spec.dat');
writeFileSync(i1other, readFileSync(i1otherTmp));
const i1c = auditArtifacts({ spectrumPath: i1other, peaksPath: i1peaks, template: i1tpl });

const i2dir = join(tmp, 'i2');
mkdirSync(i2dir, { recursive: true });
const i2srv = createServer(createRoutes({ root, env: { ...process.env, XPSPEAK_ROOT: root, XPSPEAK_MODE: '', XPSPEAK_MODE_FILE: '' } }));
await new Promise((resolve) => i2srv.listen(0, '127.0.0.1', resolve));
const i2port = i2srv.address().port;
const i2bad = await request(i2port, '/xps/runlog', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: i2dir, artifacts: [] }),
});
const i2good = await request(i2port, '/xps/runlog', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: i2dir, files: [], spectrumSha256: i1sha }),
});
await new Promise((resolve) => i2srv.close(resolve));

check('I1 同源谱：模板由这条谱拟合得出 → template-copied 降 warn（判据写进 detail）', () => {
  const c = i1a.checks.find((x) => x.id === 'template-copied');
  assert.ok(c, JSON.stringify(i1a.checks));
  assert.equal(c.status, 'warn', c.detail);
  assert.match(c.detail, /同源谱/, c.detail);
  assert.match(c.detail, /sha256/, 'detail 要写清用了哪条判据：' + c.detail);
  assert.equal(i1a.verdict, 'warn', '同源复现不该整体判 fail：' + i1a.checks.map((c) => c.id + '=' + c.status + (c.status === 'fail' ? '(' + c.detail + ')' : '')).join(' | '));
});

check('I1b 同源兜底判据：只有文件名可比（basename + 平移≈0）也降 warn', () => {
  const c = i1b.checks.find((x) => x.id === 'template-copied');
  assert.equal(c.status, 'warn', c.detail);
  assert.match(c.detail, /basename/, 'fallback 判据要写明：' + c.detail);
});

check('I1c 非同源照搬模板仍 fail（降级只对同源生效）', () => {
  const c = i1c.checks.find((x) => x.id === 'template-copied');
  assert.equal(c.status, 'fail', c.detail);
  assert.match(c.detail, /不是拟合/);
  assert.equal(i1c.verdict, 'fail');
});

check('I2 runlog 顶层键白名单：artifacts 这种错键必须 400 unknown-field，别静默写空数组', () => {
  assert.equal(i2bad.status, 400, JSON.stringify(i2bad.json));
  assert.equal(i2bad.json.code, 'unknown-field');
  assert.match(i2bad.json.message, /artifacts/, '要说清哪个键不认识');
  assert.match(i2bad.json.message, /files/, '要给出正确键名');
  assert.ok(Array.isArray(i2bad.json.allowed) && i2bad.json.allowed.includes('spectrumSha256'), JSON.stringify(i2bad.json.allowed));
  assert.equal(i2good.status, 200, JSON.stringify(i2good.json));
  const run = JSON.parse(readFileSync(join(i2dir, 'run.json'), 'utf8'));
  assert.equal(run.spectrumSha256, i1sha, 'run.json 必须记下审计谱的 sha256（同源判据要靠它）');
});

check('I3 assess_peaks 背景口径：bg=None 内部按同源算法重算（shirley/linear），长度不符直接拒绝', () => {
  if (!pyForGuards) {
    process.stdout.write('  skip 找不到 python，跳过 I3\n');
    return;
  }
  const out = JSON.parse(runPy(`
import inspect, json, sys
sys.path.insert(0, 'server')
import xps_fit as F

E = [880.0 - 0.1 * i for i in range(200)]
base = [4000.0 + (E[0] - e) * 12.0 for e in E]
peaks = [dict(pos=870.0, fwhm=1.6, area=60000.0, gl=30)]
model = [0.0] * len(E)
for pk in peaks:
    af = F.area_factor(pk["gl"] / 100.0)
    h = pk["area"] / (pk["fwhm"] * af)
    for i, e in enumerate(E):
        model[i] += F.gl(e, pk["pos"], pk["fwhm"], h, pk["gl"] / 100.0)
raw = [base[i] + model[i] for i in range(len(E))]
lo, hi = 865.0, 875.0
a = F.assess_peaks(E, raw, None, peaks, lo, hi)
b = F.assess_peaks(E, raw, F.shirley_bg(E, raw), peaks, lo, hi)
c = F.assess_peaks(E, raw, None, peaks, lo, hi, bg_kind="linear")
d = F.assess_peaks(E, raw, F.linear_bg(E, raw), peaks, lo, hi)
err = ""
try:
    F.assess_peaks(E, raw, [0.0] * 10, peaks, lo, hi)
except Exception as exc:
    err = str(exc)
doc = inspect.getdoc(F.assess_peaks) or ""
print(json.dumps({"a": a["r2"], "b": b["r2"], "c": c["r2"], "d": d["r2"],
                  "err": err, "doc_same": "同源" in doc, "doc_866": "866" in doc}))
`));
  assert.ok(Math.abs(out.a - out.b) < 1e-9, 'bg=None 必须与显式同源 Shirley 逐位一致：' + JSON.stringify(out));
  assert.ok(Math.abs(out.c - out.d) < 1e-9, 'bg_kind=linear 必须与显式 linear_bg 一致：' + JSON.stringify(out));
  assert.ok(Math.abs(out.a - out.c) > 1e-6, 'shirley 与 linear 必须真的算出不同背景（否则 bg_kind 没生效）：' + JSON.stringify(out));
  assert.match(out.err, /长度/, '长度不符要直接拒（补零等于换了背景）：' + out.err);
  assert.equal(out.doc_same, true, 'docstring 要写死「bg 必须是整条谱的同源背景」');
  assert.equal(out.doc_866, true, 'docstring 要写清全谱 vs 窗口 Shirley 的实测差 866 cps');
});


// I1d：第三臂（模板复现）。模板来自 2.xls、审计谱是派生的 .dat —— 哈希与 basename 都判不出来，
// 只有「run.json 的 fit 实参与模板逐项相等」这一条能证明「照模板原样复现」。
const i1dDir = join(tmp, 'i1d');
mkdirSync(i1dDir, { recursive: true });
const i1dSpec = join(i1dDir, 'derived_cc.dat');
writeFileSync(i1dSpec, readFileSync(i1spec));
const i1dTpl = {
  ...i1tpl,
  id: 'i1d-tpl',
  provenance: { source_file: '2.xls（Ni2p Scan）' },
  fwhm_min: 1.0,
  fwhm_max: 5.0,
  ctol: null,
  peak_windows: [
    { label: 'a', center_ev: 870, eta: 0.3, search_ev: 1.5, observed: { fwhm_ev: 1.6, gl_pct: 30 } },
    { label: 'b', center_ev: 875, eta: 0.3, search_ev: 1.5, observed: { fwhm_ev: 1.0, gl_pct: 30 } },
  ],
};
const i1dFit = {
  centers: [870, 875], wlo: 1, whi: 5, eta: [0.3, 0.3], ctol: 1.5, window: [864, 880], bg: 'linear',
};
const i1dRun = join(i1dDir, 'run.json');
writeFileSync(i1dRun, JSON.stringify({ templateId: 'i1d-tpl', createdAt: '2026-01-01T00:00:00.000Z', fit: i1dFit, artifacts: [] }), 'utf8');
const i1d = auditArtifacts({ spectrumPath: i1dSpec, peaksPath: i1peaks, template: i1dTpl, runPath: i1dRun });

// 只把第一个峰位改 0.01 eV：就必须回到 fail —— 这一臂的可证伪性在这里
const i1dRunBad = join(i1dDir, 'run_bad.json');
writeFileSync(i1dRunBad, JSON.stringify({
  templateId: 'i1d-tpl', createdAt: '2026-01-01T00:00:00.000Z',
  fit: { ...i1dFit, centers: [870.01, 875] }, artifacts: [],
}), 'utf8');
const i1dBad = auditArtifacts({ spectrumPath: i1dSpec, peaksPath: i1peaks, template: i1dTpl, runPath: i1dRunBad });

// I2b：body 没给 spectrumSha256 时按 dir 里唯一的 *_spectrum.dat 自动算；有歧义就不写
const i2bDir = join(tmp, 'i2b');
mkdirSync(i2bDir, { recursive: true });
const i2bSpec = join(i2bDir, 'Ni2p_spectrum.dat');
writeFileSync(i2bSpec, 'B.E.\tIntensity\n880\t1000\n879\t1010\n', 'utf8');
const i2bAmb = join(tmp, 'i2b_amb');
mkdirSync(i2bAmb, { recursive: true });
writeFileSync(join(i2bAmb, 'a_spectrum.dat'), 'B.E.\tIntensity\n880\t1000\n', 'utf8');
writeFileSync(join(i2bAmb, 'b_spectrum.dat'), 'B.E.\tIntensity\n881\t1000\n', 'utf8');
const i2bSrv = createServer(createRoutes({ root, env: { ...process.env, XPSPEAK_ROOT: root, XPSPEAK_MODE: '', XPSPEAK_MODE_FILE: '' } }));
await new Promise((resolve) => i2bSrv.listen(0, '127.0.0.1', resolve));
const i2bPort = i2bSrv.address().port;
const i2bAuto = await request(i2bPort, '/xps/runlog', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: i2bDir, files: [] }),
});
const i2bTwo = await request(i2bPort, '/xps/runlog', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: i2bAmb, files: [] }),
});
await new Promise((resolve) => i2bSrv.close(resolve));

check('I1d 第三臂：run.json 实参与模板逐项一致 → 判模板复现（warn），改一个 center 0.01 eV 就回 fail', () => {
  const c = i1d.checks.find((x) => x.id === 'template-copied');
  assert.ok(c, JSON.stringify(i1d.checks));
  assert.equal(c.status, 'warn', c.detail);
  assert.match(c.detail, /逐项一致/, 'detail 要写清判据是「实参与模板逐项一致」：' + c.detail);
  assert.match(c.detail, /模板复现/, 'detail 要说清这是模板复现、不是独立拟合：' + c.detail);
  assert.equal(i1d.verdict, 'warn', '模板复现不该整体判 fail：' + i1d.checks.map((x) => x.id + '=' + x.status).join(' | '));
  const bad = i1dBad.checks.find((x) => x.id === 'template-copied');
  assert.equal(bad.status, 'fail', '改了一个峰位就不再是逐项一致，必须回到 fail：' + bad.detail);
  assert.equal(i1dBad.verdict, 'fail');
});

check('I2b runlog 自动 spectrumSha256：dir 里唯一谱文件才算，出现歧义不许猜', () => {
  assert.equal(i2bAuto.status, 200, JSON.stringify(i2bAuto.json));
  const auto = JSON.parse(readFileSync(join(i2bDir, 'run.json'), 'utf8'));
  assert.equal(auto.spectrumSha256, sha256(readFileSync(i2bSpec)), '唯一命中时要顺手记下谱的 sha256');
  assert.equal(i2bTwo.status, 200, JSON.stringify(i2bTwo.json));
  const amb = JSON.parse(readFileSync(join(i2bAmb, 'run.json'), 'utf8'));
  assert.equal(amb.spectrumSha256 ?? null, null, '两条候选就必须留空，不许挑一条猜');
});


/* ───────── 19. 导入 .xps 生成模板草稿 ───────── */

process.stdout.write('\n[19] 导入 .xps → 模板草稿（POST /xps/import）\n');

const impFx = join(REPO, 'test', 'fixtures', 'import');
const impRoot = join(tmp, 'imp');
mkdirSync(impRoot, { recursive: true });
const impBytes = Buffer.concat([Buffer.from('XPSPEAK 4.0DP', 'latin1'), Buffer.alloc(64, 0x20)]);

function importEnv(extra, mode = '') {
  return {
    ...process.env,
    XPSPEAK_ROOT: impRoot,
    XPSPEAK_MODE: mode,
    XPSPEAK_MODE_FILE: '',
    XPS_IMPORT_EXTRA_ARGS: extra,
    XPS_IMPORT_TIMEOUT_MS: '60000',
  };
}
function importListen(env) {
  const srv = createServer(createRoutes({ root: impRoot, env }));
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}
function importPost(port, filename, body = impBytes) {
  return request(port, '/xps/import?filename=' + encodeURIComponent(filename), {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body,
  });
}

const impSrvShirley = await importListen(importEnv('--replay ' + join(impFx, 'shirley')));
const impShirley = await importPost(impSrvShirley.address().port, 'Ni2p_demo.xps');
await new Promise((resolve) => impSrvShirley.close(resolve));

const impSrvLinear = await importListen(importEnv('--replay ' + join(impFx, 'linear')));
const impLinear = await importPost(impSrvLinear.address().port, 'Co_2p_scan.xps');
await new Promise((resolve) => impSrvLinear.close(resolve));

const impSrvFile = await importListen(importEnv('--replay ' + join(impFx, 'file')));
const impFile = await importPost(impSrvFile.address().port, 'S2p.xps');
await new Promise((resolve) => impSrvFile.close(resolve));

const impSrvReject = await importListen(importEnv('--replay ' + join(impFx, 'shirley')));
const impRejPort = impSrvReject.address().port;
const impRpa = await importPost(impRejPort, 'a.rpa');
const impTxt = await importPost(impRejPort, 'a.txt');
const impBadHead = await importPost(impRejPort, 'bad.xps', Buffer.from('NOTXPSPEAK-AT-ALL', 'latin1'));
mkdirSync(join(impRoot, 'imports'), { recursive: true });
writeFileSync(join(impRoot, 'imports', '.lock'), 'held', 'utf8');
const impBusy = await importPost(impRejPort, 'busy.xps');
rmSync(join(impRoot, 'imports', '.lock'), { force: true });
await new Promise((resolve) => impSrvReject.close(resolve));

const impSrvTeach = await importListen(importEnv('--replay ' + join(impFx, 'shirley'), 'teach'));
const impTeach = await importPost(impSrvTeach.address().port, 'teach.xps');
await new Promise((resolve) => impSrvTeach.close(resolve));

const impStub = join(impRoot, 'stub-nopeaks.json');
writeFileSync(impStub, JSON.stringify({ ok: false, code: 'no-peaks', message: '导出里没有峰（Peak 参数为空）' }), 'utf8');
const impSrvStub = await importListen(importEnv('--stub-json ' + impStub));
const impNoPeaks = await importPost(impSrvStub.address().port, 'nopeaks.xps');
await new Promise((resolve) => impSrvStub.close(resolve));

const impSrvNoExe = await importListen(importEnv('--exe C:/nope/XPSPEAK41.EXE'));
const impNoExe = await importPost(impSrvNoExe.address().port, 'noexe.xps');
await new Promise((resolve) => impSrvNoExe.close(resolve));

check('J1 导入回包：草稿峰位/FWHM/eta 逐峰、背景判 shirley、fit_window 取交集、模板键从文件名预填', () => {
  assert.equal(impShirley.status, 200, impShirley.text.slice(0, 400));
  const d = impShirley.json.draft;
  assert.equal(d.background, 'shirley', '背景要按文件 Background 列判，不许一律 shirley/linear');
  assert.deepEqual(d.peak_windows.map((p) => p.center_ev), [870, 874, 877], '峰位要逐项来自导出的 Peak 参数');
  assert.deepEqual(d.peak_windows.map((p) => p.observed.fwhm_ev), [1.2, 2.4, 1.6]);
  assert.deepEqual(d.peak_windows.map((p) => p.eta), [0.3, 0.6, 0.9], 'eta 必须逐峰取 GL/100，不许取第一峰的标量');
  assert.deepEqual(d.fit_window_ev, { lo: 862.8, hi: 880 }, 'fit_window = 首峰-3FWHM 到 末峰+3FWHM，与谱范围取交集');
  assert.equal(d.applicable_window_ev, 20, '数据宽度用谱范围');
  assert.equal(d.fwhm_min, 0.9, 'FWHM 下限 = min×0.75');
  assert.equal(d.fwhm_max, 3, 'FWHM 上限 = max×1.25');
  assert.equal(d.element, 'Ni', '文件名认得出来就预填元素');
  assert.equal(d.orbital, '2p');
  assert.equal(d.category, '高分辨谱');
  assert.equal(d.provenance.source_file, 'Ni2p_demo.xps');
  assert.equal(d.provenance.points, 201);
  assert.match(String(d.provenance.sha256), /^[0-9a-f]{64}$/, 'sha256 要写进 provenance');
  assert.equal(impShirley.json.sha256, d.provenance.sha256);
  assert.equal(validateTemplate(d).ok, true, '生成的草稿必须能直接过 validateTemplate：' + JSON.stringify(validateTemplate(d).errors));
  assert.equal(existsSync(impShirley.json.importPath), false, '导入成功后源 .xps 不另存（原文件在用户磁盘）');
  assert.equal(existsSync(impShirley.json.resultPath), true, 'imports/<时间戳>.json 要留下草稿');
  assert.match(impShirley.json.warnings.join('\n'), /交集/, '窗口被交集裁剪要出 warning');
  assert.equal(existsSync(join(impRoot, 'imports', '.lock')), false, '结束要放锁');
});

check('J2 linear 夹具 → background=linear；J3 台阶背景 → file 且写明两路偏离', () => {
  assert.equal(impLinear.status, 200, impLinear.text.slice(0, 300));
  assert.equal(impLinear.json.draft.background, 'linear');
  assert.equal(impLinear.json.draft.element, 'Co');
  assert.equal(impFile.status, 200, impFile.text.slice(0, 300));
  assert.equal(impFile.json.draft.background, 'file', '既不像直线也不像 Shirley 就按 file 存');
  assert.match(impFile.json.warnings.join('\n'), /既不像直线也不像 Shirley/, '要写出两路偏离，不能只说“不像”');
  assert.match(impFile.json.warnings.join('\n'), /12\.6%/, '偏离数值要写出来');
});

check('J4 拒绝路径：.rpa/.txt/文件头/教学档/忙/没峰/找不到 XPSPeak 各自的状态码与 code', () => {
  assert.equal(impRpa.status, 415, impRpa.text);
  assert.equal(impRpa.json.code, 'rpa-not-supported');
  assert.match(impRpa.json.message, /没有谱图|缺/, '要说明 .rpa 缺谱');
  assert.equal(impTxt.status, 415, impTxt.text);
  assert.equal(impTxt.json.code, 'not-xps');
  assert.equal(impBadHead.status, 415, impBadHead.text);
  assert.equal(impBadHead.json.code, 'not-xps');
  assert.match(impBadHead.json.message, /XPSPEAK 4\.0/);
  assert.equal(impTeach.status, 403);
  assert.equal(impTeach.json.code, 'teaching-mode');
  assert.equal(impBusy.status, 409, impBusy.text);
  assert.equal(impBusy.json.code, 'import-busy');
  assert.equal(impNoPeaks.status, 422, impNoPeaks.text);
  assert.equal(impNoPeaks.json.code, 'no-peaks');
  assert.equal(impNoExe.status, 501, impNoExe.text);
  assert.equal(impNoExe.json.code, 'xpspeak-not-found');
});

check('J5 imports/*.json 只留最近 20 份；J6 草稿能直接 POST /xps/templates?filename=meta.json', async () => {
  const dir = join(impRoot, 'imports');
  for (let i = 0; i < 26; i += 1) {
    writeFileSync(join(dir, '202001010000' + String(i).padStart(2, '0') + '.json'), '{}', 'utf8');
  }
  const srv = await importListen(importEnv('--replay ' + join(impFx, 'shirley')));
  const r = await importPost(srv.address().port, 'prune.xps');
  // 文件名认不出元素/轨道时，草稿的 element/orbital/category 必须为空，先证它过不了模板校验
  const raw = await request(srv.address().port, '/xps/templates?filename=meta.json', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(r.json.draft),
  });
  const posted = await request(srv.address().port, '/xps/templates?filename=meta.json', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...r.json.draft, element: 'Ni', orbital: '2p', category: '高分辨谱' }),
  });
  await new Promise((resolve) => srv.close(resolve));
  const kept = readdirSync(dir).filter((f) => /^\d{14}\.json$/.test(f));
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.equal(kept.length, 20, 'imports/ 只留最近 20 份草稿，多了按时间删旧的：' + kept.length);
  assert.equal(raw.status, 400, '缺 element/orbital/category 的草稿不许落盘：' + raw.text.slice(0, 200));
  assert.match(raw.text, /element|orbital|category/, raw.text.slice(0, 200));
  assert.equal(posted.status, 201, '新建模板回 201（created）：' + posted.text.slice(0, 200));
  assert.equal(posted.json.ok, true);
  removeTemplate(posted.json.template.id, impRoot);
});


check('J7 面板：导入按钮存在、提交前必须补齐 element/orbital/category（不许绕过）', () => {
  const src = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8');
  assert.match(src, /导入 \.xps/, '面板要有「导入 .xps」入口');
  assert.match(src, /accept: "\.xps"/, '文件选择器只收 .xps');
  assert.match(src, /fetch\(`\$\{BASE\}\/import\?filename=/, '上传走 POST /xps/import');
  assert.match(src, /"name", "element", "orbital", "category"\]\.filter\(/, '提交前要检查这四个键');
  assert.match(src, /模板元数据必填/, '缺键要明确报错，不许静默保存');
  // 必填检查必须在 submitDraft 自己的提交之前：先算出 missing，再 POST（别被 upload() 里的同名 fetch 骗到）
  const iFn = src.indexOf('const submitDraft = async () =>');
  const iCheck = src.indexOf('const missing = ["name", "element", "orbital", "category"]', iFn);
  const iPost = src.indexOf('fetch(`${BASE}/templates?filename=', iFn);
  assert.ok(iFn > 0, '面板里要有 submitDraft');
  assert.ok(iCheck > iFn && iPost > iCheck, '必填检查要排在保存请求之前');
  assert.match(src, /className: String\(draft\[key\] \?\? ""\)\.trim\(\) === "" \? "req" : ""/, '空的检索键要标红');
});

check('J8 导入收尾清理：落盘的源 .xps / 工作目录 / 锁全删，且路由 finally 用的就是这个函数', () => {
  const dir = join(tmp, 'cleanup-j8');
  mkdirSync(dir, { recursive: true });
  const stored = join(dir, '20260101000000-clean.xps');
  writeFileSync(stored, 'XPSPEAK 4.0D', 'utf8');
  const work = join(dir, '20260101000000-work');
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, 'peaks.dat'), 'x', 'utf8');
  const lock = join(dir, '.lock');
  writeFileSync(lock, '', 'utf8');
  const gone = cleanupImportArtifacts([work, stored, lock, null]);
  assert.equal(existsSync(stored), false, '落盘的源 .xps 必须删掉（replay 夹具不产生它，端到端跑不到这条分支）');
  assert.equal(existsSync(work), false, '中间工作目录要删');
  assert.equal(existsSync(lock), false, '锁要释放');
  assert.equal(gone.length, 3, '返回的是实际清理成功的路径');
  // 单测绿还不够：路由的 finally 必须真的调它，否则真导入仍会漏文件
  const rs = readFileSync(join(REPO, 'lib', 'routes.js'), 'utf8');
  assert.match(rs, /cleanupImportArtifacts\(\[workDir, stored, lockPath\]\)/, '导入 finally 必须调用清理函数');
  assert.doesNotMatch(rs, /rmSync\(stored, \{ force: true \}\)/, '不许绕过清理函数直接 rmSync(stored)');
});

check('J9 静默模式：启动 SW_HIDE + 只隐藏本 pid + wait_new 改认隐藏记录（替身单测）', () => {
  const pyBin = resolvePy();
  if (pyBin === null) {
    process.stdout.write('  skip 找不到 python，跳过 hidden 单测\n');
    return;
  }
  let raw = '';
  try {
    raw = execFileSync(pyBin, [join(REPO, 'test', 'hidden_unit.py')], { stdio: 'pipe', timeout: 60000 }).toString('utf8');
  } catch (e) {
    // 单测失败时它会往 stdout 打一行 {"ok":false,...}，把那行捞出来给出可读原因
    raw = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  const out = JSON.parse(raw.trim().split(/\r?\n/).filter(Boolean).pop());
  assert.equal(out.ok, true, `hidden 单测失败：${out.message ?? raw.slice(0, 300)}`);
  for (const must of ['启动时 SW_HIDE', '隐藏线程随 launch 启动、绑该 pid', '别的 pid 一个都不碰',
    '静默态挑无菜单的 VB6 窗体', 'since 之前的记录不算新对话框', '导入脚本 run_gui 默认静默']) {
    assert.ok(out.checks.includes(must), `hidden 单测少了这一项：${must}`);
  }
  // 默认真源：导入脚本必须默认静默，且留 --no-hidden 排障
  const imp = readFileSync(join(REPO, 'server', 'xpspeak_import.py'), 'utf8');
  assert.match(imp, /"--hidden",\s*dest="hidden",\s*action="store_true",\s*default=True/, '--hidden 必须默认开');
  assert.match(imp, /"--no-hidden",\s*dest="hidden",\s*action="store_false"/, '要留 --no-hidden 排障开关');
  assert.match(imp, /hidden=a\.hidden/, 'CLI 的值要真的传进 run_gui');
  const drv = readFileSync(join(REPO, 'server', 'xpspeak_drive.py'), 'utf8');
  assert.match(drv, /dwFlags \|= STARTF_USESHOWWINDOW[\s\S]{0,200}wShowWindow = SW_HIDE/, '启动时先 SW_HIDE');
  assert.match(drv, /class HideKeeper/, '要有隐藏线程');
  assert.match(drv, /floor = t0 if since is None else since/, 'wait_new 的时间闸（对话框被隐藏后不能靠可见性判断）');
  assert.match(drv, /ts >= floor - 0\.3 and cls\(h\) == "ThunderRT6FormDC"/, '静默态只认 VB6 窗体记录');
});

check('J10 面板 %GL 显示逐峰（只看全局 eta 会把 48/100/100/100 显示成 30%）', () => {
  const src = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8');
  // 不只 grep：把 glText 的源码整段摘出来求值，直接验证行为
  const start = src.indexOf('function glText(t) {');
  assert.ok(start > 0, '面板要有 glText，把逐峰 %Lorentzian 折成一段文本');
  const end = src.indexOf('\n}', start);
  assert.ok(end > start, 'glText 要能被整段摘出来，否则这条断言失效');
  const glText = new Function(`${src.slice(start, end + 2)}; return glText;`)();
  assert.equal(
    glText({ eta: 0.3, peak_windows: [{ eta: 0.48 }, { eta: 1 }, { eta: 1 }, { eta: 1 }] }),
    'GL 48/100/100/100%',
    '逐峰 eta 必须逐峰显示（模板是 48/100/100/100，全局 eta 是 0.3）',
  );
  assert.equal(glText({ eta: 0.3, peak_windows: [{ eta: 0.64 }, { eta: 0.64 }] }), 'GL 64%', '各峰相同时收成一个数');
  assert.equal(glText({ eta: 0.3, peak_windows: [{ center_ev: 1 }] }), 'GL 30%', '没有逐峰 eta 才退全局 eta');
  assert.equal(glText({ peak_windows: [] }), 'GL 30%（默认）', '三样都没有时给默认值并标明是默认');
  assert.equal(glText({ eta: 0.3, peak_windows: [{ eta: 0.5 }, {}] }), 'GL 50/30%', '个别峰缺 eta 用全局值补，不能用 0');
  assert.match(src, /glText\(template\),/, '模板卡片的 meta 行要走 glText');
  assert.match(src, /'%GL', glText\(t\)/, '详情表「模板值」列要走 glText');
  assert.doesNotMatch(src, /Math\.round\(\(typeof template\.eta === 'number' \? template\.eta : 0\.3\) \* 100\)/, '旧的「只读全局 eta」表达式必须删干净');
});

/* ───────── 20. ds 默认 0（不猜）与高度口径（F1 / F4） ───────── */

process.stdout.write('\n[20] ds 默认 0（不猜）与 height/area 口径\n');

const DSPECTRUM = join(REPO, 'test', 'fixtures', 'ds', 'ni2p_5peak_spectrum.dat');

check('K1 不传 ds 是单线且五峰高度都>0；显式 ds=1.18 会把一个组分压到 0 并撞界', () => {
  const out = runPy(`
import json, sys
sys.path.insert(0, 'server')
import xps_fit as F
C = [852.163, 853.216, 855.377, 858.597, 861.297]
KW = dict(bg_kind='file', lo=849.5, hi=865.49, wlo=0.5, whi=6.0)
d = F.run(${JSON.stringify(DSPECTRUM)}, C, **KW)
k = F.run(${JSON.stringify(DSPECTRUM)}, C, ds=1.18, **KW)
print(json.dumps({
    'd_ds': d['ds'], 'd_heights': [c['height'] for c in d['comps']],
    'd_bounds': [c['bounds'] for c in d['comps'] if c['bounds']],
    'd_r2': d['r2'], 'd_rms': d['rms'],
    'd_line': F.report(d, include_bounds=False).splitlines()[0],
    'k_heights': [c['height'] for c in k['comps']],
    'k_bounds': [c['bounds'] for c in k['comps'] if c['bounds']],
    'k_r2': k['r2'],
    'k_line': F.report(k, include_bounds=False).splitlines()[0],
}, ensure_ascii=False))
`);
  const r = JSON.parse(out);
  assert.equal(r.d_ds, 0, '不传 ds 必须是 0（单线），不许再悄悄按 1.18 套');
  assert.ok(r.d_heights.every((h) => h > 0), `单线下五个组分都该有高度，实际 ${r.d_heights}`);
  assert.equal(r.d_bounds.length, 0, `单线不该撞界，实际 ${JSON.stringify(r.d_bounds)}`);
  assert.ok(r.d_r2 > 0.9979 && r.d_rms < 300, `单线拟合应当是这个谱的正确答案（R²=${r.d_r2} rms=${r.d_rms}）`);
  assert.match(r.d_line, /ds=0（单线：没有伴线/, `report 必须印明单线，实际：${r.d_line}`);
  assert.ok(r.k_heights.some((h) => h === 0), `默认套 1.18 就会把组分压到 0（这正是要修的陷阱），实际 ${r.k_heights}`);
  assert.ok(r.k_bounds.some((b) => b.includes('height')), `被压到 0 的组分必须标撞界 height，实际 ${JSON.stringify(r.k_bounds)}`);
  assert.ok(r.k_r2 < 0.99, `套错 Δ 的 R² 会明显变差（实测 0.985），实际 ${r.k_r2}`);
  assert.match(r.k_line, /条双峰（Δ=1\.180 eV/, `显式 ds=1.18 时 report 必须写明双线，实际：${r.k_line}`);
});

check('K2 源码两层默认都是 0，schema 写明「不传 = 单线」', () => {
  const fit = readFileSync(join(REPO, 'server', 'xps_fit.py'), 'utf8');
  assert.match(MCP_SRC, /float\(a\.get\("ds", 0\.0\)\)/, 'MCP 的 do_fit 默认必须是 0');
  assert.doesNotMatch(MCP_SRC, /a\.get\("ds", 1\.18\)/, 'MCP 里不许再把 1.18 当默认');
  assert.match(MCP_SRC, /不传 = 0（单线/, 'schema 文案必须说清不传是单线');
  assert.match(fit, /def fit\(E, raw, bg, centers, ds=0\.0,/, 'fit 的位置参数默认必须是 0');
  assert.match(fit, /def run\(path, centers, bg_kind="file", bg_col=4, ds=0\.0,/, 'run 的默认必须是 0');
  assert.doesNotMatch(fit, /float\(opt\.get\("ds", 1\.18\)\)/, 'CLI 入口也不许留 1.18 默认');
  assert.match(fit, /if 0\.0 < ds < 2\.0/, '_constraint_warnings 不能在 ds=0 时提示伴线口径');
});

check('K3 双线时 height 是主线幅度、area 是双线合计（差恰好 ratio×area_main），报告同时给 h主/h合', () => {
  const out = runPy(`
import json, os, sys
sys.path.insert(0, 'server')
import xps_fit as F
p = os.path.join(${JSON.stringify(tmp)}, 'k3_doublet.dat')
E = [844.0 + 0.1 * i for i in range(161)]
y = [F.gl(x, 852.0, 1.2, 10000.0, 0.3) + F.gl(x, 853.18, 1.2, 5000.0, 0.3) for x in E]
with open(p, 'w') as fh:
    for x, v in zip(E, y):
        fh.write('%.3f,%.4f\\n' % (x, v))
r = F.run(p, [852.0], bg_kind='none', ds=1.18, ratio=0.5, eta=0.3, wlo=0.5, whi=3.0)
c = r['comps'][0]
print(json.dumps({
    'ratio': r['ratio'], 'rms': r['rms'], 'ds': r['ds'],
    'h': c['height'], 'hp': c['height_pair'], 'a': c['area'], 'am': c['area_main'],
    'txt': '\\n'.join(F.report(r, include_bounds=False).splitlines()[1:]),
}, ensure_ascii=False))
`);
  const r = JSON.parse(out);
  assert.equal(r.ratio, 0.5, '这条夹具 ratio 是 0.5');
  assert.equal(r.ds, 1.18, '双线语义下 ds 必须是 1.18');
  assert.ok(Math.abs(r.h - 10000) < 200, `主线幅度应还原成 10000（合成谱给的就是它），实际 ${r.h}`);
  assert.ok(r.hp > r.h, `h合 必须大于 h主（含伴线尾巴），实际 ${r.hp} vs ${r.h}`);
  assert.ok(r.am < r.a, `area_main 必须小于 area（area 是双线合计），实际 ${r.am} vs ${r.a}`);
  const diff = r.a - r.am;
  assert.ok(Math.abs(diff - r.ratio * r.am) <= Math.max(1, 1e-3 * r.a),
    `area - area_main 必须 == ratio×area_main（${diff} vs ${r.ratio * r.am}）`);
  assert.match(r.txt, /h主=\d+ \/ h合=\d+/, `组分行要同时给 h主/h合，实际：${r.txt}`);
  assert.match(r.txt, /\([\d.]+%，双线合计\)/, '双线时 area 后面要标明是双线合计');
});

check('K3b 单线（ds=0）不许叠共位伴线：h合=h主、area=area_main，且 ratio 不改变读数与曲线', () => {
  const out = runPy(`
import json, sys
sys.path.insert(0, 'server')
import xps_fit as F
C = [852.163, 853.216, 855.377, 858.597, 861.297]
kw = dict(bg_kind='file', lo=849.5, hi=865.49, wlo=0.5, whi=6.0)
a = F.run(${JSON.stringify(DSPECTRUM)}, C, ds=0.0, ratio=0.5, **kw)
b = F.run(${JSON.stringify(DSPECTRUM)}, C, ds=0.0, ratio=0.0, **kw)
print(json.dumps({
    'comps': [{'h': c['height'], 'hp': c['height_pair'], 'a': c['area'], 'am': c['area_main']} for c in a['comps']],
    'h_a': [c['height'] for c in a['comps']], 'h_b': [c['height'] for c in b['comps']],
    'area_a': [c['area'] for c in a['comps']], 'area_b': [c['area'] for c in b['comps']],
    'rms': [a['rms'], b['rms']],
    'first': F.report(a, include_bounds=False).splitlines()[0],
    'txt': '\\n'.join(F.report(a, include_bounds=False).splitlines()[3:]),
}, ensure_ascii=False))
`);
  const r = JSON.parse(out);
  for (const [i, c] of r.comps.entries()) {
    assert.equal(c.hp, c.h, `组分${i + 1}: 单线时 h合 必须等于 h主（没有伴线可叠），实际 ${c.hp} vs ${c.h}`);
    assert.equal(c.am, c.a, `组分${i + 1}: 单线时 area 必须等于 area_main，实际 ${c.am} vs ${c.a}`);
  }
  assert.deepEqual(r.h_a, r.h_b, '单线时 ratio 不许改变峰高（共位伴线是幽灵，会把 h 压成 1/(1+ratio)）');
  assert.deepEqual(r.area_a, r.area_b, '单线时 ratio 不许改变面积');
  assert.deepEqual(r.rms, r.rms, '单线时 ratio 不许改变拟合优度');
  assert.match(r.first, /ds=0（单线/, '报告首行必须写明单线');
  assert.match(r.txt, /\([\d.]+%，单线\)/, '单线时 area 后面要标明是单线');
  assert.doesNotMatch(r.txt, /双线合计/, '单线时不许出现「双线合计」');
});

/* ───────── 21. 审计自动发现 run.json（F3）与截断汇总（F6） ───────── */

process.stdout.write('\n[21] 审计自动发现 run.json（F3）与边界截断汇总（F6）\n');

const k4dir = join(tmp, 'k4');
mkdirSync(k4dir, { recursive: true });
const k4spec = join(k4dir, 'k4_spectrum.dat');
const k4peaks = join(k4dir, 'k4_peaks.dat');
copyFileSync(b3spec, k4spec);
copyFileSync(b3peaks, k4peaks);
const k4run = join(k4dir, 'run.json');
writeFileSync(
  k4run,
  `${JSON.stringify({
    templateId: 'tpl-k4',
    createdAt: '2026-11-07T00:00:00.000Z',
    artifacts: [
      { path: k4spec, sha256: sha256(readFileSync(k4spec)) },
      { path: k4peaks, sha256: sha256(readFileSync(k4peaks)) },
    ],
  }, null, 1)}\n`,
  'utf8',
);
// 隔壁目录的 run.json 登记的是别的产物：不能拿来当这份的凭证
const k4other = join(tmp, 'k4other');
mkdirSync(k4other, { recursive: true });
const k4otherSpec = join(k4other, 'other_spectrum.dat');
const k4otherPeaks = join(k4other, 'other_peaks.dat');
copyFileSync(b3spec, k4otherSpec);
copyFileSync(b3peaks, k4otherPeaks);
// 这份 run.json 登记的是**另一批文件**（不在这条审计链上）：归属对不上就不能拿来当凭证
writeFileSync(
  join(k4other, 'run.json'),
  `${JSON.stringify({ templateId: 'tpl-other', artifacts: [{ path: join(k4other, 'someone_else.dat'), sha256: 'f'.repeat(64) }] })}\n`,
  'utf8',
);

const k4srv = createServer(createRoutes({ root, env: { ...process.env, XPSPEAK_ROOT: root, XPSPEAK_MODE: '', XPSPEAK_MODE_FILE: '' } }));
await new Promise((r) => k4srv.listen(0, '127.0.0.1', r));
const k4port = k4srv.address().port;
const k4auto = await request(k4port, '/xps/audit', {
  method: 'POST',
  body: JSON.stringify({ spectrumPath: k4spec, peaksPath: k4peaks }),
});
const k4foreign = await request(k4port, '/xps/audit', {
  method: 'POST',
  body: JSON.stringify({ spectrumPath: k4otherSpec, peaksPath: k4otherPeaks }),
});
await new Promise((r) => k4srv.close(r));

check('K4 不带 runPath 时自动用同目录的 run.json（只认同目录且能对上归属的那份）', () => {
  assert.equal(k4auto.status, 200, JSON.stringify(k4auto.json));
  assert.equal(k4auto.json.runPath_source, 'auto', `必须标成自动发现，实际 ${JSON.stringify(k4auto.json.runPath_source)}`);
  assert.equal(k4auto.json.runPath, k4run, '回包顶层要回显真正用到的那份 run.json');
  const byId = Object.fromEntries(k4auto.json.checks.map((c) => [c.id, c]));
  assert.equal(byId['uncontrolled'], undefined, `已经用了凭证就不该再有 uncontrolled，实际 ${JSON.stringify(byId['uncontrolled'])}`);
  assert.equal(byId['artifacts-modified'].status, 'pass', byId['artifacts-modified'].detail);

  // 归属对不上：隔壁目录的 run.json 登记的是别人，必须当没有（不能把 fail 洗成 pass）
  assert.equal(k4foreign.json.runPath, null, `不属于这份产物的 run.json 不许用，实际 ${JSON.stringify(k4foreign.json.runPath)}`);
  assert.equal(k4foreign.json.runPath_source, null);
  const fById = Object.fromEntries(k4foreign.json.checks.map((c) => [c.id, c]));
  assert.equal(fById['uncontrolled'].status, 'warn', fById['uncontrolled'].detail);
});

check('K5 边界截断汇总成一条（最坏的那条进正文，逐峰明细进 details）', () => {
  const out = runPy(`
import json, sys
sys.path.insert(0, 'server')
import xps_fit as F
E = [round(860 + i * 0.1, 1) for i in range(201)]
comps = [{'center': 860.5, 'fwhm': 4.0}, {'center': 861.2, 'fwhm': 4.0}, {'center': 862.0, 'fwhm': 4.0},
         {'center': 863.0, 'fwhm': 4.0}, {'center': 864.0, 'fwhm': 4.0}]
pf = F.preflight({'comps': comps}, E=E)
print(json.dumps({'warnings': pf['warnings'], 'details': pf.get('details', {})}, ensure_ascii=False))
`);
  const r = JSON.parse(out);
  const trunc = r.warnings.filter((w) => w.includes('边界截断'));
  assert.equal(trunc.length, 1, `五个峰都近端也只能有一条汇总，实际 ${JSON.stringify(r.warnings)}`);
  assert.equal(r.warnings.length, 1, `这条用例只该有截断一条 warning，实际 ${JSON.stringify(r.warnings)}`);
  assert.match(trunc[0], /5 个峰心距谱端不到 3×FWHM/, trunc[0]);
  assert.match(trunc[0], /最坏是组分1 860\.50 eV，距 0\.50 eV = 0\.12×FWHM/, trunc[0]);
  assert.equal(r.details['boundary-truncation'].length, 5, '逐峰明细必须 5 项');
  assert.deepEqual(r.details['boundary-truncation'][0], { index: 1, center: 860.5, fwhm: 4.0, gap_ev: 0.5, ratio: 0.125 });
  assert.doesNotMatch(JSON.stringify(r.warnings), /组分\d+（[\d.]+ eV）峰心距谱端不到/, '逐峰各报一条的旧写法必须删干净');
});

/* ───────── 22. 模板 provenance：源谱优度（F2）与 FWHM 带来源（F5） ───────── */

process.stdout.write('\n[22] 模板 provenance：源谱优度（F2）与 FWHM 带来源（F5）\n');

const provPeaks = join(impFx, 'shirley', 'peaks.dat');
const provSpec = join(impFx, 'shirley', 'spectrum.dat');

check('K6 导入草稿记源谱优度（与 assess_peaks 复算一致、bounds 不编 0），存成模板后还在', () => {
  const out = runPy(`
import json, sys
sys.path.insert(0, 'server')
import xpspeak_import as I
import xps_fit as F

draft, _warns = I.draft_from_paths(${JSON.stringify(provPeaks)}, ${JSON.stringify(provSpec)}, 'Ni2p_demo.xps', '${'a'.repeat(64)}')
peaks = [{'pos': w['center_ev'], 'fwhm': w['observed']['fwhm_ev'], 'area': w['observed']['area'], 'gl': w['observed']['gl_pct']}
         for w in draft['peak_windows']]
spec = I.parse_spectrum(open(${JSON.stringify(provSpec)}, 'r', encoding='utf-8', errors='replace').read())
bg = I.classify_background(spec)
lo, hi = draft['provenance']['source_fit']['window_ev']
q = F.assess_peaks(spec['be'], spec['raw'], spec['bg'], peaks, lo, hi, bg_kind=bg['kind'])
print(json.dumps({'draft': draft, 'recomputed': {'r2_bg': q['r2'], 'rms': q['rms']},
                  'bg_kind': bg['kind']}, ensure_ascii=False))
`);
  const r = JSON.parse(out);
  const draft = r.draft;
  const prov = draft.provenance;
  const sf = prov.source_fit;
  assert.ok(sf && typeof sf === 'object', 'provenance.source_fit 必须写进去（模板要能回答「它自己拟合得好不好」）');
  assert.ok(Math.abs(sf.r2_bg - r.recomputed.r2_bg) < 1e-6, `r2_bg 必须与 assess_peaks 复算一致：${sf.r2_bg} vs ${r.recomputed.r2_bg}`);
  assert.ok(Math.abs(sf.rms - r.recomputed.rms) <= 1e-3, `rms 必须与复算一致：${sf.rms} vs ${r.recomputed.rms}`);
  assert.equal(sf.n_peaks, 3);
  assert.equal(sf.bounds, null, '导出文本里没有撞界信息，必须写 null —— 写 0 会被读成「没有撞界」');
  assert.deepEqual(sf.window_ev, [862.8, 880], `窗口要落 4 位且与谱范围取交，实际 ${JSON.stringify(sf.window_ev)}`);
  assert.equal(prov.fwhm_band_source, 'source-spectrum ±25%', 'FWHM 区间是源谱实测 ±25% 推的，必须标明');
  assert.equal(prov.sha256, 'a'.repeat(64));
  assert.equal(r.bg_kind, 'shirley');

  const created = createTemplate(draft, root);
  assert.equal(created.ok, true, JSON.stringify(created.errors));
  const meta = JSON.parse(readFileSync(join(root, 'templates', created.template.id, 'meta.json'), 'utf8'));
  assert.equal(meta.provenance.source_fit.r2_bg, sf.r2_bg, '存盘后 source_fit 不许丢');
  assert.equal(meta.provenance.source_fit.bounds, null);
  assert.equal(meta.provenance.fwhm_band_source, 'source-spectrum ±25%');
  assert.equal(meta.provenance.sha256, 'a'.repeat(64));
});

check('K7 provenance 白名单改严：未知键被拒并列全允许键，sha256 不再静默丢弃，老模板仍通过', () => {
  const bad = validateTemplate({ ...GOOD, provenance: { source_file: 'a.dat', artifacts: ['x'], foo: 1 } });
  assert.equal(bad.ok, false, '未知键必须拒绝，不许静默丢弃');
  const joined = bad.errors.join('\n');
  assert.match(joined, /provenance\.artifacts 不是已知字段/, joined);
  assert.match(joined, /provenance\.foo 不是已知字段/, joined);
  assert.match(joined, /source_file \/ points \/ step_ev \/ range_ev \/ sha256 \/ source_fit \/ fwhm_band_source/, '必须把允许键列全');

  const good = validateTemplate({
    ...GOOD,
    provenance: {
      source_file: 'a.dat', points: 401, step_ev: 0.1, range_ev: 40,
      sha256: 'B'.repeat(64),
      fwhm_band_source: 'source-spectrum ±25%',
      source_fit: { r2_bg: 0.9975, rms: 304.25, n_peaks: 5, window_ev: [849.4, 865.9], bounds: null },
    },
  });
  assert.equal(good.ok, true, JSON.stringify(good.errors));
  assert.equal(good.template.provenance.sha256, 'b'.repeat(64), 'sha256 必须真存下来（第十五批被白名单静默丢掉过）');
  assert.equal(good.template.provenance.fwhm_band_source, 'source-spectrum ±25%');
  assert.equal(good.template.provenance.source_fit.r2_bg, 0.9975);
  assert.equal(good.template.provenance.source_fit.rms, 304.25);
  assert.equal(good.template.provenance.source_fit.bounds, null, 'bounds 不许被默认成 0');

  const old = validateTemplate({ ...GOOD, provenance: { source_file: 'old.dat' } });
  assert.equal(old.ok, true, JSON.stringify(old.errors));
  assert.equal(old.template.provenance.source_fit, null, '老模板没有优度就是 null，不是 0');
  assert.equal(old.template.provenance.sha256, '', '老模板没有哈希就是空串');
});

/* ───────── 结果 ───────── */

if (failures.length > 0) {
  process.stdout.write(`\nselftest FAILED: ${failures.length} 条不过（passed ${passed}）\n`);
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.stdout.write(`\nselftest OK: ${passed} 项全过（模板 CRUD / 路由状态码 / 空态 / 拒绝路径 / sha256 两分支 / tab 契约 / 无 MCP 调用 / files 覆盖 / 公式对拍）\n`);
