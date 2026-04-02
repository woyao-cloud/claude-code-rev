# Files API 详解

## 概述

本文档详细介绍 CLI 传输层的 Files API，包括文件下载、上传、列表操作以及并行处理机制。

---

## 目录

1. [API 基础](#api 基础)
2. [文件下载](#文件下载)
3. [文件上传](#文件上传)
4. [文件列表](#文件列表)
5. [并行处理](#并行处理)
6. [错误处理](#错误处理)

---

## API 基础

### 配置常量

```typescript
// src/services/api/filesApi.ts

const FILES_API_BETA_HEADER = 'files-api-2025-04-14,oauth-2025-04-20'
const ANTHROPIC_VERSION = '2023-06-01'
const MAX_RETRIES = 3
const BASE_DELAY_MS = 500
const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024  // 500MB
const DEFAULT_CONCURRENCY = 5  // 默认并行下载数
```

### 配置对象

```typescript
type FilesApiConfig = {
  /** OAuth token (session JWT) */
  oauthToken: string
  /** Base URL (默认：https://api.anthropic.com) */
  baseUrl?: string
  /** Session ID (用于创建会话专用目录) */
  sessionId: string
}
```

### 文件规格格式

```typescript
// CLI 参数格式：--file=<file_id>:<relative_path>
type File = {
  fileId: string      // 例如："file_011CNha8iCJcU1wXNR6q4V8w"
  relativePath: string // 例如："uploads/document.pdf"
}
```

---

## 文件下载

### 单文件下载流程

```
┌─────────────────────────────────────────────────────────────────┐
│                    单文件下载流程                                 │
└─────────────────────────────────────────────────────────────────┘

downloadFile(fileId, config)
│
├─► 1. 构建请求 URL
│   └─► `${baseUrl}/v1/files/${fileId}/content`
│
├─► 2. 准备请求头
│   ├── Authorization: `Bearer ${oauthToken}`
│   ├── 'anthropic-version': '2023-06-01'
│   └── 'anthropic-beta': 'files-api-2025-04-14,oauth-2025-04-20'
│
├─► 3. 重试循环 (MAX_RETRIES=3)
│   │
│   ├─► 发送 GET 请求
│   │   └─► axios.get(url, { responseType: 'arraybuffer' })
│   │
│   ├─► 状态码检查
│   │   │
│   │   ├─► 200 → 成功，返回 Buffer
│   │   │
│   │   ├─► 404 → 文件不存在，抛出错误
│   │   │
│   │   ├─► 401 → 认证失败，抛出错误
│   │   │
│   │   ├─► 403 → 访问拒绝，抛出错误
│   │   │
│   │   └─► 5xx/网络错误 → 等待后重试
│   │       └─► 指数退避：500ms, 1s, 2s
│   │
│   └─► 超过最大重试次数 → 抛出错误
│
└─► 4. 返回 Buffer
```

### 下载代码实现

```typescript
// src/services/api/filesApi.ts

export async function downloadFile(
  fileId: string,
  config: FilesApiConfig,
): Promise<Buffer> {
  const baseUrl = config.baseUrl || getDefaultApiBaseUrl()
  const url = `${baseUrl}/v1/files/${fileId}/content`
  
  const headers = {
    Authorization: `Bearer ${config.oauthToken}`,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': FILES_API_BETA_HEADER,
  }
  
  return retryWithBackoff(`Download file ${fileId}`, async (attempt) => {
    try {
      const response = await axios.get(url, {
        headers,
        responseType: 'arraybuffer',
        timeout: 60000, // 60 秒超时
        validateStatus: status => status < 500,
      })
      
      if (response.status === 200) {
        logDebug(`Downloaded file ${fileId} (${response.data.length} bytes)`)
        return { done: true, value: Buffer.from(response.data) }
      }
      
      // 非重试错误
      if (response.status === 404) {
        throw new Error(`File not found: ${fileId}`)
      }
      if (response.status === 401) {
        throw new Error('Authentication failed: invalid or missing API key')
      }
      if (response.status === 403) {
        throw new Error(`Access denied to file: ${fileId}`)
      }
      
      // 重试错误
      return { done: false, error: `status ${response.status}` }
    } catch (error) {
      if (!axios.isAxiosError(error)) {
        throw error
      }
      return { done: false, error: error.message }
    }
  })
}
```

### 下载并保存文件

```typescript
export async function downloadAndSaveFile(
  attachment: File,
  config: FilesApiConfig,
): Promise<DownloadResult> {
  const { fileId, relativePath } = attachment
  
  // 构建下载路径
  const fullPath = buildDownloadPath(getCwd(), config.sessionId, relativePath)
  
  if (!fullPath) {
    return {
      fileId,
      path: '',
      success: false,
      error: `Invalid file path: ${relativePath}`,
    }
  }
  
  try {
    // 下载文件内容
    const content = await downloadFile(fileId, config)
    
    // 确保父目录存在
    const parentDir = path.dirname(fullPath)
    await fs.mkdir(parentDir, { recursive: true })
    
    // 写入文件
    await fs.writeFile(fullPath, content)
    
    logDebug(`Saved file ${fileId} to ${fullPath} (${content.length} bytes)`)
    
    return {
      fileId,
      path: fullPath,
      success: true,
      bytesWritten: content.length,
    }
  } catch (error) {
    logDebugError(`Failed to download file ${fileId}: ${errorMessage(error)}`)
    
    return {
      fileId,
      path: fullPath,
      success: false,
      error: errorMessage(error),
    }
  }
}
```

### 路径构建和安全检查

```typescript
// 构建下载路径，防止路径遍历攻击
export function buildDownloadPath(
  basePath: string,
  sessionId: string,
  relativePath: string,
): string | null {
  // 规范化路径
  const normalized = path.normalize(relativePath)
  
  // 安全检查：禁止路径遍历
  if (normalized.startsWith('..')) {
    logDebugError(
      `Invalid file path: ${relativePath}. Path must not traverse above workspace`,
    )
    return null
  }
  
  // 构建 uploads 基础目录
  const uploadsBase = path.join(basePath, sessionId, 'uploads')
  
  // 移除冗余前缀
  const redundantPrefixes = [
    path.join(basePath, sessionId, 'uploads') + path.sep,
    path.sep + 'uploads' + path.sep,
  ]
  
  const matchedPrefix = redundantPrefixes.find(p => normalized.startsWith(p))
  const cleanPath = matchedPrefix
    ? normalized.slice(matchedPrefix.length)
    : normalized
  
  return path.join(uploadsBase, cleanPath)
}
```

---

## 文件上传

### 上传流程 (BYOC 模式)

```
┌─────────────────────────────────────────────────────────────────┐
│                    文件上传流程 (BYOC 模式)                        │
└─────────────────────────────────────────────────────────────────┘

uploadFile(filePath, relativePath, config)
│
├─► 1. 读取文件内容
│   └─► fs.readFile(filePath)
│       ├── 成功 → 继续
│       └── 失败 → 返回错误 (不重试)
│
├─► 2. 大小验证
│   └─► fileSize <= MAX_FILE_SIZE_BYTES (500MB) ?
│       ├── 是 → 继续
│       └── 否 → 返回错误
│
├─► 3. 构建 multipart/form-data 请求体
│   ├── boundary = randomUUID()
│   ├── File part
│   │   ├── filename
│   │   ├── Content-Type: application/octet-stream
│   │   └── 文件内容
│   └── Purpose part
│       └── purpose: "user_data"
│
├─► 4. 重试循环 (MAX_RETRIES=3)
│   │
│   ├─► 发送 POST 请求
│   │   └─► axios.post(url, body, { headers })
│   │
│   ├─► 状态码检查
│   │   │
│   │   ├─► 200/201 → 成功，返回 fileId
│   │   │
│   │   ├─► 401 → 认证失败，抛出非重试错误
│   │   │
│   │   ├─► 403 → 访问拒绝，抛出非重试错误
│   │   │
│   │   ├─► 413 → 文件太大，抛出非重试错误
│   │   │
│   │   └─► 5xx/网络错误 → 等待后重试
│   │
│   └─► 超过最大重试次数 → 返回错误
│
└─► 5. 返回上传结果
```

### 上传代码实现

```typescript
// src/services/api/filesApi.ts

export async function uploadFile(
  filePath: string,
  relativePath: string,
  config: FilesApiConfig,
  opts?: { signal?: AbortSignal },
): Promise<UploadResult> {
  const baseUrl = config.baseUrl || getDefaultApiBaseUrl()
  const url = `${baseUrl}/v1/files`
  
  const headers = {
    Authorization: `Bearer ${config.oauthToken}`,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': FILES_API_BETA_HEADER,
  }
  
  // 1. 读取文件内容 (重试循环外)
  let content: Buffer
  try {
    content = await fs.readFile(filePath)
  } catch (error) {
    logEvent('tengu_file_upload_failed', { error_type: 'file_read' })
    return { path: relativePath, error: errorMessage(error), success: false }
  }
  
  // 2. 大小验证
  const fileSize = content.length
  if (fileSize > MAX_FILE_SIZE_BYTES) {
    logEvent('tengu_file_upload_failed', { error_type: 'file_too_large' })
    return {
      path: relativePath,
      error: `File exceeds maximum size of ${MAX_FILE_SIZE_BYTES} bytes`,
      success: false,
    }
  }
  
  // 3. 构建 multipart body
  const boundary = `----FormBoundary${randomUUID()}`
  const filename = path.basename(relativePath)
  
  const bodyParts: Buffer[] = []
  
  // File part
  bodyParts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    ),
  )
  bodyParts.push(content)
  bodyParts.push(Buffer.from('\r\n'))
  
  // Purpose part
  bodyParts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="purpose"\r\n\r\n` +
        `user_data\r\n`,
    ),
  )
  
  // End boundary
  bodyParts.push(Buffer.from(`--${boundary}--\r\n`))
  
  const body = Buffer.concat(bodyParts)
  
  // 4. 重试循环
  try {
    return await retryWithBackoff(`Upload file ${relativePath}`, async () => {
      try {
        const response = await axios.post(url, body, {
          headers: {
            ...headers,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length.toString(),
          },
          timeout: 120000, // 2 分钟超时
          signal: opts?.signal,
          validateStatus: status => status < 500,
        })
        
        if (response.status === 200 || response.status === 201) {
          const fileId = response.data?.id
          if (!fileId) {
            return {
              done: false,
              error: 'Upload succeeded but no file ID returned',
            }
          }
          return {
            done: true,
            value: {
              path: relativePath,
              fileId,
              size: fileSize,
              success: true,
            },
          }
        }
        
        // 非重试错误
        if (response.status === 401) {
          throw new UploadNonRetriableError('Authentication failed')
        }
        if (response.status === 403) {
          throw new UploadNonRetriableError('Access denied for upload')
        }
        if (response.status === 413) {
          throw new UploadNonRetriableError('File too large for upload')
        }
        
        return { done: false, error: `status ${response.status}` }
      } catch (error) {
        if (error instanceof UploadNonRetriableError) {
          throw error
        }
        if (axios.isCancel(error)) {
          throw new UploadNonRetriableError('Upload canceled')
        }
        // 网络错误可重试
        if (axios.isAxiosError(error)) {
          return { done: false, error: error.message }
        }
        throw error
      }
    })
  } catch (error) {
    if (error instanceof UploadNonRetriableError) {
      return {
        path: relativePath,
        error: error.message,
        success: false,
      }
    }
    logEvent('tengu_file_upload_failed', { error_type: 'network' })
    return {
      path: relativePath,
      error: errorMessage(error),
      success: false,
    }
  }
}
```

---

## 文件列表

### 分页列表流程

```typescript
// src/services/api/filesApi.ts

export async function listFilesCreatedAfter(
  afterCreatedAt: string,
  config: FilesApiConfig,
): Promise<FileMetadata[]> {
  const baseUrl = config.baseUrl || getDefaultApiBaseUrl()
  const headers = {
    Authorization: `Bearer ${config.oauthToken}`,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': FILES_API_BETA_HEADER,
  }
  
  const allFiles: FileMetadata[] = []
  let afterId: string | undefined
  
  // 分页循环
  while (true) {
    const params: Record<string, string> = {
      after_created_at: afterCreatedAt,
    }
    if (afterId) {
      params.after_id = afterId
    }
    
    const page = await retryWithBackoff(
      `List files after ${afterCreatedAt}`,
      async () => {
        const response = await axios.get(`${baseUrl}/v1/files`, {
          headers,
          params,
          timeout: 60000,
          validateStatus: status => status < 500,
        })
        
        if (response.status === 200) {
          return { done: true, value: response.data }
        }
        
        // 错误处理
        if (response.status === 401) {
          throw new Error('Authentication failed')
        }
        if (response.status === 403) {
          throw new Error('Access denied to list files')
        }
        
        return { done: false, error: `status ${response.status}` }
      },
    )
    
    // 收集文件元数据
    const files = page.data || []
    for (const f of files) {
      allFiles.push({
        filename: f.filename,
        fileId: f.id,
        size: f.size_bytes,
      })
    }
    
    // 检查是否有更多页面
    if (!page.has_more) {
      break
    }
    
    // 使用最后一页的最后一个文件 ID 作为游标
    const lastFile = files.at(-1)
    if (!lastFile?.id) {
      break
    }
    afterId = lastFile.id
  }
  
  return allFiles
}
```

### 分页机制

```
┌─────────────────────────────────────────────────────────────────┐
│                    文件列表分页机制                               │
└─────────────────────────────────────────────────────────────────┘

第 1 页请求
│
├─► GET /v1/files?after_created_at=2024-01-01T00:00:00Z
│   └─► 响应：{ data: [...], has_more: true }
│
├─► 获取最后一页最后一个文件 ID
│   └─► afterId = lastFile.id
│
├─► 第 2 页请求
│   └─► GET /v1/files?after_created_at=...&after_id=file_xxx
│       └─► 响应：{ data: [...], has_more: true }
│
├─► 重复直到 has_more = false
│
└─► 返回所有文件元数据
```

---

## 并行处理

### 并行下载实现

```typescript
// 工作者模式并发控制
async function parallelWithLimit<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let currentIndex = 0
  
  // 工作者函数
  async function worker(): Promise<void> {
    while (currentIndex < items.length) {
      const index = currentIndex++
      const item = items[index]
      if (item !== undefined) {
        results[index] = await fn(item, index)
      }
    }
  }
  
  // 启动工作者
  const workers: Promise<void>[] = []
  const workerCount = Math.min(concurrency, items.length)
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker())
  }
  
  await Promise.all(workers)
  return results
}

