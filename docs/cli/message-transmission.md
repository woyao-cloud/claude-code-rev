# 消息传输详解

## 概述

本文档详细介绍 CLI 传输层的消息传输机制，包括流式请求发送、响应处理、工具调用路由和使用量跟踪。

---

## 目录

1. [消息发送流程](#消息发送流程)
2. [流式响应处理](#流式响应处理)
3. [工具调用处理](#工具调用处理)
4. [使用量跟踪](#使用量跟踪)
5. [错误处理](#错误处理)

---

## 消息发送流程

### 完整消息发送流程

```
┌─────────────────────────────────────────────────────────────────┐
│                    消息发送完整流程                               │
└─────────────────────────────────────────────────────────────────┘

query() → sendRequest()
│
├─► 1. 构建请求配置
│   │
│   ├─► buildRequestConfig(params, options)
│   │   │
│   │   ├─► 规范化消息 (normalizeMessagesForAPI())
│   │   │   ├── 转换用户消息格式
│   │   │   ├── 处理系统消息
│   │   │   └── 整理工具响应
│   │   │
│   │   ├─► 添加工具定义 (tools?.map(tool => toolToAPISchema()))
│   │   │   ├── 工具名称
│   │   │   ├── 工具描述
│   │   │   ├── 输入 Schema
│   │   │   └── 输出 Schema (可选)
│   │   │
│   │   ├─► 构建系统提示 (buildSystemPrompt())
│   │   │   ├── 核心系统指令
│   │   │   ├── 工具使用上下文
│   │   │   └── 会话记忆
│   │   │
│   │   ├─► 添加 Beta 功能 (getMergedBetas())
│   │   │   ├── context-management-2024-08-01
│   │   │   ├── files-api-2025-04-14
│   │   │   └── oauth-2025-04-20
│   │   │
│   │   └─► 添加上下文管理 (getAPIContextManagement())
│   │       ├── 自动压缩设置
│   │       └── 上下文窗口管理
│   │
│   └─► 返回配置对象
│       {
│         model,
│         max_tokens,
│         messages,
│         system,
│         tools,
│         betas,
│         ...contextManagement
│       }
│
├─► 2. 应用重试逻辑
│   └─► withRetry(async () => { ... })
│       ├── 获取客户端实例
│       ├── 执行操作
│       └── 错误处理和重试
│
├─► 3. 发送流式请求
│   └─► client.beta.messages.stream(config)
│       │
│       ├─► 创建 HTTP 请求
│       │   ├── POST /v1/messages
│       │   ├── Content-Type: application/json
│       │   ├── stream: true
│       │   └── 请求体：{ ...config }
│       │
│       └─► 返回 Stream 对象
│           ├── 异步迭代器
│           ├── 事件监听器
│           └── 取消方法
│
└─► 4. 处理流式响应
    └─► for await (const event of stream) { ... }
```

### 请求配置构建代码

```typescript
// src/services/api/claude.ts

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

---

## 流式响应处理

### SSE 事件类型

| 事件类型 | 描述 | 数据内容 |
|----------|------|----------|
| `message_start` | 消息流开始 | `{ type: 'message_start', message: { id, ... } }` |
| `content_block_start` | 内容块开始 | `{ type: 'content_block_start', index, content_block: { type, ... } }` |
| `content_block_delta` | 内容增量 | `{ type: 'content_block_delta', index, delta: { type, text, ... } }` |
| `content_block_stop` | 内容块结束 | `{ type: 'content_block_stop', index }` |
| `message_delta` | 消息增量 | `{ type: 'message_delta', delta: { stop_reason, stop_sequence }, usage: { ... } }` |
| `message_stop` | 消息流结束 | `{ type: 'message_stop' }` |

### 流式响应处理代码

```typescript
// src/services/api/claude.ts

export async function processStreamResponse(
  stream: Stream<BetaRawMessageStreamEvent>
): Promise<QueryResult> {
  const contentBlocks: ContentBlock[] = []
  let currentBlock: ContentBlock | null = null
  let usage: Usage | null = null
  let stopReason: string | null = null
  
  for await (const event of stream) {
    switch (event.type) {
      case 'message_start':
        // 记录消息开始
        logForDebugging(`Message started: ${event.message.id}`)
        break
        
      case 'content_block_start':
        // 创建新的内容块
        currentBlock = {
          type: event.content_block.type,
          text: '',
          toolCalls: [],
        }
        break
        
      case 'content_block_delta':
        // 处理内容增量
        if (event.delta.type === 'text_delta') {
          // 文本增量 - 流式输出到终端
          yield { type: 'text', text: event.delta.text }
          if (currentBlock) {
            currentBlock.text += event.delta.text
          }
        } else if (event.delta.type === 'input_json_delta') {
          // 工具输入 JSON 增量
          if (currentBlock) {
            currentBlock.inputJson += event.delta.partial_json
          }
        }
        break
        
      case 'content_block_stop':
        // 内容块完成
        if (currentBlock) {
          contentBlocks.push(currentBlock)
          currentBlock = null
        }
        break
        
      case 'message_delta':
        // 记录使用量和停止原因
        usage = event.usage
        stopReason = event.delta.stop_reason
        break
        
      case 'message_stop':
        // 消息完成
        logForDebugging(`Message completed: ${stopReason}`)
        break
    }
  }
  
  return {
    contentBlocks,
    usage,
    stopReason,
  }
}
```

### 流式处理时序图

```
┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐
│query.ts   │  │claude.ts  │  │SDK Stream │  │API Server │
└─────┬─────┘  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘
      │              │              │              │
      │ stream()     │              │              │
      │─────────────>│              │              │
      │              │              │              │
      │              │ POST /messages              │
      │              │────────────────────────────>│
      │              │              │              │
      │              │              │              │
      │              │              │ message_start│
      │              │              │<─────────────│
      │              │              │              │
      │              │ on('message_start')         │
      │              │<─────────────│              │
      │              │              │              │
      │              │ yield event │              │
      │              │─────────────>│              │
      │              │              │              │
      │              │              │ content_block_start
      │              │              │<─────────────│
      │              │<─────────────│              │
      │              │              │              │
      │              │              │ content_block_delta (xN)
      │              │              │<─────────────│
      │              │<─────────────│              │
      │              │              │              │
      │              │ yield delta (流式输出)      │
      │              │─────────────>│              │
      │              │              │              │
      │              │              │ content_block_stop
      │              │              │<─────────────│
      │              │<─────────────│              │
      │              │              │              │
      │              │              │ message_delta
      │              │              │<─────────────│
      │              │<─────────────│              │
      │              │              │              │
      │              │              │ message_stop │
      │              │              │<─────────────│
      │              │<─────────────│              │
      │              │              │              │
      │<─────────────│              │              │
      │              │              │              │
```

---

## 工具调用处理

### 工具调用检测

```typescript
// 检测工具调用事件
if (event.type === 'content_block_start' && 
    event.content_block.type === 'tool_use') {
  // 开始新的工具调用
  currentToolCall = {
    id: event.content_block.id,
    name: event.content_block.name,
    input: '',
  }
}

if (event.type === 'content_block_delta' && 
    event.delta.type === 'input_json_delta') {
  // 累积工具输入 JSON
  if (currentToolCall) {
    currentToolCall.input += event.delta.partial_json
  }
}

if (event.type === 'content_block_stop') {
  // 工具调用完成
  if (currentToolCall) {
    toolCalls.push(currentToolCall)
    currentToolCall = null
  }
}
```

### 工具调用执行流程

```
模型返回工具调用
│
├─► 1. 解析工具调用
│   ├── 工具名
│   ├── 工具 ID
│   └── 输入参数 (JSON)
│
├─► 2. 查找工具实现
│   ├── 内置工具 (Bash, FileRead, etc.)
│   ├── MCP 工具 (mcp__server__tool)
│   └── 插件工具
│
├─► 3. 权限检查
│   └─► checkPermissions(toolName, args)
│       ├── 检查允许规则
│   │   ├── 检查拒绝规则
│       ├── 运行分类器 (auto 模式)
│       └── 返回决策 (allow/deny/ask)
│
├─► 4. 执行工具
│   └─► tool.execute(args)
│       ├── 执行具体逻辑
│       ├── 捕获输出
│       └── 返回结果
│
├─► 5. 构建工具响应
│   └─► {
│         type: 'tool_result',
│         tool_use_id: toolId,
│         content: result,
│       }
│
└─► 6. 发送回 API
    └─► 下一轮查询继续
```

---

## 使用量跟踪

### 指标记录

```typescript
// src/services/api/claude.ts

function logAPIMetrics(config: BetaMessageStreamParams): void {
  logEvent('api_request_completed', {
    model: config.model,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    duration_ms: Date.now() - startTime,
    first_token_latency_ms: firstTokenTime - startTime,
  })
}
```

### 使用量数据结构

```typescript
interface Usage {
  input_tokens: number           // 输入令牌数
  output_tokens: number          // 输出令牌数
  cache_read_input_tokens?: number  // 缓存读取输入令牌
  cache_creation_input_tokens?: number  // 缓存创建输入令牌
}
```

### 令牌估算

```typescript
// 估算消息的令牌数
export function tokenCountWithEstimation(messages: Message[]): number {
  let total = 0
  
  for (const message of messages) {
    // 每条消息的基础开销
    total += 4  // 消息格式开销
    
    // 内容块令牌估算
    for (const content of message.content) {
      if (content.type === 'text') {
        // 文本：约 4 字符/令牌
        total += Math.ceil(content.text.length / 4)
      } else if (content.type === 'image') {
        // 图像：固定令牌 + 分辨率调整
        total += estimateImageTokens(content)
      } else if (content.type === 'tool_use' || content.type === 'tool_result') {
        // 工具调用：JSON 内容估算
        total += Math.ceil(JSON.stringify(content).length / 4)
      }
    }
  }
  
  return total
}
```

---

## 错误处理

### API 错误类型

```typescript
// src/services/api/errors.ts

// SDK 基础错误
export class APIError extends Error {
  status?: number
  headers?: Headers
}

export class APIConnectionError extends APIError {
  // 网络连接错误
}

export class APIConnectionTimeoutError extends APIConnectionError {
  // 连接超时
}

export class APIUserAbortError extends APIError {
  // 用户取消
}
```

### 错误分类和处理

| 错误类型 | 处理方式 |
|----------|----------|
| `APIConnectionTimeoutError` | 重试 |
| `APIConnectionError` (ECONNRESET/EPIPE) | 禁用 keep-alive，重试 |
| `APIError` (529) | 特殊处理，连续 3 次降级 |
| `APIError` (429) | 等待 Retry-After，重试 |
| `APIError` (401) | 刷新令牌，重试 |
| `APIError` (403, token revoked) | 刷新令牌，重试 |
| `APIError` (5xx) | 重试 |
| `APIError` (4xx) | 不重试，抛出错误 |

### 错误日志

```typescript
// 短错误栈提取 (用于工具结果)
export function extractShortErrorStack(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }
  
  const lines = (error.stack || '').split('\n')
  
  // 只保留前 5 行和相关源码行
  const relevantLines = lines.filter((line, i) => {
    if (i === 0) return true  // 错误消息
    if (i <= 5) return true   // 前 5 行栈帧
    return line.includes('src/')  // 只保留源码行
  })
  
  return relevantLines.join('\n')
}
```

---

## 相关文件

| 文件 | 描述 |
|------|------|
| `src/services/api/claude.ts` | 消息发送核心逻辑 |
| `src/services/api/client.ts` | API 客户端创建 |
| `src/services/api/withRetry.ts` | 重试逻辑 |
| `src/services/api/errors.ts` | 错误定义 |
| `src/services/api/errorUtils.ts` | 错误处理工具 |
| `src/services/api/logging.ts` | API 日志记录 |
| `src/services/api/usage.ts` | 使用量跟踪 |

---

*文档生成时间：2026-04-01*
