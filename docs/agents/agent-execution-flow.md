# Agent 执行流程图

## 1. 快速参考：Agent 执行完整流程

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Agent 执行完整流程                                    │
└─────────────────────────────────────────────────────────────────────────────┘

  模型调用：AgentTool({ prompt: "任务描述", subagent_type: "Explore" })
          │
          ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ 阶段 1: 工具调用与代理选择                                                 │
  │  ┌───────────────────────────────────────────────────────────────────┐  │
  │  │ AgentTool.call()                                                   │  │
  │  │ • 解析输入参数 (prompt, subagent_type, model, run_in_background)   │  │
  │  │ • 检查团队模式 (team_name + name)                                  │  │
  │  │ • 检查 Fork 模式 (isForkSubagentEnabled())                         │  │
  │  │ • 从 agentDefinitions 查找代理定义                                  │  │
  │  │ • 检查 MCP 服务器要求 (hasRequiredMcpServers)                      │  │
  │  │ • 检查权限规则 (filterDeniedAgents)                                │  │
  │  └───────────────────────────────────────────────────────────────────┘  │
  └─────────────────────────────────────────────────────────────────────────┘
          │
          ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ 阶段 2: 执行模式分发                                                      │
  │                                                                          │
  │  ┌──────────────────────────────────────────────────────────────────┐   │
  │  │ 执行模式判断                                                      │   │
  │  │                                                                  │   │
  │  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐   │   │
  │  │  │  isolation=     │  │run_in_background│  │   同步执行      │   │   │
  │  │  │  'remote'       │  │ =true           │  │   (默认)        │   │   │
  │  │  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘   │   │
  │  │           │                    │                    │            │   │
  │  │           ▼                    ▼                    ▼            │   │
  │  │  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐     │   │
  │  │  │registerRemote  │  │runAsyncAgent   │  │runAgent()      │     │   │
  │  │  │AgentTask()     │  │Lifecycle()     │  │(同步生成器)    │     │   │
  │  │  │                │  │                │  │                │     │   │
  │  │  │• 远程 CCR 执行   │  │• 注册 LocalAgent │  │• 直接执行     │     │   │
  │  │  │• 后台运行       │  │• 后台运行       │  │• 阻塞直到完成 │     │   │
  │  │  │• 返回 taskId    │  │• 返回 agentId   │  │• 返回结果     │     │   │
  │  │  └────────────────┘  └────────────────┘  └────────────────┘     │   │
  │  └──────────────────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────────────────┘
          │
          ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ 阶段 3: runAgent() 执行 (同步/异步通用)                                    │
  │                                                                          │
  │  ┌───────────────────────────────────────────────────────────────────┐  │
  │  │ 3.1 初始化代理配置                                                  │  │
  │  │     • 获取代理模型 (getAgentModel)                                 │  │
  │  │     • 创建 agentId (createAgentId)                                 │  │
  │  │     • 准备用户上下文 (可能省略 CLAUDE.md)                           │  │
  │  │     • 准备系统上下文 (可能省略 gitStatus)                          │  │
  │  │     • 创建 agentGetAppState (权限覆盖)                             │  │
  │  │                                                                    │  │
  │  │ 3.2 工具池准备                                                      │  │
  │  │     • resolveAgentTools() - 解析代理工具                           │  │
  │  │     • initializeAgentMcpServers() - 初始化 MCP 服务器               │  │
  │  │     • 合并工具池 (uniqBy 去重)                                     │  │
  │  │                                                                    │  │
  │  │ 3.3 系统 Prompt 构建                                                 │  │
  │  │     • agentDefinition.getSystemPrompt()                            │  │
  │  │     • enhanceSystemPromptWithEnvDetails()                          │  │
  │  │                                                                    │  │
  │  │ 3.4 创建子代理上下文                                                 │  │
  │  │     • createSubagentContext() - 隔离/共享状态                      │  │
  │  │     • 克隆 readFileState                                           │  │
  │  │     • 创建/共享 abortController                                    │  │
  │  │     • 设置工具选项                                                 │  │
  │  └───────────────────────────────────────────────────────────────────┘  │
  │          │                                                              │
  │          ▼                                                              │
  │  ┌───────────────────────────────────────────────────────────────────┐  │
  │  │ 3.5 查询循环 (query())                                             │  │
  │  │                                                                   │  │
  │  │     for await (const message of query({                           │  │
  │  │       messages: initialMessages,                                  │  │
  │  │       systemPrompt: agentSystemPrompt,                            │  │
  │  │       userContext: resolvedUserContext,                           │  │
  │  │       systemContext: resolvedSystemContext,                       │  │
  │  │       canUseTool,                                                 │  │
  │  │       toolUseContext: agentToolUseContext,                        │  │
  │  │       querySource,                                                │  │
  │  │       maxTurns,                                                   │  │
  │  │     })) {                                                         │  │
  │  │       // 记录转录                                                 │  │
  │  │       await recordSidechainTranscript([message], agentId);        │  │
  │  │       yield message;                                              │  │
  │  │     }                                                             │  │
  │  └───────────────────────────────────────────────────────────────────┘  │
  │          │                                                              │
  │          ▼                                                              │
  │  ┌───────────────────────────────────────────────────────────────────┐  │
  │  │ 3.6 清理资源                                                       │  │
  │  │     • 清理 MCP 服务器 (mcpCleanup)                                  │  │
  │  │     • 清理会话钩子 (clearSessionHooks)                             │  │
  │  │     • 清理文件缓存 (readFileState.clear)                           │  │
  │  │     • 清理 Perfetto 注册 (unregisterPerfettoAgent)                 │  │
  │  │     • 清理待办事项 (从 AppState.todos 删除)                        │  │
  │  │     • 杀死后台任务 (killShellTasksForAgent)                        │  │
  │  └───────────────────────────────────────────────────────────────────┘  │
  └─────────────────────────────────────────────────────────────────────────┘
          │
          ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ 阶段 4: 结果返回                                                         │
  │  ┌───────────────────────────────────────────────────────────────────┐  │
  │  │ 同步执行：返回 accumulated messages                               │  │
  │  │ 异步执行：返回 { status: 'async_launched', agentId, ... }         │  │
  │  │ 远程执行：返回 { status: 'remote_launched', taskId, sessionUrl }  │  │
  │  └───────────────────────────────────────────────────────────────────┘  │
  └─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 时序图

