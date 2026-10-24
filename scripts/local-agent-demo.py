#!/usr/bin/env python3
"""End-to-end demo: drive a local-machine project through pi-web's HTTP API.

What it does (all over plain HTTP, Python standard library only):

  1. log in to pi-web (the BFF proxies the platform account and sets a cookie)
  2. download the matching agent-client binary for this OS/arch and verify its
     version against the WebUI's required version
  3. create a workspace directory on this machine and seed it with a file
  4. pair the client with the WebUI (one-time pairing code) and start it
  5. wait until the client is online, then create a local-machine PROJECT that
     points at the workspace
  6. submit a batch task bound to that project and poll it to completion
  7. print the final answer and the file the agent wrote

The client is started with a demo-specific config under the cache directory,
so it does not disturb an existing ~/.agent-client pairing. It keeps running
after the demo by default (`--stop-client` to stop it); subsequent runs reuse
the same machine identity.

Requirements:
  * pi-web deployed with PI_WEB_AUTH=on (a logged-in user is required to mint a
    pairing code and create a project)
  * the pi-web server can reach this machine's relay port (same host / LAN)
  * `agent-client` binaries present in <pi-web>/agent/dist (run
    agent/scripts/build.sh on a build host)

Usage:
  python scripts/local-agent-demo.py \
      --pi-web http://127.0.0.1:30141 --username admin \
      --workspace ~/pi-web-demo/workspace

The password is prompted for when --password is omitted.
"""

from __future__ import annotations

import argparse
import getpass
import http.cookiejar
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


class DemoError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# HTTP client (cookie session; the batch API also accepts the same cookie)
# ---------------------------------------------------------------------------

class Http:
    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar)
        )

    def request(self, method: str, path: str, body: dict | None = None, timeout: float = 30):
        data = None
        headers = {"Accept": "application/json"}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with self.opener.open(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", "replace")
            message = raw
            try:
                payload = json.loads(raw)
                message = payload.get("error") or payload.get("message") or raw
            except (ValueError, AttributeError):
                pass
            raise DemoError(f"{method} {path} -> HTTP {exc.code}: {message}") from None
        except urllib.error.URLError as exc:
            raise DemoError(f"{method} {path} -> {exc.reason}") from None
        return json.loads(raw) if raw.strip() else {}

    def get(self, path: str, timeout: float = 30):
        return self.request("GET", path, timeout=timeout)

    def post(self, path: str, body: dict | None = None, timeout: float = 30):
        return self.request("POST", path, body or {}, timeout=timeout)

    def download(self, path: str, target: Path) -> None:
        with self.opener.open(self.base + path, timeout=120) as resp, open(target, "wb") as fh:
            shutil.copyfileobj(resp, fh)


# ---------------------------------------------------------------------------
# Versions / binaries
# ---------------------------------------------------------------------------

def version_tuple(raw: str | None):
    match = re.search(r"(\d+)\.(\d+)\.(\d+)", raw or "")
    return tuple(int(part) for part in match.groups()) if match else None


def client_asset_name() -> str:
    system = platform.system().lower()
    machine = platform.machine().lower()
    arch = "arm64" if machine in ("arm64", "aarch64") else "amd64"
    if system == "windows":
        # Windows on ARM runs the amd64 build under emulation.
        return "agent-client-windows-amd64.exe"
    if system == "darwin":
        return f"agent-client-darwin-{arch}"
    return f"agent-client-linux-{arch}"


def default_cache_dir() -> Path:
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home())
        return Path(base) / "pi-web" / "agent-client"
    base = os.environ.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
    return Path(base) / "pi-web" / "agent-client"


