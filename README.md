# dsh-xps-peakfit

XPS 分峰拟合 SOP —— 一个给 AI agent 用的 skill（Agent Skills 目录形态，`SKILL.md` + `references/`）。

仓库：<https://github.com/bansheng2000/dsh-xps-peakfit>

**四个步骤，名称与顺序是硬约束**（不得新增、删除、重命名或打乱）：

| # | 步骤 | 产物（第六节产物契约） |
|---|---|---|
| 1 | 荷电校正 | `01_charge_correction.md` + 校正后谱图 |
| 2 | 全谱分析 | `02_survey_elements.md` |
| 3 | 高分辨分峰 | `03_peakfit_<样品>_<轨道>.md` + 图 + 曲线数据 + XPSPeak 状态文件（`.xps` / `.rpa`） |
| 4 | 峰位移分析 | `04_shift_analysis.md` |
| — | 交付 | `05_deliverables.md` + 交付包；全程维护 `xps_run_record.md`（第七节） |

每一步都写齐：**输入 → 处理目标 → 输出 → 注意事项 → 门槛**。软件侧映射到 **XPSPeak 4.1** 的面板操作（附录 A：菜单/字段 ↔ 四步）。

## 关键机制

- **通过门槛**：每步末尾有一组勾选项，上一步门槛未过就停在该步，不往后做。例如步骤 3：每峰有物理依据、约束可逐项追溯到用户确认、残差无系统性结构、优度达标（达标判据由用户给定）。
- **产物契约**：每步固定文件名与最小字段，文件名以步骤号开头，顺序即执行顺序；原始数据目录只读。
- **结论必须有依据**：每条结论写成 `claim` / `依据（哪一步、哪个产物）` / `置信状态（支撑｜不可区分｜不支持｜不足以判定｜未验证）` / `备选解释`；缺依据自动降级为「不足以判定」（第九节）。
- **项目记录与续接**：`xps_run_record.md` 记录样品清单、逐样品 ΔE、各轨道约束、产物路径、未决问题；新会话**先读记录并逐个核对产物文件真实存在**，不凭旧完成标记跳过（第七节）。
- **步内 mode**：默认「执行」；「诊断」模式只读、只列问题，不改数、不自动转成修改（第二节）。
- **待确认问题表**：信息缺失项在第八节表化列出，并标注「阻塞 / 可延后」，不在缺信息时替用户假设。
- **出图分工**：数据与判定归本 skill；交给绘图 skill 的「出图委派包」共 10 项（数据文件 / 系列表 / 双线绘制约定 / 标注文本 / 轴 / 页面 / 禁止项 / 交付 / 验收），清单见 `SKILL.md` 第六节约定；要按参考图复刻排版/配色走 `dsh-origin-replica`（本 skill 只交数据、系列与标注、版面约束与禁止项），Origin 工具级细节走 `origin-plotting`。
- **Origin 收尾显示窗口**：出完最后一张 Origin 图（或交付完成）调 `origin_reveal` / `origin_release` 把 Origin 窗口显示出来并确认 `visible_after` 为真；不这么做，任务结束后只剩一个**看不见的 Origin 后台实例**（COM 拉起默认隐藏），用户既没法直接看/存/关，还挡住下次开 Origin。

## 交付物（缺一项即未交付）

- 步骤产物 `01`–`04` + `05_deliverables.md`
- **XPSPeak 保存文件**：`.xps`（谱图 + 背景 + 已定峰，可原样载回）/ `.rpa`（只存区域峰参数）
- **Origin 保存文件**：工程文件（如 `.opju`），图能继续编辑
- 图（PNG / PDF / TIF / SVG）+ 导出的 ASCII 与峰参数表
- **交付前必做「载回校验」**：`.xps` 重新载入、Origin 工程重新打开，峰参数/图页与产物表一致
- **残差不进成品图，但必须进交付物**：成品图不画残差子图；残差判定（拟合优度 + 是否含系统性结构 + 判定依据）必须写进 `03_peakfit_*.md` 与报告

## 文件

