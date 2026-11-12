# workspace-probe（示例扩展）

演示第三方扩展如何通过 pi-web 的 `WorkspaceOperations` v1 事件桥操作**当前会话的工作区**，不接触 SSH 密码、relay token 或平台 API key。

## 安装

把它放进项目的配置目录，然后刷新/新开会话：

```bash
<project>/.pi/extensions/workspace-probe/
  package.json
  index.ts
```

项目需要处于受信任状态（扩展代码会在 pi-web 会话进程中加载）。

## 工具

`workspace_probe` 参数：

- `path?`：工作区相对路径或工作区内绝对路径，默认根目录；
- `command?`：可选，在当前工作区执行并返回 stdout/stderr/exitCode。

返回内容：`capabilities` + `stat`，目录附带 `readdir`，小文件附带 UTF-8 文本，命令附带 `exec` 结果。大于 1 MiB 的文件不会内联读取。

## 行为边界

- 仅 pi-web 托管的会话有桥；纯 pi CLI 会返回 `workspace request timed out` 或明确的 UNSUPPORTED 错误。
- 桥只返回最终 `exec` 结果，不流式；单次传输上限 32 MiB。
- 路径围栏由宿主 provider 执行（host/sandbox/local-machine/SSH 各自不同），扩展不要自己拼远端路径。
- v1 没有 per-extension ACL：会话里加载的其他扩展也能发同样的请求。

协议与完整契约见上一级目录的 [`remote-workspace.md`](../../references/remote-workspace.md)。
