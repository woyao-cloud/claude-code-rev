# Yao Code 项目结构说明文档

## 项目概述

这是一个从 source map 逆向还原的 Yao Code 源码树，主要用于研究和理解 Yao Code 的内部架构。

**版本**: 999.0.0-restored  
**构建工具**: Bun 1.3.5+  
**语言**: TypeScript/JavaScript (ES Modules)

---

## 目录结构

```
claude-code-rev/
├── src/                          # 主要源代码目录
│   ├── bootstrap-entry.ts        # 启动入口点
│   ├── entrypoints/
│   │   └── cli.tsx               # CLI 主入口
│   ├── main.tsx                  # 主程序入口
│   ├── commands/                 # CLI 命令模块
│   ├── tools/                    # 工具实现
│   ├── services/                 # 服务层
│   ├── state/                    # 状态管理
│   ├── utils/                    # 工具函数
│   ├── constants/                # 常量定义
│   ├── types/                    # 类型定义
│   └── ...
├── shims/                        # 兼容层/降级实现
├── package.json                  # 项目配置
└── README.md                     # 项目说明
```

---

## 核心模块详解

### 1. 启动流程 (Bootstrap)

**文件**: `src/bootstrap-entry.ts` → `src/entrypoints/cli.tsx` → `src/main.tsx`

启动流程采用快速路径 (fast-path) 设计，对常用命令进行优化：

```
bootstrap-entry.ts
├── --version 快速路径 (零模块加载)
├── --dump-system-prompt 快速路径
├── --daemon-worker 快速路径
├── --remote-control 快速路径
├── --daemon 快速路径
├── --bg/--background 快速路径
├── --templates 快速路径
└── 完整 CLI 加载
```

**关键文件**:
- `src/bootstrap-entry.ts`: 启动入口，处理特殊标志
- `src/entrypoints/cli.tsx`: CLI 主入口，设置环境变量和特征标志
- `src/main.tsx`: 主程序，包含所有 CLI 命令定义和主循环

### 2. 命令系统 (Commands)

**目录**: `src/commands/`

命令系统采用模块化设计，每个命令独立实现：

| 命令 | 文件 | 功能 |
|------|------|------|
| `/help` | `commands/help/` | 帮助信息 |
| `/clear` | `commands/clear/` | 清除对话历史 |
| `/config` | `commands/config/` | 配置管理 |
| `/skills` | `commands/skills/` | 技能管理 |
| `/tasks` | `commands/tasks/` | 任务管理 |
| `/session` | `commands/session/` | 会话管理 |
| `/login` | `commands/login/` | 登录认证 |
| `/logout` | `commands/logout/` | 登出 |
| `/mcp` | `commands/mcp/` | MCP 服务器管理 |
| `/memory` | `commands/memory/` | 记忆管理 |
| `/init` | `commands/init.js` | 项目初始化 |
| `/commit` | `commands/commit.js` | Git 提交 |
| `/review` | `commands/review.js` | 代码审查 |
| `/teleport` | `commands/teleport/` | 远程会话 |

**核心文件**: `src/commands.ts` - 导出所有命令的注册表

### 3. 工具系统 (Tools)

**目录**: `src/tools/`

工具是模型可以调用的能力单元：

| 工具类别 | 工具名 | 文件 |
|----------|--------|------|
| **基础工具** | BashTool | `tools/BashTool/` |
| | FileReadTool | `tools/FileReadTool/` |
| | FileWriteTool | `tools/FileWriteTool/` |
| | FileEditTool | `tools/FileEditTool/` |
| | GlobTool | `tools/GlobTool/` |
| | GrepTool | `tools/GrepTool/` |
| **高级工具** | AgentTool | `tools/AgentTool/` |
| | SkillTool | `tools/SkillTool/` |
| | TaskCreateTool | `tools/TaskCreateTool/` |
| | TaskUpdateTool | `tools/TaskUpdateTool/` |
| | TodoWriteTool | `tools/TodoWriteTool/` |
| | WebSearchTool | `tools/WebSearchTool/` |
| | WebFetchTool | `tools/WebFetchTool/` |
| | LSPTool | `tools/LSPTool/` |
| **MCP 工具** | ListMcpResourcesTool | `tools/ListMcpResourcesTool/` |
| | ReadMcpResourceTool | `tools/ReadMcpResourceTool/` |
| **计划工具** | EnterPlanModeTool | `tools/EnterPlanModeTool/` |
| | ExitPlanModeV2Tool | `tools/ExitPlanModeTool/` |
| **工作树工具** | EnterWorktreeTool | `tools/EnterWorktreeTool/` |
| | ExitWorktreeTool | `tools/ExitWorktreeTool/` |

**核心文件**: `src/tools.ts` - 工具注册表和导出

### 4. 服务层 (Services)

**目录**: `src/services/`

