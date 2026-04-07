# Yao Code Prompt 生成流程详细分析

## 1. 概述

Claude Code 的 prompt 生成是一个多层次的复杂流程，涉及系统 prompt 构建、用户消息处理、工具定义、上下文管理等多个环节。本文档详细分析了从用户输入到 API 请求的完整 prompt 生成流程。

### 1.1 Prompt 类型

Claude Code 中主要有以下几种 prompt 类型：

| 类型 | 用途 | 生成位置 |
|------|------|----------|
| **System Prompt** | 定义模型行为、工具说明、安全约束 | `src/utils/systemPrompt.ts` |
| **User Prompt** | 用户输入、工具结果、附件内容 | `src/utils/messages.ts` |
| **Skill Prompt** | 技能/命令的指令内容 | `src/skills/` |
| **Agent Prompt** | 自定义代理的指令 | `src/tools/AgentTool/` |
| **Tool Prompt** | 工具的 description 和 schema | `src/tools/*/prompt.ts` |

---

## 2. 系统架构

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Yao Code Prompt 生成系统                          │
└─────────────────────────────────────────────────────────────────────────────┘

  用户输入
     │
     ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ 阶段 1: 输入处理 (processUserInput)                                       │
  │  ┌───────────────────────────────────────────────────────────────────┐  │
  │  │ • parseSlashCommand() - 解析斜杠命令                                │  │
  │  │ • processSlashCommand() - 处理命令执行                              │  │
  │  │ • getMessagesForSlashCommand() - 获取命令消息                       │  │
  │  │ • getMessagesForPromptSlashCommand() - 获取 prompt 类命令消息        │  │
  │  └───────────────────────────────────────────────────────────────────┘  │
  └─────────────────────────────────────────────────────────────────────────┘
     │
     ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ 阶段 2: Skill/Command 内容加载                                            │
  │  ┌───────────────────────────────────────────────────────────────────┐  │
  │  │ • command.getPromptForCommand() - 获取技能 prompt                   │  │
  │  │ • registerSkillHooks() - 注册技能钩子                               │  │
  │  │ • prepareForkedCommandContext() - 准备 fork 上下文                   │  │
  │  └───────────────────────────────────────────────────────────────────┘  │
  └─────────────────────────────────────────────────────────────────────────┘
     │
     ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ 阶段 3: 系统 Prompt 构建                                                   │
  │  ┌───────────────────────────────────────────────────────────────────┐  │
  │  │ • buildEffectiveSystemPrompt() - 构建有效系统 prompt                 │  │
  │  │ • asSystemPrompt() - 类型转换                                       │  │
  │  │ • appendSystemPrompt - 追加系统 prompt                               │  │
  │  └───────────────────────────────────────────────────────────────────┘  │
  └─────────────────────────────────────────────────────────────────────────┘
     │
     ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ 阶段 4: 消息规范化与转换                                                  │
  │  ┌───────────────────────────────────────────────────────────────────┐  │
  │  │ • normalizeMessagesForAPI() - 规范化消息                            │  │
  │  │ • userMessageToMessageParam() - 用户消息转换                        │  │
  │  │ • assistantMessageToMessageParam() - 助手消息转换                   │  │
  │  │ • ensureToolResultPairing() - 确保工具结果配对                      │  │
  │  └───────────────────────────────────────────────────────────────────┘  │
  └─────────────────────────────────────────────────────────────────────────┘
     │
     ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ 阶段 5: API 请求构建                                                      │
  │  ┌───────────────────────────────────────────────────────────────────┐  │
  │  │ • queryModel() - 主查询函数                                         │  │
  │  │ • configureTaskBudgetParams() - 配置预算参数                        │  │
  │  │ • getExtraBodyParams() - 获取额外 body 参数                          │  │
  │  │ • toolToAPISchema() - 工具 schema 转换                              │  │
  │  └───────────────────────────────────────────────────────────────────┘  │
  └─────────────────────────────────────────────────────────────────────────┘
     │
     ▼
  Anthropic API Request
