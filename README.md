# dsh-xps-peakfit

XPS 分峰拟合的固定四步 SOP（荷电校正 → 全谱分析 → 高分辨分峰 → 峰位移），执行软件 XPSPeak 4.1。
拿到谱、要化学态归属或峰位移结论时用本 skill；只想让 AI 操作 XPSPeak 界面（开谱、加分峰、导出），用配套的 `xpspeak-automation`。

## 安装

插件装进 DSH profile：`dependencies` 与 `dsh.profile.bundles` 两处都要有它，只写依赖会被 `pnpm install` prune 掉。

```powershell
cd C:\Users\12576\.dsh\profiles\desktop
pnpm add -D dsh-xps-peakfit@file:E:/文档/deepseek-harness/dsh-xps-peakfit
```

重启 DSH 后确认：侧栏出现「XPS 模板」页，连接器里出现 `custom-xpspeak`（`serverName=xpspeak`、`injectionMode=always`）。

## 快速开始

1. 导入：模板页上传 `.xps`，生成草稿——峰位、FWHM、%GL、面积、背景类型、拟合窗口全部取自软件导出的文本，不解析二进制。
2. 补必填：`element` / `orbital` 能从文件名认出就预填，认不出必须手填；`category` 默认「高分辨谱」。
3. 选模板：点「选这个」写入 `selection.json`，之后的 fit / build 都以它为约定。
4. 拟合：`xpspeak_fit`（纯 Python，不开 GUI）出峰参数；撞界、残差分段、峰顶缺口不过就回去调。
5. 落盘：`xpspeak_build` 按这组参数生成原生 `.xps`，保存前用同一套门槛复算一遍。
6. 审计：`/xps/audit` 复核产物与模板是否一致（同目录有 `run.json` 会自动采用），`/xps/runlog` 写交付凭证。

全程只用这 9 个固定工具名：`xpspeak_status`、`xpspeak_open`、`xpspeak_export`、`xpspeak_save`、`xpspeak_menu`、`xpspeak_click`、`xpspeak_close`、`xpspeak_fit`、`xpspeak_build`。

最小模板骨架（字段全貌见 `SKILL.md`）：

```json
{ "name": "Ni 2p", "category": "高分辨谱", "element": "Ni", "orbital": "2p",
  "background": "shirley", "doublet_delta_ev": null, "charge_correction_ev": null,
  "peak_windows": [{ "center_ev": 852.884, "eta": 0.48, "observed": { "fwhm_ev": 1.93, "gl_pct": 48 } }],
  "fwhm_min": 1.4475, "fwhm_max": 2.4125, "fit_window_ev": { "lo": 847.094, "hi": 865.49 } }
```

## 关键概念与限制

| 约定 | 说明 |
| --- | --- |
| 模板只管拟合约定 | 峰位、FWHM 带、逐峰 eta、背景类型、拟合窗口、约束；显示设置、平滑、配色都不进模板 |
| 双线不猜 | 2.9.0 起 `ds` 默认 0：不传就是单线；要伴线必须显式给 Δ，模板 `doublet_delta_ev` 为 `null` 时同样是单线 |
| 模板不跨元素复用 | 一个模板对应一个元素 + 轨道的一组谱；换元素或换卫星结构要另建 |
| FWHM 带带来源 | `fwhm_min/max` 是标定源谱实测 ±25%，来源记在 `provenance.fwhm_band_source`，换样品不一定适用 |
| 硬闸会阻断 | 撞界、背景口径不一致、优度不过（R²(扣背景)<0.85、残差段>0.5×rms、缺口>10%）都拒绝保存；只有 `force:true` 放行且写进 `run.json` |
| 面积回读有系统偏差 | 2–5%，宽峰更甚；别设 1% 硬闸 |

## 数据目录

```
~/.dsh/dsh-xps-peakfit/
  templates/<id>/meta.json   模板（导入草稿或手写；`.rpa` 不支持，只有区域峰参数、没有谱）
  imports/<时间戳>.json      导入草稿，只留最近 20 份；上传上限 20 MB
  mode.json                  档位真源：teach（只读讲解）/ exec（代执行）
  selection.json             当前选中模板；模板被删后标 stale 并给出原因
  run.json                   交付凭证，落在产物目录，不在本根
```

## 故障排查

| 现象 | 处置 |
| --- | --- |
| 409 `runlog-exists` | 该目录已有凭证；确认是同一产物后加 `overwrite:true` 重写，否则换输出目录 |
| 415 `rpa-not-supported` | `.rpa` 只存区域峰参数、没有谱，改用 `.xps` 或两列 ASCII 导入 |
| 504 `import-timeout` | 软件没响应或弹了没人点的对话框；重试，仍失败用 `--no-hidden` 跑一次看卡在哪 |
| 422 `no-peaks` | 这份 `.xps` 里没有已定义峰；先在 XPSPeak 里拟合并 Add Peak 再导入 |
| 409 `import-busy` | 同一时间只允许一个导入；等前一个结束，陈锁超过 5 分钟可抢 |

## 版本与变更

当前 `2.9.0`。字段、门槛与破坏性变更见 [CHANGELOG.md](CHANGELOG.md)，四步 SOP 与判据全文见 [SKILL.md](SKILL.md)。