// 批量下载
export async function downloadSessionFiles(
  files: File[],
  config: FilesApiConfig,
  concurrency: number = DEFAULT_CONCURRENCY,
): Promise<DownloadResult[]> {
  if (files.length === 0) {
    return []
  }
  
  logDebug(`Downloading ${files.length} file(s) for session ${config.sessionId}`)
  const startTime = Date.now()
  
  const results = await parallelWithLimit(
    files,
    file => downloadAndSaveFile(file, config),
    concurrency,
  )
  
  const elapsedMs = Date.now() - startTime
  const successCount = count(results, r => r.success)
  logDebug(`Downloaded ${successCount}/${files.length} file(s) in ${elapsedMs}ms`)
  
  return results
}
```

### 并行上传实现

```typescript
export async function uploadSessionFiles(
  files: Array<{ path: string; relativePath: string }>,
  config: FilesApiConfig,
  concurrency: number = DEFAULT_CONCURRENCY,
): Promise<UploadResult[]> {
  if (files.length === 0) {
    return []
  }
  
  logDebug(`Uploading ${files.length} file(s) for session ${config.sessionId}`)
  const startTime = Date.now()
  
  const results = await parallelWithLimit(
    files,
    file => uploadFile(file.path, file.relativePath, config),
    concurrency,
  )
  
  const elapsedMs = Date.now() - startTime
  const successCount = count(results, r => r.success)
  logDebug(`Uploaded ${successCount}/${files.length} file(s) in ${elapsedMs}ms`)
  
  return results
}
```

### 并发控制时序图

```
┌─────────────────────────────────────────────────────────────────┐
│                    并行处理时序图 (concurrency=3)                 │
└─────────────────────────────────────────────────────────────────┘

