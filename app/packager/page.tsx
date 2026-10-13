"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";

/**
 * 发布方打包工作台（单页，管理员）。把 scripts/pack-apkg.ts 的 CLI 流程
 * 可视化：上传明文 zip → 选/建密钥代 → 填包信息 → 许可限制 → 打包下载。
 * 后端 /api/apkg/keys 与 /api/apkg/pack 与 CLI 共用 lib/apkg-format +
 * lib/apkg-keys，产物完全一致。
 *
 * 直排中文（与 /login 同为独立工具页，不走主应用 i18n）。
 */

type Phase = "checking" | "denied" | "ready";

interface KeyList {
  storePath: string;
  keys: string[];
}

interface PackResult {
  apkgBase64: string;
  fileName: string;
  byteSize: number;
  fingerprint: string;
  keyId: string;
  isNewKey: boolean;
  storePath: string;
  license?: { expiresAt?: string; maxImports?: number };
}

const STEP_TITLES = ["① 上传明文包", "② 密钥代", "③ 包信息", "④ 许可限制", "⑤ 打包"];

const inputStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", height: 34, padding: "0 10px",
  background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)",
  borderRadius: 6, fontSize: 13, outline: "none",
};
const labelStyle: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 600, color: "var(--text)", margin: "12px 0 4px" };
const hintStyle: React.CSSProperties = { fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.7 };
const btn = (primary: boolean): React.CSSProperties => ({
  padding: primary ? "8px 18px" : "7px 14px", borderRadius: 7, cursor: "pointer", fontSize: 12.5,
  fontWeight: primary ? 700 : 400,
  border: `1px solid ${primary ? "var(--accent)" : "var(--border)"}`,
  background: primary ? "var(--accent)" : "var(--bg)",
  color: primary ? "#fff" : "var(--text)",
});

