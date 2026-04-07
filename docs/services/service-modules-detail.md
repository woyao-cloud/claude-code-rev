# 服务模块详细实现

## 概述

本文档深入分析 Yao Code 各服务模块的内部实现细节。

---

## 目录

1. [分析服务深入](#分析服务深入)
2. [API 服务深入](#api 服务深入)
3. [MCP 服务深入](#mcp 服务深入)
4. [LSP 服务深入](#lsp 服务深入)
5. [上下文压缩服务深入](#上下文压缩服务深入)
6. [记忆服务深入](#记忆服务深入)

---

## 分析服务深入

### 事件日志架构

```typescript
// src/services/analytics/index.ts

// 事件队列（接收器附加前）
const eventQueue: QueuedEvent[] = []
let sink: AnalyticsSink | null = null

// 日志事件（同步）
export function logEvent(
  eventName: string,
  metadata: LogEventMetadata,
): void {
  if (sink === null) {
    // 接收器未附加，加入队列
    eventQueue.push({ eventName, metadata, async: false })
    return
  }
  sink.logEvent(eventName, metadata)
}

// 日志事件（异步）
export function logEventAsync(
  eventName: string,
  metadata: LogEventMetadata,
): Promise<void> {
  if (sink === null) {
    eventQueue.push({ eventName, metadata, async: true })
    return Promise.resolve()
  }
  return sink.logEventAsync(eventName, metadata)
}

// 附加接收器
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

### GrowthBook 特征标志

```typescript
// src/services/analytics/growthbook.ts

let growthBook: GrowthBook | null = null
let featureCache: Map<string, { value: unknown; timestamp: number }> = new Map()

// 初始化 GrowthBook
export async function initializeGrowthBook(): Promise<void> {
  growthBook = new GrowthBook({
    enableDevMode: process.env.NODE_ENV === 'development',
  })
  
  // 获取特征配置
  const response = await fetch(GROWTHBOOK_API_URL)
  const features = await response.json()
  
  growthBook.setFeatures(features)
}

// 获取特征值（带缓存）
export function getFeatureValue_CACHED_MAY_BE_STALE<T>(
  featureKey: string,
  defaultValue: T,
): T {
  const cached = featureCache.get(featureKey)
  const now = Date.now()
  
  // 缓存 5 分钟
  if (cached && now - cached.timestamp < 5 * 60 * 1000) {
    return cached.value as T
  }
  
  if (!growthBook) {
    return defaultValue
  }
  
  const value = growthBook.getFeatureValue(featureKey, defaultValue)
  
  featureCache.set(featureKey, {
    value,
    timestamp: now,
  })
  
  return value
}

// 刷新特征
export async function refreshGrowthBookAfterAuthChange(): Promise<void> {
  if (!growthBook) return
  
  try {
    const response = await fetch(GROWTHBOOK_API_URL)
    const features = await response.json()
    growthBook.setFeatures(features)
    featureCache.clear()
  } catch (error) {
    logError(error)
  }
}
```

### Datadog 数据上报

```typescript
// src/services/analytics/datadog.ts

const DATADOG_CLIENT_TOKEN = process.env.DATADOG_CLIENT_TOKEN
const DATADOG_SITE = 'datadoghq.com'
const DATADOG_SERVICE = 'claude-code'

let datadogClient: DatadogClient | null = null

export function initializeDatadogClient(): void {
  datadogClient = new DatadogClient({
    clientToken: DATADOG_CLIENT_TOKEN,
    site: DATADOG_SITE,
    service: DATADOG_SERVICE,
  })
}

export async function sendToDatadog(
  eventName: string,
  metadata: LogEventMetadata,
): Promise<void> {
  if (!datadogClient) return
  
  try {
    await datadogClient.logEvent({
      service: DATADOG_SERVICE,
      event: eventName,
      metadata: {
        ...metadata,
        timestamp: Date.now(),
        session_id: getSessionId(),
      },
    })
  } catch (error) {
    // Datadog 失败不影响主流程
    logForDebugging(`Datadog send failed: ${errorMessage(error)}`)
  }
}
```

---

## API 服务深入

### 请求配置构建

```typescript
// src/services/api/claude.ts

interface BuildRequestConfigOptions {
  messages: Message[]
  systemPrompt: SystemPrompt
  tools?: Tools
  model: string
  maxTokens?: number
  betas?: string[]
}

async function buildRequestConfig(
  options: BuildRequestConfigOptions
): Promise<BetaMessageStreamParams> {
  // 1. 规范化消息
  const normalizedMessages = normalizeMessagesForAPI(options.messages)
  
  // 2. 添加工具
  const tools = options.tools?.map(tool => ({
    name: tool.name,
    description: await tool.description(null, {
      isNonInteractiveSession: false,
      toolPermissionContext: getEmptyToolPermissionContext(),
      tools: options.tools || [],
    }),
    input_schema: tool.inputJSONSchema || zodToJsonSchema(tool.inputSchema),
  }))
  
  // 3. 构建系统提示
  const system = await buildSystemPrompt(options.systemPrompt)
  
  // 4. 合并 Beta 功能
  const betas = getMergedBetas(options.betas)
  
  // 5. 上下文管理
  const contextManagement = getAPIContextManagement()
  
  return {
    model: options.model,
    max_tokens: options.maxTokens || getDefaultMaxTokens(options.model),
    messages: normalizedMessages,
    system,
    tools,
    betas,
    ...contextManagement,
  }
}

// 工具转 API Schema
export function toolToAPISchema(tool: Tool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputJSONSchema || zodToJsonSchema(tool.inputSchema),
    // 缓存编辑功能
    ...(tool.alwaysLoad ? { cache_control: { type: 'ephemeral' } } : {}),
  }
}
```

### 流式响应处理

```typescript
// src/query.ts

export async function* query(
  params: QueryParams
): AsyncGenerator<StreamEvent | Message, Terminal> {
  const stream = await sendRequest(
    {
      model: params.model,
      max_tokens: params.maxOutputTokensOverride,
      messages: normalizeMessagesForAPI(params.messages),
      system: params.systemPrompt,
      tools: params.toolUseContext.options.tools,
    },
    params.options
  )
  
  let currentMessage: AssistantMessage | null = null
  let currentContentBlock: ContentBlock | null = null
  
  for await (const event of stream) {
    switch (event.type) {
      case 'message_start':
        // 消息开始
        yield { type: 'request_start', usage: event.message.usage }
        break
        
      case 'content_block_start':
        // 内容块开始
        currentContentBlock = {
          type: event.content_block.type,
          content: '',
          index: event.index,
        }
        break
        
      case 'content_block_delta':
        // 内容增量
        if (currentContentBlock) {
          currentContentBlock.content += event.delta.text
          yield {
            type: 'content_delta',
            delta: event.delta.text,
            index: event.index,
          }
        }
        break
        
      case 'content_block_stop':
        // 内容块完成
        if (currentMessage && currentContentBlock) {
          currentMessage.message.content.push(currentContentBlock)
          currentContentBlock = null
        }
        break
        
      case 'message_delta':
        // 消息增量（使用量）
        yield {
          type: 'message_delta',
          usage: event.usage,
          stop_reason: event.delta.stop_reason,
        }
        break
        
      case 'message_stop':
        // 消息完成
        if (currentMessage) {
          yield currentMessage
          currentMessage = null
        }
        break
    }
  }
  
  return { type: 'complete' }
}
```

### 错误处理

```typescript
// src/services/api/errors.ts

export function categorizeRetryableAPIError(
  error: unknown
): {
  shouldRetry: boolean
  reason: string
  retryAfter?: number
} {
  if (error instanceof APIConnectionTimeoutError) {
    return {
      shouldRetry: true,
      reason: 'Connection timeout',
    }
  }
  
  if (error instanceof APIConnectionError) {
    return {
      shouldRetry: true,
      reason: 'Connection error',
    }
  }
  
  if (error instanceof APIError) {
    switch (error.status) {
      case 429:
        // Rate limit
        const retryAfter = error.headers?.['retry-after']
        return {
          shouldRetry: true,
          reason: 'Rate limited',
          retryAfter: retryAfter ? parseInt(retryAfter) * 1000 : undefined,
        }
      
      case 503:
        // Service unavailable
        return {
          shouldRetry: true,
          reason: 'Service unavailable',
        }
      
      case 500:
        // Server error
        return {
          shouldRetry: true,
          reason: 'Server error',
        }
      
      default:
        return {
          shouldRetry: false,
          reason: `API error: ${error.status}`,
        }
    }
  }
  
  return {
    shouldRetry: false,
    reason: 'Unknown error',
  }
}
```

---

## MCP 服务深入

### 连接管理器实现

```typescript
// src/services/mcp/MCPConnectionManager.tsx

export class MCPConnectionManager {
  private connections: Map<string, MCPServerConnection> = new Map()
  private eventEmitter: EventEmitter = new EventEmitter()
  
  // 添加服务器
  async addServer(config: McpSdkServerConfig): Promise<MCPServerConnection> {
    const existing = this.connections.get(config.name)
    if (existing) {
      return existing
    }
    
    const connection = await this.createConnection(config)
    this.connections.set(config.name, connection)
    
    this.eventEmitter.emit('connection-added', connection)
    
    return connection
  }
  
  // 移除服务器
  async removeServer(name: string): Promise<void> {
    const connection = this.connections.get(name)
    if (!connection) return
    
    await connection.client.close()
    this.connections.delete(name)
    
    this.eventEmitter.emit('connection-removed', name)
  }
  
  // 获取所有连接
  getAllConnections(): MCPServerConnection[] {
    return Array.from(this.connections.values())
  }
  
  // 按名称获取连接
  getConnection(name: string): MCPServerConnection | undefined {
    return this.connections.get(name)
  }
  
  // 创建连接
  private async createConnection(
    config: McpSdkServerConfig
  ): Promise<MCPServerConnection> {
    const client = new Client({
      name: 'claude-code',
      version: getVersion(),
    })
    
    const transport = this.createTransport(config)
    
    try {
      await client.connect(transport)
      
      const [toolsResult, resourcesResult] = await Promise.all([
        client.listTools(),
        client.listResources(),
      ])
      
      return {
        client,
        config,
        tools: toolsResult.tools,
        resources: resourcesResult.resources,
        status: 'connected',
        connectedAt: Date.now(),
      }
    } catch (error) {
      return {
        config,
        status: 'error',
        error: toError(error),
      }
    }
  }
  
  // 创建传输层
  private createTransport(config: McpSdkServerConfig): Transport {
    switch (config.type) {
      case 'stdio':
        return new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: { ...subprocessEnv, ...config.env },
        })
      
      case 'sse':
        return new SSEClientTransport(new URL(config.url), {
          requestInit: {
            headers: getMcpServerHeaders(config.name),
          },
        })
      
      case 'streamable-http':
        return new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: {
            headers: getMcpServerHeaders(config.name),
          },
        })
      
      default:
        throw new Error(`Unknown transport type: ${config.type}`)
    }
  }
}
```

### OAuth 认证处理

```typescript
// src/services/mcp/auth.ts

export class ClaudeAuthProvider {
  private oauthConfig: OAuthConfig
  
  constructor(oauthConfig: OAuthConfig) {
    this.oauthConfig = oauthConfig
  }
  
  // 获取访问令牌
  async getAccessToken(): Promise<string> {
    const tokens = await getClaudeAIOAuthTokens()
    
    if (!tokens || !tokens.access_token) {
      throw new Error('No OAuth tokens available')
    }
    
    // 检查是否过期
    if (this.isTokenExpired(tokens)) {
      const newTokens = await this.refreshTokens(tokens.refresh_token)
      return newTokens.access_token
    }
    
    return tokens.access_token
  }
  
  // 刷新令牌
  private async refreshTokens(refreshToken: string): Promise<OAuthTokens> {
    const response = await axios.post(this.oauthConfig.TOKEN_URL, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.oauthConfig.CLIENT_ID,
    })
    
    const newTokens = OAuthTokensSchema.parse(response.data)
    
    // 保存新令牌
    await saveClaudeAIOAuthTokens(newTokens)
    
    return newTokens
  }
  
  // 检查令牌是否过期
  private isTokenExpired(tokens: OAuthTokens): boolean {
    const expiresAt = tokens.expires_at || tokens.expires_in
    if (!expiresAt) return false
    
    // 提前 5 分钟刷新
    const bufferMs = 5 * 60 * 1000
    return Date.now() >= (expiresAt - bufferMs)
  }
}