### 2.1 同步 Agent 执行时序图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        同步 Agent 执行时序图                                  │
└─────────────────────────────────────────────────────────────────────────────┘

  Model          AgentTool        runAgent()      createSubagentContext    query()        API
    │                │                │                    │                  │             │
    │──call()───────▶│                │                    │                  │             │
    │                │                │                    │                  │             │
    │                │ 解析参数        │                    │                  │             │
    │                │ 选择代理        │                    │                  │             │
    │                │                │                    │                  │             │
    │                │──runAgent()───▶│                    │                  │             │
    │                │                │                    │                  │             │
    │                │                │ getAgentModel()    │                  │             │
    │                │                │ createAgentId()    │                  │             │
    │                │                │                    │                  │             │
    │                │                │──createSubagentContext()─▶           │             │
    │                │                │                    │                  │             │
    │                │                │                    │ 克隆 readFileState │             │
    │                │                │                    │ 创建 abortController│            │
    │                │                │                    │ 包装 getAppState  │             │
    │                │                │◀───────────────────┘                  │             │
    │                │                │                    │                  │             │
    │                │                │ getAgentSystemPrompt()                │             │
    │                │                │                    │                  │             │
    │                │                │──query()─────────▶│                  │             │
    │                │                │                    │                  │             │
    │                │                │                    │ buildEffectiveSystemPrompt()   │
    │                │                │                    │ normalizeMessagesForAPI()      │
    │                │                │                    │                  │             │
    │                │                │                    │──queryModel()──▶│             │
    │                │                │                    │                  │             │
    │                │                │                    │◀─stream response─│             │
    │                │                │                    │                  │             │
    │                │                │                    │ for each message:│             │
    │                │                │                    │   yield message  │             │
    │                │                │◀───────────────────┘                  │             │
    │                │                │                    │                  │             │
    │                │                │ 清理资源           │                  │             │
    │                │                │ - mcpCleanup      │                  │             │
    │                │                │ - clear hooks     │                  │             │
    │                │                │ - clear cache     │                  │             │
    │                │                │                    │                  │             │
    │                │◀─messages─────│                    │                  │             │
    │◀─result───────│                │                    │                  │             │
    │                │                │                    │                  │             │
