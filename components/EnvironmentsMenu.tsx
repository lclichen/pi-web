"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useRelayAgent } from "@/hooks/useRelayAgent";
import { LocalMachinesDialog } from "./relay/ConnectLocalMachine";

/**
 * 顶栏「环境」入口：把原先三个平铺的顶栏按钮（连接本地机器 / 我的
 * 工作区 / 沙箱容器）收纳为一个下拉菜单。本地机器条目自带 relay 在线
 * 状态；我的工作区与沙箱容器仍由 AppShell 的既有对话框承载（登录后
 * 可见），此处仅负责入口。
 */
export function EnvironmentsMenu({
  signedIn,
  onOpenWorkspace,
  onOpenSandbox,
}: {
  /** 工作区/沙箱容器条目需要登录态（与原顶栏按钮的 webUser 门控一致）。 */
  signedIn: boolean;
  onOpenWorkspace: () => void;
  onOpenSandbox: () => void;
}) {
  const { t } = useI18n();
  const { online, ready, machines } = useRelayAgent();
  const [menuOpen, setMenuOpen] = useState(false);
  const [machinesOpen, setMachinesOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  // 点击菜单外或按 Esc 关闭（菜单自身的 Esc 不外泄）。
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const machineCount = machines?.length ?? 0;

  const items: Array<{
    key: string;
    title: string;
    desc: string;
    icon: React.ReactNode;
    badge?: React.ReactNode;
    onSelect: () => void;
  }> = [
    {
      key: "machines",
      title: t("relay.localMachine"),
      desc: t("app.environmentsMachinesDesc"),
      icon: (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="2" y="4" width="20" height="12" rx="2" />
          <line x1="8" y1="20" x2="16" y2="20" />
          <line x1="12" y1="16" x2="12" y2="20" />
        </svg>
      ),
      badge: (
        <>
          {machineCount > 1 && <span className="env-menu-badge">×{machineCount}</span>}
          <span
            className={`env-menu-dot${online ? " is-online" : ""}`}
            aria-label={online ? t("relay.localMachine") : t("relay.connectLocalMachine")}
          />
        </>
      ),
      onSelect: () => {
        setMenuOpen(false);
        setMachinesOpen(true);
      },
    },
    ...(signedIn
      ? [
          {
            key: "workspace",
            title: t("app.myWorkspace"),
            desc: t("app.environmentsWorkspaceDesc"),
            icon: (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25" />
                <polyline points="8 16 12 12 16 16" />
                <line x1="12" y1="12" x2="12" y2="21" />
              </svg>
            ),
            onSelect: () => {
              setMenuOpen(false);
              onOpenWorkspace();
            },
          } as const,
          {
            key: "sandbox",
            title: t("app.sandboxContainer"),
            desc: t("app.environmentsSandboxDesc"),
            icon: (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
            ),
            onSelect: () => {
              setMenuOpen(false);
              onOpenSandbox();
            },
          } as const,
        ]
      : []),
  ];

  return (
    <div ref={anchorRef} className="env-menu-anchor">
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        title={t("app.environments")}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          height: "100%",
          padding: "0 12px",
          background: "none",
          border: "none",
          borderTop: "2px solid transparent",
          borderRight: "1px solid var(--border)",
          color: online ? "var(--text)" : "var(--text-muted)",
          cursor: "pointer",
          fontSize: 11,
          whiteSpace: "nowrap",
          flexShrink: 0,
          transition: "color 0.1s, background 0.1s",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = "var(--text)";
          e.currentTarget.style.background = "var(--bg-hover)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = online ? "var(--text)" : "var(--text-muted)";
          e.currentTarget.style.background = "none";
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: ready ? (online ? "var(--success)" : "#9ca3af") : "#6b7280",
            boxShadow: online ? "0 0 6px var(--success)" : "none",
          }}
        />
        <span>{t("app.environments")}</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{ transform: menuOpen ? "rotate(180deg)" : "none", transition: "transform 0.12s" }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {menuOpen && (
        <div role="menu" aria-label={t("app.environments")} className="env-menu-popover">
          {items.map((item) => (
            <button key={item.key} type="button" role="menuitem" className="env-menu-item" onClick={item.onSelect}>
              <span className="env-menu-item-icon">{item.icon}</span>
              <span className="env-menu-item-text">
                <span className="env-menu-item-title">{item.title}</span>
                <span className="env-menu-item-desc">{item.desc}</span>
              </span>
              {"badge" in item && item.badge}
            </button>
          ))}
        </div>
      )}

      <LocalMachinesDialog open={machinesOpen} onClose={() => setMachinesOpen(false)} />
    </div>
  );
}
