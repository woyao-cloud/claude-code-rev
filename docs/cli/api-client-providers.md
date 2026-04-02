# API 客户端与提供商管理

## 概述

本文档详细介绍 CLI 传输层的 API 客户端创建机制和多提供商支持架构。Claude Code 支持四种 API 提供商：直连 Anthropic API、AWS Bedrock、GCP Vertex AI 和 Azure Foundry。

---

## 目录

1. [提供商架构](#提供商架构)
2. [客户端创建流程](#客户端创建流程)
3. [认证机制](#认证机制)
4. [请求头管理](#请求头管理)
5. [环境变量配置](#环境变量配置)

---

## 提供商架构

### 支持的提供商

| 提供商 | SDK | 认证方式 | 适用场景 |
|--------|-----|----------|----------|
| **直连 Anthropic** | `@anthropic-ai/sdk` | API Key / OAuth | 标准用户、ClaudeAI 订阅 |
| **AWS Bedrock** | `@anthropic-ai/bedrock-sdk` | AWS 凭证 | AWS 企业用户、VPC 部署 |
| **GCP Vertex AI** | `@anthropic-ai/vertex-sdk` | GCP 凭证 | GCP 企业用户、Google Cloud 集成 |
| **Azure Foundry** | `@anthropic-ai/foundry-sdk` | Azure AD / API Key | Azure 企业用户、Microsoft 集成 |

### 提供商选择逻辑

```typescript
// src/services/api/client.ts

// 1. 检查 Bedrock
if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) {
  const { AnthropicBedrock } = await import('@anthropic-ai/bedrock-sdk')
  return new AnthropicBedrock(bedrockArgs)
}

// 2. 检查 Foundry
if (isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)) {
  const { AnthropicFoundry } = await import('@anthropic-ai/foundry-sdk')
  return new AnthropicFoundry(foundryArgs)
}

// 3. 检查 Vertex
if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) {
  const { AnthropicVertex } = await import('@anthropic-ai/vertex-sdk')
  return new AnthropicVertex(vertexArgs)
}

// 4. 默认：直连 Anthropic API
return new Anthropic(clientConfig)
```

---

## 客户端创建流程

### 完整创建流程

```
┌─────────────────────────────────────────────────────────────────┐
│                    API 客户端创建完整流程                         │
└─────────────────────────────────────────────────────────────────┘

getAnthropicClient({ apiKey, maxRetries, model, source })
│
├─► 1. 收集客户端元数据
│   ├── CLAUDE_CODE_CONTAINER_ID (容器 ID)
│   ├── CLAUDE_CODE_REMOTE_SESSION_ID (远程会话 ID)
│   ├── CLAUDE_AGENT_SDK_CLIENT_APP (SDK 客户端应用)
│   └── 自定义请求头 (ANTHROPIC_CUSTOM_HEADERS)
│
├─► 2. 构建默认请求头
│   ├── 'x-app': 'cli'
│   ├── 'User-Agent': getClaudeCodeUserAgent()
│   ├── 'X-Claude-Code-Session-Id': getSessionId()
│   ├── 'x-claude-remote-container-id': containerId
│   ├── 'x-claude-remote-session-id': remoteSessionId
│   ├── 'x-client-app': clientApp
│   ├── 'x-anthropic-additional-protection': 'true' (可选)
│   └── 自定义请求头 (ANTHROPIC_CUSTOM_HEADERS)
│
├─► 3. OAuth 令牌检查和刷新
│   └─► checkAndRefreshOAuthTokenIfNeeded()
│       ├── 检查令牌是否存在
│       ├── 检查令牌是否过期
│       └── 如过期则刷新
│
├─► 4. 配置 API Key (非 ClaudeAI 订阅用户)
│   └─► configureApiKeyHeaders()
│       ├── 检查 ANTHROPIC_AUTH_TOKEN
│       └── 检查 apiKeyHelper
│
├─► 5. 构建 fetch 包装器
│   └─► buildFetch()
│       ├── 注入 Client Request ID (UUID)
│       ├── 记录请求日志
│       └── 应用代理设置
│
├─► 6. 根据环境变量选择提供商
│   │
│   ├─► Bedrock (CLAUDE_CODE_USE_BEDROCK)
│   │   ├── 获取 AWS 区域 (getAWSRegion())
│   │   ├── 检查小模型区域覆盖 (ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION)
│   │   ├── 获取 AWS 凭证 (可跳过)
│   │   │   ├── 检查 AWS_BEARER_TOKEN_BEDROCK (API Key 认证)
│   │   │   └─► 刷新凭证 (refreshAndGetAwsCredentials())
│   │   │       ├── accessKeyId
│   │   │       ├── secretAccessKey
│   │   │       └── sessionToken
│   │   └── 创建 AnthropicBedrock 实例
│   │
│   ├─► Foundry (CLAUDE_CODE_USE_FOUNDRY)
│   │   ├── 检查 ANTHROPIC_FOUNDRY_API_KEY
│   │   ├── 创建 Azure AD Token Provider (无 API Key 时)
│   │   │   └─► DefaultAzureCredential + getBearerTokenProvider()
│   │   └── 创建 AnthropicFoundry 实例
│   │
│   ├─► Vertex (CLAUDE_CODE_USE_VERTEX)
│   │   ├── 刷新 GCP 凭证 (可跳过)
│   │   ├── 创建 GoogleAuth
│   │   │   ├── scopes: ['https://www.googleapis.com/auth/cloud-platform']
│   │   │   └── projectId (后备值：ANTHROPIC_VERTEX_PROJECT_ID)
│   │   ├── 获取区域 (getVertexRegionForModel())
│   │   │   ├── VERTEX_REGION_CLAUDE_3_5_HAIKU
│   │   │   ├── VERTEX_REGION_CLAUDE_HAIKU_4_5
│   │   │   ├── VERTEX_REGION_CLAUDE_3_5_SONNET
│   │   │   ├── VERTEX_REGION_CLAUDE_3_7_SONNET
│   │   │   ├── CLOUD_ML_REGION (默认)
│   │   │   └── us-east5 (后备)
│   │   └── 创建 AnthropicVertex 实例
│   │
│   └─► 直连 (默认)
│       ├── apiKey: getAnthropicApiKey() 或 null (ClaudeAI 订阅)
│       ├── authToken: getClaudeAIOAuthTokens()?.accessToken
│       └── 创建 Anthropic 实例
│
└─► 7. 返回客户端实例
```

### 客户端参数

```typescript
// 通用参数 (所有提供商)
const COMMON_ARGS = {
  defaultHeaders,
  maxRetries,
  timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
  dangerouslyAllowBrowser: true,
  fetchOptions: getProxyFetchOptions({ forAnthropicAPI: true }),
  fetch: resolvedFetch,
}

// Bedrock 特有参数
const BEDROCK_ARGS = {
  ...COMMON_ARGS,
  awsRegion: getAWSRegion(),
  skipAuth: isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH),
  awsAccessKey: credentials?.accessKeyId,
  awsSecretKey: credentials?.secretAccessKey,
  awsSessionToken: credentials?.sessionToken,
}

// Vertex 特有参数
const VERTEX_ARGS = {
  ...COMMON_ARGS,
  region: getVertexRegionForModel(model),
  googleAuth,
}

// Foundry 特有参数
const FOUNDRY_ARGS = {
  ...COMMON_ARGS,
  azureADTokenProvider,
}
```

---

## 认证机制

### 直连 Anthropic 认证

**认证方式**: API Key 或 OAuth

```typescript
// OAuth 令牌检查
await checkAndRefreshOAuthTokenIfNeeded()

// API Key 配置
const clientConfig = {
  apiKey: isClaudeAISubscriber() ? null : apiKey || getAnthropicApiKey(),
  authToken: isClaudeAISubscriber()
    ? getClaudeAIOAuthTokens()?.accessToken
    : undefined,
  // OAuth  staging 配置
  ...(process.env.USER_TYPE === 'ant' &&
  isEnvTruthy(process.env.USE_STAGING_OAUTH)
    ? { baseURL: getOauthConfig().BASE_API_URL }
    : {}),
}
```

**API Key 来源优先级**:

```
1. 传入的 apiKey 参数
2. ANTHROPIC_API_KEY 环境变量
3. apiKeyHelper (安全存储)
4. ~/.claude/ 目录中的登录凭证
```

### AWS Bedrock 认证

**认证方式**: AWS 凭证

```typescript
// 凭证来源
1. AWS_BEARER_TOKEN_BEDROCK (API Key 认证)
2. AWS 默认凭证链 (SDK defaults)
   - 环境变量 (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
   - 凭证文件 (~/.aws/credentials)
   - EC2 实例元数据
   - ECS 任务角色
   - IAM 角色
```

**凭证刷新**:

```typescript
// 刷新 AWS 凭证
const cachedCredentials = await refreshAndGetAwsCredentials()
if (cachedCredentials) {
  bedrockArgs.awsAccessKey = cachedCredentials.accessKeyId
  bedrockArgs.awsSecretKey = cachedCredentials.secretAccessKey
  bedrockArgs.awsSessionToken = cachedCredentials.sessionToken
}
```

### GCP Vertex AI 认证

**认证方式**: GCP 凭证 (google-auth-library)

```typescript
const googleAuth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  // 防止元数据服务器超时的后备 projectId
  ...(hasProjectEnvVar || hasKeyFile
    ? {}
    : { projectId: process.env.ANTHROPIC_VERTEX_PROJECT_ID }),
})
```

**凭证来源**:

```
1. 环境变量 (GOOGLE_APPLICATION_CREDENTIALS)
2. 凭证文件 (service account JSON, ADC file)
3. gcloud 配置
4. GCE 元数据服务器 (GCP 环境)
```

### Azure Foundry 认证

**认证方式**: Azure AD 或 API Key

```typescript
// API Key 认证 (如果提供)
if (process.env.ANTHROPIC_FOUNDRY_API_KEY) {
  // SDK 自动使用
}

// Azure AD 认证 (无 API Key 时)
if (!process.env.ANTHROPIC_FOUNDRY_API_KEY) {
  const { DefaultAzureCredential, getBearerTokenProvider } = 
    await import('@azure/identity')
  
  azureADTokenProvider = getBearerTokenProvider(
    new DefaultAzureCredential(),
    'https://cognitiveservices.azure.com/.default',
  )
}
```

---

## 请求头管理

### 默认请求头

```typescript
const defaultHeaders = {
  'x-app': 'cli',
  'User-Agent': getUserAgent(),
  'X-Claude-Code-Session-Id': getSessionId(),
  
  // 远程会话
  ...(containerId 
    ? { 'x-claude-remote-container-id': containerId } 
    : {}),
  ...(remoteSessionId 
    ? { 'x-claude-remote-session-id': remoteSessionId } 
    : {}),
  
  // SDK 客户端应用标识
  ...(clientApp 
    ? { 'x-client-app': clientApp } 
    : {}),
  
  // 额外保护 (可选)
  ...(isEnvTruthy(process.env.CLAUDE_CODE_ADDITIONAL_PROTECTION)
    ? { 'x-anthropic-additional-protection': 'true' }
    : {}),
}
```

### 自定义请求头

```typescript
// 从环境变量解析自定义请求头
// 格式：每行一个请求头，"Name: Value"
function getCustomHeaders(): Record<string, string> {
  const customHeaders: Record<string, string> = {}
  const customHeadersEnv = process.env.ANTHROPIC_CUSTOM_HEADERS

  if (!customHeadersEnv) return customHeaders

  // 按换行符分割
  const headerStrings = customHeadersEnv.split(/\n|\r\n/)

  for (const headerString of headerStrings) {
    if (!headerString.trim()) continue

    // 解析 "Name: Value" 格式
    const colonIdx = headerString.indexOf(':')
    if (colonIdx === -1) continue
    
    const name = headerString.slice(0, colonIdx).trim()
    const value = headerString.slice(colonIdx + 1).trim()
    
    if (name) {
      customHeaders[name] = value
    }
  }

  return customHeaders
}
```

### Client Request ID

```typescript
// 为每个请求生成唯一的 Client Request ID
// 用于在超时情况下关联服务器日志
const CLIENT_REQUEST_ID_HEADER = 'x-client-request-id'

function buildFetch(fetchOverride, source) {
  const inner = fetchOverride ?? globalThis.fetch
  
  return (input, init) => {
    const headers = new Headers(init?.headers)
    
    // 仅为第一方 API 注入请求 ID
    if (injectClientRequestId && !headers.has(CLIENT_REQUEST_ID_HEADER)) {
      headers.set(CLIENT_REQUEST_ID_HEADER, randomUUID())
    }
    
    // 记录请求日志
    const id = headers.get(CLIENT_REQUEST_ID_HEADER)
    logForDebugging(
      `[API REQUEST] ${new URL(url).pathname}${id ? ` ${CLIENT_REQUEST_ID_HEADER}=${id}` : ''} source=${source ?? 'unknown'}`,
    )
    
    return inner(input, { ...init, headers })
  }
}
```

---

## 环境变量配置

### 提供商选择

| 环境变量 | 值 | 效果 |
|----------|-----|------|
| `CLAUDE_CODE_USE_BEDROCK` | `1` / `true` | 使用 AWS Bedrock |
| `CLAUDE_CODE_USE_VERTEX` | `1` / `true` | 使用 GCP Vertex AI |
| `CLAUDE_CODE_USE_FOUNDRY` | `1` / `true` | 使用 Azure Foundry |

### AWS Bedrock 配置

| 环境变量 | 描述 |
|----------|------|
| `AWS_REGION` | AWS 区域 (默认：us-east-1) |
| `AWS_DEFAULT_REGION` | AWS 默认区域 |
| `ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION` | 小模型区域覆盖 |
| `AWS_BEARER_TOKEN_BEDROCK` | API Key 认证令牌 |
| `CLAUDE_CODE_SKIP_BEDROCK_AUTH` | 跳过认证 (测试用) |

### GCP Vertex AI 配置

| 环境变量 | 描述 |
|----------|------|
| `VERTEX_REGION_CLAUDE_3_5_HAIKU` | Claude 3.5 Haiku 区域 |
| `VERTEX_REGION_CLAUDE_HAIKU_4_5` | Claude Haiku 4.5 区域 |
| `VERTEX_REGION_CLAUDE_3_5_SONNET` | Claude 3.5 Sonnet 区域 |
| `VERTEX_REGION_CLAUDE_3_7_SONNET` | Claude 3.7 Sonnet 区域 |
| `CLOUD_ML_REGION` | 默认 GCP 区域 |
| `ANTHROPIC_VERTEX_PROJECT_ID` | GCP 项目 ID (必需) |
| `GOOGLE_APPLICATION_CREDENTIALS` | GCP 凭证文件路径 |
| `CLAUDE_CODE_SKIP_VERTEX_AUTH` | 跳过认证 (测试用) |

### Azure Foundry 配置

| 环境变量 | 描述 |
|----------|------|
| `ANTHROPIC_FOUNDRY_RESOURCE` | Azure 资源名称 |
| `ANTHROPIC_FOUNDRY_BASE_URL` | 完整基础 URL (可选) |
| `ANTHROPIC_FOUNDRY_API_KEY` | Foundry API Key |
| `CLAUDE_CODE_SKIP_FOUNDRY_AUTH` | 跳过认证 (测试用) |

### 通用配置

| 环境变量 | 描述 |
|----------|------|
| `ANTHROPIC_CUSTOM_HEADERS` | 自定义请求头 (每行一个) |
| `API_TIMEOUT_MS` | API 超时时间 (默认：600000ms) |
| `CLAUDE_CODE_ADDITIONAL_PROTECTION` | 启用额外保护 |
| `CLAUDE_CODE_CONTAINER_ID` | 容器 ID (远程会话) |
| `CLAUDE_CODE_REMOTE_SESSION_ID` | 远程会话 ID |

---

## 相关文件

| 文件 | 描述 |
|------|------|
| `src/services/api/client.ts` | API 客户端创建核心逻辑 |
| `src/utils/auth.ts` | 认证和令牌管理 |
| `src/utils/model/providers.ts` | API 提供商管理 |
| `src/utils/http.js` | HTTP 工具函数 |
| `src/utils/userAgent.ts` | User-Agent 生成 |

---

*文档生成时间：2026-04-01*
