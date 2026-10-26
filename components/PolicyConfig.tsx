"use client";

/**
 * 设置 → 策略：路径护栏的管理视图（GET/PUT/DELETE /api/policy）。
 *
 * 展示当前项目的生效策略（.pi/path-policy.json，无文件时为默认值）、
 * 自保护恒生效清单说明，与“不再询问”决策记录（可移除）。策略编辑仅
 * Host 模式目录开放（服务端锁定，非 Host 只读）；决策记录随配置包
 * 导出分发（含“拒绝且不再询问”——分发端同样不再询问）。
 *
 * 类型从服务端模块 import type 引入（编译期擦除，不把 node:fs 拖进
 * 客户端包——webpack 陷阱见 docs）。
 */
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { PathPolicy, PolicyDecisions } from "@/lib/extensions/path-guard";
import { ConfigButton, ConfigPanelShell } from "./SettingsUi";

interface PolicyState {
  cwd: string;
  policyFilePresent: boolean;
  policy: PathPolicy;
  defaults: PathPolicy;
  decisions: PolicyDecisions;
  editable: boolean;
  lockReason?: string;
}

export function PolicyConfig({ embedded = false, cwd }: { embedded?: boolean; cwd: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<PolicyState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [formMsg, setFormMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/policy?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" });
      const d = (await res.json()) as PolicyState & { error?: string };
      if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
      setState(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => { void load(); }, [load]);

  const startEdit = () => {
    if (!state) return;
    setEditing(true);
    setDraft(JSON.stringify(state.policyFilePresent ? state.policy : state.defaults, null, 2));
    setFormMsg(null);
  };

  const save = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch (e) {
      setFormMsg(null);
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/policy?cwd=${encodeURIComponent(cwd)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy: parsed }),
      });
      const d = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
      setEditing(false);
      setFormMsg(t("policy.saved"));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const removeDecision = async (path: string) => {
    try {
      const res = await fetch(`/api/policy?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`, { method: "DELETE" });
      const d = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const patternChips = (items: string[]) => (
    <div className="bundle-chip-list" style={{ paddingTop: 0 }}>
      {items.length === 0 ? <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("policy.noPatterns")}</span> : items.map((p) => (
        <span key={p} className="bundle-chip is-mono">{p}</span>
      ))}
    </div>
  );

  return (
    <ConfigPanelShell embedded={embedded} title={t("settings.policy")} closeLabel={t("i18n.close")} onClose={() => {}}>
      <div style={{ padding: 18, overflowY: "auto", height: "100%", boxSizing: "border-box", maxWidth: 720 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text)" }}>{t("settings.policy")}</h2>
        <p style={{ margin: "6px 0 0", fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6 }}>
          {t("policy.intro")} <code style={{ fontFamily: "var(--font-mono)" }}>.pi/path-policy.json</code>
        </p>

        {/* 锁定状态 */}
        {state && (
          <div className={`policy-lock-banner${state.editable ? " is-editable" : ""}`} style={{ marginTop: 14 }}>
            {state.editable ? t("policy.hostEditable") : t("policy.locked")}
          </div>
        )}

        {loading && <p style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 14 }}>{t("apiKeys.loading")}</p>}
        {error && <p role="alert" style={{ color: "var(--danger)", fontSize: 12, marginTop: 12 }}>{error}</p>}

        {state && !editing && (
          <>
            <div className="policy-section-title">{t("policy.allowWrite")}</div>
            {patternChips(state.policy.allowWrite)}
            <div className="policy-section-title">{t("policy.denyWrite")}</div>
            {patternChips(state.policy.denyWrite)}
            <div className="policy-section-title">{t("policy.denyRead")}</div>
            {patternChips(state.policy.denyRead)}
            <div className="policy-section-title">{t("policy.behavior")}</div>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text)" }}>
              {state.policy.askOnOutsideWrite !== false ? t("policy.askOnOutside") : t("policy.denyOnOutside")}
            </p>
            <p style={{ margin: "10px 0 0", fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6 }}>
              {t("policy.selfProtectedNote")}
            </p>
            {state.editable && (
              <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                <ConfigButton variant="primary" onClick={startEdit}>{t("policy.edit")}</ConfigButton>
              </div>
            )}

            <div className="policy-section-title" style={{ marginTop: 20 }}>{t("policy.decisions")}</div>
            {state.decisions.entries.length === 0 ? (
              <p style={{ margin: 0, fontSize: 12, color: "var(--text-dim)" }}>{t("policy.noDecisions")}</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {state.decisions.entries.slice().reverse().map((e) => (
                  <div key={e.path} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderBottom: "1px solid var(--border)" }}>
                    <span className="config-scope-tag" style={e.decision === "deny" ? { color: "var(--danger)", background: "color-mix(in srgb, var(--danger) 8%, transparent)" } : { color: "var(--success)", background: "color-mix(in srgb, var(--success) 8%, transparent)" }}>
                      {e.decision === "deny" ? t("policy.decisionDeny") : t("policy.decisionAllow")}
                    </span>
                    <span style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={e.path}>
                      {e.path}
                    </span>
                    <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>{e.at ? new Date(e.at).toLocaleString() : ""}</span>
                    <ConfigButton size="small" onClick={() => void removeDecision(e.path)}>{t("policy.removeDecision")}</ConfigButton>
                  </div>
                ))}
                <p style={{ margin: "8px 0 0", fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6 }}>
                  {t("policy.decisionsExportNote")}
                </p>
              </div>
            )}
          </>
        )}

        {state && editing && (
          <>
            <p style={{ margin: "14px 0 0", fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6 }}>
              {t("policy.editHint")}
            </p>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              style={{
                width: "100%", minHeight: 260, marginTop: 8, padding: 10, boxSizing: "border-box",
                fontFamily: "var(--font-mono)", fontSize: 11.5, lineHeight: 1.6,
                background: "var(--bg-panel)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 6,
                outline: "none", resize: "vertical",
              }}
            />
            {formMsg && !error && <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--success)" }}>{formMsg}</p>}
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <ConfigButton onClick={() => { setEditing(false); setError(null); }}>{t("common.cancel")}</ConfigButton>
              <ConfigButton variant="primary" disabled={saving} onClick={() => void save()}>
                {saving ? t("common.saving") : t("common.save")}
              </ConfigButton>
            </div>
          </>
        )}
      </div>
    </ConfigPanelShell>
  );
}
