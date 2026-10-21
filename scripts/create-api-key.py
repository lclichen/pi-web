#!/usr/bin/env python3
"""在沙盒平台上创建/管理个人 API Key（批量测试接口用）。

适用于任何前端版本（旧版发布没有"API 密钥"设置页时，用本脚本代替 curl）。
仅用 Python 标准库，无第三方依赖。

用法（常用）：
    # 创建一把 key（密码不传则交互输入，避免进 shell 历史）
    python scripts/create-api-key.py --platform http://10.99.9.7:3000 \
        --username admin --name 批量测试

    # 创建后顺手验证它能否调 pi-web 批量接口（要求管理员账号）
    python scripts/create-api-key.py --platform http://10.99.9.7:3000 \
        --username admin --pi-web http://10.99.9.7:30141

    # 列出我的 key（只有前缀与元数据；明文不可再取，平台只存哈希）
    python scripts/create-api-key.py --platform ... --username admin --list

    # 吊销（id 来自 --list；立即失效）
    python scripts/create-api-key.py --platform ... --username admin --revoke 12

说明：
    - 批量测试接口（POST /api/batch/tasks）要求管理员 key，非管理员 403。
    - 明文 sk_... 只在创建时出现一次，请立即保存到安全位置。
    - 遗失明文只能吊销重建。
"""
import argparse
import getpass
import json
import sys
import urllib.error
import urllib.parse
import urllib.request


def http_json(method: str, url: str, body: dict | None = None, token: str | None = None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.read().decode("utf-8")
        return json.loads(raw) if raw else {}


def die(msg: str, code: int = 1):
    print(f"错误: {msg}", file=sys.stderr)
    sys.exit(code)


def main():
    ap = argparse.ArgumentParser(description="沙盒平台个人 API Key 管理（批量测试用）")
    ap.add_argument("--platform", required=True, help="平台地址，如 http://10.99.9.7:3000")
    ap.add_argument("--username", required=True, help="平台账号（key 归属该用户）")
    ap.add_argument("--password", help="密码；不传则交互输入（推荐，避免进 shell 历史）")
    ap.add_argument("--name", default="批量测试", help="新 key 的备注名（默认: 批量测试）")
    ap.add_argument("--list", action="store_true", help="只列出我的 key")
    ap.add_argument("--revoke", type=int, metavar="ID", help="吊销指定 id 的 key")
    ap.add_argument("--pi-web", help="pi-web 地址（提供则创建后顺手验证批量接口连通）")
    args = ap.parse_args()

    platform = args.platform.rstrip("/")
    password = args.password or getpass.getpass(f"{args.username} 的平台密码: ")

    # 登录换 accessToken（平台无 cookie 会话，后续请求走 Bearer）
    try:
        login = http_json("POST", f"{platform}/api/v1/auth/login",
                          {"username": args.username, "password": password})
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:200]
        die(f"登录失败 HTTP {e.code}: {detail}")
    except urllib.error.URLError as e:
        die(f"连不上平台 {platform}: {e.reason}")
    token = login.get("accessToken", "")
    if not token:
        die(f"登录响应中没有 accessToken: {json.dumps(login, ensure_ascii=False)[:200]}")

    auth = f"{platform}/api/v1/auth/api-keys"

    if args.revoke is not None:
        try:
            http_json("DELETE", f"{auth}/{args.revoke}", token=token)
        except urllib.error.HTTPError as e:
            die(f"吊销失败 HTTP {e.code}")
        print(f"已吊销 key id={args.revoke}")
        return

    if args.list:
        keys = http_json("GET", auth, token=token).get("apiKeys", [])
        if not keys:
            print("（还没有 key）")
        for k in keys:
            state = "已吊销" if k.get("revoked_at") else "有效"
            print(f"  id={k['id']}  {k['name']}  {k.get('key_prefix', '')}…  {state}"
                  f"  创建于 {k.get('created_at', '?')}"
                  f"  最近使用 {k.get('last_used_at') or '从未'}")
        return

    # 创建（明文只在本次响应出现）
    try:
        created = http_json("POST", auth, {"name": args.name}, token=token)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:200]
        die(f"创建失败 HTTP {e.code}: {detail}")

    key = created.get("key", "")
    if not str(key).startswith("sk_"):
        die(f"平台返回异常（未见 sk_ 明文）: {json.dumps(created, ensure_ascii=False)[:200]}")

    print("=" * 62)
    print(f"密钥已创建（id={created.get('id')}  名称: {created.get('name')}）")
    print("明文只显示这一次，请立即保存：")
    print()
    print(f"    {key}")
    print("=" * 62)
    print()
    print("用法（批量测试接口，要求管理员账号）：")
    print(f"    X-Platform-API-Key: {key}")
    print(f"    curl -H 'X-Platform-API-Key: {key}' {args.pi_web or 'http://<pi-web>:30141'}/api/batch/tasks")

    if args.pi_web:
        pi_web = args.pi_web.rstrip("/")
        req = urllib.request.Request(f"{pi_web}/api/batch/tasks")
        req.add_header("X-Platform-API-Key", key)
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                resp.read()
            print(f"\n[验证] {pi_web} 批量接口连通 ✓（HTTP 200）")
        except urllib.error.HTTPError as e:
            if e.code == 403:
                print(f"\n[验证] key 本身有效，但该账号不是管理员——批量接口需要管理员 key（HTTP 403）")
            else:
                print(f"\n[验证] 批量接口返回 HTTP {e.code}（key 已创建成功，可稍后排查 pi-web 侧）")
        except urllib.error.URLError as e:
            print(f"\n[验证] 连不上 pi-web {pi_web}: {e.reason}（key 已创建成功）")


if __name__ == "__main__":
    main()
