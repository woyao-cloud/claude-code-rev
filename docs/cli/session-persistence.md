# 会话持久化详解

## 概述

本文档详细介绍 CLI 传输层的会话持久化机制，包括 Session Ingress 架构、乐观并发控制、409 冲突解决和 JWT/OAuth 认证。

---

## 目录

1. [Session Ingress 架构](#session-ingress 架构)
2. [日志追加流程](#日志追加流程)
3. [乐观并发控制](#乐观并发控制)
4. [409 冲突解决](#409 冲突解决)
5. [日志获取](#日志获取)
6. [Teleport Events API](#teleport-events-api)

---

## Session Ingress 架构

### 模块职责

```typescript
// src/services/api/sessionIngress.ts

// 核心功能
- appendSessionLog()      // 追加日志条目
- getSessionLogs()        // 获取会话日志
- clearSession()          // 清除会话缓存
- clearAllSessions()      // 清除所有会话缓存
```

### 架构组件

```
┌─────────────────────────────────────────────────────────────────┐
│                    Session Ingress 架构                          │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────┐
│  CLI Client     │
│  (本地进程)      │
└────────┬────────┘
         │
         │ 1. PUT /session/{id} (追加日志)
         │    Last-Uuid: xxx
         │
         ▼
┌─────────────────┐
│  Session        │
│  Ingress API    │
│  (远程服务)      │
└────────┬────────┘
         │
         │ 2. 检查 Last-Uuid
         │    - 匹配 → 接受，返回 200
         │    - 不匹配 → 返回 409
         │
         ▼
┌─────────────────┐
│  Spanner /      │
│  Threadstore    │
│  (持久化存储)    │
└─────────────────┘
```

### 状态管理

```typescript
// 模块级状态
const lastUuidMap: Map<string, UUID> = new Map()  // 每会话最后 UUID

// 每会话顺序执行包装器
const sequentialAppendBySession: Map<
  string,
  (entry, url, headers) => Promise<boolean>
> = new Map()
```

---

## 日志追加流程

### 完整追加流程

```
┌─────────────────────────────────────────────────────────────────┐
│                    日志追加完整流程                               │
└─────────────────────────────────────────────────────────────────┘

appendSessionLog(sessionId, entry, url)
│
├─► 1. 获取 Session Token
│   └─► getSessionIngressAuthToken()
│       ├── 成功 → 继续
│       └── 失败 → 返回 false
│
├─► 2. 准备请求头
│   ├── Authorization: `Bearer ${sessionToken}`
│   └── Content-Type: `application/json`
│
├─► 3. 获取顺序执行包装器
│   └─► getOrCreateSequentialAppend(sessionId)
│       ├── 存在 → 返回现有包装器
│       └── 不存在 → 创建新包装器
│
├─► 4. 顺序执行追加操作
│   └─► sequentialAppend(entry, url, headers)
│       │
│       └─► appendSessionLogImpl() (带重试)
│           │
│           ├─► 重试循环 (MAX_RETRIES=10)
│           │   │
│           │   ├─► 获取本地 lastUuid
│           │   │   └─► lastUuidMap.get(sessionId)
│           │   │
│           │   ├─► 添加 Last-Uuid 头
│           │   │   └─► requestHeaders['Last-Uuid'] = lastUuid
│           │   │
│           │   ├─► 发送 PUT 请求
│           │   │   └─► axios.put(url, entry, { headers })
│           │   │
│           │   ├─► 状态码处理
│           │   │   │
│           │   │   ├─► 200/201 → 成功
│           │   │   │   └─► 更新 lastUuidMap
│           │   │   │   └─► 返回 true
│           │   │   │
│           │   │   ├─► 409 → 冲突处理
│           │   │   │   └─► 采用服务器 UUID 并重试
│           │   │   │
│           │   │   ├─► 401 → 认证失败
│           │   │   │   └─► 返回 false (不重试)
│           │   │   │
│           │   │   └─► 其他 → 等待后重试
│           │   │       └─► 指数退避延迟
│           │   │
│           │   └─► 超过最大重试次数 → 返回 false
│           │
│           └─► 返回结果
│
└─► 5. 返回追加结果
```

### 追加代码实现

```typescript
// src/services/api/sessionIngress.ts

export async function appendSessionLog(
  sessionId: string,
  entry: TranscriptMessage,
  url: string,
): Promise<boolean> {
  // 1. 获取 Session Token
  const sessionToken = getSessionIngressAuthToken()
  if (!sessionToken) {
    logForDebugging('No session token available for session persistence')
    logForDiagnosticsNoPII('error', 'session_persist_fail_jwt_no_token')
    return false
  }
  
  // 2. 准备请求头
  const headers: Record<string, string> = {
    Authorization: `Bearer ${sessionToken}`,
    'Content-Type': 'application/json',
  }
  
  // 3. 获取顺序执行包装器
  const sequentialAppend = getOrCreateSequentialAppend(sessionId)
  
  // 4. 顺序执行追加
  return sequentialAppend(entry, url, headers)
}
```

### 顺序执行包装器

```typescript
// 确保每会话的日志追加是顺序执行的
function getOrCreateSequentialAppend(sessionId: string) {
  let sequentialAppend = sequentialAppendBySession.get(sessionId)
  if (!sequentialAppend) {
    sequentialAppend = sequential(
      async (
        entry: TranscriptMessage,
        url: string,
        headers: Record<string, string>,
      ) => await appendSessionLogImpl(sessionId, entry, url, headers),
    )
    sequentialAppendBySession.set(sessionId, sequentialAppend)
  }
  return sequentialAppend
}
```

---

## 乐观并发控制

### Last-Uuid 机制

```typescript
// 追加实现 (带乐观并发控制)
async function appendSessionLogImpl(
  sessionId: string,
  entry: TranscriptMessage,
  url: string,
  headers: Record<string, string>,
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // 获取本地缓存的 lastUuid
    const lastUuid = lastUuidMap.get(sessionId)
    const requestHeaders = { ...headers }
    
    // 添加 Last-Uuid 头 (乐观并发控制)
    if (lastUuid) {
      requestHeaders['Last-Uuid'] = lastUuid
    }
    
    // 发送 PUT 请求
    const response = await axios.put(url, entry, {
      headers: requestHeaders,
      validateStatus: status => status < 500,
    })
    
    // 成功：200 或 201
    if (response.status === 200 || response.status === 201) {
      // 更新本地缓存
      lastUuidMap.set(sessionId, entry.uuid)
      logForDebugging(
        `Successfully persisted session log entry for session ${sessionId}`,
      )
      return true
    }
    
    // 409 冲突处理
    if (response.status === 409) {
      // ... (见 409 冲突解决部分)
    }
    
    // 401 认证失败
    if (response.status === 401) {
      logForDebugging('Session token expired or invalid')
      logForDiagnosticsNoPII('error', 'session_persist_fail_bad_token')
      return false
    }
    
    // 其他错误：等待后重试
    const delayMs = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), 8000)
    await sleep(delayMs)
  }
  
  return false
}
```

### 并发控制时序图

```
┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐
│Client A   │  │Client B   │  │Server     │  │Storage    │
└─────┬─────┘  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘
      │              │              │              │
      │ PUT (Uuid=A) │              │              │
      │ Last-Uuid=X  │              │              │
      │─────────────>│              │              │
      │              │              │              │
      │              │ PUT (Uuid=B) │              │
      │              │ Last-Uuid=X  │              │
      │              │─────────────>│              │
      │              │              │              │
      │              │              │ 检查 Last-Uuid│
      │              │              │─────────────>│
      │              │              │              │
      │              │              │ X 匹配 → 接受 A
      │              │              │<─────────────│
      │              │              │              │
      │ 200 OK       │              │              │
      │<─────────────│              │              │
      │              │              │              │
      │              │              │ X 不匹配 → 409 B
      │              │              │<─────────────│
      │              │              │              │
      │              │ 409 Conflict │              │
      │              │<─────────────│              │
      │              │              │              │
      │              │ 采用服务器 UUID 并重试        │
      │              │              │              │
```

---

## 409 冲突解决

### 冲突解决策略

```typescript
// 409 冲突处理
if (response.status === 409) {
  // 1. 检查我们的条目是否已被存储
  const serverLastUuid = response.headers['x-last-uuid']
  if (serverLastUuid === entry.uuid) {
    // 我们的条目已在服务器上 - 从之前的请求成功
    lastUuidMap.set(sessionId, entry.uuid)
    logForDebugging(
      `Session entry ${entry.uuid} already present on server, recovering from stale state`,
    )
    logForDiagnosticsNoPII('info', 'session_persist_recovered_from_409')
    return true
  }
  
  // 2. 采用服务器的 lastUuid 并重试
  if (serverLastUuid) {
    lastUuidMap.set(sessionId, serverLastUuid)
    logForDebugging(
      `Session 409: adopting server lastUuid=${serverLastUuid} from header, retrying entry ${entry.uuid}`,
    )
    logForDiagnosticsNoPII('info', 'session_persist_409_adopt_server_uuid')
    continue // 重试
  }
  
  // 3. 服务器没有返回 x-last-uuid，重新获取会话日志
  const logs = await fetchSessionLogsFromUrl(sessionId, url, headers)
  const adoptedUuid = findLastUuid(logs)
  if (adoptedUuid) {
    lastUuidMap.set(sessionId, adoptedUuid)
    logForDebugging(
      `Session 409: re-fetched ${logs!.length} entries, adopting lastUuid=${adoptedUuid}, retrying entry ${entry.uuid}`,
    )
    continue // 重试
  }
  
  // 4. 无法确定服务器状态，放弃
  const errorData = response.data as SessionIngressError
  const errorMessage = errorData.error?.message || 'Concurrent modification detected'
  logError(
    new Error(
      `Session persistence conflict: UUID mismatch for session ${sessionId}, entry ${entry.uuid}. ${errorMessage}`,
    ),
  )
  logForDiagnosticsNoPII(
    'error',
    'session_persist_fail_concurrent_modification',
  )
  return false
}
```

### 冲突解决流程

```
┌─────────────────────────────────────────────────────────────────┐
│                    409 冲突解决流程                               │
└─────────────────────────────────────────────────────────────────┘

收到 409 响应
│
├─► 1. 检查服务器 x-last-uuid 头
│   │
│   ├─► serverLastUuid === entry.uuid ?
│   │   │
│   │   └─► 是 → 条目已存储，恢复状态
│   │       └─► 返回 true
│   │
│   └─► 否 → 继续
│
├─► 2. 服务器返回了 x-last-uuid ?
│   │
│   ├─► 是 → 采用服务器 UUID
│   │   │
│   │   ├─► lastUuidMap.set(sessionId, serverLastUuid)
│   │   └─► 重试
│   │
│   └─► 否 → 继续
│
├─► 3. 重新获取会话日志
│   │
│   ├─► GET /session/{id}
│   │
│   ├─► 找到最后一个 UUID
│   │   └─► findLastUuid(logs)
│   │
│   └─► 找到了 ?
│       │
│       ├─► 是 → 采用并重试
│       │   └─► continue
│       │
│       └─► 否 → 继续
│
└─► 4. 无法确定服务器状态
    │
    └─► 记录错误，返回 false
```

---

## 日志获取

### 获取会话日志

```typescript
// src/services/api/sessionIngress.ts

export async function getSessionLogs(
  sessionId: string,
  url: string,
): Promise<Entry[] | null> {
  // 1. 获取 Session Token
  const sessionToken = getSessionIngressAuthToken()
  if (!sessionToken) {
    logForDebugging('No session token available for fetching session logs')
    logForDiagnosticsNoPII('error', 'session_get_fail_no_token')
    return null
  }
  
  // 2. 准备请求头
  const headers = { Authorization: `Bearer ${sessionToken}` }
  
  // 3. 获取日志
  const logs = await fetchSessionLogsFromUrl(sessionId, url, headers)
  
  // 4. 更新本地 lastUuid
  if (logs && logs.length > 0) {
    const lastEntry = logs.at(-1)
    if (lastEntry && 'uuid' in lastEntry && lastEntry.uuid) {
      lastUuidMap.set(sessionId, lastEntry.uuid)
    }
  }
  
  return logs
}
```

### 获取实现

```typescript
async function fetchSessionLogsFromUrl(
  sessionId: string,
  url: string,
  headers: Record<string, string>,
): Promise<Entry[] | null> {
  try {
    const response = await axios.get(url, {
      headers,
      timeout: 20000,
      validateStatus: status => status < 500,
      params: isEnvTruthy(process.env.CLAUDE_AFTER_LAST_COMPACT)
        ? { after_last_compact: true }
        : undefined,
    })
    
    if (response.status === 200) {
      const data = response.data
      
      // 验证响应格式
      if (!data || typeof data !== 'object' || !Array.isArray(data.loglines)) {
        logError(
          new Error(
            `Invalid session logs response format: ${jsonStringify(data)}`,
          ),
        )
        return null
      }
      
      const logs = data.loglines as Entry[]
      logForDebugging(
        `Fetched ${logs.length} session logs for session ${sessionId}`,
      )
      return logs
    }
    
    if (response.status === 404) {
      logForDebugging(`No existing logs for session ${sessionId}`)
      return []
    }
    
    if (response.status === 401) {
      logForDebugging('Auth token expired or invalid')
      throw new Error(
        'Your session has expired. Please run /login to sign in again.',
      )
    }
    
    return null
  } catch (error) {
    const axiosError = error as AxiosError<SessionIngressError>
    logError(new Error(`Error fetching session logs: ${axiosError.message}`))
    return null
  }
}
```

---

## Teleport Events API

### CCR v2 Sessions API

```typescript
// src/services/api/sessionIngress.ts

/**
 * 通过 CCR v2 Sessions API 获取 worker events (transcript)
 * 替代 getSessionLogsViaOAuth (session-ingress 已废弃)
 */
export async function getTeleportEvents(
  sessionId: string,
  accessToken: string,
  orgUUID: string,
): Promise<Entry[] | null> {
  const baseUrl = `${getOauthConfig().BASE_API_URL}/v1/code/sessions/${sessionId}/teleport-events`
  const headers = {
    ...getOAuthHeaders(accessToken),
    'x-organization-uuid': orgUUID,
  }
  
  const all: Entry[] = []
  let cursor: string | undefined
  let pages = 0
  
  // 最大页数限制：100 页 × 1000 条/页 = 100k events
  const maxPages = 100
  
  // 分页循环
  while (pages < maxPages) {
    const params: Record<string, string | number> = { limit: 1000 }
    if (cursor !== undefined) {
      params.cursor = cursor
    }
    
    const response = await axios.get<TeleportEventsResponse>(baseUrl, {
      headers,
      params,
      timeout: 20000,
      validateStatus: status => status < 500,
    })
    
    if (response.status === 404) {
      // 404 在第一页：会话不存在或路由未部署
      // 404 在分页中：会话被删除
      return pages === 0 ? null : all
    }
    
    if (response.status === 401) {
      throw new Error(
        'Your session has expired. Please run /login to sign in again.',
      )
    }
    
    if (response.status !== 200) {
      return null
    }
    
    const { data, next_cursor } = response.data
    
    // 收集 events (payload IS the Entry)
    for (const ev of data) {
      if (ev.payload !== null) {
        all.push(ev.payload)
      }
    }
    
    pages++
    
    // 检查是否有更多页面
    if (next_cursor == null) {
      break
    }
    cursor = next_cursor
  }
  
  return all
}
```

### Teleport Events 响应类型

```typescript
type TeleportEventsResponse = {
  data: Array<{
    event_id: string
    event_type: string
    is_compaction: boolean
    payload: Entry | null  // payload IS the Entry
    created_at: string
  }>
  next_cursor?: string  // 未设置时表示流结束
}
```

### 分页机制

```
┌─────────────────────────────────────────────────────────────────┐
│                    Teleport Events 分页机制                       │
└─────────────────────────────────────────────────────────────────┘

第 1 页请求
│
├─► GET /v1/code/sessions/{id}/teleport-events?limit=1000
│   └─► 响应：{ data: [...], next_cursor: "xxx" }
│
├─► 收集 events
│   └─► all.push(...data)
│
├─► 第 2 页请求
│   └─► GET ...?limit=1000&cursor=xxx
│       └─► 响应：{ data: [...], next_cursor: "yyy" }
│
├─► 重复直到 next_cursor == null
│
└─► 返回所有 events
```

---

## 状态清理

### 清除会话状态

```typescript
// 清除单个会话的缓存状态
export function clearSession(sessionId: string): void {
  lastUuidMap.delete(sessionId)
  sequentialAppendBySession.delete(sessionId)
}

// 清除所有会话的缓存状态 (用于 /clear 命令)
export function clearAllSessions(): void {
  lastUuidMap.clear()
  sequentialAppendBySession.clear()
}
```

---

## 诊断事件

### 持久化事件

| 事件名 | 描述 |
|--------|------|
| `session_persist_recovered_from_409` | 从 409 恢复 |
| `session_persist_409_adopt_server_uuid` | 采用服务器 UUID |
| `session_persist_fail_bad_token` | 令牌失效 |
| `session_persist_fail_concurrent_modification` | 并发修改 |
| `session_persist_fail_status` | 状态码错误 |
| `session_persist_error_retries_exhausted` | 重试耗尽 |

### 获取事件

| 事件名 | 描述 |
|--------|------|
| `session_get_fail_no_token` | 无令牌 |
| `session_get_fail_invalid_response` | 响应格式无效 |
| `session_get_fail_bad_token` | 令牌失效 |
| `session_get_fail_status` | 状态码错误 |
| `session_get_no_logs_for_session` | 无日志 |

---

## 相关文件

| 文件 | 描述 |
|------|------|
| `src/services/api/sessionIngress.ts` | Session Ingress 核心实现 |
| `src/utils/teleport/api.ts` | Teleport API 工具 |
| `src/utils/sessionIngressAuth.ts` | Session Ingress 认证 |

---

*文档生成时间：2026-04-01*