```

### 2.2 核心组件关系图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Prompt 生成组件关系                                │
└─────────────────────────────────────────────────────────────────────────────┘

                    ┌─────────────────────────┐
                    │      用户输入           │
                    │   (User Input)          │
                    └───────────┬─────────────┘
                                │
                                ▼
                    ┌─────────────────────────┐
                    │  processSlashCommand    │
                    │  (命令解析入口)          │
                    └───────────┬─────────────┘
                                │
            ┌───────────────────┼───────────────────┐
            │                   │                   │
            ▼                   ▼                   ▼
    ┌───────────────┐   ┌───────────────┐   ┌───────────────┐
    │ local-jsx     │   │    local      │   │    prompt     │
    │ 命令          │   │   命令        │   │   命令        │
    └───────────────┘   └───────────────┘   └───────┬───────┘
                                                    │
                                                    │ fork?
                                    ┌───────────────┴───────────────┐
                                    │ 是                            │ 否
                                    ▼                               ▼
                          ┌─────────────────┐             ┌─────────────────┐
                          │executeForked... │             │getMessagesFor...│
                          │SlashCommand()   │             │PromptSlashCmd() │
                          └────────┬────────┘             └────────┬────────┘
                                   │                               │
                                   │                               │
                                   ▼                               ▼
                          ┌─────────────────────────────────────────────┐
                          │      prepareForkedCommandContext()          │
                          │  • 获取 skillContent (getPromptForCommand)  │
                          │  • 解析 allowedTools                        │
                          │  • 准备 baseAgent                           │
                          │  • 准备 promptMessages                      │
                          └─────────────────────────────────────────────┘
                                   │
                                   ▼
                          ┌─────────────────────────────────────────────┐
                          │         runAgent() / runForkedAgent()       │
                          │  • 创建 subagent 上下文                       │
                          │  • 执行 query() 循环                         │
                          └─────────────────────────────────────────────┘
                                   │
                                   ▼
                          ┌─────────────────────────────────────────────┐
                          │              query()                        │
                          │  • buildEffectiveSystemPrompt()             │
                          │  • normalizeMessagesForAPI()                │
                          │  • queryModel()                             │
                          └─────────────────────────────────────────────┘
                                   │
                                   ▼
                          ┌─────────────────────────────────────────────┐
                          │           queryModel()                      │
                          │  • 构建 API 请求参数                          │
                          │  • 转换 messages 为 MessageParam              │
                          │  • 调用 anthropic.messages.create()         │
                          └─────────────────────────────────────────────┘
                                   │
                                   ▼
                          Anthropic API
```

---

## 3. 详细代码调用流程

### 3.1 斜杠命令处理流程

```typescript
// 文件：src/utils/processUserInput/processSlashCommand.tsx

// 入口点：processSlashCommand()
export async function processSlashCommand(
  inputString: string,           // 用户输入，如 "/brainstorming 设计一个功能"
  precedingInputBlocks: ContentBlockParam[],
  imageContentBlocks: ContentBlockParam[],
  attachmentMessages: AttachmentMessage[],
  context: ProcessUserInputContext,
  setToolJSX: SetToolJSXFn,
  uuid?: string,
  isAlreadyProcessing?: boolean,
  canUseTool?: CanUseToolFn
): Promise<ProcessUserInputBaseResult> {
  
  // 1. 解析斜杠命令
  const parsed = parseSlashCommand(inputString)
  // 返回：{ commandName: "brainstorming", args: "设计一个功能", isMcp: false }
  
  // 2. 检查命令是否存在
  if (!hasCommand(commandName, context.options.commands)) {
    // 命令不存在，返回错误消息
  }
  
  // 3. 获取命令消息
  const result = await getMessagesForSlashCommand(
    commandName, parsedArgs, setToolJSX, context, ...
  )
  
  // 4. 返回处理结果
  return result
}
```

### 3.2 Prompt 类命令处理流程

```typescript
// 文件：src/utils/processUserInput/processSlashCommand.tsx

async function getMessagesForPromptSlashCommand(
  command: CommandBase & PromptCommand,
  args: string,
  context: ToolUseContext,
  precedingInputBlocks: ContentBlockParam[] = [],
  imageContentBlocks: ContentBlockParam[] = [],
  uuid?: string
): Promise<SlashCommandResult> {
  
  // 1. 检查 coordinator 模式 (跳过完整内容加载)
  if (feature('COORDINATOR_MODE') && ...) {
    // 返回简要摘要，用于 coordinator 分配任务给 worker
  }
  
  // 2. 获取技能的完整 prompt 内容
  const result = await command.getPromptForCommand(args, context)
  // result 类型：ContentBlockParam[]
  
  // 3. 注册技能钩子 (如果定义了 hooks)
  const hooksAllowedForThisSkill = ...
  if (command.hooks && hooksAllowedForThisSkill) {
    const sessionId = getSessionId()
    registerSkillHooks(
      context.setAppState,
      sessionId,
      command.hooks,
      command.name,
      command.skillRoot
    )
  }
  
  // 4. 构建返回消息
  const messages: UserMessage[] = [
    createUserMessage({
      content: formatSkillLoadingMetadata(command.name, command.progressMessage)
    }),
    createUserMessage({
      content: result,  // 技能的完整 prompt 内容
      isMeta: true      // 标记为 meta 消息，对用户隐藏但模型可见
    })
  ]
  
  return {
    messages,
    shouldQuery: true,   // 需要查询 API
    command,
    allowedTools: command.allowedTools,
    model: command.model,
    effort: command.effort
  }
}
```

