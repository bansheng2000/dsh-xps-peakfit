#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""check_skills.py — 技能路由自检（触发词去重 + 双向互指）

为什么必须有这个脚本而不是靠文档自觉：`description` 是技能路由的唯一输入，没人会
逐字读它。三个触发词（`XPSPeak` / `XPSPEAK41` / `XPS 分峰`）曾经两个技能都挂着，
过了三轮人工审计、两次发版，没人发现——自觉已被证伪。

用法：
    py check_skills.py          # 返回码 0=全过 / 1=有 FAIL

检查项：
  C1 两个 description 的「触发词：」词条，归一化后集合求交 → 非空即 FAIL
  C2 跨侧子串包含（"XPS 分峰" ⊂ "把 XPS 分峰装到别的电脑"）→ 只 WARN，不影响返回码
  C3 双向互指：每个 SKILL.md 全文须出现对方技能名 ≥1 次 → 缺即 FAIL
  C4 「触发词：」段存在且切出 ≥3 项 → 否则 FAIL

C1 只判「精确相等」而不判子串：自动化侧词条天然含 `XPSPeak`（如「教我 XPSPeak」），
按子串判会永远 red，人最后会把检查关掉——检查被关掉就等于没有。

两个技能现在同在本仓库：`SKILL.md`（四步 SOP）与 `skills/xpspeak-automation/SKILL.md`（软件自动化）。
新增第三个技能时，在下面的 SKILLS 表里加一行即可（路径 + 技能名 + 对方技能名）。
"""
from __future__ import annotations

import io
import os
import sys

try:  # Windows 控制台默认 GBK，会把中文与符号打成乱码/直接抛 UnicodeEncodeError
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

REPO = os.path.dirname(os.path.abspath(__file__))
SKILLS = [
    {"name": "dsh-xps-peakfit", "other": "xpspeak-automation",
     "path": os.path.join(REPO, "SKILL.md")},
    {"name": "xpspeak-automation", "other": "dsh-xps-peakfit",
     "path": os.path.join(REPO, "skills", "xpspeak-automation", "SKILL.md")},
]
KEY = "触发词："
MIN_TRIGGERS = 3


def read(path):
    with io.open(path, "r", encoding="utf-8", newline="") as fh:
        return fh.read()


def get_description(text):
    """取 frontmatter 里的 description 行（本仓两技能都是单行）。"""
    lines = text.split("\n")
    if not lines or lines[0].strip().rstrip("\r") != "---":
        return ""
    for ln in lines[1:]:
        s = ln.rstrip("\r")
        if s.strip() == "---":
            break
        if s.startswith("description:"):
            return s[len("description:"):].strip()
    return ""


def get_triggers(desc):
    if KEY not in desc:
        return None
    raw = desc.split(KEY, 1)[1]
    return [t.strip().strip("。.，,") for t in raw.split("/") if t.strip()]


def norm(t):
    return "".join(t.split()).lower()


def main():
    fails, warns = [], []
    info = []
    for s in SKILLS:
        if not os.path.isfile(s["path"]):
            fails.append("C0 missing-file: %s" % s["path"])
            info.append((s, "", None, None))
            continue
        text = read(s["path"])
        desc = get_description(text)
        trig = get_triggers(desc)
        info.append((s, desc, trig, text))
        if not desc:
            fails.append("C4 description-missing: %s 无 frontmatter description" % s["name"])
        elif trig is None:
            fails.append("C4 trigger-block-missing: %s 的 description 无「%s」段" % (s["name"], KEY))
        elif len(trig) < MIN_TRIGGERS:
            fails.append("C4 trigger-block-thin: %s 只有 %d 项触发词（< %d）"
                         % (s["name"], len(trig), MIN_TRIGGERS))

    # C1 触发词交集 / C2 跨侧子串
    if len(info) == 2 and all(x[2] for x in info):
        (s1, _d1, t1, _x1), (s2, _d2, t2, _x2) = info
        n1 = {norm(t): t for t in t1}
        n2 = {norm(t): t for t in t2}
        inter = sorted(set(n1) & set(n2))
        if inter:
            fails.append("C1 trigger-overlap: " + ", ".join(n1[k] for k in inter))
            for s, _d, t, _x in info:
                print("  %s:%s" % (s["name"], os.path.basename(s["path"])))
                print("      触发词 = " + " | ".join(t))
            print("  → 裸词只能一侧持有；分配表见 docs/trigger-ownership.md")
        for k1, o1 in n1.items():
            for k2, o2 in n2.items():
                a, b = " ".join(o1.lower().split()), " ".join(o2.lower().split())
                if a != b and len(min(a, b, key=len)) >= 3 and (a in b or b in a):
                    warns.append('C2 substring: %s "%s" in %s "%s"（可接受）'
                                 % (s1["name"], o1, s2["name"], o2))

    # C3 双向互指
    for s, _d, _t, text in info:
        if text is None:
            continue
        if s["other"] not in text:
            fails.append("C3 cross-pointer-missing: %s 未出现 \"%s\""
                         % (s["name"], s["other"]))
            print("  → %s 须有一行互指，例：要判据与产物契约 → `%s`" % (s["name"], s["other"]))

    for w in warns:
        print("WARN " + w)
    for f in fails:
        print("FAIL " + f)
    print("  FAILS=%d WARNS=%d" % (len(fails), len(warns)))
    print("  ALL_PASS %s" % (not fails))
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
