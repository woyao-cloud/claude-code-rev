# Prompt 代码提取实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将分散的 Prompt 相关代码提取到 `src/prompt/` 目录，采用转发器模式保证迁移过程中代码始终可运行。

**Architecture:** 按功能模块拆分为 5 个子目录（core, generation, tools, messages, ui），通过 6 个阶段渐进式迁移，每阶段独立 PR。

**Tech Stack:** TypeScript, Bun, React (for UI components)

---

## 阶段 1：类型定义迁移

### Task 1.1: 创建目标目录结构

**Files:**
- Create: `src/prompt/core/`
- Create: `src/prompt/generation/`
- Create: `src/prompt/tools/`
- Create: `src/prompt/messages/`
- Create: `src/prompt/ui/`

- [ ] **Step 1: 创建目录结构**

```bash
mkdir -p src/prompt/core src/prompt/generation src/prompt/tools src/prompt/messages src/prompt/ui
```

Expected: 5 个新目录创建成功

- [ ] **Step 2: 创建各目录的 index.ts 占位文件**

```typescript
// src/prompt/core/index.ts
// Core prompt building utilities
export {}
```

```typescript
// src/prompt/generation/index.ts
// Prompt generation flow
export {}
```

```typescript
// src/prompt/tools/index.ts
// Prompt utility tools
export {}
```

```typescript
// src/prompt/messages/index.ts
// Message creation and normalization
export {}
```

```typescript
// src/prompt/ui/index.ts
// Prompt UI components
export {}
```

- [ ] **Step 3: 提交**

```bash
git add src/prompt/
git commit -m "chore: create prompt module directory structure"
```

---

### Task 1.2: 迁移 systemPromptType.ts

**Files:**
- Move: `src/utils/systemPromptType.ts` → `src/prompt/core/types.ts`
- Modify: `src/utils/systemPromptType.ts` (创建转发器)
- Update: 33 个引用文件

- [ ] **Step 1: 复制文件到新位置**

```typescript
// src/prompt/core/types.ts
/**
 * Branded type for system prompt arrays.
 *
 * This module is intentionally dependency-free so it can be imported
 * from anywhere without risking circular initialization issues.
 */

export type SystemPrompt = readonly string[] & {
  readonly __brand: 'SystemPrompt'
}

export function asSystemPrompt(value: readonly string[]): SystemPrompt {
  return value as SystemPrompt
}
```

- [ ] **Step 2: 在旧位置创建转发器**

```typescript
// src/utils/systemPromptType.ts
// Forwarder: migrated to src/prompt/core/types.ts
export { asSystemPrompt, type SystemPrompt } from '../prompt/core/types.js';
```

- [ ] **Step 3: 验证 TypeScript 编译**

```bash
bun run build
```

Expected: 编译成功，无错误

- [ ] **Step 4: 提交**

```bash
git add src/prompt/core/types.ts src/utils/systemPromptType.ts
git commit -m "refactor: migrate systemPromptType to prompt/core/types"
```

---

### Task 1.3: 更新直接引用（第 1 批）

**目标文件**: 更新 10 个直接引用 `systemPromptType.ts` 的文件

**Files:**
- Modify: `src/utils/systemPrompt.ts`
- Modify: `src/utils/forkedAgent.ts`
- Modify: `src/tools/AgentTool/runAgent.ts`
- Modify: `src/tools/AgentTool/AgentTool.tsx`
- Modify: `src/services/api/claude.ts`
- Modify: `src/Tool.ts`
- Modify: `src/QueryEngine.ts`
- Modify: `src/query.ts`
- Modify: `src/components/Feedback.tsx`
- Modify: `src/commands/btw/btw.tsx`

- [ ] **Step 1: 更新 import 路径**

对每个文件，将：
```typescript
import { asSystemPrompt, type SystemPrompt } from './systemPromptType.js';
// 或
import { asSystemPrompt, type SystemPrompt } from '../utils/systemPromptType.js';
```

