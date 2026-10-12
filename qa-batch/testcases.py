"""测试用例与矩阵定义。

提示词设计原则：
  · 单轮可判定——每条都要求模型"原样汇报"关键标记，断言可机械检查；
  · 强制触发目标工具（plan/todo/Agent/MCP），不做开放式任务；
  · 禁止破坏性操作（不删不改既有文件，写入仅限任务自己的文件）。

矩阵 = 模式 × 功能 × 模型/配置组合。模式运行参数（沙盒容器、ssh/本地
项目、快速模板、MCP 工具）来自 config.json 的占位符，未填则跳过对应用例。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional

SANITY_FILE = "task.txt"
SANITY_CONTENT = "PI-QA-SANITY-7f3a 初始内容\n第二行：hello world\n第三行：计数校验行 123\n"


# ---------------------------------------------------------------- 提示词

def prompt_sanity(with_file: bool) -> str:
    if with_file:
        return (
            f"读取当前目录下的 {SANITY_FILE}，然后：1) 原样引用文件全部内容；"
            "2) 报告它有多少行、多少个字符（不含换行）。不要创建或修改任何文件。"
        )
    return (
        "运行 pwd 与 ls -l，确认当前工作目录并列出目录内容，然后汇报："
        "当前目录的绝对路径、目录里有哪几项。不要创建或修改任何文件。"
    )


PROMPT_PLAN = (
    "请先制定一个分步计划来完成以下任务：写一个 Python 脚本 wordcount.py，"
    f"统计 {SANITY_FILE} 中每个单词出现的次数并按次数降序输出。"
    "把计划用 plan 工具保存好，然后原样汇报计划的全部内容。"
    "本轮只需要计划本身，不要开始实现代码。"
)

PROMPT_TODO = (
    "用 todo 工具创建三项待办：1) 读取当前目录的文件清单；"
    f"2) 读取 {SANITY_FILE}（若不存在则统计你看到的第一个文件）；"
    "3) 汇报前两步结果。逐项执行、每完成一项就勾选一项，"
    "最后原样汇报待办清单每一项的完成状态。"
)

PROMPT_SUBAGENT = (
    "用 Agent 工具启动一个 subagent_type=general-purpose 的子智能体，任务："
    "查看当前工作目录的结构，总结里面有哪些文件和子目录，以 DONE 结尾回复。"
    "等待子智能体结束后，原样汇报它的结论。不要自己代替它去执行。"
)


def prompt_mcp(tool_name: str, server_name: str) -> str:
    return (
        f"调用 MCP 工具 {tool_name}（来自服务器 {server_name}）："
        "获取它能提供的最新信息，然后原样汇报该工具的原始返回（可截断到 200 字），"
        "并注明这是 MCP 工具的输出。如果该工具不存在，明确说明找不到这个工具名。"
    )


QUICK_PROMPT = (
    "按照你的模板设定回答：用一句话说明你能做什么，然后创建两项待办"
    "（自我介绍、结束），逐项勾选完成并汇报清单状态。"
)


# ---------------------------------------------------------------- 用例模型

@dataclass
class Case:
    case_id: str
    mode: str                 # host | sandbox | ssh | local-machine | quick
    transport: str            # batch | session
    feature: str              # sanity | plan | todo | subagent | mcp
    prompt: str
    expect_tools: List[str] = field(default_factory=list)  # 任一子串命中即过
    expect_text: List[str] = field(default_factory=list)   # 文本需含子串
    model: Optional[dict] = None                            # {provider, modelId}
    thinking_level: Optional[str] = None
    # batch 传输专用
    work_dir: Optional[str] = None
    files: Optional[Dict[str, str]] = None
    container_id: Optional[int] = None
    # session 传输专用
    project_id: Optional[str] = None
    template_id: Optional[str] = None


FEATURE_PROMPTS = {
    "sanity": lambda cfg: prompt_sanity(with_file=cfg["mode"] == "host"),
    "plan": lambda cfg: PROMPT_PLAN,
    "todo": lambda cfg: PROMPT_TODO,
    "subagent": lambda cfg: PROMPT_SUBAGENT,
}

FEATURE_TOOLS = {
    "sanity": ["read", "bash", "ls"],
    "plan": ["plan"],
    "todo": ["todo"],
    "subagent": ["Agent", "agent"],
}

FEATURE_TEXTS = {
    "sanity": [],
    "plan": ["计划"],
    "todo": [],
    "subagent": [],
}


def build_matrix(cfg: dict) -> List[Case]:
    """按 config 生成用例。模式占位符未填 → 该模式全部跳过（标记 skip）。

    矩阵规模控制：config.matrix.features 每模式选功能；
    config.models 是模型×配置组合（第一条为默认）；
    默认全部组合 × 全部功能；config.matrix.model_feature_pairs_limit 可截断。
    """
    cases: List[Case] = []
    modes_cfg = cfg.get("modes", {})
    features_cfg = cfg.get("matrix", {}).get("features", {})
    default_model = cfg.get("defaults", {}).get("model")  # {"provider","modelId"}
    default_thinking = cfg.get("defaults", {}).get("thinking_level")
    models: List[dict] = cfg.get("models") or [
        {"label": "default", "model": default_model, "thinking_level": default_thinking}
    ]
    # 占位模型（REPLACE_ 前缀）跳过——与模式占位同一规则
    models = [m for m in models
              if not str((m.get("model") or {}).get("modelId", "")).startswith("REPLACE")] or [
        {"label": "default", "model": default_model, "thinking_level": default_thinking}
    ]

    # host：batch 传输，始终可用（work_dir 有默认占位）
    host_cfg = modes_cfg.get("host", {})
    host_dir = host_cfg.get("work_dir")
    if host_dir:
        for model_combo in models:
            for feature in features_cfg.get("host", ["sanity", "plan", "todo", "subagent", "mcp"]):
                if feature == "mcp" and not _mcp_ready(cfg):
                    continue
                cases.append(_make_case("host", "batch", feature, model_combo, cfg,
                                        work_dir=host_dir,
                                        files={SANITY_FILE: SANITY_CONTENT} if feature != "sanity" or True else None))

    # sandbox：batch 传输，container_id 占位必填（数字）
    sandbox_cfg = modes_cfg.get("sandbox", {})
    container_id = sandbox_cfg.get("container_id")
    if isinstance(container_id, int):
        for model_combo in models[:1]:  # 沙盒用例贵，只跑默认模型
            for feature in features_cfg.get("sandbox", ["sanity", "todo"]):
                cases.append(_make_case("sandbox", "batch", feature, model_combo, cfg,
                                        container_id=container_id))

    # ssh / local-machine：session 传输，project_id 占位
    for mode in ("ssh", "local-machine"):
        project_id = modes_cfg.get(mode, {}).get("project_id")
        if project_id and not str(project_id).startswith("REPLACE"):
            for model_combo in models[:1]:
                for feature in features_cfg.get(mode, ["sanity", "todo", "subagent"]):
                    cases.append(_make_case(mode, "session", feature, model_combo, cfg,
                                            project_id=str(project_id)))

    # quick：session 传输，template_id（None = 服务端默认模板）
    quick_cfg = modes_cfg.get("quick", {})
    if quick_cfg.get("enabled", False):
        tid = quick_cfg.get("template_id")
        combo = models[0]
        cases.append(_make_case("quick", "session", "sanity", combo, cfg,
                                template_id=tid, prompt_override=QUICK_PROMPT))

    limit = cfg.get("matrix", {}).get("max_cases")
    if isinstance(limit, int) and limit > 0:
        cases = cases[:limit]
    return cases


def _mcp_ready(cfg: dict) -> bool:
    mcp = cfg.get("features", {}).get("mcp", {})
    tool = str(mcp.get("tool_name", ""))
    return bool(tool) and not tool.startswith("REPLACE")


def _make_case(mode: str, transport: str, feature: str, combo: dict, cfg: dict,
               work_dir=None, files=None, container_id=None, project_id=None,
               template_id=None, prompt_override=None) -> Case:
    label = str(combo.get("label", "m"))
    prompt = prompt_override if prompt_override else FEATURE_PROMPTS[feature]({"mode": mode})
    if feature == "mcp":
        mcp = cfg.get("features", {}).get("mcp", {})
        prompt = prompt_mcp(str(mcp.get("tool_name")), str(mcp.get("server_name", "default")))
    expect_tools = list(FEATURE_TOOLS.get(feature, []))
    if feature == "mcp":
        expect_tools = [str(cfg.get("features", {}).get("mcp", {}).get("tool_name"))]
    model = combo.get("model") or cfg.get("defaults", {}).get("model")
    return Case(
        case_id=f"{mode}-{feature}-{label}",
        mode=mode,
        transport=transport,
        feature=feature,
        prompt=prompt,
        expect_tools=expect_tools,
        expect_text=list(FEATURE_TEXTS.get(feature, [])),
        model=model,
        thinking_level=combo.get("thinking_level"),
        work_dir=work_dir,
        files=files,
        container_id=container_id,
        project_id=project_id,
        template_id=template_id,
    )
