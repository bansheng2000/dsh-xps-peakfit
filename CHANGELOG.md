# 变更记录

## 第十七批 C：模板记源谱优度与 FWHM 来源（F2 / F5）

版本仍 `2.8.0`。

- **问题（F2）**：模板 `provenance` 只有 `source_file`/`points`/`step_ev`/`range_ev`/`sha256`，事后无法回答「这份模板自己拟合得好不好」；而且路由的 `provenance` 是白名单，**未知键静默丢弃**——连草稿里的 `sha256` 都被丢掉了，面板显示有哈希、存下来却没有。
- **改法（F2）**：导入侧在 `build_draft()` 里用 `xps_fit.assess_peaks()` 按导出峰参数与谱复算源谱优度，写 `provenance.source_fit = {r2_bg, rms, n_peaks, window_ev, bounds}`；`bounds` 写 `null`（导出文本没有撞界信息，写 0 等于编）。复算失败就一条 warning 并**不写**这个字段，不假装有值。模板详情表新增「源谱优度」一行，老模板显示「未记录（第十六批之前建的模板）」，不显示 0。
- **改法（F5）**：导入侧写 `provenance.fwhm_band_source = "source-spectrum ±25%"`（`fwhm_min/max` 就是源谱实测 ±25% 推的，跨样品不可迁移）；撞界提示补一句「这些是调用方给的约束，不是本谱实测」——MCP 层拿不到模板来源，所以只写「若来自模板，它是源谱实测 ±25% 推的」，不编。
- **provenance 白名单改严**：`validateTemplate` 只收 `source_file`/`points`/`step_ev`/`range_ev`/`sha256`/`source_fit`/`fwhm_band_source`，出现未知键 400 并列出允许键（不再静默丢弃）；`sha256` 必须 64 位十六进制并真正保存，`fwhm_band_source` ≤120 字符，`source_fit` 逐项校验（`r2_bg∈[0,1]`、`rms≥0`、`n_peaks` 整数 ≥1、`window_ev` 为 `[lo,hi]` 或 null、`bounds` 为整数 ≥0 或 null）。
- **自检**：新增 [22] 段 K6（草稿 `source_fit` 与独立 `assess_peaks` 复算一致到 1e-6、`bounds` 为 null、窗口与谱范围取交 `[862.8, 880]`、`fwhm_band_source` 正确，`createTemplate` 存盘后三项仍在）、K7（未知键被拒且列出全部允许键、`sha256` 大写存成小写、老模板 `source_fit` 为 null 而非 0）。先红：旧代码 `FAIL K6 … KeyError: 'source_fit'`、`FAIL K7 …: 未知键必须拒绝，不许静默丢弃`（passed 150）。两处变异各真红：不写 `source_fit` → K6；白名单放行未知键 → K7。

## 第十七批 B：审计自动发现 run.json（F3）+ 边界截断汇总（F6）

版本仍 `2.8.0`。

- **问题（F3）**：面板「审计这份」只传 `spectrumPath`/`peaksPath`/`templateId`，从不传 `runPath`，于是同一目录明明有 `run.json`，`uncontrolled` 也永远 warn、`summary.runPath` 永远 `null`；回包顶层还没有这个字段。用户看到的是「有凭证也说过没凭证」。
- **改法**：新增 `findAutoRunJson()`（`lib/routes.js`，可单测）：在谱/峰所在目录找 `run.json`，但只认**确实是这份产物**的那份——`artifacts` 里登记了本次审计的谱或峰，或它的 `spectrumSha256` 等于本次谱的哈希；归属对不上就当没有（宁可 `uncontrolled` warn，也不拿隔壁那次跑的凭证把 fail 洗成 pass）。`/xps/audit` 回包新增顶层 `runPath` 与 `runPath_source`（`body`/`auto`/`null`），面板结果表加一行「交付凭证」，写清是自动发现还是请求里给的、以及没有时为什么 warn。
- **问题（F6）**：`preflight` 对边界截断逐峰 `append` 一条，五个峰就五行几乎同义的话。
- **改法**：`server/xps_fit.py` 改成汇总一条——正文写「N 个峰心距谱端不到 3×FWHM（最坏是组分 k，距 x eV = y×FWHM）」，逐峰明细进 `details["boundary-truncation"]`（`index`/`center`/`fwhm`/`gap_ev`/`ratio`），`preflight` 返回值新增 `details`。
- **自检**：新增 [21] 段 K4（不带 `runPath` 调审计 → `runPath_source=auto`、顶层 `runPath` 回显、`artifacts-modified` pass、无 `uncontrolled`；隔壁目录登记别人的 `run.json` 必须 `null` + `uncontrolled` warn）、K5（五峰全近端 → 只有一条截断 warning、`details` 5 项、最坏是组分 1 0.12×FWHM、旧的逐峰写法不许残留）。先红：旧代码 `FAIL K4 …: 必须标成自动发现，实际 undefined`、`FAIL K5 …: 0 !== 1`（passed 148）。两处变异各真红：关掉自动发现 → K4「实际 null」；截断改回逐峰 → K5（5 行）。

## 第十七批 A：`ds` 默认改 0（不猜）+ 峰高/面积口径写明（F1 / F4）

版本仍 `2.8.0`。

- **问题（F1）**：`xpspeak_fit` 的 `ds` 默认是 1.18（S 2p 的劈裂），不传就静默套到任何元素上。Ni 2p 五峰实测：默认 1.18 → 第 2 个组分峰高被压到 **0**、撞界 1 项、R² 0.997957→0.985095、rms 276.76→747.54、峰顶缺口 3.4%→12.4%。只有一条「撞界」提示，结果看着还挺好。
- **改法**：`server/xps_fit.py` 的 `fit(..., ds=0.0)`、`run(..., ds=0.0)` 与 CLI 入口、`server/xpspeak_mcp.py` 的 `do_fit`（`a.get("ds", 0.0)`）、schema 文案全部改成「不传 = 0（单线、没有伴线、不猜）；要双线必须显式给 Δ」。模板路径本来就是 `template.doublet_delta_ev ?? 0`，不动。`_constraint_warnings` 加 `0.0 < ds` 条件——单线不该出现任何伴线口径提示。
- **问题（F4）**：返回的 `height` 只是**主线**幅度，`area` 却是**双线合计**，ratio=0.5 时 `area/(w·af(η))` 恰好 = 1.5×`height`（实测四个组分 23871.8/15917、11381.0/7589、2895.5/1931、3984.6/2657 全是 1.500）。按 `height` 画图会以为「拟合矮了 43%」。
- **改法**：comps 新增 `height_pair`（该峰位处含伴线尾巴的合计高度）与 `area_main`（主线面积）；`report()` 组分行改印「area …（双线合计） h主=… / h合=…」，`ds=0` 时不再印「伴线」，模型行改印「ds=0（单线：没有伴线，N 个独立峰）」。
- **自检**：新增 [20] 段 K1（不传 `ds` 是单线、五峰高度都 >0、无撞界、R² 0.997957；显式 1.18 时某峰高度 ==0 且 bounds 含 `height`）、K2（两层源码默认都是 0、schema 与 CLI 不许留 1.18）、K3（`height_pair > height`、`area_main < area`、`area − area_main == ratio×area_main`、报告文案）。夹具 `test/fixtures/ds/ni2p_5peak_spectrum.dat`（30723 B，来自 `ceshiqu\out\20261107-ni2p-2xls-clean`）。三处变异各真红：`run` 默认改回 1.18 → K1/K2/K3；`height_pair = h` → K3；报告恒按双线印 → K1。

## 补：面板 %GL 改为逐峰显示（`lib/client.js`）

版本仍 `2.8.0`。

