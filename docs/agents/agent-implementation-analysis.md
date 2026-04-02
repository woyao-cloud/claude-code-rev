# Claude Code Agent 实现原理分析

## 1. 概述

Claude Code 的 Agent 系统是一个多层次的多代理架构，通过**工具调用**、**上下文隔离**、**消息传递**和**状态管理**实现子代理的创建、执行和协调。

### 1.1 Agent 核心能力

| 能力 | 实现机制 | 关键文件 |
|------|----------|----------|
| **工具调用** | 模型通过工具定义调用 AgentTool | `src/tools/AgentTool/` |
| **上下文隔离** | `createSubagentContext()` 创建独立 ToolUseContext | `src/utils/forkedAgent.ts` |
| **消息传递** | 消息生成器和流式传输 | `src/query.ts` |
| **状态管理** | AppState 分层存储和回调 | `src/state/` |
| **权限控制** | 权限模式继承和覆盖 | `src/utils/permissions/` |
| **MCP 集成** | 代理专属 MCP 服务器 | `src/tools/AgentTool/runAgent.ts` |

### 1.2 Agent 类型

```typescript
// src/tools/AgentTool/loadAgentsDir.ts
export type AgentDefinition =
  | BuiltInAgentDefinition    // 内置代理 (Explore, Plan, General-Purpose)
  | CustomAgentDefinition     // 用户/项目自定义代理
  | PluginAgentDefinition     // 插件提供的代理
```

**内置代理** (`src/tools/AgentTool/builtInAgents.ts`):
- `general-purpose` - 通用代理，默认执行子任务
- `explore` - 代码探索代理（只读搜索）
- `plan` - 实现规划代理（只读分析）
- `claude-code-guide` - Claude Code 使用指南
- `verification` - 验证代理（实验性）

---

