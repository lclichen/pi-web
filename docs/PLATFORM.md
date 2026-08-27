# 平台总体设计（架构 · 关系 · 管线 · 流程）

> 面向介绍/展示的单一入口文档。所有图为 Mermaid，可在 GitHub / Typora / VS Code 直接渲染。
> 配套运维文档：[DEPLOYMENT.md](./DEPLOYMENT.md)。

平台由三个仓库协作，构成一个多用户的"AI 编程实验教学"环境：学生在 Web 里建项目、开会话，
Agent 在**沙箱容器内**（或学生自己的电脑上）读写文件、执行命令；教师/管理员通过镜像、配额、
教学面板控制环境。

| 仓库 | 角色 | 技术栈 |
| --- | --- | --- |
| `pi-web` | WebUI + BFF（会话编排、项目管理、文件/终端代理） | Next.js 16, pi SDK 0.83 |
| `sandbox-platform` | 沙箱容器管理 API（容器生命周期/配额/快照/云盘/PTY） | Node 22（TS 类型剥离直跑）+ Express + SQLite |
| `pi-sandbox-extension` | pi 的工具桥接扩展（bash/read/write 路由进容器） | TypeScript（pi 扩展协议） |

---

## 1. 总体架构

```mermaid
flowchart TB
    subgraph Client[" 🖥️ 学生浏览器 "]
        UI["Next.js 前端<br/>会话 / 文件 / 终端 / Git / 计划"]
    end

    subgraph PIWEB[" pi-web (BFF) :30141 "]
        direction TB
        AUTH["多用户认证<br/>PI_WEB_AUTH=on"]
        RPCM["RPC 会话管理器<br/>AgentSessionWrapper 注册表"]
        AGENT["Agent 引擎会话<br/>pi SDK createAgentSessionServices"]
        RT["remote-terminal / remotefs<br/>终端与文件反向代理"]
        PROJ["projects / homes 管理<br/>.pi 配置层写入"]
    end

    subgraph EXT[" 项目 home 的 .pi/extensions/ "]
        SBX["pi-sandbox-extension<br/>bash/read/write → 容器 API"]
    end

    subgraph PLAT[" sandbox-platform :3000 "]
        APIv1["REST /api/v1/*<br/>containers·images·snapshots·workspaces·quota"]
        PTY["PTY WebSocket 桥<br/>GET /containers/:id/pty"]
        QS["配额服务<br/>resource_quotas + images.max_per_user"]
        DB[("SQLite<br/>users/containers/<br/>snapshots/workspaces…")]
    end

    subgraph HOSTL["宿主机（Apptainer）"]
        C1["容器 sb-xxxx<br/>/workspace 数据层"]
        C2["容器 …每个项目一个"]
    end

    RELAY["本机 Agent（Go relay）<br/>学生自己电脑 :30142"]

    UI -->|"cookie 会话"| AUTH
    UI -->|"REST/WebSocket"| RT
    AUTH --> RPCM --> AGENT
    AGENT -. "扩展自动发现<br/><cwd>/.pi/extensions/" .-> SBX
    PROJ -->|"写配置层"| SBX
    SBX -->|"工具调用<br/>(sk_ API key)"| APIv1
    RT -->|"admin WebSocket"| PTY
    AUTH -->|"登录代理 + 铸造 sk_"| APIv1
    APIv1 --> QS --> DB
    APIv1 --> DB
    PTY --> C1
    APIv1 --> C1 & C2
    UI -.->|"本机模式（可选）"| RELAY
    RELAY -.-> RPCM
```

要点：

- **浏览器只跟 pi-web 说话**。平台凭证（JWT/sk_ key）从不进入前端——经典的 BFF 边界。
- **沙盒扩展是"数据面"**：模型发出 bash/read/write 后，扩展直接拿项目凭证打容器 API；
  pi-web 是"控制面"（创建/绑定容器、开户、配额）。
- 三条互相独立的可信边界：WebUI 账号（= 平台账号的代理）、平台资源所有权、pi 会话归属。

## 2. 身份与多租户模型

