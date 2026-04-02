# Prompt 代码提取设计文档

**日期**: 2026-04-02  
**状态**: 设计已批准  
**方案**: 方案 A - 按功能模块提取

---

## 1. 背景与目标

### 1.1 问题陈述

当前 Claude Code 项目中，Prompt 相关代码分散在多个目录中：

| 类别 | 文件路径 | 问题 |
|------|---------|------|
| 核心 Prompt | `src/constants/prompts.ts` (13KB+) | 文件过大，职责混杂 |
| 系统 Prompt | `src/utils/systemPrompt.ts` | 依赖分散，难以独立测试 |
| 消息处理 | `src/utils/messages.ts` (10KB+) | 包含过多非 Prompt 相关逻辑 |
| Tool Prompts | `src/tools/*/prompt.ts` (50+ 文件) | 分散在各工具目录 |
| 生成流程 | `processSlashCommand.tsx`, `forkedAgent.ts` | 与 UI 逻辑耦合 |

这种分散结构导致：
- 新成员难以理解 Prompt 生成全貌
- 修改 Prompt 逻辑需要跨多个文件
- 难以进行统一的 Prompt 优化和测试

### 1.2 目标

1. **集中管理**：将所有 Prompt 相关代码集中到 `src/prompt/` 目录
2. **清晰边界**：定义明确的模块职责和接口
3. **零中断迁移**：迁移过程中代码始终可运行
4. **可独立测试**：Prompt 模块可脱离主程序进行单元测试

---

## 2. 架构设计

### 2.1 目标目录结构

```
src/prompt/
├── core/                        # 核心 Prompt 构建
│   ├── index.ts                 # 统一导出
│   ├── types.ts                 # 类型定义（原 systemPromptType.ts）
│   ├── systemPrompt.ts          # 系统 Prompt 构建（原 systemPrompt.ts）
│   └── sections.ts              # Prompt 分段构建（原 systemPromptSections.ts）
│
├── generation/                  # Prompt 生成流程
│   ├── index.ts                 # 统一导出
│   ├── slashCommand.ts          # Slash Command 处理
│   ├── skillLoader.ts           # Skill/Command 加载
│   └── forkedContext.ts         # Fork 上下文准备
│
├── tools/                       # Prompt 工具函数
│   ├── index.ts                 # 统一导出
│   ├── editor.ts                # 外部编辑器（原 promptEditor.ts）
│   ├── shellExecution.ts        # Shell 命令执行（原 promptShellExecution.ts）
│   └── category.ts              # Prompt 分类（原 promptCategory.ts）
│
├── messages/                    # 消息处理
│   ├── index.ts                 # 统一导出
│   ├── creation.ts              # 消息创建相关函数
│   ├── normalization.ts         # 消息规范化相关函数
│   └── types.ts                 # 消息类型定义
│
└── ui/                          # UI 组件
    ├── index.ts                 # 统一导出
    └── overlayContext.tsx       # Prompt 浮层 Context
```

### 2.2 模块职责

| 模块 | 职责 | 主要导出 |
|------|------|---------|
| `core` | Prompt 类型定义和系统 Prompt 构建 | `buildEffectiveSystemPrompt()`, `SystemPrompt` |
| `generation` | Prompt 生成流程 | `prepareForkedCommandContext()`, `getMessagesForPromptSlashCommand()` |
| `tools` | Prompt 相关工具函数 | `editPromptInEditor()`, `executeShellCommandsInPrompt()` |
| `messages` | 消息创建和规范化 | `createUserMessage()`, `normalizeMessages()` |
| `ui` | Prompt 相关 UI 组件 | `PromptOverlayProvider`, `useSetPromptOverlay()` |

### 2.3 依赖关系

