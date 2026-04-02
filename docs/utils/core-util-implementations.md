# 核心工具函数实现详解

本文档详细描述工具函数层中各核心模块的实现细节。

---

## 目录

1. [认证模块](#认证模块)
2. [配置系统](#配置系统)
3. [Git 操作](#git 操作)
4. [文件系统抽象](#文件系统抽象)
5. [Bash 解析](#bash 解析)
6. [模型管理](#模型管理)
7. [缓存机制](#缓存机制)
8. [错误处理](#错误处理)

---

## 认证模块

### 文件：`src/utils/auth.ts`

#### 认证源检测流程

```typescript
// 认证源优先级检测
function getAuthTokenSource(): { source: string, hasToken: boolean } {
  // 1. --bare 模式：仅支持 apiKeyHelper
  if (isBareMode()) {
    if (getConfiguredApiKeyHelper()) {
      return { source: 'apiKeyHelper', hasToken: true }
    }
    return { source: 'none', hasToken: false }
  }
  
  // 2. 环境变量检测
  if (process.env.ANTHROPIC_AUTH_TOKEN && !isManagedOAuthContext()) {
    return { source: 'ANTHROPIC_AUTH_TOKEN', hasToken: true }
  }
  
  // 3. CCR OAuth 令牌
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { source: 'CLAUDE_CODE_OAUTH_TOKEN', hasToken: true }
  }
  
  // 4. OAuth FD 令牌（文件描述符传递）
  const oauthTokenFromFd = getOAuthTokenFromFileDescriptor()
  if (oauthTokenFromFd) {
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR) {
      return { source: 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', hasToken: true }
    }
    return { source: 'CCR_OAUTH_TOKEN_FILE', hasToken: true }
  }
  
  // 5. apiKeyHelper（不执行，仅检查配置）
  const apiKeyHelper = getConfiguredApiKeyHelper()
  if (apiKeyHelper && !isManagedOAuthContext()) {
    return { source: 'apiKeyHelper', hasToken: true }
  }
  
  // 6. Claude AI OAuth
  const oauthTokens = getClaudeAIOAuthTokens()
  if (shouldUseClaudeAIAuth(oauthTokens?.scopes) && oauthTokens?.accessToken) {
    return { source: 'claude.ai', hasToken: true }
  }
  
  return { source: 'none', hasToken: false }
}
```

#### API 密钥获取逻辑

```typescript
function getAnthropicApiKeyWithSource(opts = {}): { key: string | null, source: ApiKeySource } {
  // --bare 模式：hermetic auth
  if (isBareMode()) {
    if (process.env.ANTHROPIC_API_KEY) {
      return { key: process.env.ANTHROPIC_API_KEY, source: 'ANTHROPIC_API_KEY' }
    }
    if (getConfiguredApiKeyHelper()) {
      return {
        key: opts.skipRetrievingKeyFromApiKeyHelper 
          ? null 
          : getApiKeyFromApiKeyHelperCached(),
        source: 'apiKeyHelper',
      }
    }
    return { key: null, source: 'none' }
  }
  
  // Homespace 环境：不使用 ANTHROPIC_API_KEY
  const apiKeyEnv = isRunningOnHomespace()
    ? undefined
    : process.env.ANTHROPIC_API_KEY
  
  // CI/测试环境
  if (isEnvTruthy(process.env.CI) || process.env.NODE_ENV === 'test') {
    const apiKeyFromFd = getApiKeyFromFileDescriptor()
    if (apiKeyFromFd) {
      return { key: apiKeyFromFd, source: 'ANTHROPIC_API_KEY' }
    }
    
    if (apiKeyEnv) {
      return { key: apiKeyEnv, source: 'ANTHROPIC_API_KEY' }
    }
    
    return { key: null, source: 'none' }
  }
  
  // 检查安全存储（Keychain/Windows Credential Manager）
  const keyFromKeychain = getApiKeyFromKeychain()
  if (keyFromKeychain) {
    return { key: keyFromKeychain, source: '/login managed key' }
  }
  
  return { key: null, source: 'none' }
}
```

#### 认证启用判断

```typescript
function isAnthropicAuthEnabled(): boolean {
  // --bare 模式：仅 API key，不使用 OAuth
  if (isBareMode()) return false
  
  // SSH 隧道模式：ANTHROPIC_UNIX_SOCKET
  if (process.env.ANTHROPIC_UNIX_SOCKET) {
    return !!process.env.CLAUDE_CODE_OAUTH_TOKEN
  }
  
  // 第三方服务（Bedrock/Vertex/Foundry）
  const is3P =
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
  
  // 检查外部 API key
  const { source: apiKeySource } = getAnthropicApiKeyWithSource({
    skipRetrievingKeyFromApiKeyHelper: true,
  })
  const hasExternalApiKey =
    apiKeySource === 'ANTHROPIC_API_KEY' || apiKeySource === 'apiKeyHelper'
  
  // 检查外部令牌
  const hasExternalAuthToken =
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
  
  // 以下情况禁用 Anthropic OAuth：
  // 1. 使用第三方服务
  // 2. 有外部 API key（非托管上下文）
  // 3. 有外部令牌（非托管上下文）
  const shouldDisableAuth =
    is3P ||
    (hasExternalAuthToken && !isManagedOAuthContext()) ||
    (hasExternalApiKey && !isManagedOAuthContext())
  
  return !shouldDisableAuth
}
```

#### 关键数据结构

```typescript
type ApiKeySource =
  | 'ANTHROPIC_API_KEY'      // 环境变量
  | 'apiKeyHelper'           // 配置中的 helper 函数
  | '/login managed key'     // /login 命令管理的密钥
  | 'none'                   // 无密钥

type AuthTokenSource =
  | 'ANTHROPIC_AUTH_TOKEN'
  | 'CLAUDE_CODE_OAUTH_TOKEN'
  | 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR'
  | 'CCR_OAUTH_TOKEN_FILE'
  | 'apiKeyHelper'
  | 'claude.ai'
  | 'none'
```

---

## 配置系统

### 文件：`src/utils/config.ts`

#### 配置类型定义

```typescript
// 全局配置
type GlobalConfig = {
  apiKeyHelper?: string                      // API 密钥辅助函数
  projects?: Record<string, ProjectConfig>   // 项目配置
  numStartups: number                        // 启动次数
  installMethod?: InstallMethod              // 安装方式
  autoUpdates?: boolean                      // 自动更新
  doctorShownAtSession?: number              // Doctor 提示会话数
  userID?: string                            // 用户 ID
  theme: ThemeSetting                        // 主题设置
  hasCompletedOnboarding?: boolean           // 是否完成入门引导
  
  // MCP 服务器配置
  mcpServers?: Record<string, McpServerConfig>
  enabledMcpjsonServers?: string[]           // 已启用的 MCP 服务器
  disabledMcpjsonServers?: string[]          // 已禁用的 MCP 服务器
  enableAllProjectMcpServers?: boolean       // 启用所有项目 MCP
  
  // 权限相关
  bypassPermissionsModeAccepted?: boolean    // 是否接受绕过权限模式
  customApiKeyResponses?: {
    approved?: string[]                      // 已批准的 API 密钥响应
    rejected?: string[]                      // 已拒绝的 API 密钥响应
  }
  
  // 编辑器设置
  editorMode?: EditorMode                    // 编辑器模式
  diffTool?: DiffTool                        // 差异工具
  
  // 会话追踪
  hasUsedBackgroundTask?: boolean            // 是否使用过后台任务
  hasUsedStash?: boolean                     // 是否使用过暂存
}

// 项目配置
type ProjectConfig = {
  allowedTools: string[]                     // 允许的工具列表
  mcpContextUris: string[]                   // MCP 上下文 URI
  mcpServers?: Record<string, McpServerConfig>
  
  // 性能指标
  lastAPIDuration?: number                   // 上次 API 耗时
  lastToolDuration?: number                  // 上次工具耗时
  lastCost?: number                          // 上次成本
  lastLinesAdded?: number                    // 上次添加行数
  lastLinesRemoved?: number                  // 上次删除行数
  
  // Token 使用
  lastTotalInputTokens?: number
  lastTotalOutputTokens?: number
  lastTotalCacheCreationInputTokens?: number
  lastTotalCacheReadInputTokens?: number
  
  // 模型使用
  lastModelUsage?: Record<string, {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
    costUSD: number
  }>
  
  // 信任对话框
  hasTrustDialogAccepted?: boolean           // 是否接受信任对话框
  hasCompletedProjectOnboarding?: boolean    // 是否完成项目入门
  
  // Worktree 会话管理
  activeWorktreeSession?: {
    originalCwd: string
    worktreePath: string
    worktreeName: string
    originalBranch?: string
    sessionId: string
    hookBased?: boolean
  }
}
```

#### 设置加载流程

```typescript
// 设置源优先级（从低到高）
const SETTING_SOURCES = [
  'managedFile',      // managed-settings.json
  'managedDropIns',   // managed-settings.d/*.json
  'global',           // ~/.claude/settings.json
  'project',          // .claude/settings.json
  'remoteManaged',    // 远程托管设置
  'mdmHkcu',          // HKCU MDM 策略
  'mdmHklm',          // HKLM MDM 策略
  'plugin',           // 插件设置
  'env',              // 环境变量
  'cli',              // CLI 参数
] as const

// 设置加载主函数
function getSettingsForSourceUncached(
  source: SettingSource
): { settings: SettingsJson, errors: ValidationError[] } {
  switch (source) {
    case 'managedFile':
    case 'managedDropIns':
      return loadManagedFileSettings()
    
    case 'global':
      return parseSettingsFile(getGlobalSettingsPath())
    
    case 'project':
      return parseSettingsFile(getProjectSettingsPath())
    
    case 'remoteManaged':
      return { 
        settings: getRemoteManagedSettingsSyncFromCache(), 
        errors: [] 
      }
    
    case 'mdmHkcu':
      return { settings: getHkcuSettings(), errors: [] }
    
    case 'mdmHklm':
      return { settings: getMdmSettings(), errors: [] }
    
    case 'plugin':
      return { settings: getPluginSettingsBase(), errors: [] }
    
    default:
      return { settings: {}, errors: [] }
  }
}
```

#### 设置合并策略

```typescript
// 使用 lodash mergeWith 进行深度合并
function mergeSettings(...sources: SettingsJson[]): SettingsJson {
  return mergeWith({}, ...sources, settingsMergeCustomizer)
}

// 自定义合并器：数组替换而非合并
function settingsMergeCustomizer(objValue: unknown, srcValue: unknown) {
  // 数组：使用源值替换（而非合并）
  if (Array.isArray(objValue) && Array.isArray(srcValue)) {
    return srcValue
  }
  // 对象：深度合并
  if (isObject(objValue) && isObject(srcValue)) {
    return undefined // mergeWith 会继续深度合并
  }
  // 原始值：使用源值
  return srcValue
}
```

---

## Git 操作

### 文件：`src/utils/git.ts`

#### Git 根目录查找（带 LRU 缓存）

```typescript
const GIT_ROOT_NOT_FOUND = Symbol('git-root-not-found')

// 使用 LRU 缓存防止无限制内存增长
const findGitRootImpl = memoizeWithLRU(
  (startPath: string): string | typeof GIT_ROOT_NOT_FOUND => {
    const startTime = Date.now()
    logForDiagnosticsNoPII('info', 'find_git_root_started')
    
    let current = resolve(startPath)
    const root = current.substring(0, current.indexOf(sep) + 1) || sep
    let statCount = 0
    
    // 向上遍历目录树
    while (current !== root) {
      try {
        const gitPath = join(current, '.git')
        statCount++
        const stat = statSync(gitPath)
        // .git 可以是目录（常规仓库）或文件（worktree/子模块）
        if (stat.isDirectory() || stat.isFile()) {
          logForDiagnosticsNoPII('info', 'find_git_root_completed', {
            duration_ms: Date.now() - startTime,
            stat_count: statCount,
            found: true,
          })
          return current.normalize('NFC')
        }
      } catch {
        // .git 不存在于此层级，继续向上
      }
      const parent = dirname(current)
      if (parent === current) {
        break
      }
      current = parent
    }
    
    // 检查根目录
    try {
      const gitPath = join(root, '.git')
      statCount++
      const stat = statSync(gitPath)
      if (stat.isDirectory() || stat.isFile()) {
        return root.normalize('NFC')
      }
    } catch {
      // .git 不存在于根目录
    }
    
    return GIT_ROOT_NOT_FOUND
  },
  path => path,  // key 函数
  50             // 最大缓存 50 个条目
)

// 包装函数，将 Symbol 转换为 null
export const findGitRoot = createFindGitRoot()

function createFindGitRoot(): {
  (startPath: string): string | null
  cache: typeof findGitRootImpl.cache
} {
  function wrapper(startPath: string): string | null {
    const result = findGitRootImpl(startPath)
    return result === GIT_ROOT_NOT_FOUND ? null : result
  }
  wrapper.cache = findGitRootImpl.cache
  return wrapper
}
```

#### 规范 Git 根目录解析（Worktree 支持）

```typescript
// 解析规范 Git 根目录，解析 worktree 链
const resolveCanonicalRoot = memoizeWithLRU(
  (gitRoot: string): string => {
    try {
      // 在 worktree 中，.git 是一个文件，内容为：gitdir: <path>
      const gitContent = readFileSync(join(gitRoot, '.git'), 'utf-8').trim()
      if (!gitContent.startsWith('gitdir:')) {
        return gitRoot  // 常规仓库，直接返回
      }
      
      // 解析 worktree gitdir
      const worktreeGitDir = resolve(
        gitRoot,
        gitContent.slice('gitdir:'.length).trim(),
      )
      
      // commondir 指向共享的 .git 目录
      const commonDir = resolve(
        worktreeGitDir,
        readFileSync(join(worktreeGitDir, 'commondir'), 'utf-8').trim(),
      )
      
      // 安全验证：防止恶意仓库利用 commondir 进行沙箱逃逸
      // 1. worktreeGitDir 必须是 <commonDir>/worktrees/ 的子目录
      if (resolve(dirname(worktreeGitDir)) !== join(commonDir, 'worktrees')) {
        return gitRoot
      }
      
      // 2. <worktreeGitDir>/gitdir 必须指回 <gitRoot>/.git
      const backlink = realpathSync(
        readFileSync(join(worktreeGitDir, 'gitdir'), 'utf-8').trim(),
      )
      if (backlink !== join(realpathSync(gitRoot), '.git')) {
        return gitRoot
      }
      
      // Bare 仓库的 worktrees：使用 common dir 作为稳定身份
      if (basename(commonDir) !== '.git') {
        return commonDir.normalize('NFC')
      }
      
      return dirname(commonDir).normalize('NFC')
    } catch {
      return gitRoot
    }
  },
  root => root,
  50
)
```

#### Git 状态保存（用于 Issue 提交）

```typescript
type PreservedGitState = {
  remote_base_sha: string | null    // 远程基础 SHA
  remote_base: string | null        // 远程分支（如 origin/main）
  patch: string                     // 从 merge-base 到当前状态的补丁
  untracked_files: Array<{ path: string, content: string }>
  format_patch: string | null       // format-patch 输出（保留提交链）
  head_sha: string | null           // HEAD SHA
  branch_name: string | null        // 分支名
}

async function preserveGitStateForIssue(): Promise<PreservedGitState | null> {
  // 检查是否为 Git 仓库
  const isGit = await getIsGit()
  if (!isGit) return null
  
  // 浅克隆检测：回退到 HEAD-only 模式
  if (await isShallowClone()) {
    const [{ stdout: patch }, untrackedFiles] = await Promise.all([
      execFileNoThrow(gitExe(), ['diff', 'HEAD']),
      captureUntrackedFiles(),
    ])
    return {
      remote_base_sha: null,
      remote_base: null,
      patch: patch || '',
      untracked_files: untrackedFiles,
      format_patch: null,
      head_sha: null,
      branch_name: null,
    }
  }
  
  // 查找最佳远程基础
  const remoteBase = await findRemoteBase()
  
  if (!remoteBase) {
    // 未找到远程，使用 HEAD-only 模式
    // ... 类似处理
  }
  
  // 获取与远程的 merge-base
  const { stdout: mergeBase } = await execFileNoThrow(
    gitExe(),
    ['merge-base', 'HEAD', remoteBase]
  )
  const remoteBaseSha = mergeBase.trim()
  
  // 并行执行 5 个 Git 命令
  const [
    { stdout: patch },
    untrackedFiles,
    { stdout: formatPatchOut },
    { stdout: headSha },
    { stdout: branchName },
  ] = await Promise.all([
    execFileNoThrow(gitExe(), ['diff', remoteBaseSha]),
    captureUntrackedFiles(),
    execFileNoThrow(gitExe(), ['format-patch', `${remoteBaseSha}..HEAD`, '--stdout']),
    execFileNoThrow(gitExe(), ['rev-parse', 'HEAD']),
    execFileNoThrow(gitExe(), ['rev-parse', '--abbrev-ref', 'HEAD']),
  ])
  
  return {
    remote_base_sha: remoteBaseSha,
    remote_base: remoteBase,
    patch: patch || '',
    untracked_files: untrackedFiles,
    format_patch: formatPatchOut?.trim() || null,
    head_sha: headSha?.trim() || null,
    branch_name: branchName?.trim() !== 'HEAD' ? branchName?.trim() : null,
  }
}
```

#### 未跟踪文件捕获

```typescript
// 大小限制
const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024  // 500MB 每文件
const MAX_TOTAL_SIZE_BYTES = 5 * 1024 * 1024 * 1024  // 5GB 总计
const MAX_FILE_COUNT = 20000

// 嗅探缓冲区：用于二进制检测和内容重用
const SNIFF_BUFFER_SIZE = 64 * 1024  // 64KB

async function captureUntrackedFiles(): Promise<Array<{ path: string, content: string }>> {
  const { stdout, code } = await execFileNoThrow(
    gitExe(),
    ['ls-files', '--others', '--exclude-standard']
  )
  
  const trimmed = stdout.trim()
  if (code !== 0 || !trimmed) return []
  
  const files = trimmed.split('\n').filter(Boolean)
  const result: Array<{ path: string, content: string }> = []
  let totalSize = 0
  
  for (const filePath of files) {
    // 检查文件数量限制
    if (result.length >= MAX_FILE_COUNT) break
    
    // 按扩展名跳过二进制文件（零 I/O）
    if (hasBinaryExtension(filePath)) continue
    
    try {
      const stats = await stat(filePath)
      const fileSize = stats.size
      
      // 跳过超过单文件限制的文件
      if (fileSize > MAX_FILE_SIZE_BYTES) continue
      
      // 检查总大小限制
      if (totalSize + fileSize > MAX_TOTAL_SIZE_BYTES) break
      
      // 空文件
      if (fileSize === 0) {
        result.push({ path: filePath, content: '' })
        continue
      }
      
      // 二进制嗅探
      const sniffSize = Math.min(SNIFF_BUFFER_SIZE, fileSize)
      const fd = await open(filePath, 'r')
      try {
        const sniffBuf = Buffer.alloc(sniffSize)
        const { bytesRead } = await fd.read(sniffBuf, 0, sniffSize, 0)
        const sniff = sniffBuf.subarray(0, bytesRead)
        
        if (isBinaryContent(sniff)) continue
        
        let content: string
        if (fileSize <= sniffSize) {
          // 嗅探缓冲区已包含整个文件
          content = sniff.toString('utf-8')
        } else {
          // 大文件：使用 readFile 直接解码为字符串
          content = await readFile(filePath, 'utf-8')
        }
        
        result.push({ path: filePath, content })
        totalSize += fileSize
      } finally {
        await fd.close()
      }
    } catch (err) {
      // 跳过无法读取的文件
      logForDebugging(`Failed to read untracked file ${filePath}: ${err}`)
    }
  }
  
  return result
}
```

---

## 文件系统抽象

### 文件：`src/utils/fsOperations.ts`

#### FsOperations 接口定义

```typescript
type FsOperations = {
  // 同步操作
  cwd(): string
  existsSync(path: string): boolean
  statSync(path: string): fs.Stats
  lstatSync(path: string): fs.Stats
  realpathSync(path: string): string
  readFileSync(path: string, options: { encoding: BufferEncoding }): string
  readFileBytesSync(path: string): Buffer
  mkdirSync(path: string, options?: { mode?: number }): void
  readdirSync(path: string): fs.Dirent[]
  readdirStringSync(path: string): string[]
  isDirEmptySync(path: string): boolean
  rmdirSync(path: string): void
  rmSync(path: string, options?: { recursive?: boolean, force?: boolean }): void
  unlinkSync(path: string): void
  renameSync(oldPath: string, newPath: string): void
  copyFileSync(src: string, dest: string): void
  linkSync(target: string, path: string): void
  symlinkSync(target: string, path: string, type?: 'dir' | 'file' | 'junction'): void
  readlinkSync(path: string): string
  appendFileSync(path: string, data: string, options?: { mode?: number }): void
  createWriteStream(path: string): fs.WriteStream
  
  // 异步操作
  stat(path: string): Promise<fs.Stats>
  readdir(path: string): Promise<fs.Dirent[]>
  unlink(path: string): Promise<void>
  rmdir(path: string): Promise<void>
  rm(path: string, options?: { recursive?: boolean, force?: boolean }): Promise<void>
  mkdir(path: string, options?: { mode?: number }): Promise<void>
  readFile(path: string, options: { encoding: BufferEncoding }): Promise<string>
  rename(oldPath: string, newPath: string): Promise<void>
  readFileBytes(path: string, maxBytes?: number): Promise<Buffer>
}
```

#### 安全路径解析

```typescript
function safeResolvePath(
  fs: FsOperations,
  filePath: string,
): { resolvedPath: string, isSymlink: boolean, isCanonical: boolean } {
  // 阻止 UNC 路径（防止网络请求）
  if (filePath.startsWith('//') || filePath.startsWith('\\\\')) {
    return { resolvedPath: filePath, isSymlink: false, isCanonical: false }
  }
  
  try {
    // 检查特殊文件类型（FIFO、套接字、设备）
    const stats = fs.lstatSync(filePath)
    if (
      stats.isFIFO() ||
      stats.isSocket() ||
      stats.isCharacterDevice() ||
      stats.isBlockDevice()
    ) {
      return { resolvedPath: filePath, isSymlink: false, isCanonical: false }
    }
    
    const resolvedPath = fs.realpathSync(filePath)
    return {
      resolvedPath,
      isSymlink: resolvedPath !== filePath,
      isCanonical: true,  // realpathSync 返回的是规范路径
    }
  } catch (_error) {
    // 失败时返回原始路径（允许文件创建）
    return { resolvedPath: filePath, isSymlink: false, isCanonical: false }
  }
}
```

#### 权限检查路径链

```typescript
function getPathsForPermissionCheck(inputPath: string): string[] {
  // 展开波浪号
  let path = inputPath
  if (path === '~') {
    path = homedir().normalize('NFC')
  } else if (path.startsWith('~/')) {
    path = nodePath.join(homedir().normalize('NFC'), path.slice(2))
  }
  
  const pathSet = new Set<string>()
  const fsImpl = getFsImplementation()
  
  // 始终检查原始路径
  pathSet.add(path)
  
  // 阻止 UNC 路径
  if (path.startsWith('//') || path.startsWith('\\\\')) {
    return Array.from(pathSet)
  }
  
  // 遍历符号链接链
  try {
    let currentPath = path
    const visited = new Set<string>()
    const maxDepth = 40  // 防止无限循环
    
    for (let depth = 0; depth < maxDepth; depth++) {
      // 防止循环符号链接
      if (visited.has(currentPath)) break
      visited.add(currentPath)
      
      if (!fsImpl.existsSync(currentPath)) {
        // 处理悬空符号链接
        if (currentPath === path) {
          const resolved = resolveDeepestExistingAncestorSync(fsImpl, path)
          if (resolved !== undefined) {
            pathSet.add(resolved)
          }
        }
        break
      }
      
      const stats = fsImpl.lstatSync(currentPath)
      
      // 跳过特殊文件类型
      if (
        stats.isFIFO() ||
        stats.isSocket() ||
        stats.isCharacterDevice() ||
        stats.isBlockDevice()
      ) {
        break
      }
      
      if (!stats.isSymbolicLink()) break
      
      // 获取符号链接目标
      const target = fsImpl.readlinkSync(currentPath)
      const absoluteTarget = nodePath.isAbsolute(target)
        ? target
        : nodePath.resolve(nodePath.dirname(currentPath), target)
      
      // 添加中间目标
      pathSet.add(absoluteTarget)
      currentPath = absoluteTarget
    }
  } catch {
    // 遍历时出错，继续处理已有路径
  }
  
  // 添加最终解析路径
  const { resolvedPath, isSymlink } = safeResolvePath(fsImpl, path)
  if (isSymlink && resolvedPath !== path) {
    pathSet.add(resolvedPath)
  }
  
  return Array.from(pathSet)
}
```

#### 最深现有祖先解析

```typescript
function resolveDeepestExistingAncestorSync(
  fs: FsOperations,
  absolutePath: string,
): string | undefined {
  let dir = absolutePath
  const segments: string[] = []
  
  // 向上遍历，使用 lstat（不跟随符号链接）
  while (dir !== nodePath.dirname(dir)) {
    let st: fs.Stats
    try {
      st = fs.lstatSync(dir)
    } catch {
      // lstat 失败：组件不存在，继续向上
      segments.unshift(nodePath.basename(dir))
      dir = nodePath.dirname(dir)
      continue
    }
    
    if (st.isSymbolicLink()) {
      // 找到符号链接，尝试解析
      try {
        const resolved = fs.realpathSync(dir)
        return segments.length === 0
          ? resolved
          : nodePath.join(resolved, ...segments)
      } catch {
        // 悬空符号链接：使用 readlink
        const target = fs.readlinkSync(dir)
        const absTarget = nodePath.isAbsolute(target)
          ? target
          : nodePath.resolve(nodePath.dirname(dir), target)
        return segments.length === 0
          ? absTarget
          : nodePath.join(absTarget, ...segments)
      }
    }
    
    // 现有非符号链接组件
    try {
      const resolved = fs.realpathSync(dir)
      if (resolved !== dir) {
        return segments.length === 0
          ? resolved
          : nodePath.join(resolved, ...segments)
      }
    } catch {
      // realpath 失败，返回 undefined
    }
    return undefined
  }
  
  return undefined
}
```

---

## Bash 解析

### 文件：`src/utils/bash/parser.ts`

#### 命令解析入口

```typescript
const MAX_COMMAND_LENGTH = 10000

const DECLARATION_COMMANDS = new Set([
  'export', 'declare', 'typeset', 'readonly',
  'local', 'unset', 'unsetenv',
])

const ARGUMENT_TYPES = new Set(['word', 'string', 'raw_string', 'number'])
const SUBSTITUTION_TYPES = new Set([
  'command_substitution',
  'process_substitution'
])
const COMMAND_TYPES = new Set(['command', 'declaration_command'])

async function parseCommand(command: string): Promise<ParsedCommandData | null> {
  if (!command || command.length > MAX_COMMAND_LENGTH) return null
  
  // Feature gate：仅 ant 用户可用
  if (feature('TREE_SITTER_BASH')) {
    await ensureParserInitialized()
    const mod = getParserModule()
    logLoadOnce(mod !== null)
    if (!mod) return null
    
    try {
      const rootNode = mod.parse(command)
      if (!rootNode) return null
      
      const commandNode = findCommandNode(rootNode, null)
      const envVars = extractEnvVars(commandNode)
      
      return { rootNode, envVars, commandNode, originalCommand: command }
    } catch {
      return null
    }
  }
  
  return null  // 回退到传统解析
}
```

#### AST 节点查找

```typescript
function findCommandNode(node: Node, parent: Node | null): Node | null {
  const { type, children } = node
  
  // 找到命令节点
  if (COMMAND_TYPES.has(type)) return node
  
  // 变量赋值后跟命令
  if (type === 'variable_assignment' && parent) {
    return (
      parent.children.find(
        c => COMMAND_TYPES.has(c.type) && c.startIndex > node.startIndex
      ) ?? null
    )
  }
  
  // 管道：递归到第一个子节点
  if (type === 'pipeline') {
    for (const child of children) {
      const result = findCommandNode(child, node)
      if (result) return result
    }
    return null
  }
  
  // 重定向语句：查找内部的命令
  if (type === 'redirected_statement') {
    return children.find(c => COMMAND_TYPES.has(c.type)) ?? null
  }
  
  // 递归搜索
  for (const child of children) {
    const result = findCommandNode(child, node)
    if (result) return result
  }
  
  return null
}

function extractEnvVars(commandNode: Node | null): string[] {
  if (!commandNode || commandNode.type !== 'command') return []
  
  const envVars: string[] = []
  for (const child of commandNode.children) {
    if (child.type === 'variable_assignment') {
      envVars.push(child.text)
    } else if (child.type === 'command_name' || child.type === 'word') {
      break
    }
  }
  return envVars
}
```

#### 参数提取

```typescript
function extractCommandArguments(commandNode: Node): string[] {
  // 声明命令
  if (commandNode.type === 'declaration_command') {
    const firstChild = commandNode.children[0]
    return firstChild && DECLARATION_COMMANDS.has(firstChild.text)
      ? [firstChild.text]
      : []
  }
  
  const args: string[] = []
  let foundCommandName = false
  
  for (const child of commandNode.children) {
    if (child.type === 'variable_assignment') continue
    
    // 命令名
    if (
      child.type === 'command_name' ||
      (!foundCommandName && child.type === 'word')
    ) {
      foundCommandName = true
      args.push(child.text)
      continue
    }
    
    // 参数
    if (ARGUMENT_TYPES.has(child.type)) {
      args.push(stripQuotes(child.text))
    } else if (SUBSTITUTION_TYPES.has(child.type)) {
      break  // 遇到替换，停止
    }
  }
  
  return args
}

function stripQuotes(text: string): string {
  return text.length >= 2 &&
    ((text[0] === '"' && text.at(-1) === '"') ||
     (text[0] === "'" && text.at(-1) === "'"))
    ? text.slice(1, -1)
    : text
}
```

---

## 模型管理

### 文件：`src/utils/model/model.ts`

#### 模型选择逻辑

```typescript
function getMainLoopModel(): ModelName {
  const model = getUserSpecifiedModelSetting()
  if (model !== undefined && model !== null) {
    return parseUserSpecifiedModel(model)
  }
  return getDefaultMainLoopModel()
}

function getUserSpecifiedModelSetting(): ModelSetting | undefined {
  let specifiedModel: ModelSetting | undefined
  
  // 1. 会话中覆盖（/model 命令）
  const modelOverride = getMainLoopModelOverride()
  if (modelOverride !== undefined) {
    specifiedModel = modelOverride
  } else {
    // 2-4. 启动参数、环境变量、设置
    const settings = getSettings_DEPRECATED() || {}
    specifiedModel = process.env.ANTHROPIC_MODEL || settings.model || undefined
  }
  
  // 忽略不在允许列表中的模型
  if (specifiedModel && !isModelAllowed(specifiedModel)) {
    return undefined
  }
  
  return specifiedModel
}

function getDefaultMainLoopModelSetting(): ModelName | ModelAlias {
  // Ant 用户
  if (process.env.USER_TYPE === 'ant') {
    return (
      getAntModelOverrideConfig()?.defaultModel ??
      getDefaultOpusModel() + '[1m]'
    )
  }
  
  // Max 用户：Opus
  if (isMaxSubscriber()) {
    return getDefaultOpusModel() + (isOpus1mMergeEnabled() ? '[1m]' : '')
  }
  
  // Team Premium：Opus
  if (isTeamPremiumSubscriber()) {
    return getDefaultOpusModel() + (isOpus1mMergeEnabled() ? '[1m]' : '')
  }
  
  // 其他用户：Sonnet
  return getDefaultSonnetModel()
}
```

#### 默认模型配置

```typescript
// Opus 默认
function getDefaultOpusModel(): ModelName {
  if (process.env.ANTHROPIC_DEFAULT_OPUS_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  }
  // 第三方提供商可能滞后
  if (getAPIProvider() !== 'firstParty') {
    return getModelStrings().opus46
  }
  return getModelStrings().opus46
}

// Sonnet 默认
function getDefaultSonnetModel(): ModelName {
  if (process.env.ANTHROPIC_DEFAULT_SONNET_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  }
  // 第三方默认使用 Sonnet 4.5（可能还没有 4.6）
  if (getAPIProvider() !== 'firstParty') {
    return getModelStrings().sonnet45
  }
  return getModelStrings().sonnet46
}

// Haiku 默认
function getDefaultHaikuModel(): ModelName {
  if (process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  }
  return getModelStrings().haiku45
}
```

---

## 缓存机制

### 文件：`src/utils/memoize.ts`

#### TTL 缓存（同步）

```typescript
function memoizeWithTTL<Args extends unknown[], Result>(
  f: (...args: Args) => Result,
  cacheLifetimeMs: number = 5 * 60 * 1000,  // 默认 5 分钟
): MemoizedFunction<Args, Result> {
  const cache = new Map<string, CacheEntry<Result>>()
  
  const memoized = (...args: Args): Result => {
    const key = jsonStringify(args)
    const cached = cache.get(key)
    const now = Date.now()
    
    // 填充缓存
    if (!cached) {
      const value = f(...args)
      cache.set(key, { value, timestamp: now, refreshing: false })
      return value
    }
    
    // 过期缓存：返回旧值并后台刷新
    if (
      cached &&
      now - cached.timestamp > cacheLifetimeMs &&
      !cached.refreshing
    ) {
      cached.refreshing = true
      
      // 后台刷新
      Promise.resolve()
        .then(() => {
          const newValue = f(...args)
          if (cache.get(key) === cached) {
            cache.set(key, {
              value: newValue,
              timestamp: Date.now(),
              refreshing: false,
            })
          }
        })
        .catch(e => {
          logError(e)
          if (cache.get(key) === cached) {
            cache.delete(key)
          }
        })
      
      return cached.value
    }
    
    return cache.get(key)!.value
  }
  
  memoized.cache = { clear: () => cache.clear() }
  return memoized
}
```

#### TTL 缓存（异步）

```typescript
function memoizeWithTTLAsync<Args extends unknown[], Result>(
  f: (...args: Args) => Promise<Result>,
  cacheLifetimeMs: number = 5 * 60 * 1000,
): ((...args: Args) => Promise<Result>) & { cache: { clear: () => void } } {
  const cache = new Map<string, CacheEntry<Result>>()
  // 防止并发冷启动的 in-flight 映射
  const inFlight = new Map<string, Promise<Result>>()
  
  const memoized = async (...args: Args): Promise<Result> => {
    const key = jsonStringify(args)
    const cached = cache.get(key)
    const now = Date.now()
    
    // 冷启动：等待 in-flight 请求
    if (!cached) {
      const pending = inFlight.get(key)
      if (pending) return pending
      
      const promise = f(...args)
      inFlight.set(key, promise)
      try {
        const result = await promise
        if (inFlight.get(key) === promise) {
          cache.set(key, { value: result, timestamp: now, refreshing: false })
        }
        return result
      } finally {
        if (inFlight.get(key) === promise) {
          inFlight.delete(key)
        }
      }
    }
    
    // 过期缓存：返回旧值并后台刷新
    if (
      cached &&
      now - cached.timestamp > cacheLifetimeMs &&
      !cached.refreshing
    ) {
      cached.refreshing = true
      
      const staleEntry = cached
      f(...args)
        .then(newValue => {
          if (cache.get(key) === staleEntry) {
            cache.set(key, {
              value: newValue,
              timestamp: Date.now(),
              refreshing: false,
            })
          }
        })
        .catch(e => {
          logError(e)
          if (cache.get(key) === staleEntry) {
            cache.delete(key)
          }
        })
      
      return cached.value
    }
    
    return cache.get(key)!.value
  }
  
  memoized.cache = {
    clear: () => {
      cache.clear()
      inFlight.clear()
    },
  }
  
  return memoized
}
```

#### LRU 缓存

```typescript
function memoizeWithLRU<
  Args extends unknown[],
  Result extends NonNullable<unknown>,
>(
  f: (...args: Args) => Result,
  cacheFn: (...args: Args) => string,
  maxCacheSize: number = 100,
): LRUMemoizedFunction<Args, Result> {
  const cache = new LRUCache<string, Result>({ max: maxCacheSize })
  
  const memoized = (...args: Args): Result => {
    const key = cacheFn(...args)
    const cached = cache.get(key)
    if (cached !== undefined) {
      return cached
    }
    
    const result = f(...args)
    cache.set(key, result)
    return result
  }
  
  memoized.cache = {
    clear: () => cache.clear(),
    size: () => cache.size,
    delete: (key: string) => cache.delete(key),
    get: (key: string) => cache.peek(key),  // peek 不更新访问顺序
    has: (key: string) => cache.has(key),
  }
  
  return memoized
}
```

---

## 错误处理

### 文件：`src/utils/errors.ts`

#### 错误类型定义

```typescript
// 基础错误类
class ClaudeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = this.constructor.name
  }
}

// 中止错误
class AbortError extends Error {
  constructor(message?: string) {
    super(message)
    this.name = 'AbortError'
  }
}

// 配置解析错误
class ConfigParseError extends Error {
  filePath: string
  defaultConfig: unknown
  
  constructor(message: string, filePath: string, defaultConfig: unknown) {
    super(message)
    this.name = 'ConfigParseError'
    this.filePath = filePath
    this.defaultConfig = defaultConfig
  }
}

// Shell 错误
class ShellError extends Error {
  constructor(
    public readonly stdout: string,
    public readonly stderr: string,
    public readonly code: number,
    public readonly interrupted: boolean,
  ) {
    super('Shell command failed')
    this.name = 'ShellError'
  }
}

// 遥测安全错误
class TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS extends Error {
  readonly telemetryMessage: string
  
  constructor(message: string, telemetryMessage?: string) {
    super(message)
    this.name = 'TelemetrySafeError'
    this.telemetryMessage = telemetryMessage ?? message
  }
}
```

#### 错误处理工具函数

```typescript
// 中止错误检测
function isAbortError(e: unknown): boolean {
  return (
    e instanceof AbortError ||
    e instanceof APIUserAbortError ||
    (e instanceof Error && e.name === 'AbortError')
  )
}

// 错误消息提取
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// errno 代码提取
function getErrnoCode(e: unknown): string | undefined {
  if (e && typeof e === 'object' && 'code' in e && typeof e.code === 'string') {
    return e.code
  }
  return undefined
}

// ENOENT 检测
function isENOENT(e: unknown): boolean {
  return getErrnoCode(e) === 'ENOENT'
}

// 文件系统不可访问检测
function isFsInaccessible(e: unknown): e is NodeJS.ErrnoException {
  const code = getErrnoCode(e)
  return (
    code === 'ENOENT' ||  // 不存在
    code === 'EACCES' ||  // 权限拒绝
    code === 'EPERM' ||   // 操作不允许
    code === 'ENOTDIR' || // 不是目录
    code === 'ELOOP'      // 符号链接过多
  )
}

// Axios 错误分类
type AxiosErrorKind =
  | 'auth'      // 401/403
  | 'timeout'   // ECONNABORTED
  | 'network'   // ECONNREFUSED/ENOTFOUND
  | 'http'      // 其他 HTTP 错误
  | 'other'     // 非 Axios 错误

function classifyAxiosError(e: unknown): {
  kind: AxiosErrorKind
  status?: number
  message: string
} {
  const message = errorMessage(e)
  
  if (!e || typeof e !== 'object' || !('isAxiosError' in e) || !e.isAxiosError) {
    return { kind: 'other', message }
  }
  
  const err = e as { response?: { status?: number }, code?: string }
  const status = err.response?.status
  
  if (status === 401 || status === 403) {
    return { kind: 'auth', status, message }
  }
  if (err.code === 'ECONNABORTED') {
    return { kind: 'timeout', status, message }
  }
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
    return { kind: 'network', status, message }
  }
  return { kind: 'http', status, message }
}

// 短堆栈提取（用于工具结果）
function shortErrorStack(e: unknown, maxFrames = 5): string {
  if (!(e instanceof Error)) return String(e)
  if (!e.stack) return e.message
  
  const lines = e.stack.split('\n')
  const header = lines[0] ?? e.message
  const frames = lines.slice(1).filter(l => l.trim().startsWith('at '))
  
  if (frames.length <= maxFrames) return e.stack
  return [header, ...frames.slice(0, maxFrames)].join('\n')
}
```

---

## 拒绝跟踪

### 文件：`src/utils/permissions/denialTracking.ts`

```typescript
type DenialTrackingState = {
  consecutiveDenials: number  // 连续拒绝次数
  totalDenials: number        // 总拒绝次数
}

const DENIAL_LIMITS = {
  maxConsecutive: 3,  // 最大连续拒绝
  maxTotal: 20,       // 最大总拒绝
} as const

function recordDenial(state: DenialTrackingState): DenialTrackingState {
  return {
    ...state,
    consecutiveDenials: state.consecutiveDenials + 1,
    totalDenials: state.totalDenials + 1,
  }
}

function recordSuccess(state: DenialTrackingState): DenialTrackingState {
  if (state.consecutiveDenials === 0) return state
  return {
    ...state,
    consecutiveDenials: 0,
  }
}

function shouldFallbackToPrompting(state: DenialTrackingState): boolean {
  return (
    state.consecutiveDenials >= DENIAL_LIMITS.maxConsecutive ||
    state.totalDenials >= DENIAL_LIMITS.maxTotal
  )
}
```

---

*文档生成时间：2026-04-01*