// 处理 401 错误
export async function handleOAuth401Error(
  error: unknown,
  connection: MCPServerConnection
): Promise<void> {
  if (!isAuthError(error)) {
    throw error
  }
  
  // 清除缓存的令牌
  await clearKeychainCache()
  
  // 尝试重新认证
  try {
    const newToken = await claudeAuthProvider.getAccessToken()
    
    // 更新连接
    connection.accessToken = newToken
    connection.status = 'connected'
  } catch (refreshError) {
    connection.status = 'needs-auth'
    connection.error = toError(refreshError)
    throw refreshError
  }
}
```

---

## LSP 服务深入

### 服务器管理器

```typescript
// src/services/lsp/LSPServerManager.ts

export class LSPServerManager {
  private servers: Map<string, LSPServerInstance> = new Map()
  private diagnosticRegistry: LSPDiagnosticRegistry
  
  constructor() {
    this.diagnosticRegistry = new LSPDiagnosticRegistry()
  }
  
  // 启动服务器
  async startServer(config: LSPServerConfig): Promise<void> {
    const server = new LSPServerInstance(config)
    
    // 注册诊断处理程序
    server.onDiagnostics(diagnostics => {
      this.diagnosticRegistry.updateDiagnostics(config.id, diagnostics)
    })
    
    // 启动
    await server.start()
    
    this.servers.set(config.id, server)
    
    logForDebugging(`LSP server started: ${config.id}`)
  }
  