| 路径 | 内容 |
|---|---|
| `SKILL.md` | 技能正文（十一节）：〇 用途与边界 · 一 铁律 · 二 触发条件与使用方式 · 三 整体输入要求 · 四 整体输出要求 · 五 四个步骤（含附录 A XPSPeak 4.1 执行映射、附录 B 分轮放开与检查点，及步骤 3 的「基准参数快照」）· 六 产物契约与交付物清单 · 七 项目记录与续接 · 八 待确认问题 · 九 结论字段规范 · 十 禁止事项 · 十一 科学边界 |
| `references/deliverable-templates.md` | `01`–`04` 产物与 `xps_run_record.md` 的可直接填空骨架（字段名不要改，未获取的项写「待确认」，不留空、不猜） |
| `package.json` / `cordis.patch.yml` | 插件包声明（`files` 必须列全运行期文件）与 bundle patch（`- insert:` 形态） |
| `lib/index.js` | 插件入口：`server/*.py` sha256 同步 + 挂 `/xps` 路由 |
| `lib/routes.js` | 模板存取、SVG 缩略图、「用这个」指令、回环校验、档位读取 |
| `lib/client.js` | 右侧栏「XPS 模板」标签（免构建，宿主 ModuleLoader 注入） |
| `server/*.py` | XPSPeak 驱动的三个 py 副本（与安装位同源，包内为准） |
| `test/selftest.mjs` | 自检：模板 CRUD / 路由状态码 / 拒绝路径 / sha256 两分支 / tab 契约 / 无 MCP 调用（`node test/selftest.mjs`） |

版本号与完整变更见 `CHANGELOG.md`（当前 v2.8.0 未发版）。本 README 不再内联变更摘要，版本只维护 `CHANGELOG.md` 一处。

## 插件壳与模板页（v2.8.0 未发版）

本仓库同时是 DSH 插件包（`package.json` + `lib/index.js` + `cordis.patch.yml`），壳只做两件事：

- **三个 py 同步**：包内 `server/*.py` 与安装位 `~/.dsh/dsh-xps-peakfit/server/` 比 sha256，不一致**以包内为准**覆盖并写一行日志（`旧 → 新`）。反向覆盖是禁止的。MCP 连接器 `custom-xpspeak` 指向安装位，所以 `files` 字段漏一个文件就等于装完缺文件。
- **模板页路由 `/xps`**：`GET /xps/templates`、`POST /xps/templates?filename=a.json`、`POST /xps/templates/<id>/{rename,use}`、`DELETE /xps/templates/<id>`、`POST /xps/favorites`、`GET /xps/thumb/<id>`。全部只接受回环请求（Host + peer 双查），其余 403。

侧栏标签：`id = kind = 槽位 key = "xps"`（三者必须同一字符串），显示名「XPS 模板」，另注册一个不带 `guide` 的兼容别名 `xps-templates`。

模板是一个 JSON（`name` / `category` / `element` / `orbital` / `doublet_delta_ev` / `peak_windows[]` / `fwhm_min` / `fwhm_max` / `background` / `constraints` / `note`），**不预置任何模板**：峰位差 1 eV 结论就错，宁可不给。缩略图由 `lib/routes.js:pseudoVoigt` 按模板参数算一条模拟谱拼成 SVG（公式与 `server/xps_fit.py:gl` 一致，自检里对拍），算不出来给「无参数」占位。

**「用这个」只产出结构化指令**（模板字段 + 建议调用顺序），交 agent 执行；服务端**从不**调 MCP、不驱动 XPSPeak。教学模式（`~/.dsh/dsh-xps-peakfit/mode.json`，与 MCP 同一份真源）下按钮禁用，且服务端同样返回 403 —— 前端禁用只是体验，闸门在服务端。

数据目录：`~/.dsh/dsh-xps-peakfit/`（`templates/<id>/meta.json`、`favorites.json`、`mode.json`、`server/`）。pnpm 重装 node_modules 不会清这里。

## 使用

把本仓库目录放进 agent 的技能目录即可（例如 DSH 的 `~/.agents/skills/dsh-xps-peakfit/`）。

触发词：XPS 分峰 / XPS 拟合 / XPS peak fitting / XPSPeak / XPSPEAK41 / 荷电校正 / charge correction / 高分辨谱 / C 1s 校正 / 峰位移。

## 边界（本 skill 不做什么）

- 不做仪器校准；不给全谱定量结论；不保证化学态归属正确；不替用户判定数据「够不够发」
- 不解析各家仪器的数据格式；不内置拟合算法与软件依赖
- 不提供参考峰标准值库
- 判据阈值（校正容许漂移、拟合优度达标线等）一律由用户给定，缺失时标注「未核定」，不代为编造

## 禁止事项（节选，全文见第十节）

- 不为压低残差而加峰；峰数必须有物理依据
- 不得把 XPSPeak 面板读数当成用户已确认的约束——未逐项确认前一律标为「截图读数」
- 不输出无依据结论；不凭旧完成标记跳过未验证步骤

## 许可

暂未附 `LICENSE` 文件，默认保留所有权利；需要开源许可（MIT / CC-BY 等）请提出。
