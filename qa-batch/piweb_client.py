"""pi-web QA 批量测试 HTTP 客户端（纯标准库）。

两种传输：
  BatchTransport   —— /api/batch/tasks（host / sandbox 模式；X-Platform-API-Key 认证）
  SessionTransport —— /api/webauth/login + /api/agent/*（ssh / local-machine / quick
                      模式——batch API 尚不支持它们，走标准会话 API 等价覆盖）

契约参照：app/api/batch/tasks/route.ts、lib/batch/task-store.ts、
app/api/agent/new/route.ts（以仓库实现为准）。
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

TERMINAL_STATES = {"completed", "failed", "cancelled"}


class ApiError(Exception):
    def __init__(self, status: int, message: str, body: Any = None):
        super().__init__(f"HTTP {status}: {message}")
        self.status = status
        self.body = body


@dataclass
class HttpResponse:
    status: int
    body: Any
    headers: Dict[str, str] = field(default_factory=dict)


def http_json(
    method: str,
    url: str,
    payload: Optional[dict] = None,
    headers: Optional[Dict[str, str]] = None,
    timeout: int = 60,
    retries: int = 1,
) -> HttpResponse:
    """JSON POST/GET with one retry on transport errors (poll 抖动容忍)."""
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    base_headers = {"Content-Type": "application/json; charset=utf-8"}
    # 注意：不要发送 Origin / sec-fetch-site —— 服务端 isApiRequestAllowed
    # 只在带这些头时做同源校验，程序化调用不带即放行。
    if headers:
        base_headers.update(headers)
    last_err: Optional[Exception] = None
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, data=data, headers=base_headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
                body: Any = raw
                try:
                    body = json.loads(raw) if raw else None
                except json.JSONDecodeError:
                    pass
                return HttpResponse(resp.status, body, dict(resp.headers))
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", errors="replace")
            try:
                body = json.loads(raw) if raw else raw
            except json.JSONDecodeError:
                body = raw
            # 5xx 重试一次；4xx 是确定性的请求问题，直接抛
            if e.code >= 500 and attempt < retries:
                last_err = ApiError(e.code, str(body), body)
                time.sleep(2)
                continue
            raise ApiError(e.code, str(body)[:500], body)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if attempt < retries:
                last_err = e
                time.sleep(2)
                continue
            raise
    raise ApiError(0, f"transport failure: {last_err}")


# ---------------------------------------------------------------- batch API

class BatchTransport:
    """host / sandbox 模式：X-Platform-API-Key（sk_…，管理员密钥）。"""

    def __init__(self, base_url: str, platform_api_key: Optional[str] = None,
                 web_cookie: Optional[str] = None):
        """API key（推荐，CI）或 web 会话 cookie（服务端也接受，调试便利）。"""
        self.base = base_url.rstrip("/")
        if platform_api_key:
            self.headers = {"X-Platform-API-Key": platform_api_key}
        elif web_cookie:
            self.headers = {"Cookie": f"pi_web_sid={web_cookie}"}
        else:
            raise ValueError("BatchTransport 需要 platform_api_key 或 web_cookie")

    def submit(self, body: dict) -> str:
        res = http_json("POST", f"{self.base}/api/batch/tasks", body, self.headers, timeout=30)
        if res.status != 202 or not isinstance(res.body, dict) or "taskId" not in res.body:
            raise ApiError(res.status, f"unexpected submit response: {res.body}")
        return res.body["taskId"]

    def poll(self, task_id: str) -> dict:
        res = http_json("GET", f"{self.base}/api/batch/tasks/{task_id}", headers=self.headers, timeout=30)
        if not isinstance(res.body, dict):
            raise ApiError(res.status, "non-json task summary")
        return res.body

    def wait(self, task_id: str, timeout_s: int, interval_s: float = 5.0) -> dict:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            summary = self.poll(task_id)
            if summary.get("state") in TERMINAL_STATES:
                return summary
            time.sleep(interval_s)
        raise TimeoutError(f"batch task {task_id} not terminal after {timeout_s}s (state={summary.get('state')})")

    def result(self, task_id: str) -> dict:
        # 仅终态可取；409 = 还在跑（调用方先 wait）
        res = http_json("GET", f"{self.base}/api/batch/tasks/{task_id}/result", headers=self.headers, timeout=60)
        return res.body if isinstance(res.body, dict) else {"raw": res.body}


# ---------------------------------------------------------------- session API

class SessionTransport:
    """ssh / local-machine / quick 模式（batch API 未支持）+ 会话侧证物查询。"""

    def __init__(self, base_url: str, username: str, password: str):
        self.base = base_url.rstrip("/")
        self.username = username
        self.password = password
        self.cookie: Optional[str] = None

    def login(self) -> None:
        res = http_json(
            "POST",
            f"{self.base}/api/webauth/login",
            {"username": self.username, "password": self.password},
            timeout=30,
        )
        set_cookie = res.headers.get("Set-Cookie", "") or res.headers.get("set-cookie", "")
        sid = None
        for part in set_cookie.split(";"):
            if part.strip().startswith("pi_web_sid="):
                sid = part.strip().split("=", 1)[1]
        if res.status != 200 or not sid:
            raise ApiError(res.status, f"login failed: {str(res.body)[:200]}")
        self.cookie = sid

    @property
    def headers(self) -> Dict[str, str]:
        if not self.cookie:
            raise RuntimeError("not logged in")
        return {"Cookie": f"pi_web_sid={self.cookie}"}

    def ensure_session(self, body: dict) -> str:
        res = http_json("POST", f"{self.base}/api/agent/new", body, self.headers, timeout=60)
        if not isinstance(res.body, dict) or not res.body.get("sessionId"):
            raise ApiError(res.status, f"ensure_session failed: {str(res.body)[:300]}")
        return res.body["sessionId"]

    def prompt(self, session_id: str, message: str, model: Optional[dict] = None, thinking: Optional[str] = None) -> None:
        body: Dict[str, Any] = {"type": "prompt", "message": message}
        if model:
            body.update(model)
        if thinking:
            body["thinkingLevel"] = thinking
        res = http_json("POST", f"{self.base}/api/agent/{session_id}", body, self.headers, timeout=60)
        if res.status not in (200, 202):
            raise ApiError(res.status, f"prompt rejected: {str(res.body)[:300]}")

    def running_ids(self) -> List[str]:
        res = http_json("GET", f"{self.base}/api/agent/running", headers=self.headers, timeout=30)
        if isinstance(res.body, dict):
            ids = res.body.get("runningSessionIds")
            if isinstance(ids, list):
                return [str(x) for x in ids]
        return []

    def wait_settled(self, session_id: str, timeout_s: int, interval_s: float = 5.0) -> None:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            if session_id not in self.running_ids():
                # 连续两次缺席才算稳定（防轮询间隙竞态）
                time.sleep(2)
                if session_id not in self.running_ids():
                    return
            time.sleep(interval_s)
        raise TimeoutError(f"session {session_id} still running after {timeout_s}s")

    def context(self, session_id: str) -> dict:
        res = http_json(
            "GET",
            f"{self.base}/api/sessions/{session_id}/context?tail=200",
            headers=self.headers,
            timeout=60,
        )
        return res.body if isinstance(res.body, dict) else {"raw": res.body}

    def sessions_flat(self) -> List[dict]:
        """/api/sessions 扁平化（分组结构里抽出 sessions 数组）。"""
        res = http_json("GET", f"{self.base}/api/sessions", headers=self.headers, timeout=60)
        items = res.body if isinstance(res.body, list) else (res.body or {}).get("sessions", [])
        flat: List[dict] = []
        for group in items:
            if isinstance(group, dict) and isinstance(group.get("sessions"), list):
                flat.extend(group["sessions"])
            elif isinstance(group, dict):
                flat.append(group)
        return flat


# ---------------------------------------------------------------- 证物提取

def batch_tool_names(result: dict) -> List[str]:
    """batch result.toolCallLog → 工具名列表（兼容 [{name,...}] / ["name"] 两种形态）。"""
    log = result.get("toolCallLog") or []
    names: List[str] = []
    for entry in log:
        if isinstance(entry, dict):
            n = entry.get("name") or entry.get("tool")
            if n:
                names.append(str(n))
        elif isinstance(entry, str):
            names.append(entry)
    return names


def context_tool_names_and_texts(context_body: dict) -> tuple:
    """session context → (工具名列表, assistant 文本列表)。

    context 形状：{context: {messages: [...]}}，message.content 为块数组，
    toolCall 块带 name；assistant 文本块带 text。
    """
    ctx = context_body.get("context") if isinstance(context_body.get("context"), dict) else {}
    messages = ctx.get("messages") or []
    tools: List[str] = []
    texts: List[str] = []
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        role = (msg.get("message") or msg).get("role") if isinstance(msg.get("message"), dict) else msg.get("role")
        content = (msg.get("message") or msg).get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "toolCall" and block.get("name"):
                tools.append(str(block["name"]))
            if block.get("type") == "text" and block.get("text") and role == "assistant":
                texts.append(str(block["text"]))
    return tools, texts