改为：
```typescript
import { asSystemPrompt, type SystemPrompt } from '../prompt/core/types.js';
// 或相应路径
```

- [ ] **Step 2: 验证 TypeScript 编译**

```bash
bun run build
```

Expected: 编译成功

- [ ] **Step 3: 提交**

```bash
git add src/utils/systemPrompt.ts src/utils/forkedAgent.ts src/tools/AgentTool/runAgent.ts src/tools/AgentTool/AgentTool.tsx src/services/api/claude.ts src/Tool.ts src/QueryEngine.ts src/query.ts src/components/Feedback.tsx src/commands/btw/btw.tsx
git commit -m "refactor: update imports to use prompt/core/types"
```

---

### Task 1.4: 更新剩余引用（第 2 批）

**目标文件**: 更新剩余 23 个引用文件

**Files:**
- `src/utils/teleport.tsx`
- `src/utils/swarm/inProcessRunner.ts`
- `src/utils/shell/prefix.ts`
- `src/utils/sessionTitle.ts`
- `src/utils/queryContext.ts`
- `src/utils/mcp/dateTimeParser.ts`
- `src/utils/hooks/skillImprovement.ts`
- `src/utils/hooks/postSamplingHooks.ts`
- `src/utils/hooks/execAgentHook.ts`
- `src/utils/hooks/execPromptHook.ts`
- `src/utils/hooks/apiQueryHookHelper.ts`
- `src/utils/api.ts`
- `src/tools/WebFetchTool/utils.ts`
- `src/tools/WebSearchTool/WebSearchTool.ts`
- `src/tools/AgentTool/resumeAgent.ts`
- `src/services/toolUseSummary/toolUseSummaryGenerator.ts`
- `src/services/compact/compact.ts`
- `src/services/awaySummary.ts`
- `src/services/SessionMemory/sessionMemory.ts`
- `src/query/stopHooks.ts`
- `src/components/agents/generateAgent.ts`
- `src/commands/rename/generateSessionName.ts`
- `src/commands/insights.ts`

- [ ] **Step 1: 批量更新 import 路径**

使用 `ast-grep` 或全局搜索替换：
```bash
# 查找所有引用
grep -r "from.*systemPromptType" src/ --include="*.ts" --include="*.tsx"
```

- [ ] **Step 2: 验证 TypeScript 编译**

```bash
bun run build
```

Expected: 编译成功

- [ ] **Step 3: 运行测试**

```bash
bun test
```

Expected: 所有测试通过

- [ ] **Step 4: 提交**

```bash
git add src/utils/teleport.tsx src/utils/swarm/inProcessRunner.ts ...
git commit -m "refactor: update remaining imports to use prompt/core/types (stage 1 complete)"
```

---

## 阶段 2：核心 Prompt 构建迁移

### Task 2.1: 迁移 systemPromptSections.ts

**Files:**
- Move: `src/utils/systemPromptSections.ts` → `src/prompt/core/sections.ts`
- Modify: `src/utils/systemPromptSections.ts` (创建转发器)

- [ ] **Step 1: 读取源文件内容**

```bash
cat src/utils/systemPromptSections.ts
```

- [ ] **Step 2: 复制到新位置**

```typescript
// src/prompt/core/sections.ts
// 从原文件复制全部内容
// 更新 import 路径指向新的 types.ts 位置
```

- [ ] **Step 3: 创建转发器**

```typescript
// src/utils/systemPromptSections.ts
// Forwarder: migrated to src/prompt/core/sections.ts
export {
  systemPromptSection,
  DANGEROUS_uncachedSystemPromptSection,
  resolveSystemPromptSections,
} from '../prompt/core/sections.js';
```

- [ ] **Step 4: 验证编译**

```bash
bun run build
```

- [ ] **Step 5: 提交**

```bash
git add src/prompt/core/sections.ts src/utils/systemPromptSections.ts
git commit -m "refactor: migrate systemPromptSections to prompt/core/sections"
```