时间    Worker 1        Worker 2        Worker 3
│       │               │               │
├─► 文件 1              │               │
│       │───────┐       │               │
│       │       │       │               │
│       │←──────┘       │               │
│       │               │               │
├─► 文件 2              │               │
│       │───────┐       │               │
│       │       │       │               │
│       │       │←──────┘               │
│       │       │               │       │
├─► 文件 3      │               │       │
│       │       │───────┐     │       │
│       │       │       │←────┘       │
│       │       │               │       │
├─► 文件 4      │               │       │
│       │←──────┘       │       │       │
│       │               │       │       │
└─►     └─ 所有完成 ────┘       │       │
```

---

## 错误处理

### 下载错误分类

| 状态码 | 错误类型 | 是否重试 | 处理 |
|--------|----------|----------|------|
| 200 | 成功 | - | 返回 Buffer |
| 404 | 文件不存在 | ❌ | 抛出错误 |
| 401 | 认证失败 | ❌ | 抛出错误 |
| 403 | 访问拒绝 | ❌ | 抛出错误 |
| 5xx | 服务器错误 | ✅ | 重试 |
| 网络错误 | 连接错误 | ✅ | 重试 |

### 上传错误分类

| 状态码 | 错误类型 | 是否重试 | 处理 |
|--------|----------|----------|------|
| 200/201 | 成功 | - | 返回 fileId |
| 401 | 认证失败 | ❌ | UploadNonRetriableError |
| 403 | 访问拒绝 | ❌ | UploadNonRetriableError |
| 413 | 文件太大 | ❌ | UploadNonRetriableError |
| 5xx | 服务器错误 | ✅ | 重试 |
| 网络错误 | 连接错误 | ✅ | 重试 |
| 取消 | 用户取消 | ❌ | UploadNonRetriableError |

### 重试工具函数

```typescript
// 通用重试函数
async function retryWithBackoff<T>(
  operation: string,
  attemptFn: (attempt: number) => Promise<RetryResult<T>>,
): Promise<T> {
  let lastError = ''
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const result = await attemptFn(attempt)
    
    if (result.done) {
      return result.value
    }
    
    lastError = result.error || `${operation} failed`
    logDebug(`${operation} attempt ${attempt}/${MAX_RETRIES} failed: ${lastError}`)
    
    if (attempt < MAX_RETRIES) {
      // 指数退避
      const delayMs = BASE_DELAY_MS * Math.pow(2, attempt - 1)
      logDebug(`Retrying ${operation} in ${delayMs}ms...`)
      await sleep(delayMs)
    }
  }
  
  throw new Error(`${lastError} after ${MAX_RETRIES} attempts`)
}
```

---

## 事件跟踪

### 上传事件

```typescript
// 成功上传
logEvent('tengu_file_uploaded', {
  file_size: fileSize,
  file_extension: path.extname(relativePath),
})

// 上传失败
logEvent('tengu_file_upload_failed', {
  error_type: 'file_read' | 'file_too_large' | 'auth' | 'forbidden' | 'size' | 'network',
})
```

### 下载事件

```typescript
// 成功下载
logEvent('tengu_file_downloaded', {
  file_size: bytesWritten,
  download_duration_ms: elapsedMs,
})
```

---

## 相关文件

| 文件 | 描述 |
|------|------|
| `src/services/api/filesApi.ts` | Files API 核心实现 |
| `src/services/api/bootstrap.ts` | Bootstrap API |
| `src/utils/retry.ts` | 重试工具函数 |

---

*文档生成时间：2026-04-01*
