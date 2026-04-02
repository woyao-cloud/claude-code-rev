# CLI 传输层架构总览

## 概述

本文档详细描述 Claude Code CLI 传输层（CLI Transport Layer）的架构设计、模块组成和执行流程。传输层负责处理所有与外部 API 的通信，包括 Anthropic API、AWS Bedrock、GCP Vertex AI 和 Azure Foundry。

**版本**: 999.0.0-restored  
**最后更新**: 2026-04-01

---

## 目录

1. [传输层概览](#传输层概览)
2. [核心模块](#核心模块)
3. [API 提供商架构](#api 提供商架构)
4. [数据传输流程](#数据传输流程)
5. [错误处理策略](#错误处理策略)
6. [流程图和时序图](#流程图和时序图)

---

## 传输层概览

### 目录结构

```
src/services/api/
├── client.ts                    # API 客户端创建（多提供商支持）
├── claude.ts                    # 消息发送核心逻辑
├── withRetry.ts                 # 重试逻辑实现
├── bootstrap.ts                 # Bootstrap 数据获取
├── filesApi.ts                  # 文件上传/下载/列表 API
├── sessionIngress.ts            # 会话日志持久化
├── errors.ts                    # API 错误定义
├── errorUtils.ts                # 错误处理工具
├── logging.ts                   # API 日志记录
├── usage.ts                     # 使用量跟踪
└── ...
```

### 层级定位

```
┌─────────────────────────────────────────────────────────────────┐
│                        应用层 (Application)                      │
│  main.tsx, REPL.tsx, QueryEngine.ts                             │
├─────────────────────────────────────────────────────────────────┤
│                        业务逻辑层 (Business Logic)               │
│  query.ts, tools/, commands/                                     │
├─────────────────────────────────────────────────────────────────┤
│                        服务层 (Services) ← 传输层位于此处         │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                  传输层 (Transmission)                     │  │
│  │  - API 客户端（多提供商）                                   │  │
│  │  - 消息传输（流式请求/响应）                                │  │
│  │  - 重试逻辑（错误处理、退避）                               │  │
│  │  - Files API（文件上传/下载）                               │  │
│  │  - Session Ingress（会话持久化）                            │  │
│  └───────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│                        工具函数层 (Utils)                        │
│  auth.ts, config.ts, permissions/, model/                        │
├─────────────────────────────────────────────────────────────────┤
│                        基础设施 (Infrastructure)                 │
│  Node.js/Bun Runtime, OS API, HTTP                               │
└─────────────────────────────────────────────────────────────────┘
```

### 核心职责

| 职责 | 描述 |
|------|------|
| **多提供商支持** | 支持直连 Anthropic、AWS Bedrock、GCP Vertex、Azure Foundry |
| **流式传输** | 处理 SSE 流式请求和响应，实时 token 输出 |
| **重试和容错** | 指数退避、错误分类、快速模式降级 |
| **认证管理** | API Key、OAuth、AWS 凭证、GCP 凭证 |
| **文件传输** | 大文件上传/下载、并行处理、断点续传 |
| **会话持久化** | 日志持久化、乐观并发控制 |

### 设计特点

| 特点 | 描述 |
|------|------|
| **提供商抽象** | 统一的 API 接口，底层提供商可切换 |
| **流式优先** | 基于 SSE 的流式传输，低延迟响应 |
| **失败开放** | 非关键错误不影响核心功能 |
| **智能重试** | 根据错误类型动态调整重试策略 |
| **缓存保护** | 快速模式降级时保护 prompt 缓存 |

---

## 核心模块

### 1. API 客户端模块

**文件**: `src/services/api/client.ts`

**职责**:
- 创建 Anthropic SDK 客户端实例
- 支持多种 API 提供商（直连/Bedrock/Vertex/Foundry）
- 处理认证和请求头
- 配置重试和超时参数

**客户端类型**:

| 类型 | 环境变量 | SDK | 认证方式 |
|------|----------|-----|----------|
| **直连** | - | `@anthropic-ai/sdk` | API Key / OAuth |
| **Bedrock** | `CLAUDE_CODE_USE_BEDROCK` | `@anthropic-ai/bedrock-sdk` | AWS 凭证 |
| **Vertex** | `CLAUDE_CODE_USE_VERTEX` | `@anthropic-ai/vertex-sdk` | GCP 凭证 |
| **Foundry** | `CLAUDE_CODE_USE_FOUNDRY` | `@anthropic-ai/foundry-sdk` | Azure AD / API Key |

**客户端创建流程**:

```typescript
// src/services/api/client.ts

export async function getAnthropicClient({
  apiKey,
  maxRetries,
  model,
  fetchOverride,
  source,
}: {
  apiKey?: string
  maxRetries: number
  model?: string
  fetchOverride?: ClientOptions['fetch']
  source?: string
}): Promise<Anthropic> {
  // 1. 准备默认请求头
  const defaultHeaders = {
    'x-app': 'cli',
    'User-Agent': getUserAgent(),
    'X-Claude-Code-Session-Id': getSessionId(),
    // ...
  }
  
  // 2. OAuth 令牌检查和刷新
  await checkAndRefreshOAuthTokenIfNeeded()
  
  // 3. 根据环境变量选择提供商
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) {
    const { AnthropicBedrock } = await import('@anthropic-ai/bedrock-sdk')
    return new AnthropicBedrock({
      awsRegion: getAWSRegion(),
      // ...
    })
  }
  
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) {
    const { AnthropicVertex } = await import('@anthropic-ai/vertex-sdk')
    return new AnthropicVertex({
      region: getVertexRegionForModel(model),
      googleAuth,
      // ...
    })
  }
  
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)) {
    const { AnthropicFoundry } = await import('@anthropic-ai/foundry-sdk')
    return new AnthropicFoundry({
      azureADTokenProvider,
      // ...
    })
  }
  
  // 4. 默认直连 Anthropic API
  return new Anthropic({
    apiKey: apiKey || getAnthropicApiKey(),
    defaultHeaders,
    maxRetries,
    // ...
  })
}
```

---

### 2. 消息传输模块

**文件**: `src/services/api/claude.ts`

**职责**:
- 发送流式消息请求到 API
- 处理响应事件流
- 工具调用路由
- 使用量跟踪

**流式响应事件**:

| 事件类型 | 描述 |
|----------|------|
| `message_start` | 消息流开始 |
| `content_block_start` | 内容块开始 |
| `content_block_delta` | 内容增量（文本/工具调用） |
| `content_block_stop` | 内容块结束 |
| `message_delta` | 消息增量（使用量统计） |
| `message_stop` | 消息流结束 |

**消息发送流程**:

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
  // 1. 构建请求配置
  const config = await buildRequestConfig(params, options)
  
  // 2. 应用重试逻辑
  return withRetry(async () => {
    // 3. 发送流式请求
    const stream = await client.beta.messages.stream(config)
    
    // 4. 记录 API 指标
    logAPIMetrics(config)
    
    return stream
  }, {
    maxRetries: options.maxRetries || 3,
    onRetry: (attempt, error) => logRetry(attempt, error),
  })
}
```

---

### 3. 重试逻辑模块

**文件**: `src/services/api/withRetry.ts`

**职责**:
- 实现指数退避重试算法
- 错误分类和重试决策
- 快速模式降级处理
- 持久重试模式（无人值守场景）

**错误分类**:

| 错误类型 | 状态码 | 是否重试 | 备注 |
|----------|--------|----------|------|
| **529 Overloaded** | 529 | ✅ | 容量不足，特殊处理 |
| **Rate Limit** | 429 | ✅ | 带延迟重试 |
| **Connection Timeout** | - | ✅ | 网络超时 |
| **Connection Reset** | - | ✅ | ECONNRESET/EPIPE |
| **Unauthorized** | 401 | ✅ | 刷新令牌后重试 |
| **Token Revoked** | 403 | ✅ | OAuth 令牌被撤销 |
| **Server Error** | 5xx | ✅ | 服务端错误 |
| **Client Error** | 4xx (除 401/403) | ❌ | 客户端错误，不重试 |

**重试延迟计算**:

```typescript
// src/services/api/withRetry.ts

export function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
  maxDelayMs = 32000,
): number {
  // 1. 优先使用 Retry-After 头
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10)
    if (!isNaN(seconds)) {
      return seconds * 1000
    }
  }
  
  // 2. 指数退避：500ms, 1s, 2s, 4s, 8s, 16s, 32s
  const baseDelay = Math.min(
    BASE_DELAY_MS * Math.pow(2, attempt - 1),
    maxDelayMs,
  )
  
  // 3. 添加 25% 抖动
  const jitter = Math.random() * 0.25 * baseDelay
  
  return baseDelay + jitter
}
```

**快速模式降级**:

```typescript
// 快速模式降级逻辑
if (wasFastModeActive && !isPersistentRetryEnabled()) {
  const retryAfterMs = getRetryAfterMs(error)
  
  if (retryAfterMs !== null && retryAfterMs < SHORT_RETRY_THRESHOLD_MS) {
    // 短延迟：等待并重试，保持快速模式激活（保护 prompt 缓存）
    await sleep(retryAfterMs, options.signal, { abortError })
    continue
  }
  
  // 长延迟：进入冷却模式，切换到标准速度模型
  const cooldownMs = Math.max(
    retryAfterMs ?? DEFAULT_FAST_MODE_FALLBACK_HOLD_MS,
    MIN_COOLDOWN_MS,
  )
  triggerFastModeCooldown(Date.now() + cooldownMs, cooldownReason)
  retryContext.fastMode = false
  continue
}
```

---

### 4. Files API 模块

**文件**: `src/services/api/filesApi.ts`

**职责**:
- 文件下载（单文件/批量/并行）
- 文件上传（BYOC 模式）
- 文件列表（分页）
- 大小验证和错误处理

**下载流程**:

```typescript
// src/services/api/filesApi.ts

export async function downloadFile(
  fileId: string,
  config: FilesApiConfig,
): Promise<Buffer> {
  const url = `${baseUrl}/v1/files/${fileId}/content`
  
  return retryWithBackoff(`Download file ${fileId}`, async () => {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${config.oauthToken}`,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      responseType: 'arraybuffer',
    })
    
    if (response.status === 200) {
      return { done: true, value: Buffer.from(response.data) }
    }
    
    // 错误处理
    if (response.status === 404) {
      throw new Error(`File not found: ${fileId}`)
    }
    
    return { done: false, error: `status ${response.status}` }
  })
}
```

**并行下载**:

```typescript
// 并行处理，限制并发数
export async function downloadSessionFiles(
  files: File[],
  config: FilesApiConfig,
  concurrency: number = DEFAULT_CONCURRENCY,
): Promise<DownloadResult[]> {
  return parallelWithLimit(
    files,
    file => downloadAndSaveFile(file, config),
    concurrency,
  )
}

// 工作者模式并发控制
async function worker(): Promise<void> {
  while (currentIndex < items.length) {
    const index = currentIndex++
    results[index] = await fn(items[index], index)
  }
}
```

---

### 5. Session Ingress 模块

**文件**: `src/services/api/sessionIngress.ts`

**职责**:
- 会话日志持久化到远程存储
- 乐观并发控制（Last-Uuid 头）
- 409 冲突解决
- JWT/OAuth 认证

**持久化流程**:

```typescript
// src/services/api/sessionIngress.ts

async function appendSessionLogImpl(
  sessionId: string,
  entry: TranscriptMessage,
  url: string,
  headers: Record<string, string>,
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const lastUuid = lastUuidMap.get(sessionId)
    const requestHeaders = { ...headers }
    
    // 乐观并发控制：添加 Last-Uuid 头
    if (lastUuid) {
      requestHeaders['Last-Uuid'] = lastUuid
    }
    
    const response = await axios.put(url, entry, {
      headers: requestHeaders,
      validateStatus: status => status < 500,
    })
    
    if (response.status === 200 || response.status === 201) {
      // 成功：更新本地缓存的 UUID
      lastUuidMap.set(sessionId, entry.uuid)
      return true
    }
    
    if (response.status === 409) {
      // 冲突：采用服务器的 UUID 并重试
      const serverLastUuid = response.headers['x-last-uuid']
      if (serverLastUuid) {
        lastUuidMap.set(sessionId, serverLastUuid)
        continue // 重试
      }
    }
    
    if (response.status === 401) {
      // 认证失败：不重试
      return false
    }
    
    // 其他错误：等待后重试
    await sleep(delayMs)
  }
  
  return false
}
```

---

## API 提供商架构

### 提供商选择决策树

```
                     ┌─────────────────┐
                     │  检查环境变量   │
                     └────────┬────────┘
                              │
         ┌────────────────────┼────────────────────┐
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ CLAUDE_CODE_    │  │ CLAUDE_CODE_    │  │ CLAUDE_CODE_    │
│ USE_BEDROCK=1   │  │ USE_VERTEX=1    │  │ USE_FOUNDRY=1   │
└────────┬────────┘  └────────┬────────┘  └────────┬────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ AnthropicBedrock│  │ AnthropicVertex │  │ AnthropicFoundry│
│ awsRegion       │  │ region          │  │ azureADToken    │
│ AWS 凭证         │  │ GCP 凭证         │  │ Azure AD / Key  │
└─────────────────┘  └─────────────────┘  └─────────────────┘
                              │
                              ▼
                     ┌─────────────────┐
                     │   默认：直连     │
                     │   Anthropic API  │
                     │   API Key/OAuth  │
                     └─────────────────┘
```

### 提供商对比

| 特性 | 直连 | Bedrock | Vertex | Foundry |
|------|------|---------|--------|---------|
| **SDK** | `@anthropic-ai/sdk` | `bedrock-sdk` | `vertex-sdk` | `foundry-sdk` |
| **认证** | API Key / OAuth | AWS 凭证 | GCP 凭证 | Azure AD / Key |
| **区域** | - | AWS Region | GCP Region | Azure Region |
| **网络** | 公网 | VPC | VPC | VPC |
| **计费** | Anthropic | AWS | GCP | Azure |

---

## 数据传输流程

### 完整数据流

```
用户输入
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│  1. 业务逻辑层 (query.ts)                                        │
│     - 构建查询配置                                                │
│     - 添加工具定义                                                │
│     - 准备系统提示                                                │
└─────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. 传输层 - 消息传输 (claude.ts)                                │
│     - buildRequestConfig()                                      │
│     - 规范化消息                                                │
│     - 添加工具 Schema                                            │
└─────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. 传输层 - 重试逻辑 (withRetry.ts)                             │
│     - withRetry() 包装器                                        │
│     - 错误分类和重试决策                                         │
│     - 指数退避延迟                                              │
└─────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│  4. 传输层 - API 客户端 (client.ts)                               │
│     - getAnthropicClient()                                      │
│     - 选择提供商（直连/Bedrock/Vertex/Foundry）                  │
│     - 添加认证头                                                │
└─────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│  5. 基础设施层                                                   │
│     - HTTP 请求                                                   │
│     - SSE 流式传输                                                │
└─────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│  6. API 响应处理                                                  │
│     - message_start                                             │
│     - content_block_delta (流式输出)                             │
│     - message_delta (使用量统计)                                 │
│     - message_stop                                              │
└─────────────────────────────────────────────────────────────────┘
    │
    ▼
业务逻辑层处理响应
```

---

## 错误处理策略

### 错误分类层次

```
Error
├── APIError (SDK 基础错误)
│   ├── APIConnectionError (连接错误)
│   │   ├── 网络超时
│   │   ├── ECONNRESET
│   │   └── EPIPE
│   ├── APIUserAbortError (用户取消)
│   └── APIStatusError (状态码错误)
│       ├── 529 Overloaded
│       ├── 429 Rate Limit
│       ├── 401 Unauthorized
│       ├── 403 Forbidden
│       └── 5xx Server Error
├── CannotRetryError (无法重试)
├── FallbackTriggeredError (降级触发)
└── UploadNonRetriableError (上传不可重试)
```

### 重试决策矩阵

| 错误 | 状态码 | 直连 | Bedrock | Vertex | Foundry |
|------|--------|------|---------|--------|---------|
| Overloaded | 529 | ✅ | ✅ | ✅ | ✅ |
| Rate Limit | 429 | ✅* | ✅ | ✅ | ✅ |
| Unauthorized | 401 | ✅ | ✅ | ✅ | ✅ |
| Token Revoked | 403 | ✅ | ✅ | ✅ | ✅ |
| Connection Reset | - | ✅ | ✅ | ✅ | ✅ |
| Timeout | 408 | ✅ | ✅ | ✅ | ✅ |
| Server Error | 5xx | ✅ | ✅ | ✅ | ✅ |
| Client Error | 4xx | ❌ | ❌ | ❌ | ❌ |

*ClaudeAI 订阅用户不重试 429，企业用户重试

---

## 流程图和时序图

### API 客户端创建流程

```
┌─────────────────────────────────────────────────────────────────┐
│                    API 客户端创建流程                             │
└─────────────────────────────────────────────────────────────────┘

getAnthropicClient()
│
├─► 1. 准备默认请求头
│   └─► User-Agent, Session-ID, 自定义头
│
├─► 2. OAuth 令牌检查和刷新
│   └─► checkAndRefreshOAuthTokenIfNeeded()
│
├─► 3. 检查提供商环境变量
│   │
│   ├─► CLAUDE_CODE_USE_BEDROCK=1 ?
│   │   │
│   │   ├─► 是 → 导入 @anthropic-ai/bedrock-sdk
│   │   │        │
│   │   │        ├─► 获取 AWS 区域
│   │   │        ├─► 获取 AWS 凭证 (可跳过)
│   │   │        └─► 返回 AnthropicBedrock 实例
│   │   │
│   ├─► CLAUDE_CODE_USE_VERTEX=1 ?
│   │   │
│   │   ├─► 是 → 导入 @anthropic-ai/vertex-sdk
│   │   │        │
│   │   │        ├─► 获取 GCP 区域
│   │   │        ├─► 创建 GoogleAuth
│   │   │        └─► 返回 AnthropicVertex 实例
│   │   │
│   ├─► CLAUDE_CODE_USE_FOUNDRY=1 ?
│   │   │
│   │   ├─► 是 → 导入 @anthropic-ai/foundry-sdk
│   │   │        │
│   │   │        ├─► 检查 API Key
│   │   │        ├─► 创建 Azure AD Token Provider
│   │   │        └─► 返回 AnthropicFoundry 实例
│   │   │
│   └─► 默认
│       │
│       ├─► 获取 API Key 或 OAuth Token
│       └─► 返回 Anthropic 实例
│
└─► 4. 配置客户端参数
    ├─► maxRetries
    ├─► timeout
    ├─► defaultHeaders
    └─► fetchOptions
```

---

### 消息发送时序图

```
┌──────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌──────────┐
│用户  │  │query.ts   │  │claude.ts  │  │withRetry  │  │API       │
└──┬───┘  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘  └────┬─────┘
   │            │              │              │              │
   │ 发送查询   │              │              │              │
   │───────────>│              │              │              │
   │            │              │              │              │
   │            │ 构建配置     │              │              │
   │            │─────────────>│              │              │
   │            │              │              │              │
   │            │              │ withRetry()  │              │
   │            │              │─────────────>│              │
   │            │              │              │              │
   │            │              │              │ 发送请求     │
   │            │              │              │─────────────>│
   │            │              │              │              │
   │            │              │              │ message_start│
   │            │              │              │<─────────────│
   │            │              │              │              │
   │            │              │              │ content_delta│
   │            │              │              │<─────────────│
   │            │              │              │              │
   │            │              │              │ content_delta│
   │            │              │              │<─────────────│
   │            │              │              │              │
   │            │              │              │ message_delta│
   │            │              │              │<─────────────│
   │            │              │              │              │
   │            │              │              │ message_stop │
   │            │              │              │<─────────────│
   │            │              │              │              │
   │            │              │<─────────────│              │
   │            │<─────────────│              │              │
   │            │              │              │              │
   │ 流式输出   │              │              │              │
   │<───────────│              │              │              │
```

---

*文档生成时间：2026-04-01*
