---
name: xpspeak-automation
description: 用 AI/脚本控制 XPSPeak 4.1（XPSPEAK41.exe，XPS 分峰软件）——Win32 消息级自动化 + 自带 MCP server，可装到新电脑、载入谱图、加分峰/扣背景/优化、导出数据与原生 .xps/.rpa。两档：教学模式（只读讲解，不替你点）与代执行（授权范围内一次做完）。触发词：XPSPeak / XPSPEAK41 / 控制 XPS Peak / 把 XPS 分峰装到别的电脑 / 让 AI 操作 XPS 分峰软件 / 教我 XPSPeak / 带我走一遍 XPSPeak / XPSPeak 自动化 / Win32 控制 XPSPeak / xpspeak MCP。
---

# XPSPeak 4.1 自动化：怎么控制它 + 怎么装到别的电脑

本目录同时是**技能**和**MCP server**：SKILL.md 给 AI 看怎么用，三个 .py 是真干活的（纯标准库，无第三方依赖）。

> **分工**：要判据、门槛与产物契约（怎么做分峰、怎么下结论）→ `dsh-xps-peakfit` 技能；本技能只管「怎么操作软件、怎么装到别的电脑」。

- `xpspeak_mcp.py` — MCP server（stdio，9 个工具），任何 MCP 客户端（DSH / Claude Code / Cursor…）都能调
- `xpspeak_drive.py` — 底层 Win32 消息驱动，也可以**不装 MCP 直接用命令行跑**

---

## 〇、两档模式：教学 / 代执行（先判档，再动手）

| 用户说 | 档位 |
|---|---|
| 「教我 / 带我走一遍 / 我想学 / 这一步在哪」 | **教学模式** |
| 「你来做 / 帮我处理完 / 直接出结果」 | **代执行** |
| 没说清 | **先问一句**，别猜 |

切换用 `xpspeak_status(mode="teach"|"exec")`，当前档会写进每次 status 返回。**用户说「你来吧」才切代执行，切的时候先用一句话复述授权范围再动手。**

### 教学模式铁律（服务端硬拦，不靠自觉）

1. **一次只给一小步**：这一步在哪个窗口、哪个菜单、哪个控件；目的是什么；做完怎么判断对了。
2. **说完就停**：等用户回 `done` 或发截图，**不许连续播下一步**。
3. **不许代替用户点击/输入**。教学模式下调 `xpspeak_open / xpspeak_export / xpspeak_save / xpspeak_menu / xpspeak_click / xpspeak_close / xpspeak_build` 会被服务端直接拒绝（`isError` +「教学模式：不替你点按钮 —— 这一步请你操作」+ 具体该点哪里），这是硬拦截，不是提示。
   - 允许的是**只读**：`xpspeak_status`（读进程/窗体/菜单/当前值）、`xpspeak_fit`（纯数值拟合，不碰界面）。**「看」不等于「做」**。
4. **截图只支持可见结论**：截图里读不出的参数值/文件内容，去查项目文件或导出数据，别猜。
5. **卡住超过一轮还没进展** → 主动问「要不要切到代执行模式」。

### 代执行模式

在**用户授权范围内**一次做完，不逐步重复索要许可；但开头要把范围说清楚（哪些文件、哪些谱、能不能覆盖原工程）。中途要扩大范围（换文件、覆盖原 `.xps`、批量跑多张谱）**先问再动**。

### 五段回复格式（凡给结论/建议）

| 段 | 写什么 | 不合格的样子 |
|---|---|---|
| 1 当前证据 | 实测值 / 读回值 / `文件:行号` | 「看起来峰偏宽」 |
| 2 改什么 | 具体动作或建议值 | 「调一下参数」 |
| 3 为什么 | 机制 / 原理 | 「经验上这样好」 |
| 4 依据 | 本 SKILL 行号 / 软件行为 / 实测记录 | 「一般来说」 |
| 5 如何判定 | 改完怎么证明对了：一条命令或一个读数 | 「应该会好一些」 |

**五段缺一段 → 该结论降级为「未验证」，不许当结论用。**
教学模式下这五段就是每一步的骨架：位置（当前证据）→ 目的与原理（为什么）→ 判据（如何判定）。

---

## 一、XPSPEAK41 能怎么控制（选型，别绕远路）

