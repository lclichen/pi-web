"""矩阵执行器：并发 4 跑全部用例，产出 JSON + Markdown 报告。

用法：
    python run_matrix.py --config config.json
    python run_matrix.py --config config.json --only host-todo   # 按案例ID前缀过滤
    python run_matrix.py --config config.json --dry-run          # 只列矩阵不执行

报告落在 qa-batch/reports/：batch-qa-<时间戳>.json / .md。
Markdown 里每个用例带会话 URL（?session=<id>），供人工 UI 走查：
plan 面板 / 待办勾选 / 子智能体嵌套与右面板 viewer / MCP 工具卡片。
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as _dt
import json
import os
import sys
import time
import traceback
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from piweb_client import (  # noqa: E402
    ApiError,
    BatchTransport,
    SessionTransport,
    batch_tool_names,
    context_tool_names_and_texts,
)
from testcases import Case, build_matrix  # noqa: E402


@dataclass
class CaseResult:
    case: Case
    state: str = "pending"          # pass | fail | error | skip
    checks: List[Dict[str, Any]] = field(default_factory=list)
    session_id: Optional[str] = None
    task_id: Optional[str] = None
    duration_s: float = 0.0
    final_text: str = ""
    error: str = ""
    usage: Optional[dict] = None


# ---------------------------------------------------------------- 执行

def run_batch_case(case: Case, cfg: dict, batch: BatchTransport,
                   session: Optional[SessionTransport]) -> CaseResult:
    r = CaseResult(case=case)
    t0 = time.monotonic()
    body: Dict[str, Any] = {
        "mode": case.mode,
        "prompt": case.prompt,
        "timeoutMs": int(cfg.get("task_timeout_s", 900)) * 1000,
    }
    if case.mode == "host":
        body["workDir"] = case.work_dir
        if case.files:
            body["files"] = case.files
    if case.mode == "sandbox":
        body["containerId"] = case.container_id
    if case.model:
        body["model"] = case.model
    if case.thinking_level:
        body["thinkingLevel"] = case.thinking_level

    r.task_id = batch.submit(body)
    summary = batch.wait(r.task_id, timeout_s=int(cfg.get("task_timeout_s", 900)) + 120,
                         interval_s=float(cfg.get("poll_interval_s", 5)))
    result = batch.result(r.task_id)
    r.duration_s = round(time.monotonic() - t0, 1)
    r.session_id = result.get("sessionId") or ""
    r.usage = result.get("usage")
    r.final_text = str(result.get("finalResponse") or "")[:2000]

    r.state = "pass"
    r.checks.append({"name": "task-state",
                     "ok": summary.get("state") == "completed",
                     "detail": f"state={summary.get('state')} stopReason={summary.get('stopReason')} err={summary.get('error')}"})
    if summary.get("state") != "completed":
        r.state = "fail"
    r.checks.append({"name": "final-response-nonempty",
                     "ok": len(r.final_text.strip()) > 0,
                     "detail": r.final_text[:120]})
    if not r.final_text.strip():
        r.state = "fail"

    tools = batch_tool_names(result)
    _check_tools(r, tools)
    _check_texts(r, [r.final_text])
    if case.feature == "subagent":
        # batch host 会话落 cwd-slug 布局（sessions/--<cwd>--/），该布局不被
        # /api/sessions 扫描——子会话嵌套无法用列表断言，记为信息项；
        # session 传输（ssh/local）用例在 users/u1 分片，列表断言有效。
        r.checks.append({"name": "child-session-listed", "ok": True,
                         "detail": "batch 布局不经列表扫描（工具日志已含 Agent）；嵌套/UI 走查见 session 传输用例"})
    if any(not c["ok"] for c in r.checks):
        r.state = "fail" if r.state == "pass" else r.state
    if r.state == "pass":
        r.state = "pass" if all(c["ok"] for c in r.checks) else "fail"
    return r


def run_session_case(case: Case, cfg: dict, session: SessionTransport) -> CaseResult:
    r = CaseResult(case=case)
    t0 = time.monotonic()
    new_body: Dict[str, Any] = {"mode": case.mode, "type": "ensure_session"}
    if case.project_id:
        new_body["projectId"] = case.project_id
    if case.template_id:
        new_body["templateId"] = case.template_id
    r.session_id = session.ensure_session(new_body)
    session.prompt(r.session_id, case.prompt, model=case.model, thinking=case.thinking_level)
    session.wait_settled(r.session_id, timeout_s=int(cfg.get("task_timeout_s", 900)),
                         interval_s=float(cfg.get("poll_interval_s", 5)))
    time.sleep(2)
    ctx = session.context(r.session_id)
    tools, texts = context_tool_names_and_texts(ctx)
    r.duration_s = round(time.monotonic() - t0, 1)
    r.final_text = (texts[-1] if texts else "")[:2000]

    r.state = "pass"
    r.checks.append({"name": "assistant-reply", "ok": bool(r.final_text.strip()),
                     "detail": r.final_text[:120]})
    if not r.final_text.strip():
        r.state = "fail"
    _check_tools(r, tools)
    _check_texts(r, texts)
    if case.feature == "subagent":
        _check_child_session(r, session)
    if not all(c["ok"] for c in r.checks):
        r.state = "fail"
    return r


def _check_tools(r: CaseResult, tools: List[str]) -> None:
    if not r.case.expect_tools:
        r.checks.append({"name": "tools-any", "ok": len(tools) > 0,
                         "detail": f"tools={tools[:12]}"})
        return
    # expect_tools 是同义候选（read/bash/ls、Agent/agent）——任一命中即过
    joined = " ".join(tools)
    ok = any(expect.lower() in joined.lower() for expect in r.case.expect_tools)
    r.checks.append({"name": "tool:" + "|".join(r.case.expect_tools), "ok": ok,
                     "detail": f"tools={tools[:12]}"})


def _check_texts(r: CaseResult, texts: List[str]) -> None:
    joined = " ".join(texts)
    for expect in r.case.expect_text:
        r.checks.append({"name": f"text:{expect}", "ok": expect in joined,
                         "detail": joined[:120]})


def _check_child_session(r: CaseResult, session: SessionTransport) -> None:
    """子智能体用例：会话列表应存在 parentSessionId 指向本会话的子会话。"""
    try:
        children = [s for s in session.sessions_flat()
                    if (s.get("parentSessionId") == r.session_id)
                    or ((s.get("relation") or {}).get("kind") == "subagent"
                        and (s.get("relation") or {}).get("parentSessionId") == r.session_id)]
        r.checks.append({"name": "child-session-listed", "ok": len(children) > 0,
                         "detail": f"children={[c.get('id') for c in children][:3]}；"
                                   f"（UI 走查：应嵌套显示 + 可开右面板 viewer）"})
    except Exception as e:  # noqa: BLE001
        r.checks.append({"name": "child-session-listed", "ok": False, "detail": f"查询失败: {e}"})


def execute(case: Case, cfg: dict, batch: Optional[BatchTransport],
            session: Optional[SessionTransport]) -> CaseResult:
    try:
        if case.transport == "batch":
            assert batch is not None, "batch 传输未配置（缺 platform_api_key）"
            return run_batch_case(case, cfg, batch, session)
        assert session is not None, "session 传输未配置（缺 web 账号）"
        if not session.cookie:
            session.login()
        return run_session_case(case, cfg, session)
    except (ApiError, TimeoutError, AssertionError) as e:
        return CaseResult(case=case, state="error", error=str(e))
    except Exception:  # noqa: BLE001
        return CaseResult(case=case, state="error", error=traceback.format_exc(limit=4))


# ---------------------------------------------------------------- 报告

def write_reports(results: List[CaseResult], cfg: dict, out_dir: str) -> tuple:
    os.makedirs(out_dir, exist_ok=True)
    stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    base_url = cfg.get("base_url", "")

    payload = {
        "generated_at": _dt.datetime.now().isoformat(timespec="seconds"),
        "base_url": base_url,
        "concurrency": cfg.get("concurrency", 4),
        "summary": _summary(results),
        "cases": [{
            "case_id": r.case.case_id,
            "mode": r.case.mode,
            "transport": r.case.transport,
            "feature": r.case.feature,
            "model": r.case.model,
            "thinking_level": r.case.thinking_level,
            "state": r.state,
            "session_id": r.session_id,
            "task_id": r.task_id,
            "duration_s": r.duration_s,
            "checks": r.checks,
            "final_text": r.final_text,
            "usage": r.usage,
            "error": r.error,
            "ui_url": f"{base_url}/?session={r.session_id}" if r.session_id else None,
        } for r in results],
    }
    json_path = os.path.join(out_dir, f"batch-qa-{stamp}.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    s = payload["summary"]
    lines = [
        "# pi-web 批量 QA 报告",
        "",
        f"- 时间：{payload['generated_at']} ｜ 服务：{base_url} ｜ 并发：{payload['concurrency']}",
        f"- 结果：**{s['pass']} 通过 / {s['fail']} 失败 / {s['error']} 错误 / {s['skip']} 跳过**",
        "",
        "| 用例 | 模式 | 功能 | 模型 | 思考 | 结果 | 耗时 | 会话（UI 走查） |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for c in payload["cases"]:
        model = (c["model"] or {}).get("modelId", "-")
        url = f"[打开]({c['ui_url']})" if c["ui_url"] else "-"
        lines.append(
            f"| `{c['case_id']}` | {c['mode']} | {c['feature']} | {model} | "
            f"{c['thinking_level'] or '-'} | {c['state'].upper()} | {c['duration_s']}s | {url} |"
        )
    lines += ["", "## 失败/错误详情", ""]
    for c in payload["cases"]:
        if c["state"] in ("fail", "error"):
            lines.append(f"### {c['case_id']} — {c['state']}")
            if c["error"]:
                lines.append(f"- 错误：`{c['error'][:300]}`")
            for chk in c["checks"]:
                if not chk["ok"]:
                    lines.append(f"- ✗ {chk['name']}：{chk['detail']}")
            lines.append("")
    lines += [
        "## UI 走查清单（人工）",
        "",
        "| 功能 | 检查点 |",
        "|---|---|",
        "| plan | 打开对应会话：左侧/顶部计划面板可见，计划内容与汇报一致 |",
        "| todo | 待办清单渲染为可勾选列表，全部呈完成态 |",
        "| 子智能体 | 侧栏子会话嵌套在父会话下（⌘ 标记）；Agent 卡片可开右面板 viewer |",
        "| MCP | 工具调用卡片显示 MCP 工具名与原始返回 |",
        "| 通用 | 各模式会话分组正确（Host/沙盒/SSH/本地徽标），无“未知来源”堆积 |",
    ]
    md_path = os.path.join(out_dir, f"batch-qa-{stamp}.md")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return json_path, md_path


def _summary(results: List[CaseResult]) -> dict:
    out = {"pass": 0, "fail": 0, "error": 0, "skip": 0}
    for r in results:
        out[r.state if r.state in out else "error"] += 1
    return out


# ---------------------------------------------------------------- 入口

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--only", help="按 case_id 子串过滤（逗号分隔多个）")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    with open(args.config, encoding="utf-8") as f:
        cfg = json.load(f)

    cases = build_matrix(cfg)
    if args.only:
        keys = [k.strip() for k in args.only.split(",") if k.strip()]
        cases = [c for c in cases if any(k in c.case_id for k in keys)]

    print(f"矩阵：{len(cases)} 个用例；并发 {cfg.get('concurrency', 4)}")
    for c in cases:
        print(f"  - {c.case_id:36s} [{c.transport}] {c.feature:9s} model={(c.model or {}).get('modelId', '-')}")
    if args.dry_run or not cases:
        return 0

    # 先建 web 会话（session 传输 + batch 的 cookie 调试通道都要它）
    session = None
    web = cfg.get("web", {})
    if web.get("username") and not str(web.get("password", "")).startswith("REPLACE"):
        session = SessionTransport(cfg["base_url"], web["username"], web["password"])
        try:
            session.login()
            print(f"✔ web 登录成功（{web['username']}）")
        except Exception as e:  # noqa: BLE001
            print(f"⚠ web 登录失败（session 用例将报错）：{e}")
            session = None

    batch = None
    key = cfg.get("batch", {}).get("platform_api_key", "")
    cookie_for_batch = session.cookie if session else None
    if key.startswith("sk_"):
        batch = BatchTransport(cfg["base_url"], platform_api_key=key)
    elif cookie_for_batch:
        # 服务端接受 web cookie 调试 batch API（batch-auth.ts）；CI 请用 API key
        batch = BatchTransport(cfg["base_url"], web_cookie=cookie_for_batch)
        print("⚠ 未配置 platform_api_key，用 web 会话 cookie 走 batch API（调试模式）")

    results: List[CaseResult] = []
    t0 = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(max_workers=int(cfg.get("concurrency", 4))) as pool:
        futs = {pool.submit(execute, c, cfg, batch, session): c for c in cases}
        for fut in concurrent.futures.as_completed(futs):
            r = fut.result()
            results.append(r)
            mark = {"pass": "✔", "fail": "✗", "error": "!", "skip": "-"}.get(r.state, "?")
            print(f"{mark} {r.case.case_id:36s} {r.state.upper():5s} {r.duration_s:7.1f}s "
                  f"sid={r.session_id or '-'}")
    results.sort(key=lambda r: r.case.case_id)

    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reports")
    json_path, md_path = write_reports(results, cfg, out_dir)
    s = _summary(results)
    print(f"\n完成（{round(time.monotonic() - t0)}s）：{s['pass']} 通过 / {s['fail']} 失败 / {s['error']} 错误 / {s['skip']} 跳过")
    print(f"报告：{md_path}\n      {json_path}")
    return 0 if (s["fail"] == 0 and s["error"] == 0) else 1


if __name__ == "__main__":
    raise SystemExit(main())
