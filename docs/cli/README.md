# CLI 传输层文档索引

本目录包含 Yao Code CLI 传输层的详细文档，涵盖从用户输入到 API 响应再到输出的完整链路。

---

## 文档列表

| 文档 | 描述 |
|------|------|
| [cli-transport-architecture.md](./cli-transport-architecture.md) | 传输层架构总览，包含层级定位、核心职责、数据流概览 |
| [api-client-providers.md](./api-client-providers.md) | API 客户端与提供商管理（直连/Bedrock/Vertex/Foundry） |
| [message-transmission.md](./message-transmission.md) | 消息传输详解（流式请求/响应处理、工具调用） |
| [retry-logic.md](./retry-logic.md) | 重试逻辑（错误分类、退避策略、快速模式、持久重试） |
| [files-api.md](./files-api.md) | 文件传输 API（上传/下载/列表、并行处理） |
| [session-persistence.md](./session-persistence.md) | 会话持久化（Session Ingress、乐观并发控制） |
| [complete-request-flow.md](./complete-request-flow.md) | 完整请求链路时序图 |
| [flow-diagrams.md](./flow-diagrams.md) | 专项流程图集合 |

---

## 快速导航

### 想了解系统整体架构？
→ 阅读 [cli-transport-architecture.md](./cli-transport-architecture.md)

### 想了解 API 客户端如何支持多提供商？
→ 阅读 [api-client-providers.md](./api-client-providers.md)

### 想了解消息发送和响应处理？
→ 阅读 [message-transmission.md](./message-transmission.md)

### 想了解重试机制和错误处理？
→ 阅读 [retry-logic.md](./retry-logic.md)

### 想了解文件上传下载？
→ 阅读 [files-api.md](./files-api.md)

### 想了解会话日志持久化？
→ 阅读 [session-persistence.md](./session-persistence.md)

### 想看完整的请求链路图？
→ 阅读 [complete-request-flow.md](./complete-request-flow.md)

---

## 核心模块索引

### API 客户端模块

| 文件 | 描述 |
|------|------|
| `src/services/api/client.ts` | API 客户端创建，支持多种提供商 |
| `src/services/api/claude.ts` | 消息发送核心逻辑 |
| `src/services/api/withRetry.ts` | 重试逻辑实现 |

### 文件传输模块

| 文件 | 描述 |
|------|------|
| `src/services/api/filesApi.ts` | 文件上传/下载/列表 API |
| `src/services/api/bootstrap.ts` | Bootstrap 数据获取 |

### 会话持久化模块

| 文件 | 描述 |
|------|------|
| `src/services/api/sessionIngress.ts` | 会话日志持久化 |

---

## 架构图预览

### 传输层定位

```
┌─────────────────────────────────────────────────────────────┐
│                      应用层 (App Layer)                      │
│                   CLI、REPL、UI Components                   │
├─────────────────────────────────────────────────────────────┤
│                      业务逻辑层 (Business Logic)             │
│              query.ts, tools/, commands/                     │
├─────────────────────────────────────────────────────────────┤
│                      服务层 (Services)                       │
│         API、MCP、LSP、Compact、Plugins、Analytics           │
│    ┌────────────────────────────────────────────────────┐   │
│    │              传输层 (Transmission) ← 本文档          │   │
│    │   API 客户端、消息传输、重试逻辑、文件 API、会话持久化    │   │
│    └────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│                    工具函数层 (Utils)                        │
│    认证、配置、权限、Git、文件系统、Bash 解析、模型管理        │
├─────────────────────────────────────────────────────────────┤
│                    基础设施 (Infrastructure)                 │
│                  Node.js/Bun Runtime、OS API                 │
└─────────────────────────────────────────────────────────────┘
```

### 核心依赖关系

```
传输层
    │
    ├──→ API 客户端 ──→ 多提供商支持（直连/Bedrock/Vertex/Foundry）
    ├──→ 消息传输 ──→ 流式请求/响应、工具调用
    ├──→ 重试逻辑 ──→ 错误处理、退避策略、快速模式
    ├──→ Files API ──→ 文件上传/下载/列表
    └──→ Session Ingress ──→ 会话日志持久化
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
- [工具层文档](../utils/) - 工具函数层实现详解
- [工具系统文档](../tools/) - 工具系统实现详解

---

*本目录文档由 brainstorming 技能生成*
