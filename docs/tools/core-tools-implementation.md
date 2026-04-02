# 核心工具实现详解

## 概述

本文档深入分析 Claude Code 中核心工具的实现细节，包括 BashTool、AgentTool、FileEditTool 等关键工具的内部工作机制。

---

## 目录

1. [BashTool](#bashtool)
2. [AgentTool](#agenttool)
3. [FileEditTool](#fileedittool)
4. [FileReadTool](#filereadtool)
5. [GrepTool / GlobTool](#greptool--globtool)
6. [SkillTool](#skilltool)
7. [Task 相关工具](#task-相关工具)

---

## BashTool

**文件**: `src/tools/BashTool/BashTool.tsx`

### 功能描述

执行 Shell 命令的核心工具，支持：
- 命令执行和输出捕获
- 超时控制
- 后台任务
- 沙箱执行
- 权限检查

### 核心实现

```typescript
// 工具定义
export const BashTool = buildTool({
  name: BASH_TOOL_NAME,  // 'Bash'
  
  // 输入 Schema
  inputSchema: z.object({
    command: z.string().describe('要执行的命令'),
    description: z.string().describe('命令的简短描述'),
    timeout: z.number().optional().describe('超时时间 (毫秒)'),
    background: z.boolean().optional().describe('是否在后台运行'),
  }),
  
  // 执行方法
  async call(args, context, canUseTool, parentMessage, onProgress) {
    // 1. 验证命令
    const validationResult = await this.validateInput(args, context);
    if (!validationResult.result) {
      return { data: { error: validationResult.message } };
    }
    
    // 2. 检查权限
    const permissionResult = await this.checkPermissions(args, context);
    if (permissionResult.behavior === 'deny') {
      return { data: { error: 'Permission denied' } };
    }
    
    // 3. 执行命令
    const result = await executeBashCommand(args.command, {
      timeout: args.timeout,
      background: args.background,
      onProgress,
      abortSignal: context.abortController.signal,
    });
    
    // 4. 处理结果
    return {
      data: {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      },
    };
  },
  
  // 并发安全性检查
  isConcurrencySafe(input) {
    // 只读命令可并发执行
    const safeCommands = ['ls', 'cat', 'head', 'tail', 'grep', 'find', 'wc'];
    const baseCommand = input.command.split(/\s+/)[0];
    return safeCommands.includes(baseCommand);
  },
  
  // 只读检查
  isReadOnly(input) {
    const readOnlyCommands = ['ls', 'cat', 'head', 'tail', 'grep', 'find', 'wc', 'stat'];
    const baseCommand = input.command.split(/\s+/)[0];
    return readOnlyCommands.includes(baseCommand);
  },
  
  // 搜索/读取命令识别（用于 UI 折叠）
  isSearchOrReadCommand(input) {
    return isSearchOrReadBashCommand(input.command);
  },
});
```

### 命令解析和 AST 分析

```typescript
// src/tools/BashTool/bashCommandHelpers.ts

// 命令分割（处理管道和操作符）
export function splitCommandWithOperators(command: string): string[] {
  // 使用 shell-quote 解析命令，保留操作符
  // 例如："ls -la | grep .ts && echo done"
  // 返回：["ls", "-la", "|", "grep", ".ts", "&&", "echo", "done"]
}

// 搜索/读取命令识别
export function isSearchOrReadBashCommand(command: string): {
  isSearch: boolean;
  isRead: boolean;
  isList: boolean;
} {
  const BASH_SEARCH_COMMANDS = new Set(['find', 'grep', 'rg', 'ag', 'ack', 'locate', 'which', 'whereis']);
  const BASH_READ_COMMANDS = new Set(['cat', 'head', 'tail', 'less', 'more', 'wc', 'stat', 'file', 'strings', 'jq', 'awk', 'cut', 'sort', 'uniq', 'tr']);
  const BASH_LIST_COMMANDS = new Set(['ls', 'tree', 'du']);
  const BASH_SEMANTIC_NEUTRAL_COMMANDS = new Set(['echo', 'printf', 'true', 'false', ':']);
  
  // 解析命令管道，检查每个部分
  // 只有所有部分都是搜索/读取命令时，整体才被认为是搜索/读取命令
}
```

### 权限检查

```typescript
// src/tools/BashTool/bashPermissions.ts

export async function checkBashPermissions(
  command: string,
  context: ToolUseContext
): Promise<PermissionResult> {
  // 1. 检查危险命令
  const dangerousCommands = ['rm -rf', 'mkfs', 'dd', '> /dev/'];
  if (dangerousCommands.some(cmd => command.includes(cmd))) {
    return { behavior: 'ask', reason: '危险命令' };
  }
  
  // 2. 检查路径
  const paths = extractPathsFromCommand(command);
  for (const path of paths) {
    if (!isPathAllowed(path, context)) {
      return { behavior: 'deny', reason: '路径不在允许范围内' };
    }
  }
  
  // 3. 检查写操作
  if (isWriteOperation(command)) {
    return { behavior: 'ask', reason: '写操作需要确认' };
  }
  
  return { behavior: 'allow' };
}
```

### 后台任务管理

```typescript
// src/tasks/LocalShellTask/LocalShellTask.ts

export async function spawnShellTask(
  command: string,
  options: {
    background: boolean;
    timeout?: number;
    onProgress?: (progress: BashProgress) => void;
  }
): Promise<ExecResult> {
  if (options.background) {
    // 后台任务：创建独立进程组
    return runInBackground(command, options);
  } else {
    // 前台任务：等待完成
    return runInForeground(command, options);
  }
}

// 后台任务注册
export async function registerForeground(taskId: string): Promise<void> {
  // 将后台任务切换到前台
  // 用户可以看到实时输出并交互
}
```

---

## AgentTool

**文件**: `src/tools/AgentTool/AgentTool.tsx`

### 功能描述

启动子代理执行任务的工具，支持：
- 同步/异步执行
- 前台/后台模式
- 工作树隔离
- 远程执行
- 多代理协作（队友模式）

### 核心实现

```typescript
// 工具定义
export const AgentTool = buildTool({
  name: AGENT_TOOL_NAME,  // 'Agent'
  
  // 输入 Schema
  inputSchema: z.object({
    description: z.string().describe('任务的简短描述 (3-5 词)'),
    prompt: z.string().describe('要给代理的任务'),
    subagent_type: z.string().optional().describe('使用的代理类型'),
    model: z.enum(['sonnet', 'opus', 'haiku']).optional().describe('模型覆盖'),
    run_in_background: z.boolean().optional().describe('是否后台运行'),
    name: z.string().optional().describe('代理名称，用于 SendMessage 寻址'),
    team_name: z.string().optional().describe('团队名称'),
    mode: permissionModeSchema().optional().describe('权限模式'),
    isolation: z.enum(['worktree', 'remote']).optional().describe('隔离模式'),
    cwd: z.string().optional().describe('工作目录'),
  }),
  
  // 执行方法
  async call(args, context, canUseTool, parentMessage, onProgress) {
    // 1. 决定是否异步执行
    const forceAsync = shouldForceAsync(args, context);
    
    if (forceAsync || args.run_in_background) {
      // 异步执行
      return runAsyncAgent(args, context, onProgress);
    } else {
      // 同步执行
      return runSyncAgent(args, context, onProgress);
    }
  },
});
```

### 同步代理执行

```typescript
// src/tools/AgentTool/runAgent.ts

export async function runSyncAgent(
  args: AgentToolInput,
  context: ToolUseContext,
  onProgress: ToolCallProgress<AgentToolProgress>
): Promise<AgentToolResult> {
  // 1. 构建子代理上下文
  const childContext = createSubagentContext(context, {
    agentType: args.subagent_type || 'general-purpose',
    agentId: createAgentId(),
  });
  
  // 2. 准备系统提示
  const systemPrompt = await buildAgentSystemPrompt({
    type: args.subagent_type,
    tools: childContext.options.tools,
    commands: childContext.options.commands,
  });
  
  // 3. 准备消息历史
  const messages = buildForkedMessages(context.messages, {
    includePreviousToolResults: false,
  });
  
  // 4. 执行查询
  const result = await query({
    messages,
    systemPrompt,
    toolUseContext: childContext,
    maxTurns: args.subagent_type === 'explorer' ? 10 : 25,
  });
  
  // 5. 生成摘要
  const summary = await summarizeAgentExecution(result.messages);
  
  return {
    status: 'completed',
    prompt: args.prompt,
    summary,
  };
}
```

### 异步代理执行

```typescript
// src/tools/AgentTool/agentToolUtils.ts

export async function runAsyncAgent(
  args: AgentToolInput,
  context: ToolUseContext,
  onProgress: ToolCallProgress<AgentToolProgress>
): Promise<AsyncAgentOutput> {
  // 1. 注册异步代理任务
  const taskId = registerAsyncAgent({
    description: args.description,
    prompt: args.prompt,
    agentType: args.subagent_type,
    model: args.model,
    cwd: args.cwd,
  });
  
  // 2. 启动后台执行
  void executeAgentInBackground(taskId, {
    ...args,
    context,
  });
  
  // 3. 立即返回，不等待完成
  return {
    status: 'async_launched',
    agentId: taskId,
    description: args.description,
    prompt: args.prompt,
    outputFile: getTaskOutputPath(taskId),
  };
}
```

### 队友模式（多代理协作）

```typescript
// src/tools/shared/spawnMultiAgent.ts

export async function spawnTeammate(
  args: {
    name: string;
    prompt: string;
    team_name?: string;
    mode?: PermissionMode;
  },
  context: ToolUseContext
): Promise<TeammateSpawnedOutput> {
  // 1. 创建 tmux 会话
  const tmuxSession = await createTmuxSession({
    name: args.name,
    teamName: args.team_name,
  });
  
  // 2. 启动子进程
  const childProcess = spawn('claude', [
    '--agent',
    '--team', args.team_name,
    '--mode', args.mode || 'default',
  ], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  
  // 3. 附加到 tmux
  await attachToTmux(childProcess, tmuxSession);
  
  // 4. 返回代理信息
  return {
    status: 'teammate_spawned',
    teammate_id: generateTeammateId(),
    agent_id: generateAgentId(),
    name: args.name,
    tmux_session_name: tmuxSession.name,
    tmux_window_name: tmuxSession.window,
    tmux_pane_id: tmuxSession.pane,
  };
}
```

### 工作树隔离

```typescript
// src/tools/AgentTool/forkSubagent.ts

export async function createAgentWorktree(
  args: { isolation: 'worktree'; cwd?: string }
): Promise<{ worktreePath: string; cleanup: () => void }> {
  // 1. 获取 Git 根目录
  const gitRoot = await findGitRoot(args.cwd || process.cwd());
  
  // 2. 创建工作树
  const worktreeName = `agent-${Date.now()}`;
  const worktreePath = path.join(gitRoot, '.git/worktrees', worktreeName);
  
  await exec(`git worktree add ${worktreePath}`);
  
  // 3. 返回清理函数
  return {
    worktreePath,
    cleanup: async () => {
      await exec(`git worktree remove ${worktreePath}`);
    },
  };
}
```

---

## FileEditTool

**文件**: `src/tools/FileEditTool/FileEditTool.ts`

### 功能描述

文件编辑工具，使用 diff 模式进行文件修改。

### 核心实现

```typescript
// 工具定义
export const FileEditTool = buildTool({
  name: 'Edit',
  
  // 输入 Schema
  inputSchema: z.object({
    file_path: z.string().describe('要编辑的文件路径'),
    old_string: z.string().describe('要替换的原始内容'),
    new_string: z.string().describe('替换后的新内容'),
  }),
  
  // 执行方法
  async call(args, context, canUseTool) {
    // 1. 验证文件存在
    const fileExists = await fs.exists(args.file_path);
    if (!fileExists) {
      return { data: { error: '文件不存在' } };
    }
    
    // 2. 读取文件内容
    const content = await fs.readFile(args.file_path, 'utf-8');
    
    // 3. 查找并替换
    const index = content.indexOf(args.old_string);
    if (index === -1) {
      return { 
        data: { 
          error: '未找到要替换的内容',
          hint: generateSimilarContentHint(content, args.old_string),
        } 
      };
    }
    
    // 4. 应用编辑
    const newContent = content.replace(args.old_string, args.new_string);
    await fs.writeFile(args.file_path, newContent, 'utf-8');
    
    // 5. 更新文件历史
    if (fileHistoryEnabled()) {
      fileHistoryTrackEdit({
        path: args.file_path,
        oldContent: content,
        newContent: newContent,
      });
    }
    
    // 6. 通知 VSCode (如果安装了 MCP)
    await notifyVscodeFileUpdated(args.file_path);
    
    return {
      data: {
        success: true,
        path: args.file_path,
        changes: computeDiff(content, newContent),
      },
    };
  },
  
  // 只读检查
  isReadOnly() {
    return false;  // 编辑操作总是写操作
  },
  
  // 破坏性检查
  isDestructive(input) {
    // 如果新内容为空，视为删除操作
    return input.new_string === '';
  },
});
```

### Diff 生成

```typescript
// src/tools/FileEditTool/utils.ts

export function computeDiff(oldContent: string, newContent: string): DiffResult {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  
  const diff = [];
  let i = 0, j = 0;
  
  while (i < oldLines.length || j < newLines.length) {
    if (i >= oldLines.length) {
      diff.push({ type: 'add', line: j, content: newLines[j] });
      j++;
    } else if (j >= newLines.length) {
      diff.push({ type: 'remove', line: i, content: oldLines[i] });
      i++;
    } else if (oldLines[i] === newLines[j]) {
      i++;
      j++;
    } else {
      // 简单替换检测
      diff.push({ type: 'remove', line: i, content: oldLines[i] });
      diff.push({ type: 'add', line: j, content: newLines[j] });
      i++;
      j++;
    }
  }
  
  return {
    hunks: groupDiffIntoHunks(diff),
    stats: {
      additions: diff.filter(d => d.type === 'add').length,
      deletions: diff.filter(d => d.type === 'remove').length,
    },
  };
}
```

---

## FileReadTool

**文件**: `src/tools/FileReadTool/FileReadTool.ts`

### 功能描述

读取文件内容的工具，支持：
- 大文件分块读取
- 图片处理
- 编码检测
- 令牌限制

### 核心实现

```typescript
// 工具定义
export const FileReadTool = buildTool({
  name: 'Read',
  
  // 输入 Schema
  inputSchema: z.object({
    path: z.string().describe('要读取的文件路径'),
    offset: z.number().optional().describe('起始行号'),
    limit: z.number().optional().describe('最大行数'),
  }),
  
  // 执行方法
  async call(args, context) {
    // 1. 验证路径
    const resolvedPath = safeResolvePath(args.path, context);
    
    // 2. 检查文件存在
    if (!await fs.exists(resolvedPath)) {
      return { data: { error: '文件不存在' } };
    }
    
    // 3. 检查文件大小
    const stats = await fs.stat(resolvedPath);
    if (stats.size > MAX_FILE_SIZE) {
      return { 
        data: { 
          error: '文件过大',
          suggestion: `使用 offset/limit 参数或 Bash head/tail 命令`,
        } 
      };
    }
    
    // 4. 检测编码
    const encoding = await detectFileEncoding(resolvedPath);
    
    // 5. 读取内容
    let content: string;
    if (args.offset !== undefined || args.limit !== undefined) {
      content = await readLines(resolvedPath, {
        offset: args.offset,
        limit: args.limit,
      });
    } else {
      content = await fs.readFile(resolvedPath, encoding);
    }
    
    // 6. 检查是否超过令牌限制
    const tokenCount = estimateTokens(content);
    if (tokenCount > MAX_READ_TOKENS) {
      return {
        data: {
          error: '内容超过令牌限制',
          suggestion: `文件约 ${tokenCount} tokens，限制为 ${MAX_READ_TOKENS}`,
          preview: content.slice(0, 10000),
        },
      };
    }
    
    // 7. 更新文件状态缓存
    context.readFileState.set(resolvedPath, {
      content,
      mtime: stats.mtimeMs,
      size: stats.size,
    });
    
    return {
      data: {
        content,
        path: resolvedPath,
        encoding,
        lineCount: content.split('\n').length,
      },
    };
  },
  
  // 并发安全性
  isConcurrencySafe() {
    return true;  // 读操作可并发
  },
  
  // 只读检查
  isReadOnly() {
    return true;
  },
});
```

### 图片处理

```typescript
// src/tools/FileReadTool/imageProcessor.ts

export async function processImageFile(
  path: string
): Promise<{ type: 'image'; source: { type: 'base64'; media_type: string; data: string } }> {
  // 1. 读取图片
  const buffer = await fs.readFile(path);
  
  // 2. 检测媒体类型
  const mediaType = await detectImageType(buffer);
  
  // 3. 调整大小（如果过大）
  const resizedBuffer = await resizeImageIfNeeded(buffer, {
    maxWidth: 2048,
    maxHeight: 2048,
    maxFileSize: 10 * 1024 * 1024,  // 10MB
  });
  
  // 4. 转换为 base64
  const base64Data = resizedBuffer.toString('base64');
  
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaType,
      data: base64Data,
    },
  };
}
```

---

## GrepTool / GlobTool

### GrepTool

**文件**: `src/tools/GrepTool/GrepTool.ts`

```typescript
export const GrepTool = buildTool({
  name: 'Grep',
  
  inputSchema: z.object({
    pattern: z.string().describe('正则表达式模式'),
    path: z.string().optional().describe('搜索目录'),
    include: z.string().optional().describe('文件匹配模式 (如 *.ts)'),
    exclude: z.string().optional().describe('排除模式'),
  }),
  
  async call(args, context) {
    // 使用 ripgrep 执行搜索
    const results = await runRipgrep({
      pattern: args.pattern,
      path: args.path || '.',
      include: args.include,
      exclude: args.exclude || context.globExclusions,
    });
    
    return {
      data: {
        matches: results.map(r => ({
          file: r.file,
          line: r.line,
          column: r.column,
          content: r.content,
        })),
        totalMatches: results.length,
      },
    };
  },
  
  isConcurrencySafe() {
    return true;
  },
  
  isReadOnly() {
    return true;
  },
  
  isSearchOrReadCommand() {
    return { isSearch: true, isRead: false };
  },
});
```

### GlobTool

**文件**: `src/tools/GlobTool/GlobTool.ts`

```typescript
export const GlobTool = buildTool({
  name: 'Glob',
  
  inputSchema: z.object({
    pattern: z.string().describe('Glob 模式 (如 **/*.ts)'),
    path: z.string().optional().describe('搜索目录'),
  }),
  
  async call(args, context) {
    const results = await runGlob({
      pattern: args.pattern,
      path: args.path || '.',
      limit: context.globLimits?.maxResults || 1000,
    });
    
    return {
      data: {
        files: results,
        totalFiles: results.length,
      },
    };
  },
  
  isConcurrencySafe() {
    return true;
  },
  
  isReadOnly() {
    return true;
  },
  
  isSearchOrReadCommand() {
    return { isSearch: true, isRead: false };
  },
});
```

---

## SkillTool

**文件**: `src/tools/SkillTool/SkillTool.ts`

### 功能描述

技能调用工具，将技能展开为 prompt 发送给模型。

### 核心实现

```typescript
// 工具定义
export const SkillTool = buildTool({
  name: 'Skill',
  
  // 输入 Schema
  inputSchema: z.object({
    skill: z.string().describe('技能名称'),
    args: z.record(z.unknown()).optional().describe('技能参数'),
  }),
  
  // 执行方法
  async call(args, context) {
    // 1. 查找技能
    const skills = await getSkillToolCommands(context.cwd);
    const skill = skills.find(s => s.name === args.skill);
    
    if (!skill) {
      return {
        data: {
          error: `技能 ${args.skill} 不存在`,
          availableSkills: skills.map(s => s.name),
        },
      };
    }
    
    // 2. 获取技能 prompt
    const prompt = await skill.getPromptForCommand(args.args, {
      cwd: context.cwd,
      commands: context.options.commands,
    });
    
    // 3. 创建用户消息
    const userMessage = createUserMessage({
      content: prompt,
    });
    
    return {
      data: {
        skill: args.skill,
        expanded: true,
      },
      newMessages: [userMessage],
    };
  },
});
```

### 技能发现

```typescript
// src/skills/loadSkillsDir.ts

export async function getSkillDirCommands(cwd: string): Promise<Command[]> {
  const skillsDir = path.join(cwd, '.claude', 'skills');
  
  if (!await fs.exists(skillsDir)) {
    return [];
  }
  
  const skills: Command[] = [];
  const files = await fs.readdir(skillsDir, { recursive: true });
  
  for (const file of files) {
    if (file.endsWith('.md') || file.endsWith('.txt')) {
      const skillPath = path.join(skillsDir, file);
      const content = await fs.readFile(skillPath, 'utf-8');
      
      // 解析 frontmatter
      const { frontmatter, body } = parseFrontmatter(content);
      
      skills.push({
        type: 'prompt',
        name: path.basename(file, path.extname(file)),
        description: frontmatter.description || body.split('\n')[0],
        source: 'skills',
        loadedFrom: 'skills',
        async getPromptForCommand(args, context) {
          return buildSkillPrompt(body, args);
        },
      });
    }
  }
  
  return skills;
}
```

---

## Task 相关工具

### TaskCreateTool

**文件**: `src/tools/TaskCreateTool/TaskCreateTool.ts`

```typescript
export const TaskCreateTool = buildTool({
  name: 'TaskCreate',
  
  inputSchema: z.object({
    subject: z.string().describe('任务标题'),
    description: z.string().describe('任务描述'),
    activeForm: z.string().optional().describe('进行中的形式 (用于 spinner)'),
  }),
  
  async call(args, context) {
    const taskId = generateTaskId();
    
    // 更新应用状态
    context.setAppState(prev => ({
      ...prev,
      tasks: {
        ...prev.tasks,
        [taskId]: {
          id: taskId,
          subject: args.subject,
          description: args.description,
          activeForm: args.activeForm || args.subject,
          status: 'pending',
          createdAt: Date.now(),
        },
      },
    }));
    
    return {
      data: {
        taskId,
        status: 'created',
      },
    };
  },
});
```

### TaskUpdateTool

```typescript
export const TaskUpdateTool = buildTool({
  name: 'TaskUpdate',
  
  inputSchema: z.object({
    taskId: z.string().describe('任务 ID'),
    subject: z.string().optional().describe('新标题'),
    description: z.string().optional().describe('新描述'),
    status: z.enum(['pending', 'in_progress', 'completed', 'deleted']).optional(),
  }),
  
  async call(args, context) {
    const { taskId, ...updates } = args;
    
    context.setAppState(prev => ({
      ...prev,
      tasks: {
        ...prev.tasks,
        [taskId]: {
          ...prev.tasks[taskId],
          ...updates,
        },
      },
    }));
    
    return {
      data: {
        taskId,
        status: 'updated',
      },
    };
  },
});
```

### TaskListTool

```typescript
export const TaskListTool = buildTool({
  name: 'TaskList',
  
  inputSchema: z.object({
    status: z.enum(['pending', 'in_progress', 'completed']).optional(),
  }),
  
  async call(args, context) {
    const appState = context.getAppState();
    const tasks = Object.values(appState.tasks);
    
    const filteredTasks = args.status
      ? tasks.filter(t => t.status === args.status)
      : tasks;
    
    return {
      data: {
        tasks: filteredTasks.map(t => ({
          id: t.id,
          subject: t.subject,
          status: t.status,
          activeForm: t.activeForm,
        })),
        total: filteredTasks.length,
      },
    };
  },
});
```

---

## 相关文件索引

| 工具 | 文件路径 |
|------|----------|
| BashTool | `src/tools/BashTool/BashTool.tsx` |
| AgentTool | `src/tools/AgentTool/AgentTool.tsx` |
| FileEditTool | `src/tools/FileEditTool/FileEditTool.ts` |
| FileReadTool | `src/tools/FileReadTool/FileReadTool.ts` |
| FileWriteTool | `src/tools/FileWriteTool/FileWriteTool.ts` |
| GrepTool | `src/tools/GrepTool/GrepTool.ts` |
| GlobTool | `src/tools/GlobTool/GlobTool.ts` |
| SkillTool | `src/tools/SkillTool/SkillTool.ts` |
| TaskCreateTool | `src/tools/TaskCreateTool/TaskCreateTool.ts` |
| TaskUpdateTool | `src/tools/TaskUpdateTool/TaskUpdateTool.ts` |
| TaskListTool | `src/tools/TaskListTool/TaskListTool.ts` |

---

*文档生成时间：2026-04-01*
