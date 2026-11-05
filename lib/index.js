/**
 * dsh-xps-peakfit — 插件壳
 * =====================
 *
 * 只做两件事，不做第三件：
 *   1. **把包内的三个 py 同步到安装位**（`~/.dsh/dsh-xps-peakfit/server/`）。
 *      以**包内**为准：pnpm 重装 node_modules 会清掉别处，而 MCP 连接器指向安装位，
 *      两边不一致时静默跑旧代码是最难查的故障 —— 所以不一致就覆盖并写一行日志。
 *   2. **挂模板页的路由**（`/xps`）。
 *
 * 不做：不调 MCP、不驱动 XPSPeak、不装连接器（连接器由用户/Chief 走连接器 API 改）。
 * 模板页的「用这个」只产出结构化指令，执行在 agent 侧，闸门在 MCP 的 _refuse_in_teach。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROUTE_PREFIX, createRoutes, installedServerDir, sha256, stateRoot } from './routes.js';

export const name = 'xps-peakfit';

/** 无必需 seam。`webServer` 是可选 seam，按仓库约定在 apply() 里 ctx.inject 懒加载。 */
const inject = [];
export { inject };

/** 包内随附的 py（与安装位同源）。 */
export const SERVER_FILES = ['xpspeak_mcp.py', 'xpspeak_drive.py', 'xps_fit.py'];

export function packagedServerDir() {
  return fileURLToPath(new URL('../server', import.meta.url));
}

/**
 * 比对包内与安装位的 sha256，不一致则以包内为准复制过去。
 * 返回 [{file, action:'copied'|'same'|'missing-in-package', from, to}]，供日志与自检。
 * **只允许 package → installed**，反向覆盖是禁止的（否则用户机器上的旧副本会传染回来）。
 */
export function syncServerFiles({ from = packagedServerDir(), to = installedServerDir(), copy = copyFileSync, read = readFileSync, exists = existsSync, mkdir = mkdirSync } = {}) {
  const report = [];
  if (!exists(to)) mkdir(to, { recursive: true });
  for (const file of SERVER_FILES) {
    const src = join(from, file);
    const dst = join(to, file);
    if (!exists(src)) {
      report.push({ file, action: 'missing-in-package', from: null, to: exists(dst) ? sha256(read(dst)) : null });
      continue;
    }
    const srcHash = sha256(read(src));
    const dstHash = exists(dst) ? sha256(read(dst)) : null;
    if (srcHash === dstHash) {
      report.push({ file, action: 'same', from: srcHash, to: dstHash });
      continue;
    }
    copy(src, dst);
    report.push({ file, action: 'copied', from: dstHash, to: srcHash });
  }
  return report;
}

export function apply(ctx) {
  const logger = ctx?.logger?.('xps-peakfit') ?? console;
  const log = (message) => {
    try {
      (logger.info ?? logger.log ?? console.log)(`xps-peakfit: ${message}`);
    } catch {
      /* 日志失败不影响插件 */
    }
  };

  try {
    const report = syncServerFiles();
    for (const item of report) {
      if (item.action === 'copied') log(`server/${item.file} 已用包内版本覆盖安装位（${String(item.from).slice(0, 12)} → ${String(item.to).slice(0, 12)}）`);
      else if (item.action === 'missing-in-package') log(`server/${item.file} 包内缺失，保留安装位不动（这不是正常状态，请检查 files 字段）`);
    }
  } catch (error) {
    log(`server 同步失败：${error?.message ?? error}`);
  }

  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => {
      const dispose = sctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: createRoutes({ root: stateRoot(), env: process.env }),
      });
      log(`模板页路由已挂到 ${ROUTE_PREFIX}/（数据目录 ${stateRoot()}）`);
      return () => dispose?.();
    }, 'xps-peakfit: template routes');
  });
}