- **问题**：模板卡片 meta 行与详情表「模板值」列只看全局 `eta`（这些模板是 0.3），把 `48/100/100/100` 显示成 `GL 30%`。拟合链路（`lib/routes.js` 的 `etaPerPeak`）一直按逐峰走，**只有显示错，拟合没错**。
- **改法**：新增 `glText(t)` —— 有逐峰 `peak_windows[].eta` 就逐峰显示（各峰相同收成一个数，个别峰缺值用全局 `eta` 补），没有逐峰才退全局 `eta`，两者都没有显示 `GL 30%（默认）`。卡片与详情表都改走它；详情表「来源」列改为「实测 / 约束夹出 / 近似」。
- **自检 J10**：把 `glText` 源码整段摘出来求值验证行为（`48/100/100/100`、同值收敛 `64`、仅全局 `30`、全无 `30%（默认）`、部分缺值 `50/30`），并钉住面板两处都走 `glText`、旧的「只读全局 eta」表达式不许残留；145 项全过。三处变异各真红：卡片退回旧表达式 → J10「模板卡片的 meta 行要走 glText」；`perPeak = false` → J10「逐峰 eta 必须逐峰显示」；详情表退回旧表达式 → J10「详情表「模板值」列要走 glText」。
## 第十六批：导入静默运行（默认 `--hidden`）+ 收尾清理的断言补强

版本仍 `2.8.0`。

- **静默模式**（`server/xpspeak_drive.py`）：`launch(..., hidden=False)` 启动时 `STARTUPINFO` 置 `STARTF_USESHOWWINDOW` + `wShowWindow=SW_HIDE`；新增 `HideKeeper(pid, interval=0.08)` 隐藏线程（`poll_once()` 扫 `tops(pid)`，只对 `IsWindowVisible` 的窗口 `ShowWindow(h, 0)`，记 `(ts, hwnd)`），随进程结束由 `stop_keeper()` 停掉。`build`/`export` 加 `hidden` 参数并在 `finally` 停线程。**只碰本次拉起的 pid**：实测用户自己开着的实例（pid 45932）Region 1 / XPS Peak Processing / XPSPEAK41 三个顶层窗口仍 `visible=True`。
- **`wait_new` 改认隐藏记录**：静默态窗口不可见，原来「新可见的 VB6 窗体」判据失效；改为从 `keeper.hidden` 里挑 `ts >= since - 0.3`、`cls=="ThunderRT6FormDC"` 且无菜单（`GetMenu==0`，分峰主窗体有菜单会被随机重新 Show）的窗口。`build` 里 Background 与每个 Add Peak 都以 `menu_click` 前的时间戳作 `since`——用函数入口时间会漏掉 Background 对话框（它 +0.086 s 就出现并在 settle 期间被隐藏）。
- **`server/xpspeak_import.py`**：`run_gui(..., hidden=True)`，CLI 新增 `--hidden`（默认开）/`--no-hidden`（排障）。
- **收尾清理抽成函数**（`lib/routes.js` `cleanupImportArtifacts(paths)`）：导入 `finally` 改为调它清 `workDir`/`stored`/`lockPath`。原因：Chief 实测把 `server/xpspeak_import.py` 的 `os.remove` 换成 `pass` 后 **142 项仍全绿**——J1–J7 走 `--replay` 夹具，夹具模式不产生那份复制出来的 `.xps`，删除分支从没被执行。
- **自检**：新增 J8（清理函数真删三个路径 + 路由 `finally` 必须调它、不许绕过它直接 `rmSync(stored)`）与 J9（`test/hidden_unit.py` 替身单测 22 项：启动标志、只隐藏本 pid、`poll_once` 只碰可见窗口、`wait_new` 的 since 闸与无菜单判据、`run_gui` 默认静默、导出前清旧文件），144 项全过。四处变异各真红：导入 finally 不调清理 → J8（连带 J1–J4 因源 `.xps` 残留变红）；`wShowWindow=1` → J9「启动时 SW_HIDE: dwFlags=1 wShowWindow=1」；`floor = t0` 忽略 since → J9；`if True:` 隐藏不可见窗口 → J9「hidden 了 [(201,0),(202,0),(203,0)]」。
- **导出前的旧文件清理抽成 `clear_stale_exports(paths)`**（`server/xpspeak_import.py`）：`run_gui` 导出前调它删掉工作目录里同名的 `peaks.dat`/`spectrum.dat`（旧文件留着会让 Export 对话框弹「覆盖?」，静默态可能抢不到；也容易让人把旧文件当成这次导出的）。单测钉住「真删、返回只含真删掉的、缺文件不算失败、`run_gui` 真的调它」——这样复验时那条 `os.remove(p) → pass` 的变异现在**真红**（`FAIL J9 … 旧导出文件要删掉: a=True b=True`）。说明一下：这一行删的是**中间产物**，用户上传的源 `.xps` 由路由 `finally` 的 `cleanupImportArtifacts` 删，两条分支各自都有断言。
- **实测读数**：静默导出 30241 B / 9.2 s / md5 `75f1fae44034f2bb16eac30d576aa7fe`，与可见模式**逐字节相同**；静默 `build` 全链路 28.2 s、写出 5643 B `.xps`，导出峰参数 `870.000/40000.000/1.200/30`、`874.000/30000.000/2.400/60` 与传入一致，Background（Shirley）与 Add Peak 对话框都被抓到；可见模式 build 回归 21.7 s / 4983 B 正常；真实 `.xps` 静默导入 12.9 s，回包与第十五批完全一致（`background shirley`、四峰同值、176 点、sha256 `8d354de2…`）。**窗口仍会闪现（10 ms 采样器实测单窗最长可见 0.29–0.36 s，含线程被抢占的偏差）**，不是 0；不建议改用独立桌面/窗口站。

## 第十五批：从 .xps 导入模板（峰参数取软件导出、背景判定与 audit 同源）

版本仍 `2.8.0`。

- **新脚本 `server/xpspeak_import.py`**：打开 `.xps` → 导出 `_peaks.dat`/`_spectrum.dat` → 生成模板草稿。纯函数 `suggest_from_name()`（Ni/Co/Fe 2p、Mo 3d、S 2p、C 1s、O 1s，空格/下划线/大小写都容忍）、`parse_peak_params()`、`parse_spectrum()`、`classify_background()`（`xps_fit.linear_bg`/`shirley_bg`，按扣背景峰高归一，<0.5% 判类型、都不过判 `file`）、`build_draft()`；测试通道 `--replay <dir>`（读现成的两份导出文本）与 `--stub-json`。
- **`POST /xps/import?filename=…`**（`lib/routes.js`）：教学档 403；`.rpa` 415（没谱）；非 `.xps`/文件头不是 `XPSPEAK 4.0` 415；>20 MB 413；`imports/.lock` 并发 409（陈锁 >5 min 视为上次被杀）；脚本 `no-peaks` 422、`xpspeak-not-found` 501、超时 504；成功后写 `imports/<时间戳>.json`（只留 20 份）并**删掉落盘的源 `.xps`**（原名与 `sha256` 已进草稿 provenance）。`--source-name` 传用户上传时的原始文件名，别把时间戳前缀写进 provenance。
- **面板**：新增「导入 .xps」（隐藏 input `accept=".xps"`）+ 草稿条：显示识别出的元素/轨道、峰数、背景、拟合区、来源与 sha256 前缀；`name/element/orbital/category` 四个输入框预填，空的标红，`submitDraft` 在**发请求之前**就拒（缺键不许保存），过了才 `POST /xps/templates?filename=meta.json` 复用既有 schema 校验。
- **修掉一个真 bug**：`.xps` 文件头检查原来比前 13 字节与 `'XPSPEAK 4.0'`（11 字符），永远不相等 → 任何真文件都被判 `not-xps`。真实文件头是 `XPSPEAK 4.0D` 后直接跟二进制，改成只比前 11 字节。
- **自检**：`[19]` 段 J1–J7（草稿逐项、linear/file 两档、拒绝路径、prune 20 份、草稿能直接过 `validateTemplate` 并 POST 成功、面板必填不许绕过），142 项全过。四处变异各真红一条（背景判定恒 shirley → J2/J3；eta 取标量 → J1；fit_window 不取交集 → J1；不删源 `.xps` → J1）。

## 第十四批补：I1 第三臂（模板复现）+ runlog 自动谱哈希

