# 权限系统专项文档

## 概述

权限系统是 Claude Code 安全模型的核心，负责控制工具执行的访问权限。系统支持多种权限模式、规则匹配、分类器集成和路径验证。

---

## 目录

1. [权限模式](#权限模式)
2. [规则系统](#规则系统)
3. [路径验证](#路径验证)
4. [分类器集成](#分类器集成)
5. [拒绝跟踪](#拒绝跟踪)
6. [沙箱集成](#沙箱集成)

---

## 权限模式

### 模式定义

```typescript
type PermissionMode =
  | 'default'           // 默认模式，需要用户确认
  | 'plan'              // 计划模式，只读操作
  | 'auto'              // 自动模式，分类器决策（Ant 专用）
  | 'acceptEdits'       // 接受编辑模式
  | 'bypassPermissions' // 绕过权限（开发用）
  | 'dontAsk'           // 不询问，自动拒绝
  | 'bubble'            // 气泡模式
```

### 模式配置

```typescript
const PERMISSION_MODE_CONFIG = {
  default: {
    title: 'Default',
    shortTitle: 'Default',
    symbol: '',
    color: 'text',
    external: 'default',
  },
  plan: {
    title: 'Plan Mode',
    shortTitle: 'Plan',
    symbol: '⏸️',
    color: 'planMode',
    external: 'plan',
  },
  acceptEdits: {
    title: 'Accept edits',
    shortTitle: 'Accept',
    symbol: '⏵⏵',
    color: 'autoAccept',
    external: 'acceptEdits',
  },
  auto: {
    title: 'Auto mode',
    shortTitle: 'Auto',
    symbol: '⏵⏵',
    color: 'warning',
    external: 'default',
  },
  bypassPermissions: {
    title: 'Bypass Permissions',
    shortTitle: 'Bypass',
    symbol: '⏵⏵',
    color: 'error',
    external: 'bypassPermissions',
  },
  dontAsk: {
    title: "Don't Ask",
    shortTitle: 'DontAsk',
    symbol: '⏵⏵',
    color: 'error',
    external: 'dontAsk',
  },
}
```

### 模式决策流程

```
权限检查请求
    │
    ▼
检查当前模式
    │
    ├── plan 模式
    │   └── 只允许只读工具（FileRead、Glob、Grep 等）
    │
    ├── acceptEdits 模式
    │   └── 工作目录内写操作自动允许，外部需要审批
    │
    ├── auto 模式
    │   └── 分类器决策（见分类器集成）
    │
    ├── bypassPermissions 模式
    │   └── 所有操作自动允许
    │
    ├── dontAsk 模式
    │   └── 所有需要审批的操作自动拒绝
    │
    └── default 模式
        └── 标准规则匹配流程
```

---

## 规则系统

### 规则类型

```typescript
type PermissionRule = {
  source: PermissionRuleSource      // 规则来源
  ruleBehavior: PermissionBehavior  // 行为（allow/deny/ask）
  ruleValue: PermissionRuleValue    // 规则内容
}

type PermissionRuleSource =
  | 'managedFile'      // managed-settings.json
  | 'managedDropIns'   // managed-settings.d/*.json
  | 'global'           // ~/.claude/settings.json
  | 'project'          // .claude/settings.json
  | 'remoteManaged'    // 远程托管设置
  | 'mdmHkcu'          // HKCU MDM 策略
  | 'mdmHklm'          // HKLM MDM 策略
  | 'plugin'           // 插件设置
  | 'env'              // 环境变量
  | 'cli'              // CLI 参数
  | 'session'          // 会话级规则

type PermissionBehavior = 'allow' | 'deny' | 'ask'

type PermissionRuleValue = {
  toolName: string       // 工具名称
  ruleContent?: string   // 规则内容（如路径前缀）
}
```

### 规则格式

规则字符串格式：`ToolName(content)`

| 格式 | 示例 | 含义 |
|------|------|------|
| `ToolName` | `Bash` | 匹配整个工具 |
| `ToolName(prefix:*)` | `Bash(prefix:git)` | 匹配命令前缀 |
| `ToolName(path:/path)` | `FileRead(path:/etc)` | 匹配路径 |
| `mcp__server` | `mcp__filesystem` | 匹配 MCP 服务器 |
| `mcp__server__*` | `mcp__filesystem__*` | 匹配服务器所有工具 |
| `Agent(Explore)` | `Agent(Explore)` | 匹配特定 Agent 类型 |

### 规则匹配流程

```typescript
// 获取允许规则
function getAllowRules(context: ToolPermissionContext): PermissionRule[] {
  return PERMISSION_RULE_SOURCES.flatMap(source =>
    (context.alwaysAllowRules[source] || []).map(ruleString => ({
      source,
      ruleBehavior: 'allow',
      ruleValue: permissionRuleValueFromString(ruleString),
    }))
  )
}

// 获取拒绝规则
function getDenyRules(context: ToolPermissionContext): PermissionRule[] {
  return PERMISSION_RULE_SOURCES.flatMap(source =>
    (context.alwaysDenyRules[source] || []).map(ruleString => ({
      source,
      ruleBehavior: 'deny',
      ruleValue: permissionRuleValueFromString(ruleString),
    }))
  )
}

// 工具匹配规则
function toolMatchesRule(
  tool: { name: string, mcpInfo?: any },
  rule: PermissionRule
): boolean {
  // 规则必须没有内容才能匹配整个工具
  if (rule.ruleValue.ruleContent !== undefined) {
    return false
  }
  
  // MCP 工具使用完全限定名匹配
  const nameForRuleMatch = getToolNameForPermissionCheck(tool)
  
  // 直接工具名匹配
  if (rule.ruleValue.toolName === nameForRuleMatch) {
    return true
  }
  
  // MCP 服务器级匹配
  const ruleInfo = mcpInfoFromString(rule.ruleValue.toolName)
  const toolInfo = mcpInfoFromString(nameForRuleMatch)
  
  return (
    ruleInfo !== null &&
    toolInfo !== null &&
    (ruleInfo.toolName === undefined || ruleInfo.toolName === '*') &&
    ruleInfo.serverName === toolInfo.serverName
  )
}
```

### 规则优先级

```
1. 拒绝规则（最高优先级）
   └── 匹配则立即拒绝

2. 安全验证
   └── 路径安全检查（危险文件、配置目录等）

3. 工作目录检查
   └── 在工作目录内且 acceptEdits 模式 → 允许

4. 沙箱白名单检查
   └── 在沙箱写白名单内 → 允许

5. 允许规则
   └── 匹配则允许

6. 默认拒绝
```

---

## 路径验证

### 文件：`src/utils/permissions/pathValidation.ts`

#### 路径验证流程

```typescript
function validatePath(
  path: string,
  cwd: string,
  context: ToolPermissionContext,
  operationType: 'read' | 'write' | 'create'
): ResolvedPathCheckResult {
  // 1. 清理路径（移除引号、展开波浪号）
  const cleanPath = expandTilde(path.replace(/^['"]|['"]$/g, ''))
  
  // 2. 安全检查：UNC 路径
  if (containsVulnerableUncPath(cleanPath)) {
    return {
      allowed: false,
      decisionReason: {
        type: 'other',
        reason: 'UNC network paths require manual approval',
      },
    }
  }
  
  // 3. 安全检查：波浪号变体
  if (cleanPath.startsWith('~')) {
    return {
      allowed: false,
      decisionReason: {
        type: 'other',
        reason: 'Tilde expansion variants require manual approval',
      },
    }
  }
  
  // 4. 安全检查：Shell 展开语法
  if (
    cleanPath.includes('$') ||
    cleanPath.includes('%') ||
    cleanPath.startsWith('=')
  ) {
    return {
      allowed: false,
      decisionReason: {
        type: 'other',
        reason: 'Shell expansion syntax in paths requires manual approval',
      },
    }
  }
  
  // 5. Glob 模式处理
  if (GLOB_PATTERN_REGEX.test(cleanPath)) {
    if (operationType === 'write' || operationType === 'create') {
      return {
        allowed: false,
        decisionReason: {
          type: 'other',
          reason: 'Glob patterns not allowed in write operations',
        },
      }
    }
    // 读操作：验证基础目录
    return validateGlobPattern(cleanPath, cwd, context, operationType)
  }
  
  // 6. 解析路径
  const absolutePath = isAbsolute(cleanPath)
    ? cleanPath
    : resolve(cwd, cleanPath)
  const { resolvedPath, isCanonical } = safeResolvePath(
    getFsImplementation(),
    absolutePath
  )
  
  // 7. 权限检查
  const result = isPathAllowed(
    resolvedPath,
    context,
    operationType,
    isCanonical ? [resolvedPath] : undefined
  )
  
  return {
    allowed: result.allowed,
    resolvedPath,
    decisionReason: result.decisionReason,
  }
}
```

#### 路径允许性检查

```typescript
function isPathAllowed(
  resolvedPath: string,
  context: ToolPermissionContext,
  operationType: FileOperationType,
  precomputedPathsToCheck?: readonly string[]
): PathCheckResult {
  const permissionType = operationType === 'read' ? 'read' : 'edit'
  
  // 1. 检查拒绝规则（最高优先级）
  const denyRule = matchingRuleForInput(resolvedPath, context, permissionType, 'deny')
  if (denyRule !== null) {
    return {
      allowed: false,
      decisionReason: { type: 'rule', rule: denyRule },
    }
  }
  
  // 2. 内部可编辑路径检查（.claude 目录下的特定路径）
  if (operationType !== 'read') {
    const internalEditResult = checkEditableInternalPath(resolvedPath, {})
    if (internalEditResult.behavior === 'allow') {
      return {
        allowed: true,
        decisionReason: internalEditResult.decisionReason,
      }
    }
  }
  
  // 3. 路径安全检查（Windows 模式、配置文件、危险文件）
  if (operationType !== 'read') {
    const safetyCheck = checkPathSafetyForAutoEdit(resolvedPath, precomputedPathsToCheck)
    if (!safetyCheck.safe) {
      return {
        allowed: false,
        decisionReason: {
          type: 'safetyCheck',
          reason: safetyCheck.message,
          classifierApprovable: safetyCheck.classifierApprovable,
        },
      }
    }
  }
  
  // 4. 工作目录检查
  const isInWorkingDir = pathInAllowedWorkingPath(
    resolvedPath,
    context,
    precomputedPathsToCheck
  )
  if (isInWorkingDir) {
    if (operationType === 'read' || context.mode === 'acceptEdits') {
      return { allowed: true }
    }
  }
  
  // 5. 内部可读路径检查（读操作）
  if (operationType === 'read') {
    const internalReadResult = checkReadableInternalPath(resolvedPath, {})
    if (internalReadResult.behavior === 'allow') {
      return {
        allowed: true,
        decisionReason: internalReadResult.decisionReason,
      }
    }
  }
  
  // 6. 沙箱白名单检查
  if (
    operationType !== 'read' &&
    !isInWorkingDir &&
    isPathInSandboxWriteAllowlist(resolvedPath)
  ) {
    return {
      allowed: true,
      decisionReason: {
        type: 'other',
        reason: 'Path is in sandbox write allowlist',
      },
    }
  }
  
  // 7. 允许规则检查
  const allowRule = matchingRuleForInput(resolvedPath, context, permissionType, 'allow')
  if (allowRule !== null) {
    return {
      allowed: true,
      decisionReason: { type: 'rule', rule: allowRule },
    }
  }
  
  // 8. 默认拒绝
  return { allowed: false }
}
```

#### 危险删除路径检测

```typescript
function isDangerousRemovalPath(resolvedPath: string): boolean {
  const forwardSlashed = resolvedPath.replace(/[\\/]+/g, '/')
  
  // 通配符删除
  if (forwardSlashed === '*' || forwardSlashed.endsWith('/*')) {
    return true
  }
  
  const normalizedPath = forwardSlashed === '/'
    ? forwardSlashed
    : forwardSlashed.replace(/\/$/, '')
  
  // 根目录
  if (normalizedPath === '/') {
    return true
  }
  
  // Windows 驱动器根目录
  if (/^[A-Za-z]:\/?$/.test(normalizedPath)) {
    return true
  }
  
  // 家目录
  const normalizedHome = homedir().replace(/[\\/]+/g, '/')
  if (normalizedPath === normalizedHome) {
    return true
  }
  
  // 根目录直接子目录（/usr, /tmp, /etc 等）
  const parentDir = dirname(normalizedPath)
  if (parentDir === '/') {
    return true
  }
  
  // Windows 驱动器直接子目录（C:\Windows, C:\Users 等）
  if (/^[A-Za-z]:\/[^/]+$/.test(normalizedPath)) {
    return true
  }
  
  return false
}
```

---

## 分类器集成

### 文件：`src/utils/permissions/classifierDecision.ts`

#### 自动模式工具白名单

```typescript
const SAFE_YOLO_ALLOWLISTED_TOOLS = new Set([
  // 只读文件操作
  'FileReadTool',
  // 搜索/只读
  'GrepTool',
  'GlobTool',
  'LSPTool',
  'ToolSearchTool',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  // 任务管理（仅元数据）
  'TodoWriteTool',
  'TaskCreateTool',
  'TaskGetTool',
  'TaskUpdateTool',
  'TaskListTool',
  'TaskStopTool',
  'TaskOutputTool',
  // 计划模式/UI
  'AskUserQuestionTool',
  'EnterPlanModeTool',
  'ExitPlanModeV2Tool',
  // Swarm 协调
  'TeamCreateTool',
  'TeamDeleteTool',
  'SendMessageTool',
  // 工作流编排
  'WorkflowTool',
  // 其他安全工具
  'SleepTool',
  // 内部工具
  'YOLO_CLASSIFIER',
])

function isAutoModeAllowlistedTool(toolName: string): boolean {
  return SAFE_YOLO_ALLOWLISTED_TOOLS.has(toolName)
}
```

#### 分类器决策流程

```
工具调用请求
    │
    ▼
检查是否为自动模式
    │
    ├── 否 → 标准权限检查
    │
    └── 是 → 检查工具白名单
            │
            ├── 在白名单内 → 自动允许
            │
            └── 不在白名单 → 调用分类器
                            │
                            ├── 格式化动作用于分类
                            │   formatActionForClassifier()
                            │
                            ├── 调用分类器 API
                            │   classifyYoloAction()
                            │
                            └── 返回决策
                                ├── allow → 允许执行
                                ├── ask → 询问用户
                                └── deny → 拒绝
```

---

## 拒绝跟踪

### 文件：`src/utils/permissions/denialTracking.ts`

#### 状态定义

```typescript
type DenialTrackingState = {
  consecutiveDenials: number  // 连续拒绝次数
  totalDenials: number        // 总拒绝次数
}

const DENIAL_LIMITS = {
  maxConsecutive: 3,   // 最大连续拒绝
  maxTotal: 20,        // 最大总拒绝
} as const
```

#### 状态转换

```typescript
// 记录拒绝
function recordDenial(state: DenialTrackingState): DenialTrackingState {
  return {
    ...state,
    consecutiveDenials: state.consecutiveDenials + 1,
    totalDenials: state.totalDenials + 1,
  }
}

// 记录成功
function recordSuccess(state: DenialTrackingState): DenialTrackingState {
  if (state.consecutiveDenials === 0) return state  // 无需变化
  return {
    ...state,
    consecutiveDenials: 0,  // 重置连续计数
  }
}

// 是否回退到提示模式
function shouldFallbackToPrompting(state: DenialTrackingState): boolean {
  return (
    state.consecutiveDenials >= DENIAL_LIMITS.maxConsecutive ||
    state.totalDenials >= DENIAL_LIMITS.maxTotal
  )
}
```

#### 状态机

```
初始状态：{ consecutiveDenials: 0, totalDenials: 0 }
    │
    ├── 拒绝 → { consecutiveDenials: 1, totalDenials: 1 }
    │           │
    │           ├── 拒绝 → { consecutiveDenials: 2, totalDenials: 2 }
    │           │           │
    │           │           ├── 拒绝 → { consecutiveDenials: 3, totalDenials: 3 }
    │           │           │           │
    │           │           │           └── 触发回退（连续限制）
    │           │           │
    │           │           └── 成功 → { consecutiveDenials: 0, totalDenials: 2 }
    │           │
    │           └── 成功 → { consecutiveDenials: 0, totalDenials: 1 }
    │
    └── 成功 → 状态不变
```

---

## 沙箱集成

### 文件：`src/utils/permissions/pathValidation.ts`

#### 沙箱写白名单检查

```typescript
function isPathInSandboxWriteAllowlist(resolvedPath: string): boolean {
  if (!SandboxManager.isSandboxingEnabled()) {
    return false
  }
  
  const { allowOnly, denyWithinAllow } = SandboxManager.getFsWriteConfig()
  
  // 解析白名单和黑名单路径（处理符号链接）
  const resolvedAllow = allowOnly.flatMap(getResolvedSandboxConfigPath)
  const resolvedDeny = denyWithinAllow.flatMap(getResolvedSandboxConfigPath)
  
  // 检查所有路径表示
  const pathsToCheck = getPathsForPermissionCheck(resolvedPath)
  
  return pathsToCheck.every(p => {
    // 首先检查黑名单
    for (const denyPath of resolvedDeny) {
      if (pathInWorkingPath(p, denyPath)) return false
    }
    // 然后检查白名单
    return resolvedAllow.some(allowPath => pathInWorkingPath(p, allowPath))
  })
}
```

#### 沙箱配置

```typescript
// 沙箱文件系统配置
type SandboxFsConfig = {
  allowOnly: string[]      // 允许的目录列表
  denyWithinAllow: string[] // 在白名单内的拒绝路径
}

// 示例配置
const defaultConfig: SandboxFsConfig = {
  allowOnly: [
    '.',                          // 当前工作目录
    '/tmp/claude',                // 临时目录
  ],
  denyWithinAllow: [
    '.claude/settings.json',      // 配置文件
    '.claude/credentials',        // 凭据目录
  ],
}
```

---

## 权限检查完整流程

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           权限检查完整流程                                   │
└─────────────────────────────────────────────────────────────────────────────┘

工具调用请求 (tool, input, context)
    │
    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 步骤 1: 模式检查                                                             │
│                                                                              │
│   ├── plan 模式 → 只允许只读工具                                              │
│   ├── bypassPermissions → 自动允许                                           │
│   ├── dontAsk → 自动拒绝                                                     │
│   └── auto → 分类器决策                                                      │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 步骤 2: 规则匹配                                                             │
│                                                                              │
│   ├── 拒绝规则匹配 → 立即拒绝                                                │
│   ├── 允许规则匹配 → 继续检查                                                │
│   └── 无规则匹配 → 默认行为                                                  │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 步骤 3: 路径验证（文件操作）                                                  │
│                                                                              │
│   ├── 安全检查                                                               │
│   │   ├── UNC 路径检查                                                       │
│   │   ├── 波浪号变体检查                                                     │
│   │   ├── Shell 展开语法检查                                                 │
│   │   └── Glob 模式检查                                                      │
│   │                                                                          │
│   ├── 路径解析                                                               │
│   │   ├── 展开波浪号                                                         │
│   │   ├── 转换为绝对路径                                                     │
│   │   └── 解析符号链接                                                       │
│   │                                                                          │
│   ├── 内部路径检查                                                           │
│   │   ├── 可编辑内部路径（.claude 下特定目录）                               │
│   │   └── 可读内部路径（临时目录、会话内存）                                 │
│   │                                                                          │
│   ├── 安全检查                                                               │
│   │   ├── Windows 危险模式                                                   │
│   │   ├── 配置文件保护                                                       │
│   │   └── 危险文件检测                                                       │
│   │                                                                          │
│   ├── 工作目录检查                                                           │
│   │   └── acceptEdits 模式 + 工作目录内 → 允许                               │
│   │                                                                          │
│   └── 沙箱白名单检查                                                         │
│       └── 在沙箱写白名单内 → 允许                                            │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 步骤 4: Hook 检查                                                            │
│                                                                              │
│   └── executePermissionRequestHooks()                                        │
│       └── 自定义 Hook 可以修改决策                                           │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 步骤 5: 分类器检查（自动模式）                                                │
│                                                                              │
│   ├── 工具在白名单内 → 自动允许                                              │
│   ├── 调用分类器 API                                                         │
│   │   ├── 格式化动作                                                         │
│   │   ├── 发送分类请求                                                       │
│   │   └── 解析响应                                                           │
│   └── 返回决策                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 步骤 6: 拒绝跟踪                                                             │
│                                                                              │
│   ├── 记录拒绝 → 更新计数                                                    │
│   ├── 检查限制                                                               │
│   │   ├── 连续拒绝 >= 3 → 回退到提示模式                                     │
│   │   └── 总拒绝 >= 20 → 回退到提示模式                                      │
│   └── 记录成功 → 重置连续计数                                                │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    ▼
返回 PermissionResult {
  allowed: boolean
  decisionReason?: PermissionDecisionReason
}
```

---

## 决策原因类型

```typescript
type PermissionDecisionReason =
  | { type: 'rule', rule: PermissionRule }           // 规则匹配
  | { type: 'hook', hookName: string, reason?: string }  // Hook 拦截
  | { type: 'mode', mode: PermissionMode }           // 模式限制
  | { type: 'workingDir', reason: string }           // 工作目录限制
  | { type: 'safetyCheck', reason: string, classifierApprovable?: boolean }  // 安全检查
  | { type: 'sandboxOverride' }                      // 沙箱覆盖
  | { type: 'classifier', classifier: string, reason: string }  // 分类器决策
  | { type: 'permissionPromptTool', permissionPromptToolName: string }  // 权限提示工具
  | { type: 'asyncAgent', reason: string }           // 异步 Agent
  | { type: 'subcommandResults', reasons: Map<string, { behavior: string }> }  // 子命令结果
  | { type: 'other', reason: string }                // 其他原因
```

---

## 相关文件

| 文件 | 描述 |
|------|------|
| `src/utils/permissions/permissions.ts` | 权限检查核心逻辑 |
| `src/utils/permissions/PermissionRule.ts` | 规则类型定义 |
| `src/utils/permissions/PermissionMode.ts` | 模式配置 |
| `src/utils/permissions/PermissionResult.ts` | 结果类型 |
| `src/utils/permissions/pathValidation.ts` | 路径验证 |
| `src/utils/permissions/filesystem.ts` | 文件系统权限 |
| `src/utils/permissions/classifierDecision.ts` | 分类器决策 |
| `src/utils/permissions/denialTracking.ts` | 拒绝跟踪 |

---

*文档生成时间：2026-04-01*