```mermaid
flowchart LR
    subgraph Platform["sandbox-platform 用户域"]
        PUser["users 表<br/>id=1 admin…"]
        PKey["api_keys<br/>长寿命 sk_ 凭证"]
        Quota["resource_quotas<br/>max_containers/cpu/mem/disk…<br/>allowed_image_ids 白名单"]
        PUser -->|"quota_id"| Quota
    end

    subgraph Piweb["pi-web 会话域"]
        Cookie["HttpOnly cookie<br/>(登录时铸造 sk_)"]
        Reg["运行时注册表<br/>(sessionId → ownerId+mode)"]
        Meta["session-metas.json<br/>(持久侧车: mode/owner/projectId)"]
        Proj["projects.json<br/>ownerId → 项目 → containerId"]
    end

    Browser["浏览器"] -->|"login 代理到 /auth/login"| PUser
    Browser -.-> Cookie
    Cookie --> Reg
    Cookie --> Meta
    Cookie --> Proj
    PUser --- PKey --- Cookie
```

- **登录即代理**：`POST /api/webauth/login` 把用户名密码转交平台 `/auth/login`，成功后为该用户
  铸造一枚长寿命 `sk_` API key 存入 WebUI 会话——之后所有 BFF→平台调用都用它。
- **会话三重账本**：运行时注册表（最权威，重启即空）＞ session-metas.json（进程间共享，mtime 失效重载）
  ＞ URL 参数。`resolveRemoteSession` 按 owner→meta 顺序解析模式与归属，拒绝跨用户访问。
- **两层权限检查**：任何 `remotefs/remoteterminal/remotetools` 请求都要过
  `requireUserIdentity`（谁）＋ `resolveRemoteSession`（这个会话是不是你的、什么模式、用哪个容器）。

## 3. 数据布局：两套文件系统

平台刻意区分「**配置层**」和「**数据层**」，这是理解一切 I/O 行为的钥匙：

```mermaid
flowchart TB
    subgraph ServerFs["🖥️ pi-web 服务器文件系统（配置层）"]
        HOME["项目 home<br/>data/homes/sandbox/u&lt;uid&gt;/&lt;projectId&gt;/"]
        subgraph DotPi[".pi/ （唯一真实存在的东西）"]
          SETT["settings.json 会话配置"]
          EXTL["extensions/pi-sandbox-extension<br/>→ 软链接到扩展安装处"]
          SBCFG["sandbox-platform.json<br/>url / apiKey / containerId"]
        end
        HOME --- DotPi
    end

    subgraph ContainerFs["📦 容器文件系统（数据层）"]
      WS["/workspace<br/>代码、数据、学生成果"]
    end

    subgraph Sidecars["📄 中心化侧车文件（data/ 下）"]
      PJ["projects.json 项目↔容器绑定"]
      SM["session-metas.json 会话归属"]
    end

    AgentOut["🤖 模型产生的 bash/read/write"] -->|"扩展拦截后全部路由到容器"| WS
    EXTL -.->|"SDK 自动发现，任何 cwd=home 的会话都带上桥"| AgentOut
    StudentFiles["👨‍🎓 学生的作品"] <--> WS
```

设计含义：

| 事件 | 结果 |
| --- | --- |
| 新建沙盒项目 | 创建 home（含 `.pi/`），软链扩展，绑定容器 id 写入 `.pi/sandbox-platform.json` 与 projects.json |
| 新会话（cwd=home） | SDK 自动发现 `.pi/extensions/` ⇒ 无需注入即获得沙盒桥；**恢复/子智能体/分支会话同样生效** |
| 模型 `pwd` | `/workspace`（exec 带 `--pwd`，openPty 同样落在 /workspace） |
| 删容器但留快照 | 快照表带 user_id/image_id 冗余列，`ON DELETE SET NULL` —— 存档比实例活得久 |

## 4. 管线一：项目创建

```mermaid
sequenceDiagram
    autonumber
    actor U as 学生
    participant W as pi-web BFF
    participant P as sandbox-platform
    participant D as SQLite

    U->>W: POST /api/projects {name, mode, imageId?, containerId?}
    W->>W: 鉴权 + 同名检查 → createProject()
    W->>W: 建 home + .pi/（settings、扩展 symlink）

    alt 显式传了 containerId（复用已有容器）
        W->>P: GET /containers?filter=all（按凭证只看得见自己的）
        W->>W: 归属校验 + 排他校验（未被其他项目绑定）
        W->>W: updateProject(containerId)
    else 未指定 → 自动供给 provisionContainerForProject
        W->>P: 找空闲 running/stopped 容器？
        W->>P: 否则 POST /containers（imageId, workspaceId seed?）
        P->>P: 配额检查①镜像白名单②assertCanCreate③max_per_user
        P-->>W: {containerId}
    end

    W->>U: 201 {project}
    Note over W,P: 供给失败⇒删项目回滚，错误立即暴露给学生
```

