# -*- coding: utf-8 -*-
"""静默模式（--hidden）单元自检：不碰真窗口，全靠替身验证接线与判据。

跑：py test/hidden_unit.py        → stdout 单行 JSON，{ok:true, checks:[...]}
失败：抛出 AssertionError，退出码 1（selftest 里当一条断言用）。
"""
import json
import os
import sys
import time as _time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "server"))
import xpspeak_drive as D

checks = []


def ok(name, cond, detail=""):
    if not cond:
        raise AssertionError("%s: %s" % (name, detail))
    checks.append(name)


class FakeProc:
    pid = 4321
    hidden_keeper = None

    def terminate(self):
        pass


def test_launch_flags():
    captured = {}

    class FakeKeeper:
        started = False

        def __init__(self, pid, interval=D.HIDE_POLL_S):
            captured["pid"] = pid

        def start(self):
            FakeKeeper.started = True
            return self

    orig_popen, orig_keeper, orig_sleep = D.subprocess.Popen, D.HideKeeper, D.time.sleep

    def fake_popen(argv, **kw):
        captured["kw"] = kw
        return FakeProc()

    try:
        D.subprocess.Popen = fake_popen
        D.HideKeeper = FakeKeeper
        D.time.sleep = lambda s: None
        exe = os.path.abspath(__file__)          # 存在即可，不会真启动
        D.launch(exe, hidden=True)
        si = captured["kw"].get("startupinfo")
        ok("hidden=True 传 STARTUPINFO", si is not None, "startupinfo=%r" % (si,))
        ok("启动时 SW_HIDE", bool(si.dwFlags & D.STARTF_USESHOWWINDOW) and si.wShowWindow == D.SW_HIDE,
           "dwFlags=%s wShowWindow=%s" % (si.dwFlags, si.wShowWindow))
        ok("隐藏线程随 launch 启动、绑该 pid", FakeKeeper.started and captured.get("pid") == 4321)

        captured.clear()
        FakeKeeper.started = False
        D.launch(exe, hidden=False)
        ok("hidden=False 不设 startupinfo", captured["kw"].get("startupinfo") is None)
        ok("hidden=False 不起隐藏线程", not FakeKeeper.started)
    finally:
        D.subprocess.Popen, D.HideKeeper, D.time.sleep = orig_popen, orig_keeper, orig_sleep


def test_poll_once():
    shown = []
    scanned = []

    class ShimU:
        def IsWindowVisible(self, h):
            return h in (201, 203)          # 202 不可见，不该被碰

        def ShowWindow(self, h, cmd):
            shown.append((h, cmd))
            return 1

    def fake_tops(pid):
        scanned.append(pid)
        return [201, 202, 203] if pid == 777 else []

    orig_tops, orig_u = D.tops, D.u
    try:
        D.tops = fake_tops
        D.u = ShimU()
        k = D.HideKeeper(777)
        n = k.poll_once()
        ok("只隐藏可见窗口", [h for h, _ in shown] == [201, 203], "hidden 了 %r" % (shown,))
        ok("隐藏方式是 SW_HIDE", all(cmd == D.SW_HIDE for _, cmd in shown))
        ok("记录 (时间, 句柄)", [h for _, h in k.hidden] == [201, 203] and n == 2)
        ok("只扫自己的 pid", scanned == [777], "scanned=%r" % (scanned,))

        shown.clear()
        ok("别的 pid 一个都不碰", D.HideKeeper(888).poll_once() == 0 and shown == [] and scanned == [777, 888])
    finally:
        D.tops, D.u = orig_tops, orig_u


def test_wait_new_hidden():
    t0 = _time.time() - 10
    classes = {301: "ThunderRT6FormDC", 302: "ThunderRT6FormDC", 303: "ComboLBox",
               304: "ThunderRT6FormDC"}
    menus = {301: 1}                        # 301 = 分峰主窗体（有菜单）

    class ShimU:
        def GetMenu(self, h):
            return menus.get(h, 0)

    class Keeper:
        def __init__(self, hidden):
            self.hidden = hidden

    orig_cls, orig_u, orig_sleep = D.cls, D.u, D.time.sleep
    save_poll = D.HIDE_POLL_S
    try:
        D.cls = lambda h: classes.get(h, "?")
        D.u = ShimU()
        D.HIDE_POLL_S = 0.001
        D.time.sleep = lambda s: None
        k = Keeper([(t0 + 0.1, 301),                     # 主窗体重新 Show：有菜单，要排掉
                    (t0 + 0.2, 302),                     # 真对话框：无菜单
                    (t0 + 0.3, 303)])                    # 组合框弹出列表：类不对
        got = D.wait_new(0, set(), timeout=0.2, keeper=k, since=t0)
        ok("静默态挑无菜单的 VB6 窗体", got == 302, "got=%r" % (got,))

        # 时间闸：只在 since 之后的记录里找（对话框在 settle 期内出现，不能按函数入口时间算）
        old = Keeper([(t0 - 5, 302)])
        ok("since 之前的记录不算新对话框", D.wait_new(0, set(), timeout=0.05, keeper=old, since=t0) is None)
        ok("since=None 时退回函数入口时间",
           D.wait_new(0, set(), timeout=0.05, keeper=Keeper([(t0, 302)]), since=None) is None)
    finally:
        D.cls, D.u, D.time.sleep = orig_cls, orig_u, orig_sleep
        D.HIDE_POLL_S = save_poll


def test_defaults():
    import inspect
    sig = inspect.signature(D.launch)
    ok("launch 签名带 hidden", "hidden" in sig.parameters, str(sig))
    ok("launch hidden 默认 False（不改变 MCP 现有行为）", sig.parameters["hidden"].default is False)
    ok("build 支持 hidden", "hidden" in inspect.signature(D.build).parameters)
    ok("export 支持 hidden", "hidden" in inspect.signature(D.export).parameters)

    import xpspeak_import as I
    sig2 = inspect.signature(I.run_gui)
    ok("导入脚本 run_gui 默认静默", sig2.parameters["hidden"].default is True, str(sig2))


def main():
    test_launch_flags()
    test_poll_once()
    test_wait_new_hidden()
    test_defaults()
    print(json.dumps({"ok": True, "checks": checks}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except AssertionError as e:
        print(json.dumps({"ok": False, "message": str(e), "checks": checks}, ensure_ascii=False))
        sys.exit(1)