---

### Task 2.2: 迁移 systemPrompt.ts

**Files:**
- Move: `src/utils/systemPrompt.ts` → `src/prompt/core/systemPrompt.ts`
- Modify: `src/utils/systemPrompt.ts` (创建转发器)

- [ ] **Step 1: 读取源文件内容**

```bash
cat src/utils/systemPrompt.ts
```

- [ ] **Step 2: 复制到新位置并更新 import**

```typescript
// src/prompt/core/systemPrompt.ts
import { feature } from 'bun:bundle'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import type { ToolUseContext } from '../Tool.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import { isBuiltInAgent } from '../tools/AgentTool/loadAgentsDir.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { asSystemPrompt, type SystemPrompt } from './types.js'
// ... 其余内容
```

- [ ] **Step 3: 创建转发器**

```typescript
// src/utils/systemPrompt.ts
// Forwarder: migrated to src/prompt/core/systemPrompt.ts
export {
  buildEffectiveSystemPrompt,
  asSystemPrompt,
  type SystemPrompt,
} from '../prompt/core/systemPrompt.js';
```

- [ ] **Step 4: 验证编译**

```bash
bun run build
```

- [ ] **Step 5: 提交**

```bash
git add src/prompt/core/systemPrompt.ts src/utils/systemPrompt.ts
git commit -m "refactor: migrate systemPrompt to prompt/core/systemPrompt"
```

---

### Task 2.3: 更新 systemPrompt 引用

**Files:** 更新引用 `systemPrompt.ts` 的文件（约 8 个）

- [ ] **Step 1: 查找所有引用**

```bash
grep -r "from.*systemPrompt" src/ --include="*.ts" --include="*.tsx" | grep -v "systemPromptType" | grep -v "systemPromptSections"
```

- [ ] **Step 2: 更新 import 路径**

将：
```typescript
import { buildEffectiveSystemPrompt } from './systemPrompt.js';
```

改为：
```typescript
import { buildEffectiveSystemPrompt } from '../prompt/core/systemPrompt.js';
```

- [ ] **Step 3: 验证编译和测试**

```bash
bun run build && bun test
```

- [ ] **Step 4: 提交**

```bash
git commit -m "refactor: update systemPrompt imports (stage 2 complete)"
```

---

## 阶段 3：Prompt 工具函数迁移

### Task 3.1: 迁移 promptCategory.ts

**Files:**
- Move: `src/utils/promptCategory.ts` → `src/prompt/tools/category.ts`
- Modify: `src/utils/promptCategory.ts` (创建转发器)

- [ ] **Step 1: 复制文件到新位置**

```typescript
// src/prompt/tools/category.ts
import type { QuerySource } from 'src/constants/querySource.js'
import {
  DEFAULT_OUTPUT_STYLE_NAME,
  OUTPUT_STYLE_CONFIG,
} from '../constants/outputStyles.js'
import { getSettings_DEPRECATED } from '../utils/settings/settings.js'

// ... 其余内容
```

- [ ] **Step 2: 创建转发器**

```typescript
// src/utils/promptCategory.ts
// Forwarder: migrated to src/prompt/tools/category.ts
export {
  getQuerySourceForAgent,
  getQuerySourceForREPL,
} from '../prompt/tools/category.js';
```

- [ ] **Step 3: 验证编译**

```bash
bun run build
```

- [ ] **Step 4: 提交**

```bash
git add src/prompt/tools/category.ts src/utils/promptCategory.ts
git commit -m "refactor: migrate promptCategory to prompt/tools/category"
```

---

### Task 3.2: 迁移 promptEditor.ts

**Files:**
- Move: `src/utils/promptEditor.ts` → `src/prompt/tools/editor.ts`
- Modify: `src/utils/promptEditor.ts` (创建转发器)

- [ ] **Step 1: 复制文件到新位置**