复用已有容器（`containerId` 直传）是"环境复用"入口；配额中的 max_containers/max_per_user
只约束**新建**，不约束绑定既有容器（绑定时的排他性由项目层保证：一个容器只属于一个项目）。

## 5. 管线二：会话与工具执行（核心数据面）

```mermaid
sequenceDiagram
    autonumber
    actor U as 学生
    participant FE as 前端 ChatWindow
    participant BFF as pi-web BFF
    participant SES as AgentSession(RPC)<br/>cwd = 项目 home
    participant EXT as sandbox-extension<br/>(.pi/extensions/)
    participant P as 平台容器 API
    participant C as 容器 /workspace

    U->>FE: 发消息
    FE->>BFF: POST /api/agent/:id {type:"prompt",…}
    BFF->>SES: session.send(prompt)
    Note over SES: /api/agent/new 时已确定：<br/>mode=sandbox、ownerId、projectId<br/>（注册表 + metas 双记账）

    SES-->>EXT: 模型请求 bash("pytest")
    EXT->>EXT: 读 .pi/sandbox-platform.json<br/>url/apiKey/containerId
    EXT->>P: POST /containers/:id/tools/bash
    P->>C: apptainer exec --pwd /workspace instance://… bash -c pytest
    C-->>P: stdout/stderr
    P-->>EXT: JSON 结果
    EXT-->>SES: tool result
    SES-->>FE: SSE 事件流（增量文本/工具卡片）
```

强调三点：

1. **工具流量不过 BFF**——扩展持项目级凭证直连平台，pi-web 宕掉不影响已在跑的会话产物；
2. **会话注册以项目 mode 为准**（不是客户端随手传的字段），这杜绝了"刚建的沙盒会话被当成
   host 模式"整类事故；
3. 所有远端面板（remotefs 文件浏览、PlanPanel 计划读取、终端）都以
   `remoteSessionCtx = {sessionId,label}` 为单一事实来源决定走 `/api/files` 还是 `/api/remotefs`。

## 6. 管线三：交互式终端（PTY）

```mermaid
flowchart LR
    X[xterm.js] -->|input POST| SSElib["remote-terminal 库<br/>(pi-web 进程内注册表)"]
    SSElib -->|"input 帧\nJSON"| WS["WebSocket<br/>node ws"]
    WS -->|"宿主真 PTY<br/>node-pty spawn"| AP["apptainer exec<br/>--pwd /workspace<br/>instance://X bash"]
    AP -->|"输出流"| WS
    WS -->|"output/exit 帧"| SSElib
    SSElib -->|"SSE data 帧 + 心跳"| X

    PLATPTY["平台 PTY 服务<br/>WS upgrade + 计数"] --- WS

    subgraph 治理规则
      R1["PTY_MAX_PER_CONTAINER=3<br/>超出→HTTP 429"]
      R2["最后订阅者离开 60s 后回收<br/>(防页面刷新泄漏名额)"]
      R3["30min idle 清扫 + 30s ping"]
    end
```

黑屏教训沉淀成的两条不变量：**必须真 PTY**（管道模式下 bash 无提示符无回显）；**泄漏的
PTY 占用的是全容器的并发名额**，所以订阅者清零后有 60 秒宽限强制回收。

## 7. 管线四：快照（游戏存档）与云盘工作区

```mermaid
flowchart TB
    subgraph Snapshot["快照 = 整个 /workspace 的 tar.gz"]
        S1["保存 save"] -->|"cp -a overlay → 快照"| SNAP[("snapshots 表 + 文件<br/>FIFO 最多 2 份/容器")]
        S2["恢复 restore 到原容器"] -->|"换 overlay 重启"| RUN["running 容器"]
        S3["恢复 restore 到新容器"] -->|"走 create()（受所有配额约束）"| NEW["新容器 + 旧环境"]
    end

    subgraph Workspace["云盘工作区（用户级）"]
        UP["上传 upload"] --> WSDB[("workspaces 表")]
        SEED["单向 seed：建新容器时<br/>把云盘文件拷入 /workspace（一次性）"]
        EXP["导出 export：容器 /workspace → tar.gz 入云盘"]
        WSDB --- SEED
        WSDB --- EXP
    end
```

