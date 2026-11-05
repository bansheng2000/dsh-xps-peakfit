#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""sync_skills.py — 把仓库里两个技能的文件同步到 ~/.agents/skills/

仓库 = 唯一源，技能目录 = 脚本产物，**永不手改副本**（手改会被下次同步静默覆盖，
这正是唯一正确的语义）。漏拷的后果是"副本还是旧版"，而副本才是 DSH 实际读的那份。

管的两个技能：
    dsh-xps-peakfit      SKILL.md + references/                 （3 个文件）
    xpspeak-automation   skills/xpspeak-automation/ 下 4 个文件 （SKILL.md + 三个 py）

**不管安装位** `~/.dsh/dsh-xps-peakfit/server/`：那份由插件壳按 sha256 校验覆盖，
两个通道混在一起会互相打架。

用法：
    py sync_skills.py              # 同步并逐文件核 md5
    py sync_skills.py --apply      # 同上（显式写法）
    py sync_skills.py --check      # 只核对，不写；返回码 0=全一致 / 1=有差异

搬自 dsh-plot-clone/sync_skills.py；OK / DIFF / MISSING / EXTRA 四态统计与返回码
原样保留（EXTRA 抓副本里的历史残留）。
"""
from __future__ import annotations

import argparse
import hashlib
import io
import os
import shutil
import sys

REPO = os.path.dirname(os.path.abspath(__file__))
DEST_ROOT = os.path.expandvars(r"%USERPROFILE%\.agents\skills")

# 每个技能：源根（相对 REPO）、要同步的文件、要整棵同步的子树、目标目录名
SKILLS = [
    {"name": "dsh-xps-peakfit", "src": ".", "files": ["SKILL.md"], "trees": ["references"]},
    {"name": "xpspeak-automation", "src": "skills/xpspeak-automation", "trees": [],
     "files": ["SKILL.md", "xps_fit.py", "xpspeak_drive.py", "xpspeak_mcp.py"]},
]


def rel_norm(p):
    return p.replace("\\", "/")


def md5(path):
    h = hashlib.md5()
    with io.open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def collect(skill):
    """返回 [(目标内相对路径, 源绝对路径)]；缺文件直接报错，不静默跳过。"""
    base = os.path.join(REPO, skill["src"])
    out = []
    for f in skill["files"]:
        src = os.path.join(base, f)
        if not os.path.isfile(src):
            raise SystemExit("缺文件：%s（%s 的清单里有它）" % (src, skill["name"]))
        out.append((rel_norm(f), src))
    for tree in skill["trees"]:
        root = os.path.join(base, tree)
        if not os.path.isdir(root):
            raise SystemExit("缺目录：%s（%s 的清单里有它）" % (root, skill["name"]))
        for dirpath, _dirnames, filenames in os.walk(root):
            for fn in filenames:
                full = os.path.join(dirpath, fn)
                out.append((rel_norm(os.path.relpath(full, base)), full))
    return sorted(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description="同步技能文件到 ~/.agents/skills（带 --check）")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="只核对，不写")
    mode.add_argument("--apply", action="store_true", help="写入（默认行为，显式写法）")
    args = ap.parse_args(argv)

    plan = []  # [(skill_name, dest_dir, rel, src)]
    for skill in SKILLS:
        dest = os.path.join(DEST_ROOT, skill["name"])
        for rel, src in collect(skill):
            plan.append((skill["name"], dest, rel, src))

    print("== sync %d files -> %s\\<技能名>\\%s"
          % (len(plan), DEST_ROOT, "  [check only]" if args.check else ""))

    if not args.check:
        for _name, dest, rel, src in plan:
            dst = os.path.join(dest, rel.replace("/", os.sep))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copyfile(src, dst)

    ok = diff = missing = 0
    for name, dest, rel, src in plan:
        dst = os.path.join(dest, rel.replace("/", os.sep))
        if not os.path.isfile(dst):
            missing += 1
            print("  MISSING %s/%s" % (name, rel))
            continue
        if md5(src) == md5(dst):
            ok += 1
        else:
            diff += 1
            print("  DIFF    %s/%s" % (name, rel))

    extra = []
    for skill in SKILLS:
        dest = os.path.join(DEST_ROOT, skill["name"])
        known = {rel for n, d, rel, _src in plan if n == skill["name"]}
        if not os.path.isdir(dest):
            continue
        for dirpath, _dirnames, filenames in os.walk(dest):
            for fn in filenames:
                full = os.path.join(dirpath, fn)
                rel = rel_norm(os.path.relpath(full, dest))
                if rel not in known:
                    extra.append("%s/%s" % (skill["name"], rel))
    for e in sorted(extra):
        print("  EXTRA   %s" % e)

    print("   OK=%d DIFF=%d MISSING=%d EXTRA=%d" % (ok, diff, missing, len(extra)))
    all_ok = diff == 0 and missing == 0 and not extra
    print("   ALL_MATCH %s" % all_ok)
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