### 3.3 Skill Prompt 内容获取流程

```typescript
// 文件：src/skills/loadSkillsDir.ts

// 在技能加载时创建 getPromptForCommand 函数
async function createSkillCommand({...}): Command {
  return {
    // ... 其他属性
    async getPromptForCommand(args, toolUseContext) {
      let finalContent = baseDir
        ? `Base directory for this skill: ${baseDir}\n\n${markdownContent}`
        : markdownContent

      // 替换参数占位符
      finalContent = substituteArguments(
        finalContent,
        args,
        true,
        argumentNames
      )

      // 替换 ${CLAUDE_SKILL_DIR} 变量
      if (baseDir) {
        const skillDir = process.platform === 'win32' 
          ? baseDir.replace(/\\/g, '/') 
          : baseDir
        finalContent = finalContent.replace(
          /\$\{CLAUDE_SKILL_DIR\}/g, 
          skillDir
        )
      }

      // 替换 ${CLAUDE_SESSION_ID} 变量
      finalContent = finalContent.replace(
        /\$\{CLAUDE_SESSION_ID\}/g,
        getSessionId()
      )

      // 执行内联 shell 命令 (!`...`)
      if (loadedFrom !== 'mcp') {
        finalContent = await executeShellCommandsInPrompt(
          finalContent,
          { ...toolUseContext, getAppState() {...} },
          `/${skillName}`,
          shell
        )
      }

      return [{ type: 'text', text: finalContent }]
    }
  }
}
```

### 3.4 Forked Command 上下文准备

```typescript
// 文件：src/utils/forkedAgent.ts

export async function prepareForkedCommandContext(
  command: PromptCommand,
  args: string,
  context: ToolUseContext,
): Promise<PreparedForkedContext> {
  
  // 1. 获取技能内容 (带参数替换)
  const skillPrompt = await command.getPromptForCommand(args, context)
  const skillContent = skillPrompt
    .map(block => block.type === 'text' ? block.text : '')
    .join('\n')

  // 2. 解析允许的工具列表
  const allowedTools = parseToolListFromCLI(command.allowedTools ?? [])

  // 3. 创建修改后的 getAppState (添加工具权限)
  const modifiedGetAppState = createGetAppStateWithAllowedTools(
    context.getAppState,
    allowedTools
  )

  // 4. 确定使用的 agent
  const agentTypeName = command.agent ?? 'general-purpose'
  const baseAgent = agents.find(a => a.agentType === agentTypeName) ??
                    agents.find(a => a.agentType === 'general-purpose') ??
                    agents[0]

  // 5. 准备初始 prompt 消息
  const promptMessages = [createUserMessage({ content: skillContent })]

  return {
    skillContent,
    modifiedGetAppState,
    baseAgent,
    promptMessages
  }
}
```

---

## 4. 系统 Prompt 构建流程

### 4.1 buildEffectiveSystemPrompt()

```typescript
// 文件：src/utils/systemPrompt.ts

export function buildEffectiveSystemPrompt({
  mainThreadAgentDefinition,
  toolUseContext,
  customSystemPrompt,
  defaultSystemPrompt,
  appendSystemPrompt,
  overrideSystemPrompt,
}: {
  mainThreadAgentDefinition: AgentDefinition | undefined
  toolUseContext: Pick<ToolUseContext, 'options'>
  customSystemPrompt: string | undefined
  defaultSystemPrompt: string[]
  appendSystemPrompt: string | undefined
  overrideSystemPrompt?: string | null
}): SystemPrompt {
  
  // 优先级 0: Override system prompt (完全替换)
  if (overrideSystemPrompt) {
    return asSystemPrompt([overrideSystemPrompt])
  }
  
  // 优先级 1: Coordinator 模式
  if (feature('COORDINATOR_MODE') && ... && !mainThreadAgentDefinition) {
    return asSystemPrompt([
      getCoordinatorSystemPrompt(),
      ...(appendSystemPrompt ? [appendSystemPrompt] : [])
    ])
  }
  
  // 获取 Agent system prompt
  const agentSystemPrompt = mainThreadAgentDefinition
    ? isBuiltInAgent(mainThreadAgentDefinition)
      ? mainThreadAgentDefinition.getSystemPrompt({...})
      : mainThreadAgentDefinition.getSystemPrompt()
    : undefined
  
  // 优先级 2: Agent system prompt
  // 在 proactive 模式下，agent prompt 追加到 default
  if (agentSystemPrompt && (feature('PROACTIVE') || feature('KAIROS')) && ...) {
    return asSystemPrompt([
      ...defaultSystemPrompt,
      `\n# Custom Agent Instructions\n${agentSystemPrompt}`,
      ...(appendSystemPrompt ? [appendSystemPrompt] : [])
    ])
  }
  
  // 优先级 3: Custom system prompt 或 default
  return asSystemPrompt([
    ...(agentSystemPrompt
      ? [agentSystemPrompt]
      : customSystemPrompt
        ? [customSystemPrompt]
        : defaultSystemPrompt),
    ...(appendSystemPrompt ? [appendSystemPrompt] : [])
  ])
}
```

### 4.2 系统 Prompt 优先级

```
┌─────────────────────────────────────────────────────────────────┐
│                    System Prompt 优先级                           │
├─────────────────────────────────────────────────────────────────┤
│  0. overrideSystemPrompt (完全替换所有其他 prompt)               │
│  1. Coordinator system prompt (coordinator 模式)                │
│  2. Agent system prompt (自定义代理)                             │
│     - Proactive 模式：追加到 default                             │
│     - 其他模式：替换 default                                     │
│  3. Custom system prompt (--system-prompt 参数)                 │
│  4. Default system prompt (标准 Yao Code prompt)             │
│                                                                 │
│  Append: appendSystemPrompt (始终追加到末尾)                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. 消息规范化流程