| 方式 | 可行性 | 结论 |
|---|---|---|
| **Win32 消息级自动化**（本技能）| ★★★★★ | **首选**。XPSPeak 是 VB6 程序（表单类 `ThunderRT6FormDC`，按钮 `ThunderRT6CommandButton`），菜单是**真 Win32 菜单** → 可以按菜单**文字**取 id，然后 `PostMessage WM_COMMAND`。不依赖鼠标坐标、DPI、前台焦点，用户在别的窗口打字也不影响 |
| UI Automation / pywinauto | ★★ | VB6 老控件属性暴露极少，反而更绕；还要装第三方库 → 不用 |
| 键鼠模拟（SendInput / 按键精灵 / AutoHotkey）| ★★ | 必须前台 + 固定坐标 + 固定缩放；用户碰一下鼠标就崩 → 只在乱套时兜底 |
| 命令行 / 批处理 | ✗ | XPSPEAK41.exe **没有 CLI**（Readme 里无此说明，实测不带参数启动）；只有 GUI |
| 文件层 | ★★★★ | 数据进出走 ASCII（`Data > Import (ASCII)` / `Export (Spectrum)`）和原生 `.xps` / `.rpa`。**真要批量分峰，用 Python 自己拟合更靠谱**；XPSPeak 用来人工看/存参数/出图 |

一句话：**要 AI 驱动 → MCP + Win32 消息；只想自己点 → 直接开程序。**

---

## 二、装到另一台电脑

### 第 0 步（最快）：一条命令
从 GitHub 拿到仓库后，在仓库根目录：

    "<PYTHON.exe>" install.py

它自动做完「拷文件到技能库 → 找 XPSPEAK41.exe → 打印可直接导入的 mcpServers JSON」，下面第 1、2 步就不用手工了（`--exe/--dest/--json-only` 可覆盖；同目录会落一份 `mcpServers.json`）。

> **不能只给一个 GitHub 链接就装进 MCP**：本 MCP 驱动的是本机 GUI，必须是本机 stdio 进程，不像连接器市场里的托管服务（DSH 市场 109 条全是 `streamable-http`）那样给 URL 即可。所以「GitHub 拿代码 + 本机一条命令注册」是另一台机器上最短的路。

### 前提
- Windows（必须；XPSPeak 只有 Windows 版），已装好 XPSPeak 4.1（`XPSPEAK41.exe`）
- Python 3.8+（**标准库就够**，不需要 pip 装任何东西；DSH 自带 runtime 的 python.exe 也能用）
  - **别直接敲 `python`**：本机裸 `python` 可能是 WindowsApps 存根（退出码 49、零输出，看着像命令没跑），一律用真实 `python.exe` 绝对路径，例如 DSH 自带的 `C:\Users\12576\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe`

### 第 1 步：放文件（整个目录一起拷）
把 `xpspeak-automation/`（含 SKILL.md + 三个 .py）拷到一个**固定不变**的目录，推荐：

    %USERPROFILE%\.agents\skills\xpspeak-automation\

放这儿的好处：DSH 的技能库就是扫这个目录，拷一次 = **技能和 MCP 一起装好**。
（其它客户端没有技能库就放任意固定目录，例如 `D:\tools\xpspeak-automation`。）
记这个目录为 **\<DIR\>**。

### 第 2 步：注册 MCP server
**DSH**：把下面 JSON 交给 `mcp_connector_import_json`（或 UI：设置 → MCP/连接器 → 添加自定义 stdio），把两个 `<...>` 换成真实路径，**JSON 里的反斜杠要写两个** `\\`：

~~~json
{"mcpServers":{"xpspeak":{"command":"<PYTHON.exe 绝对路径>","args":["<DIR>\\xpspeak_mcp.py"],"env":{"XPSPEAK_EXE":"<XPSPEAK41.exe 绝对路径>"}}}}
~~~

**其它客户端**（Claude Code / Cursor / Cherry Studio…）写进各自的 `mcpServers`，形状同上。

> `XPSPEAK_EXE` 是**必须按机器改的旋钮**：代码里的默认路径是作者机器的，别的机器一定不一样。
> 不想写 env 也行 —— 但必须在启动前设好同名环境变量，否则会报 “请设环境变量 XPSPEAK_EXE”。

### 第 3 步：自检（会真开一次 XPSPeak，约 12 秒）

    "<PYTHON.exe>" "<DIR>\xpspeak_mcp.py" --selftest

期望输出：`selftest OK: 9 个工具，initialize/tools-list/fit/status/open/save/export/build/close 全通，导出 N 字节、存 .xps M 字节、生成 .xps K 字节`。
自检用安装包自带的样例谱 `gaas.xps`（与 XPSPEAK41.exe 同目录）。若没有，把 XPSPEAK41.exe 旁边的任意 .xps 拷成 `gaas.xps` 即可。

### 第 4 步：重启客户端
MCP 配置**必须重启客户端才生效**。重启后先调 `xpspeak_status`，能看到 pid + 按钮 + 菜单清单就算通了。

### 磁盘/离线替代
不想装 MCP 也能用，直接命令行：

    "<PYTHON.exe>" xpspeak_drive.py inventory                    # 打印窗口/菜单/控件清单（排查用）
    "<PYTHON.exe>" xpspeak_drive.py export <in.xps> <out.dat>    # 打开谱图 → 导出 ASCII
    "<PYTHON.exe>" xpspeak_drive.py importascii <in.txt> <out.dat>

