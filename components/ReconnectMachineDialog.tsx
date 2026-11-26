"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useRelayAgent } from "@/hooks/useRelayAgent";
import type { ProjectRecord } from "@/lib/projects";
import type { MachineStatus } from "@/lib/relay/protocol";
import { machineDisplayName } from "@/lib/machine-badge";
import { buildMachineReconnectPatch, sortReconnectMachines } from "@/lib/project-machine-reconnect";
import { DirectoryPicker, type DirectorySource } from "./DirectoryPicker";

interface Props {
  project: ProjectRecord;
  onClose: () => void;
  /** 改绑成功后刷新项目列表与 relay 状态。 */
  onReconnected: () => void;
}

/** 本项目自己的机器绑定响应（workdir 走专用接口——publicProject 有意剥掉路径）。 */
interface MachineDetail {
  machineId: string | null;
  previousMachineId?: string;
  workdir: string;
}

/**
 * 「重新连接机器」对话框：机器被解配（agent 配置丢失后重新配对会生成全新
 * machineId）或绑定机器离线时，把本机项目重新绑到一台已配对的机器上。
 *
 * - 机器列表复用 useRelayAgent（按页共享的 relay SSE），在线优先；
 * - 目录浏览复用 RemoteConnectWizard 同一套能力（DirectoryPicker +
 *   /api/agent-relay/browse），数据源按所选机器注入；
 * - 提交 PATCH /api/projects/:id `{ machineId, workdir? }`，服务端在**新
 *   机器**上校验目录并写入 previousMachineId。
 */