```typescript
// src/prompt/tools/editor.ts
import {
  expandPastedTextRefs,
  formatPastedTextRef,
  getPastedTextRefNumLines,
} from '../history.js'
// ... 更新所有 import 路径
```

- [ ] **Step 2: 创建转发器**

```typescript
// src/utils/promptEditor.ts
// Forwarder: migrated to src/prompt/tools/editor.ts
export {
  editFileInEditor,
  editPromptInEditor,
  type EditorResult,
} from '../prompt/tools/editor.js';
```

- [ ] **Step 3: 验证编译**

```bash
bun run build
```

- [ ] **Step 4: 提交**

```bash
git add src/prompt/tools/editor.ts src/utils/promptEditor.ts
git commit -m "refactor: migrate promptEditor to prompt/tools/editor"
```

---

### Task 3.3: 迁移 promptShellExecution.ts

**Files:**
- Move: `src/utils/promptShellExecution.ts` → `src/prompt/tools/shellExecution.ts`
- Modify: `src/utils/promptShellExecution.ts` (创建转发器)

- [ ] **Step 1: 复制文件到新位置**

```typescript
// src/prompt/tools/shellExecution.ts
import { randomUUID } from 'crypto'
import type { Tool, ToolUseContext } from '../Tool.js'
import { BashTool } from '../tools/BashTool/BashTool.js'
// ... 更新所有 import 路径
```

- [ ] **Step 2: 创建转发器**

```typescript
// src/utils/promptShellExecution.ts
// Forwarder: migrated to src/prompt/tools/shellExecution.ts
export {
  executeShellCommandsInPrompt,
} from '../prompt/tools/shellExecution.js';
```

- [ ] **Step 3: 验证编译**

```bash
bun run build
```

- [ ] **Step 4: 提交**

```bash
git add src/prompt/tools/shellExecution.ts src/utils/promptShellExecution.ts
git commit -m "refactor: migrate promptShellExecution to prompt/tools/shellExecution (stage 3 complete)"
```

---

## 阶段 4：消息处理模块迁移

### Task 4.1: 创建消息模块文件

**Files:**
- Create: `src/prompt/messages/types.ts`
- Create: `src/prompt/messages/creation.ts`
- Create: `src/prompt/messages/normalization.ts`

- [ ] **Step 1: 创建类型文件**

从 `src/utils/messages.ts` 提取类型定义：
```typescript
// src/prompt/messages/types.ts
export type {
  UserMessage,
  AssistantMessage,
  SystemMessage,
  NormalizedMessage,
  // ... 其他消息类型
} from '../types/message.js'
```

- [ ] **Step 2: 创建消息创建文件**

提取相关函数：
```typescript
// src/prompt/messages/creation.ts
export function createUserMessage(...) { ... }
export function createAssistantMessage(...) { ... }
export function createSystemMessage(...) { ... }
```

- [ ] **Step 3: 创建消息规范化文件**

```typescript
// src/prompt/messages/normalization.ts
export function normalizeMessages(...) { ... }
export function prepareUserContent(...) { ... }
```

- [ ] **Step 4: 提交**

```bash
git add src/prompt/messages/
git commit -m "feat: create prompt/messages module structure"
```

---

### Task 4.2: 更新 messages.ts 导出

**Files:**
- Modify: `src/utils/messages.ts`

- [ ] **Step 1: 在 messages.ts 中添加转发导出**

```typescript
// src/utils/messages.ts
// 在文件顶部添加转发
export {
  createUserMessage,
  createAssistantMessage,
  createSystemMessage,
} from '../prompt/messages/creation.js'

export {
  normalizeMessages,
  prepareUserContent,
} from '../prompt/messages/normalization.js'

// 保留原有非 Prompt 相关函数
```

- [ ] **Step 2: 验证编译**

```bash
bun run build
```

- [ ] **Step 3: 提交**

```bash
git commit -m "refactor: add forwarders in messages.ts for prompt/messages exports"
```

---

## 阶段 5：生成流程迁移

