# 小红书 Agent Plugin - 技术设计文档

## 第一部分：架构设计

### 1.1 系统架构图

```
┌─────────────────────────────────────────────────────────┐
│  浏览器插件层 (Chrome Extension Manifest V3)             │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  Popup UI (用户交互)                                     │
│  ├─ 关键词输入表单                                       │
│  ├─ 参数配置面板                                         │
│  ├─ 任务进度显示                                         │
│  └─ 结果导出按钮                                         │
│                                                          │
│  Content Script (页面内容注入)                          │
│  └─ 可选的页面快速启动功能                              │
│                                                          │
│  Service Worker / Background (核心逻辑)                 │
│  ├─ 任务管理器 (TaskManager)                            │
│  ├─ 工作流引擎 (WorkflowEngine)                         │
│  ├─ 浏览器通信层 (BrowserAPI)                           │
│  ├─ LLM 调用层 (LLMClient)                              │
│  ├─ 本地存储层 (StorageManager)                         │
│  └─ 错误恢复与重试逻辑                                  │
│                                                          │
└─────────────────────────────────────────────────────────┘
          ↓ (IPC/消息传递)
┌─────────────────────────────────────────────────────────┐
│  IndexedDB (本地数据库)                                  │
├─────────────────────────────────────────────────────────┤
│  └─ workflows (工作流缓存)                              │
│  └─ tasks (任务历史)                                    │
│  └─ results (采集结果)                                  │
│  └─ cache (临时缓存)                                    │
│                                                          │
└─────────────────────────────────────────────────────────┘
          ↓ (HTTP/HTTPS)
┌─────────────────────────────────────────────────────────┐
│  Claude API / LLM 服务                                  │
├─────────────────────────────────────────────────────────┤
│  └─ 工作流生成                                          │
│  └─ 页面理解与数据提取指导                              │
│                                                          │
└─────────────────────────────────────────────────────────┘
          ↓ (真实浏览器交互)
┌─────────────────────────────────────────────────────────┐
│  用户真实浏览器 (Chrome / Edge)                         │
├─────────────────────────────────────────────────────────┤
│  └─ 真实登录态                                          │
│  └─ 真实页面渲染                                        │
│  └─ 真实用户行为                                        │
│                                                          │
└─────────────────────────────────────────────────────────┘
          ↓
┌─────────────────────────────────────────────────────────┐
│  小红书网站                                              │
│  └─ 搜索、笔记、评论页面                                │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### 1.2 核心模块划分

| 模块名 | 职责 | 关键接口 |
|--------|------|---------|
| **TaskManager** | 任务生命周期管理、队列、状态转移 | createTask, executeTask, retryTask, cancelTask |
| **WorkflowEngine** | 工作流生成、缓存、执行、失效检测 | generateWorkflow, getOrCreateWorkflow, executeWorkflow, markInvalid |
| **BrowserAPI** | 真实浏览器操作封装 | openPage, click, scroll, extract, screenshot |
| **LLMClient** | Claude API 调用与 Prompt 管理 | callLLM, generateWorkflowPrompt |
| **StorageManager** | IndexedDB 操作与数据持久化 | saveWorkflow, getWorkflow, saveResult, getResults, exportData |
| **ResultProcessor** | 结果结构化、聚合、导出 | parseNotes, parseComments, aggregateResults, exportJSON/CSV/Excel |
| **ErrorHandler** | 错误分类、恢复策略、重试逻辑 | handleError, shouldRetry, getRecoveryPath |

---

## 第二部分：数据结构设计

### 2.1 工作流结构

```
WorkflowDefinition {
  id: string                           // "xiaohongshu_search_v1"
  platform: string                     // "xiaohongshu.com"
  version: number                      // 版本号
  created_at: timestamp
  expires_at: timestamp               // 30天自动失效
  
  variables: {                         // 预定义变量
    keyword: { type: "string", required: true },
    page_depth: { type: "number", default: 1 },
    comment_depth: { type: "number", default: 5 }
  }
  
  steps: WorkflowStep[]
  error_handlers: ErrorHandler[]
  validation_rules: ValidationRule[]
}