- **`template-copied` 的第三臂（`lib/audit.js` `fitMirrorsTemplate`）**：模板 `provenance.source_file` 是 `2.xls（Ni2p Scan）`、被审谱却是派生的 `ni2p_cc.dat` 时，哈希臂与 basename 臂都永远判不出同源 —— 用户照模板复现一次仍被判 fail（实测 Ni 2p 交付：`counts {pass:4,warn:3,fail:1}`，verdict fail）。
  现在补一条：`run.json.templateId` 等于模板 id，且 `run.json.fit` 的实参与模板导出参数**逐项相等**（各峰 centers 1e-6、`wlo/whi` = `fwhm_min/max`、eta 逐峰、ctol（模板为空时比峰窗 `search_ev`）、window = `fit_window_ev`、bg = `background`）→ `template-copied` 判 `warn`，detail 写「实参与模板逐项一致（…）：模板复现，不是独立拟合」。任何一项被改就回到 `fail`（可证伪：改一个 center +0.01 eV 即红）。
  同一份真实产物复跑结果：`template-copied=warn`、verdict `warn`、`counts {pass:4,warn:4,fail:0,skip:0}`（其余 warn 是 peak-gap 6.0% 与两处边界截断，属既有口径）。
- **runlog 自动补 `spectrumSha256`（`lib/routes.js`）**：body 没显式给时，若 `dir` 里能**唯一**定位到 `*_spectrum.dat`（或 `.txt`/`.csv`）就顺手算一个；候选多于一个就留空 —— 不猜一条谱的哈希。

## 未发版修订（第十四批：同源谱降 warn、runlog 键名白名单）

版本仍 `2.8.0`。

- **I1 同源谱降级**（`lib/audit.js`）：`template-copied` 原来对模板自己的来源谱也判 fail —— 同一份谱跑自己的模板，FWHM/峰位本来就不会动，这会把正常复现说成造假。现在先判同源：① `run.json.spectrumSha256` 与模板 `provenance.source_file` 来源谱的哈希一致；② 没有 run 时直接比审计谱与来源谱哈希；③ 都拿不到哈希时用「basename 相同 + 峰位平移 ≈0」兜底。同源 → `warn`，detail 写明「同源谱：模板即由该谱拟合得出，属模板复现（判据：…）」；非同源照搬仍 `fail`。
- **I2 runlog 键名白名单**（`lib/routes.js`）：只认 `files`，此前传 `artifacts` 会被静默忽略并写出空数组。现在顶层键走白名单（`dir`/`files`/`templateId`/`fit`/`result`/`chargeCorrection`/`forced`/`preflight`/`overwrite`/`spectrumSha256`），未知键 400 `unknown-field`，message 列出允许键并点明「产物列表的键名是 files，不是 artifacts」；新增 `spectrumSha256`（64 位十六进制校验），写进 `run.json` 供同源判据使用。
- 自检 130 → 134（I1 / I1b / I1c / I2 四条）；先红三条（旧代码上 I1b、I2 与 I1 全红，I1c 是「非同源仍 fail」的守门断言，旧代码本来就 fail）。
- 两处变异各真红：同源降级关掉（`same !== null` → `false &&`）→ I1/I1b 红；runlog 未知字段不再拒绝 → I2 红。
- **I3 背景口径写死**（`server/xps_fit.py:assess_peaks()`）：`bg` 允许传 `None`，由函数按 `bg_kind`（`shirley`/`linear`）用**与 fit 同源的整谱算法**重算再按 `lo/hi` 切片；传进来的背景数组必须与谱等长，长度不符直接抛错（不补零——补零等于换了一条背景）。docstring 写死口径与实测差（全谱 vs 窗口 Shirley 平均 866 cps）。`build_quality()` 另加长度/端点一致性断言：背景与谱、Background 列与谱都必须同长，否则报「内部错误」而不是算出一套看着像的 R²。
- **I4 文档**：`SKILL.md` / `README.md` 写明「重建模板曲线只能在拟合窗口内算 Shirley、端点取窗口两端；用整谱算实测最大差 1301.75 cps」。
- **I5 文档**：面积回读是系统偏差 2–5%（宽峰尾部更甚，峰 2 FWHM 4.25 时到 5%），不要设成 1% 硬闸；要设就 6% 警告 / 10% 阻断，并在产物里注明「面积以回读值为准」。
- 自检 134 → 135（I3 一条）；先红：旧代码上 I3 直接 `Command failed`（`assess_peaks` 无 `bg_kind`）；两处变异各真红（忽略 `bg_kind` → linear 断言红；删长度校验 → 「list index out of range」）。
- `lib/client.js` 另修一处侧栏空白：`runAudit` 的 `const` 定义在 `const header` 之后，而 header 的「审计这份」按钮先引用它 → 渲染第一步抛 TDZ `ReferenceError`，整页空白。把 `runAudit` 整块移到 `header` 之前（内部改用 `state.selection?.templateId ?? null`）。

## 未发版修订（第十三批：linear 背景在 build 预检里发警告，不当闸）

版本仍 `2.8.0`。

- **两条 linear 警告**（`server/xpspeak_mcp.py:build_quality()`）：`expect_bg == "linear"` 时——① 源谱没有 Background 列（纯两列 ASCII）：warning 写明「直线背景按窗口两端现算、没有独立参照，优度只证明模型自洽，不证明直线适合这条谱；背景呈台阶形请改用 shirley 模板或 file，并用 audit 的 bg-shape 复核」；② 有 Background 列：量该列与窗口弦的最大偏离，超扣背景峰高 0.5% 时把 `cps` 与 `%` 写进 warning，提示换 `shirley`/`file`。两条都**不阻断**——linear 模板配两列 ASCII 是本插件常规用法，堵死正常路径得不偿失。
- **与第九批硬闸的关系（如实说明）**：4 列谱而偏离 >0.5% 时，`preflight` 的 `bg-shape` 硬闸（同阈值、同比较）本来就会报 error 并阻断，所以这一档看到的是「警告带数值 + 老闸阻断」；没有放宽那道闸，runB2 正是靠它 + 残差被拦下的。
- **依据**：第十二批 A 项实测——同一窗口下没有任何指标能把「适用 linear 的模板源谱」与三条台阶谱拉开 ≥10 倍（最好 7.9×），所以不做闸，只把「有没有独立参照」「偏了多少」如实说清。
- 自检 129 → 130（G4：两列谱 warning 文案 + 4 列谱数值 warning 与老闸阻断）；三处变异各真红（两列 warning 不 push / 整块关掉 / 阈值 0.5%→50%）。

## 未发版修订（第十二批：build 复算 fit 门槛、force 留痕；linear 背景判据测量）

版本仍 `2.8.0`。

- **B：build 自己复算 fit 的门槛**（`server/xps_fit.py:assess_peaks()`、`server/xpspeak_mcp.py:build_quality()` + `do_build` 内接线）。以前 fit 把「⛔ 已阻断保存」写进回包，build 照建不误：实测 `E:\文档\deepseek-harness\ceshiqu\out\20261106-ni2p-scan-v2\runB2\runB2_ni2p.xps`（11,379 B，sha256 `06d1db62c2e47094…`）就是被阻断的那组参数建出来的。现在 build 用 `path`+`peaks` 解出模型，按与 fit 完全相同的 `preflight()` 判 R²(扣背景)、四段残差、峰顶缺口；不过就**不驱动 XPSPeak、盘上不留 `.xps`**，文案与 fit 一致。
- **force 与留痕**：只有显式 `force: true` 放行，回包写 `forced: true（未过门槛 N 项）`；`POST /xps/runlog` 的 run 对象新增 `forced` 与 `preflight` 明细，强制放行可事后核对。`.xps`/`.rpa` 源谱读不了谱表，回包明确写「优度预检未执行」。
- **A：linear 背景适用性判据的测量结论**：四条真实谱、同一窗口（845.68–866.90）下，没有任何指标能把「适用的模板源谱」和「不适用的台阶谱」拉开 ≥10 倍——最好的残差倾斜/噪声是 0.31 vs 2.44/2.66（7.9×），`RMS(Shirley−弦)/峰高` 与台阶高度约 2.9×、总面积变化 2.2×；模板源谱自己在 linear↔shirley 下总面积也变 −7.35%，所以它不是物理平背景。结论：linear 只作为「谱自带 Background 列且该列确实是直线」的来源约束使用，默认建议 shirley，硬拦截靠上面的优度复算。
- **背景口径与落盘那份谱一致**：`build_quality()` 默认先按 `window` 裁谱再重取背景端点（与 `do_build` 的 `crop=true` 同口径）。实测反例（runB2 同一组峰参数、`ni2p_cc.dat`）：全谱弦 r²=0.930191/rms=1610.6、窗口弦 r²=0.960379/rms=1215.6，后者与 fit 回包（残差 −73/69/190/−1604、缺口 10.9%）一字不差；用全谱弦会把第 4 段错报成 −1293。断言 G1 里加了弯曲基线夹具钉住这条。
- 自检 126 → 129（G1 数值 + 窗口弦 / G2 接线 / G3 源码顺序与 schema）；三处变异各真红（删 build_quality 调用 → G2/G3；`preflight` 恒 ok → G1；关掉裁谱分支 → G1「裁剪后复算必须用窗口弦」）。

