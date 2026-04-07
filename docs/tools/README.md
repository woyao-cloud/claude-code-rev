# Yao Code 工具系统文档索引
已完成工具系统文档生成。创建了以下 4 个文档到 docs/tools/ 目录：

  生成的文档

  ┌──────────────────────────────┬──────────────────────────────────────────────────────────┐
  │             文件             │                           内容                           │
  ├──────────────────────────────┼──────────────────────────────────────────────────────────┤
  │ README.md                    │ 文档索引和快速导航                                       │
  ├──────────────────────────────┼──────────────────────────────────────────────────────────┤
  │ tool-system-architecture.md  │ 工具系统架构总览（核心概念、工具/命令注册表、工具分类）  │
  ├──────────────────────────────┼──────────────────────────────────────────────────────────┤
  │ command-execution-flow.md    │ 命令系统执行流程（命令加载、类型、执行流程、缓存管理）   │
  ├──────────────────────────────┼──────────────────────────────────────────────────────────┤
  │ execution-diagrams.md        │ 流程图和时序图（启动流程、工具执行、命令执行、权限检查） │
  ├──────────────────────────────┼──────────────────────────────────────────────────────────┤
  │ core-tools-implementation.md │ 核心工具实现详解（BashTool、AgentTool、FileEditTool 等） │
  └──────────────────────────────┴──────────────────────────────────────────────────────────┘

  文档亮点

  包含的图表:
  - ASCII 流程图（系统启动、工具执行、命令执行、权限检查）
  - DOT 格式决策树和流程图
  - Mermaid 时序图
  - 调用时序图（完整工具执行生命周期）

  涵盖的核心模块:
  - 工具注册表 (src/tools.ts)
  - 命令注册表 (src/commands.ts)
  - 查询引擎 (src/query.ts, src/QueryEngine.ts)
  - 工具编排 (src/services/tools/toolOrchestration.ts)
  - 流式执行器 (src/services/tools/StreamingToolExecutor.ts)

  详细分析的工具:
  - BashTool（命令解析、AST 分析、权限检查）
  - AgentTool（同步/异步执行、队友模式、工作树隔离）
  - FileEditTool（diff 生成、文件历史）
  - FileReadTool（编码检测、图片处理）
  - SkillTool（技能发现和展开）
本目录包含 Yao Code 工具系统和命令系统的详细文档。

---

## 文档列表

| 文档 | 描述 |
|------|------|
| [tool-system-architecture.md](./tool-system-architecture.md) | 工具系统架构总览，包含核心概念、工具注册表、命令注册表 |
| [command-execution-flow.md](./command-execution-flow.md) | 命令系统执行流程详解，包含命令加载、类型、执行流程 |
| [execution-diagrams.md](./execution-diagrams.md) | 完整流程图和调用时序图（ASCII 和 Mermaid 格式） |
| [core-tools-implementation.md](./core-tools-implementation.md) | 核心工具实现详解（BashTool, AgentTool, FileEditTool 等） |

---

## 快速导航

### 想了解系统整体架构？
→ 阅读 [tool-system-architecture.md](./tool-system-architecture.md)

### 想了解命令如何执行？
→ 阅读 [command-execution-flow.md](./command-execution-flow.md)

### 想查看流程图和时序图？
→ 阅读 [execution-diagrams.md](./execution-diagrams.md)

### 想了解具体工具实现？
→ 阅读 [core-tools-implementation.md](./core-tools-implementation.md)

---

## 核心文件索引

### 工具系统核心文件

| 文件 | 描述 |
|------|------|
| `src/Tool.ts` | 工具类型定义和 `buildTool` 函数 |
| `src/tools.ts` | 工具注册表，`getAllBaseTools()`, `getTools()`, `assembleToolPool()` |
| `src/services/tools/toolOrchestration.ts` | 工具编排，`runTools()` |
| `src/services/tools/toolExecution.ts` | 工具执行，`runToolUse()` |
| `src/services/tools/StreamingToolExecutor.ts` | 流式工具执行器 |

### 命令系统核心文件

| 文件 | 描述 |
|------|------|
| `src/commands.ts` | 命令注册表，`getCommands()`, `findCommand()` |
| `src/types/command.ts` | 命令类型定义 |
| `src/replLauncher.tsx` | REPL 启动和输入处理 |

### 查询执行核心文件

| 文件 | 描述 |
|------|------|
| `src/query.ts` | 查询执行核心逻辑 |
| `src/QueryEngine.ts` | 查询引擎类 |
| `src/bootstrap-entry.ts` | 启动入口点 |
| `src/main.tsx` | 主程序入口 |

---

## 工具分类

### 基础工具 (10+)
- `BashTool` - Shell 命令执行
- `FileReadTool` - 文件读取
- `FileEditTool` - 文件编辑 (diff 模式)
- `FileWriteTool` - 文件写入
- `GlobTool` - 文件模式搜索
- `GrepTool` - 内容正则搜索

### 高级工具 (15+)
- `AgentTool` - 子代理执行
- `SkillTool` - 技能调用
- `TaskCreateTool` - 任务创建
- `TaskUpdateTool` - 任务更新
- `TaskListTool` - 任务列表
- `WebSearchTool` - 网络搜索
- `LSPTool` - 语言服务器协议

### 计划和工作树工具
- `EnterPlanModeTool` - 进入计划模式
- `ExitPlanModeV2Tool` - 退出计划模式
- `EnterWorktreeTool` - 创建工作树
- `ExitWorktreeTool` - 退出工作树

### MCP 工具
- `ListMcpResourcesTool` - 列出 MCP 资源
- `ReadMcpResourceTool` - 读取 MCP 资源

---

## 命令分类

### 内置命令 (builtin)
位于 `src/commands/` 目录：
- `/help` - 帮助信息
- `/clear` - 清除历史
- `/config` - 配置管理
- `/skills` - 技能管理
- `/tasks` - 任务管理
- `/memory` - 记忆管理
- `/mcp` - MCP 服务器管理
- `/login` / `/logout` - 认证管理

### 技能命令 (skills)
- 位于 `./.claude/skills/`
- 用户自定义技能

### 插件命令 (plugin)
- 位于 `./.claude/plugins/`
- 插件提供的命令

---

## 架构图预览

### 工具执行流程

```
模型响应 (含 tool_use)
    │
    ▼
StreamingToolExecutor.addTool()
    │
    ▼
processQueue() ──┬── 并发安全工具 → 并行执行
                 │
                 └── 非并发工具 → 串行执行
                        │
                        ▼
              runToolUse()
                  ├── validateInput()
                  ├── checkPermissions()
                  ├── canUseTool()
                  └── tool.call()
                        │
                        ▼
                  ToolResult → 新消息 → 下一轮查询
```

### 命令执行流程

```
用户输入 /command
    │
    ▼
REPL 识别命令类型
    │
    ├── prompt 类型 → getPromptForCommand() → 发送给模型
    │
    ├── local 类型 → call() → 文本输出
    │
    └── local-jsx 类型 → call() → Ink UI
```

---

## 版本信息

- **项目版本**: 999.0.0-restored
- **文档版本**: 1.0.0
- **最后更新**: 2026-04-01
- **构建工具**: Bun 1.3.5+

---

## 相关文档

- [项目主文档](../../README.md)
- [CLAUDE.md](../../CLAUDE.md) - 项目结构说明

---

*本目录文档由 brainstorming 技能生成*