---

## 三、工具与调用顺序

**要结论**：`xpspeak_fit`（纯 Python，毫秒级，约束内建）→ 参数直接写进论文。
**要交付文件**：`xpspeak_build`（一次调用把同一组参数落成 .xps，不用人点界面）。
**要手工折腾**：`xpspeak_status` → `xpspeak_open` 载谱 → `xpspeak_menu`/`xpspeak_click` → `xpspeak_export`/`xpspeak_save` → `xpspeak_close`。

| 工具 | 干什么 | 关键参数 |
|---|---|---|
| `xpspeak_fit` | 带约束双线拟合，不启动 GUI | `path`；`centers`（各组分主峰初值 eV）；`bg`=file/linear/shirley/none；`ds`（劈裂 ΔBE）；`ratio`（伴线面积比）；`eta`（%L）；`ctol`/`wlo`/`whi`/`hmax`（边界，默认 1.0/0.6/4.0/120000）；`window`（拟合窗口 [lo,hi] eV，Shirley 端点按窗口重取）；`scan`（扫 1..N 条模型）；`csv` |
| `xpspeak_build` | 一次调用生成 .xps（载谱→扣背景→逐个 Add Peak→导出→Save XPS，并回读复核面积） | `path`；`peaks`=[{pos,fwhm,area,gl}]；`out`（.xps）；`spec`/`par`（可选导出）；`bg` |
| `xpspeak_status` | 启动并返回 pid、窗体、按钮、全部菜单项、当前模式。**任何操作前先调它**；也是切模式的入口 | `mode`=teach/exec（省略=只读当前模式） |
| `xpspeak_open` | 载入谱图 | `path`；`source`=auto/xps/ascii（auto 按扩展名：.xps/.rpa 走 Open XPS，其余走 Import (ASCII)） |
| `xpspeak_export` | 导出数据 | `path`；`what`=spectrum（B.E./Raw/Peak Sum/Background/各峰/difference）或 peaks（峰参数表） |
| `xpspeak_save` | 存原生文件 | `path`；`what`=xps（谱图+背景+已定峰，可被 open 原样载回）或 rpa（只存区域峰参数，可套到别的谱） |
| `xpspeak_menu` | 执行任意菜单 | `top`（Data / Parameters / Add Peak / Background / Optimise Region / ReDisplay），`sub`，`settle`（等待秒数，默认 2） |
| `xpspeak_click` | 按标题点按钮 | `caption`（Open XPS / Save XPS / Optimise All / Close / Options / 区域号 1..10），`form`=processing/fit |
| `xpspeak_close` | 关进程（**先校验进程名是 XPSPEAK41.EXE，不是就拒绝**，防止误杀别的 VB6 程序） | `pid`（可选） |

菜单可用项：`Data > Export (Spectrum) / Export (Peak Parameters) / Import (ASCII) / Import (Kratos|Leybold|Phi|VAMAS)`；
`Parameters > Load|Save Region Parameters / Clear Parameters / Delete Region / Region Shift`；
顶层直接是命令：`Add Peak` / `Background` / `Optimise Region` / `ReDisplay`。

### 分峰：为什么用 `xpspeak_fit` 而不是 GUI 的 Optimise

- **Optimise 是无约束的**：实测 MoS₂/S 2p 跑成 162.031（area 69065）+ 163.086（area 11464, FWHM 2.125）——2p₁/₂ 面积只有 1/6、还比主峰窄，物理上不可能；rms 反而更低（444 cps），是"约束缺失被噪声利用"。
- **XPSPeak 把曲线数组存在文件里**，参数只是显示值：改参数不会重算曲线 → 自造 .xps 会出现「参数和曲线对不上」的误导性文件。要交付 .xps 就用 `xpspeak_build`（走 Add Peak 对话框，Area 会被真正采用并重算曲线），**别再点 Optimise**。
- **别用「造 .rpa 再 Load Region Parameters」生成 .xps**：实测首峰 Area 被软件按 height 反算忽略（写 53963 读回 40401.88 = height×FWHM×FK），主峰曲线画小约 25%，文件与参数不自洽。
- `xpspeak_fit` 把约束做进参数化（Δ 固定、面积比固定、双峰等宽），只放 center/FWHM/height —— 这就是可发表版本；放开约束的结果可作为系统误差上界。

回归基准（MoS₂/S 2p，181 点，背景用文件自带 Shirley）：162.059±0.003 eV、FWHM 0.952±0.006、area 80944±698、rms 577.4、R² 0.996822、AIC 2307.8；2/3 条双线对照 543.5/2291.9、506.9/2272.7（追加组分 FWHM 撞上界 → 判为无新化学态）。
（area 的 σ 由旧的 ±518 更正为 ±698：旧公式只算 c/w 两项、漏了 height，σ 偏小；中心值未变。）