### 5.1 normalizeMessagesForAPI()

```typescript
// 文件：src/utils/messages.ts

export function normalizeMessagesForAPI(
  messages: Message[],
  options: {
    enablePromptCaching?: boolean
    querySource?: QuerySource
    // ...
  }
): MessageParam[] {
  
  const apiMessages: MessageParam[] = []
  
  for (const message of messages) {
    switch (message.type) {
      case 'user':
        apiMessages.push(
          userMessageToMessageParam(
            message,
            addCache,
            enablePromptCaching,
            querySource
          )
        )
        break
      case 'assistant':
        apiMessages.push(
          assistantMessageToMessageParam(
            message,
            addCache,
            enablePromptCaching,
            querySource
          )
        )
        break
      // ... 处理其他消息类型
    }
  }
  
  // 确保工具结果配对 (修复不完整的 tool_use/tool_result)
  const pairedMessages = ensureToolResultPairing(apiMessages)
  
  return pairedMessages
}
```

### 5.2 消息转换函数

```typescript
// 文件：src/services/api/claude.ts

// 用户消息转换
export function userMessageToMessageParam(
  message: UserMessage,
  addCache = false,
  enablePromptCaching: boolean,
  querySource?: QuerySource
): MessageParam {
  if (addCache) {
    if (typeof message.message.content === 'string') {
      return {
        role: 'user',
        content: [{
          type: 'text',
          text: message.message.content,
          ...(enablePromptCaching && {
            cache_control: getCacheControl({ querySource })
          })
        }]
      }
    }
    // ... 处理数组内容
  }
  
  return {
    role: 'user',
    content: Array.isArray(message.message.content)
      ? [...message.message.content]
      : message.message.content
  }
}

// 助手消息转换
export function assistantMessageToMessageParam(
  message: AssistantMessage,
  addCache = false,
  enablePromptCaching: boolean,
  querySource?: QuerySource
): MessageParam {
  // 类似用户消息转换，但处理 thinking/redacted_thinking 块
  // ...
}
```

---

## 6. API 请求构建流程

### 6.1 queryModel() 主函数

```typescript
// 文件：src/services/api/claude.ts

async function* queryModel(
  messages: Message[],
  systemPrompt: SystemPrompt,
  thinkingConfig: ThinkingConfig,
  tools: Tools,
  signal: AbortSignal,
  options: Options
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage> {
  
  // 1. 准备 API 客户端
  const anthropic = getAnthropicClient({
    apiKey: ...,
    model: options.model,
    maxRetries: 3,
    source: options.querySource
  })
  
  // 2. 构建系统 prompt
  const [systemPromptPrefix, systemPromptSuffix] = splitSysPromptPrefix(
    asSystemPrompt(systemPrompt)
  )
  
  // 3. 准备消息参数
  const apiMessages = normalizeMessagesForAPI(messages, {
    enablePromptCaching: options.enablePromptCaching,
    querySource: options.querySource
  })
  
  // 4. 准备工具定义
  const apiTools = tools.map(tool => toolToAPISchema(tool))
  
  // 5. 准备 beta 功能
  const betas = getMergedBetas(options.model, ...)
  
  // 6. 准备额外 body 参数
  const extraBodyParams = getExtraBodyParams(betas)
  
  // 7. 配置 effort 参数
  configureEffortParams(
    options.effortValue,
    outputConfig,
    extraBodyParams,
    betas,
    options.model
  )
  
  // 8. 配置 task budget 参数
  configureTaskBudgetParams(
    options.taskBudget,
    outputConfig,
    betas
  )
  
  // 9. 构建 API 请求
  const requestParams: BetaMessageStreamParams = {
    model: options.model,
    max_tokens: maxTokens,
    messages: prependUserContext(
      options.userContext,
      appendSystemContext(systemContext, apiMessages)
    ),
    system: systemPromptPrefix
      ? [{ type: 'text', text: systemPromptPrefix }, ...systemPromptSuffix]
      : systemPromptSuffix,
    tools: apiTools,
    tool_choice: options.toolChoice,
    temperature: options.temperatureOverride ?? 1,
    stream: true,
    betas,
    ...(Object.keys(extraBodyParams).length > 0 && {
      extra_body: extraBodyParams
    }),
    ...(outputConfig && { output_config: outputConfig }),
    metadata: getAPIMetadata()
  }
  
  // 10. 调用 API
  const stream = await anthropic.beta.messages.create(requestParams)
  
  // 11. 处理流式响应
  for await (const event of stream) {
    // 处理各种事件类型
    yield processStreamEvent(event)
  }
}
```