## 2. 系统架构

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Claude Code Agent 系统架构                            │
└─────────────────────────────────────────────────────────────────────────────┘

  用户输入: "/agent 执行任务"
          │
          ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ 阶段 1: 工具调用 (Tool Invocation)                                        │
  │  ┌───────────────────────────────────────────────────────────────────┐  │
  │  │ AgentTool.call()                                                   │  │
  │  │ • 解析 subagent_type 参数                                          │  │
  │  │ • 从 agentDefinitions 查找代理定义                                  │  │
  │  │ • 检查 MCP 服务器要求                                                │  │
  │  │ • 检查权限规则 (Agent(x) 语法)                                      │  │
  │  └───────────────────────────────────────────────────────────────────┘  │
  └─────────────────────────────────────────────────────────────────────────┘
          │
          ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ 阶段 2: 代理启动 (Agent Launch)                                          │
  │                                                                          │
  │  ┌──────────────────────────────────────────────────────────────────┐   │
  │  │ 执行模式判断                                                      │   │
  │  │ ┌────────────┬────────────┬────────────┬────────────┐            │   │
  │  │  │  Sync    │  Async     │  Teammate  │   Fork     │            │   │
  │  │  │ (同步)    │ (后台异步)  │  (团队)    │  (缓存共享) │            │   │
  │  │  └────┬─────┴─────┬──────┴─────┬──────┴─────┬──────┘            │   │
  │  │       │          │            │            │                     │   │
  │  │       ▼          ▼            ▼            ▼                     │   │
  │  │  ┌────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐              │   │
  │  │  │runAgent│ │register  │ │spawn     │ │runForked │              │   │
  │  │  │        │ │AsyncAgent│ │Teammate  │ │Agent     │              │   │
  │  │  └────────┘ └──────────┘ └──────────┘ └──────────┘              │   │
  │  └──────────────────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────────────────┘
          │
          ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ 阶段 3: 上下文准备 (Context Preparation)                                  │
  │  ┌───────────────────────────────────────────────────────────────────┐  │
  │  │ createSubagentContext()                                            │  │
  │  │ • 克隆 readFileState (文件状态缓存)                                 │  │
  │  │ • 创建/共享 abortController                                        │  │
  │  │ • 包装 getAppState (权限控制)                                       │  │
  │  │ • 设置工具池 (resolveAgentTools)                                   │  │
  │  │ • 初始化 MCP 客户端                                                 │  │
  │  └───────────────────────────────────────────────────────────────────┘  │
  └─────────────────────────────────────────────────────────────────────────┘
          │
          ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ 阶段 4: 系统 Prompt 构建                                                  │
  │  ┌───────────────────────────────────────────────────────────────────┐  │
  │  │ getAgentSystemPrompt()                                             │  │
  │  │ • 调用 agentDefinition.getSystemPrompt()                           │  │
  │  │ • 增强环境详情 (enhanceSystemPromptWithEnvDetails)                  │  │
  │  │ • 注入工具定义                                                     │  │
  │  │ • 注入 MCP 服务器信息                                               │  │
  │  └───────────────────────────────────────────────────────────────────┘  │
  └─────────────────────────────────────────────────────────────────────────┘
          │
          ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ 阶段 5: 查询循环 (Query Loop)                                            │
  │  ┌───────────────────────────────────────────────────────────────────┐  │
  │  │ query() - 主查询函数                                                │  │
  │  │                                                                   │  │
  │  │ 1. buildEffectiveSystemPrompt() - 构建系统 prompt                  │  │
  │  │ 2. normalizeMessagesForAPI() - 规范化消息                          │  │
  │  │ 3. queryModel() - 发送 API 请求                                     │  │
  │  │ 4. runTools() - 执行工具调用                                       │  │
  │  │ 5. executePostSamplingHooks() - 执行后采样钩子                     │  │
  │  │ 6. 循环直到完成或达到 maxTurns                                     │  │
  │  └───────────────────────────────────────────────────────────────────┘  │
  └─────────────────────────────────────────────────────────────────────────┘
          │
          ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ 阶段 6: 清理与回调 (Cleanup & Callback)                                  │
  │  ┌───────────────────────────────────────────────────────────────────┐  │
  │  │ • 清理 MCP 服务器                                                  │  │
  │  │ • 清理会话钩子                                                     │  │
  │  │ • 清理文件状态缓存                                                 │  │
  │  │ • 清理 Perfetto 注册                                               │  │
  │  │ • 清理待办事项条目                                                 │  │
  │  │ • 杀死后台 bash 任务                                                │  │
  │  │ • 执行 agent callback (内置代理)                                   │  │
  │  └───────────────────────────────────────────────────────────────────┘  │
  └─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 核心组件关系图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Agent 组件关系图                                   │
└─────────────────────────────────────────────────────────────────────────────┘

                    ┌─────────────────┐
                    │   AgentTool.tsx │
                    │   (工具入口)     │
                    └────────┬────────┘
                             │
           ┌─────────────────┼─────────────────┐
           │                 │                 │
           ▼                 ▼                 ▼
    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
    │  runAgent.ts │  │forkSubagent.ts│  │spawnMultiAgent│
    │  (同步/异步)  │  │  (缓存共享)   │  │  (团队协作)   │
    └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
           │                 │                 │
           └─────────────────┼─────────────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │ forkedAgent.ts  │
                    │ (上下文创建)    │
                    │ createSubagent  │
                    │ Context()       │
                    └────────┬────────┘
                             │
           ┌─────────────────┼─────────────────┐
           │                 │                 │
           ▼                 ▼                 ▼
    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
    │ ToolUseContext│  │  AppState    │  │   query.ts   │
    │ (工具状态)    │  │ (应用状态)   │  │  (查询循环)  │
    └──────────────┘  └──────────────┘  └──────┬───────┘
                                               │
                                               ▼
                                      ┌─────────────────┐
                                      │  claude.ts      │
                                      │  (API 请求)      │
                                      └─────────────────┘
```

---

## 3. 详细代码调用流程

### 3.1 Agent 工具调用流程

```typescript
// src/tools/AgentTool/AgentTool.tsx:call()