## 未发版修订（第十一批：lastRun、窗口下限、file 背景前置、临时谱清理、stale）

版本仍 `2.8.0`。

- **P1-5 `lastRun` 真有写入者**：`lib/routes.js` 新增 `recordLastRun()`，`use`（成功 `status:'ok'` / 失败 `status:'blocked'` + 原因）、`audit`（`status=verdict`、`r2`）、`runlog`（`status:'delivered'`、`runPath`、`r2`）各写一次。以前 `selection.json` 的 `lastRun` 只有读写定义、全仓没有一个写入者，选择态的「上次跑的结果」永远是 `null`。
- **P1-6 窗口交集设下限**：`useInstruction` 在原「只判交集非空」之外，要求交集宽度 ≥ `max(3×fwhm_max, 5 eV)`，否则 422 `window-too-narrow`，文案写交集宽度与下限。反例：20 eV 拟合区 + 6.5 eV FWHM 的模板，交集 18 eV 也照跑，出来一个没人拦的难看 R²。
- **P1-7 `file` 背景提前拦**：`spectrumRange()` 记 `columns` / `has_background`；`background='file'` + 2 列 ASCII 在 `useInstruction` 出指令前就返回 `background-file-needs-column`（写明读到几列、缺 Background 列），不再等 `server/xps_fit.py` 到拟合中段才报「没有背景列」。
- **P1-8 裁剪谱用完即删**：`bg_plan()` 的临时谱本来就在 `tempfile.gettempdir()`（不落交付目录），`do_build` 建区收尾时再 `os.remove(plan["crop"]["used"])`，不留在临时目录里越攒越多。
- **P2-9 notes 与流程一致**：`useInstruction` 的 notes 现在写明「流程是 fit → build」并禁止 export/save 写同一文件（旧句「也可改用 xpspeak_build…别自己编」在 P0 批已删，本轮加断言钉住）。
- **P2-10 失效选择标 `stale`**：`readSelection()` 校验 `templateId` 对应的 `meta.json` 是否存在，不存在时给 `stale: true` + `stale_reason`；`POST /xps/selection` 回包也走 `readSelection()`（否则写盘对象里没有这两个字段，接口上看不见失效）。
- 自检 120 → 126（E1–E6 六条）；六处变异各真红 1 条（删 runlog 写入 / 关最小宽度闸 / 前置检查恒 false / 不删临时谱 / `stale` 恒 false / notes 加回矛盾说法）。

## 未发版修订（第十批 C+D：建区回读行为断言、步骤补 build、荷电不默认归零、审计传窗口与核凭证）

版本仍 `2.8.0`。

- **C 补真行为断言**：`test/selftest.mjs` 新增一条——伪造 `D.build` 写出 Background 整体 +5000 cps 的导出谱，让 `do_build` 真跑，断言它抛「建区背景与拟合背景不一致」且盘上不留 `.xps`。旧做法只查 `bg_consistency(` 的字符串位置，把那段分支改成 `if False:` 也不会红。
- **P0-1 流程里补上 build**：`lib/routes.js` 的 `steps` 从 `status → open → fit → export → save` 改为 `status → open →（校正前置）→ fit → xpspeak_build`；fit 是纯 Python 拟合、不往 GUI 里加峰，`xpspeak_save` 存的是 GUI 当前状态，「fit → save」只会得到没有峰的 `.xps`。build 的 `peaks` 占位明写用本次 fit 的 `{pos, fwhm, area}`（`gl = eta×100`），不允许把模板里供对照的实测面积塞进去。
- **P0-2 荷电校正不再被静默归零**：`charge_correction_ev` 由 `?? 0` 改回 `?? null`；非 0 时 `fields.charge_correction` 给 `{ev, reference_peak, applied:false}`，并在 `steps` 里插一条 `kind: 'precondition'`（fit 之前）——插件不平移能量，目标谱必须已按参考峰校正，未校正不许往下拟合。
- **P0-3 审计按拟合区切片**：`POST /xps/audit` 之前不传 `window`，40 eV 谱会把 868–878 未建模的 2p1/2 也算进 R²/四段残差。现在：`body.window` 优先、否则模板 `fit_window_ev`，与谱范围取交集；都没有就是整条谱并在回包标 `window_mode: 'full'`；交集为空 422 `window-outside-spectrum`。
- **P0-4 审计核交付凭证**：`auditArtifacts()` 新增 `runPath`，逐条重算 artifact 的 sha256，不一致或文件消失 → `artifacts-modified` fail（写明哪个文件、原/现哈希）；不传或 `run.json` 读不出 → `uncontrolled` warn。以前审计只看文件内部自洽，产物事后被改了也发现不了。
- 自检 116 → 120（C + D1 步骤里必须有 build、D2 charge 不归零、D3 audit 按 window 切片、D4 run.json 哈希）；四处变异各真红 1 条（删 `window` 参数 / 把 build 换回 save / `?? 0` / 关掉哈希比对）。

## 未发版修订（第十批 A+B：背景类型只认 shirley/linear/file，build 按模板选背景）

版本仍 `2.8.0`。

- **移除 `tougaard` 这个空壳类型**：`lib/routes.js` 的 `BACKGROUNDS` 改为 `shirley / linear / file`；`file` 的语义写死为「背景取自目标谱自带的 Background 列，插件不做模型假设」。XPSPeak 的类型下拉虽然有 Tougaard，但插件无法保证兑现，声明了却做不到比不支持更误导。
- **老模板不静默改写历史**：`listTemplates()` 与上传路径读到 `background: 'tougaard'` 时归一成 `file`，返回 `legacy_background: 'tougaard'` 并在 `note` 追加原文「原 background=tougaard，插件无法设置该类型，已按 file 处理…」；`validateTemplate` 直接拒收 `tougaard`。
- **清掉五处 tougaard 特例**：`bgAt()` 的 `t**2` 分支、`mcpBackground()` 兜底、`useInstruction` 的 `bg=file` 警告、`build_guard` 的 `tougaard↔file` 放行、`audit` `bg-shape` 的 skip 文案、UI 展示（改为 `file（谱自带）`）。规则统一成一句：`file` = 用谱自带背景。
- **`xpspeak_build` 按模板选背景类型**：`server/xpspeak_drive.py` 新增 `set_combo()`（`CB_SETCURSEL` + `WM_COMMAND(CBN_SELCHANGE)`），在 Background 对话框的 `ComboBox id=13` 上选 `Shirley/Linear/Tougaard`；`do_build` 传 `bg_type = expect_bg`（`shirley`/`linear`），`file` 不点 Background。真谱实测：`Linear` 产出的背景对两端直线偏离 **0.0%**、默认是 Shirley（7.19%）；此前「选择无效」的结论来自两峰合成谱（背景本来接近直线），不成立。
- **`file` 只配 `.xps`/`.rpa`**：ASCII 源谱没有背景列，`do_build` 在 `D.build` **之前** 直接拒绝，不许先建出来再靠 audit 兜。
- 自检 109 → 116（A① 老模板归一 + note 原文；A② 拒收 tougaard；A③ `file` 提示；A④ `file↔file` 放行、`file↔shirley` 拒绝；B① `bg_type=linear` 真传下去；B② `file`+ASCII 在建区前拒绝）；旧 HEAD 红 6 条，两处变异（关归一、`bg_type` 写回 None）各真红 1 条。