两个方向都是**显式动作**而非持续同步——保证容器内部状态对学生可预期（不会出现"后台悄悄覆盖了
我的改动"）。游戏存档制（save/restore/delete，容量 FIFO）是快照的学生视角包装。

## 8. 配额体系

```mermaid
flowchart LR
    REQ["POST /containers 请求"] --> CHK1{"镜像白名单<br/>quota.allowed_image_ids"}
    CHK1 -->|不在名单| REJ1["IMAGE_NOT_ALLOWED"]
    CHK1 --> CHK2["档位 assertCanCreate<br/>max_containers / cpu / mem / disk"]
    CHK2 -->|超限| REJ2["422 QUOTA_EXCEEDED"]
    CHK2 --> CHK3["images.max_per_user<br/>每用户×每镜像实例数"]
    CHK3 -->|超过 N| REJ3["422 QUOTA_EXCEEDED<br/>『每用户最多 N 个实例』"]
    CHK3 --> OK201["201 Created"]

    style REJ1 fill:#fee,stroke:#c00
    style REJ2 fill:#fee,stroke:#c00
    style REJ3 fill:#fee,stroke:#c00
```

- `resource_quotas` 是**用户档位**（总量型：能开几个容器、多大规格）；`images.max_per_user`
  是**模板政策**（形状型：这种镜像每人最多几个实例）。两者正交，创建前依序检查。
- 这是后续「一键启动项目模板」的地基：

| 未来模板 | 组合方式 |
| --- | --- |
| DocQA（超小容器+MCP 子智能体问答，记忆存在实例里） | 该镜像 `max_per_user=1` + 小盘默认资源 |
| CodeHelper（可运行环境×3） | `max_per_user=3` + 中等资源 |
| TemplateDevBox（开发模板用，Host 模式） | 不进沙盒域，Host 会话天然不受容器配额影响 |

落地 administration：管理员 `PATCH /api/v1/admin/images/:id {"max_per_user":1}` 即刻生效；
pi-web 建项目对话框会在镜像名上显示"（每人限 N 个实例）"，超限时平台返回的中文错误直接透出。

## 9. 部署形态

```mermaid
flowchart TB
    subgraph BuildMachine["构建机"]
        PKG["scripts/package-linux.sh<br/>探测兄弟目录三仓 → 自包含目录 + tar.gz<br/>冒烟：CLI 存活 / WebUI HTTP / 平台 /health(mock)"]
        AI["scripts/package-appimage.sh<br/>→ Amedac.ai-x64.AppImage (≈215MB)"]
        PKG --> AI
    end
    subgraph Target["目标机"]
        TARL["tar 解压目录版"]
        APPIMG["AppImage 单文件"]
        START["scripts/start-all.sh（幂等）"]
        TARL --> START
        APPIMG -->|"首启展开到 ~/.local/share/amedac/app<br/>升级保留 data/ 与 *.env"| START
        START --> SVC1["sandbox-platform :3000<br/>sqlite 自动迁移"]
        START --> SVC2["pi-web :30141<br/>next start"]
        SVC1 --> APT["需要 Apptainer(≥1.x)"]
    end
```

## 10. 已知取舍与风险清单

| 取舍 | 原因 | 影响 |
| --- | --- | ---|
| 配置层/数据层分离，不做双向同步 | 可预期性优先 | 云盘↔容器仅显式 seed/export |
| Agent 工具流量直达平台（不经 BFF） | 解耦、pi-web 故障不影响已建会话 | 平台端要独立审计（有 sessions/audit 表） |
| AppImage 首启展开 ~1GB 到用户目录 | 只读挂载内的数据无法持久 | 磁盘紧张机器建议用 tar.gz 版 |
| 运行时注册表在重启后丢失 | 内存态性能最好 | 靠 metas 侧车补账（mtime 失效重载） |
| 一个容器绑一个项目 | 两项目共用会互相踩 /workspace | 需要"同环境多项目"时先复制项目再绑同一镜像新容器 |