WorkflowStep {
  id: string                           // "step_1"
  action: string                       // "openPage" | "click" | "scroll" | "extract" | "wait" | "closeTab"
  
  // 通用字段
  timeout: number                      // 毫秒
  retry_count: number
  on_error: "continue" | "retry" | "abort"
  
  // action 特定字段
  // 如果 action = "openPage"
  url?: string                         // 支持模板变量 {keyword}
  
  // 如果 action = "click"
  selector?: string
  
  // 如果 action = "scroll"
  direction?: "up" | "down" | "top" | "bottom"
  distance?: number
  delay?: number
  
  // 如果 action = "extract"
  target_selector?: string
  schema?: DataSchema
  
  // 如果 action = "wait"
  element_selector?: string
  max_wait?: number
}

ErrorHandler {
  type: string                         // "rate_limited" | "page_not_loaded" | "selector_not_found"
  detect: string | RegExp              // 检测方式
  action: "retry" | "skip" | "abort" | "regenerate"
  delay?: number                       // 重试前等待
  max_attempts?: number
}

DataSchema {
  // 定义如何从 DOM 提取结构化数据
  title: { selector: string, extractor: "text" | "attr" }
  author: { selector: string, extractor: "text" }
  likes: { selector: string, extractor: "text", parser: "number" }
  // ...
}
```

### 2.2 任务结构

```
Task {
  id: string                           // "xhs_20261010_abc123"
  status: "pending" | "running" | "completed" | "failed" | "cancelled"
  
  input: {
    keywords: string[]
    mode: "basic" | "advanced"
    config: TaskConfig
  }
  
  workflow_id: string                  // 使用的工作流 ID
  workflow_version: number
  
  execution: {
    started_at: timestamp
    completed_at: timestamp
    total_duration_ms: number
    
    progress: {
      keywords_processed: number
      keywords_total: number
      notes_collected: number
      comments_collected: number
    }
    
    steps_executed: number
    steps_total: number
  }
  
  results: {
    notes: Note[]
    comments: Comment[]
    errors: TaskError[]
    summary: ResultSummary
  }
  
  metadata: {
    user_agent: string
    browser_type: string
    created_at: timestamp
    user_id?: string
  }
}

TaskConfig {
  depth: {
    notes_per_keyword: number          // 默认 20
    comments_per_note: number          // 默认 5
  }
  
  filters: {
    time_range?: "last_7_days" | "last_30_days" | "all"
    engagement_type?: "hot" | "trending" | "all"
    content_type?: "image" | "video" | "all"
  }
  
  batch: {
    parallel: number                   // 并发数（小红书建议 1）
    retry_count: number
    batch_interval_ms: number
  }
  
  output: {
    format: "json" | "csv" | "xlsx"
    export: boolean
    include_media_urls: boolean
  }
}

Note {
  id: string
  title: string
  url: string
  posted_at: timestamp
  
  author: {
    id: string
    name: string
    followers: number
    verified: boolean
    avatar_url: string
  }
  
  content: {
    text: string
    word_count: number
  }
  
  media: Media[]
  
  engagement: {
    likes: number
    comments: number
    reposts: number
    collected: number
  }
  
  tags: string[]
  comments: Comment[]
}

Comment {
  id: string
  author_id: string
  author_name: string
  text: string
  likes: number
  posted_at: timestamp
}

Media {
  type: "image" | "video"
  url: string
  cover?: string                       // 视频封面
  duration_seconds?: number
  order: number
}
```

### 2.3 本地存储 Schema

```
// IndexedDB Database: "xhs-agent-db"

ObjectStore: "workflows"
├─ Key: workflow_id
├─ Value: {
│   id: string
│   platform: string
│   version: number
│   created_at: timestamp
│   expires_at: timestamp
│   steps: WorkflowStep[]
│   ...
│ }

