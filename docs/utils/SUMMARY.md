# Utils 层文档总结

## 文档概览

本系列文档详细记录了 Yao Code 工具函数层（Utils Layer）的架构设计、核心实现和执行流程。

---

## 文档列表

| 文档 | 主题 | 核心内容 |
|------|------|----------|
| [utils-layer-architecture.md](./utils-layer-architecture.md) | 架构总览 | 层级定位、模块分类、设计原则、依赖关系 |
| [core-util-implementations.md](./core-util-implementations.md) | 核心实现 | 认证、配置、Git、文件系统、Bash 解析、模型管理、缓存机制 |
| [permission-system-design.md](./permission-system-design.md) | 权限系统 | 权限模式、规则系统、路径验证、分类器、拒绝跟踪 |
| [execution-flow-diagrams.md](./execution-flow-diagrams.md) | 流程图 | 认证流程、权限检查、Git 操作、文件操作、Bash 解析、设置加载 |
| [README.md](./README.md) | 索引导航 | 快速导航、模块索引、分类索引 |

---

## 核心主题覆盖

### 1. 认证与配置
- API 密钥管理（OAuth、AWS SSO、安全存储）
- 配置加载（全局配置、项目配置、MCP 配置）
- 环境检测（终端类型、平台识别、部署环境）

### 2. 权限系统
- 权限模式（default、plan、auto、acceptEdits、bypass、dontAsk）
- 规则匹配（工具名、路径、命令内容）
- 路径验证（UNC 拦截、shell 扩展检测、沙箱集成）
- 分类器（bashClassifier、yoloClassifier）
- 拒绝跟踪（状态机、降级策略）

### 3. Git 操作
- Git 根目录查找（LRU 缓存、worktree 解析）
- 规范根目录解析（符号链接安全验证）
- Git 状态保存（用于 issue 提交）

### 4. 文件系统
- FsOperations 接口（30+ 方法）
- 符号链接处理（链式遍历、安全解析）
- 权限检查路径生成

### 5. Bash 解析
- Tree-sitter 集成（WASM 加载、AST 解析）
- 命令提取（危险命令识别、环境变量提取）
- AST 安全分析

### 6. 模型管理
- 模型选择优先级
- 模型别名处理
- 提供商管理

### 7. 设置系统
- 多源设置加载（9 个优先级层级）
- 设置合并策略
- 设置缓存管理

### 8. 缓存机制
- TTL 缓存（同步/异步）
- LRU 缓存
- 飞行中请求去重

### 9. 错误处理
- 错误类型定义（ClaudeError、AbortError 等）
- 错误分类工具
- 遥测安全错误处理

---

## 流程图覆盖

| 流程类型 | 流程图 |
|----------|--------|
| 认证 | 认证源检测、API 密钥获取时序、AWS 刷新 |
| 权限 | 完整检查决策树、路径验证、规则匹配时序 |
| Git | 根目录查找（LRU）、Worktree 解析链、状态保存 |
| 文件系统 | 符号链接链遍历、安全路径解析 |
| Bash | Tree-sitter 解析、AST 参数提取 |
| 设置 | 源优先级加载、解析缓存 |
| 缓存 | TTL 流程、LRU 流程 |

---

## 设计原则

1. **不可变性** - 所有函数返回新对象，不修改输入
2. **错误处理** - 系统边界验证，类型守卫处理未知错误
3. **缓存策略** - memoizeWithTTL、memoizeWithLRU、LRUCache
4. **抽象接口** - FsOperations 等接口支持多实现

---

## 相关文件

- [工具层文档](../tools/) - 工具系统实现
- [服务层文档](../services/) - 服务层实现
- [项目主文档](../../README.md) - 项目概述

---

*文档生成时间：2026-04-01*