---

## 四、实测坑（照抄，都是真机踩过的）

1. **必须 `PostMessage`，不能 `SendMessage`**：BM_CLICK / IDOK 用 SendMessage 会同步等到模态框关闭，遇到异常弹窗直接死锁。
2. **文件对话框填 Edit 再发 IDOK**，不要去点按钮 HWND：Open 对话框的按钮在 DirectUI 里根本没有 HWND（Save 对话框才有 Button id=1）。Edit 的 CtrlID 是 `0x47C`(=1148) 或 `1001`。
3. **传给文件对话框的路径必须是反斜杠形式**（`C:\a\b.dat`）：正斜杠会被 Save 对话框拒绝 → 对话框不关、文件写不出来。
4. **Import (ASCII) 只认 CRLF**：LF-only 文件会被**静默读错**（实测 181 点读成 91 点、B.E. 列变成强度值）。驱动里的 `ascii_crlf()` 会自动做一份 CRLF 副本。
5. **导出成功会弹 “XPSPEAK41 / Data file exported” 模态框**，要顺手点掉才能继续；这类框的确定按钮 **CtrlID=2**，`WM_COMMAND IDOK(1)` 打不掉，必须 `BM_CLICK` 真按钮。
6. **Processing 窗的 “Save XPS” 保存框标题仍然是 “Open file”**（VB6 CommonDialog 的 caption 没改）—— 按标题匹配时别写错。
7. **分峰窗标题会随区域改名**（载入后从 “XPS Peak Fit” 变 “Region 4”）→ 认窗只能靠「有菜单」，不能靠标题。
8. **启动到窗体可用约 4 秒**，驱动里轮询最多 20×0.5 秒等它出现，别刚 Popen 就操作。
9. **stdio 协议纪律**：stdout 只许写 JSON-RPC 行，工具里的 print 全部重定向到 stderr；stdin/stdout 必须 `reconfigure(encoding="utf-8")`（Windows 管道默认 cp936，不设会中文乱码/解码失败）。
10. **Add Peak 对话框的 Area 会被真正采用**（实测要求 53963 → 参数表 53963 → 曲线面积 52977，差 1.8% 是 0.1 eV 粗网格的梯形积分误差）；而 **Load Region Parameters 的 Area 会被忽略**（按 height 反算）。生成 .xps 必须走 Add Peak。
11. **导入失败会弹 `#32770 'XPSPEAK41'` + Static "Error Reading File"**（按钮 CtrlID=2），这个框不点掉，后面的 Background / Add Peak 全不响应（表现成「对话框没出现」）。最常见诱因是 ASCII 行尾不对：`ascii_crlf()` 现在会把 `\r\r\n`、LF、混合行尾统一成 `\r\n`。
12. **XPSPeak 的对话框都是预先建好再 Show 的**（隐藏状态就在窗口树里，标题是 `Region`/`Peak`）→ 等对话框只能比「可见性变化」，不能比「句柄是否新增」。Background 框 Accept 按钮 CtrlID=9（2 是 Optimise，别点错），Add Peak 框 Accept=7、Position=32、FWHM=25、Area=20、%GL=13。
13. 已经有人开着 XPSPeak 也能接管（`find_pid` 找现有窗口），不会另开一个；`xpspeak_close` 是 `taskkill /F`。

---

## 五、排障

| 现象 | 处理 |
|---|---|
| `FileNotFoundError` / “请设环境变量 XPSPEAK_EXE” | 路径不对。设 `XPSPEAK_EXE` 指向真实的 XPSPEAK41.exe（env 或系统环境变量） |
| 工具调用超时/卡住 | 别用 SendMessage 类操作；看有没有没点掉的模态框（`_kill_strays` 就是干这个的） |
| 导出的文件不存在但工具说成功 | 路径写成正斜杠了；或者 Save 对话框没关。检查路径 + 重试 |
| 载入后点数少一半 / X 列变成强度 | ASCII 是 LF 换行，走 `xpspeak_open`（自动 CRLF 化）而不是自己喂给程序 |
| 弹 “Error Reading File” 后所有菜单都没反应 | 先点掉这个框；多半是 ASCII 行尾/列数不对（用 `ascii_crlf()` 或 `xpspeak_open`） |
| 生成的 .xps 曲线比参数小一圈 | 走了 .rpa 载入路径（Area 被忽略）；改用 `xpspeak_build` |
| 菜单命令没反应 | 菜单文字写错（区分 `Export (Spectrum)` 与 `Export (Peak Parameters)`）；用 `xpspeak_status` 打印的菜单清单核对 |
| 客户端里看不到工具 | 配置 JSON 语法错（反斜杠没转义）+ **没重启客户端** |
