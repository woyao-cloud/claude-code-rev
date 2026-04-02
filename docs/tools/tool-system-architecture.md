# Claude Code 工具系统架构文档

## 概述

本文档详细描述了 Claude Code 的工具系统（Tool System）和命令系统（Command System）的架构设计、执行流程及代码调用过程。

**版本**: 999.0.0-restored  
**最后更新**: 2026-04-01

---

## 目录

1. [核心概念](#核心概念)
2. [工具系统架构](#工具系统架构)
3. [命令系统架构](#命令系统架构)
4. [执行流程详解](#执行流程详解)
5. [调用时序图](#调用时序图)
6. [核心工具实现](#核心工具实现)

---

## 核心概念

### 工具（Tool）

工具是模型可以调用的能力单元，每个工具提供特定的功能。工具定义在 `src/Tool.ts` 中：

```typescript
export type Tool<Input, Output, Progress> = {
  name: string                              // 工具名称
  description: (...) => Promise<string>     // 工具描述
  inputSchema: z.ZodType                    // 输入参数 Schema
  outputSchema?: z.ZodType                  // 输出参数 Schema
  call: (...) => Promise<ToolResult>        // 执行方法
  isConcurrencySafe: (...) => boolean       // 是否可并发执行
  isReadOnly: (...) => boolean              // 是否只读操作
  checkPermissions: (...) => Promise<PermissionResult>  // 权限检查
  // ... 更多方法
}
```

### 命令（Command）

命令是用户通过斜杠（`/`）触发的功能，分为三种类型：

```typescript
export type Command = {
  name: string
  type: 'prompt' | 'local' | 'local-jsx'
  description: string
  source: 'builtin' | 'plugin' | 'bundled' | 'skills'
  // prompt 类型：展开为文本发送给模型
  // local 类型：本地执行产生文本输出
  // local-jsx 类型：渲染 Ink UI 组件
}
```

---

## 工具系统架构

### 工具注册表 (`src/tools.ts`)

工具注册表负责组装和管理所有可用工具：

```
src/tools.ts
├── getAllBaseTools()          # 获取所有基础工具
├── getTools()                 # 获取当前上下文允许的工具
├── assembleToolPool()         # 组装内置工具和 MCP 工具
├── getMergedTools()           # 获取合并后的工具列表
└── filterToolsByDenyRules()   # 根据拒绝规则过滤工具
```

### 工具分类

| 类别 | 工具数 | 示例 |
|------|--------|------|
| **基础工具** | 10+ | BashTool, FileReadTool, FileEditTool, FileWriteTool, GlobTool, GrepTool |
| **高级工具** | 15+ | AgentTool, SkillTool, TaskCreateTool, WebSearchTool, LSPTool |
| **MCP 工具** | 动态 | ListMcpResourcesTool, ReadMcpResourceTool |
| **计划工具** | 2 | EnterPlanModeTool, ExitPlanModeV2Tool |
| **工作树工具** | 2 | EnterWorktreeTool, ExitWorktreeTool |
| **条件工具** | 10+ | 根据 feature flag 启用（如 REPLTool, MonitorTool 等） |

### 工具接口定义

```typescript
// src/Tool.ts:362-695
export type Tool<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = {
  // 基本属性
  name: string
  aliases?: string[]
  searchHint?: string
  
  // 核心方法
  call(args, context, canUseTool, parentMessage, onProgress): Promise<ToolResult>
  description(input, options): Promise<string>
  
  // Schema
  inputSchema: Input
  outputSchema?: z.ZodType
  
  // 能力检查
  isEnabled(): boolean
  isConcurrencySafe(input): boolean
  isReadOnly(input): boolean
  isDestructive?(input): boolean
  
  // 权限
  checkPermissions(input, context): Promise<PermissionResult>
  validateInput?(input, context): Promise<ValidationResult>
  
  // UI 渲染
  renderToolUseMessage(input, options): React.ReactNode
  renderToolResultMessage(content, progressMessages, options): React.ReactNode
  renderToolUseProgressMessage?(progressMessages, options): React.ReactNode
  
  // 进度和状态
  getActivityDescription?(input): string | null
  getToolUseSummary?(input): string | null
  
  // ... 更多方法
}
```

---

## 命令系统架构

### 命令注册表 (`src/commands.ts`)

```
src/commands.ts
├── COMMANDS (memoized)        # 内置命令列表
├── getCommands()              # 获取所有可用命令
├── getSkillToolCommands()     # 获取技能工具命令
├── getSlashCommandToolSkills() # 获取斜杠命令技能
├── builtInCommandNames        # 内置命令名称集合
└── REMOTE_SAFE_COMMANDS       # 远程模式安全命令
```

### 命令类型

| 类型 | 描述 | 示例 |
|------|------|------|
| `prompt` | 展开为文本发送给模型 | `/skills`, `/review` |
| `local` | 本地执行，产生文本输出 | `/help`, `/version` |
| `local-jsx` | 渲染 Ink UI 组件 | `/config`, `/tasks` |

### 命令加载流程

```
getCommands(cwd)
├── loadAllCommands(cwd) [memoized]
│   ├── getSkills(cwd)
│   │   ├── getSkillDirCommands()
│   │   ├── getPluginSkills()
│   │   ├── getBundledSkills()
│   │   └── getBuiltinPluginSkills()
│   ├── getPluginCommands()
│   └── getWorkflowCommands()
├── meetsAvailabilityRequirement()  # 检查可用性
├── isCommandEnabled()              # 检查是否启用
└── 插入 dynamic skills
```

---

## 执行流程详解

### 1. 系统启动流程

```
src/bootstrap-entry.ts
├── --version 快速路径
├── --dump-system-prompt 快速路径
├── --daemon 快速路径
└── 完整 CLI 加载
    └── src/entrypoints/cli.tsx
        └── src/main.tsx
            ├── init() 初始化
            ├── launchRepl() 启动 REPL
            └── QueryEngine 创建
```

### 2. 工具执行流程

```
query.ts (query 函数)
├── buildQueryConfig()
├── normalizeMessagesForAPI()
├── SDK API 调用
├── 接收流式响应
│   └── StreamingToolExecutor
│       ├── addTool() 添加工具到队列
│       ├── processQueue() 处理队列
│       └── executeTool() 执行工具
│           └── runToolUse() (toolExecution.ts)
│               ├── validateInput() 验证输入
│               ├── checkPermissions() 检查权限
│               ├── canUseTool() 最终确认
│               └── tool.call() 执行工具
└── 生成结果消息
```

### 3. 工具编排流程 (`src/services/tools/toolOrchestration.ts`)

```typescript
async function* runTools(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdate>
```

**执行策略**:

1. **分区（Partition）**: 将工具调用分为并发安全批次和非并发批次
2. **并发执行**: 并发安全工具可并行执行
3. **串行执行**: 非并发工具顺序执行

```
partitionToolCalls()
├── 遍历 toolUseMessages
├── 检查每个工具的 isConcurrencySafe()
└── 生成 Batch[]
    ├── { isConcurrencySafe: true, blocks: [...] }   // 并发批次
    └── { isConcurrencySafe: false, blocks: [...] }  // 串行批次
```

### 4. 命令执行流程

```
用户输入 /command
├── REPL.tsx 处理输入
│   ├── isSlashCommand() 识别命令
│   └── getCommand() 查找命令定义
├── 根据命令类型执行
│   ├── prompt 类型
│   │   └── getPromptForCommand() → 发送给模型
│   ├── local 类型
│   │   └── call() → 本地执行 → 输出文本
│   └── local-jsx 类型
│       └── call() → 渲染 Ink 组件
└── 显示结果
```

---

## 调用时序图

### 完整工具执行时序

```
┌─────┐  ┌───────────┐  ┌─────────────┐  ┌────────────────┐  ┌──────────┐  ┌──────┐
│用户 │  │QueryEngine│  │SDK/API Client│  │StreamingToolExecutor│  │Tool    │  │Hook  │
└──┬──┘  └─────┬─────┘  └──────┬──────┘  └───────┬────────┘  └────┬─────┘  └──┬───┘
   │          │                │                 │                │           │
   │ 1.提交消息 │                │                 │                │           │
   │─────────>│                │                 │                │           │
   │          │                │                 │                │           │
   │          │ 2.构建查询配置  │                 │                │           │
   │          │───────────────>│                 │                │           │
   │          │                │                 │                │           │
   │          │ 3.发送 API 请求  │                 │                │           │
   │          │───────────────>│                 │                │           │
   │          │                │                 │                │           │
   │          │ 4.流式响应      │                 │                │           │
   │          │<───────────────│                 │                │           │
   │          │                │                 │                │           │
   │          │ 5.检测 tool_use │                 │                │           │
   │          │────────────────────────────────>│                │           │
   │          │                │                 │                │           │
   │          │                │                 │ 6.addTool()    │           │
   │          │                │                 │───────────────>│           │
   │          │                │                 │                │           │
   │          │                │                 │ 7.processQueue()           │
   │          │                │                 │───────────────>│           │
   │          │                │                 │                │           │
   │          │                │                 │ 8.执行工具     │           │
   │          │                │                 │───────────────>│           │
   │          │                │                 │                │           │
   │          │                │                 │                │ 9.PreToolUse Hook
   │          │                │                 │                │──────────>│
   │          │                │                 │                │           │
   │          │                │                 │                │ 10.验证输入│
   │          │                │                 │                │──────────>│
   │          │                │                 │                │           │
   │          │                │                 │                │ 11.权限检查│
   │          │                │                 │                │──────────>│
   │          │                │                 │                │           │
   │          │                │                 │                │ 12.canUseTool
   │          │                │                 │                │──────────>│
   │          │                │                 │                │           │
   │          │                │                 │                │ 13.tool.call()
   │          │                │                 │                │──────────>│
   │          │                │                 │                │           │
   │          │                │                 │ 14.返回结果    │           │
   │          │                │                 │<───────────────│           │
   │          │                │                 │                │           │
   │          │                │                 │ 15.生成消息    │           │
   │          │                │                 │───────────────>│           │
   │          │                │                 │                │           │
   │          │ 16.工具结果    │                 │                │           │
   │          │<────────────────────────────────│                │           │
   │          │                │                 │                │           │
   │          │ 17.下一轮迭代  │                 │                │           │
   │          │───────────────>│                 │                │           │
   │          │                │                 │                │           │
   │ 18.最终结果│                │                 │                │           │
   │<─────────│                │                 │                │           │
   │          │                │                 │                │           │
```

### 命令执行时序

```
┌─────┐  ┌────────┐  ┌───────────┐  ┌─────────────┐
│用户 │  │REPL    │  │Command    │  │Command Call │
└──┬──┘  └───┬────┘  └─────┬─────┘  └──────┬──────┘
   │        │              │               │
   │ /help  │              │               │
   │───────>│              │               │
   │        │              │               │
   │        │ 查找命令     │               │
   │        │─────────────>│               │
   │        │              │               │
   │        │ 根据类型执行 │               │
   │        │─────────────>│               │
   │        │              │               │
   │        │              │ call()        │
   │        │              │──────────────>│
   │        │              │               │
   │        │              │ 渲染/执行     │
   │        │              │<──────────────│
   │        │              │               │
   │        │ 显示结果     │               │
   │<───────│              │               │
   │        │              │               │
```

---

## 核心工具实现

### BashTool (`src/tools/BashTool/BashTool.tsx`)

**功能**: 执行 shell 命令

**核心方法**:
- `call()`: 执行命令，支持超时、后台任务
- `isSearchOrReadCommand()`: 识别搜索/读取命令以折叠显示
- `checkPermissions()`: 权限检查（路径、危险命令）

**特性**:
- 支持命令解析和 AST 分析
- 自动识别搜索/读取/列表命令
- 支持硬链接创建（复制大文件优化）
- 支持沙箱执行

### AgentTool (`src/tools/AgentTool/AgentTool.tsx`)

**功能**: 启动子代理执行任务

**核心方法**:
- `call()`: 创建子代理会话
- `runAsyncAgent()`: 异步代理执行
- `spawnTeammate()`: 队友模式（多代理协作）

**特性**:
- 支持前台/后台模式
- 支持工作树隔离
- 支持远程执行
- 进度追踪和通知

### FileEditTool (`src/tools/FileEditTool/FileEditTool.ts`)

**功能**: 文件编辑（diff 模式）

**核心方法**:
- `call()`: 应用编辑
- `isReadOnly()`: 检查是否只读
- `checkPermissions()`: 路径权限检查

### SkillTool (`src/tools/SkillTool/SkillTool.ts`)

**功能**: 技能调用

**核心方法**:
- `call()`: 展开技能为 prompt
- 支持技能发现和推荐

---

## 相关文件索引

| 文件 | 内容 |
|------|------|
| `src/Tool.ts` | 工具类型定义和构建函数 |
| `src/tools.ts` | 工具注册表和组装逻辑 |
| `src/commands.ts` | 命令注册表和加载逻辑 |
| `src/query.ts` | 查询执行核心逻辑 |
| `src/QueryEngine.ts` | 查询引擎类 |
| `src/services/tools/toolOrchestration.ts` | 工具编排 |
| `src/services/tools/toolExecution.ts` | 工具执行 |
| `src/services/tools/StreamingToolExecutor.ts` | 流式工具执行器 |
| `src/replLauncher.tsx` | REPL 启动器 |
| `src/main.tsx` | 主程序入口 |

---

## 附录：工具列表

### 内置工具完整列表

```typescript
// src/tools.ts:193-250
getAllBaseTools() returns:
- AgentTool
- TaskOutputTool
- BashTool
- GlobTool, GrepTool (如果未嵌入)
- ExitPlanModeV2Tool
- FileReadTool
- FileEditTool
- FileWriteTool
- NotebookEditTool
- WebFetchTool
- TodoWriteTool
- WebSearchTool
- TaskStopTool
- AskUserQuestionTool
- SkillTool
- EnterPlanModeTool
- ConfigTool (ant only)
- TungstenTool (ant only)
- LSPTool (如果启用)
- EnterWorktreeTool, ExitWorktreeTool (如果启用)
- SendMessageTool
- ListPeersTool (如果启用)
- TeamCreateTool, TeamDeleteTool (如果启用)
- REPLTool (ant only)
- WorkflowTool (如果启用)
- SleepTool (如果启用)
- Cron 工具 (如果启用)
- RemoteTriggerTool (如果启用)
- MonitorTool (如果启用)
- BriefTool
- SendUserFileTool (如果启用)
- PushNotificationTool (如果启用)
- SubscribePRTool (如果启用)
- PowerShellTool (如果启用)
- SnipTool (如果启用)
- ListMcpResourcesTool
- ReadMcpResourceTool
- ToolSearchTool (如果启用)
```

---

*文档生成时间：2026-04-01*