async call(
  {
    prompt,
    subagent_type,        // 代理类型
    description,          // 任务描述
    model,                // 模型覆盖
    run_in_background,    // 后台运行
    name,                 // 代理名称 (团队模式)
    team_name,            // 团队名称
    isolation,            // 隔离模式 (worktree/remote)
    cwd,                  // 工作目录
  }: AgentToolInput,
  toolUseContext,
  canUseTool,
  assistantMessage,
  onProgress?
)
```

**调用步骤**:

1. **权限检查** (`AgentTool.tsx:254-274`)
   ```typescript
   const appState = toolUseContext.getAppState();
   const permissionMode = appState.toolPermissionContext.mode;
   ```

2. **团队模式检查** (`AgentTool.tsx:284`)
   ```typescript
   if (teamName && name) {
     //  spawnTeammate() - 团队代理
   }
   ```

3. **代理选择** (`AgentTool.tsx:322-356`)
   ```typescript
   const effectiveType = subagent_type ?? 
     (isForkSubagentEnabled() ? undefined : GENERAL_PURPOSE_AGENT.agentType);
   
   const isForkPath = effectiveType === undefined;
   
   if (isForkPath) {
     selectedAgent = FORK_AGENT;  // 缓存共享路径
   } else {
     selectedAgent = agents.find(a => a.agentType === effectiveType);
   }
   ```

4. **MCP 服务器检查** (`AgentTool.tsx:371-410`)
   ```typescript
   if (requiredMcpServers?.length) {
     // 等待 MCP 服务器连接
     // 检查服务器是否有可用工具
   }
   ```

5. **执行模式分发** (`AgentTool.tsx:500-700`)
   ```typescript
   if (isolation === 'remote') {
     // 远程执行 (CCR)
     return registerRemoteAgentTask(...);
   }
   
   if (run_in_background || selectedAgent.background) {
     // 后台异步执行
     return runAsyncAgentLifecycle(...);
   }
   
   if (isolation === 'worktree') {
     // 工作树隔离
     worktreePath = await createAgentWorktree(...);
   }
   
   // 同步执行
   const messages: Message[] = [];
   for await (const message of runAgent({ ... })) {
     messages.push(message);
   }
   ```

### 3.2 runAgent() 执行流程

```typescript
// src/tools/AgentTool/runAgent.ts