## 未发版修订（第九批：bg-shape 扩到 Shirley 与类型识别）

版本仍 `2.8.0`。

- **Shirley 模板不再整项 skip**：`lib/audit.js` 新增 `shirleyBg()`（与 `server/xps_fit.py:shirley_bg` 同源：12 次迭代、初始值钳在 min/max、高 BE→低 BE 累加），对 `background === 'shirley'` 的模板按文件自己的端点重算，再与 `Background` 列逐点比。对拍：三份实测导出谱（213/401/176 点）JS 与 Python 结果逐点最大差 `0.000e+0`。
- **先量后定阈值**：三份谱的 Shirley 重算最大偏离 25 / 3 / 31 cps = 峰高 0.09% / 0.01% / 0.12%，取 `SHIRLEY_TOL = 0.005`（0.5%，约 4 倍余量）；换类型的偏离是 6.7%–11.3%，量级差 50 倍以上，不会被阈值混淆。
- **类型不符与同类型被改动分开报**：模板声明 shirley、文件是直线 → 报「背景类型不符」并给两侧偏差；同类型被改动 → 报「同类型背景被改动」。`linear` 模板下若文件实际更像 Shirley，同样报类型不符。`tougaard`/`file` 等无法重算的类型 → skip 且 reason 写「不支持该背景类型的重算」。
- 文档：`SKILL.md` 七项检查与第 7 条、`README.md` 校验链一段同步。
- 自检 105 → 109（① Shirley 对 Shirley pass；② Shirley 对直线 fail；③ linear 对 Shirley fail 且点名背景类型；④ tougaard skip 且写不支持）；两处变异均真红。

## 未发版修订（第八批：建区背景口径与拟合统一）

版本仍 `2.8.0`。

- **拟合区背景 ≠ 全谱背景**：`xpspeak_fit` 只在拟合窗口内取 Shirley 端点，XPSPeak 建区按整条谱算 —— 实测 `ni2p_cc.dat`（401 点）窗口 845.68–866.9 内平均差 866 cps，同组参数直接 fit 的 R²=0.9923，经 `xpspeak_build` 建区后审计只剩 0.9682、残差四段全正（+1037/+1227/+883/+58）。
- `server/xpspeak_mcp.py`：新增 `BG_SCOPE_TOL=0.005` / `BG_SCOPE_FLOOR=20.0` 与 `bg_scope_check()` / `crop_to_window()` / `bg_consistency()` / `bg_plan()`；`do_build` 在 `D.build` 之前决定用哪条谱（不一致默认裁到拟合窗口，`crop=false` 抛错），落盘后回读导出谱 Background 再核一道，超差即删 `.xps` 并报 cps 与修法。
- `xpspeak_build` 参数新增 `window` / `crop`（9 个工具名不变）；返回文本写明是否裁谱、裁了多少点、临时谱路径。
- 文档：`SKILL.md` 选择态第 5 条与校验链一节、`README.md` 选择态一段，各写明「建区前先把背景口径统一」。
- 自检 101 → 105（Z7 全谱 vs 拟合区实测 −866 cps；Z8 裁后 213 点、差 <20；Z9 导出谱用全谱背景判失败、用窗口背景判通过；Z10 `crop=false` 拒绝且 `bg_plan` 在 `D.build` 之前）；两处变异均真红。

## 未发版修订（第七批：全 skip 判 insufficient）

版本仍 `2.8.0`。

- **全 skip 不再判 pass**：`lib/audit.js:301-318` 先统计 `{pass, warn, fail, skip}` 四项计数（`summary.counts`），verdict 按 `fail > warn > pass` 降级，三者均为 0 时判 `insufficient` —— 只有 B.E.+强度的 2 列谱五项检查全 skip，以前会输出「通过」，比 fail 更容易被当成已核验。
- 自检 99 → 101（Z5 全 skip → insufficient 且 `counts.skip === 5`；Z6 有实质检查时仍判 pass 且 counts 四项之和等于 checks 数）；两处变异均真红。

## 未发版修订（第六批：交付凭证防覆盖 / 2 列谱可审）

版本仍 `2.8.0`。

- **`POST /xps/runlog` 已存在即 409**：`lib/routes.js` 在 `writeFileSync` 之前检 `run.json`，存在且 `body.overwrite !== true` 时返回 409 `runlog-exists`，响应体带 `run`（旧内容）与 `path`；不会再静默把 `createdAt` 覆盖掉。确要重写必须显式 `overwrite: true`。
- **审计接受 2 列谱**：`lib/audit.js:numericRow` 改为至少 1 列就收下、`parseSpectrum` 记 `columns`；≥2 列即合法（2 列 = B.E.+ 强度，`bg`/`fit` 为 `null`）。`fit-quality` 在无 `Peak Sum` 时判 `skip` 并明写「无背景列」，`bg-shape` 判 `skip`，`peak-gap`/残差不受影响。列数 <2 时报「谱图列数不足（读到 N 列）」，不再把列数问题误报成「行数不足 0 行」。
- 自检 95 → 99（Z1 runlog 409 / Z2 2 列谱 / Z3 3 列缺背景 / Z4 列数报错），三处变异均真红。

`SKILL.md` 正文只保留当前版本号与一行说明；完整历史记在这里（正文顶部原来那条约 1,800 字符的变更行已搬到此文件，避免每次触发都把它载入上下文）。

## 未发版修订（A1–A5 修缺陷 / B1–B3 一键化）

版本仍 `2.8.0`，判据与四步流程未改，只补了「保存前硬前置」与「点一下就出结果」的入口。