  // 停止服务器
  async stopServer(id: string): Promise<void> {
    const server = this.servers.get(id)
    if (!server) return
    
    await server.stop()
    this.servers.delete(id)
    
    logForDebugging(`LSP server stopped: ${id}`)
  }
  
  // 获取所有服务器
  getAllServers(): Map<string, LSPServerInstance> {
    return new Map(this.servers)
  }
  
  // 获取诊断
  getDiagnostics(uri: string): Diagnostic[] {
    return this.diagnosticRegistry.getDiagnostics(uri)
  }
}
```

### LSP 客户端实现

```typescript
// src/services/lsp/LSPClient.ts

export class LSPClient {
  private connection: LSPConnection
  private capabilities: ServerCapabilities | null = null
  
  constructor(transport: LSPTransport) {
    this.connection = new LSPConnection(transport)
  }
  
  // 初始化
  async initialize(rootUri: string): Promise<InitializeResult> {
    const result = await this.connection.sendRequest('initialize', {
      processId: process.pid,
      clientInfo: {
        name: 'claude-code',
        version: getVersion(),
      },
      rootUri,
      capabilities: {
        textDocument: {
          synchronization: {
            dynamicRegistration: true,
            didSave: true,
          },
          publishDiagnostics: {
            relatedInformation: true,
          },
        },
      },
    })
    
    this.capabilities = result.capabilities
    
    // 发送 initialized 通知
    await this.connection.sendNotification('initialized', {})
    
    return result
  }
  