export async function* runAgent({
  agentDefinition,        // 代理定义
  promptMessages,         // prompt 消息
  toolUseContext,         // 父工具上下文
  canUseTool,             // 权限检查函数
  isAsync,                // 是否异步
  forkContextMessages,    // fork 上下文消息
  querySource,            // 查询来源
  override,               // 覆盖参数
  model,                  // 模型
  maxTurns,               // 最大回合数
  availableTools,         // 可用工具池
  allowedTools,           // 允许的工具列表
  useExactTools,          // 使用精确工具 (缓存共享)
  worktreePath,           // 工作树路径
  description,            // 任务描述
  transcriptSubdir,       // 转录子目录
  onQueryProgress,        // 进度回调
}): AsyncGenerator<Message, void>
```

**执行步骤**:

1. **初始化代理配置** (`runAgent.ts:332-498`)
   ```typescript
   // 获取代理模型
   const resolvedAgentModel = getAgentModel(
     agentDefinition.model,
     toolUseContext.options.mainLoopModel,
     model,
     permissionMode,
   );
   
   // 创建 agentId
   const agentId = override?.agentId ? override.agentId : createAgentId();
   
   // 准备用户上下文 (可能省略 CLAUDE.md)
   const shouldOmitClaudeMd = 
     agentDefinition.omitClaudeMd && 
     !override?.userContext &&
     getFeatureValue_CACHED_MAY_BE_STALE('tengu_slim_subagent_claudemd', true);
   
   // 准备系统上下文 (可能省略 gitStatus)
   const resolvedSystemContext = 
     agentDefinition.agentType === 'Explore' || 
     agentDefinition.agentType === 'Plan'
       ? systemContextNoGit : baseSystemContext;
   
   // 创建代理专用的 getAppState
   const agentGetAppState = () => {
     const state = toolUseContext.getAppState();
     // 覆盖权限模式
     // 设置 shouldAvoidPermissionPrompts
     // 设置 allowedTools
   };
   ```

2. **工具池解析** (`runAgent.ts:500-502`)
   ```typescript
   const resolvedTools = useExactTools
     ? availableTools
     : resolveAgentTools(agentDefinition, availableTools, isAsync).resolvedTools;
   ```

3. **MCP 服务器初始化** (`runAgent.ts:649-664`)
   ```typescript
   const {
     clients: mergedMcpClients,
     tools: agentMcpTools,
     cleanup: mcpCleanup,
   } = await initializeAgentMcpServers(
     agentDefinition,
     toolUseContext.options.mcpClients,
   );
   
   // 合并工具
   const allTools = agentMcpTools.length > 0
     ? uniqBy([...resolvedTools, ...agentMcpTools], 'name')
     : resolvedTools;
   ```

4. **系统 Prompt 构建** (`runAgent.ts:508-518`)
   ```typescript
   const agentSystemPrompt = override?.systemPrompt
     ? override.systemPrompt
     : asSystemPrompt(
         await getAgentSystemPrompt(
           agentDefinition,
           toolUseContext,
           resolvedAgentModel,
           additionalWorkingDirectories,
           resolvedTools,
         ),
       );
   ```

5. **创建子代理上下文** (`runAgent.ts:700-714`)
   ```typescript
   const agentToolUseContext = createSubagentContext(toolUseContext, {
     options: agentOptions,
     agentId,
     agentType: agentDefinition.agentType,
     messages: initialMessages,
     readFileState: agentReadFileState,
     abortController: agentAbortController,
     getAppState: agentGetAppState,
     shareSetAppState: !isAsync,  // 同步代理共享状态回调
     shareSetResponseLength: true,
     contentReplacementState,
   });
   ```

6. **查询循环** (`runAgent.ts:748-806`)
   ```typescript
   for await (const message of query({
     messages: initialMessages,
     systemPrompt: agentSystemPrompt,
     userContext: resolvedUserContext,
     systemContext: resolvedSystemContext,
     canUseTool,
     toolUseContext: agentToolUseContext,
     querySource,
     maxTurns: maxTurns ?? agentDefinition.maxTurns,
   })) {
     onQueryProgress?.();
     
     // 记录转录
     if (isRecordableMessage(message)) {
       await recordSidechainTranscript([message], agentId, lastRecordedUuid);
       yield message;
     }
   }
   ```

7. **清理** (`runAgent.ts:816-858`)
   ```typescript
   try {
     // ... 查询循环
   } finally {
     await mcpCleanup();              // 清理 MCP 服务器
     clearSessionHooks(rootSetAppState, agentId);  // 清理钩子
     cleanupAgentTracking(agentId);   // 清理缓存跟踪
     agentToolUseContext.readFileState.clear();  // 清理文件缓存
     initialMessages.length = 0;      // 清理消息
     unregisterPerfettoAgent(agentId); // 清理 Perfetto
     clearAgentTranscriptSubdir(agentId); // 清理转录目录
     killShellTasksForAgent(agentId, ...); // 杀死后台任务
   }
   ```

### 3.3 createSubagentContext() 详细分析

```typescript
// src/utils/forkedAgent.ts:createSubagentContext()

