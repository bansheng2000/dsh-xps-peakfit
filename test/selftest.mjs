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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
  stateRoot,
  thumbSvg,
  useInstruction,
  validateTemplate,
  writeSelection,
  writeFavorites,
} from '../lib/routes.js';
import { SERVER_FILES, packagedServerDir, syncServerFiles } from '../lib/index.js';

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
  assert.ok(Array.isArray(r2.instruction.warnings) && r2.instruction.warnings.length === 0, '写了 eta 就不该有 warnings');
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

check('W4 窗口适用性：谱窗 17.5 < 模板 40 → 拒绝；够宽 → 放行；读不到 → 只警告', () => {
  const t = { ...GOOD, applicable_window_ev: 40 };
  const narrow = useInstruction(t, 'exec', { lo: 844.4, hi: 861.9 });
  assert.equal(narrow.ok, false, '窗口不够必须拒绝');
  assert.equal(narrow.code, 'window-too-narrow');
  assert.match(narrow.message, /17\.5/, '拒绝理由要写实际窗口宽度');
  assert.equal(useInstruction(t, 'exec', { lo: 830, hi: 875 }).ok, true);
  const unknown = useInstruction(t, 'exec', null);
  assert.equal(unknown.ok, true, '拿不到谱就不能拦');
  assert.match(unknown.instruction.warnings.join('\n'), /未核对/);
  assert.match(
    useInstruction({ ...GOOD }, 'exec', { lo: 830, hi: 875 }).instruction.warnings.join('\n'),
    /未标 applicable_window_ev/,
    '老模板缺字段只警告，不拦',
  );
});

const w5SpecNarrow = join(tmp, 'w5-narrow.txt');
const w5SpecWide = join(tmp, 'w5-wide.txt');
writeFileSync(w5SpecNarrow, '# BE  intensity\n844.4  100\n850  500\n861.9  120\n', 'utf8');
writeFileSync(w5SpecWide, '830  10\n850  500\n875  20\n', 'utf8');
const w5Created = createTemplate({ ...GOOD, applicable_window_ev: 40 }, root);
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

check('⑩ 背景不一致 → build_guard 拒绝；tougaard 按 file 只警告不拦', () => {
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
tg = build_guard(peaks, 'tougaard', 'file', None, None)
E = [880 - 0.05 * i for i in range(600)]
raw = [F.model_at(e, [856.7, 1.177, 30000.0], 1, 0.0, 0.0, 0.3) + 10.0 for e in E]
res = F.fit(E, raw, [10.0] * len(E), [856.5], ds=0.0, ratio=0.0, eta=0.3, wlo=0.6, whi=4.0, ctol=1.0)
pf = F.preflight(res, bg_used='file', expect_bg='tougaard')
ok_same = F.preflight(res, bg_used='linear', expect_bg='linear')['ok']
print(json.dumps({'bad': bad, 'tougaard_ok': tg, 'tougaard_warn': pf['warnings'],
                  'tougaard_ok_preflight': pf['ok'], 'same_bg_ok': ok_same}))
`);
  const r = JSON.parse(out);
  assert.equal(r.bad, true, 'linear 模板 + file 背景必须拒绝');
  assert.equal(r.tougaard_ok, true, 'tougaard 按 file 处理：允许保存');
  assert.equal(r.tougaard_ok_preflight, true, 'tougaard 不阻断');
  assert.equal(r.same_bg_ok, true, '背景一致时不许乱拦');
  assert.ok(r.tougaard_warn.some((w) => w.includes('tougaard')), '但必须给警告');
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

/* ───────── 结果 ───────── */

if (failures.length > 0) {
  process.stdout.write(`\nselftest FAILED: ${failures.length} 条不过（passed ${passed}）\n`);
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.stdout.write(`\nselftest OK: ${passed} 项全过（模板 CRUD / 路由状态码 / 空态 / 拒绝路径 / sha256 两分支 / tab 契约 / 无 MCP 调用 / files 覆盖 / 公式对拍）\n`);