### 6.2 工具 Schema 转换

```typescript
// 文件：src/utils/api.ts

export function toolToAPISchema(tool: Tool): BetaToolUnion {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
    ...(tool.cacheControl && { cache_control: tool.cacheControl })
  }
}
```

---

## 7. Prompt 缓存机制

### 7.1 缓存控制

```typescript
// 文件：src/services/api/claude.ts

export function getCacheControl({
  scope,
  querySource
}: {
  scope?: CacheScope
  querySource?: QuerySource
} = {}): {
  type: 'ephemeral'
  ttl?: '1h'
  scope?: CacheScope
} {
  return {
    type: 'ephemeral',
    ...(should1hCacheTTL(querySource) && { ttl: '1h' }),
    ...(scope === 'global' && { scope })
  }
}

// 1h TTL 条件检查
function should1hCacheTTL(querySource?: QuerySource): boolean {
  // 1. 3P Bedrock 用户 (通过环境变量)
  if (getAPIProvider() === 'bedrock' && 
      isEnvTruthy(process.env.ENABLE_PROMPT_CACHING_1H_BEDROCK)) {
    return true
  }
  
  // 2. 用户资格检查 (ant 或订阅者)
  let userEligible = getPromptCache1hEligible()
  if (userEligible === null) {
    userEligible = process.env.USER_TYPE === 'ant' ||
                   (isClaudeAISubscriber() && !currentLimits.isUsingOverage)
  }
  if (!userEligible) return false
  
  // 3. GrowthBook allowlist 检查
  let allowlist = getPromptCache1hAllowlist()
  if (allowlist === null) {
    const config = getFeatureValue_CACHED_MAY_BE_STALE('tengu_prompt_cache_1h_config', {})
    allowlist = config.allowlist ?? []
  }
  
  return querySource !== undefined &&
         allowlist.some(pattern =>
           pattern.endsWith('*')
             ? querySource.startsWith(pattern.slice(0, -1))
             : querySource === pattern
         )
}
```

### 7.2 缓存关键点