ObjectStore: "tasks"
├─ Key: task_id
├─ Index: "timestamp" (用于按创建时间查询)
├─ Value: {
│   id: string
│   status: string
│   input: TaskInput
│   created_at: timestamp
│   ...
│ }

ObjectStore: "results"
├─ Key: "${task_id}_chunk_${index}"
├─ Index: "task_id" (用于按任务查询)
├─ Value: {
│   task_id: string
│   chunk_index: number
│   notes: Note[]      // 每个 chunk 最多 100 条
│   size_bytes: number
│   timestamp: timestamp
│ }

ObjectStore: "cache"
├─ Key: cache_key
├─ Value: {
│   key: string
│   data: any
│   expires_at: timestamp
│ }
```

---

## 第三部分：模块接口设计

### 3.1 TaskManager

```
interface ITaskManager {
  // 创建新任务
  createTask(input: TaskInput): Promise<Task>
  
  // 获取任务
  getTask(taskId: string): Promise<Task>
  
  // 列出任务
  listTasks(filter?: TaskFilter): Promise<Task[]>
  
  // 执行任务
  executeTask(taskId: string): Promise<void>
  
  // 暂停任务
  pauseTask(taskId: string): Promise<void>
  
  // 恢复任务
  resumeTask(taskId: string): Promise<void>
  
  // 取消任务
  cancelTask(taskId: string): Promise<void>
  
  // 重试失败任务
  retryTask(taskId: string, options?: RetryOptions): Promise<void>
  
  // 更新任务状态
  updateTaskStatus(taskId: string, status: TaskStatus): Promise<void>
}
```

### 3.2 WorkflowEngine

```
interface IWorkflowEngine {
  // 生成工作流（需要调用 LLM）
  generateWorkflow(
    platform: string,
    taskType: string,
    context: GenerationContext
  ): Promise<WorkflowDefinition>
  
  // 获取或生成工作流
  getOrCreateWorkflow(
    platform: string,
    taskType: string,
    context?: GenerationContext
  ): Promise<WorkflowDefinition>
  
  // 执行工作流
  executeWorkflow(
    workflow: WorkflowDefinition,
    variables: Record<string, any>,
    onProgress?: (progress: ExecutionProgress) => void
  ): Promise<ExecutionResult>
  
  // 标记工作流为失效
  markWorkflowInvalid(workflowId: string): Promise<void>
  
  // 检查工作流是否过期
  isWorkflowExpired(workflow: WorkflowDefinition): boolean
  
  // 获取工作流缓存命中率（统计用）
  getWorkflowCacheStats(): Promise<CacheStats>
}

interface ExecutionResult {
  success: boolean
  data: any[]                          // 提取的数据
  errors: ExecutionError[]
  duration_ms: number
  steps_completed: number
  last_completed_step: string
}

interface ExecutionProgress {
  current_step: number
  total_steps: number
  current_step_name: string
  progress_percent: number
}
```

### 3.3 BrowserAPI

```
interface IBrowserAPI {
  // 打开页面
  openPage(url: string, timeout?: number): Promise<PageHandle>
  
  // 关闭页面/标签页
  closePage(pageHandle: PageHandle): Promise<void>
  
  // 等待元素出现
  waitForSelector(
    pageHandle: PageHandle,
    selector: string,
    timeout?: number
  ): Promise<void>
  
  // 点击元素
  click(
    pageHandle: PageHandle,
    selector: string,
    delay?: number
  ): Promise<ClickResult>
  
  // 滚动页面
  scroll(
    pageHandle: PageHandle,
    direction: "up" | "down" | "top" | "bottom",
    distance?: number,
    delay?: number
  ): Promise<void>
  
  // 输入文本
  type(
    pageHandle: PageHandle,
    selector: string,
    text: string,
    delay?: number
  ): Promise<void>
  