  // 打开文档
  async didOpenTextDocument(
    uri: string,
    text: string,
    languageId: string
  ): Promise<void> {
    await this.connection.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text,
      },
    })
  }
  
  // 悬停信息
  async hover(uri: string, position: Position): Promise<Hover | null> {
    return this.connection.sendRequest('textDocument/hover', {
      textDocument: { uri },
      position,
    })
  }
  
  // 定义位置
  async definition(uri: string, position: Position): Promise<Location[]> {
    return this.connection.sendRequest('textDocument/definition', {
      textDocument: { uri },
      position,
    })
  }
  
  // 完成
  async completion(
    uri: string,
    position: Position
  ): Promise<CompletionItem[]> {
    return this.connection.sendRequest('textDocument/completion', {
      textDocument: { uri },
      position,
    })
  }
}
```

---

## 上下文压缩服务深入

### 压缩点查找

```typescript
// src/services/compact/compact.ts

function findCompactionPoint(messages: Message[]): number {
  // 从后向前查找合适的压缩点
  // 压缩点应该在工具调用完成后
  
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    
    // 查找工具调用完成后的位置
    if (message.type === 'assistant') {
      const hasToolUse = message.message.content.some(
        block => block.type === 'tool_use'
      )
      
      if (hasToolUse) {
        // 找到工具调用，返回下一条消息的位置
        return i + 1
      }
    }
  }
  
  // 没有找到合适的点，返回中间位置
  return Math.floor(messages.length / 2)
}
```

### 摘要生成

```typescript
// src/services/compact/compact.ts

async function generateSummary(
  messages: Message[],
  options: {
    model: string
    systemPrompt: SystemPrompt
  }
): Promise<string> {
  // 构建压缩提示
  const prompt = buildCompactPrompt(messages)
  
  // 创建临时消息
  const compactMessages: Message[] = [
    createUserMessage({ content: prompt }),
  ]
  
  // 调用模型
  const stream = await sendRequest(
    {
      model: options.model,
      max_tokens: MAX_OUTPUT_TOKENS_FOR_SUMMARY,
      messages: compactMessages,
      system: asSystemPrompt('You are a conversation summarizer.'),
    },
    {}
  )
  
  let summary = ''
  
  for await (const event of stream) {
    if (event.type === 'content_block_delta') {
      summary += event.delta.text
    }
  }
  
  return summary
}