export function createSubagentContext(
  parentContext: ToolUseContext,
  overrides?: SubagentContextOverrides,
): ToolUseContext {
  // 1. AbortController: 显式覆盖 > 共享父 > 新建子
  const abortController =
    overrides?.abortController ??
    (overrides?.shareAbortController
      ? parentContext.abortController
      : createChildAbortController(parentContext.abortController));
  
  // 2. getAppState: 包装以设置 shouldAvoidPermissionPrompts
  const getAppState: ToolUseContext['getAppState'] = overrides?.getAppState
    ? overrides.getAppState
    : overrides?.shareAbortController
      ? parentContext.getAppState  // 交互式代理共享
      : () => {
          const state = parentContext.getAppState();
          return {
            ...state,
            toolPermissionContext: {
              ...state.toolPermissionContext,
              shouldAvoidPermissionPrompts: true,
            },
          };
        };
  
  return {
    // 可变状态 - 默认克隆以隔离
    readFileState: cloneFileStateCache(
      overrides?.readFileState ?? parentContext.readFileState,
    ),
    contentReplacementState:
      overrides?.contentReplacementState ??
      (parentContext.contentReplacementState
        ? cloneContentReplacementState(parentContext.contentReplacementState)
        : undefined),
    
    // AbortController
    abortController,
    
    // AppState 访问
    getAppState,
    setAppState: overrides?.shareSetAppState
      ? parentContext.setAppState
      : () => {},  // 默认为 no-op
    setAppStateForTasks: parentContext.setAppStateForTasks ?? parentContext.setAppState,
    
    // 突变回调 - 默认 no-op
    setInProgressToolUseIDs: () => {},
    setResponseLength: overrides?.shareSetResponseLength
      ? parentContext.setResponseLength
      : () => {},
    
    // UI 回调 - undefined (子代理无法控制父 UI)
    addNotification: undefined,
    setToolJSX: undefined,
    setStreamMode: undefined,
    
    // 可覆盖的字段
    options: overrides?.options ?? parentContext.options,
    messages: overrides?.messages ?? parentContext.messages,
    agentId: overrides?.agentId ?? createAgentId(),
    agentType: overrides?.agentType,
    
    // 查询链跟踪
    queryTracking: {
      chainId: randomUUID(),
      depth: (parentContext.queryTracking?.depth ?? -1) + 1,
    },
  };
}
```

**隔离策略**:

| 字段 | 默认行为 | 可共享选项 |
|------|----------|------------|
| `readFileState` | 克隆 | `overrides.readFileState` |
| `abortController` | 新建子控制器 | `shareAbortController: true` |
| `getAppState` | 包装 (禁止权限提示) | `shareAbortController: true` |
| `setAppState` | no-op | `shareSetAppState: true` |
| `setResponseLength` | no-op | `shareSetResponseLength: true` |
| `contentReplacementState` | 克隆 | `overrides.contentReplacementState` |

---

## 4. Fork 子代理机制

### 4.1 缓存共享原理

Fork 子代理通过**CacheSafeParams**与父代理共享 prompt 缓存：

```typescript
// src/utils/forkedAgent.ts:CacheSafeParams

export type CacheSafeParams = {
  systemPrompt: SystemPrompt;           // 系统 prompt (必须相同)
  userContext: { [k: string]: string }; // 用户上下文
  systemContext: { [k: string]: string }; // 系统上下文
  toolUseContext: ToolUseContext;       // 工具上下文
  forkContextMessages: Message[];       // 父上下文消息
}
```

**缓存命中条件**:
1. 系统 prompt 相同
2. 工具定义相同
3. 模型相同
4. 消息前缀相同
5. thinking config 相同

### 4.2 runForkedAgent() 流程

```typescript
// src/utils/forkedAgent.ts:runForkedAgent()

export async function runForkedAgent({
  promptMessages,
  cacheSafeParams,      // 缓存安全参数
  canUseTool,
  querySource,
  forkLabel,
  overrides,
  maxOutputTokens,      // 谨慎使用 - 影响缓存
  maxTurns,
  onMessage,
  skipTranscript,
  skipCacheWrite,
}: ForkedAgentParams): Promise<ForkedAgentResult>
```

**执行流程**:
1. 使用 `createSubagentContext()` 创建隔离上下文
2. 合并 `forkContextMessages + promptMessages`
3. 调用 `query()` 执行查询循环
4. 累积 usage 指标
5. 记录 `tengu_fork_agent_query` 事件

---

## 5. Agent 类型详解

### 5.1 内置代理定义

```typescript
// src/tools/AgentTool/built-in/generalPurposeAgent.ts