```

### 2.2 异步 Agent 执行时序图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       异步 Agent 执行时序图                                    │
└─────────────────────────────────────────────────────────────────────────────┘

  Model       AgentTool    LocalAgentTask    runAgent()     Query Loop    API
    │             │              │               │              │           │
    │─call()─────▶│              │               │              │           │
    │             │              │               │              │           │
    │             │ 判断 background=true        │              │           │
    │             │              │               │              │           │
    │             │─registerAsyncAgent()───────▶│              │           │
    │             │              │               │              │           │
    │             │              │ 创建 AgentTask │              │           │
    │             │              │ 设置进度跟踪   │              │           │
    │             │              │               │              │           │
    │             │              │─runWithAgentContext()       │           │
    │             │              │               │              │           │
    │             │              │               │ 执行 query 循环 │           │
    │             │              │               │──────────────▶           │
    │             │              │               │              │           │
    │             │              │ 更新进度       │              │           │
    │             │◀─progress────│               │              │           │
    │             │              │               │              │           │
    │             │              │ 记录转录       │              │           │
    │             │              │               │              │           │
    │             │              │─────────────────────────────▶           │
    │             │              │               │              │           │
    │             │              │◀─complete────│              │           │
    │             │              │               │              │           │
    │             │              │ 清理资源       │              │           │
    │             │              │               │              │           │
    │◀─{status:   │              │               │              │           │
    │  'async_    │              │               │              │           │
    │   launched'}│              │               │              │           │
    │             │              │               │              │           │
```

### 2.3 Fork 子代理执行时序图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Fork 子代理执行时序图 (缓存共享)                          │
└─────────────────────────────────────────────────────────────────────────────┘

  Parent      AgentTool    runForkedAgent()  createSubagentContext   query()     API
    │             │               │                   │                │          │
    │─call()─────▶│               │                   │                │          │
    │             │               │                   │                │          │
    │             │ isForkPath=true                  │                │          │
    │             │ selectedAgent=FORK_AGENT         │                │          │
    │             │               │                   │                │          │
    │             │─runForkedAgent()─▶               │                │          │
    │             │               │                   │                │          │
    │             │               │ cacheSafeParams   │                │          │
    │             │               │ - systemPrompt    │                │          │
    │             │               │ - userContext     │                │          │
    │             │               │ - toolUseContext  │                │          │
    │             │               │ - forkContextMsgs │                │          │
    │             │               │                   │                │          │
    │             │               │──createSubagentContext()─▶        │          │
    │             │               │                   │                │          │
    │             │               │                   │ 克隆 fileState  │          │
    │             │               │                   │ 克隆 replacementState     │
    │             │               │◀───────────────────┘                │          │
    │             │               │                   │                │          │
    │             │               │──query()─────────▶│                │          │
    │             │               │                   │                │          │
    │             │               │                   │ 使用相同的      │          │
    │             │               │                   │ - systemPrompt  │          │
    │             │               │                   │ - tools         │          │
    │             │               │                   │ - thinking config         │
    │             │               │                   │                │          │
    │             │               │                   │──API Request──▶          │
    │             │               │                   │                │          │
    │             │               │                   │ ◀─Cache Hit───│          │
    │             │               │◀───────────────────┘                │          │
    │             │               │                   │                │          │
    │             │               │ 记录 tengu_fork_agent_query         │          │
    │             │               │ - cacheHitRate                      │          │
    │             │               │ - inputTokens                       │          │
    │             │               │ - outputTokens                      │          │
    │             │               │                   │                │          │
    │             │◀─{messages,   │                   │                │          │
    │             │  totalUsage}─ │                   │                │          │
    │◀─result──── │               │                   │                │          │
    │             │               │                   │                │          │