def binary_version(path: Path) -> tuple | None:
    try:
        out = subprocess.run(
            [str(path), "--version"], capture_output=True, text=True, timeout=15
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return version_tuple(out.stdout or out.stderr)


def ensure_client(http: Http, cache_dir: Path, required: tuple | None) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    minimum = required or (0, 3, 0)
    # Versioned filename: a running client keeps its old binary locked on
    # Windows, so a re-download must never overwrite the in-use file.
    base_name = client_asset_name()
    stem, suffix = os.path.splitext(base_name)
    binary = cache_dir / f"{stem}-{'.'.join(map(str, minimum))}{suffix}"

    have = binary_version(binary) if binary.exists() else None
    if have and have >= minimum:
        print(f"   client: {binary} (v{'.'.join(map(str, have))})")
        return binary

    print(f"   downloading {base_name} ...")
    tmp = binary.with_suffix(binary.suffix + ".part")
    try:
        http.download(f"/api/agent-relay/download/{base_name}", tmp)
    except urllib.error.HTTPError as exc:
        raise DemoError(
            f"client download failed (HTTP {exc.code}) — build pi-web/agent/dist first "
            "(agent/scripts/build.sh)"
        ) from None
    except urllib.error.URLError as exc:
        raise DemoError(f"client download failed: {exc.reason}") from None
    if os.name != "nt":
        tmp.chmod(0o755)
    tmp.replace(binary)
    got = binary_version(binary)
    if not got:
        raise DemoError("downloaded agent-client does not run (bad binary?)")
    if got < minimum:
        raise DemoError(
            f"downloaded client is v{'.'.join(map(str, got))}, but the WebUI requires "
            f">= {'.'.join(map(str, minimum))}; rebuild agent/dist"
        )
    print(f"   client: {binary} (v{'.'.join(map(str, got))})")
    return binary


# ---------------------------------------------------------------------------
# Client lifecycle
# ---------------------------------------------------------------------------

def stop_previous_client(cache_dir: Path) -> None:
    pid_file = cache_dir / "client.pid"
    if not pid_file.exists():
        return
    try:
        pid = int(pid_file.read_text().strip())
    except (ValueError, OSError):
        pid_file.unlink(missing_ok=True)
        return
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True)
        else:
            os.kill(pid, 15)
        time.sleep(0.5)
    except OSError:
        pass
    pid_file.unlink(missing_ok=True)


def start_client(binary: Path, config: Path, log_path: Path) -> subprocess.Popen:
    log = open(log_path, "ab")
    kwargs = {}
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    proc = subprocess.Popen(
        [str(binary), "run", "--config", str(config)],
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=subprocess.STDOUT,
        **kwargs,
    )
    return proc


def wait_online(http: Http, machine_id: str, timeout: float = 45) -> dict:
    deadline = time.time() + timeout
    last_state = "offline"
    while time.time() < deadline:
        status = http.get("/api/agent-relay/status")
        for machine in status.get("machines") or []:
            if machine.get("machineId") != machine_id:
                continue
            last_state = "online" if machine.get("online") else "offline"
            if machine.get("online"):
                if machine.get("compatible") is False:
                    raise DemoError(
                        f"client v{machine.get('info', {}).get('agentVersion', '?')} is older than "
                        f"required v{machine.get('requiredVersion', '?')}; update agent-client"
                    )
                return machine
        time.sleep(1)
    raise DemoError(f"client did not come online within {timeout:.0f}s (last state: {last_state})")


# ---------------------------------------------------------------------------
# Demo
# ---------------------------------------------------------------------------