  // 提取数据
  extractData(
    pageHandle: PageHandle,
    selector: string,
    schema: DataSchema
  ): Promise<any[]>
  
  // 执行 JavaScript
  evaluate(
    pageHandle: PageHandle,
    script: string,
    args?: any[]
  ): Promise<any>
  
  // 截图
  screenshot(
    pageHandle: PageHandle,
    options?: ScreenshotOptions
  ): Promise<Buffer>
  
  // 获取当前 URL
  getCurrentUrl(pageHandle: PageHandle): Promise<string>
  
  // 获取页面标题
  getTitle(pageHandle: PageHandle): Promise<string>
}

interface PageHandle {
  id: string
  created_at: timestamp
  last_accessed_at: timestamp
}

interface ClickResult {
  success: boolean
  element_found: boolean
  element_tag: string
  element_text: string
}
```

### 3.4 LLMClient

```
interface ILLMClient {
  // 调用 LLM 生成工作流
  generateWorkflow(prompt: WorkflowGenerationPrompt): Promise<WorkflowDefinition>
  
  // 通用 LLM 调用
  callLLM(request: LLMRequest): Promise<LLMResponse>
  
  // 获取 API 状态
  getStatus(): Promise<LLMStatus>
}

interface WorkflowGenerationPrompt {
  platform: string
  task_type: string
  skill_md: string                     // web-access SKILL.md 内容
  site_pattern: string                 // 站点经验文件内容
  context: {
    target_keywords?: string[]
    target_depth?: number
    past_failures?: string[]           // 之前的失败原因，用于指导生成更鲁棒的工作流
  }
}

interface LLMRequest {
  model: string                        // "claude-opus" 等
  system_prompt: string
  user_message: string
  max_tokens?: number
  temperature?: number
}

interface LLMResponse {
  content: string
  usage: {
    input_tokens: number
    output_tokens: number
  }
  model: string
  created_at: timestamp
}
```

### 3.5 StorageManager

```
interface IStorageManager {
  // 工作流存储
  saveWorkflow(workflow: WorkflowDefinition): Promise<void>
  getWorkflow(workflowId: string): Promise<WorkflowDefinition | null>
  listWorkflows(platform?: string): Promise<WorkflowDefinition[]>
  deleteWorkflow(workflowId: string): Promise<void>
  
  // 任务存储
  saveTask(task: Task): Promise<void>
  getTask(taskId: string): Promise<Task | null>
  listTasks(filter?: TaskFilter): Promise<Task[]>
  updateTaskStatus(taskId: string, status: TaskStatus): Promise<void>
  
  // 结果存储（分块写入，避免内存溢出）
  appendResults(taskId: string, notes: Note[], chunkIndex: number): Promise<void>
  getResults(taskId: string): Promise<Note[]>
  getResultChunk(taskId: string, chunkIndex: number): Promise<Note[]>
  
  // 导出功能
  exportToJSON(taskId: string): Promise<string>
  exportToCSV(taskId: string): Promise<string>
  exportToExcel(taskId: string): Promise<Buffer>
  
  // 缓存
  setCache(key: string, value: any, expiresIn?: number): Promise<void>
  getCache(key: string): Promise<any | null>
  clearCache(): Promise<void>
  
  // 数据库维护
  clearExpiredData(): Promise<void>
  getStorageStats(): Promise<StorageStats>
}

interface TaskFilter {
  status?: TaskStatus
  platform?: string
  dateRange?: { from: timestamp; to: timestamp }
  limit?: number
  offset?: number
}
```

### 3.6 ErrorHandler

```
interface IErrorHandler {
  // 分类并处理错误
  handleError(error: Error, context: ErrorContext): Promise<ErrorRecoveryPath>
  
  // 判断是否应该重试
  shouldRetry(error: Error, retryCount: number): boolean
  
  // 获取恢复路径
  getRecoveryPath(error: Error): ErrorRecoveryPath
  