- **A1 撞界必须中止**：`server/xps_fit.py:preflight()`、`server/xpspeak_mcp.py:build_guard()`；`xpspeak_build` 在 `D.build()` 之前调 guard，撞界直接抛错、不落 `.xps`；`xpspeak_fit` 文本把 `⛔` 置顶并写明「已阻断保存」。**顺带补掉一个真漏洞**：默认初值 FWHM=1.0 遇到 `wlo=1.5` 时本就在界外，若 LM 一次步进都没接受，`res.bound` 会是空的（越界却不报）——现在初值先 clamp 进 `[lo,hi]`，越界必然被标出。
- **A2 逐峰 eta**：`eta_list()` / `model_at()` / `fit()` 接受标量或长度=nc 的序列；`res.eta_list`、每组分 `eta`、`report()` 逐峰显示；`useInstruction` 逐峰取 `observed.gl_pct/100`，全相等时才退化成标量。
- **A3 背景一致性**：`preflight(bg_used, expect_bg)` 与 `build_guard(expect_bg, actual_bg)` 不一致即拒绝；`tougaard` 不在 `xps_fit` 支持内，按 `file` 处理但必须报警。
- **A4 边界截断**：`_edge_warnings()` 与 `preflight(edge_ratio=3.0)` 对「峰心距谱端 < 3×FWHM」报「尾部被截断，面积只按当前窗口积分」，build 结果前置显示。
- **A5 字段语义**：`doublet_delta_ev` / `charge_correction_ev` 允许 `null`（= 未记录 / 不做双线约束，不再把 `0` 当实测值）；详情表新增「来源」列，四态 `实测 / 约束夹出 / 近似 / 未记录`。
- **B1 选择态**：`lib/routes.js:selectionFile/readSelection/writeSelection` + `GET/POST /xps/selection`（教学档 403、模板不存在 404、`templateId: null` = 取消）；面板主按钮改「选这个」，选中卡片高亮、顶部「已选」条 + 取消选择。
- **B2 说明书**：`SKILL.md` 新增「选择态：用户说『按模板做』→ 一次跑完」一节（不带编号）。
- **B3 向后兼容**：`use` 路由保留，面板「用这个」降为次要按钮；教学档两处禁用 + 服务端 403。
- 自检 57 → 67 项（新增 selection 四条、⑧–⑪ 四条、客户端契约两条）；`sync_skills.py` 仍管 7 个文件。
- **校验链（第一批）**：`preflight` 扩到七条 —— 新增「未优化参数（初值=终值且不在界上，阻断）」「R²<0.85 阻断 / <0.90 警告」「残差四段任一段 >0.5×rms 阻断（系统性偏移）」「峰顶缺口 >10% 阻断 / >5% 警告」「linear 模板下导出谱 Background 列偏离两端直线 >0.5% 峰高 → 阻断（build 侧删掉刚写出的 .xps，不落盘）」。阈值常量与依据见 `SKILL.md`「保存前的校验链」；自检 67 → 72 项（⑫–⑯ 五条）。
- **逐峰 eta 正式化（第二批）**：`peak_windows[].eta`（0–1，可选）进 schema；`useInstruction` 只从这里取逐峰 eta，`observed.gl_pct` 退回纯对照 —— 修掉「代码用 observed 进拟合、文档又说 observed 绝不进拟合」的自相矛盾。老模板没有该字段时回落模板标量（提示写进 notes），不拦。
- **窗口适用性（第二批）**：新增顶层 `applicable_window_ev`（>0，可选）。`POST /xps/templates/<id>/use` 收可选 `spectrumPath`（缺省用选择态里那份），读首列范围；谱窗比模板窄 → 422 `window-too-narrow`（写明两边宽度），够宽放行；读不出范围只给 warnings「未核对」。`lib/routes.js:spectrumRange()` 只读首列、不参与拟合。自检 72 → 77 项（W1–W5）。
- **第三批：审计 / 荷电登记 / run.json**。新增 `lib/audit.js`（只读解析文本导出，七项检查：优度、残差结构、峰顶缺口、背景形状、照搬模板、窗口适用性、边界截断；判据与保存前校验链同源，verdict = pass/warn/fail）。新增 `POST /xps/audit`（`{spectrumPath, peaksPath, templateId}`，坏文件 400、模板不存在 404）与面板「审计这份」；实测那份 176 点 Ni 2p 产物判 fail（残差第二段 1.22×rms、峰顶缺口 10.8%、Background 偏离直线 11.3%、峰位整体平移 −0.896 eV = 照搬模板、窗口 17.5 对 40）。`selection.json` 加 `chargeCorrection` 五字段并在 `POST /xps/selection` 校验（`shift_ev` 必须等于 `target_ev − measured_ev`，否则 400）；缺登记时 `use` 仍 200 但 warnings 点名。新增 `POST /xps/runlog`：在产物目录写 `run.json`（模板 id、fit 参数、r2/rms/撞界/门检查、每个产物 sha256+字节数、时间），教学档 403。自检 77 → 86 项（X1–X9）。
- **窗口闸改 90% 容差**：`applicable_window_ev` 不再要求目标谱窗口 ≥ 模板标定宽度（差 0.2 eV 就判死不合理：同一份 Ni 2p 数据 401 点 884.0→844.0 = 40.000，厂商 Peak Table 自己的拟合区是 883.9→844.1 = 39.8）。现在 `< 90%` 才 422（message 写模板宽度、本次宽度与 90% 下限）；90%–100% 放行并在 `warnings` 写明窄了多少 eV；17.5 对 40 仍判死。
- **R² 改扣背景口径（第四批）**：`lib/audit.js` 的 `fit-quality` 同时算两个口径，闸只认扣背景 —— 同一份 v2 产物按原始计数 0.9152 会判 pass，按 `(Raw−Background)` 对 `(Peak Sum−Background)` 是 0.8683，与 XPSPeak 保存的 0.868272 同刻度。`server/xps_fit.py` 的 `r2` 本来就是扣背景口径（`target = raw − bg`），本次补 `r2_raw` 并回报，`preflight` 两道 R² 判据语义未变、`bound`/`aic` 未动。
- **拟合区 `fit_window_ev`（第五批）**：模板 schema 新增顶层 `fit_window_ev: {lo, hi}`（0–1500、lo<hi，且必须覆盖各峰 `center_ev ± fwhm_max`）；`useInstruction` 真正把 `window: [lo, hi]` 传给 `xpspeak_fit`（与谱范围取交集，无交集 422 `window-outside-spectrum`），闸改成对拟合区宽度判 90%（整数比较），`applicable_window_ev` 降级为「数据够不够长」的提示、不再参与判决；老模板没有该字段时不传 window，但 warnings 必须写「按整条谱拟合、窗口外未建模峰会拉低 R²」。`lib/audit.js` 的 window-applicability 与 R²/残差/峰顶缺口同样按拟合区切片，保证 audit 与 fit 同一口径。起因是实测：Ni 2p 模板的参数在 40 eV 全窗上 R²=0.5869、4 项撞界，收到 844.37–866 后 R²=0.9481、无撞界 —— 868–878 的 2p1/2 峰没建模，一进窗口就把优度拉低并逼峰往边界跑。
- **`validateChargeCorrection(null)` 措辞对齐**：函数接受 `null` 返回 `{ok:true, value:null}`（与路由层「null = 未登记」一致）；容差以代码为准（`> 0.01`，不是 0.005）。
- 自检 86 → 95 项（X11/X11b/X12 三条双口径 + W4/W5 改写 + Y1–Y5 五条拟合区）。

## v2.8.0（未发版）：插件壳 + 模板页

本轮把仓库变成 DSH 插件包，**判据、算法与四步流程一字未改**。版本号写 `package.json`（`2.8.0`：不低于旧线 1.2.2 / 2.7.2，也不暗示算法变化），`SKILL.md` 正文未动。

- **包与壳**：`package.json`（`main: lib/index.js`、`type: module`、`exports["./client"]`、`dsh.bundle.patch`、`dsh.client.inject = ["slots","sidebarRightTabs","sidebarRight"]`）；`files` 列全 `lib/**/*.js` / `cordis.patch.yml` / `server/*.py` / `skills/**` / `README.md` / `test/selftest.mjs`（漏一个就是装完 `ERR_MODULE_NOT_FOUND`，自检里有一条专门核）。`cordis.patch.yml` 用 `- insert:` 形态（裸 list 只会改已有条目，条目不存在是静默空操作），条目 id `xps-peakfit`。
- **三个 py 随包 + 启动同步**：`server/` 放 `xpspeak_mcp.py` / `xpspeak_drive.py` / `xps_fit.py`；`lib/index.js:syncServerFiles()` 与安装位 `~/.dsh/dsh-xps-peakfit/server/` 比 sha256，不一致**以包内为准**覆盖并写一行日志（`旧 → 新`）；包内缺文件时保留安装位不动并如实记 `missing-in-package`。**禁止反向覆盖**。
- **模板页**（`/xps` 路由 + 右侧栏「XPS 模板」标签）：分类 chips → 搜索 → 卡片 → 悬停放大（原生 `div` + `position:fixed`，150 ms 延迟，四周夹 8 px）→ 上传（只收 `.json`、≤256 KB、服务端生成 id）→ 改名（id 不动）→ 收藏 → 删除（同时从收藏剔掉）。**不预置任何模板**。
- **缩略图**：`lib/routes.js:pseudoVoigt` 按模板参数算一条模拟谱拼 SVG（纯标准库，不碰 matplotlib / Origin / MCP），与 `server/xps_fit.py:gl` 同一公式，自检里用 python 对拍；无参数给「无参数」占位，不编谱。
- **「用这个」只产出结构化指令**（模板字段 + 建议调用顺序），交 agent 执行。服务端**从不**调 MCP、不驱动 XPSPeak（自检断言 `lib/*.js` 无 `child_process` / 连接器 API / 工具调用）。
- **档位真源统一**：模板页与 MCP 读同一份 `~/.dsh/dsh-xps-peakfit/mode.json`，语义与 `xpspeak_mcp.py:load_mode()` 一致（缺文件 → env → exec；坏文件 → teach 并写明原因）。教学档下「用这个」按钮禁用，**服务端同样 403**。
- **回环校验**：`/xps/*` 全部要求 Host 与 peer 双回环，否则 403（插件路由不在宿主鉴权墙后面）。
- **自检**：`test/selftest.mjs`（46 项，纯 node 无依赖，只碰临时目录），`node test/selftest.mjs` → `selftest OK: 46 项全过`。