export default function PackagerPage() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [step, setStep] = useState(0);

  // ① 上传
  const [zipName, setZipName] = useState("");
  const [zipSize, setZipSize] = useState(0);
  const [zipB64, setZipB64] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // ② 密钥
  const [keyInfo, setKeyInfo] = useState<KeyList | null>(null);
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [newKeyId, setNewKeyId] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);

  // ③ 包信息
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const [channel, setChannel] = useState("stable");

  // ④ 许可
  const [expires, setExpires] = useState("");
  const [maxImports, setMaxImports] = useState("");

  // ⑤ 结果
  const [packing, setPacking] = useState(false);
  const [result, setResult] = useState<PackResult | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void fetch("/api/webauth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { authEnabled?: boolean; user?: { role?: string } | null } | null) => {
        const admin = d?.authEnabled === false || d?.user?.role === "admin";
        setPhase(admin ? "ready" : "denied");
      })
      .catch(() => setPhase("denied"));
  }, []);

  const loadKeys = useCallback(async () => {
    setKeyBusy(true);
    try {
      const r = await fetch("/api/apkg/keys", { cache: "no-store" });
      if (r.ok) {
        const d = (await r.json()) as KeyList;
        setKeyInfo(d);
        setSelectedKey((prev) => (prev && d.keys.includes(prev) ? prev : d.keys[0] ?? ""));
      }
    } finally {
      setKeyBusy(false);
    }
  }, []);

  useEffect(() => {
    if (phase === "ready" && step === 1 && !keyInfo) void loadKeys();
  }, [phase, step, keyInfo, loadKeys]);

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    setError("");
    setResult(null);
    if (!f) return;
    if (!/\.zip$/i.test(f.name)) { setError("请选择 .zip 文件（先在 WebUI 的配置包导出中产出明文包）"); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const buf = new Uint8Array(reader.result as ArrayBuffer);
      if (buf[0] !== 0x50 || buf[1] !== 0x4b) { setError("不是有效的 zip 文件（缺 PK 头）"); return; }
      let binary = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < buf.length; i += CHUNK) {
        binary += String.fromCharCode(...buf.subarray(i, i + CHUNK));
      }
      setZipB64(btoa(binary));
      setZipName(f.name);
      setZipSize(f.size);
      setName(f.name.replace(/\.zip$/i, "").replace(/[^\w.-]+/g, "-").slice(0, 64));
    };
    reader.readAsArrayBuffer(f);
  };

  const createKey = async () => {
    setKeyBusy(true);
    setError("");
    try {
      const r = await fetch("/api/apkg/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newKeyId.trim() ? { keyId: newKeyId.trim() } : {}),
      });
      const d = (await r.json().catch(() => ({}))) as { keyId?: string; error?: string };
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      await loadKeys();
      if (d.keyId) setSelectedKey(d.keyId);
      setNewKeyId("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setKeyBusy(false);
    }
  };

  const doPack = async () => {
    setPacking(true);
    setError("");
    setResult(null);
    try {
      const r = await fetch("/api/apkg/pack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          zipBase64: zipB64,
          zipFileName: zipName,
          name, title, desc, version, channel,
          ...(expires ? { expiresAt: expires } : {}),
          ...(maxImports.trim() ? { maxImports: Number(maxImports) } : {}),
          ...(selectedKey ? { keyId: selectedKey } : {}),
        }),
      });
      const d = (await r.json().catch(() => ({}))) as PackResult & { error?: string };
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      setResult(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPacking(false);
    }
  };

  const download = () => {
    if (!result) return;
    const bin = atob(result.apkgBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = result.fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (phase === "checking") {
    return <Shell><p style={hintStyle}>检查权限…</p></Shell>;
  }
  if (phase === "denied") {
    return (
      <Shell>
        <h1 style={{ fontSize: 16, margin: "0 0 8px" }}>发布方打包工作台</h1>
        <p style={hintStyle}>仅管理员可用。请先以管理员身份登录主界面，再回到本页（/packager）。</p>
        <a href="/" style={{ color: "var(--accent)", fontSize: 13 }}>← 返回主界面</a>
      </Shell>
    );
  }

  const canNext = [
    Boolean(zipB64),
    Boolean(selectedKey) || (keyInfo && keyInfo.keys.length === 0),
    name.trim().length > 0,
    true,
    true,
  ][step];

  return (
    <Shell>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <h1 style={{ fontSize: 16, margin: 0, flex: 1 }}>📦 发布方打包工作台</h1>
        <a href="/" style={{ color: "var(--text-dim)", fontSize: 12 }}>← 主界面</a>
      </div>
      <p style={{ ...hintStyle, margin: "0 0 14px" }}>
        把明文配置包 zip 加密为 .apkg 分发格式（商业化保护 §一）。流程与
        <code> scripts/pack-apkg.ts </code>完全一致；密钥材料只存在服务器
        <code> apkg-keys.json </code>中，页面与产物里都不出现。
      </p>

      {/* 步骤条 */}
      <div style={{ display: "flex", gap: 4, marginBottom: 14 }}>
        {STEP_TITLES.map((s, i) => (
          <div key={s} style={{
            flex: 1, textAlign: "center", fontSize: 11, padding: "6px 2px", borderRadius: 6,
            background: i === step ? "var(--bg-selected)" : "transparent",
            color: i === step ? "var(--text)" : "var(--text-dim)",
            fontWeight: i === step ? 700 : 400,
            border: `1px solid ${i === step ? "var(--accent)" : "transparent"}`,
          }}>{s}</div>
        ))}
      </div>

      {/* ① 上传 */}
      {step === 0 && (
        <div>
          <p style={hintStyle}>
            明文 zip 来自 WebUI 的「导出配置包」（项目或 Host 目录的配置导出）。
            本页只读该文件做加密，不在服务器留存明文副本。
          </p>
          <input ref={fileRef} type="file" accept=".zip" onChange={onFile} style={{ display: "none" }} />
          <button type="button" onClick={() => fileRef.current?.click()} style={{ ...btn(false), marginBottom: 8 }}>
            选择明文 zip…
          </button>
          {zipB64 && (
            <div style={{ padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12 }}>
              ✅ {zipName}（{(zipSize / 1024).toFixed(1)} KB）
            </div>
          )}
        </div>
      )}

      {/* ② 密钥 */}
      {step === 1 && (
        <div>
          <p style={hintStyle}>
            密钥仓：<code>{keyInfo?.storePath ?? "…"}</code>。同一代密钥打包的包，
            只能被部署了同一份密钥仓的服务器导入。
          </p>
          {keyBusy && !keyInfo && <p style={hintStyle}>读取密钥代…</p>}
          {keyInfo?.keys.map((k) => (
            <label key={k} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, padding: "5px 0", cursor: "pointer" }}>
              <input type="radio" name="apkg-key" checked={selectedKey === k} onChange={() => setSelectedKey(k)} />
              <code>{k}</code>
            </label>
          ))}
          {keyInfo && keyInfo.keys.length === 0 && <p style={hintStyle}>（密钥仓为空——首次打包将自动生成新代）</p>}
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
            <input
              value={newKeyId}
              onChange={(e) => setNewKeyId(e.target.value)}
              placeholder="新代 id（可选，≤16 字节）"
              style={{ ...inputStyle, width: 220, fontFamily: "var(--font-mono)" }}
            />
            <button type="button" onClick={createKey} disabled={keyBusy} style={btn(false)}>
              {keyBusy ? "…" : "＋ 新建密钥代"}
            </button>
          </div>
          <p style={{ ...hintStyle, marginTop: 8 }}>
            ⚠ 新建的密钥代只写入了本机密钥仓——请把该文件部署为每台需要导入此包的
            pi-web 服务器的 <code>&lt;数据目录&gt;/apkg-keys.json</code>。
          </p>
        </div>
      )}

      {/* ③ 包信息 */}
      {step === 2 && (
        <div>
          <label style={labelStyle}>包名（name，导入计数与锁定按它 + 指纹标识）</label>
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} />
          <label style={labelStyle}>显示名（title）</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={name} style={inputStyle} />
          <label style={labelStyle}>描述</label>
          <input value={desc} onChange={(e) => setDesc(e.target.value)} style={inputStyle} />
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>版本</label>
              <input value={version} onChange={(e) => setVersion(e.target.value)} style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>渠道</label>
              <input value={channel} onChange={(e) => setChannel(e.target.value)} style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} />
            </div>
          </div>
        </div>
      )}

      {/* ④ 许可 */}
      {step === 3 && (
        <div>
          <p style={hintStyle}>
            两项都可留空（= 不限制）。限制在导入侧强制：过期或导入次数用尽的包会被拒绝导入。
          </p>
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>有效期至（可空）</label>
              <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} style={inputStyle} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>最大导入次数（可空）</label>
              <input
                value={maxImports}
                onChange={(e) => setMaxImports(e.target.value.replace(/[^\d]/g, ""))}
                placeholder="如 50"
                style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
              />
            </div>
          </div>
        </div>
      )}

      {/* ⑤ 打包 */}
      {step === 4 && (
        <div>
          <div style={{ fontSize: 12.5, lineHeight: 2, marginBottom: 10 }}>
            <div>明文包：<code>{zipName || "—"}</code>（{(zipSize / 1024).toFixed(1)} KB）</div>
            <div>密钥代：<code>{selectedKey || "（将自动新建）"}</code></div>
            <div>包名 / 版本：<code>{name || "—"}</code> / <code>{version}</code>（渠道 {channel}）</div>
            <div>许可：{expires ? `至 ${expires}` : "不限期"} · {maxImports ? `${maxImports} 次导入` : "不限次数"}</div>
          </div>
          <button type="button" onClick={doPack} disabled={packing || !zipB64} style={btn(true)}>
            {packing ? "打包中…" : "🔒 生成加密配置包"}
          </button>

          {result && (
            <div style={{ marginTop: 14, padding: 14, border: "1px solid var(--accent)", borderRadius: 8 }}>
              <div style={{ fontSize: 13, marginBottom: 6 }}>✅ 已生成 <b>{result.fileName}</b>（{(result.byteSize / 1024).toFixed(1)} KB）</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>指纹（导入计数 / 锁定身份）：</span>
                <code style={{ fontSize: 12, wordBreak: "break-all" }}>{result.fingerprint}</code>
                <button
                  type="button"
                  onClick={() => { void navigator.clipboard?.writeText(result.fingerprint).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
                  style={{ ...btn(false), padding: "3px 10px", fontSize: 11 }}
                >{copied ? "已复制" : "复制"}</button>
              </div>
              <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 10 }}>
                密钥代：<code>{result.keyId}</code>
                {result.isNewKey && (
                  <b style={{ color: "#f59e0b" }}>（新生成——请把 {result.storePath} 部署到所有导入服务器！）</b>
                )}
              </div>
              <button type="button" onClick={download} style={btn(true)}>⬇ 下载 .apkg</button>
            </div>
          )}
        </div>
      )}

      {error && (
        <div style={{ marginTop: 12, padding: "8px 10px", borderRadius: 6, background: "rgba(239,68,68,0.08)", color: "#ef4444", fontSize: 12.5 }}>
          {error}
        </div>
      )}

      {/* 底部导航 */}
      <div style={{ display: "flex", gap: 8, marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
        {step > 0 && (
          <button type="button" onClick={() => setStep((s) => s - 1)} style={btn(false)}>上一步</button>
        )}
        <div style={{ flex: 1 }} />
        {step < 4 && (
          <button type="button" disabled={!canNext} onClick={() => setStep((s) => s + 1)}
            style={{ ...btn(true), opacity: canNext ? 1 : 0.45, cursor: canNext ? "pointer" : "not-allowed" }}>
            下一步
          </button>
        )}
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: "100vh", background: "var(--bg)", color: "var(--text)",
      display: "flex", justifyContent: "center", padding: "32px 16px",
      fontFamily: "var(--font-sans, system-ui)", boxSizing: "border-box",
    }}>
      <div style={{ width: "min(680px, 96vw)" }}>{children}</div>
    </div>
  );
}
