# 工具函数层架构总览

## 概述

工具函数层（Utils Layer）是 Yao Code 架构中的基础设施层，位于服务层之下，为整个应用提供通用的工具函数和基础能力。

---

## 目录

1. [层级定位](#层级定位)
2. [模块分类](#模块分类)
3. [设计原则](#设计原则)
4. [核心抽象接口](#核心抽象接口)
5. [模块依赖关系](#模块依赖关系)

---

## 层级定位

```
┌─────────────────────────────────────────────────────────────┐
│                      应用层 (App Layer)                      │
│                   CLI、REPL、UI Components                   │
├─────────────────────────────────────────────────────────────┤
│                      服务层 (Services)                       │
│         API、MCP、LSP、Compact、Plugins、Analytics           │
├─────────────────────────────────────────────────────────────┤
│                    工具函数层 (Utils) ← 本文档               │
│    认证、配置、权限、Git、文件系统、Bash 解析、模型管理        │
├─────────────────────────────────────────────────────────────┤
│                    基础设施 (Infrastructure)                 │
│                  Node.js/Bun Runtime、OS API                 │
└─────────────────────────────────────────────────────────────┘
```

**职责范围**：
- 提供跨模块的通用工具函数
- 封装底层基础设施（文件系统、Git、网络）
- 实现核心业务逻辑（认证、权限、配置）
- 为服务层提供可复用的能力单元

---

## 模块分类

### 1. 认证与配置模块

**核心文件**：`auth.ts`, `config.ts`, `env.ts`

| 模块 | 职责 | 关键函数 |
|------|------|----------|
| `auth.ts` | API 密钥管理、OAuth 认证、令牌刷新 | `getAnthropicApiKey()`, `getAuthTokenSource()`, `isAnthropicAuthEnabled()` |
| `config.ts` | 全局配置和项目配置加载 | `getGlobalConfig()`, `getProjectConfig()`, `parseSettingsFile()` |
| `env.ts` | 环境变量检测、平台识别 | `env` 对象、`detectTerminal()`, `detectDeploymentEnvironment()` |

**认证流程**：
```
用户请求 API
    │
    ▼
getAuthTokenSource() ──┬── 检查 --bare 模式
                       ├── 检查 ANTHROPIC_AUTH_TOKEN
                       ├── 检查 CLAUDE_CODE_OAUTH_TOKEN
                       ├── 检查 OAuth FD 令牌
                       ├── 检查 apiKeyHelper
                       └── 检查 Yao AI OAuth
    │
    ▼
getAnthropicApiKeyWithSource() ──┬── 检查 ANTHROPIC_API_KEY
                                 ├── 检查 apiKeyHelper
                                 ├── 检查 /login 管理密钥
                                 └── 检查安全存储
    │
    ▼
返回 { key, source }
```

---

### 2. 权限系统模块

**目录**：`src/utils/permissions/`

| 文件 | 职责 |
|------|------|
| `permissions.ts` | 权限检查核心逻辑、规则匹配 |
| `PermissionRule.ts` | 权限规则类型定义和 Schema |
| `PermissionMode.ts` | 权限模式配置（default/plan/auto/bypass） |
| `PermissionResult.ts` | 权限决策结果类型 |
| `PermissionUpdate.ts` | 权限更新持久化 |
| `bashClassifier.ts` | Bash 命令分类器 |
| `yoloClassifier.ts` | YOLO 模式分类器 |
| `pathValidation.ts` | 路径验证逻辑 |
| `filesystem.ts` | 文件系统权限检查 |
| `denialTracking.ts` | 拒绝跟踪和降级策略 |

**权限模式**：
| 模式 | 描述 | 符号 |
|------|------|------|
| `default` | 默认模式，需要用户确认 | - |
| `plan` | 计划模式，只读操作 | ⏸️ |
| `auto` | 自动模式，分类器决策 | ⏵⏵ |
| `bypassPermissions` | 绕过权限（开发用） | ⏵⏵ |
| `dontAsk` | 不询问，自动拒绝 | ⏵⏵ |

**权限检查流程**：
```
工具调用请求
    │
    ▼
checkPermissions()
    │
    ├── 1. 获取权限规则
    │   ├── getAllowRules() - 允许规则
    │   └── getDenyRules() - 拒绝规则
    │
    ├── 2. 匹配规则
    │   ├── 工具名匹配
    │   ├── 路径匹配（如有）
    │   └── 命令内容匹配（Bash）
    │
    ├── 3. 分类器检查（如启用）
    │   ├── bashClassifier
    │   └── yoloClassifier
    │
    ├── 4. Hook 检查
    │   └── executePermissionRequestHooks()
    │
    └── 5. 返回决策
        ├── allow - 允许执行
        ├── deny - 拒绝执行
        └── ask - 询问用户
```

---

### 3. 设置系统模块

**目录**：`src/utils/settings/`

| 文件 | 职责 |
|------|------|
| `settings.ts` | 设置加载、合并、缓存 |
| `types.ts` | 设置类型定义和 Zod Schema |
| `validation.ts` | 设置验证和错误处理 |
| `constants.ts` | 设置源常量定义 |
| `settingsCache.ts` | 设置缓存管理 |
| `mdm/settings.ts` | MDM 策略设置读取 |
| `managedPath.ts` | 托管设置路径管理 |
| `pluginOnlyPolicy.ts` | 插件专用策略 |

**设置源优先级**（从低到高）：
```
1. managed-settings.json (文件)
2. managed-settings.d/*.json (drop-in 文件)
3. 全局配置 (~/.claude/settings.json)
4. 项目配置 (.claude/settings.json)
5. 远程托管设置 (API)
6. MDM 策略 (HKCU/HKLM)
7. 插件设置
8. 环境变量
9. CLI 参数
```

---

### 4. Git 操作模块

**核心文件**：`git.ts`, `gitDiff.ts`, `gitSettings.ts`

| 函数 | 职责 |
|------|------|
| `findGitRoot()` | 查找 Git 仓库根目录（带 LRU 缓存） |
| `findCanonicalGitRoot()` | 查找规范 Git 根目录（解析 worktree） |
| `getGitState()` | 获取 Git 状态快照 |
| `preserveGitStateForIssue()` | 保存 Git 状态用于 issue 提交 |
| `normalizeGitRemoteUrl()` | 规范化 Git 远程 URL |
| `getRepoRemoteHash()` | 生成仓库哈希（用于身份识别） |

**Git 根目录查找算法**：
```typescript
findGitRoot(startPath):
  current = resolve(startPath)
  while current !== root:
    if exists(join(current, '.git')):
      return current  // 找到 Git 根
    current = dirname(current)
  return null  // 未找到
```

**Worktree 解析链**：
```
Worktree 目录
    │
    ▼
.git 文件 (gitdir: <path>)
    │
    ▼
<gitDir>/commondir → 指向共享 .git 目录
    │
    ▼
验证结构：
  1. worktreeGitDir 是 <commonDir>/worktrees/ 的子目录
  2. <worktreeGitDir>/gitdir 指回 <gitRoot>/.git
    │
    ▼
返回规范根目录
```

---

### 5. 文件系统模块

**核心文件**：`fsOperations.ts`, `file.ts`, `fileRead.ts`

**FsOperations 接口**：
```typescript
type FsOperations = {
  // 同步操作
  existsSync(path: string): boolean
  readFileSync(path, options): string
  writeFileSync(path, data): void
  statSync(path): Stats
  lstatSync(path): Stats
  realpathSync(path): string
  
  // 异步操作
  stat(path): Promise<Stats>
  readFile(path, options): Promise<string>
  writeFile(path, data): Promise<void>
  mkdir(path, options): Promise<void>
  unlink(path): Promise<void>
  rm(path, options): Promise<void>
}
```

**关键函数**：
| 函数 | 职责 |
|------|------|
| `safeResolvePath()` | 安全路径解析，处理符号链接 |
| `getPathsForPermissionCheck()` | 获取权限检查路径链 |
| `resolveDeepestExistingAncestorSync()` | 解析最深现有祖先 |
| `readLinesReverse()` | 反向读取文件行 |
| `tailFile()` | 读取文件尾部 |

**符号链接处理**：
```
输入路径
    │
    ▼
检查是否存在
    │
    ├── 不存在 → resolveDeepestExistingAncestorSync()
    │              │
    │              ├── lstat 向上查找第一个现有组件
    │              ├── 遇到符号链接 → readlink 解析
    │              └── 返回解析路径
    │
    └── 存在 → 遍历符号链接链
                 │
                 ├── lstat 检查类型
                 ├── 是符号链接 → readlink 获取目标
                 ├── 添加中间目标到路径集
                 └── 继续直到非符号链接
    │
    ▼
返回所有权限检查路径
```

---

### 6. Bash 解析模块

**目录**：`src/utils/bash/`

| 文件 | 职责 |
|------|------|
| `parser.ts` | 命令解析入口，Tree-sitter 集成 |
| `bashParser.ts` | Tree-sitter 解析器初始化 |
| `ast.ts` | AST 安全分析行走器 |
| `commands.ts` | 命令提取和处理 |
| `shellQuote.ts` | Shell 引用处理 |
| `shellQuoting.ts` | Shell 引用规范化 |
| `heredoc.ts` | Heredoc 处理 |
| `treeSitterAnalysis.ts` | Tree-sitter 分析 |

**解析流程**：
```
Bash 命令字符串
    │
    ▼
parseCommand()
    │
    ├── feature('TREE_SITTER_BASH')?
    │   │
    │   ├── 是 → 初始化 Tree-sitter 解析器
    │   │         │
    │   │         ├── load WASM (tree-sitter-bash.wasm)
    │   │         └── create Parser + Language
    │   │
    │   └── 解析 → rootNode
    │              │
    │              ├── findCommandNode() - 查找命令节点
    │              └── extractEnvVars() - 提取环境变量
    │
    └── 否 → 返回 null (回退到传统解析)
    │
    ▼
返回 ParsedCommandData {
  rootNode,
  envVars,
  commandNode,
  originalCommand
}
```

**AST 安全分析**：
```typescript
// 识别危险命令
const DANGEROUS_COMMANDS = new Set([
  'eval', 'source', '.', 'exec',
  'trap', 'enable', 'hash',
  'curl | bash', 'wget | bash'
])

// 识别评估型命令
const DECLARATION_COMMANDS = new Set([
  'export', 'declare', 'typeset',
  'readonly', 'local', 'unset'
])

// 识别替换类型
const SUBSTITUTION_TYPES = new Set([
  'command_substitution',
  'process_substitution'
])
```

---

### 7. 模型管理模块

**目录**：`src/utils/model/`

| 文件 | 职责 |
|------|------|
| `model.ts` | 模型选择逻辑 |
| `providers.ts` | API 提供商管理 |
| `modelStrings.ts` | 模型字符串配置 |
| `aliases.ts` | 模型别名 |
| `configs.ts` | 模型配置 |
| `modelOptions.ts` | 模型选项定义 |

**模型选择优先级**：
```
getMainLoopModel()
    │
    ├── 1. /model 命令覆盖 (最高优先级)
    │
    ├── 2. --model 启动参数
    │
    ├── 3. ANTHROPIC_MODEL 环境变量
    │
    ├── 4. settings.model 用户设置
    │
    └── 5. 内置默认
            │
            ├── Max/Team Premium → Opus
            └── 其他用户 → Sonnet
```

**模型别名**：
| 别名 | 解析 |
|------|------|
| `opus` | 最新 Opus 模型 |
| `sonnet` | 最新 Sonnet 模型 |
| `haiku` | 最新 Haiku 模型 |
| `opusplan` | Opus (计划模式) |
| `sonnetplan` | Sonnet (计划模式) |

---

### 8. 遥测与日志模块

**目录**：`src/utils/telemetry/`

| 文件 | 职责 |
|------|------|
| `sessionTracing.ts` | 会话追踪 |
| `events.ts` | 事件定义 |
| `logger.ts` | 日志记录 |
| `instrumentation.ts` | 性能检测 |
| `bigqueryExporter.ts` | BigQuery 导出 |

**日志级别**：
| 函数 | 用途 |
|------|------|
| `logForDebugging()` | 调试日志 |
| `logForDiagnosticsNoPII()` | 诊断日志（无 PII） |
| `logError()` | 错误日志 |
| `logAntError()` | Ant 错误日志 |

---

## 设计原则

### 1. 不可变性 (Immutability)

```typescript
// ❌ 错误：直接修改对象
function modifyConfig(config, key, value) {
  config[key] = value
  return config
}

// ✅ 正确：创建新对象
function updateConfig(config, key, value) {
  return { ...config, [key]: value }
}
```

### 2. 错误处理

```typescript
// 在系统边界进行输入验证
function validateInput(input: unknown): ValidatedInput {
  if (!isValid(input)) {
    throw new ValidationError('Invalid input')
  }
  return input
}

// 使用类型守卫处理未知错误
function isAbortError(e: unknown): boolean {
  return (
    e instanceof AbortError ||
    e instanceof APIUserAbortError ||
    (e instanceof Error && e.name === 'AbortError')
  )
}
```

### 3. 缓存策略

```typescript
// 使用 memoize 缓存纯函数
export const findGitRoot = memoizeWithLRU(
  (startPath: string): string | null => {
    // 实现...
  },
  path => path,  // key 函数
  50             // 最大缓存条目
)

// 带 TTL 的异步缓存
export const getBranch = memoize(async (): Promise<string> => {
  // 实现...
})
```

### 4. 抽象接口

```typescript
// 定义抽象接口，支持多种实现
type FsOperations = {
  existsSync(path: string): boolean
  readFileSync(path, options): string
  // ...
}

// 默认实现
const NodeFsOperations: FsOperations = {
  existsSync: fs.existsSync,
  readFileSync: fs.readFileSync,
  // ...
}

// 可切换实现
function getFsImplementation(): FsOperations {
  return activeFs
}
```

---

## 模块依赖关系

```
                    ┌─────────────────┐
                    │   Application   │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │    Services     │
                    └────────┬────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
┌────────▼────────┐ ┌────────▼────────┐ ┌────────▼────────┐
│     Auth        │ │   Permissions   │ │      Git        │
│   config.ts     │ │  permissions/   │ │     git.ts      │
└────────┬────────┘ └────────┬────────┘ └────────┬────────┘
         │                   │                   │
         │          ┌────────▼────────┐          │
         │          │   File System   │          │
         │          │ fsOperations.ts │          │
         │          └────────┬────────┘          │
         │                   │                   │
         │          ┌────────▼────────┐          │
         │          │   Bash Parser   │          │
         │          │  bash/parser.ts │          │
         │          └─────────────────┘          │
         │                                       │
┌────────▼──────────────────────────────────────▼────────┐
│                   Infrastructure                        │
│            Node.js/Bun Runtime, OS API                  │
└─────────────────────────────────────────────────────────┘
```

---

## 相关文件

| 类别 | 文件 |
|------|------|
| 类型定义 | `src/types/permissions.ts`, `src/types/settings.ts` |
| 常量定义 | `src/utils/configConstants.ts`, `src/utils/settings/constants.ts` |
| Schema 定义 | `src/utils/lazySchema.ts` |

---

*文档生成时间：2026-04-01*