- **修 search_ev 死字段**：`lib/routes.js` 的 `useInstruction` 原来只有 `centers/ds/ratio/wlo/whi/bg`，`search_ev` 上传时校验、进模板、进 notes，却从没传给拟合（实际一直走 `xpspeak_fit` 默认 `ctol=1.0`）。现取各峰 `search_ev` 最大值折成标量 `ctol`，无 `search_ev` 回落 1.0，`fields` 同步带出，notes 写清「只存一个标量」。
- **模板 schema v2（全部可选，老模板照样能用）**：`eta`（0–1，→ `xpspeak_fit.eta`）、`charge_correction_ev`（−20–20，显示）、`reference_peak`（≤40 字）、`provenance`（`source_file`/`points`/`step_ev`/`range_ev`，纯显示）、`peak_windows[].observed`（`center_ev`/`fwhm_ev`/`gl_pct`/`area`/`share_pct`，只作对照，**绝不传给 fit**）。`eta` 是本次最关键一条：三份实测谱主峰 %GL 45–48%、卫星 100%，此前固定 0.3 与实测差一截。
- **缺 eta 的模板给 warnings**：`use` 仍返回 200（老模板不拦），但 `instruction.warnings` 非空（「模板未写 eta，已按 0.3 拟合；实测 %GL 不同的谱请补 eta」）；写了 `eta` 的模板 `warnings` 为空数组。自检 +1 条（⑦）。
- **模板页 UI**：卡片 meta 补 `GL 45%` 与 `校正 +1.2 eV`；点卡片名开详情表（项目 / 模板值 / 实测值三列：峰位、搜索窗口、FWHM 区间、等宽、背景、Δ、%GL、面积占比、校正基准、来源）。
- **自检 +6 条**：`search_ev`→`ctol`、`eta`→`xpspeak_fit.eta`、老模板回落（1.0 / 0.3）、`observed` 不进 fit 参数、详情表两列、schema v2 非法值整条拒绝。①②③⑤⑥ 五条在旧代码上跑红；④ 在旧码上本已通过（`observed` 随 `peak_windows` 透传），防的是将来泄漏。
- **「用这个」的步骤改成真能执行的链**：原实现逐个 `xpspeak_menu {top:"Add Peak"}`（菜单通道不接收位置/宽度，只会建空峰壳）→ 改为 `xpspeak_status` → `xpspeak_open` → `xpspeak_fit`（`centers`/`ds`/`ratio`/`wlo`/`whi`/`bg`）→ `xpspeak_export` → `xpspeak_save`，并新增 `notes` 说明「Add Peak 不接收参数、要手工加壳请在软件里点」与 `search_ev` 是窗口半宽；`tougaard` 背景映射为 `bg=file`。返回键名 `{ok, instruction:{template,name,fields,steps,notes}}` 未改。
- **兼容别名 id/kind 统一**：`COMPAT_ID = COMPAT_KIND = "xps-templates"`（原 `xps/compat` 与 kind 不同字符串，违反「id = kind = 槽位 key」），`guide` 仍为 `null`；主类型 `"xps"` 未动。
- **说明书补模板页一节**：`SKILL.md` 在第 3 步之前新增「模板页与「用这个」的返回值」（无编号标题），写死字段→工具参数映射与「不映射面积/峰高」、`search_ev` 语义、教学档 403、模板不是数据来源。
- **自检 +3 条**：steps 不得含裸 `xpspeak_menu Add Peak`、`fwhm_max` 变化必须带动 fit 的 `whi`、别名 id/kind 同一字符串（三条都对旧代码先跑红）。
- **并入 XPS 全线（仓库结构）**：`skills/xpspeak-automation/`（软件自动化技能：`SKILL.md` + 三个 py 的技能内副本）搬入本仓库；旧仓库 `dsh-xpspeak` 整仓（含 `.git` 与历史）迁到 `legacy/dsh-xpspeak/` 只读留存，外层 `.gitignore` 加 `legacy/`，嵌套仓库不被外层跟踪。
- **脚本路径**：`check_skills.py` 的 `BASE` 换成脚本所在目录（本仓库内自定位），两个 SKILL 路径改指仓库根 `SKILL.md` 与 `skills/xpspeak-automation/SKILL.md`；`sync_skills.py` 源本来就在本仓库，未改。
- **同步脚本扩到两个技能**：`sync_skills.py` 从 3 个文件扩到 7 个（主技能 `SKILL.md` + `references/`，加 `skills/xpspeak-automation/` 的 `SKILL.md` 与三个 py），干净态 `OK=7`；EXTRA 四态保留（副本里多出来的文件照样报红），安装位 `~/.dsh/dsh-xps-peakfit/server/` 明确不归它管。
- **唯一源**：三个 py 以 `server/` 为准，安装位 `~/.dsh/dsh-xps-peakfit/server/` 由插件壳按 sha256 覆盖；`legacy/` 内任何文件（包括其中的 py 与 `skills/`）不再修改。

## 未发版修订（并入 `dsh-xpspeak` 插件前的技能侧准备）

本轮只做「两技能 → 一插件」的准备工作，**判据与算法内容一字未改**；版本号仍为 v2.7.2，待建包轮统一递增。

- **触发词去重**：`XPSPeak` / `XPSPEAK41` 归 `xpspeak-automation` 独占；`XPS 分峰` 归本技能独占；分析类词（`XPS 拟合` / `XPS peak fitting` / `荷电校正` / `charge correction` / `高分辨谱` / `C 1s 校正` / `峰位移`）本技能独占，操作/安装/教学类词归自动化侧独占。
- **双向互指**：`xpspeak-automation` 正文补一行「要判据、门槛与产物契约 → `dsh-xps-peakfit`」；本技能原有的 5 处引用保留（原第 279 行那条是路径引用，不计入互指）。
- **子号改附录**：`五.〇` → 「附录 A：XPSPeak 4.1 执行映射」、`五.一` → 「附录 B：分轮放开与检查点」；正文两处交叉引用与 README 两处同步（历史条目保留原样，不改写）。
- **新增 `check_skills.py`**：触发词交集（精确相等判死）、跨侧子串（只告警）、双向互指、触发词段存在四项检查；返回码 0/1，先在新脚本上跑红再改文本转绿。
- **新增 `sync_skills.py`**：仓库 → `~/.agents/skills/dsh-xps-peakfit` 同步并逐文件核 md5，带 `--check` 只读模式与 `OK/DIFF/MISSING/EXTRA` 四态统计（搬自 `dsh-plot-clone`，只改路径与清单）。

## v2.7.2（2026-11-03 发版）：方法论升级（分轮放开 / 科学边界 / 五段回复）

三块改动：**① 分轮放开与检查点**（五组变量一次只放开一组、不通过回退检查点、四步各一张放开表）；**② 科学边界由 1 条扩到 6 条**（每条带「断言 → 原因 → 怎么判」）；**③ 五段回复格式 + `置信` 枚举补 `未验证`**。四步流程、步骤名与顺序未变，既有门槛一条未放宽。