```
┌─────────────────────────────────────────────────────────────┐
│                      src/prompt/                             │
│  ┌──────────┐    ┌──────────────┐    ┌─────────────────┐   │
│  │  core    │───>│  generation  │    │     tools       │   │
│  │ (基础层) │    │   (业务层)    │    │   (工具层)      │   │
│  └──────────┘    └──────────────┘    └─────────────────┘   │
│       │                  │                      │           │
│       │                  ▼                      │           │
│       │           ┌──────────────┐              │           │
│       │           │   messages   │◄─────────────┘           │
│       │           │   (消息层)    │                          │
│       │           └──────────────┘                          │
│       │                  │                                   │
│       ▼                  ▼                                   │
│  ┌──────────┐    ┌──────────────┐                           │
│  │   ui     │    │   (外部依赖)  │                           │
│  │ (UI 层)   │    │  Tool, types │                           │
│  └──────────┘    └──────────────┘                           │
└─────────────────────────────────────────────────────────────┘
```

**依赖规则**：
- `core` 不依赖任何其他 prompt 模块
- `generation` 可依赖 `core` 和 `tools`
- `messages` 可依赖 `core` 和 `types`
- `ui` 可依赖 `messages`
- `tools` 不依赖其他 prompt 模块

---

## 3. 迁移策略

### 3.1 总体策略：移动 + 重定向

采用 **转发器模式（Forwarder Pattern）** 保证迁移过程中代码始终可运行：

1. **移动文件** 到新位置
2. **在旧位置创建 re-export 文件**（转发器）
3. **逐步更新调用方** import 路径
4. **全部完成后删除** 转发器文件

### 3.2 转发器示例

```typescript
// 移动后：src/utils/systemPrompt.ts (新内容 - 转发器)
export {
  buildEffectiveSystemPrompt,
  asSystemPrompt,
  type SystemPrompt,
} from '../prompt/core/systemPrompt.js';
```

调用方无需立即修改，仍可使用旧路径：
```typescript
// 调用方代码（暂时不变）
import { buildEffectiveSystemPrompt } from '../utils/systemPrompt.js';
```

### 3.3 迁移阶段划分

共分为 **6 个阶段**，每个阶段独立 PR：

| 阶段 | 内容 | 预计文件数 | 依赖 |
|------|------|-----------|------|
| **阶段 1** | 类型定义迁移 | 1 文件 | 无 |
| **阶段 2** | 核心 Prompt 构建 | 3 文件 | 阶段 1 |
| **阶段 3** | Prompt 工具函数 | 3 文件 | 无 |
| **阶段 4** | 消息处理模块 | 3 文件 | 阶段 1 |
| **阶段 5** | 生成流程 | 3 文件 | 阶段 2, 3, 4 |
| **阶段 6** | UI 组件和清理 | 2 文件 + 删除转发器 | 阶段 4 |

---

## 4. 详细迁移计划

### 阶段 1：类型定义迁移

**目标文件**：
- `src/utils/systemPromptType.ts` → `src/prompt/core/types.ts`

**步骤**：
1. 创建 `src/prompt/core/` 目录
2. 移动 `systemPromptType.ts` 到新位置
3. 在旧位置创建转发器
4. 更新本阶段内可完成的引用
5. 提交 PR #1

**验证**：
- `bun run build` 成功
- 运行基础测试

---

### 阶段 2：核心 Prompt 构建

**目标文件**：
- `src/utils/systemPrompt.ts` → `src/prompt/core/systemPrompt.ts`
- `src/utils/systemPromptSections.ts` → `src/prompt/core/sections.ts`
- `src/constants/prompts.ts` → 拆分到 `src/prompt/core/`

**步骤**：
1. 移动文件到新位置
2. 在旧位置创建转发器
3. 更新直接引用（`AgentTool.tsx`, `resumeAgent.ts` 等）
4. 提交 PR #2

**难点**：
- `prompts.ts` 文件较大，需要分析依赖后拆分

---

### 阶段 3：Prompt 工具函数

**目标文件**：
- `src/utils/promptEditor.ts` → `src/prompt/tools/editor.ts`
- `src/utils/promptShellExecution.ts` → `src/prompt/tools/shellExecution.ts`
- `src/utils/promptCategory.ts` → `src/prompt/tools/category.ts`