  // 记录错误
  logError(error: Error, context: ErrorContext): Promise<void>
}

interface ErrorContext {
  task_id: string
  workflow_id: string
  step_id: string
  step_action: string
  timestamp: timestamp
}

interface ErrorRecoveryPath {
  recovery_type: "retry" | "skip" | "regenerate_workflow" | "abort"
  delay_ms?: number
  max_attempts?: number
  reason: string
}

// 错误分类示例
enum ErrorType {
  RATE_LIMIT = "rate_limit",              // 小红书返回 300031
  PAGE_NOT_LOADED = "page_not_loaded",
  SELECTOR_NOT_FOUND = "selector_not_found",
  NETWORK_ERROR = "network_error",
  BROWSER_CRASHED = "browser_crashed",
  TIMEOUT = "timeout",
  AUTH_REQUIRED = "auth_required",
  WORKFLOW_INVALID = "workflow_invalid"
}
```

---

## 第四部分：状态机与流转

### 4.1 任务状态流转

```
状态转移图：

┌─────────┐
│ pending │
└────┬────┘
     │ (executeTask)
     ↓
┌─────────────┐
│   running   │
└────┬────┬───┘
     │    │
     │    │ (用户取消)
     │    └──────┐
     │           ↓
     │         ┌──────────┐
     │         │ cancelled│
     │         └──────────┘
     │
     │ (步骤执行过程中)
     ├─ 成功 ──→ ┌────────────┐
     │          │ completed  │
     │          └────────────┘
     │
     └─ 失败 ──→ ┌────────┐
                │ failed │
                └───┬────┘
                    │
                    └─ (retryTask) ──→ running
                                        (重新开始)
```

### 4.2 工作流缓存状态

```
┌─────────────────┐
│ GENERATED (新)  │
└────────┬────────┘
         │ (保存到本地)
         ↓
┌──────────────────┐
│ CACHED (可用)     │
└────────┬────────┐┘
         │        │
         │        └─ (是否过期？每 30 天一次)
         │           是 ↓
         │        ┌─────────────┐
         │        │ EXPIRED     │
         │        │ (需重建)     │
         │        └─────────────┘
         │
         └─ (执行期间失败？)
            是 ↓
         ┌──────────────┐
         │ INVALID      │
         │ (需重生成)    │
         └──────────────┘
```

---

## 第五部分：关键业务流程

### 5.1 首次任务执行流程

```
用户输入关键词 → TaskManager.createTask()
                    ↓
                [Task 状态: pending]
                    ↓
            TaskManager.executeTask()
                    ↓
                [Task 状态: running]
                    ↓
            WorkflowEngine.getOrCreateWorkflow()
                    ↓
                缓存中有工作流？
                    │ 有                │ 没有
                    ↓                   ↓
            [命中缓存]         LLMClient.generateWorkflow()
                    │                   ↓
                    │         [调用 Claude API]
                    │                   ↓
                    │         LLMClient.callLLM()
                    │           (Prompt 包含 SKILL.md)
                    │                   ↓
                    │         [返回 WorkflowDefinition]
                    │                   ↓
                    └─→ StorageManager.saveWorkflow()
                            ↓
                    WorkflowEngine.executeWorkflow()
                            ↓
                ┌─────────────────────────┐
                │ 逐步执行工作流中的步骤 │
                └────────┬────────────────┘
                         ↓
                Step 1: BrowserAPI.openPage()
                         ↓
                Step 2: BrowserAPI.waitForSelector()
                         ↓
                Step 3: BrowserAPI.click() (点击搜索)
                         ↓
                Step 4: BrowserAPI.scroll()
                         ↓
                Step 5: BrowserAPI.extractData() (提取笔记)
                         ↓
                Step 6: for each 笔记
                         └─→ BrowserAPI.click() (打开笔记)
                             ↓
                             BrowserAPI.extractData() (提取评论)
                             ↓
                             StorageManager.appendResults()
                         ↓
                Step 7: BrowserAPI.closePage()
                         ↓
            [Task 状态: completed]
                         ↓
            用户触发导出
                         ↓
            StorageManager.exportToJSON/CSV/Excel()
                         ↓
            [结果文件下载到本地]