```
┌─────────────────────────────────────────────────────────────────┐
│                    Prompt Cache 关键点                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Cache Key 组成:                                                │
│  • System Prompt                                                │
│  • Tools 定义                                                    │
│  • Model 配置                                                   │
│  • Messages (prefix)                                            │
│  • Thinking Config                                              │
│                                                                 │
│  Cache 控制:                                                    │
│  • 默认：ephemeral (短期缓存)                                   │
│  • 1h TTL: 需要资格 + allowlist 匹配                             │
│  • Global scope: 跨会话共享 (需要配置)                           │
│                                                                 │
│  Cache 破坏检测:                                                │
│  • checkResponseForCacheBreak()                                 │
│  • recordPromptState()                                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 8. 流程图

### 8.1 完整 Prompt 生成流程

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Prompt 生成完整流程                                   │
└─────────────────────────────────────────────────────────────────────────────┘

  用户输入: "/brainstorming 设计新功能"
          │
          ▼
  ┌───────────────────────────────────────────────────────────────────────────┐
  │ 步骤 1: parseSlashCommand()                                                │
  │  输入："/brainstorming 设计新功能"                                         │
  │  输出：{ commandName: "brainstorming", args: "设计新功能" }                │
  └───────────────────────────────────────────────────────────────────────────┘
          │
          ▼
  ┌───────────────────────────────────────────────────────────────────────────┐
  │ 步骤 2: hasCommand() - 检查命令是否存在                                    │
  │  从 context.options.commands 中查找                                         │
  └───────────────────────────────────────────────────────────────────────────┘
          │
          ▼
  ┌───────────────────────────────────────────────────────────────────────────┐
  │ 步骤 3: getMessagesForSlashCommand()                                       │
  │  根据命令类型分发:                                                         │
  │  • local-jsx: 加载 JSX 模块并执行                                           │
  │  • local: 加载本地模块并执行                                                │
  │  • prompt: 调用 getMessagesForPromptSlashCommand()                         │
  └───────────────────────────────────────────────────────────────────────────┘
          │
          ▼
  ┌───────────────────────────────────────────────────────────────────────────┐
  │ 步骤 4: getMessagesForPromptSlashCommand()                                 │
  │  • 检查 coordinator 模式                                                   │
  │  • 调用 command.getPromptForCommand(args, context)                         │
  │  • 注册技能钩子 (如果有)                                                    │
  │  • 构建返回消息                                                            │
  └───────────────────────────────────────────────────────────────────────────┘
          │
          ▼
  ┌───────────────────────────────────────────────────────────────────────────┐
  │ 步骤 5: command.getPromptForCommand()                                      │
  │  • 读取 SKILL.md 内容                                                       │
  │  • 注入 Base directory header                                              │
  │  • 替换 ${CLAUDE_SKILL_DIR}                                                 │
  │  • 替换 ${CLAUDE_SESSION_ID}                                                │
  │  • 替换参数占位符 ($ARGUMENTS, $arg_name)                                  │
  │  • 执行内联 shell 命令 (!`...`)                                             │
  └───────────────────────────────────────────────────────────────────────────┘
          │
          ▼
  ┌───────────────────────────────────────────────────────────────────────────┐
  │ 步骤 6: query() - 主查询循环                                                │
  │  • buildEffectiveSystemPrompt()                                            │
  │  • normalizeMessagesForAPI()                                               │
  │  • queryModel()                                                            │
  └───────────────────────────────────────────────────────────────────────────┘
          │
          ▼
  ┌───────────────────────────────────────────────────────────────────────────┐
  │ 步骤 7: queryModel() - API 请求构建                                         │
  │  • getAnthropicClient()                                                    │
  │  • normalizeMessagesForAPI() → MessageParam[]                              │
  │  • toolToAPISchema() → BetaToolUnion[]                                     │
  │  • getMergedBetas() → string[]                                             │
  │  • getExtraBodyParams() → JsonObject                                       │
  │  • configureEffortParams()                                                 │
  │  • configureTaskBudgetParams()                                             │
  └───────────────────────────────────────────────────────────────────────────┘
          │
          ▼
  ┌───────────────────────────────────────────────────────────────────────────┐
  │ 步骤 8: anthropic.beta.messages.create()                                   │
  │  请求参数:                                                                 │
  │  • model: "claude-sonnet-4-6"                                              │
  │  • max_tokens: 8192                                                        │
  │  • messages: MessageParam[]                                                │
  │  • system: SystemPrompt[]                                                  │
  │  • tools: BetaToolUnion[]                                                  │
  │  • betas: ["prompt-caching-2024-07-31", ...]                               │
  │  • stream: true                                                            │
  └───────────────────────────────────────────────────────────────────────────┘
          │
          ▼
  Anthropic API 响应流
```

### 8.2 调用时序图

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                    Prompt 生成调用时序图                                          │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘

  用户      processSlashCommand    getMessagesForPrompt  command.getPrompt   query()        queryModel()      Anthropic API
   │                │                      │                    │               │                  │                 │
   │─输入──────────▶│                      │                    │               │                  │                 │
   │                │                      │                    │               │                  │                 │
   │                │─parseSlashCommand──▶│                    │               │                  │                 │
   │                │                      │                    │               │                  │                 │
   │                │◀─解析结果────────────│                    │               │                  │                 │
   │                │                      │                    │               │                  │                 │
   │                │─getMessagesFor...──▶│                    │               │                  │                 │
   │                │                      │                    │               │                  │                 │
   │                │                      │─getPromptForCmd──▶│               │                  │                 │
   │                │                      │                    │               │                  │                 │
   │                │                      │                    │─读取 SKILL.md─▶│                  │                 │
   │                │                      │                    │               │                  │                 │
   │                │                      │                    │─注入变量──────▶│                  │                 │
   │                │                      │                    │               │                  │                 │
   │                │                      │                    │─执行 shell────▶│                  │                 │
   │                │                      │                    │               │                  │                 │
   │                │                      │◀─prompt 内容───────│               │                  │                 │
   │                │                      │                    │               │                  │                 │
   │                │                      │─registerHooks────▶│               │                  │                 │
   │                │                      │                    │               │                  │                 │
   │                │◀─消息列表────────────│                    │               │                  │                 │
   │                │                      │                    │               │                  │                 │
   │                │─query()─────────────────────────────────────────────────▶│                  │                 │
   │                │                      │                    │               │                  │                 │
   │                │                      │                    │               │─buildSystemPrompt│                  │                 │
   │                │                      │                    │               │                  │                 │
   │                │                      │                    │               │─normalizeMsgs───▶│                  │                 │
   │                │                      │                    │               │                  │                 │
   │                │                      │                    │               │─queryModel()────▶│                  │                 │
   │                │                      │                    │               │                  │                 │
   │                │                      │                    │               │                  │─构建请求参数     │                 │
   │                │                      │                    │               │                  │                 │
   │                │                      │                    │               │                  │─创建 API 请求────▶│                 │
   │                │                      │                    │               │                  │                 │
   │                │                      │                    │               │                  │◀─流式响应───────│                 │
   │                │                      │                    │               │                  │                 │
   │                │                      │                    │               │◀─事件流──────────│                 │
   │                │                      │                    │               │                  │                 │
   │                │◀─结果消息────────────│                    │               │                  │                 │
   │                │                      │                    │               │                  │                 │
   │◀─最终响应──────│                      │                    │               │                  │                 │
   │                │                      │                    │               │                  │                 │