**步骤**：
1. 移动文件到新位置
2. 在旧位置创建转发器
3. 更新引用
4. 提交 PR #3

---

### 阶段 4：消息处理模块

**目标文件**：
- 从 `src/utils/messages.ts` 提取相关函数到 `src/prompt/messages/`

**提取内容**：
- `createUserMessage()`, `createAssistantMessage()` 等创建函数
- `normalizeMessages()`, `prepareUserContent()` 等规范化函数
- 消息类型定义

**步骤**：
1. 创建 `src/prompt/messages/` 目录
2. 提取相关函数到新文件
3. 在 `messages.ts` 中创建转发导出
4. 更新引用
5. 提交 PR #4

---

### 阶段 5：生成流程

**目标文件**：
- `src/utils/processUserInput/processSlashCommand.tsx` → 提取到 `src/prompt/generation/slashCommand.ts`
- `src/utils/forkedAgent.ts` → `src/prompt/generation/forkedContext.ts`
- `src/tools/SkillTool/SkillTool.ts` → 提取到 `src/prompt/generation/skillLoader.ts`

**步骤**：
1. 分析依赖，确定提取边界
2. 移动/提取代码到新位置
3. 更新引用
4. 提交 PR #5

---

### 阶段 6：UI 组件和清理

**目标文件**：
- `src/context/promptOverlayContext.tsx` → `src/prompt/ui/overlayContext.tsx`

**清理工作**：
1. 删除所有转发器文件
2. 全局搜索确认无旧路径引用
3. 更新 `src/utils/` 目录的 index 导出
4. 提交 PR #6（最终清理）

---

## 5. 风险与缓解

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|----------|
| 遗漏引用导致运行时错误 | 中 | 高 | 每个阶段后运行完整测试套件 + TypeScript 类型检查 |
| 循环依赖 | 低 | 中 | 严格遵循依赖规则，使用 `madge` 工具检测 |
| 转发器被意外删除 | 低 | 高 | 在清理阶段前，禁止删除任何转发器文件 |
| 测试覆盖率不足 | 中 | 高 | 阶段 4 完成后，补充 Prompt 模块专项测试 |

---

## 6. 验证标准

### 6.1 每阶段验证

- [ ] TypeScript 编译通过 (`bun run build`)
- [ ] 现有测试通过
- [ ] 无 ESLint 错误
- [ ] 基础功能手动验证

### 6.2 最终验证（阶段 6 完成后）

- [ ] 所有转发器文件已删除
- [ ] 无 `src/utils/systemPrompt*` 等旧路径引用
- [ ] `src/prompt/` 目录自包含（无外部依赖）
- [ ] 新增 Prompt 模块单元测试（目标覆盖率 80%+）

---

## 7. 成功指标

| 指标 | 当前状态 | 目标状态 |
|------|----------|----------|
| Prompt 相关文件集中度 | 分散在 6+ 目录 | 集中在 `src/prompt/` |
| 新成员理解成本 | 高（需跨多文件） | 低（单一目录） |
| 可测试性 | 低（耦合严重） | 高（模块独立） |
| 代码可维护性 | 中 | 高 |

---

## 8. 附录

### 8.1 关键文件引用统计

| 文件 | 引用次数 | 主要引用方 |
|------|---------|-----------|
| `systemPrompt.ts` | ~15 | AgentTool, REPL, commands |
| `messages.ts` | ~50+ | 几乎所有工具和服务 |
| `forkedAgent.ts` | ~5 | SkillTool, processSlashCommand |
| `promptOverlayContext.tsx` | ~3 | FullscreenLayout, PromptInput |

### 8.2 相关文件

- [ ] `docs/prompts/prompt-generation-analysis.md` - Prompt 生成流程分析
- [ ] `docs/prompts/prompt-execution-flow.md` - Prompt 执行流程图
- [ ] `src/utils/systemPrompt.ts` - 当前系统 Prompt 实现
- [ ] `src/utils/messages.ts` - 当前消息处理实现

---

**设计审批**:

- [ ] 用户审批通过
- [ ] 准备进入实现计划阶段