```

### 5.2 失败恢复流程

```
执行步骤 → 出错
        ↓
ErrorHandler.handleError()
        ↓
        错误分类
        ├─ RATE_LIMIT (小红书 300031)
        │   ↓
        │   ErrorRecoveryPath: retry, delay=300000ms (5分钟)
        │   ↓
        │   等待 5 分钟后重试 (最多 3 次)
        │   ↓
        │   仍然失败 → 标记工作流为失效
        │            → 重新生成工作流
        │            → 继续执行
        │
        ├─ SELECTOR_NOT_FOUND
        │   ↓
        │   可能是页面改版
        │   ↓
        │   标记工作流为失效
        │   ↓
        │   LLMClient.generateWorkflow() (重生成)
        │   ↓
        │   继续执行
        │
        ├─ TIMEOUT
        │   ↓
        │   ErrorRecoveryPath: retry, delay=2000ms
        │   ↓
        │   重试 (最多 3 次)
        │
        └─ NETWORK_ERROR
            ↓
            ErrorRecoveryPath: retry, delay=1000ms
            ↓
            重试 (最多 5 次)
        ↓
所有恢复都失败
        ↓
[Task 状态: failed]
        ↓
用户可选：
├─ retryTask() (整个任务重来)
├─ resumeTask() (从失败点继续)
└─ cancelTask() (放弃)
```

---

## 第六部分：实现检查清单

### 6.1 基础设施

- [ ] Manifest V3 配置
- [ ] Service Worker 初始化
- [ ] IndexedDB 数据库创建与版本管理
- [ ] 消息传递系统 (popup → service worker → content script)
- [ ] 错误日志和监控基础

### 6.2 TaskManager

- [ ] 任务创建接口
- [ ] 任务状态管理
- [ ] 任务队列（FIFO）
- [ ] 任务重试机制
- [ ] 任务取消和暂停
- [ ] 任务历史查询

### 6.3 WorkflowEngine

- [ ] 工作流缓存策略
- [ ] 工作流过期检测（30 天）
- [ ] 工作流版本管理
- [ ] 工作流执行引擎
- [ ] 变量替换机制
- [ ] 步骤顺序执行与并行支持

### 6.4 BrowserAPI

- [ ] 真实浏览器 page/tab 管理
- [ ] openPage 与 closePage
- [ ] 元素等待与超时
- [ ] Click 操作（JS click）
- [ ] Scroll 操作（含懒加载等待）
- [ ] 文本输入与表单交互
- [ ] DOM 数据提取
- [ ] 截图功能

### 6.5 LLMClient

- [ ] Claude API 集成
- [ ] API Key 管理
- [ ] Prompt 模板设计与版本控制
- [ ] Token 计数和成本估算
- [ ] API 限流处理
- [ ] 重试与超时管理
- [ ] 工作流 Prompt 特化

### 6.6 StorageManager

- [ ] IndexedDB 操作封装
- [ ] 工作流的 CRUD
- [ ] 任务的 CRUD
- [ ] 结果分块存储与检索
- [ ] 导出到 JSON/CSV/Excel
- [ ] 缓存清理机制
- [ ] 存储配额管理

### 6.7 ErrorHandler

- [ ] 错误分类系统
- [ ] 各类错误的恢复策略
- [ ] 重试次数和延迟算法
- [ ] 错误日志记录
- [ ] 用户可见的错误提示

### 6.8 UI 层

- [ ] Popup HTML 和基础样式
- [ ] 关键词输入表单
- [ ] 参数配置面板
- [ ] 任务状态展示
- [ ] 进度条和实时反馈
- [ ] 导出按钮和选项
- [ ] 任务历史列表
- [ ] 结果预览

### 6.9 集成与测试

- [ ] 单元测试（各模块独立测试）
- [ ] 集成测试（模块间交互）
- [ ] 端到端测试（完整用户流程）
- [ ] 小红书场景测试
- [ ] 批量任务测试
- [ ] 失败恢复测试
- [ ] 性能测试（内存、CPU）
- [ ] 浏览器兼容性测试

### 6.10 文档

- [ ] API 文档
- [ ] 模块设计文档
- [ ] 工作流模板文档
- [ ] 错误处理指南
- [ ] 开发者快速开始指南

---

## 第七部分：技术选型建议

### 7.1 核心技术栈

| 技术域 | 建议选型 | 理由 |
|--------|---------|------|
| 插件框架 | Manifest V3 | Chrome 最新规范，向前兼容 |
| 数据库 | IndexedDB | 浏览器原生，无外部依赖 |
| 状态管理 | 自建或 Redux | 任务状态复杂，需清晰流转 |
| 构建工具 | Vite / Webpack | 快速开发和生产构建 |
| 通信 | Chrome Message API | 插件内部通信标准 |
| HTTP | Fetch API | 原生，无需额外库 |
| 时间处理 | Date + 时区库 | 避免时区混淆 |
| 导出 | xlsx 库 | Excel 导出的标准库 |

### 7.2 依赖最小化原则

- 尽量使用浏览器原生 API
- 避免重型框架（如 React）
- 只在必要时引入第三方库
- 监控代码体积

---

## 第八部分：性能考虑

### 8.1 内存管理

- 结果分块存储（每 100 条笔记一个 chunk）
- 使用 IndexedDB 而非内存
- 及时释放大对象引用
- 监控内存使用情况

### 8.2 执行性能

- 工作流缓存命中率目标 > 80%
- 单任务执行时间 (50 条笔记) < 3 分钟
- 批量任务支持暂停与恢复

### 8.3 网络性能

- 工作流生成（LLM 调用）缓存，减少 API 调用
- 工作流首次生成后，后续 99 次执行不需要 LLM
- API 请求复用和批处理

---

## 第九部分：安全与隐私

### 9.1 数据安全

- 所有结果保存在本地，不上传
- 不强制云同步
- 用户可完全控制数据删除

### 9.2 隐私保护

- 不采集用户浏览历史（除了任务历史）
- 不采集用户本地文件
- 不发送数据到第三方

### 9.3 API 安全

- Claude API Key 存储在浏览器本地存储
- 不在日志中暴露 API Key
- 定期提示用户轮换 Key

---

## 第十部分：部署与发布

### 10.1 开发环境

```
├─ src/
│  ├─ manifest.json
│  ├─ popup/
│  │  ├─ index.html
│  │  ├─ index.js
│  │  └─ style.css
│  ├─ background/
│  │  ├─ service-worker.js
│  │  ├─ task-manager.js
│  │  ├─ workflow-engine.js
│  │  ├─ llm-client.js
│  │  ├─ storage-manager.js
│  │  ├─ error-handler.js
│  │  └─ browser-api.js
│  └─ content/
│     └─ content-script.js
├─ tests/
├─ docs/
└─ build/
```

### 10.2 构建与测试流程

- 本地开发：`npm run dev` → 自动加载插件
- 单元测试：`npm run test`
- 构建生产：`npm run build`
- Chrome Web Store 提交

### 10.3 版本发布

- v0.1：内部测试版
- v0.2：小范围 Beta 版
- v1.0：正式发布版

---

## 总结

本文档定义了系统的：
1. 整体架构和模块划分
2. 数据结构和存储方案
3. 关键接口和 API
4. 状态机和流程
5. 实现检查清单
6. 技术选型建议

开发时应按上述检查清单逐项完成，确保各模块接口一致、数据流转清晰。