def run(args: argparse.Namespace) -> int:
    base = args.pi_web.rstrip("/")
    http = Http(base)

    print("[1/7] login")
    password = args.password or getpass.getpass(f"password for {args.username}: ")
    result = http.post("/api/webauth/login", {"username": args.username, "password": password})
    if result.get("mustChangePassword"):
        raise DemoError("account must change its password before using the API")
    try:
        me = http.get("/api/webauth/me")
        user = me.get("user") or {}
        if user.get("username"):
            print(f"   logged in as {user.get('username')} ({user.get('role')})")
        else:
            print("   logged in")
    except DemoError:
        print("   logged in")

    print("[2/7] check client version")
    status = http.get("/api/agent-relay/status")
    required = version_tuple(status.get("requiredVersion"))
    relay_port = status.get("relayPort") or 30142
    advertise = status.get("advertiseUrl")

    print("[3/7] download client")
    cache = Path(args.client_cache).expanduser()
    cache.mkdir(parents=True, exist_ok=True)
    stop_previous_client(cache)  # free the old binary (Windows lock) + avoid two clients
    client = ensure_client(http, cache, required)

    print("[4/7] prepare workspace")
    workspace = Path(args.workspace).expanduser().resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    hello = workspace / "hello.txt"
    if not hello.exists():
        hello.write_text("hello from the local workspace\n", encoding="utf-8")
    answer = workspace / "answer.txt"
    answer.unlink(missing_ok=True)
    print(f"   workspace: {workspace}")

    print("[5/7] pair + start client")
    config = cache / "config.json"
    label = args.label or f"pi-web demo ({socket.gethostname()})"

    code = http.post("/api/agent-relay/pair", {"label": label}).get("code")
    if not code:
        raise DemoError("pairing code was not returned")

    parsed = urllib.parse.urlparse(base)
    relay = advertise or f"{parsed.scheme or 'http'}://{parsed.hostname}:{relay_port}"
    pair_cmd = [
        str(client), "pair", "--code", code, "--server", relay,
        "--root", str(workspace), "--label", label, "--config", str(config),
    ]
    pair = subprocess.run(pair_cmd, capture_output=True, text=True, timeout=60)
    if pair.returncode != 0:
        raise DemoError(
            f"pairing failed (exit {pair.returncode}): {(pair.stderr or pair.stdout).strip()}"
        )
    print("   " + " / ".join(line for line in pair.stdout.strip().splitlines() if line))

    machine_id = json.loads(config.read_text(encoding="utf-8")).get("machineId")
    if not machine_id:
        raise DemoError("pairing config has no machineId")

    log_path = cache / "client.log"
    proc = start_client(client, config, log_path)
    (cache / "client.pid").write_text(str(proc.pid), encoding="utf-8")
    print(f"   client running (pid {proc.pid}, log {log_path})")
    try:
        wait_online(http, machine_id)
        print("   client is online")

        print("[6/7] create local-machine project")
        project_name = args.project_name or time.strftime("local-demo-%Y%m%d-%H%M%S")
        project = http.post("/api/projects", {
            "name": project_name,
            "mode": "local-machine",
            "workdir": str(workspace),
            "machineId": machine_id,
        }).get("project") or {}
        project_id = project.get("id")
        if not project_id:
            raise DemoError("project creation returned no id")
        print(f"   project: {project_name} ({project_id})")

        print("[7/7] submit batch task + wait")
        prompt = args.prompt or (
            f"你在一台用户电脑的本地工作区中工作，工作区目录是 {workspace}。\n"
            f"1. 读取 {hello}。\n"
            f"2. 新建 {answer}，写入 hello.txt 的内容，并在末尾追加一行「local-agent demo ok」。\n"
            "3. 用一句话总结你做了什么。"
        )
        task = http.post("/api/batch/tasks", {
            "mode": "local-machine",
            "projectId": project_id,
            "prompt": prompt,
            "timeoutMs": int(args.timeout * 1000),
        })
        task_id = task.get("taskId")
        if not task_id:
            raise DemoError("batch task submission returned no taskId")

        deadline = time.time() + args.timeout + 30
        last = ""
        while time.time() < deadline:
            state = http.get(f"/api/batch/tasks/{task_id}")
            current = state.get("state", "unknown")
            if current != last:
                print(f"   task {current}")
                last = current
            if current in ("completed", "failed", "cancelled"):
                break
            time.sleep(2)
        else:
            raise DemoError("timed out waiting for the task")

        final = http.get(f"/api/batch/tasks/{task_id}/result")
        print("\n=== final answer ===")
        print((final.get("finalResponse") or "").strip() or "(empty)")
        usage = final.get("usage") or {}
        if usage:
            print(f"\ntokens: {usage.get('totalTokens', '?')} · tool calls: {usage.get('toolCalls', '?')}")
        if final.get("error"):
            print(f"error: {final['error']}")
        if answer.exists():
            print(f"\nanswer.txt written by the agent:\n{answer.read_text(encoding='utf-8')}")
        else:
            print(f"\n(note: {answer} was not created)")
        return 0 if final.get("state") == "completed" else 1
    finally:
        if args.stop_client:
            try:
                proc.terminate()
            except OSError:
                pass
            (cache / "client.pid").unlink(missing_ok=True)
            print("client stopped (--stop-client)")
        else:
            print(
                "client left running for follow-up work; stop it with "
                f"`taskkill /PID {proc.pid} /F` on Windows or `kill {proc.pid}` elsewhere"
            )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="pi-web local-agent end-to-end demo (login → client → project → chat)",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--pi-web", default="http://127.0.0.1:30141", help="pi-web origin")
    parser.add_argument("--username", required=True, help="pi-web/platform username")
    parser.add_argument("--password", help="password (prompted when omitted)")
    parser.add_argument("--workspace", default="~/pi-web-local-demo/workspace", help="workspace directory on this machine")
    parser.add_argument("--project-name", help="project name (default: timestamped)")
    parser.add_argument("--prompt", help="task prompt (default: reads/writes the seeded files)")
    parser.add_argument("--label", help="machine label shown in the WebUI")
    parser.add_argument("--client-cache", default=str(default_cache_dir()), help="agent-client cache directory")
    parser.add_argument("--timeout", type=float, default=300, help="task timeout in seconds")
    parser.add_argument("--stop-client", action="store_true", help="stop the client when the demo finishes")
    args = parser.parse_args()

    try:
        return run(args)
    except DemoError as exc:
        print(f"\nFAILED: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
