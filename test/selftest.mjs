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
  removeTemplate,
  renameTemplate,
  sha256,
  stateRoot,
  thumbSvg,
  useInstruction,
  validateTemplate,
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

/* ───────── 结果 ───────── */

if (failures.length > 0) {
  process.stdout.write(`\nselftest FAILED: ${failures.length} 条不过（passed ${passed}）\n`);
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.stdout.write(`\nselftest OK: ${passed} 项全过（模板 CRUD / 路由状态码 / 空态 / 拒绝路径 / sha256 两分支 / tab 契约 / 无 MCP 调用 / files 覆盖 / 公式对拍）\n`);