```

---

## 9. 关键数据结构

### 9.1 SystemPrompt 类型

```typescript
// 文件：src/utils/systemPromptType.ts

export type SystemPrompt = string & { readonly __brand: unique symbol }

export function asSystemPrompt(parts: string[]): SystemPrompt {
  return parts.join('\n\n') as SystemPrompt
}
```

### 9.2 Message 类型层次

```typescript
// 文件：src/types/message.ts

type Message =
  | UserMessage           // 用户消息
  | AssistantMessage      // 助手消息
  | SystemMessage         // 系统消息
  | ProgressMessage       // 进度消息
  | AttachmentMessage     // 附件消息
  | ToolUseSummaryMessage // 工具使用摘要

interface UserMessage {
  type: 'user'
  message: {
    role: 'user'
    content: string | ContentBlockParam[]
  }
  isMeta?: boolean       // 对用户隐藏
  toolUseResult?: string
  sourceToolAssistantUUID?: string
}

interface AssistantMessage {
  type: 'assistant'
  message: {
    role: 'assistant'
    content: ContentBlockParam[]
  }
  apiError?: string
}
```

### 9.3 ContentBlockParam 类型

```typescript
// 来自 @anthropic-ai/sdk

type ContentBlockParam =
  | TextBlockParam           // 文本块
  | ImageBlockParam          // 图像块
  | ToolUseBlockParam        // 工具使用块
  | ToolResultBlockParam     // 工具结果块
  | ThinkingBlockParam       // 思考块
  | RedactedThinkingBlockParam  // 编辑后的思考块
  | ConnectorTextBlock       // 连接器文本块 (实验性)
```

---

## 10. 环境变量与配置

### 10.1 Prompt 相关环境变量

| 环境变量 | 用途 | 默认值 |
|---------|------|--------|
| `CLAUDE_CODE_EXTRA_BODY` | API 请求额外 body 参数 | - |
| `CLAUDE_CODE_EXTRA_METADATA` | API 请求额外 metadata | - |
| `DISABLE_PROMPT_CACHING` | 禁用所有 prompt 缓存 | false |
| `DISABLE_PROMPT_CACHING_HAIKU` | 禁用 Haiku 模型缓存 | false |
| `DISABLE_PROMPT_CACHING_SONNET` | 禁用 Sonnet 模型缓存 | false |
| `DISABLE_PROMPT_CACHING_OPUS` | 禁用 Opus 模型缓存 | false |
| `ENABLE_PROMPT_CACHING_1H_BEDROCK` | Bedrock 1h TTL | false |
| `CLAUDE_CODE_COORDINATOR_MODE` | Coordinator 模式 | false |
| `CLAUDE_SKILL_DIR` | 技能目录 (运行时注入) | - |
| `CLAUDE_SESSION_ID` | 会话 ID (运行时注入) | - |

### 10.2 Beta 功能头

| Beta Header | 用途 |
|-------------|------|
| `prompt-caching-2024-07-31` | Prompt 缓存支持 |
| `effort-2026-03-13` | Effort 参数支持 |
| `task-budgets-2026-03-13` | Task Budget 支持 |
| `context-management-2025-04-01` | 上下文管理 |
| `tool-search-2025-06-01` | 工具搜索 |

---

## 11. 性能优化

### 11.1 缓存策略

```
┌─────────────────────────────────────────────────────────────────┐
│                      Prompt 缓存优化策略                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. 系统 Prompt 缓存                                             │
│     • 固定在消息列表开头                                         │
│     • 使用 cache_control 标记                                    │
│                                                                 │
│  2. 工具定义缓存                                                 │
│     • 工具 schema 在会话中保持不变                                │
│     • 使用 cache_control 标记                                    │
│                                                                 │
│  3. 历史消息缓存                                                 │
│     • 早期消息标记为 ephemeral                                   │
│     • 最近消息保持动态                                           │
│                                                                 │
│  4. Skill 内容缓存                                               │
│     • SKILL.md 内容在首次加载后缓存                               │
│     • 使用 memoize() 进行函数结果缓存                            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 11.2 懒加载模式