```

---

## 3. 组件交互图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Agent 组件交互图                                    │
└─────────────────────────────────────────────────────────────────────────────┘

                         ┌─────────────────────┐
                         │   AgentTool.tsx     │
                         │   (工具入口)        │
                         └──────────┬──────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
                    ▼               ▼               ▼
         ┌──────────────────┐ ┌──────────────┐ ┌─────────────────┐
         │  runAgent.ts     │ │forkSubagent.ts│ │spawnMultiAgent.ts│
         │  (核心执行)      │ │(缓存共享)     │ │(团队协作)        │
         └─────────┬────────┘ └──────┬───────┘ └────────┬────────┘
                   │                 │                  │
                   │                 │                  │
                   ▼                 ▼                  ▼
         ┌─────────────────────────────────────────────────────────┐
         │                    forkedAgent.ts                        │
         │  • createSubagentContext()  - 创建隔离上下文              │
         │  • runForkedAgent()         - 执行 fork 查询循环           │
         │  • prepareForkedCommandContext() - 准备 fork 上下文       │
         └─────────────────────────────────────────────────────────┘
                   │
         ┌─────────┴─────────┐
         │                   │
         ▼                   ▼
┌──────────────────┐  ┌──────────────────┐
│  ToolUseContext  │  │   AppState       │
│  (工具状态)      │  │   (应用状态)     │
│                  │  │                  │
│ • readFileState  │  │ • agentTasks     │
│ • abortController│  │ • todos          │
│ • getAppState    │  │ • mcp.clients    │
│ • setAppState    │  │ • mcp.tools      │
│ • options        │  │ • permissions    │
│ • messages       │  │                  │
└──────────────────┘  └──────────────────┘
         │                   │
         │                   │
         ▼                   ▼
┌─────────────────────────────────────────────────────────┐
│                      query.ts                            │
│  • buildEffectiveSystemPrompt()                          │
│  • normalizeMessagesForAPI()                             │
│  • runTools()                                            │
│  • executePostSamplingHooks()                            │
└─────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────┐
│                 services/api/claude.ts                   │
│  • queryModel() - API 请求构建                            │
│  • configureTaskBudgetParams()                           │
│  • toolToAPISchema()                                     │
└─────────────────────────────────────────────────────────┘
```

---

## 4. 数据流图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Agent 数据流图                                      │
└─────────────────────────────────────────────────────────────────────────────┘

  输入数据流:
  
  ┌──────────────────────────────────────────────────────────────────────┐
  │  AgentToolInput                                                       │
  │  ┌────────────────────────────────────────────────────────────────┐   │
  │  │ • description: string     - 任务描述                            │   │
  │  │ • prompt: string          - 详细指令                            │   │
  │  │ • subagent_type: string   - 代理类型                            │   │
  │  │ • model: sonnet/opus/haiku - 模型覆盖                           │   │
  │  │ • run_in_background: bool - 后台运行                            │   │
  │  │ • name: string            - 代理名称 (团队)                      │   │
  │  │ • team_name: string       - 团队名称                            │   │
  │  │ • mode: PermissionMode    - 权限模式                            │   │
  │  │ • isolation: worktree/remote - 隔离模式                         │   │
  │  │ • cwd: string             - 工作目录                            │   │
  │  └────────────────────────────────────────────────────────────────┘   │
  └──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │  AgentDefinition                                                      │
  │  ┌────────────────────────────────────────────────────────────────┐   │
  │  │ • agentType: string         - 代理类型标识符                     │   │
  │  │ • whenToUse: string         - 使用时机说明                       │   │
  │  │ • tools: string[]           - 允许的工具列表                     │   │
  │  │ • disallowedTools: string[] - 禁止的工具列表                     │   │
  │  │ • mcpServers: AgentMcpServerSpec[] - MCP 服务器                  │   │
  │  │ • hooks: HooksSettings      - 会话钩子                          │   │
  │  │ • model: string             - 模型配置                          │   │
  │  │ • effort: EffortValue       - 努力程度                          │   │
  │  │ • permissionMode: PermissionMode - 权限模式                     │   │
  │  │ • maxTurns: number          - 最大回合数                        │   │
  │  │ • background: boolean       - 后台运行标志                       │   │
  │  │ • memory: user/project/local - 记忆作用域                       │   │
  │  │ • getSystemPrompt: () => string - 系统 prompt 生成器             │   │
  │  └────────────────────────────────────────────────────────────────┘   │
  └──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │  ToolUseContext (子代理)                                              │
  │  ┌────────────────────────────────────────────────────────────────┐   │
  │  │ • readFileState: FileStateCache  - 文件读取缓存                 │   │
  │  │ • abortController: AbortController - 取消控制                   │   │
  │  │ • getAppState: () => AppState    - 状态访问                     │   │
  │  │ • options: ToolUseOptions      - 工具选项                       │   │
  │  │   ┌─────────────────────────────────────────────────────────┐   │   │
  │  │   │ • tools: Tool[]           - 工具池                       │   │   │
  │  │   │ • mcpClients: MCPServerConnection[] - MCP 客户端          │   │   │
  │  │   │ • mainLoopModel: string   - 主循环模型                   │   │   │
  │  │   │ • thinkingConfig: {type}  - 思考配置                     │   │   │
  │  │   └─────────────────────────────────────────────────────────┘   │   │
  │  │ • messages: Message[]          - 消息历史                       │   │
  │  │ • agentId: AgentId             - 代理 ID                        │   │
  │  │ • agentType: string            - 代理类型                       │   │
  │  └────────────────────────────────────────────────────────────────┘   │
  └──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │  API Request (Claude API)                                            │
  │  ┌────────────────────────────────────────────────────────────────┐   │
  │  │ • system: SystemPrompt                                          │   │
  │  │ • tools: ToolSchema[]                                           │   │
  │  │ • model: string                                                 │   │
  │  │ • messages: MessageParam[]                                      │   │
  │  │ • max_tokens: number                                            │   │
  │  │ • thinking: {type: 'enabled' | 'disabled'}                      │   │
  │  └────────────────────────────────────────────────────────────────┘   │
  └──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │  输出数据流                                                           │
  │  ┌────────────────────────────────────────────────────────────────┐   │
  │  │ 同步执行:                                                        │   │
  │  │   { status: 'completed', prompt: string }                       │   │
  │  │                                                                  │   │
  │  │ 异步执行:                                                        │   │
  │  │   { status: 'async_launched',                                   │   │
  │  │     agentId: string,                                            │   │
  │  │     description: string,                                        │   │
  │  │     outputFile: string }                                        │   │
  │  │                                                                  │   │
  │  │ 远程执行:                                                        │   │
  │  │   { status: 'remote_launched',                                  │   │
  │  │     taskId: string,                                             │   │
  │  │     sessionUrl: string }                                        │   │
  │  └────────────────────────────────────────────────────────────────┘   │
  └──────────────────────────────────────────────────────────────────────┘