export function ReconnectMachineDialog({ project, onClose, onReconnected }: Props) {
  const { t } = useI18n();
  const { machines, ready, refresh } = useRelayAgent();
  const machineList = useMemo(() => sortReconnectMachines(machines ?? []), [machines]);
  const [selected, setSelected] = useState("");
  const [workdir, setWorkdir] = useState("");
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${encodeURIComponent(project.id)}/machine`)
      .then(async (r) => {
        const d = (await r.json().catch(() => ({}))) as MachineDetail & { error?: string };
        if (!r.ok || d.error) throw new Error(d.error ?? `HTTP ${r.status}`);
        return d;
      })
      .then((d) => {
        if (!cancelled) setWorkdir(d.workdir ?? "");
      })
      .catch(() => {
        // 读取失败只影响预填：用户可以手动填写目录后重试。
      });
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  // 默认选中：只有一台机器时选它；多台时不预选（避免误连到别的机器）。
  // 选中的机器从列表里消失（解绑）时回到未选状态。
  useEffect(() => {
    if (machineList.length === 0) return;
    if (machineList.some((m) => m.machineId === selected)) return;
    setSelected(machineList.length === 1 ? machineList[0].machineId : "");
  }, [machineList, selected]);

  const selectedMachine: MachineStatus | undefined = machineList.find((m) => m.machineId === selected);
  const browseAllowed = Boolean(selectedMachine?.online);

  // 目录浏览数据源：与 RemoteConnectWizard 的本机分支一致，只是机器取当前选择。
  const relaySource: DirectorySource = {
    load: async (directory) => {
      const qs = new URLSearchParams();
      if (directory) qs.set("path", directory);
      if (selected) qs.set("machineId", selected);
      const res = await fetch(`/api/agent-relay/browse?${qs.toString()}`);
      const d = (await res.json().catch(() => ({}))) as {
        path?: string;
        parentPath?: string | null;
        directories?: Array<{ name: string; path: string }>;
        error?: string;
      };
      if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
      return d;
    },
    create: async (parentPath, name) => {
      const res = await fetch("/api/agent-relay/browse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: parentPath, name, ...(selected ? { machineId: selected } : {}) }),
      });
      const d = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
      if (!res.ok || !d.path) throw new Error(d.error ?? `HTTP ${res.status}`);
      return d.path;
    },
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !selected || !workdir.trim()) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildMachineReconnectPatch(selected, workdir)),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        window.alert(d.error ?? t("sessions.operationFailedHttp", { code: res.status }));
        return;
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
      return;
    } finally {
      setBusy(false);
    }
    // relay 快照里的机器状态不受改绑影响，但它可能刚上线（列表要刷新）；
    // 项目列表要重新拉取以更新徽标。
    refresh();
    onReconnected();
    onClose();
  };

  // 目录必须由目标机器校验：机器离线时保存必然被服务端拒绝，直接禁用更诚实
  // （能选离线机器是为了看清自己有哪些机器；等它上线后再来保存）。
  const canSubmit =
    !busy && Boolean(selected) && Boolean(workdir.trim()) && Boolean(selectedMachine?.online);

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1180,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.4)",
      }}
    >
      <form
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        style={{
          width: "min(560px, 92vw)",
          maxHeight: "86vh",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 14,
          padding: "20px 22px",
          borderRadius: 12,
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
            {t("sessions.machineReconnectDialogTitle", { name: project.name })}
          </span>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 16,
            }}
          >
            ×
          </button>
        </div>

        <div style={{ fontSize: 12, lineHeight: 1.6, color: "var(--text-muted)" }}>
          {t("sessions.machineReconnectIntro")}
        </div>

        {!ready ? (
          // 机器目录还没到达：先不判定「一台都没配对」（避免闪现错误引导）。
          <div className="info-banner">{t("i18n.loading")}</div>
        ) : machineList.length === 0 ? (
          // 一台都没配对：给出准确入口（顶部「环境」菜单 →「本地机器」配对）。
          <div className="info-banner">{t("sessions.machineReconnectNoMachines")}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("sessions.machinePickMachine")}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {machineList.map((machine) => {
                const checked = machine.machineId === selected;
                return (
                  <label
                    key={machine.machineId}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "8px 10px",
                      borderRadius: 8,
                      border: `1px solid ${checked ? "var(--accent)" : "var(--border)"}`,
                      background: "var(--bg)",
                      color: "var(--text)",
                      cursor: "pointer",
                      opacity: machine.online ? 1 : 0.7,
                    }}
                  >
                    <input
                      type="radio"
                      name="reconnect-machine"
                      value={machine.machineId}
                      checked={checked}
                      onChange={() => setSelected(machine.machineId)}
                    />
                    <span
                      aria-hidden="true"
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 999,
                        flexShrink: 0,
                        background: machine.online ? "var(--success)" : "#9ca3af",
                        boxShadow: machine.online ? "0 0 6px var(--success)" : "none",
                      }}
                    />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 600 }}>{machineDisplayName(machine)}</span>
                      {machine.hostname && machine.hostname !== machineDisplayName(machine) ? (
                        <span
                          style={{
                            marginLeft: 8,
                            fontSize: 11,
                            color: "var(--text-dim)",
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          {machine.hostname}
                        </span>
                      ) : null}
                    </span>
                    {machine.online ? (
                      <span style={{ fontSize: 11, color: "var(--success)" }}>{t("sessions.machineOnline")}</span>
                    ) : (
                      <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("sessions.machineOffline")}</span>
                    )}
                  </label>
                );
              })}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("sessions.machineReconnectPickHint")}</div>
            {selectedMachine && !selectedMachine.online && (
              // 离线：能选、能看到，但保存按钮禁用（目录无法在目标机器上校验）。
              <div style={{ fontSize: 11, color: "var(--warning, #f59e0b)" }}>
                {t("sessions.machineOfflineNoValidate")}
              </div>
            )}
          </div>
        )}

        <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12, color: "var(--text-muted)" }}>
          {t("sessions.machineWorkdir")}
          <span style={{ display: "flex", gap: 8 }}>
            <input
              value={workdir}
              onChange={(e) => setWorkdir(e.target.value)}
              placeholder="/home/me/project"
              spellCheck={false}
              style={{ ...inputStyle, flex: 1, minWidth: 0, fontFamily: "var(--font-mono)" }}
            />
            {/* 机器在线才能浏览它的目录；离线时退化为手填（保存时服务端会报错）。 */}
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              disabled={!browseAllowed}
              style={{ ...btnStyle, opacity: browseAllowed ? 1 : 0.5 }}
            >
              {t("sessions.machineBrowseWorkdir")}
            </button>
          </span>
          {!workdir.trim() && (
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("sessions.machineWorkdirRequired")}</span>
          )}
        </label>

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} style={btnStyle}>
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            style={{
              ...btnStyle,
              background: "var(--accent)",
              color: "white",
              borderColor: "var(--accent)",
              opacity: canSubmit ? 1 : 0.5,
            }}
          >
            {busy ? t("i18n.loading") : t("sessions.machineReconnectSave")}
          </button>
        </div>
      </form>

      {pickerOpen && (
        <DirectoryPicker
          title={t("sessions.machineBrowseWorkdir")}
          initialPath={workdir.trim() || undefined}
          source={relaySource}
          onCancel={() => setPickerOpen(false)}
          onSelect={(abs) => {
            setWorkdir(abs);
            setPickerOpen(false);
          }}
        />
      )}
    </div>
  );
}

const inputStyle = {
  height: 34,
  padding: "0 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 13,
  outline: "none",
} as const;

const btnStyle = {
  height: 32,
  padding: "0 14px",
  borderRadius: 7,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text-muted)",
  fontSize: 12,
  cursor: "pointer",
} as const;