```typescript
// 文件：src/tools/SkillTool/prompt.ts

// 使用 memoize 缓存 prompt
export const getPrompt = memoize(async (_cwd: string): Promise<string> => {
  return `Execute a skill within the main conversation...`
})

// 缓存清除
export function clearPromptCache(): void {
  getPrompt.cache?.clear?.()
}
```

---

## 12. 错误处理

### 12.1 常见错误类型

| 错误类型 | 原因 | 处理方式 |
|---------|------|---------|
| `MalformedCommandError` | 命令格式错误 | 返回错误消息 |
| `AbortError` | 用户中断 | 显示"Interrupted"消息 |
| `APIConnectionTimeoutError` | API 超时 | 重试机制 |
| `APIUserAbortError` | 用户取消请求 | 优雅退出 |
| `max_output_tokens` | 超出 token 限制 | 恢复循环或提示用户 |

### 12.2 错误恢复流程

```
API 错误
   │
   ▼
┌─────────────────┐
│ 错误类型判断     │
└────────┬────────┘
         │
   ┌─────┴─────┐
   │           │
   ▼           ▼
┌──────┐   ┌──────────┐
│ 可恢复│   │ 不可恢复 │
└──┬───┘   └────┬─────┘
   │            │
   ▼            ▼
┌────────┐  ┌──────────┐
│ 重试   │  │ 返回错误 │
│ 或降级 │  │ 消息     │
└────────┘  └──────────┘
```

---

## 13. 总结

### 13.1 核心设计原则

1. **分层处理**: 从用户输入到 API 请求，经过多层处理和转换
2. **模块化**: 每个组件职责单一，易于测试和维护
3. **可扩展**: 支持自定义 agent、skill、hook 等扩展点
4. **性能优化**: 多级缓存、懒加载、并行处理
5. **错误恢复**: 完善的错误处理和重试机制

### 13.2 关键文件清单

| 文件路径 | 职责 |
|---------|------|
| `src/utils/processUserInput/processSlashCommand.tsx` | 斜杠命令处理入口 |
| `src/utils/systemPrompt.ts` | 系统 prompt 构建 |
| `src/utils/messages.ts` | 消息创建和规范化 |
| `src/services/api/claude.ts` | API 请求构建和调用 |
| `src/services/api/claude.ts` | API 客户端和流式处理 |
| `src/skills/loadSkillsDir.ts` | 技能加载和解析 |
| `src/utils/forkedAgent.ts` | Forked agent 上下文准备 |
| `src/utils/hooks/registerSkillHooks.ts` | 技能钩子注册 |

### 13.3 架构图总结

```
┌─────────────────────────────────────────────────────────────────┐
│                    Yao Code Prompt 生成系统                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  用户输入层                                                       │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ processSlashCommand / processUserInput                  │    │
│  └─────────────────────────────────────────────────────────┘    │
│                          │                                       │
│                          ▼                                       │
│  命令处理层                                                       │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ getMessagesForSlashCommand                              │    │
│  │ └─> getMessagesForPromptSlashCommand                    │    │
│  │     └─> command.getPromptForCommand()                   │    │
│  └─────────────────────────────────────────────────────────┘    │
│                          │                                       │
│                          ▼                                       │
│  上下文准备层                                                     │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ prepareForkedCommandContext                             │    │
│  │ • skillContent                                           │    │
│  │ • allowedTools                                           │    │
│  │ • baseAgent                                              │    │
│  └─────────────────────────────────────────────────────────┘    │
│                          │                                       │
│                          ▼                                       │
│  查询执行层                                                       │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ query()                                                  │    │
│  │ └─> buildEffectiveSystemPrompt()                        │    │
│  │ └─> normalizeMessagesForAPI()                           │    │
│  │ └─> queryModel()                                         │    │
│  └─────────────────────────────────────────────────────────┘    │
│                          │                                       │
│                          ▼                                       │
│  API 请求层                                                       │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ queryModel()                                             │    │
│  │ • 构建请求参数                                            │    │
│  │ • 调用 anthropic.beta.messages.create()                 │    │
│  │ • 处理流式响应                                            │    │
│  └─────────────────────────────────────────────────────────┘    │
│                          │                                       │
│                          ▼                                       │
│  Anthropic API                                                   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

**文档生成时间**: 2026-04-02  
**文档版本**: 1.0  
**生成技能**: brainstorming