### Task 5.1: 迁移 forkedAgent.ts

**Files:**
- Move: `src/utils/forkedAgent.ts` → `src/prompt/generation/forkedContext.ts`
- Modify: `src/utils/forkedAgent.ts` (创建转发器)

- [ ] **Step 1: 复制文件到新位置**

```typescript
// src/prompt/generation/forkedContext.ts
// 更新所有 import 路径
import { prepareForkedCommandContext } from './forkedContext.js'
```

- [ ] **Step 2: 创建转发器**

```typescript
// src/utils/forkedAgent.ts
// Forwarder: migrated to src/prompt/generation/forkedContext.ts
export {
  prepareForkedCommandContext,
  extractResultText,
  createCacheSafeParams,
  saveCacheSafeParams,
  getLastCacheSafeParams,
  type ForkedAgentParams,
  type ForkedAgentResult,
  type CacheSafeParams,
  type PreparedForkedContext,
} from '../prompt/generation/forkedContext.js';
```

- [ ] **Step 3: 验证编译**

```bash
bun run build
```

- [ ] **Step 4: 提交**

```bash
git add src/prompt/generation/forkedContext.ts src/utils/forkedAgent.ts
git commit -m "refactor: migrate forkedAgent to prompt/generation/forkedContext"
```

---

### Task 5.2: 提取 processSlashCommand 相关函数

**Files:**
- Create: `src/prompt/generation/slashCommand.ts`

- [ ] **Step 1: 分析 processSlashCommand.tsx 中的 Prompt 相关函数**

需要提取的函数：
- `getMessagesForPromptSlashCommand()`
- `executeForkedSlashCommand()`

- [ ] **Step 2: 创建新文件**

```typescript
// src/prompt/generation/slashCommand.ts
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources'
import type { ProcessUserInputContext } from '../utils/processUserInput/processUserInput.js'
// ... 导入依赖

export async function getMessagesForPromptSlashCommand(
  command: PromptCommand,
  args: string,
  context: ProcessUserInputContext,
): Promise<Message[]> {
  // ... 实现
}
```

- [ ] **Step 3: 更新原文件引用**

在 `src/utils/processUserInput/processSlashCommand.tsx` 中：
```typescript
import { getMessagesForPromptSlashCommand } from '../prompt/generation/slashCommand.js'
```

- [ ] **Step 4: 验证编译**

```bash
bun run build
```

- [ ] **Step 5: 提交**

```bash
git add src/prompt/generation/slashCommand.ts src/utils/processUserInput/processSlashCommand.tsx
git commit -m "refactor: extract getMessagesForPromptSlashCommand to prompt/generation"
```

---

### Task 5.3: 更新 SkillTool 引用

**Files:**
- Modify: `src/tools/SkillTool/SkillTool.ts`

- [ ] **Step 1: 更新 import**

```typescript
// src/tools/SkillTool/SkillTool.ts
import { prepareForkedCommandContext } from '../prompt/generation/forkedContext.js'
```

- [ ] **Step 2: 验证编译**

```bash
bun run build
```

- [ ] **Step 3: 提交**

```bash
git commit -m "refactor: update SkillTool imports (stage 5 complete)"
```

---

## 阶段 6：UI 组件迁移和清理

### Task 6.1: 迁移 promptOverlayContext.tsx

**Files:**
- Move: `src/context/promptOverlayContext.tsx` → `src/prompt/ui/overlayContext.tsx`
- Modify: `src/context/promptOverlayContext.tsx` (创建转发器)

- [ ] **Step 1: 复制文件到新位置**

```typescript
// src/prompt/ui/overlayContext.tsx
// 更新 import 路径
```

- [ ] **Step 2: 创建转发器**

```typescript
// src/context/promptOverlayContext.tsx
// Forwarder: migrated to src/prompt/ui/overlayContext.tsx
export {
  PromptOverlayProvider,
  usePromptOverlay,
  usePromptOverlayDialog,
  useSetPromptOverlay,
  useSetPromptOverlayDialog,
  type PromptOverlayData,
} from '../prompt/ui/overlayContext.js';
```

