# Claude Code 工具函数层文档索引

本目录包含 Claude Code 工具函数层（Utils Layer）的详细文档。

---

## 文档列表

| 文档 | 描述 |
|------|------|
| [utils-layer-architecture.md](./utils-layer-architecture.md) | 工具函数层架构总览，包含模块分类、设计原则、核心抽象接口 |
| [core-util-implementations.md](./core-util-implementations.md) | 核心工具函数实现详解（认证、配置、Git、文件系统、Bash 解析等） |
| [permission-system-design.md](./permission-system-design.md) | 权限系统专项文档（规则系统、分类器、自动模式、路径验证） |
| [execution-flow-diagrams.md](./execution-flow-diagrams.md) | 流程图和调用时序图（认证流程、权限检查、Git 操作等） |

---

## 快速导航

### 想了解系统整体架构？
→ 阅读 [utils-layer-architecture.md](./utils-layer-architecture.md)

### 想了解具体工具函数实现？
→ 阅读 [core-util-implementations.md](./core-util-implementations.md)

### 想了解权限系统？
→ 阅读 [permission-system-design.md](./permission-system-design.md)

### 想查看流程图和时序图？
→ 阅读 [execution-flow-diagrams.md](./execution-flow-diagrams.md)

---

## 核心模块索引

### 认证与配置模块

| 文件 | 描述 |
|------|------|
| `src/utils/auth.ts` | API 密钥管理、OAuth 认证、令牌刷新 |
| `src/utils/config.ts` | 全局配置和项目配置加载 |
| `src/utils/env.ts` | 环境变量检测、平台识别 |
| `src/utils/envUtils.ts` | 环境工具函数 |
| `src/utils/envValidation.ts` | 环境验证 |

### 权限系统模块

| 文件 | 描述 |
|------|------|
| `src/utils/permissions/permissions.ts` | 权限检查核心逻辑 |
| `src/utils/permissions/PermissionRule.ts` | 权限规则类型定义 |
| `src/utils/permissions/PermissionMode.ts` | 权限模式（ask/auto/yolo） |
| `src/utils/permissions/bashClassifier.ts` | Bash 命令分类器 |
| `src/utils/permissions/yoloClassifier.ts` | YOLO 模式分类器 |
| `src/utils/permissions/pathValidation.ts` | 路径验证 |
| `src/utils/permissions/filesystem.ts` | 文件系统权限 |

### 设置系统模块

| 文件 | 描述 |
|------|------|
| `src/utils/settings/settings.ts` | 设置加载和合并 |
| `src/utils/settings/types.ts` | 设置类型定义 |
| `src/utils/settings/validation.ts` | 设置验证 |
| `src/utils/settings/mdm/settings.ts` | MDM 策略设置 |

### Git 操作模块

| 文件 | 描述 |
|------|------|
| `src/utils/git.ts` | Git 仓库操作 |
| `src/utils/gitDiff.ts` | Git 差异计算 |
| `src/utils/gitSettings.ts` | Git 相关设置 |

### 文件系统模块

| 文件 | 描述 |
|------|------|
| `src/utils/fsOperations.ts` | 文件系统操作抽象层 |
| `src/utils/file.ts` | 文件写入操作 |
| `src/utils/fileRead.ts` | 文件读取操作 |
| `src/utils/path.ts` | 路径处理 |

### Bash 解析模块

| 文件 | 描述 |
|------|------|
| `src/utils/bash/parser.ts` | Bash 命令解析 |
| `src/utils/bash/bashParser.ts` | Tree-sitter 解析器 |
| `src/utils/bash/ast.ts` | AST 安全分析 |
| `src/utils/bash/commands.ts` | 命令处理 |

### 模型管理模块

| 文件 | 描述 |
|------|------|
| `src/utils/model/model.ts` | 模型选择逻辑 |
| `src/utils/model/providers.ts` | API 提供商管理 |
| `src/utils/model/modelStrings.ts` | 模型字符串配置 |
| `src/utils/model/aliases.ts` | 模型别名 |

### 遥测与日志模块

| 文件 | 描述 |
|------|------|
| `src/utils/telemetry/sessionTracing.ts` | 会话追踪 |
| `src/utils/telemetry/events.ts` | 事件定义 |
| `src/utils/telemetry/logger.ts` | 日志记录 |
| `src/utils/log.ts` | 日志工具 |

### 安全模块

| 文件 | 描述 |
|------|------|
| `src/utils/sandbox/` | 沙箱适配 |
| `src/utils/secureStorage/` | 安全存储 |

---

## 工具函数分类

### 基础工具函数

- `array.ts` - 数组操作
- `stringUtils.ts` - 字符串处理
- `json.ts` / `jsonRead.ts` - JSON 处理
- `crypto.ts` - 加密工具
- `sleep.ts` - 延时工具
- `memoize.ts` - 记忆化缓存

### 高级工具函数

- `agentContext.ts` - Agent 上下文
- `agenticSessionSearch.ts` - Agent 会话搜索
- `codeIndexing.ts` - 代码索引
- `contextAnalysis.ts` - 上下文分析
- `editor.ts` - 编辑器集成

### 平台检测

- `platform.ts` - 平台识别
- `env.ts` - 环境检测
- `bundledMode.ts` - 打包模式检测

---

## 架构图预览

### Utils 层定位

```
┌─────────────────────────────────────────────────────────────┐
│                      应用层 (App Layer)                      │
├─────────────────────────────────────────────────────────────┤
│                      服务层 (Services)                       │
├─────────────────────────────────────────────────────────────┤
│                    工具函数层 (Utils) ← 本文档               │
├─────────────────────────────────────────────────────────────┤
│                    基础设施 (Infrastructure)                 │
└─────────────────────────────────────────────────────────────┘
```

### 核心依赖关系

```
工具函数层
    │
    ├──→ 认证模块 (auth.ts) ──→ OAuth 服务、安全存储
    ├──→ 配置模块 (config.ts) ──→ 设置系统、环境检测
    ├──→ 权限模块 (permissions/) ──→ 分类器、路径验证
    ├──→ Git 模块 (git.ts) ──→ Git 命令执行
    ├──→ 文件系统 (fsOperations.ts) ──→ Node.js fs
    └──→ Bash 解析 (bash/) ──→ Tree-sitter
```

---

## 版本信息

- **项目版本**: 999.0.0-restored
- **文档版本**: 1.0.0
- **最后更新**: 2026-04-01
- **构建工具**: Bun 1.3.5+

---

## 相关文档

- [项目主文档](../../README.md)
- [CLAUDE.md](../../CLAUDE.md) - 项目结构说明
- [服务层文档](../services/) - 服务层实现详解
- [工具系统文档](../tools/) - 工具系统实现详解

---

*本目录文档由 brainstorming 技能生成*