```

---

## 5. 决策树

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Agent 执行决策树                                   │
└─────────────────────────────────────────────────────────────────────────────┘

                         AgentTool.call()
                               │
                               ▼
                    ┌─────────────────────┐
                    │ team_name + name?   │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │ Yes            │                │ No
              ▼                                ▼
    ┌──────────────────┐            ┌─────────────────────┐
    │ spawnTeammate()  │            │ 继续执行模式判断     │
    │ (团队代理)        │            └──────────┬──────────┘
    │ 返回 teammate_   │                       │
    │ spawned 状态      │                       ▼
    └──────────────────┘            ┌─────────────────────┐
                                    │ isolation='remote'? │
                                    └──────────┬──────────┘
                                               │
                              ┌────────────────┼────────────────┐
                              │ Yes            │                │ No
                              ▼                                ▼
                    ┌──────────────────┐            ┌─────────────────────┐
                    │ 远程执行          │            │ run_in_background?  │
                    │ registerRemote   │            └──────────┬──────────┘
                    │ AgentTask()      │                       │
                    │ 返回 remote_     │          ┌────────────┼────────────┐
                    │ launched        │          │ Yes        │            │ No
                    └──────────────────┘          ▼            │            ▼
                                      ┌──────────────────┐   │   ┌─────────────────────┐
                                      │ 异步执行          │   │   │ isForkPath?         │
                                      │ runAsyncAgent    │   │   └──────────┬──────────┘
                                      │ Lifecycle()      │   │              │
                                      │ 返回 async_      │   │   ┌──────────┼──────────┐
                                      │ launched        │   │   │ Yes      │          │ No
                                      └──────────────────┘   │   ▼          │          ▼
                                                             │ ┌────────┐ │ ┌─────────────────────┐
                                                             │ │Fork 执行│ │ │ 同步执行            │
                                                             │ │runForked│ │ │ runAgent()          │
                                                             │ │Agent() │ │ │ (默认 general-purpose)│
                                                             │ └────────┘ │ └─────────────────────┘
                                                             │            │
                                                             └─────┬──────┴──────┬──────────────┘
                                                                   │             │
                                                                   ▼             ▼
                                                            所有路径汇聚到 runAgent() 核心执行
```

---

## 6. 关键代码引用表

