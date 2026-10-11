# 小红书采集插件 (XHS Agent) P1 实施开发文档

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个基于 Chrome Manifest V3、原生 JS、融合 `web-access` 站点经验库架构的小红书数据采集插件，实现输入关键词自动采集笔记与评论并导出 JSON/CSV。

**Architecture:** 
- **Popup UI**：极简单手操作界面，负责触发任务、监听进度与下载导出。
- **Service Worker**：核心中枢，负责任务队列生命周期、基于 `chrome.alarms` 保活与断点恢复、调度 Scraper。
- **Scraper & Engine**：读取 `site-patterns.json` 经验库，将参数填入 Action Recipe，驱动 Content Script 执行拟人化操作。
- **Content Script**：页面 DOM 执行器，接收命令执行点击、滚动、读取 HTML 片段并反馈。
- **LLMClient**：调用 Claude API 将截取的 DOM HTML 结构化解析为标准 JSON。
- **Storage**：IndexedDB 封装，负责任务、笔记与配置持久化。

**Tech Stack:** Chrome Extension Manifest V3, Vanilla JavaScript (ES6+), IndexedDB, Claude API (Haiku / 3.5 Sonnet), Node.js (测试环境与构建脚本)

**Spec:** [spec.md](file:///D:/code/myself/xhs/doc/spec.md)

---

## Global Constraints

- 遵循 Chrome Manifest V3 规范（无持久化后台，禁止任意远程代码注入 eval）。
- 零重型 UI 框架依赖，Popup 采用原生 HTML + CSS + JS。
- 浏览器操作严守拟人化原则（步进滚动、随机 2~5s 停顿、站内详情卡片浮层交互）。
- Service Worker 必须具备 25s Alarm 保活机制与断点恢复能力。
- 本地数据存储于 IndexedDB，不依赖任何外部后端服务器。

## Review Focus

1. **Service Worker 被杀中断**：当爬取进行到一半浏览器挂起 SW，重新激活时必须能根据 `task.progress` 的 `currentNoteIndex` 继续，不能重头重新爬。
2. **小红书登录弹窗阻断**：页面弹出登录遮罩时，Content Script 探测到必须上报 `AUTH_REQUIRED` 状态并在 Popup 给出明确提示。
3. **选择器改版失效**：首选 Class 失效时，必须按 `site-patterns.json` 中的多级备选策略（属性选择器、文本包含）降级探测，全部失效才抛出异常。
4. **LLM 返回非合法 JSON**：Markdown 代码块包裹或畸形字符串时，必须有正则清洗与解析重试保护。
5. **单条笔记/评论失败容错**：单条详情或评论提取超时不能中断后续笔记采集，记录错误并跳过。

---

## 模块与文件结构规划

```
xhs/
├── src/
│   ├── manifest.json
│   ├── config/
│   │   └── site-patterns.json      # 借鉴 web-access 的站点经验库
│   ├── popup/
│   │   ├── index.html              # 极简双层 UI 页面
│   │   ├── popup.css               # 轻量布局与状态样式
│   │   └── popup.js                # UI 逻辑与状态展示
│   ├── background/
│   │   ├── service-worker.js       # 扩展入口、消息分发、Alarm 保活
│   │   ├── storage.js              # IndexedDB 统一 CRUD 封装
│   │   ├── task-manager.js         # 任务状态机与队列流转
│   │   ├── llm-client.js           # Claude API 结构化提取客户端
│   │   └── scraper.js              # 经验驱动的采集与通信调度器
│   └── content/
│       └── content-script.js       # 目标网页 DOM 操作与事件执行器
└── tests/
    ├── storage.test.js
    ├── llm-client.test.js
    └── site-patterns.test.js
```

---

## 实施任务清单

### Task 1: 基础设施搭建与 Manifest V3 配置

**Files:**
- Create: `package.json`
- Create: `src/manifest.json`
- Create: `src/config/site-patterns.json`
- Test: `tests/site-patterns.test.js`

**Interfaces:**
- Produces: `site-patterns.json` 导出标准化小红书经验结构（选择器备选列表、Recipe 操作流、反爬参数）

- [ ] **Step 1: 编写测试验证 site-patterns.json 结构完整性**
  验证包含 `xiaohongshu.com` 节点、`meta`、`patterns.selectors` 及 `recipes.searchAndCollect`。
- [ ] **Step 2: 运行测试验证失败**
  `node --test tests/site-patterns.test.js` 预期文件不存在报错。
- [ ] **Step 3: 创建 `src/config/site-patterns.json` 与 `src/manifest.json`**
  实现符合 Manifest V3 标准的 permissions（`tabs`, `storage`, `alarms`, `downloads`）与 host_permissions。
- [ ] **Step 4: 运行测试验证通过**
- [ ] **Step 5: Git Commit**
  `git commit -m "chore: setup project structure, manifest v3, and site-patterns"`

---

### Task 2: StorageManager (IndexedDB 本地存储层)

**Files:**
- Create: `src/background/storage.js`
- Test: `tests/storage.test.js`

**Interfaces:**
- Produces: `StorageManager`
  - `saveTask(task): Promise<void>`
  - `getTask(id): Promise<Task|null>`
  - `getRunningTask(): Promise<Task|null>`
  - `updateTaskProgress(id, progress): Promise<void>`
  - `saveNote(note): Promise<void>`
  - `getNotesByTaskId(taskId): Promise<Note[]>`
  - `getConfig(key): Promise<any>`
  - `saveConfig(key, val): Promise<void>`

- [ ] **Step 1: 编写 StorageManager 单元测试**
  测试任务创建、状态更新、根据 status 查询进行中任务、批量写入/读取笔记。
- [ ] **Step 2: 运行测试验证失败**
- [ ] **Step 3: 实现 `src/background/storage.js`**
  使用原生 IndexedDB，创建数据库 `xhs-agent`，包含 `tasks`、`notes`、`config` 三个 ObjectStore 并建立索引。
- [ ] **Step 4: 运行测试验证通过**
- [ ] **Step 5: Git Commit**
  `git commit -m "feat(storage): implement IndexedDB storage manager with checkpoint support"`

---

### Task 3: LLMClient (内容结构化提取模块)

**Files:**
- Create: `src/background/llm-client.js`
- Test: `tests/llm-client.test.js`

**Interfaces:**
- Produces: `LLMClient`
  - `extractNoteList(htmlSnippet): Promise<Array<{title, url, author, likes, type}>>`
  - `extractNoteDetail(htmlSnippet): Promise<{title, content, author, likes, tags, images}>`
  - `extractComments(htmlSnippet): Promise<Array<{author, text, likes, publishedAt}>>`

- [ ] **Step 1: 编写 LLMClient 单元测试（带 Mock API）**
  覆盖：HTML 冗余标签预清理（`<script>`、`<style>`）、API 调用封装、JSON 清洗解析容错。
- [ ] **Step 2: 运行测试验证失败**
- [ ] **Step 3: 实现 `src/background/llm-client.js`**
  集成 Claude API，定义专用的 System Prompt 与数据提取模板，内置 JSON 修复逻辑。
- [ ] **Step 4: 运行测试验证通过**
- [ ] **Step 5: Git Commit**
  `git commit -m "feat(llm): implement LLMClient for DOM to structured data extraction"`

---

### Task 4: Content Script (页面执行器与多级备选选择器探测)

**Files:**
- Create: `src/content/content-script.js`
- Modify: `src/manifest.json`

**Interfaces:**
- Consumes: Background 发送的 actions（`waitFor`, `click`, `scroll`, `getHTML`, `type`, `closeModal`）
- Produces: 操作结果 `{ ok: boolean, data?: any, error?: string }`

- [ ] **Step 1: 实现多级备选选择器解析器 `findFirstElement(selectors)`**
  依次尝试 CSS Selector、XPath、文本匹配，直到找到元素或超时。
- [ ] **Step 2: 实现拟人化步进滚动 `steppedScroll(distance, duration)`**
  模拟人类手指/滚轮分段滚动，带随机抖动与微小延迟。
- [ ] **Step 3: 监听 `chrome.runtime.onMessage`**
  分发 `waitFor`、`click`、`scroll`、`getHTML`、`closeModal` 等指令。
- [ ] **Step 4: 编写测试用例或在测试页面验证指令响应**
- [ ] **Step 5: Git Commit**
  `git commit -m "feat(content): implement robust content script with fallback selectors and human scroll"`

---

### Task 5: Scraper 采集调度器与 TaskManager

**Files:**
- Create: `src/background/task-manager.js`
- Create: `src/background/scraper.js`

**Interfaces:**
- Consumes: `StorageManager`, `LLMClient`, `site-patterns.json`
- Produces:
  - `TaskManager`: `createTask`, `updateStatus`, `getTask`
  - `Scraper`: `run(task)`, `resume(task)`, `cancel(taskId)`

- [ ] **Step 1: 实现 TaskManager 任务状态转移机**
  处理 `pending` -> `running` -> `completed`/`failed`/`cancelled`，记录时间与检查点。
- [ ] **Step 2: 实现 Scraper 经验驱动采集调度**
  - **搜索阶段**：导航至搜索 URL -> 等待 feeds -> 循环滚动加载 -> 截取 HTML -> LLM 提取卡片列表 -> 写入 `task.progress.noteUrls`。
  - **详情与评论阶段**：站内点击笔记卡片打开浮层 -> 截取详情 HTML -> 提取正文与评论 -> 保存 Note -> 关闭浮层 -> 记录进度。
  - **反爬防御**：操作间随机 2~5s 停顿，异常捕获容错。
- [ ] **Step 3: 验证断点恢复机制**
  测试当中断后调用 `Scraper.resume(task)`，能从 `currentNoteIndex` 继续处理未爬笔记。
- [ ] **Step 4: Git Commit**
  `git commit -m "feat(engine): implement TaskManager and Scraper engine driven by site-patterns"`

---

### Task 6: Service Worker 生命周期管理与保活机制

**Files:**
- Create: `src/background/service-worker.js`
- Modify: `src/manifest.json`

**Interfaces:**
- Produces: 监听 `chrome.runtime.onMessage`（接收 Popup 控制命令）、`chrome.alarms.onAlarm`（25s 周期保活与任务续爬）

- [ ] **Step 1: 注册 `keepalive` Alarm**
  设置每 25 秒触发一次的 Alarm。
- [ ] **Step 2: 实现 Alarm 唤醒检查**
  检测 IndexedDB 中是否存在 `status === 'running'` 的任务，若 Scraper 未在执行则触发 `resume`。
- [ ] **Step 3: 绑定通信事件**
  监听来自 Popup 的 `START_TASK`、`CANCEL_TASK`、`GET_PROGRESS`、`EXPORT_DATA` 消息。
- [ ] **Step 4: Git Commit**
  `git commit -m "feat(background): integrate service worker lifecycle management and alarms keepalive"`

---

### Task 7: 极简 Popup UI (单手操作流 + 高级设置面板)

**Files:**
- Create: `src/popup/index.html`
- Create: `src/popup/popup.css`
- Create: `src/popup/popup.js`

**Interfaces:**
- Consumes: Service Worker 的消息通信通道

- [ ] **Step 1: 编写 `index.html` 极简布局**
  - 核心区：标题、关键词输入框、采集数量选择器、[开始一键采集] 按钮。
  - 进度区：进度条、当前采集状态文字、错误提示区。
  - 导出区：[导出 JSON]、[导出 CSV] 按钮。
  - 高级抽屉（折叠）：Claude API Key 输入、采集评论开关、爬取延迟选择、经验库重置。
- [ ] **Step 2: 编写现代化轻量 CSS (`popup.css`)**
  移动端现代风格设计，兼顾紧凑与美观，支持折叠动画。
- [ ] **Step 3: 编写 `popup.js`**
  - 读取并保存用户 API Key 及配置。
  - 监听采集按钮点击，向 Service Worker 发送 `START_TASK`。
  - 轮询/监听任务进度，动态更新进度条。
  - 实现纯前端 CSV 与 JSON 字符串生成并通过 `chrome.downloads` 或 Blob URL 下载。
- [ ] **Step 4: Git Commit**
  `git commit -m "feat(popup): build minimalist user interface and export utilities"`

---

### Task 8: 端到端集成与反爬验证

**Files:**
- Modify: `src/background/scraper.js` (微调防抖动与延迟)
- Modify: `src/popup/popup.js`

- [ ] **Step 1: 完整流程演练**
  配置本地测试环境，在真实 Chrome 中加载 Unpacked 扩展。
- [ ] **Step 2: 验证核心链路**
  测试输入关键词 -> 打开小红书搜索 -> 采集 5 篇笔记及评论 -> 成功导出 JSON 与 CSV。
- [ ] **Step 3: 异常边界验证**
  验证未登录时拦截提示、网络波动重试、中断后重启浏览器继续爬取。
- [ ] **Step 4: Git Commit**
  `git commit -m "test(e2e): verify end-to-end collection, checkpoint resume, and export"`

---

## 交付与自审清单

- [x] **Spec Coverage**：覆盖 [spec.md](file:///D:/code/myself/xhs/doc/spec.md) P1 阶段的所有要求。
- [x] **Site-Patterns 经验落地**：全流程解耦，操作流与选择器完全由经验库驱动。
- [x] **MV3 生命周期闭环**：包含 25s 周期保活与 IndexedDB 检查点恢复。
- [x] **极简 UI 体验**：普通用户三步（填词-开始-导出），高级配置收拢于抽屉。