export const GENERAL_PURPOSE_AGENT: AgentDefinition = {
  agentType: 'general-purpose',
  whenToUse: 'For general tasks that don\'t require specialized capabilities',
  source: 'built-in',
  baseDir: 'built-in',
  getSystemPrompt: () => GENERAL_PURPOSE_AGENT_PROMPT,
};
```

### 5.2 Explore/Plan 代理

```typescript
// src/tools/AgentTool/built-in/exploreAgent.ts

export const EXPLORE_AGENT: AgentDefinition = {
  agentType: 'Explore',
  whenToUse: 'For exploring and understanding codebases',
  source: 'built-in',
  baseDir: 'built-in',
  omitClaudeMd: true,  // 省略 CLAUDE.md (只读代理)
  getSystemPrompt: () => EXPLORE_AGENT_PROMPT,
};
```

**优化特性**:
- `omitClaudeMd: true` - 省略 CLAUDE.md 层次结构 (节省 5-15 Gtok/周)
- 系统上下文省略 `gitStatus` (节省 1-3 Gtok/周)

---

## 6. 状态管理与清理

### 6.1 AppState 结构

```typescript
// AppState 中代理相关的状态

interface AppState {
  // 代理任务
  agentTasks: Map<AgentId, AgentTask>;
  
  // 待办事项 (按 agentId 分组)
  todos: { [agentId: string]: TodoItem[] };
  
  // MCP 客户端
  mcp: {
    clients: MCPServerConnection[];
    tools: Tool[];
  };
  
  // 工具权限
  toolPermissionContext: {
    mode: PermissionMode;
    alwaysAllowRules: { ... };
    additionalWorkingDirectories: Map<string, ...>;
  };
}
```

### 6.2 清理流程

```typescript
// runAgent.ts:finally 块

finally {
  await mcpCleanup();                    // 清理 MCP 服务器
  clearSessionHooks(rootSetAppState, agentId);  // 清理钩子
  cleanupAgentTracking(agentId);         // 清理缓存跟踪
  agentToolUseContext.readFileState.clear();  // 清理文件缓存
  initialMessages.length = 0;            // 清理消息数组
  unregisterPerfettoAgent(agentId);      // 清理 Perfetto 注册
  clearAgentTranscriptSubdir(agentId);   // 清理转录目录映射
  
  // 清理待办事项条目
  rootSetAppState(prev => {
    if (!(agentId in prev.todos)) return prev;
    const { [agentId]: _removed, ...todos } = prev.todos;
    return { ...prev, todos };
  });
  
  // 杀死后台 bash 任务
  killShellTasksForAgent(agentId, ...);
  
  // 清理 Monitor MCP 任务
  if (feature('MONITOR_TOOL')) {
    killMonitorMcpTasksForAgent(agentId, ...);
  }
}
```

---

## 7. 性能优化

### 7.1 Prompt 缓存优化

| 优化策略 | 实现位置 | 效果 |
|----------|----------|------|
| **CacheSafeParams** | `forkedAgent.ts` | 父子代理共享缓存 |
| **useExactTools** | `runAgent.ts` | 工具定义字节相同 |
| **thinkingConfig 继承** | `runAgent.ts:682` | 避免缓存失效 |
| **contentReplacementState 克隆** | `forkedAgent.ts:399` | 相同替换决策 |

### 7.2 Token 优化

| 优化 | 节省 | 触发条件 |
|------|------|----------|
| **omitClaudeMd** | 5-15 Gtok/周 | Explore/Plan 代理 |
| **省略 gitStatus** | 1-3 Gtok/周 | Explore/Plan 代理 |
| **禁用 thinking** | 可变 | 非 fork 子代理 |

### 7.3 内存优化

| 优化 | 实现 |
|------|------|
| **文件状态缓存克隆** | `cloneFileStateCache()` |
| **消息数组清理** | `initialMessages.length = 0` |
| **待办事项清理** | 从 AppState.todos 删除 |

---

## 8. 错误处理

### 8.1 常见错误

| 错误 | 原因 | 处理 |
|------|------|------|
| `Agent type not found` | 代理类型不存在或被拒绝 | 检查 `filterDeniedAgents()` |
| `Fork is not available inside a fork` | 递归 fork 尝试 | `isInForkChild()` 检查 |
| `MCP server not found` | 要求的 MCP 服务器未配置 | `hasRequiredMcpServers()` |
| `Teammates cannot spawn teammates` | 嵌套团队成员 | 团队文件扁平结构限制 |

### 8.2 错误恢复

```typescript
// AgentTool.tsx: 错误处理