| 服务 | 目录 | 功能 |
|------|------|------|
| **分析服务** | `analytics/` | GrowthBook, Statsig, 事件日志 |
| **API 服务** | `api/` | API 客户端，Bootstrap, 文件 API |
| **MCP 服务** | `mcp/` | MCP 客户端，服务器配置 |
| **插件服务** | `plugins/` | 插件管理，插件 CLI |
| **技能服务** | `skills/` | 技能加载，技能搜索 |
| **策略限制** | `policyLimits/` | 组织策略限制 |
| **远程管理** | `remoteManagedSettings/` | 远程设置管理 |
| **LSP 服务** | `lsp/` | 语言服务器管理 |

### 5. 状态管理 (State)

**目录**: `src/state/`

```
src/state/
├── store.ts              # 通用状态存储
├── AppStateStore.ts      # 应用状态
├── onChangeAppState.ts   # 状态变更处理
└── ...
```

**核心文件**: `src/bootstrap/state.ts` - 全局状态和会话管理

### 6. 工具函数 (Utils)

**目录**: `src/utils/`

主要工具模块：

| 模块 | 功能 |
|------|------|
| `auth.js` | 认证和令牌管理 |
| `config.js` | 配置系统 |
| `model/model.js` | 模型选择和配置 |
| `permissions/` | 权限管理 |
| `settings/` | 设置系统 |
| `plugins/` | 插件加载 |
| `telemetry/` | 遥测和日志 |
| `teleport/` | 远程会话 |
| `worktree.js` | Git 工作树 |
| `git.js` | Git 操作 |

### 7. 初始化流程 (Init)

**文件**: `src/entrypoints/init.ts`

初始化流程包括：
1. 配置系统启用
2. 环境变量应用
3. 优雅关闭设置
4. 遥测初始化
5. 策略限制加载
6. 远程设置加载

---

## 架构模式

### 特征标志系统 (Feature Flags)

项目使用 `feature()` 函数进行特征控制：

```typescript
import { feature } from 'bun:bundle';

// 条件性功能
if (feature('DAEMON')) {
  // 守护进程功能
}

if (feature('KAIROS')) {
  // 助手模式功能
}
```

### 懒加载模式

大量使用动态导入减少启动时间：

```typescript
const { main } = await import('../main.js');
```

### 条件性导出

使用 `require()` 进行条件性模块加载：

```typescript
const assistantModule = feature('KAIROS') 
  ? require('./assistant/index.js') 
  : null;
```

---

## 依赖关系

### 核心依赖

| 依赖 | 用途 |
|------|------|
| `@anthropic-ai/sdk` | Anthropic API 客户端 |
| `@modelcontextprotocol/sdk` | MCP 协议 |
| `ink` | React 终端 UI |
| `@commander-js/extra-typings` | CLI 命令解析 |
| `chalk` | 终端颜色 |
| `lodash-es` | 工具函数 |
| `zod` | 类型验证 |

### 本地 Shim 包

| 包 | 用途 |
|----|------|
| `@ant/claude-for-chrome-mcp` | Chrome MCP 集成 |
| `@ant/computer-use-*` | Computer Use 功能 |
| `color-diff-napi` | 颜色差异 (NAPI) |
| `modifiers-napi` | 修饰键 (NAPI) |
| `url-handler-napi` | URL 处理 (NAPI) |

---

## 运行方式

### 开发模式

```bash
bun install
bun run dev
```

### 查看版本

```bash
bun run version
```

### 查看帮助

```bash
bun run dev --help
```

---

## 重要注意事项

### 还原状态

此项目是从 source map 逆向还原的，存在以下限制：

1. **类型文件缺失**: 部分 `.d.ts` 文件可能不存在
2. **构建生成文件**: 构建时生成的文件可能不完整
3. **私有包**: 某些私有包包装层可能使用 shim 替代
4. **原生模块**: 原生绑定使用降级实现

### 当前状态

- ✅ `bun install` 成功
- ✅ `bun run version` 成功
- ✅ `bun run dev` 通过真实 CLI bootstrap 启动
- ⚠️ 部分模块仍包含恢复时的 fallback

---

## 扩展开发

### 添加新命令

1. 在 `src/commands/` 创建新目录
2. 实现命令逻辑并导出 `default`
3. 在 `src/commands.ts` 中注册

### 添加新工具

1. 在 `src/tools/` 创建新目录
2. 实现工具类，继承基础工具接口
3. 在 `src/tools.ts` 中注册

### 添加新服务

1. 在 `src/services/` 创建新目录
2. 实现服务接口
3. 在 `src/entrypoints/init.ts` 中初始化

---

## 相关文件

- `README.md` - 项目说明和运行方式
- `package.json` - 项目配置和依赖
- `src/bootstrap-entry.ts` - 启动入口
- `src/commands.ts` - 命令注册表
- `src/tools.ts` - 工具注册表
