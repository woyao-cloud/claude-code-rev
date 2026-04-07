# 服务层执行流程详解

## 概述

本文档详细描述 Yao Code 服务层的执行流程，包括各服务的初始化、调用链路和交互过程。

---

## 目录

1. [服务初始化流程](#服务初始化流程)
2. [API 服务执行流程](#api 服务执行流程)
3. [MCP 服务执行流程](#mcp 服务执行流程)
4. [压缩服务执行流程](#压缩服务执行流程)
5. [插件服务执行流程](#插件服务执行流程)
6. [完整调用时序图](#完整调用时序图)

---

## 服务初始化流程

### 启动初始化序列

```
src/entrypoints/init.ts
│
├─► 1. 配置系统启用
│   └─► getInitialSettings()
│       ├── 读取 ~/.claude/settings.json
│       ├── 读取项目级 .claude/settings.json
│       └── 合并设置
│
├─► 2. 环境变量应用
│   └─► applyConfigEnvironmentVariables()
│       ├── CLAUDE_* 环境变量
│       ├── ANTHROPIC_* 环境变量
│       └── 用户定义变量
│
├─► 3. 优雅关闭设置
│   └─► setupGracefulShutdown()
│
├─► 4. 遥测初始化
│   └─► initializeTelemetry()
│       ├── 创建 AnalyticsSink
│       ├── attachAnalyticsSink()
│       └── 处理队列事件
│
├─► 5. 策略限制加载
│   └─► loadPolicyLimits()
│       ├── isPolicyLimitsEligible()
│       ├── loadFromDiskCache()
│       ├── fetchPolicyLimitsFromApi()
│       └── startBackgroundPolling()
│
├─► 6. 远程设置加载
│   └─► loadRemoteManagedSettings()
│       ├── isRemoteManagedSettingsEligible()
│       ├── getRemoteManagedSettingsSyncFromCache()
│       ├── fetchFromApi()
│       └── startBackgroundPolling()
│
├─► 7. LSP 初始化
│   └─► initializeLspServerManager()
│       ├── createLSPServerManager()
│       ├── loadLspConfigs() (异步)
│       └── registerLSPNotificationHandlers()
│
├─► 8. MCP 初始化
│   └─► getMcpToolsCommandsAndResources()
│       ├── getAllMcpConfigs()
│       ├── createConnections()
│       ├── listTools()
│       └── listResources()
│
├─► 9. 插件初始化
│   └─► loadAllPluginsCacheOnly()
│       ├── 扫描插件目录
│       ├── 加载插件清单
│       └── 注册插件命令
│
└─► 10. 技能初始化
    └─► initBundledSkills()
        └── 注册内置技能
```

### 初始化代码示例

```typescript
// src/entrypoints/init.ts

export async function init(): Promise<void> {
  // 1. 配置系统
  const settings = getInitialSettings()
  
  // 2. 环境变量
  applyConfigEnvironmentVariables(settings)
  
  // 3. 优雅关闭
  setupGracefulShutdown()
  
  // 4. 遥测
  await initializeTelemetry()
  
  // 5. 策略限制（非阻塞）
  if (isPolicyLimitsEligible()) {
    void loadPolicyLimits().then(result => {
      if (result.status === 'fetched') {
        logForDebugging('Policy limits loaded')
      }
    })
  }
  
  // 6. 远程设置（非阻塞）
  if (isRemoteManagedSettingsEligible()) {
    void loadRemoteManagedSettings().then(result => {
      if (result.status === 'updated') {
        logForDebugging('Remote settings updated')
      }
    })
  }
  
  // 7. LSP（异步）
  initializeLspServerManager()
  
  // 8. MCP
  const mcpResult = await getMcpToolsCommandsAndResources()
  
  // 9. 插件
  await loadAllPluginsCacheOnly()
  
  // 10. 技能
  await initBundledSkills()
}
```

---

## API 服务执行流程

### 完整 API 请求流程

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          API 请求完整流程                                    │
└─────────────────────────────────────────────────────────────────────────────┘

query.ts:query()
│
├─► 1. 构建查询配置
│   └─► buildQueryConfig()
│       ├── 规范化消息
│       ├── 添加工具定义
│       ├── 构建系统提示
│       └── 添加 Beta 功能
│
├─► 2. 发送 API 请求
│   └─► sendRequest(params, options)
│       │
│       ├─► withRetry(async () => {
│       │   ├── 创建流式客户端
│       │   ├── client.beta.messages.stream(config)
│       │   └── 返回 Stream
│       │ }, { maxRetries: 3 })
│       │
│       └─► 错误处理
│           ├── APIConnectionTimeoutError → 重试
│           ├── APIConnectionError → 重试
│           ├── 429 RateLimit → 重试（带延迟）
│           └── 其他错误 → 抛出
│
├─► 3. 处理流式响应
│   └─► for await (const event of stream)
│       ├── message_start → 记录开始时间
│       ├── content_block_start → 处理内容块
│       ├── content_block_delta → 累积内容
│       ├── content_block_stop → 完成内容块
│       ├── message_delta → 记录使用量
│       └── message_stop → 完成消息
│
├─► 4. 记录指标
│   └─► logAPIMetrics()
│       ├── 输入/输出令牌
│       ├── 缓存命中/未命中
│       ├── 首次令牌时间
│       └── 总持续时间
│
└─► 5. 返回结果
    └─► { messages, usage, cost }
```

### API 请求代码示例

```typescript
// src/services/api/claude.ts

export async function sendRequest(
  params: BetaMessageStreamParams,
  options: RequestOptions
): Promise<Stream<BetaRawMessageStreamEvent>> {
  // 1. 构建配置
  const config = {
    model: params.model,
    max_tokens: params.max_tokens,
    messages: normalizeMessagesForAPI(params.messages),
    system: buildSystemPrompt(params.systemPrompt),
    tools: options.tools?.map(tool => toolToAPISchema(tool)),
    betas: getMergedBetas(options.betas),
    ...getAPIContextManagement(),
  }
  
  // 2. 应用重试逻辑
  return withRetry(async () => {
    // 3. 发送请求
    const stream = await client.beta.messages.stream(config)
    
    // 4. 记录请求
    captureAPIRequest(config)
    
    return stream
  }, {
    maxRetries: options.maxRetries || 3,
    shouldRetry: (error) => isRetryableError(error),
    getDelay: (attempt) => getRetryDelay(attempt),
  })
}

// 重试延迟计算
export function getRetryDelay(attempt: number): number {
  // 指数退避：1s, 2s, 4s, 8s, 16s
  const baseDelay = 1000
  const maxDelay = 30000
  
  const delay = baseDelay * Math.pow(2, attempt)
  const jitter = Math.random() * 0.1 * delay
  
  return Math.min(delay + jitter, maxDelay)
}
```

---

## MCP 服务执行流程

### MCP 工具调用流程

```
模型请求调用 MCP 工具 (mcp__server__tool)
│
├─► 1. 解析工具名
│   └─► parseMcpToolName(toolName)
│       ├── 提取服务器名：server
│       └── 提取工具名：tool
│
├─► 2. 查找连接
│   └─► findMcpConnection(serverName)
│       ├── 在 connections Map 中查找
│       └── 验证连接状态
│
├─► 3. 权限检查
│   └─► checkMcpToolPermissions(serverName, toolName)
│       ├── 检查服务器是否被禁用
│       ├── 检查工具是否在允许列表
│       └── 检查 Hook 规则
│
├─► 4. 调用工具
│   └─► connection.client.callTool({ name, arguments })
│       │
│       ├─► 发送 JSON-RPC 请求
│       │   {
│       │     "jsonrpc": "2.0",
│       │     "id": 1,
│       │     "method": "tools/call",
│       │     "params": { name, arguments }
│       │   }
│       │
│       └─► 等待响应
│           {
│             "jsonrpc": "2.0",
│             "id": 1,
│             "result": { content: [...] }
│           }
│
├─► 5. 处理响应
│   ├─► 成功
│   │   ├── 检查内容大小
│   │   ├── 持久化大内容
│   │   └── 返回结果
│   │
│   └─► 失败
│       ├── 401 → OAuth 刷新 → 重试
│       ├── 其他错误 → 抛出
│
└─► 6. 返回 ToolResult
    └─► { data, newMessages, mcpMeta }
```

### MCP 连接管理代码

```typescript
// src/services/mcp/client.ts

export async function getMcpToolsCommandsAndResources(): Promise<{
  tools: Tool[]
  commands: Command[]
  resources: ServerResource[]
}> {
  const configs = await getAllMcpConfigs()
  const connections: MCPServerConnection[] = []
  
  // 并行创建所有连接
  const connectionPromises = configs.map(async (config) => {
    if (isMcpServerDisabled(config.name)) {
      return null
    }
    
    try {
      // 创建客户端
      const client = new Client({
        name: 'claude-code',
        version: getVersion(),
      })
      
      // 创建传输层
      const transport = createTransport(config)
      
      // 连接服务器
      await client.connect(transport)
      
      // 获取工具和资源
      const [toolsResult, resourcesResult] = await Promise.all([
        client.listTools(),
        client.listResources(),
      ])
      
      // 创建连接对象
      const connection: MCPServerConnection = {
        client,
        config,
        tools: toolsResult.tools,
        resources: resourcesResult.resources,
        status: 'connected',
      }
      
      // 注册 URL 请求处理
      setupElicitationHandler(client)
      
      return connection
    } catch (error) {
      logMCPError(error, config.name)
      return {
        config,
        status: 'error',
        error,
      }
    }
  })
  
  // 等待所有连接
  const results = await Promise.all(connectionPromises)
  
  // 过滤和转换
  const validConnections = results.filter(Boolean)
  
  // 转换为工具
  const tools = validConnections.flatMap(conn => 
    conn.tools?.map(tool => createMcpTool(conn, tool)) || []
  )
  
  // 转换为命令（技能）
  const commands = validConnections.flatMap(conn =>
    createMcpSkillCommands(conn)
  )
  
  // 收集资源
  const resources = validConnections.flatMap(conn =>
    conn.resources?.map(res => ({ serverName: conn.config.name, ...res })) || []
  )
  
  return { tools, commands, resources }
}

// 创建传输层
function createTransport(config: McpSdkServerConfig): Transport {
  switch (config.type) {
    case 'stdio':
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...subprocessEnv, ...config.env },
      })
    
    case 'sse':
      return new SSEClientTransport(new URL(config.url))
    
    case 'streamable-http':
      return new StreamableHTTPClientTransport(new URL(config.url))
    
    default:
      throw new Error(`Unknown transport type: ${config.type}`)
  }
}
```

---

## 压缩服务执行流程

### 自动压缩触发流程

```
每轮查询完成后
│
├─► 1. 计算令牌使用
│   └─► tokenCountWithEstimation(messages)
│       ├── 遍历消息
│       ├── 估算每个内容块的令牌
│       └── 返回总计
│
├─► 2. 检查压缩条件
│   └─► shouldTriggerAutoCompact(tokenUsage, model)
│       ├── isAutoCompactEnabled()?
│       ├── tokenUsage >= autoCompactThreshold?
│       ├── consecutiveFailures < MAX?
│       └── 返回布尔值
│
├─► 3. 执行压缩
│   └─► compactConversation(messages, options)
│       │
│       ├─► findCompactionPoint(messages)
│       │   └── 找到合适的压缩点（工具调用后）
│       │
│       ├─► generateSummary(messagesToCompact)
│       │   ├── 创建压缩提示
│       │   ├── 调用模型生成摘要
│       │   └── 返回摘要文本
│       │
│       └─► buildCompactMessages(summary, remainingMessages)
│           └── 创建压缩边界消息
│
├─► 4. 压缩后清理
│   └─► runPostCompactCleanup()
│       ├── 清理文件缓存
│       ├── 更新状态
│       └── 记录事件
│
└─► 5. 继续查询
    └─► 使用压缩后的消息继续
```

### 压缩代码示例

```typescript
// src/services/compact/autoCompact.ts

export async function tryAutoCompact(
  messages: Message[],
  model: string,
  toolUseContext: ToolUseContext
): Promise<CompactionResult | null> {
  // 1. 计算令牌使用
  const tokenUsage = tokenCountWithEstimation(messages)
  
  // 2. 获取阈值
  const autoCompactThreshold = getAutoCompactThreshold(model)
  
  // 3. 检查是否需要压缩
  if (tokenUsage < autoCompactThreshold) {
    return null
  }
  
  // 4. 检查是否启用
  if (!isAutoCompactEnabled()) {
    return null
  }
  
  // 5. 执行压缩
  try {
    const result = await compactConversation(messages, {
      model,
      systemPrompt: toolUseContext.options.systemPrompt,
      toolUseContext,
    })
    
    // 6. 重置失败计数
    trackingState.consecutiveFailures = 0
    
    return result
  } catch (error) {
    // 7. 记录失败
    trackingState.consecutiveFailures++
    logError(error)
    
    // 8. 检查是否超过最大失败次数
    if (trackingState.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
      logError('Auto-compact disabled due to consecutive failures')
    }
    
    return null
  }
}

// 压缩对话
export async function compactConversation(
  messages: Message[],
  options: CompactOptions
): Promise<CompactionResult> {
  // 1. 找到压缩点
  const compactionPoint = findCompactionPoint(messages)
  
  // 2. 分离消息
  const messagesToCompact = messages.slice(0, compactionPoint)
  const messagesToKeep = messages.slice(compactionPoint)
  
  // 3. 生成摘要
  const summary = await generateSummary(messagesToCompact, {
    model: options.model,
    systemPrompt: options.systemPrompt,
  })
  
  // 4. 构建压缩边界
  const boundaryMessage = createSystemMessage({
    type: 'compact_boundary',
    message: `Previous conversation summarized: ${summary}`,
  })
  
  // 5. 构建新消息列表
  const compactedMessages = [boundaryMessage, ...messagesToKeep]
  
  // 6. 记录事件
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

## 插件服务执行流程

### 插件安装流程

```
用户执行：/plugin install plugin-name
│
├─► 1. 解析插件标识符
│   └─► parsePluginIdentifier(plugin)
│       ├── 名称：plugin-name
│       ├── 市场：marketplace (可选)
│       └── 版本：version (可选)
│
├─► 2. 获取市场配置
│   └─► getMarketplaceConfig(marketplace)
│       ├── 加载 knownMarketplaces.json
│       └── 返回市场 URL 和配置
│
├─► 3. 获取插件清单
│   └─► fetchPluginManifest(marketplaceConfig, name)
│       ├── GET {marketplaceUrl}/plugins/{name}
│       └── 解析 manifest.json
│
├─► 4. 下载插件
│   └─► downloadPlugin(marketplaceConfig, name, version)
│       ├── 下载插件包
│       ├── 验证校验和
│       └── 保存到临时目录
│
├─► 5. 安装插件
│   └─► installPluginToPath(pluginPath, installPath)
│       ├── 创建目标目录
│       ├── 复制文件
│       └── 安装依赖
│
├─► 6. 记录事件
│   └─► logEvent('tengu_plugin_installed', { ... })
│
└─► 7. 清除缓存
    └─► clearCommandsCache()
        └── 重新加载命令
```

### 插件安装代码

```typescript
// src/services/plugins/pluginOperations.ts

export async function installPluginOp(
  plugin: string,
  scope: InstallableScope = 'user'
): Promise<PluginOperationResult> {
  try {
    // 1. 解析标识符
    const { name, marketplace, version } = parsePluginIdentifier(plugin)
    
    // 2. 获取市场配置
    const marketplaceConfig = await getMarketplaceConfig(marketplace)
    
    // 3. 获取清单
    const manifest = await fetchPluginManifest(marketplaceConfig, name)
    const targetVersion = version || manifest.version
    
    // 4. 下载插件
    const downloadPath = await downloadPlugin(
      marketplaceConfig,
      name,
      targetVersion
    )
    
    // 5. 验证
    const isValid = await verifyPluginChecksum(downloadPath, manifest.checksum)
    if (!isValid) {
      throw new Error('Checksum verification failed')
    }
    
    // 6. 安装
    const installPath = getInstallPath(scope, name)
    await fs.mkdir(installPath, { recursive: true })
    await fs.cp(downloadPath, installPath, { recursive: true })
    
    // 7. 保存元数据
    await savePluginMetadata(installPath, {
      name,
      version: targetVersion,
      marketplace,
      installedAt: Date.now(),
      scope,
    })
    
    // 8. 记录事件
    logEvent('tengu_plugin_installed', {
      _PROTO_plugin_name: name,
      _PROTO_marketplace_name: marketplace,
      scope,
      install_source: 'cli-explicit',
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
      message: `Failed to install: ${errorMessage(error)}`,
      error,
    }
  }
}
```

---

## 完整调用时序图

### 从启动到第一次查询的完整流程

```
┌─────┐  ┌──────┐  ┌─────────┐  ┌───────┐  ┌─────┐  ┌─────┐  ┌─────┐
│用户 │  │main  │  │ init    │  │Analytics│  │Policy│  │MCP  │  │API  │
└──┬──┘  └──┬───┘  └────┬────┘  └───┬───┘  └──┬──┘  └──┬──┘  └──┬──┘
   │       │           │           │          │        │        │
   │ 启动  │           │           │          │        │        │
   │──────>│           │           │          │        │        │
   │       │           │           │          │        │        │
   │       │ 调用 init │           │          │        │        │
   │       │──────────>│           │          │        │        │
   │       │           │           │          │        │        │
   │       │           │attachSink │          │        │        │
   │       │           │──────────>│          │        │        │
   │       │           │           │          │        │        │
   │       │           │           │ 队列事件 │        │        │
   │       │           │<──────────│          │        │        │
   │       │           │           │          │        │        │
   │       │           │loadPolicy │          │        │        │
   │       │           │──────────>│          │        │        │
   │       │           │           │          │        │        │
   │       │           │ eligibility        │        │        │
   │       │           │───────────────────> │        │        │
   │       │           │           │          │        │        │
   │       │           │ API fetch │          │        │        │
   │       │           │───────────────────> │        │        │
   │       │           │           │          │        │        │
   │       │           │<─────────────────── │        │        │
   │       │           │           │          │        │        │
   │       │           │<──────────│          │        │        │
   │       │           │           │          │        │        │
   │       │           │                    getMcp   │        │
   │       │           │                    │────────>│        │
   │       │           │                    │        │        │
   │       │           │                    │ 连接服务器  │    │
   │       │           │                    │────────>│        │
   │       │           │                    │        │        │
   │       │           │                    │<─────── │        │
   │       │           │                    │        │        │
   │       │           │<───────────────────│        │        │
   │       │           │           │          │        │        │
   │       │ 初始化完成 │           │          │        │        │
   │       │<──────────│           │          │        │        │
   │       │           │           │          │        │        │
   │       │           │           │          │        │        │
   │ 输入消息 │           │          │        │        │
   │────────>│           │           │          │        │        │
   │       │           │           │          │        │        │
   │       │ query()   │           │          │        │        │
   │       │──────────>│           │          │        │        │
   │       │           │           │          │        │        │
   │       │           │ buildConfig        │        │        │
   │       │           │───────────────────────────────────────>│
   │       │           │           │          │        │        │
   │       │           │ API 请求  │          │        │        │
   │       │           │───────────────────────────────────────>│
   │       │           │           │          │        │        │
   │       │           │           │          │        │        │
   │       │           │ 流式响应 │          │        │        │
   │       │           │<───────────────────────────────────────│
   │       │           │           │          │        │        │
   │       │           │ 检测 tool_use       │        │        │
   │       │           │───────────────────> │        │        │
   │       │           │           │          │        │        │
   │       │           │           │ MCP 调用 │        │        │
   │       │           │           │────────>│        │        │
   │       │           │           │          │        │        │
   │       │           │           │ JSON-RPC │        │        │
   │       │           │           │────────>│        │        │
   │       │           │           │          │        │        │
   │       │           │           │<─────── │        │        │
   │       │           │           │          │        │        │
   │       │           │<─────────────────── │        │        │
   │       │           │           │          │        │        │
   │       │<──────────│           │          │        │        │
   │       │           │           │          │        │        │
   │ 显示结果 │           │          │        │        │
   │<───────│           │           │          │        │        │
   │       │           │           │          │        │        │
```

---

## 相关文件索引

| 流程 | 相关文件 |
|------|----------|
| 服务初始化 | `src/entrypoints/init.ts`, `src/main.tsx` |
| API 请求 | `src/services/api/claude.ts`, `src/services/api/withRetry.ts` |
| MCP 调用 | `src/services/mcp/client.ts`, `src/services/mcp/MCPConnectionManager.tsx` |
| 压缩 | `src/services/compact/autoCompact.ts`, `src/services/compact/compact.ts` |
| 插件 | `src/services/plugins/pluginOperations.ts`, `src/services/plugins/pluginLoader.ts` |
| 策略限制 | `src/services/policyLimits/index.ts` |
| 远程设置 | `src/services/remoteManagedSettings/index.ts` |

---

*文档生成时间：2026-04-01*