try {
  // 代理执行
} catch (error) {
  if (error instanceof AbortError) {
    // 用户取消
    await failAsyncAgent(agentId, 'Aborted');
  } else {
    // 其他错误
    await failAsyncAgent(agentId, errorMessage(error));
  }
} finally {
  // 清理资源
}
```

---

## 9. 关键数据结构

### 9.1 AgentDefinition

```typescript
export type BaseAgentDefinition = {
  agentType: string;
  whenToUse: string;
  tools?: string[];
  disallowedTools?: string[];
  skills?: string[];
  mcpServers?: AgentMcpServerSpec[];
  hooks?: HooksSettings;
  color?: AgentColorName;
  model?: string;
  effort?: EffortValue;
  permissionMode?: PermissionMode;
  maxTurns?: number;
  filename?: string;
  baseDir?: string;
  criticalSystemReminder_EXPERIMENTAL?: string;
  requiredMcpServers?: string[];
  background?: boolean;
  initialPrompt?: string;
  memory?: AgentMemoryScope;
  isolation?: 'worktree' | 'remote';
  omitClaudeMd?: boolean;
};
```

### 9.2 ToolUseContext

```typescript
interface ToolUseContext {
  // 可变状态
  readFileState: FileStateCache;
  contentReplacementState?: ContentReplacementState;
  abortController: AbortController;
  
  // AppState 访问
  getAppState: () => AppState;
  setAppState: (updater: AppStateUpdater) => void;
  setAppStateForTasks?: AppStateUpdater;
  
  // 回调
  setResponseLength: (length: number) => void;
  pushApiMetricsEntry?: (ttftMs: number) => void;
  
  // UI 回调
  addNotification?: (n: Notification) => void;
  setToolJSX?: (jsx: ReactElement) => void;
  
  // 配置
  options: ToolUseOptions;
  messages: Message[];
  agentId?: AgentId;
  agentType?: string;
  queryTracking?: { chainId: string; depth: number };
}
```

### 9.3 CacheSafeParams

```typescript
export type CacheSafeParams = {
  systemPrompt: SystemPrompt;
  userContext: { [k: string]: string };
  systemContext: { [k: string]: string };
  toolUseContext: ToolUseContext;
  forkContextMessages: Message[];
};
```

---

## 10. 相关文件索引

| 文件 | 作用 | 行数 |
|------|------|------|
| `src/tools/AgentTool/AgentTool.tsx` | 工具入口和分发 | ~1000 |
| `src/tools/AgentTool/runAgent.ts` | 代理执行核心 | ~974 |
| `src/utils/forkedAgent.ts` | 上下文创建和 fork 执行 | ~690 |
| `src/tools/AgentTool/loadAgentsDir.ts` | 代理定义加载 | ~756 |
| `src/tools/AgentTool/builtInAgents.ts` | 内置代理定义 | ~73 |
| `src/query.ts` | 查询循环 | ~1000+ |
| `src/tools/AgentTool/forkSubagent.ts` | Fork 子代理机制 | TBD |
| `src/tools/AgentTool/agentToolUtils.ts` | 工具辅助函数 | TBD |