- [ ] **Step 3: 验证编译**

```bash
bun run build
```

- [ ] **Step 4: 提交**

```bash
git add src/prompt/ui/overlayContext.tsx src/context/promptOverlayContext.tsx
git commit -m "refactor: migrate promptOverlayContext to prompt/ui"
```

---

### Task 6.2: 删除转发器文件

**Files:**
- Delete: `src/utils/systemPromptType.ts`
- Delete: `src/utils/systemPrompt.ts`
- Delete: `src/utils/systemPromptSections.ts`
- Delete: `src/utils/promptCategory.ts`
- Delete: `src/utils/promptEditor.ts`
- Delete: `src/utils/promptShellExecution.ts`
- Delete: `src/utils/forkedAgent.ts`
- Delete: `src/context/promptOverlayContext.tsx`

- [ ] **Step 1: 全局搜索确认无旧路径引用**

```bash
grep -r "from.*utils/systemPrompt" src/ --include="*.ts" --include="*.tsx"
grep -r "from.*utils/prompt" src/ --include="*.ts" --include="*.tsx"
grep -r "from.*utils/forkedAgent" src/ --include="*.ts" --include="*.tsx"
grep -r "from.*context/promptOverlay" src/ --include="*.ts" --include="*.tsx"
```

Expected: 无结果

- [ ] **Step 2: 删除转发器文件**

```bash
rm src/utils/systemPromptType.ts
rm src/utils/systemPrompt.ts
rm src/utils/systemPromptSections.ts
rm src/utils/promptCategory.ts
rm src/utils/promptEditor.ts
rm src/utils/promptShellExecution.ts
rm src/utils/forkedAgent.ts
rm src/context/promptOverlayContext.tsx
```

- [ ] **Step 3: 验证编译**

```bash
bun run build
```

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "refactor: remove forwarder files (cleanup complete)"
```

---

### Task 6.3: 最终验证

- [ ] **Step 1: 运行完整测试套件**

```bash
bun test
```

Expected: 所有测试通过

- [ ] **Step 2: 运行 TypeScript 类型检查**

```bash
bun run build
```

Expected: 无类型错误

- [ ] **Step 3: 运行 ESLint**

```bash
bun run lint
```

Expected: 无 lint 错误

- [ ] **Step 4: 验证目录结构**

```bash
tree src/prompt/
```

Expected:
```
src/prompt/
├── core/
│   ├── index.ts
│   ├── types.ts
│   ├── systemPrompt.ts
│   └── sections.ts
├── generation/
│   ├── index.ts
│   ├── slashCommand.ts
│   └── forkedContext.ts
├── tools/
│   ├── index.ts
│   ├── category.ts
│   ├── editor.ts
│   └── shellExecution.ts
├── messages/
│   ├── index.ts
│   ├── creation.ts
│   ├── normalization.ts
│   └── types.ts
└── ui/
    ├── index.ts
    └── overlayContext.tsx
```

- [ ] **Step 5: 提交最终验证**

```bash
git commit --allow-empty -m "chore: stage 6 complete - prompt extraction finished"
```

---

## 验证清单

完成所有阶段后，运行以下验证：

- [ ] TypeScript 编译通过 (`bun run build`)
- [ ] 所有测试通过 (`bun test`)
- [ ] 无 ESLint 错误 (`bun run lint`)
- [ ] `src/prompt/` 目录包含所有迁移的文件
- [ ] 无旧路径引用残留
- [ ] 转发器文件已全部删除

---

## 回滚方案

如果某阶段出现问题，可回滚到上一阶段：

```bash
# 回滚到最后一次成功提交
git revert HEAD

# 或重置到特定提交
git reset --hard <commit-hash>
```

每个阶段都是独立的提交，可单独回滚而不影响其他阶段。
