# 重试逻辑详解

## 概述

本文档详细介绍 CLI 传输层的重试逻辑，包括错误分类、指数退避算法、快速模式降级策略和持久重试模式。

---

## 目录

1. [错误分类](#错误分类)
2. [重试决策机制](#重试决策机制)
3. [指数退避算法](#指数退避算法)
4. [快速模式降级](#快速模式降级)
5. [持久重试模式](#持久重试模式)
6. [529 错误处理](#529 错误处理)

---

## 错误分类

### 错误类型层次

```
Error
├── APIError (SDK 基础错误)
│   ├── APIConnectionError (连接错误)
│   │   ├── 网络超时
│   │   ├── ECONNRESET (连接重置)
│   │   └── EPIPE (管道破裂)
│   ├── APIConnectionTimeoutError (连接超时)
│   ├── APIUserAbortError (用户取消)
│   └── APIStatusError (状态码错误)
│       ├── 529 Overloaded (容量不足)
│       ├── 429 Rate Limit (频率限制)
│       ├── 401 Unauthorized (未授权)
│       ├── 403 Forbidden (禁止)
│       │   └── OAuth token revoked
│       ├── 408 Request Timeout (请求超时)
│       ├── 409 Conflict (冲突)
│       └── 5xx Server Error (服务器错误)
├── CannotRetryError (无法重试)
├── FallbackTriggeredError (降级触发)
└── UploadNonRetriableError (上传不可重试)
```

### 错误重试性分类

| 错误类型 | 状态码 | 是否重试 | 备注 |
|----------|--------|----------|------|
| **529 Overloaded** | 529 | ✅ | 容量不足，特殊处理 |
| **Rate Limit** | 429 | ✅* | 带延迟重试，*订阅用户除外 |
| **Connection Timeout** | - | ✅ | 网络超时 |
| **Connection Reset** | - | ✅ | ECONNRESET/EPIPE |
| **Request Timeout** | 408 | ✅ | 请求超时 |
| **Conflict** | 409 | ✅ | 并发冲突 |
| **Unauthorized** | 401 | ✅ | 刷新令牌后重试 |
| **Token Revoked** | 403 | ✅ | OAuth 令牌被撤销 |
| **Server Error** | 5xx | ✅ | 服务端错误 |
| **Client Error** | 4xx (其他) | ❌ | 客户端错误，不重试 |
| **Mock Rate Limit** | - | ❌ | 测试用错误，不重试 |

### 错误检测代码

```typescript
// src/services/api/withRetry.ts

// 检测 529 错误
export function is529Error(error: unknown): boolean {
  if (!(error instanceof APIError)) {
    return false
  }
  return (
    error.status === 529 ||
    // SDK 在流式传输时可能不传递 529 状态码
    (error.message?.includes('"type":"overloaded_error"') ?? false)
  )
}

// 检测瞬态容量错误
function isTransientCapacityError(error: unknown): boolean {
  return (
    is529Error(error) || 
    (error instanceof APIError && error.status === 429)
  )
}

// 检测陈旧连接错误
function isStaleConnectionError(error: unknown): boolean {
  if (!(error instanceof APIConnectionError)) {
    return false
  }
  const details = extractConnectionErrorDetails(error)
  return details?.code === 'ECONNRESET' || details?.code === 'EPIPE'
}

// 检测 OAuth 令牌被撤销
function isOAuthTokenRevokedError(error: unknown): boolean {
  return (
    error instanceof APIError &&
    error.status === 403 &&
    (error.message?.includes('OAuth token has been revoked') ?? false)
  )
}

// 检测 Bedrock 认证错误
function isBedrockAuthError(error: unknown): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) {
    if (
      isAwsCredentialsProviderError(error) ||
      (error instanceof APIError && error.status === 403)
    ) {
      return true
    }
  }
  return false
}

// 检测 Vertex 认证错误
function isVertexAuthError(error: unknown): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) {
    // google-auth-library 凭证错误
    if (isGoogleAuthLibraryCredentialError(error)) {
      return true
    }
    // 服务器 401
    if (error instanceof APIError && error.status === 401) {
      return true
    }
  }
  return false
}
```

---

## 重试决策机制

### 重试决策流程

```
┌─────────────────────────────────────────────────────────────────┐
│                    重试决策流程                                   │
└─────────────────────────────────────────────────────────────────┘

发生错误
│
├─► 1. 检查是否可重试错误类型
│   │
│   ├─► isMockRateLimitError() ? → ❌ 不重试 (测试错误)
│   │
│   ├─► isFastModeNotEnabledError() ? → ✅ 禁用快速模式，重试
│   │
│   ├─► is529Error() && !shouldRetry529(querySource) ? 
│   │   → ❌ 后台任务丢弃 (不重试)
│   │
│   └─► shouldRetry(error) ? → 继续检查
│
├─► 2. 检查重试次数
│   │
│   ├─► attempt > maxRetries && !persistent ? 
│   │   → ❌ 抛出 CannotRetryError
│   │
│   └─► 继续
│
├─► 3. 特殊错误处理
│   │
│   ├─► 529 连续错误 >= MAX_529_RETRIES ?
│   │   │
│   │   ├─► 有 fallbackModel ? → ✅ 触发降级
│   │   ├─► 外部用户 + 非沙箱 + 非持久 ? → ❌ 抛出自定义错误
│   │   └─► 否则 → 继续重试
│   │
│   ├─► 401 Unauthorized ?
│   │   │
│   │   ├─► 清除 API Key 缓存
│   │   └─► ✅ 重试
│   │
│   ├─► OAuth token revoked ?
│   │   │
│   │   ├─► handleOAuth401Error()
│   │   └─► ✅ 重试
│   │
│   ├─► Bedrock/Vertex 认证错误 ?
│   │   │
│   │   ├─► 清除凭证缓存
│   │   └─► ✅ 重试
│   │
│   └─► max_tokens 上下文溢出 ?
│       │
│       ├─► 调整 maxTokensOverride
│       └─► ✅ 重试
│
├─► 4. 计算重试延迟
│   └─► getRetryDelay(attempt, retryAfterHeader, maxDelayMs)
│
├─► 5. 持久重试模式检查
│   │
│   ├─► persistent && delayMs > 60000 ?
│   │   │
│   │   └─► 分块等待 (心跳保持)
│   │       └─► 每 30 秒 yield 系统消息
│   │
│   └─► 等待延迟
│
└─► 6. 下一次重试
```

### shouldRetry() 实现

```typescript
// src/services/api/withRetry.ts

function shouldRetry(error: APIError): boolean {
  // 不重试 mock 错误
  if (isMockRateLimitError(error)) {
    return false
  }
  
  // 持久模式：429/529 总是可重试
  if (isPersistentRetryEnabled() && isTransientCapacityError(error)) {
    return true
  }
  
  // CCR 模式：401/403 可重试 (JWT 瞬态错误)
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) &&
    (error.status === 401 || error.status === 403)
  ) {
    return true
  }
  
  // 检测 overloaded 错误 (即使状态码不是 529)
  if (error.message?.includes('"type":"overloaded_error"')) {
    return true
  }
  
  // max_tokens 上下文溢出可重试
  if (parseMaxTokensContextOverflowError(error)) {
    return true
  }
  
  // 检查服务器 x-should-retry 头
  const shouldRetryHeader = error.headers?.get('x-should-retry')
  
  if (
    shouldRetryHeader === 'true' &&
    (!isClaudeAISubscriber() || isEnterpriseSubscriber())
  ) {
    return true
  }
  
  // x-should-retry: false 时，只有 5xx 错误且是 Ant 用户才重试
  if (shouldRetryHeader === 'false') {
    const is5xxError = error.status !== undefined && error.status >= 500
    if (!(process.env.USER_TYPE === 'ant' && is5xxError)) {
      return false
    }
  }
  
  // 连接错误总是重试
  if (error instanceof APIConnectionError) {
    return true
  }
  
  if (!error.status) return false
  
  // 408 请求超时
  if (error.status === 408) return true
  
  // 409 锁定超时
  if (error.status === 409) return true
  
  // 429 频率限制 (订阅用户不重试，企业用户重试)
  if (error.status === 429) {
    return !isClaudeAISubscriber() || isEnterpriseSubscriber()
  }
  
  // 401 未授权 (清除缓存后重试)
  if (error.status === 401) {
    clearApiKeyHelperCache()
    return true
  }
  
  // 403 OAuth 令牌被撤销
  if (isOAuthTokenRevokedError(error)) {
    return true
  }
  
  // 5xx 服务器错误
  if (error.status && error.status >= 500) return true
  
  return false
}
```

---

## 指数退避算法

### 延迟计算

```typescript
// src/services/api/withRetry.ts

export const BASE_DELAY_MS = 500  // 基础延迟 500ms
export const DEFAULT_MAX_RETRIES = 10

export function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
  maxDelayMs = 32000,  // 默认最大延迟 32 秒
): number {
  // 1. 优先使用 Retry-After 头
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10)
    if (!isNaN(seconds)) {
      return seconds * 1000
    }
  }
  
  // 2. 指数退避公式：baseDelay * 2^(attempt-1)
  // attempt=1: 500ms
  // attempt=2: 1000ms
  // attempt=3: 2000ms
  // attempt=4: 4000ms
  // attempt=5: 8000ms
  // attempt=6: 16000ms
  // attempt=7: 32000ms (达到上限)
  const baseDelay = Math.min(
    BASE_DELAY_MS * Math.pow(2, attempt - 1),
    maxDelayMs,
  )
  
  // 3. 添加 25% 抖动防止惊群效应
  const jitter = Math.random() * 0.25 * baseDelay
  
  return baseDelay + jitter
}
```

### 延迟时间表

| 重试次数 | 基础延迟 | +25% 抖动范围 | 累计延迟 |
|----------|----------|---------------|----------|
| 1 | 500ms | 500-625ms | 500ms |
| 2 | 1000ms | 1000-1250ms | 1.5s |
| 3 | 2000ms | 2000-2500ms | 3.5s |
| 4 | 4000ms | 4000-5000ms | 7.5s |
| 5 | 8000ms | 8000-10000ms | 15.5s |
| 6 | 16000ms | 16000-20000ms | 31.5s |
| 7 | 32000ms | 32000-40000ms | 63.5s |
| 8+ | 32000ms | 32000-40000ms | 95.5s+ |

### 持久重试模式延迟

```typescript
// 持久重试模式使用更长的延迟上限
const PERSISTENT_MAX_BACKOFF_MS = 5 * 60 * 1000  // 5 分钟
const PERSISTENT_RESET_CAP_MS = 6 * 60 * 60 * 1000  // 6 小时

// 持久模式延迟计算
if (persistent && error instanceof APIError && error.status === 429) {
  persistentAttempt++
  
  // 使用重置延迟 (如果有)
  const resetDelay = getRateLimitResetDelayMs(error)
  
  delayMs = resetDelay ?? Math.min(
    getRetryDelay(persistentAttempt, retryAfter, PERSISTENT_MAX_BACKOFF_MS),
    PERSISTENT_RESET_CAP_MS,
  )
}
```

---

## 快速模式降级

### 快速模式概述

快速模式 (Fast Mode) 是 Anthropic API 的一项优化功能，通过 prompt 缓存减少响应延迟。当遇到 429/529 错误时，系统会自动降级到标准速度模式以保护缓存。

### 降级触发条件

```typescript
// 快速模式降级常量
export const DEFAULT_FAST_MODE_FALLBACK_HOLD_MS = 30 * 60 * 1000  // 30 分钟
export const SHORT_RETRY_THRESHOLD_MS = 20 * 1000  // 20 秒
export const MIN_COOLDOWN_MS = 10 * 60 * 1000  // 10 分钟

// 降级逻辑
if (wasFastModeActive && !isPersistentRetryEnabled()) {
  const retryAfterMs = getRetryAfterMs(error)
  
  if (retryAfterMs !== null && retryAfterMs < SHORT_RETRY_THRESHOLD_MS) {
    // 短延迟：等待并重试，保持快速模式激活 (保护 prompt 缓存)
    await sleep(retryAfterMs, options.signal, { abortError })
    continue
  }
  
  // 长延迟或未知：进入冷却模式，切换到标准速度模型
  const cooldownMs = Math.max(
    retryAfterMs ?? DEFAULT_FAST_MODE_FALLBACK_HOLD_MS,
    MIN_COOLDOWN_MS,
  )
  
  const cooldownReason: CooldownReason = is529Error(error)
    ? 'overloaded'
    : 'rate_limit'
  
  triggerFastModeCooldown(Date.now() + cooldownMs, cooldownReason)
  
  if (isFastModeEnabled()) {
    retryContext.fastMode = false
  }
  continue
}
```

### 降级状态机

```
┌─────────────────────────────────────────────────────────────────┐
│                    快速模式降级状态机                             │
└─────────────────────────────────────────────────────────────────┘

快速模式激活
│
├─► 遇到 429/529 错误
│
├─► 检查 Retry-After 延迟
│
├─► 延迟 < 20 秒 ?
│   │
│   ├─► 是 → 等待 → 重试 (保持快速模式)
│   │         │
│   │         └─► 成功 → 返回
│   │         └─► 失败 → 继续
│   │
│   └─► 否 → 进入冷却模式
│             │
│             ├─► 设置冷却结束时间 (当前时间 + cooldownMs)
│             ├─► 禁用快速模式 (retryContext.fastMode = false)
│             └─► 使用标准速度模型重试
│
└─► 冷却期间
    │
    ├─► 所有请求使用标准速度
    │
    └─► 冷却时间到 ?
        │
        ├─► 是 → 重新检查快速模式启用状态
        │        │
        │        ├─► 仍启用 → 重新激活快速模式
        │        └─► 已禁用 → 继续使用标准速度
        │
        └─► 否 → 继续等待
```

### 快速模式禁用原因

| 原因 | 描述 | 冷却时间 |
|------|------|----------|
| **overloaded** | 529 容量不足 | 10 分钟 |
| **rate_limit** | 429 频率限制 | 30 分钟 |
| **overage_disabled** | 额外用量不可用 | 永久禁用 |
| **not_enabled** | API 返回"Fast mode is not enabled" | 永久禁用 |

---

## 持久重试模式

### 持久重试概述

持久重试模式 (Persistent Retry Mode) 用于无人值守的会话，可以无限期地重试 429/529 错误，同时保持心跳防止会话超时。

### 启用条件

```typescript
// src/services/api/withRetry.ts

const PERSISTENT_MAX_BACKOFF_MS = 5 * 60 * 1000  // 5 分钟
const PERSISTENT_RESET_CAP_MS = 6 * 60 * 60 * 1000  // 6 小时
const HEARTBEAT_INTERVAL_MS = 30_000  // 30 秒心跳

function isPersistentRetryEnabled(): boolean {
  return feature('UNATTENDED_RETRY')
    ? isEnvTruthy(process.env.CLAUDE_CODE_UNATTENDED_RETRY)
    : false
}
```

### 持久重试逻辑

```typescript
// 持久重试主循环
for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
  try {
    return await operation(client, attempt, retryContext)
  } catch (error) {
    lastError = error
    
    // 检查是否是持久重试错误
    const persistent = isPersistentRetryEnabled() && isTransientCapacityError(error)
    
    if (attempt > maxRetries && !persistent) {
      throw new CannotRetryError(error, retryContext)
    }
    
    // 计算延迟
    let delayMs: number
    if (persistent && error instanceof APIError && error.status === 429) {
      persistentAttempt++
      
      // 使用重置延迟 (如果有)
      const resetDelay = getRateLimitResetDelayMs(error)
      delayMs = resetDelay ?? Math.min(
        getRetryDelay(persistentAttempt, retryAfter, PERSISTENT_MAX_BACKOFF_MS),
        PERSISTENT_RESET_CAP_MS,
      )
    } else if (persistent) {
      persistentAttempt++
      delayMs = Math.min(
        getRetryDelay(persistentAttempt, retryAfter, PERSISTENT_MAX_BACKOFF_MS),
        PERSISTENT_RESET_CAP_MS,
      )
    } else {
      delayMs = getRetryDelay(attempt, retryAfter)
    }
    
    // 持久模式：分块等待 + 心跳
    if (persistent) {
      if (delayMs > 60_000) {
        logEvent('tengu_api_persistent_retry_wait', {
          status: (error as APIError).status,
          delayMs,
          attempt: persistentAttempt,
        })
      }
      
      // 分块等待，每 30 秒发送心跳
      let remaining = delayMs
      while (remaining > 0) {
        if (options.signal?.aborted) throw new APIUserAbortError()
        
        // 发送系统消息 (心跳)
        if (error instanceof APIError) {
          yield createSystemAPIErrorMessage(
            error,
            remaining,
            persistentAttempt,
            maxRetries,
          )
        }
        
        const chunk = Math.min(remaining, HEARTBEAT_INTERVAL_MS)
        await sleep(chunk, options.signal, { abortError })
        remaining -= chunk
      }
      
      // 钳制 attempt 防止循环终止
      if (attempt >= maxRetries) attempt = maxRetries
    } else {
      // 标准模式：简单等待
      if (error instanceof APIError) {
        yield createSystemAPIErrorMessage(error, delayMs, attempt, maxRetries)
      }
      await sleep(delayMs, options.signal, { abortError })
    }
  }
}
```

### 心跳机制

```
┌─────────────────────────────────────────────────────────────────┐
│                    持久重试心跳机制                               │
└─────────────────────────────────────────────────────────────────┘

等待延迟 (例如：5 分钟)
│
├─► 循环分块 (每块 30 秒)
│   │
│   ├─► 第 1 块 (0-30 秒)
│   │   │
│   │   ├─► yield 系统消息："等待重试，剩余 4:30..."
│   │   └─► sleep(30000ms)
│   │
│   ├─► 第 2 块 (30-60 秒)
│   │   │
│   │   ├─► yield 系统消息："等待重试，剩余 4:00..."
│   │   └─► sleep(30000ms)
│   │
│   ├─► ...
│   │
│   └─► 第 10 块 (270-300 秒)
│       │
│       ├─► yield 系统消息："等待重试，剩余 0:00..."
│       └─► sleep(30000ms)
│
└─► 重试操作
```

---

## 529 错误处理

### 529 错误概述

529 错误表示 API 服务器过载，无法处理请求。这是一个特殊的错误类型，需要特殊的处理逻辑。

### 529 检测

```typescript
// 529 错误检测
export function is529Error(error: unknown): boolean {
  if (!(error instanceof APIError)) {
    return false
  }
  
  // 检查状态码或错误消息
  return (
    error.status === 529 ||
    // SDK 在流式传输时可能不传递 529 状态码
    (error.message?.includes('"type":"overloaded_error"') ?? false)
  )
}
```

### 529 重试源分类

```typescript
// 前台查询源 (用户等待结果)
const FOREGROUND_529_RETRY_SOURCES = new Set<QuerySource>([
  'repl_main_thread',
  'repl_main_thread:outputStyle:custom',
  'repl_main_thread:outputStyle:Explanatory',
  'repl_main_thread:outputStyle:Learning',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
  'compact',
  'hook_agent',
  'hook_prompt',
  'verification_agent',
  'side_question',
  'auto_mode',  // 安全分类器
  ...(feature('BASH_CLASSIFIER') ? (['bash_classifier'] as const) : []),
])

function shouldRetry529(querySource: QuerySource | undefined): boolean {
  // undefined → 重试 (保守处理未标记的调用路径)
  return (
    querySource === undefined || FOREGROUND_529_RETRY_SOURCES.has(querySource)
  )
}
```

### 529 连续错误追踪

```typescript
export const MAX_529_RETRIES = 3

// 在主重试循环中追踪
let consecutive529Errors = options.initialConsecutive529Errors ?? 0

if (is529Error(error)) {
  consecutive529Errors++
  
  if (consecutive529Errors >= MAX_529_RETRIES) {
    // 检查是否有降级模型
    if (options.fallbackModel) {
      logEvent('tengu_api_opus_fallback_triggered', {
        original_model: options.model,
        fallback_model: options.fallbackModel,
      })
      
      throw new FallbackTriggeredError(options.model, options.fallbackModel)
    }
    
    // 外部用户的特殊错误处理
    if (
      process.env.USER_TYPE === 'external' &&
      !process.env.IS_SANDBOX &&
      !isPersistentRetryEnabled()
    ) {
      logEvent('tengu_api_custom_529_overloaded_error', {})
      throw new CannotRetryError(
        new Error(REPEATED_529_ERROR_MESSAGE),
        retryContext,
      )
    }
  }
}
```

### Opus 降级逻辑

```typescript
// 529 降级到降级模型
if (
  is529Error(error) &&
  (process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS ||
    (!isClaudeAISubscriber() && isNonCustomOpusModel(options.model)))
) {
  consecutive529Errors++
  
  if (consecutive529Errors >= MAX_529_RETRIES) {
    if (options.fallbackModel) {
      // 触发降级
      throw new FallbackTriggeredError(options.model, options.fallbackModel)
    }
    
    // 无降级模型时的错误处理
    // ...
  }
}
```

---

## 相关文件

| 文件 | 描述 |
|------|------|
| `src/services/api/withRetry.ts` | 重试逻辑核心实现 |
| `src/services/api/errors.ts` | 错误类型定义 |
| `src/services/api/errorUtils.ts` | 错误处理工具 |
| `src/utils/fastMode.ts` | 快速模式管理 |
| `src/services/api/claude.ts` | API 请求发送 |

---

*文档生成时间：2026-04-01*