// 构建压缩提示
function buildCompactPrompt(messages: Message[]): string {
  const conversationText = messages
    .filter(m => m.type === 'user' || m.type === 'assistant')
    .map(m => {
      if (m.type === 'user') {
        return `User: ${extractTextContent(m)}`
      } else {
        return `Assistant: ${extractTextContent(m)}`
      }
    })
    .join('\n\n')
  
  return `Please summarize the following conversation concisely, capturing:
1. Key topics discussed
2. Important decisions made
3. Tasks completed or in progress
4. Relevant file paths or code references

Conversation:
${conversationText}

Summary:`
}
```

---

## 记忆服务深入

### 记忆提取提示

```typescript
// src/services/extractMemories/prompts.ts

export function buildExtractAutoOnlyPrompt(
  messages: Message[]
): string {
  const conversationText = formatConversation(messages)
  
  return `You are an automatic memory extraction assistant.

Your task is to identify durable memories from the conversation that should be saved for future reference.

Durable memories include:
- User preferences and working style
- Project structure and architecture decisions
- Important file locations and their purposes
- Recurring patterns or solutions
- Domain-specific knowledge shared by the user

Do NOT save:
- Temporary context (current task details)
- Information that changes frequently
- Trivial details

Format each memory as:
<memory type="preference|architecture|location|pattern|knowledge">
<description>Clear, concise description</description>
<context>When this is relevant</context>
</memory>

Conversation to analyze:
${conversationText}

Extract memories:`
}

export function buildExtractCombinedPrompt(
  messages: Message[],
  existingMemories: Memory[]
): string {
  const existingText = formatMemoryManifest(existingMemories)
  const conversationText = formatConversation(messages)
  
  return `You are an automatic memory extraction assistant.

You have existing memories that have been saved previously:
${existingText}

Your task is to:
1. Review the new conversation
2. Identify NEW durable memories not already captured
3. UPDATE existing memories if new information refines them
4. DELETE memories that are no longer accurate

Format:
<new_memory type="...">
<description>...</description>
<context>...</context>
</new_memory>

<update_memory id="...">
<new_description>...</new_description>
</update_memory>

<delete_memory id="..." reason="..."/>

Conversation:
${conversationText}

Extract memories:`
}
```

### 分叉代理执行

```typescript
// src/services/extractMemories/extractMemories.ts

async function runExtraction(
  messages: Message[],
  canUseTool: CanUseToolFn
): Promise<ExtractionResult> {
  const { enabled, autoMemPath } = await isAutoMemoryEnabled(cwd)
  if (!enabled) return { memoriesExtracted: 0 }
  
  // 扫描现有记忆
  const existingMemories = await scanMemoryFiles(autoMemPath)
  
  // 构建提示
  const prompt = existingMemories.length > 0
    ? buildExtractCombinedPrompt(messages, existingMemories)
    : buildExtractAutoOnlyPrompt(messages)
  
  // 创建分叉代理上下文
  const forkContext = createCacheSafeParams({
    parentContext: toolUseContext,
    agentType: 'memory-extractor',
  })
  
  // 运行分叉代理
  const result = await runForkedAgent({
    prompt,
    options: {
      agentType: 'memory-extractor',
      maxTurns: 5,
      cwd,
    },
    context: forkContext,
  })
  
  // 解析提取的记忆
  const memories = parseExtractedMemories(result.output)
  
  // 写入记忆文件
  for (const memory of memories) {
    await writeMemoryToFile(autoMemPath, memory)
  }
  
  return {
    memoriesExtracted: memories.length,
    memories,
  }
}
```

---

## 相关文件索引

| 服务 | 深入实现文件 |
|------|-------------|
| Analytics | `src/services/analytics/index.ts`, `growthbook.ts`, `datadog.ts` |
| API | `src/services/api/claude.ts`, `errors.ts`, `withRetry.ts` |
| MCP | `src/services/mcp/client.ts`, `auth.ts`, `MCPConnectionManager.tsx` |
| LSP | `src/services/lsp/LSPServerManager.ts`, `LSPClient.ts` |
| Compact | `src/services/compact/compact.ts`, `autoCompact.ts` |
| Extract Memories | `src/services/extractMemories/extractMemories.ts`, `prompts.ts` |

---

*文档生成时间：2026-04-01*