| 功能 | 文件 | 函数/类 | 行号范围 |
|------|------|---------|----------|
| **工具入口** | `AgentTool.tsx` | `AgentTool.call()` | 239-700+ |
| **代理选择** | `AgentTool.tsx` | 代理查找逻辑 | 322-356 |
| **MCP 检查** | `AgentTool.tsx` | `hasRequiredMcpServers()` | 371-410 |
| **异步执行** | `agentToolUtils.ts` | `runAsyncAgentLifecycle()` | TBD |
| **核心执行** | `runAgent.ts` | `runAgent()` | 48-860 |
| **上下文创建** | `forkedAgent.ts` | `createSubagentContext()` | 345-462 |
| **Fork 执行** | `forkedAgent.ts` | `runForkedAgent()` | 489-626 |
| **缓存参数** | `forkedAgent.ts` | `CacheSafeParams` | 57-68 |
| **代理定义** | `loadAgentsDir.ts` | `getAgentDefinitionsWithOverrides()` | 296-393 |
| **内置代理** | `builtInAgents.ts` | `getBuiltInAgents()` | 22-72 |
| **工具解析** | `agentToolUtils.ts` | `resolveAgentTools()` | TBD |
| **MCP 初始化** | `runAgent.ts` | `initializeAgentMcpServers()` | 95-218 |
| **系统 Prompt** | `runAgent.ts` | `getAgentSystemPrompt()` | 906-932 |
| **查询循环** | `query.ts` | `query()` | 200+ |
| **API 请求** | `claude.ts` | `queryModel()` | TBD |

---

## 7. 错误处理流程

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Agent 错误处理流程                                 │
└─────────────────────────────────────────────────────────────────────────────┘

  错误类型                    检测位置                处理方式
  ─────────────────────────────────────────────────────────────────────────
  
  1. 代理类型不存在
     AgentTool.tsx:346-353    filterDeniedAgents()
     • 检查代理是否存在但被拒绝 → 抛出权限错误
     • 代理不存在 → 列出可用代理
  
  2. 递归 Fork 尝试
     AgentTool.tsx:332-334    isInForkChild()
     • 检查 querySource === 'agent:builtin:fork'
     • 扫描消息检测 fork 模式
     • 抛出 "Fork is not available inside a fork"
  
  3. MCP 服务器未配置
     AgentTool.tsx:371-410    hasRequiredMcpServers()
     • 等待 pending 服务器连接 (最多 30 秒)
     • 检查服务器是否有工具
     • 抛出 "Required MCP servers not available"
  
  4. 团队成员嵌套
     AgentTool.tsx:272-274    isTeammate() && name
     • 检测队友尝试 spawn 队友
     • 抛出 "Teammates cannot spawn other teammates"
  
  5. 异步执行错误
     agentToolUtils.ts        runAsyncAgentLifecycle()
     • AbortError → failAsyncAgent(agentId, 'Aborted')
     • 其他错误 → failAsyncAgent(agentId, errorMessage)
     • finally → 清理资源
  
  6. 查询循环错误
     runAgent.ts:808-810      abortController.signal.aborted
     • 检测中止信号 → 抛出 AbortError
     • finally 块 → 全面清理
  
  7. API 错误
     claude.ts                queryModel()
     • 重试逻辑 (withRetry)
     • Prompt 过长 → 触发自动压缩
     • 其他错误 → 抛出到调用者
```

---

## 8. 性能指标

### 8.1 缓存命中率

| 场景 | 缓存策略 | 预期命中率 |
|------|----------|------------|
| **Fork 子代理** | CacheSafeParams | 90%+ |
| **同步子代理** | 独立上下文 | 0% (独立请求) |
| **异步子代理** | 独立上下文 | 0% (独立请求) |
| **连续相同任务** | 消息前缀相同 | 50-70% |

### 8.2 Token 使用

| 代理类型 | 系统 Prompt | 平均输入 | 平均输出 |
|----------|-------------|----------|----------|
| **General-Purpose** | ~2K | ~10K | ~5K |
| **Explore** | ~1.5K (省略 CLAUDE.md) | ~8K | ~3K |
| **Plan** | ~1.5K (省略 CLAUDE.md) | ~12K | ~8K |
| **Fork** | 继承父代理 | ~5K | ~2K |

### 8.3 执行时间

| 执行模式 | 启动延迟 | 每回合延迟 | 清理时间 |
|----------|----------|------------|----------|
| **同步** | <10ms | ~500ms | <5ms |
| **异步** | <50ms | ~500ms | <10ms |
| **远程** | <100ms | ~1000ms | <20ms |
| **Fork** | <5ms | ~300ms | <5ms |
