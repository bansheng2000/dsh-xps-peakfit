#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""sync_skills.py — 把仓库里的技能文件同步到 ~/.agents/skills/dsh-xps-peakfit

仓库 = 唯一源，技能目录 = 脚本产物，**永不手改副本**（手改会被下次同步静默覆盖，
这正是唯一正确的语义）。漏拷的后果是"副本还是旧版"，而副本才是 DSH 实际读的那份。

用法：
    py sync_skills.py              # 同步并逐文件核 md5
    py sync_skills.py --check      # 只核对，不写；返回码 0=全一致 / 1=有差异

搬自 dsh-plot-clone/sync_skills.py，只改了 DEST / FILES / TREES 与排除规则；
OK / DIFF / MISSING / EXTRA 四态统计与返回码原样保留（EXTRA 抓副本里的历史残留）。
"""
from __future__ import annotations

import argparse
import hashlib
import io
import os
import shutil
import sys

REPO = os.path.dirname(os.path.abspath(__file__))
DEST = os.path.expandvars(r"%USERPROFILE%\.agents\skills\dsh-xps-peakfit")

# 仓库根下的技能文件（脚本自己、README、docs 不进副本：它们是仓库资料，不是技能内容）
FILES = ["SKILL.md"]

# 整棵子树同步
TREES = ["references"]

EXCLUDE_DIRS = []
EXCLUDE_SUFFIXES = []
SKIP_EXT = set()


def rel_norm(p):
    return p.replace("\\\\", "/")


def excluded(rel):
    r = rel_norm(rel)
    for d in EXCLUDE_DIRS:
        if r == d or r.startswith(d + "/"):
            return True
    base, ext = os.path.splitext(r)
    if ext.lower() in SKIP_EXT:
        return True
    return False


def collect():
    out = []
    for f in FILES:
        src = os.path.join(REPO, f)
        if os.path.isfile(src):
            out.append((f, src))
    for tree in TREES:
        root = os.path.join(REPO, tree)
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames
                           if not excluded(rel_norm(os.path.join(dirpath, d)) + "/")]
            for fn in filenames:
                full = os.path.join(dirpath, fn)
                rel = rel_norm(os.path.relpath(full, REPO))
                if excluded(rel):
                    continue
                out.append((rel, full))
    return sorted(out)


def md5(path):
    h = hashlib.md5()
    with io.open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main(argv=None):
    ap = argparse.ArgumentParser(description="同步技能文件到 ~/.agents/skills（带 --check）")
    ap.add_argument("--check", action="store_true", help="只核对，不写")
    args = ap.parse_args(argv)

    items = collect()
    print("== sync %d files -> %s%s"
          % (len(items), DEST, "  [check only]" if args.check else ""))

    if not args.check:
        os.makedirs(DEST, exist_ok=True)
        for rel, src in items:
            dst = os.path.join(DEST, rel.replace("/", os.sep))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copyfile(src, dst)

    ok = diff = missing = 0
    for rel, src in items:
        dst = os.path.join(DEST, rel.replace("/", os.sep))
        if not os.path.isfile(dst):
            missing += 1
            print("  MISSING %s" % rel)
            continue
        if md5(src) == md5(dst):
            ok += 1
        else:
            diff += 1
            print("  DIFF    %s" % rel)

    extra = []
    known = {r for r, _ in items}
    for dirpath, _dirnames, filenames in os.walk(DEST):
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            rel = rel_norm(os.path.relpath(full, DEST))
            if rel not in known:
                extra.append(rel)
    for e in sorted(extra):
        print("  EXTRA   %s" % e)

    print("   OK=%d DIFF=%d MISSING=%d EXTRA=%d" % (ok, diff, missing, len(extra)))
    all_ok = diff == 0 and missing == 0 and not extra
    print("   ALL_MATCH %s" % all_ok)
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
