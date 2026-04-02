# Claude Code 服务层架构文档

## 概述

本文档详细描述 Claude Code 服务层（Services Layer）的架构设计、模块组成和执行流程。服务层位于业务逻辑层之下，提供基础设施能力和外部系统集成。

**版本**: 999.0.0-restored  
**最后更新**: 2026-04-01

---

## 目录

1. [服务层概览](#服务层概览)
2. [核心服务模块](#核心服务模块)
3. [服务执行流程](#服务执行流程)
4. [服务间依赖关系](#服务间依赖关系)
5. [流程图和时序图](#流程图和时序图)

---

## 服务层概览

### 目录结构

```
src/services/
├── analytics/              # 分析服务（事件日志、GrowthBook）
├── api/                    # API 客户端服务（Anthropic API、Bootstrap）
├── compact/                # 上下文压缩服务（AutoCompact、MicroCompact）
├── mcp/                    # MCP 协议服务（服务器连接、资源管理）
├── lsp/                    # 语言服务器协议服务
├── plugins/                # 插件管理服务
├── policyLimits/           # 策略限制服务
├── remoteManagedSettings/  # 远程管理服务
├── settingsSync/           # 设置同步服务
├── SessionMemory/          # 会话记忆服务
├── extractMemories/        # 记忆提取服务
├── AgentSummary/           # 代理摘要服务
├── tips/                   # 提示服务
├── oauth/                  # OAuth 认证服务
├── contextCollapse/        # 上下文折叠服务
└── autoDream/              # 自动摘要服务
```

### 服务分层

```
┌─────────────────────────────────────────────────────────────────┐
│                        应用层 (Application)                      │
│  main.tsx, REPL.tsx, QueryEngine.ts                             │
├─────────────────────────────────────────────────────────────────┤
│                        业务逻辑层 (Business Logic)               │
│  query.ts, tools/, commands/                                     │
├─────────────────────────────────────────────────────────────────┤
│                        服务层 (Services) ← 本文档重点            │
│  analytics, api, mcp, lsp, compact, plugins, ...                │
├─────────────────────────────────────────────────────────────────┤
│                        基础设施层 (Infrastructure)               │
│  utils/, state/, constants/                                      │
└─────────────────────────────────────────────────────────────────┘
```

### 服务特点

| 特点 | 描述 |
|------|------|
| **无状态/少状态** | 服务通常无状态，状态存储在 AppState |
| **单例模式** | 关键服务（如 LSP Manager）使用单例 |
| **懒加载** | 服务按需初始化，避免启动延迟 |
| **失败开放** | 服务失败不影响核心功能（fail-open） |
| **背景轮询** | 定期后台更新（如 Policy Limits、Remote Settings） |

---

## 核心服务模块

### 1. 分析服务 (Analytics Service)

**目录**: `src/services/analytics/`

**职责**:
- 事件日志记录和上报
- GrowthBook 特征标志管理
- Datadog 数据上报
- 1P 事件日志导出

**核心文件**:

| 文件 | 职责 |
|------|------|
| `index.ts` | 公共 API，`logEvent()`, `attachAnalyticsSink()` |
| `sink.ts` | 分析后端路由（Datadog、1P 导出） |
| `growthbook.ts` | GrowthBook 初始化、特征值获取 |
| `datadog.ts` | Datadog 数据上报 |
| `firstPartyEventLogger.ts` | 1P 事件日志记录 |
| `metadata.ts` | 事件元数据丰富化 |

**关键接口**:

```typescript
// Analytics sink interface
export type AnalyticsSink = {
  logEvent: (eventName: string, metadata: LogEventMetadata) => void
  logEventAsync: (
    eventName: string,
    metadata: LogEventMetadata,
  ) => Promise<void>
}

// 附加分析接收器
export function attachAnalyticsSink(newSink: AnalyticsSink): void

// 记录事件（同步）
export function logEvent(
  eventName: string,
  metadata: LogEventMetadata,
): void

// 记录事件（异步）
export function logEventAsync(
  eventName: string,
  metadata: LogEventMetadata,
): Promise<void>

// 获取 GrowthBook 特征值
export function getFeatureValue_CACHED_MAY_BE_STALE<T>(
  featureKey: string,
  defaultValue: T,
): T
```

**事件队列机制**:

```typescript
// 事件在接收器附加前排队
const eventQueue: QueuedEvent[] = []
let sink: AnalyticsSink | null = null

// 事件记录
export function logEvent(eventName: string, metadata: LogEventMetadata): void {
  if (sink === null) {
    // 接收器未附加，加入队列
    eventQueue.push({ eventName, metadata, async: false })
    return
  }
  sink.logEvent(eventName, metadata)
}

// 接收器附加时处理队列
export function attachAnalyticsSink(newSink: AnalyticsSink): void {
  if (sink !== null) return
  sink = newSink
  
  if (eventQueue.length > 0) {
    const queuedEvents = [...eventQueue]
    eventQueue.length = 0
    
    queueMicrotask(() => {
      for (const event of queuedEvents) {
        if (event.async) {
          void sink!.logEventAsync(event.eventName, event.metadata)
        } else {
          sink!.logEvent(event.eventName, event.metadata)
        }
      }
    })
  }
}
```

---

### 2. API 服务 (API Service)

**目录**: `src/services/api/`

**职责**:
- Anthropic API 客户端封装
- Bootstrap 数据获取
- 重试逻辑和错误处理
- 使用量跟踪
- 文件 API

**核心文件**:

| 文件 | 职责 |
|------|------|
| `claude.ts` | Anthropic API 客户端，消息发送 |
| `client.ts` | SDK 客户端配置 |
| `bootstrap.ts` | Bootstrap 数据获取 |
| `withRetry.ts` | 重试逻辑 |
| `errors.ts` | API 错误处理 |
| `logging.ts` | API 日志记录 |
| `usage.ts` | 使用量跟踪 |
| `filesApi.ts` | 文件 API |

**API 客户端核心流程**:

```typescript
// src/services/api/claude.ts

export async function sendRequest(
  params: BetaMessageStreamParams,
  options: {
    tools?: Tools
    querySource?: QuerySource
    maxTurns?: number
    // ...
  }
): Promise<Stream<BetaRawMessageStreamEvent>> {
  // 1. 准备请求配置
  const config = await buildRequestConfig(params, options)
  
  // 2. 应用重试逻辑
  return withRetry(async () => {
    // 3. 发送 API 请求
    const stream = await client.beta.messages.stream(config)
    
    // 4. 记录 API 指标
    logAPIMetrics(config)
    
    return stream
  }, {
    maxRetries: options.maxRetries || 3,
    onRetry: (attempt, error) => logRetry(attempt, error),
  })
}

// 构建请求配置
async function buildRequestConfig(
  params: BetaMessageStreamParams,
  options: RequestOptions
): Promise<BetaMessageStreamParams> {
  // 1. 规范化消息
  const normalizedMessages = normalizeMessagesForAPI(params.messages)
  
  // 2. 添加工具定义
  const tools = options.tools?.map(tool => toolToAPISchema(tool))
  
  // 3. 添加系统提示
  const system = buildSystemPrompt(params.systemPrompt)
  
  // 4. 添加 Beta 功能
  const betas = getMergedBetas(options.betas)
  
  // 5. 添加上下文管理
  const contextManagement = getAPIContextManagement()
  
  return {
    model: params.model,
    max_tokens: params.max_tokens,
    messages: normalizedMessages,
    system,
    tools,
    betas,
    ...contextManagement,
  }
}
```

**重试逻辑**:

```typescript
// src/services/api/withRetry.ts

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries: number
    onRetry?: (attempt: number, error: Error) => void
  }
): Promise<T> {
  let lastError: Error
  
  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = toError(error)
      
      // 检查是否可重试
      if (!isRetryableError(lastError)) {
        throw lastError
      }
      
      // 记录重试
      options.onRetry?.(attempt, lastError)
      
      // 等待重试延迟
      const delay = getRetryDelay(attempt)
      await sleep(delay)
    }
  }
  
  throw lastError
}

// 可重试错误类型
export function isRetryableError(error: Error): boolean {
  if (error instanceof APIConnectionTimeoutError) return true
  if (error instanceof APIConnectionError) return true
  if (error.status === 429) return true  // Rate limit
  if (error.status === 503) return true  // Service unavailable
  return false
}
```

---

### 3. MCP 服务 (MCP Service)

**目录**: `src/services/mcp/`

**职责**:
- MCP 服务器连接管理
- 工具和资源发现
- OAuth 认证处理
- 请求路由和响应处理

**核心文件**:

| 文件 | 职责 |
|------|------|
| `client.ts` | MCP 客户端核心逻辑 |
| `config.ts` | MCP 配置解析 |
| `MCPConnectionManager.tsx` | 连接管理器 |
| `auth.ts` | OAuth 认证 |
| `normalization.ts` | 名称规范化 |
| `elicitationHandler.ts` | URL 请求处理 |
| `types.ts` | 类型定义 |

**MCP 连接管理**:

```typescript
// src/services/mcp/client.ts

export class MCPConnectionManager {
  private connections: Map<string, MCPServerConnection> = new Map()
  
  // 添加服务器连接
  async addServer(config: McpSdkServerConfig): Promise<MCPServerConnection> {
    const connection = await this.createConnection(config)
    this.connections.set(config.name, connection)
    return connection
  }
  
  // 创建连接
  private async createConnection(
    config: McpSdkServerConfig
  ): Promise<MCPServerConnection> {
    const client = new Client({
      name: 'claude-code',
      version: getVersion(),
    })
    
    // 根据配置创建传输层
    const transport = this.createTransport(config)
    
    // 连接服务器
    await client.connect(transport)
    
    // 获取工具列表
    const toolsResult = await client.listTools()
    
    // 获取资源列表
    const resourcesResult = await client.listResources()
    
    return {
      client,
      config,
      tools: toolsResult.tools,
      resources: resourcesResult.resources,
      status: 'connected',
    }
  }
  
  // 创建传输层
  private createTransport(config: McpSdkServerConfig): Transport {
    if (config.type === 'stdio') {
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env,
      })
    }
    
    if (config.type === 'sse') {
      return new SSEClientTransport(config.url)
    }
    
    if (config.type === 'streamable-http') {
      return new StreamableHTTPClientTransport(config.url)
    }
    
    throw new Error(`Unknown transport type: ${config.type}`)
  }
}
```

**MCP 工具调用**:

```typescript
// MCP 工具执行
export async function callMcpTool(
  connection: MCPServerConnection,
  toolName: string,
  args: Record<string, unknown>
): Promise<MCPToolResult> {
  try {
    // 调用工具
    const result = await connection.client.callTool({
      name: toolName,
      arguments: args,
    })
    
    // 处理结果
    const content = result.content || []
    
    // 检查是否需要持久化
    if (mcpContentNeedsTruncation(content)) {
      const persistedResult = await persistToolResult(content)
      return {
        type: 'persisted',
        path: persistedResult.path,
        preview: persistedResult.preview,
      }
    }
    
    return {
      type: 'inline',
      content: content,
    }
  } catch (error) {
    // 处理 401 错误（OAuth 过期）
    if (isMcpAuthError(error)) {
      await handleOAuth401Error(error, connection)
      // 重试
      return callMcpTool(connection, toolName, args)
    }
    
    throw error
  }
}
```

---

### 4. 上下文压缩服务 (Compact Service)

**目录**: `src/services/compact/`

**职责**:
- 自动上下文压缩
- 微压缩（MicroCompact）
- 会话记忆压缩
- 压缩后清理

**核心文件**:

| 文件 | 职责 |
|------|------|
| `autoCompact.ts` | 自动压缩逻辑 |
| `compact.ts` | 核心压缩函数 |
| `microCompact.ts` | 微压缩 |
| `apiMicrocompact.ts` | API 级压缩 |
| `reactiveCompact.ts` | 响应式压缩 |
| `snipCompact.ts` | 片段压缩 |
| `postCompactCleanup.ts` | 压缩后清理 |

**自动压缩触发条件**:

```typescript
// src/services/compact/autoCompact.ts

// 压缩阈值常量
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000

// 获取自动压缩阈值
export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)
  return effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS
}

// 计算令牌警告状态
export function calculateTokenWarningState(
  tokenUsage: number,
  model: string
): {
  percentLeft: number
  isAboveWarningThreshold: boolean
  isAboveErrorThreshold: boolean
  isAboveAutoCompactThreshold: boolean
  isAtBlockingLimit: boolean
} {
  const autoCompactThreshold = getAutoCompactThreshold(model)
  const threshold = isAutoCompactEnabled()
    ? autoCompactThreshold
    : getEffectiveContextWindowSize(model)
  
  const percentLeft = Math.max(
    0,
    Math.round(((threshold - tokenUsage) / threshold) * 100)
  )
  
  const warningThreshold = threshold - WARNING_THRESHOLD_BUFFER_TOKENS
  const errorThreshold = threshold - ERROR_THRESHOLD_BUFFER_TOKENS
  
  return {
    percentLeft,
    isAboveWarningThreshold: tokenUsage >= warningThreshold,
    isAboveErrorThreshold: tokenUsage >= errorThreshold,
    isAboveAutoCompactThreshold: isAutoCompactEnabled() && tokenUsage >= autoCompactThreshold,
    isAtBlockingLimit: tokenUsage >= threshold - MANUAL_COMPACT_BUFFER_TOKENS,
  }
}
```

**压缩执行流程**:

```typescript
// src/services/compact/compact.ts

export async function compactConversation(
  messages: Message[],
  options: {
    model: string
    systemPrompt: SystemPrompt
    toolUseContext: ToolUseContext
  }
): Promise<CompactionResult> {
  // 1. 选择压缩点
  const compactionPoint = findCompactionPoint(messages)
  
  // 2. 分离要压缩的消息
  const messagesToCompact = messages.slice(0, compactionPoint)
  const messagesToKeep = messages.slice(compactionPoint)
  
  // 3. 调用模型生成摘要
  const summary = await generateSummary(messagesToCompact, {
    model: options.model,
    systemPrompt: options.systemPrompt,
  })
  
  // 4. 构建压缩后的消息
  const compactedMessages = [
    createSystemMessage({
      type: 'compact_boundary',
      message: `Previous conversation summarized: ${summary}`,
    }),
    ...messagesToKeep,
  ]
  
  // 5. 记录压缩事件
  logEvent('context_compacted', {
    messages_removed: messagesToCompact.length,
    tokens_saved: estimateTokens(messagesToCompact),
  })
  
  return {
    messages: compactedMessages,
    summary,
    tokensSaved: estimateTokens(messagesToCompact),
  }
}
```

---

### 5. LSP 服务 (LSP Service)

**目录**: `src/services/lsp/`

**职责**:
- 语言服务器管理
- 诊断注册
- 被动反馈
- 服务器生命周期

**核心文件**:

| 文件 | 职责 |
|------|------|
| `manager.ts` | LSP 服务器管理器 |
| `LSPServerManager.ts` | 服务器管理实现 |
| `LSPClient.ts` | LSP 客户端 |
| `LSPDiagnosticRegistry.ts` | 诊断注册 |
| `passiveFeedback.ts` | 被动反馈处理 |
| `config.ts` | LSP 配置 |

**LSP 管理器初始化**:

```typescript
// src/services/lsp/manager.ts

let lspManagerInstance: LSPServerManager | undefined
let initializationState: InitializationState = 'not-started'
let initializationPromise: Promise<void> | undefined

export function initializeLspServerManager(): void {
  if (isBareMode()) {
    return  // --bare 模式不启用 LSP
  }
  
  if (initializationState !== 'not-started') {
    return  // 已初始化或正在初始化
  }
  
  initializationState = 'pending'
  
  // 创建管理器实例
  lspManagerInstance = createLSPServerManager()
  
  // 异步初始化（不阻塞启动）
  initializationPromise = (async () => {
    try {
      // 加载 LSP 配置
      const configs = await loadLspConfigs()
      
      // 启动服务器
      for (const config of configs) {
        await lspManagerInstance!.startServer(config)
      }
      
      // 注册通知处理程序
      registerLSPNotificationHandlers(lspManagerInstance!)
      
      initializationState = 'success'
    } catch (error) {
      initializationState = 'failed'
      initializationError = toError(error)
      logError(error)
    }
  })()
}

// 获取管理器实例
export function getLspServerManager(): LSPServerManager | undefined {
  if (initializationState === 'failed') {
    return undefined
  }
  return lspManagerInstance
}

// 等待初始化完成
export async function waitForInitialization(): Promise<void> {
  if (initializationState === 'success' || initializationState === 'failed') {
    return
  }
  
  if (initializationState === 'pending' && initializationPromise) {
    await initializationPromise
  }
}
```

---

### 6. 策略限制服务 (Policy Limits Service)

**目录**: `src/services/policyLimits/`

**职责**:
- 获取组织级策略限制
- ETag 缓存
- 后台轮询
- 功能禁用

**核心文件**:

| 文件 | 职责 |
|------|------|
| `index.ts` | 公共 API |
| `types.ts` | 类型定义 |

**策略限制加载**:

```typescript
// src/services/policyLimits/index.ts

let sessionCache: PolicyLimitsResponse['restrictions'] | null = null
let pollingIntervalId: ReturnType<typeof setInterval> | null = null

// 加载策略限制
export async function loadPolicyLimits(): Promise<PolicyLimitsFetchResult> {
  if (!isPolicyLimitsEligible()) {
    return { status: 'not-eligible' }
  }
  
  try {
    // 1. 检查会话缓存
    if (sessionCache) {
      applyPolicyRestrictions(sessionCache)
      return { status: 'cached' }
    }
    
    // 2. 检查磁盘缓存
    const cached = await loadFromDiskCache()
    if (cached && !isCacheExpired(cached)) {
      sessionCache = cached.restrictions
      applyPolicyRestrictions(cached.restrictions)
      return { status: 'disk-cache' }
    }
    
    // 3. 从 API 获取
    const response = await fetchPolicyLimitsFromApi()
    
    // 4. 更新缓存
    await saveToDiskCache(response)
    sessionCache = response.restrictions
    
    // 5. 应用限制
    applyPolicyRestrictions(response.restrictions)
    
    // 6. 启动后台轮询
    startBackgroundPolling()
    
    return { status: 'fetched' }
  } catch (error) {
    // 失败开放：继续而不应用限制
    logError(error)
    return { status: 'error', error }
  }
}

// 应用策略限制
function applyPolicyRestrictions(restrictions: PolicyRestrictions): void {
  // 禁用 MCP 服务器
  if (restrictions.disabledMcpServers) {
    for (const serverName of restrictions.disabledMcpServers) {
      disableMcpServer(serverName)
    }
  }
  
  // 禁用工具
  if (restrictions.disabledTools) {
    for (const toolName of restrictions.disabledTools) {
      disableTool(toolName)
    }
  }
  
  // 禁用命令
  if (restrictions.disabledCommands) {
    for (const commandName of restrictions.disabledCommands) {
      disableCommand(commandName)
    }
  }
}
```

---

### 7. 远程管理服务 (Remote Managed Settings)

**目录**: `src/services/remoteManagedSettings/`

**职责**:
- 获取远程管理设置
- 校验和验证
- 安全校验
- 后台同步

**核心文件**:

| 文件 | 职责 |
|------|------|
| `index.ts` | 公共 API |
| `syncCache.ts` | 同步缓存 |
| `securityCheck.tsx` | 安全校验 |
| `types.ts` | 类型定义 |

**远程设置加载**:

```typescript
// src/services/remoteManagedSettings/index.ts

export async function loadRemoteManagedSettings(): Promise<RemoteManagedSettingsFetchResult> {
  if (!isRemoteManagedSettingsEligible()) {
    return { status: 'not-eligible' }
  }
  
  try {
    // 1. 从缓存获取当前设置
    const cachedSettings = getRemoteManagedSettingsSyncFromCache()
    
    // 2. 计算校验和
    const currentChecksum = cachedSettings 
      ? computeChecksumFromSettings(cachedSettings)
      : null
    
    // 3. 发送请求（带 If-None-Match）
    const response = await axios.get(getRemoteManagedSettingsEndpoint(), {
      headers: {
        'If-None-Match': currentChecksum,
      },
      timeout: SETTINGS_TIMEOUT_MS,
    })
    
    // 4. 处理响应
    if (response.status === 304) {
      // 未修改，使用缓存
      return { status: 'not-modified' }
    }
    
    // 5. 验证新设置
    const newSettings = RemoteManagedSettingsResponseSchema.parse(response.data)
    
    // 6. 安全校验
    const securityResult = await checkManagedSettingsSecurity(newSettings.settings)
    handleSecurityCheckResult(securityResult)
    
    // 7. 保存设置
    await saveSettings(newSettings.settings)
    
    // 8. 启动后台轮询
    startBackgroundPolling()
    
    return { status: 'updated', settings: newSettings.settings }
  } catch (error) {
    // 失败开放
    logError(error)
    return { status: 'error', error }
  }
}
```

---

### 8. 记忆提取服务 (Extract Memories Service)

**目录**: `src/services/extractMemories/`

**职责**:
- 从会话中提取持久记忆
- 写入记忆目录
- 使用分叉代理模式

**核心文件**:

| 文件 | 职责 |
|------|------|
| `extractMemories.ts` | 提取逻辑 |
| `prompts.ts` | 提示模板 |

**记忆提取流程**:

```typescript
// src/services/extractMemories/extractMemories.ts

export async function runExtraction(
  messages: Message[],
  canUseTool: CanUseToolFn,
  options: {
    cwd: string
    autoMemPath?: string
  }
): Promise<void> {
  // 1. 检查是否启用自动记忆
  const { enabled, autoMemPath } = await isAutoMemoryEnabled(options.cwd)
  if (!enabled) return
  
  // 2. 检查是否有记忆写入（避免重复）
  if (hasMemoryWritesSince(messages, lastExtractionCursor)) {
    return
  }
  
  // 3. 计算要处理的消息数
  const messagesSinceLastExtraction = countModelVisibleMessagesSince(
    messages,
    lastExtractionCursor
  )
  
  // 4. 检查是否达到阈值
  if (messagesSinceLastExtraction < MIN_MESSAGES_FOR_EXTRACTION) {
    return
  }
  
  // 5. 扫描现有记忆
  const existingMemories = await scanMemoryFiles(autoMemPath)
  
  // 6. 构建提示
  const prompt = existingMemories.length > 0
    ? buildExtractCombinedPrompt(messages, existingMemories)
    : buildExtractAutoOnlyPrompt(messages)
  
  // 7. 运行分叉代理
  const result = await runForkedAgent({
    prompt,
    options: {
      agentType: 'memory-extractor',
      maxTurns: 5,
      cwd: options.cwd,
    },
  })
  
  // 8. 更新游标
  lastExtractionCursor = getLastMessageUuid(messages)
  
  // 9. 显示记忆保存消息
  if (result.memoriesExtracted > 0) {
    const notificationMessage = createMemorySavedMessage({
      count: result.memoriesExtracted,
    })
    appendSystemMessage(notificationMessage)
  }
}
```

---

### 9. 插件服务 (Plugins Service)

**目录**: `src/services/plugins/`

**职责**:
- 插件安装/卸载
- 插件启用/禁用
- 版本管理
- 市场集成

**核心文件**:

| 文件 | 职责 |
|------|------|
| `pluginOperations.ts` | 核心操作 |
| `pluginCliCommands.ts` | CLI 命令封装 |
| `pluginLoader.ts` | 插件加载 |
| `installedPluginsManager.ts` | 已安装管理 |
| `marketplaceManager.ts` | 市场管理 |

**插件安装流程**:

```typescript
// src/services/plugins/pluginOperations.ts

export async function installPluginOp(
  plugin: string,
  scope: InstallableScope
): Promise<PluginOperationResult> {
  try {
    // 1. 解析插件标识符
    const { name, marketplace, version } = parsePluginIdentifier(plugin)
    
    // 2. 获取市场配置
    const marketplaceConfig = await getMarketplaceConfig(marketplace)
    
    // 3. 解析插件清单
    const manifest = await fetchPluginManifest(marketplaceConfig, name)
    
    // 4. 下载插件
    const pluginPath = await downloadPlugin(
      marketplaceConfig,
      name,
      version || manifest.version
    )
    
    // 5. 安装到指定范围
    const installPath = getInstallPath(scope, name)
    await installPluginToPath(pluginPath, installPath)
    
    // 6. 记录事件
    logEvent('tengu_plugin_installed', {
      plugin_name: name,
      marketplace_name: marketplace,
      scope: scope,
    })
    
    return {
      success: true,
      message: `Plugin ${name} installed successfully`,
      pluginId: `${name}@${marketplace}`,
      scope,
    }
  } catch (error) {
    return {
      success: false,
      message: `Failed to install plugin: ${errorMessage(error)}`,
      error,
    }
  }
}
```

---

## 服务执行流程

### 系统启动时的服务初始化

```
main.tsx:init()
│
├─► 1. 应用环境变量
│   └─► applyConfigEnvironmentVariables()
│
├─► 2. 初始化遥测
│   └─► initializeTelemetry()
│       └─► attachAnalyticsSink()
│
├─► 3. 加载策略限制
│   └─► loadPolicyLimits()
│       ├── 检查资格
│       ├── 加载磁盘缓存
│       ├── API 获取
│       └── 启动后台轮询
│
├─► 4. 加载远程设置
│   └─► loadRemoteManagedSettings()
│       ├── 检查资格
│       ├── 校验和验证
│       ├── API 获取
│       └── 启动后台轮询
│
├─► 5. 初始化 LSP
│   └─► initializeLspServerManager()
│       ├── 创建实例
│       └── 异步加载配置
│
├─► 6. 初始化 MCP
│   └─► getMcpToolsCommandsAndResources()
│       ├── 解析配置
│       ├── 创建连接
│       └── 获取工具/资源
│
├─► 7. 初始化插件
│   └─► loadAllPluginsCacheOnly()
│
└─► 8. 初始化技能
    └─► initBundledSkills()
```

---

## 服务间依赖关系

```
┌─────────────────────────────────────────────────────────────────┐
│                        服务依赖图                                │
└─────────────────────────────────────────────────────────────────┘

                    ┌───────────────┐
                    │   Analytics   │
                    │   (分析服务)   │
                    └───────┬───────┘
                            │ (被依赖)
        ┌───────────────────┼───────────────────┐
        │                   │                   │
        ▼                   ▼                   ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│      API      │   │     MCP       │   │     LSP       │
│   (API 服务)    │   │  (MCP 服务)    │   │  (LSP 服务)    │
└───────┬───────┘   └───────┬───────┘   └───────────────┘
        │                   │
        │                   │
        ▼                   ▼
┌───────────────┐   ┌───────────────┐
│    Compact    │   │    Plugins    │
│  (压缩服务)    │   │  (插件服务)    │
└───────┬───────┘   └───────────────┘
        │
        │
        ▼
┌───────────────┐
│    Session    │
│    Memory     │
│  (会话记忆)    │
└───────────────┘

独立服务（无依赖）:
- Policy Limits (策略限制)
- Remote Managed Settings (远程管理)
- Extract Memories (记忆提取)
```

---

## 流程图和时序图

### 服务初始化时序图

```
┌─────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐
│main │  │Analytics  │  │  Policy   │  │  Remote   │  │    LSP    │  │    MCP    │
│     │  │           │  │  Limits   │  │ Settings  │  │           │  │           │
└──┬──┘  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘
   │          │               │              │              │              │
   │ 调用 init │               │              │              │              │
   │─────────>│               │              │              │              │
   │          │               │              │              │              │
   │          │ attachSink()  │              │              │              │
   │          │──────────────>│              │              │              │
   │          │               │              │              │              │
   │          │ loadPolicyLimits()           │              │              │
   │          │──────────────>│              │              │              │
   │          │               │              │              │              │
   │          │               │ eligibility  │              │              │
   │          │               │─────────────>│              │              │
   │          │               │              │              │              │
   │          │               │ cache check  │              │              │
   │          │               │─────────────>│              │              │
   │          │               │              │              │              │
   │          │               │ API fetch    │              │              │
   │          │               │─────────────>│              │              │
   │          │               │              │              │              │
   │          │               │<─────────────│              │              │
   │          │               │              │              │              │
   │          │<──────────────│              │              │              │
   │          │               │              │              │              │
   │          │                              │ loadRemote │              │
   │          │                              │───────────>│              │
   │          │                              │            │              │
   │          │                              │ checksum   │              │
   │          │                              │───────────>│              │
   │          │                              │            │              │
   │          │                              │ API fetch  │              │
   │          │                              │───────────>│              │
   │          │                              │            │              │
   │          │                              │<───────────│              │
   │          │                              │            │              │
   │          │<─────────────────────────────│            │              │
   │          │                                             │            │
   │          │                                             │ initLSP    │
   │          │                                             │───────────>│
   │          │                                             │            │
   │          │                                             │ async init │
   │          │                                             │───────────>│
   │          │                                             │            │
   │          │<────────────────────────────────────────────│            │
   │          │                                                          │
   │          │                                                          │ getMCP   │
   │          │                                                          │─────────>│
   │          │                                                          │          │
   │          │<─────────────────────────────────────────────────────────│
   │          │
   │ 初始化完成 │
   │<─────────│
```

### MCP 工具调用流程

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          MCP 工具调用流程                                    │
└─────────────────────────────────────────────────────────────────────────────┘

用户/模型请求调用 MCP 工具
│
▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. 查找 MCP 连接                                                               │
│    - 根据工具名前缀 (mcp__server__tool) 查找服务器                            │
│    - 验证连接状态                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
│
▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. 权限检查                                                                  │
│    - checkPermissions()                                                      │
│    - 验证服务器是否被禁用                                                      │
│    - 验证工具是否被允许                                                        │
└─────────────────────────────────────────────────────────────────────────────┘
│
▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. 调用工具                                                                  │
│    - client.callTool({ name, arguments })                                   │
│    - 等待响应                                                                 │
└─────────────────────────────────────────────────────────────────────────────┘
│
├──────────────────────────┬──────────────────────────┐
│ 成功                     │ 失败                      │
▼                          ▼                          │
┌─────────────────────┐   ┌─────────────────────┐     │
│ 4a. 处理结果         │   │ 4b. 错误处理         │     │
│    - 检查内容大小    │   │    - 401 错误        │     │
│    - 持久化大内容    │   │    - OAuth 刷新      │     │
│    - 返回内联结果    │   │    - 重试调用        │     │
└─────────────────────┘   └─────────────────────┘     │
│                          │                          │
└──────────────────────────┴──────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 5. 返回结果                                                                  │
│    - ToolResult { data, newMessages }                                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 自动压缩触发流程

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          自动压缩触发流程                                    │
└─────────────────────────────────────────────────────────────────────────────┘

每轮查询后
│
▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. 计算令牌使用情况                                                          │
│    - tokenCountWithEstimation(messages)                                     │
└─────────────────────────────────────────────────────────────────────────────┘
│
▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. 检查阈值                                                                  │
│    - isAboveAutoCompactThreshold?                                           │
│    - isAutoCompactEnabled?                                                  │
│    - consecutiveFailures < MAX?                                             │
└─────────────────────────────────────────────────────────────────────────────┘
│
├──────────────────────────┬──────────────────────────┐
│ 超过阈值                 │ 未超过阈值                │
▼                          ▼                          │
┌─────────────────────┐   │                          │
│ 3. 执行压缩          │   │   继续正常流程            │
│    - findCompactionPoint()                          │
│    - generateSummary()                              │
│    - buildCompactMessages()                         │
└─────────────────────┘   │                          │
│                          │                          │
├──────────────────────────┴──────────────────────────┘
│
▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 4. 压缩后清理                                                                │
│    - runPostCompactCleanup()                                                 │
│    - 清理文件缓存                                                             │
│    - 更新状态                                                                 │
└─────────────────────────────────────────────────────────────────────────────┘
│
▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 5. 记录事件                                                                  │
│    - logEvent('context_compacted', { ... })                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 相关文件索引

| 服务 | 核心文件 |
|------|----------|
| Analytics | `src/services/analytics/index.ts`, `sink.ts`, `growthbook.ts` |
| API | `src/services/api/claude.ts`, `client.ts`, `withRetry.ts` |
| MCP | `src/services/mcp/client.ts`, `config.ts`, `MCPConnectionManager.tsx` |
| LSP | `src/services/lsp/manager.ts`, `LSPServerManager.ts` |
| Compact | `src/services/compact/autoCompact.ts`, `compact.ts`, `microCompact.ts` |
| Policy Limits | `src/services/policyLimits/index.ts` |
| Remote Settings | `src/services/remoteManagedSettings/index.ts` |
| Plugins | `src/services/plugins/pluginOperations.ts`, `pluginLoader.ts` |
| Extract Memories | `src/services/extractMemories/extractMemories.ts` |

---

*文档生成时间：2026-04-01*