- **新增「五.一 分轮放开与检查点（四步共用）」**：变量分五组（背景类 / 峰位类 / 峰宽类 / 面积类 / 约束类），**一次只放开一组**，不得跨组混放；不通过 → **回退上一检查点**，不许「再加放开项试试」、不许靠加峰或放宽约束绕过；每轮记一条检查点，字段固定 `轮次 | 放开组 | 初值来源 | 结果 | 残差 | 物理检查 | 通过?`，其中物理检查必须写实际比对值（峰位候选区间 / FWHM 区间 / 双线面积比 vs 2:1 或 3:2 / 峰数与谱上可辨峰一一对应），禁止「看着合理」；阈值与区间一律用户给定，未给定 → 该轮「未核定」不得判通过。本节不新增步骤、不改顺序、不放宽任何既有门槛。
- **四步各自新增「分轮放开」表**（三列固定：本轮允许放开 / 本轮必须固定 / 进入下一步的通过条件）：步骤 1 只放开参考峰 `Position`（必要时含其 `FWHM`）；步骤 2 不放开任何拟合变量（只读判读）；步骤 3 按 背景 → 峰位 → 峰宽 → 面积 → 约束 五轮推进，任一轮不过即回退；步骤 4 不放开任何拟合变量，发现拟合不合格只能退回步骤 3 重做并重过门槛。
- **新增「十一、科学边界」**：由原来的 1 条（`Optimise` 无约束）扩到 6 条，每条按「断言 → 原因 → 怎么判」写，判不了的不写：① 优度变好 ≠ 拟合有效；② 峰数不是越多越好；③ 荷电校正的参考峰必须实测；④ 双线约束不能当自由变量；⑤ 数据不足（低信噪 / 单点峰 / 空谱 / 重叠不可分辨）不下结论；⑥ 背景不自洽时结论无效。
- **新增「结论与建议的回复格式（五段）」**（第四节）：当前证据 / 改什么 / 为什么 / 依据 / 如何判定；**五段缺一段 → 该条 `置信` 取 `未验证`，不得进结论清单**。第九节置信枚举由四值扩为五值（「四值含义」→「五值含义」），并写明「同一结论同时满足两条时取更严的『不足以判定』」。
- **产物同步**：`03` 模板加分轮检查点表，`01` / `02` / `04` 各加一行检查点，`xps_run_record.md` 加「分轮检查点（汇总）」表；第六节 `03` 最小字段与第七节记录项补「分轮检查点」。

## v2.7.1（2026-11-01 发版）：判据整改（原「未发版修订」段；本轮定版为 v2.7.1）

改动只落在判据与产物字段上，四步流程、步骤名与顺序未变。

- **步骤 3 新增「背景–峰自洽」**：规定「定峰 → 重算背景 → 重拟合 → 比对变化」的循环、轮次表与阈值（阈值由用户给定）；重算后的背景曲线必须进 ASCII 交付；写明 Shirley 的适用前提（窗口两端需落在平坦背景、单一平滑损失函数、无未计入强结构）与失效情形（末端落在峰肩上会把信号当背景吃掉）；首次出现 `Shirley` 一词（此前全文 0 命中）。
- **步骤 3 新增「初值与可复现性」**：初值来源必须写明；至少两套不同初值各跑一次，`Position` / `FWHM` 变化 ≤ 用户阈值才判可复现，否则判不可复现且不得进步骤 4。
- **步骤 3 新增「数据充分性前置」**：有效点数下限、峰区 S/N 下限；重叠峰（峰间距/FWHM < 1）必须固定至少一个参数并标「参数强相关」，用户拒绝固定 → 判未通过（参数不可辨识）。
- **步骤 3 门槛新增 4 条**：导入核对（点数/能量首末值/抽点）、数据充分性、背景–峰自洽、初值与可复现性；连同上一轮已有的「优化后回读核对」，门槛从 5 条增至 11 条。
- **步骤 4 可比性判据扩成「约束指纹」**：背景类型 / `%Lorentzian-Gaussian` / `Asymmetry` / `Peak Type`+`S.O.S.` / FWHM 约束 / `Fix` 集合 / 峰数，逐字段一致才判可比；不一致时走「已量化影响 → 可比但标『可比性受限』；未量化 → 不可比」的降级路径（不再一刀切）。
- **步骤 4 判定阈 `k`**：合成规则与 `k` 必须全项目统一并写进 `04` 表头；`k=2` 只作**建议**值，用户未确认 → 标「k 未核定」，相关结论降级为「不足以判定」。
- **步骤 4 峰位不确定度**：从「必须用户提供（阻塞）」改为三级优先口径（用户给定 → 两套初值/重复优化的离散度作 1σ 经验估计 → B 类系统量），后两者一律标「经验，不作统计检验」。
- **残差判据的 σ 有定义**：「峰区外平坦段噪声的相邻点差分稳健估计」或「计数统计 √N」二选一；`k` 由用户给定；无平坦段 → 标「无法估计」并降级。
- **双线峰半高宽**：`默认同 FWHM` 改为「缺省建议值，须用户确认后才写入」（与「不预设参数取值」对齐）。
- **基准参数快照移出正文**：`Io3d` / `Region 5` 那次截图的快照、使用纪律与 #26–#30 待确认项移入 `references/peakfit-baseline-snapshot.md`，并标明「仅当沿用该截图时适用」；`Actual FWHM` 7.064 从基准表移出，降为「未核实读数，不得作为基准或约束」。
- **出图委派包**由 10 条列表改为字段表（字段 / 本 skill 交付内容 / 复刻侧接收要求），供 `dsh-origin-replica` 按表接收。
- **Shirley 端点钉死改为「已复现的定量结论」**：上一轮只写了「据谱峰侧记录、未在仓库内复核，不作数值引用」，现改为机制 + 实测表——`shirley_bg` 在 `a, b = raw[-1], raw[0]` 处把背景两端钉死等于数据值：末端落在峰心时背景被抬到 8100（真背景 100，**81 倍**）、落在 0.25 FWHM 处时**峰面积只剩 12.6%**、≥ 5 FWHM 才基本无损（96.0%）；附只读复现脚本（`Chief/tools/verify_shirley_endpoint.py`，带 assert 门槛，`rc=0`）。同处新增「端点距离判据」：末端到最近峰心的距离必须按 FWHM 记录，**下限由用户给定**，未给定 → 背景前提不成立。
- **步骤 1 新增「参考峰峰位取自拟合峰顶」**：输出项要求写明取得方式（峰型 / 背景 / FWHM / 拟合区间）；注意事项写明「不许目视读数」及理由（`±0.1 eV` 目视误差原样进所有结合能）；只能用目视时必须标「目视读数 ±___ eV」（用户给定），该次校正判**未达合格**，依赖它的位移结论一律「不足以判定」；`01` 模板加「峰位确定方式」与门槛自检项。步骤 1 门槛 3 → 4 条。
- **背景曲线数据提为一等交付件**：第六节交付物清单与交付前自检单列 `<样品>_<轨道>_bg_curves.dat`（列＝B.E. / 原始 / 背景 / 总拟合 / 各分峰），`05_deliverables` 模板单列一行，与「只给最终峰参数、不给背景曲线 = 未交付」的门槛对齐。
- **变更记录搬入本文件**（正文只留版本号与一行索引）。

## v2.7

补两块场景缺口——步骤 3 新增「双线峰成对约束」（p/d/f 的 `S.O.S.` 区间、2:1 / 3:2 面积比、同 FWHM、只按 2p3/2 归属、配对完整性；S 2p 常见窗口仅作核对不作判据），第六节新增「出图委派包」10 项（交给 `dsh-origin-replica` / `origin-plotting` 的固定清单：数据文件、系列表、双线绘制约定、标注文本、轴、页面、禁止项、交付与验收）。

## v2.6

方法评审修复（7 高 + 8 中 + 4 低）——置信字段补「不足以判定」、能量差加下标（`ΔE_CC` / `ΔE_shift`）、门槛缺判据不得豁免、Origin 保存文件条件化、判定阈 `u` 的合成规则、基准快照生效前置、残差/χ²/半定量判定口径、步骤 3 前加 XPSPeak 可用性前置检查。

## v2.5

新增「Origin 收尾纪律」（步骤 3「输出」+ 第六节约定）——出完最后一张 Origin 图要显式收尾，把 Origin 窗口显示出来（`origin_reveal` / `origin_release`）并确认读回，不留看不见的后台实例。

## v2.4

新增出图分工与委派条款（第二节第 7 条、第六节约定）——需要按参考图复刻排版/配色时走 `dsh-origin-replica`，Origin 工具级细节走 `origin-plotting`，本 skill 不另立复刻流程。

## v2.3

成品图默认**不画残差子图**（改在步骤 3「输出」与第六节交付物清单的约定里），**残差判定保留**（步骤 3 门槛 + `03_peakfit_*.md` 拟合质量 + 报告）。

## v2.2

交付物清单（第六节）加入 **XPSPeak 保存文件**（`.xps` / `.rpa`）与 **Origin 保存文件**（工程文件），并要求交付前做「载回校验」。

## v2.1

新增第五.〇节「XPSPeak 4.1 执行映射」与步骤 3 的「基准参数快照（用户框选）」。
