# 小红书采集助手 Chrome 插件 - 技术规格书

## 1. 概述

### 1.1 目标

Chrome 浏览器插件，利用用户真实浏览器登录态，按关键词搜索小红书并采集笔记、评论数据，导出为结构化文件。

### 1.2 核心设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| LLM 角色 | 仅做内容提取（DOM → 结构化数据） | LLM 擅长理解文本，不擅长猜测动态选择器 |
| 浏览器操作 | 确定性代码 + 选择器配置文件 | 可调试、可预测、选择器变了改配置即可 |
| 插件规范 | Chrome Manifest V3 | 当前标准 |
| UI | 原生 HTML/CSS/JS | 无框架依赖，插件 Popup 场景足够 |
| 存储 | IndexedDB | 浏览器原生，无外部依赖 |
| 并发 | 串行（单标签页） | 降低被检测风险 |

### 1.3 成功标准

- 输入关键词 → 自动采集搜索结果中的笔记列表 + 详情 + 评论
- 采集 50 条笔记（含评论）< 5 分钟
- 导出 JSON / CSV
- Service Worker 被杀后能自动恢复任务

---

## 2. 架构设计

### 2.1 系统架构

```
┌──────────────────────────────────────────────────┐
│  Popup UI (原生 HTML/CSS/JS)                      │
│  ├─ 关键词输入 + 配置                             │
│  ├─ 任务进度/状态                                 │
│  └─ 结果预览 + 导出                               │
└───────────────┬──────────────────────────────────┘
                │ chrome.runtime.sendMessage
                ↓
┌──────────────────────────────────────────────────┐
│  Service Worker (Background)                      │
│                                                   │
│  ┌─────────────┐  ┌────────────┐  ┌───────────┐  │
│  │ TaskManager  │  │  Scraper   │  │ LLMClient │  │
│  │ 任务生命周期 │  │ 采集调度   │  │ 内容提取  │  │
│  └──────┬──────┘  └─────┬──────┘  └─────┬─────┘  │
│         │               │               │         │
│  ┌──────┴───────────────┴───────────────┴──────┐  │
│  │              Storage (IndexedDB)             │  │
│  └──────────────────────────────────────────────┘  │
└───────────────┬──────────────────────────────────┘
                │ chrome.tabs.sendMessage
                ↓
┌──────────────────────────────────────────────────┐
│  Content Script (注入 xiaohongshu.com)             │
│  ├─ 接收命令：点击、滚动、输入、读取 DOM          │
│  └─ 返回结果：HTML 片段、操作状态                 │
└───────────────┬──────────────────────────────────┘
                │ 用户真实浏览器
                ↓
┌──────────────────────────────────────────────────┐
│  小红书网站 (xiaohongshu.com)                     │
└──────────────────────────────────────────────────┘
```

### 2.2 模块职责

| 模块 | 职责 | 运行环境 |
|------|------|----------|
| **Popup** | 用户交互：输入、配置、查看进度、导出 | 插件弹窗 |
| **TaskManager** | 任务 CRUD、状态流转、持久化、恢复 | Service Worker |
| **Scraper** | 编排采集步骤：搜索→翻页→打开笔记→采集评论 | Service Worker |
| **LLMClient** | 调用 Claude API，将 DOM HTML 转为结构化数据 | Service Worker |
| **Storage** | IndexedDB 封装：任务、结果、配置的读写 | Service Worker |
| **Content Script** | 无脑执行器：接收命令，操作 DOM，返回结果 | 目标页面 |

### 2.3 通信协议

Service Worker ↔ Content Script 使用 `chrome.tabs.sendMessage` 通信，协议如下：

**命令（SW → CS）：**

```js
// 等待元素出现
{ action: "waitFor", selector: ".search-result", timeout: 10000 }

// 点击元素
{ action: "click", selector: ".note-card a" }

// 滚动页面
{ action: "scroll", direction: "down", distance: 800 }

// 输入文本
{ action: "type", selector: "#search-input", text: "关键词" }

// 读取 DOM HTML
{ action: "getHTML", selector: ".feed-container" }

// 读取文本内容
{ action: "getText", selector: ".note-content" }

// 执行任意 JS（兜底）
{ action: "eval", script: "document.title" }
```

**响应（CS → SW）：**

```js
// 成功
{ ok: true, data: "..." }

// 失败
{ ok: false, error: "SELECTOR_NOT_FOUND", message: "..." }
{ ok: false, error: "TIMEOUT", message: "..." }
```

---

## 3. 站点经验库与可配置操作流引擎 (借鉴 web-access)

本项目借鉴 [eze-is/web-access](https://github.com/eze-is/web-access) 核心架构思想：**“站点经验库 (Site Patterns) + 像人类一样浏览的交互闭环 + 可复用动作流水线”**。

### 3.1 为什么采用站点经验模式？

| 对比维度 | 传统纯硬编码选择器 | 原 Brief 纯 LLM 猜工作流 | **本项目：web-access 站点经验模式** |
|---------|------------------|-------------------------|-----------------------------------|
| **改版应对** | 代码写死，改版即死 | token 昂贵且瞎猜 webpack 类名 | **经验模式热更新**，降级容错，成功后自沉淀 |
| **反爬风控** | 容易机械化被封 | 无法感知站内交互规则 | **吸纳人类浏览经验**（站内浮层打开、抖动滚动、避坑规则） |
| **可复用性** | 难扩展到新站点 | 每次都要重新生成 Prompt | **标准化 Action Recipe**，换入参数即可无损复用 |

### 3.2 站点经验库定义 (`config/site-patterns.json`)

```json
{
  "xiaohongshu.com": {
    "platform": "小红书网页版",
    "version": "1.0.0",
    "meta": {
      "homeUrl": "https://www.xiaohongshu.com",
      "searchUrlTemplate": "https://www.xiaohongshu.com/search_result?keyword={keyword}"
    },
    "patterns": {
      "interaction": {
        "openDetailMethod": "click_card",       // 经验：通过点击卡片呼出浮层更安全，不直接在新标签页打开
        "closeDetailMethod": "click_mask_or_esc",// 经验：详情页可通过点击蒙层或发送 ESC 关闭
        "scrollStyle": "human_stepped"          // 经验：分段阶梯式滚动 + 随机停顿，规避滑块风控
      },
      "traps": {
        "loginDialog": {
          "detectSelector": ".login-container, .modal-mask",
          "strategy": "check_user_auth_or_prompt" // 阻断时及时向用户提示登录
        },
        "rateLimit": {
          "code": 300031,
          "cooldownSeconds": 300
        }
      },
      "selectors": {
        "search": {
          "input": ["#search-input", "input.search-input", "input[placeholder*='搜索']"],
          "searchButton": [".search-btn", "button[type='submit']"],
          "feedsContainer": [".feeds-page", ".search-result-feeds", "section[class*='feed']"],
          "noteCard": [".note-item", "section.note-card", "div[data-note-id]"],
          "noteLink": [".note-item a.cover", "a[href*='/explore/']"]
        },
        "noteDetail": {
          "container": ["#noteContainer", ".note-detail-mask", ".note-container"],
          "title": [".note-title", "#detail-title", "h1[class*='title']"],
          "content": [".note-content", ".content-text", "[class*='content-desc']"],
          "commentSection": [".comments-container", ".comment-wrapper"],
          "commentItem": [".comment-item", "div[class*='comment-item']"]
        }
      }
    },
    // 可复用的标准化动作流水线 (Action Recipe)
    "recipes": {
      "searchAndCollect": [
        { "action": "navigate", "url": "{searchUrlTemplate}" },
        { "action": "waitFor", "selectorKey": "search.feedsContainer", "timeout": 10000 },
        { "action": "loopScroll", "count": "{scrollTimes}", "style": "human_stepped" },
        { "action": "extractBatch", "selectorKey": "search.feedsContainer", "extractor": "llm.extractNoteList" }
      ],
      "collectNoteDetail": [
        { "action": "click", "selectorKey": "search.noteLink", "targetIndex": "{index}" },
        { "action": "waitFor", "selectorKey": "noteDetail.container", "timeout": 8000 },
        { "action": "extract", "selectorKey": "noteDetail.container", "extractor": "llm.extractNoteDetail" },
        { "action": "extract", "selectorKey": "noteDetail.commentSection", "extractor": "llm.extractComments" },
        { "action": "closeModal", "strategy": "click_mask_or_esc" }
      ]
    }
  }
}
```

### 3.3 经验的自适应与演进机制

1. **多重备选选择器**：每个元素提供 2~3 个候选选择器（标签属性、语义化 Class、XPath/文本），按顺序探测。
2. **执行反馈与经验演进**：当首选选择器失效但次选成功时，系统记录反馈日志，可在配置中自动将成功的选择器前移。
3. **扩展性**：后续支持扩展新站点（如 `weibo.com`、`douyin.com`），只需在 `site-patterns.json` 中配置一套经验规则与 Recipe，核心调度引擎完全复用。

---

## 4. 数据结构

### 4.1 任务（Task）

```js
{
  id: "task_1728576000_abc",       // 时间戳 + 随机后缀
  status: "pending",                // pending | running | paused | completed | failed
  keyword: "护肤推荐",
  config: {
    notesLimit: 20,                 // 采集笔记数上限
    commentsPerNote: 5,             // 每条笔记采集评论数
    outputFormat: "json"            // json | csv
  },

  // 进度（用于 SW 重启恢复）
  progress: {
    phase: "idle",                  // idle | searching | collectingNotes | collectingComments | done
    notesCollected: 0,
    notesTotal: 0,
    currentNoteIndex: -1,           // 当前处理到第几条笔记
    commentsCollected: 0,
    scrollCount: 0,                 // 搜索页已滚动次数
    noteUrls: []                    // 搜索阶段收集到的笔记 URL 列表
  },

  // 时间
  createdAt: 1728576000000,
  startedAt: null,
  completedAt: null,

  // 错误记录
  errors: []
}
```

### 4.2 笔记（Note）

```js
{
  id: "note_abc123",
  taskId: "task_1728576000_abc",
  url: "https://www.xiaohongshu.com/explore/...",

  title: "秋冬护肤必看！",
  content: "正文内容...",
  author: "用户名",
  authorId: "user_xyz",

  likes: 1234,
  comments: 56,
  collects: 789,
  shares: 12,

  tags: ["护肤", "秋冬"],
  images: ["https://...jpg", "https://...jpg"],
  type: "image",                    // image | video
  publishedAt: "2026-10-01",

  // 采集的评论
  commentList: [
    {
      id: "comment_1",
      author: "评论者",
      text: "太有用了！",
      likes: 23,
      publishedAt: "2026-10-02"
    }
  ],

  collectedAt: 1728576500000
}
```

### 4.3 IndexedDB Schema

```
Database: "xhs-agent"
Version: 1

ObjectStore: "tasks"
  keyPath: "id"
  indexes: ["status", "createdAt"]

ObjectStore: "notes"
  keyPath: "id"
  indexes: ["taskId", "collectedAt"]

ObjectStore: "config"
  keyPath: "key"
  // 存储：API Key、选择器配置、用户偏好
```

三个 store 够用。不需要单独的 cache store —— 没有工作流缓存了。

---

## 5. LLM 集成策略

### 5.1 角色定位

LLM **只做一件事**：把 DOM HTML 片段转成结构化 JSON。

不生成工作流，不决定操作步骤，不猜选择器。

### 5.2 调用时机

| 场景 | 输入 | 输出 |
|------|------|------|
| 提取搜索结果列表 | 搜索结果容器的 innerHTML | `[{title, url, author, likes, type}, ...]` |
| 提取笔记详情 | 笔记页面主体的 innerHTML | `{title, content, author, likes, tags, images, ...}` |
| 提取评论 | 评论区的 innerHTML | `[{author, text, likes, date}, ...]` |

### 5.3 Prompt 设计

```
System Prompt:
你是一个 HTML 数据提取器。给你一段小红书页面的 HTML 片段，
你需要从中提取结构化数据并返回 JSON。
只返回 JSON，不要解释。如果某个字段无法提取，值设为 null。

User Prompt (搜索结果):
从以下 HTML 中提取所有笔记卡片信息。
每条笔记返回：title, url, author, authorUrl, likes, coverImage, type (image/video)

返回格式：[{title: "...", url: "...", ...}, ...]

HTML:
<div class="feeds-page">...</div>
```

### 5.4 成本控制

- **批量提取**：搜索结果页一次调用提取所有卡片（而非每张卡片一次）
- **HTML 精简**：发送前移除 `<script>`、`<style>`、`<svg>`、data URI 等无用内容，减少 token
- **使用轻量模型**：数据提取不需要强推理，用 Claude Haiku 或 Sonnet 足够
- **缓存**：同一 URL 的页面不重复提取

### 5.5 LLMClient 接口

```js
class LLMClient {
  constructor(apiKey, model = "claude-sonnet")

  // 提取搜索结果中的笔记列表
  async extractNoteList(html) → Note[]

  // 提取笔记详情
  async extractNoteDetail(html) → NoteDetail

  // 提取评论列表
  async extractComments(html) → Comment[]

  // 通用提取（兜底）
  async extract(html, schema) → any
}
```

三个专用方法，每个内置对应的 prompt。一个通用方法做兜底。够了。


---

## 6. 关键流程

### 6.1 搜索采集流程

```
用户点击"开始" (Popup)
  → TaskManager.create(keyword, config)
  → Task 状态: pending → running
  → Scraper.run(task)

Phase 1: 搜索
  1. chrome.tabs.update(tabId, { url: 搜索URL })
  2. CS.waitFor(selectors.search.resultContainer)
  3. CS.getHTML(selectors.search.resultContainer)
  4. LLM.extractNoteList(html) → noteUrls[]
  5. 保存 noteUrls 到 task.progress（检查点）
  6. 如果笔记数不够 → CS.scroll("down") → 等待加载 → 重复 3-5
  7. 如果笔记数够了 → 进入 Phase 2

Phase 2: 采集笔记详情
  for each noteUrl in task.progress.noteUrls:
    1. chrome.tabs.update(tabId, { url: noteUrl })
    2. CS.waitFor(selectors.noteDetail.container)
    3. CS.getHTML(selectors.noteDetail.container)
    4. LLM.extractNoteDetail(html) → noteData
    5. 进入 Phase 3（评论）

Phase 3: 采集评论（在同一页面）
    6. CS.waitFor(selectors.noteDetail.commentSection)
    7. CS.getHTML(selectors.noteDetail.commentSection)
    8. LLM.extractComments(html) → comments[]
    9. Storage.saveNote({ ...noteData, commentList: comments })
    10. 更新 task.progress.currentNoteIndex（检查点）
    11. 随机等待 2-5 秒
    12. 继续下一条笔记

Phase 4: 完成
  → Task 状态: running → completed
  → 通知 Popup 显示完成
```

### 6.2 Service Worker 重启恢复流程

```
SW 启动 (install/activate/alarm)
  → Storage.getTasksByStatus("running")
  → 有未完成任务？
     → 读取 task.progress
     → 根据 phase 和 currentNoteIndex 恢复
     → Scraper.resume(task)
```

### 6.3 导出流程

```
用户点击"导出" (Popup)
  → Storage.getNotesByTaskId(taskId)
  → 格式化为 JSON 或 CSV
  → chrome.downloads.download(blob)
```

---

## 7. MV3 Service Worker 生命周期

### 7.1 问题

Chrome MV3 的 Service Worker 会被杀掉：
- 30 秒无活动 → idle
- 5 分钟 → 强制终止

采集任务可能运行 3-5 分钟，必须应对中断。

### 7.2 方案

**保活：** 采集过程中，每个步骤都涉及 `chrome.tabs.sendMessage` 等待响应，SW 在等待期间不会 idle。步骤之间的随机延迟用 `chrome.alarms` 实现（而非 `setTimeout`）。

**检查点：** 每完成一个关键步骤（收集到 noteUrls、完成一条笔记采集），立即将进度写入 IndexedDB。

**恢复：** SW 重启时，检查是否有 status=running 的任务，从最后检查点恢复。

```js
// 保活 alarm — 每 25 秒触发
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "keepalive") {
    // 检查是否有进行中的任务
    const runningTask = await Storage.getRunningTask();
    if (runningTask) {
      await Scraper.resume(runningTask);
    }
  }
});
```

**延迟等待：** 步骤之间的随机延迟不用 `setTimeout`（SW 可能被杀），用 alarm：

```js
// 等待 3 秒后继续下一步
chrome.alarms.create("next-step", { delayInMinutes: 3 / 60 });
```

---

## 8. 反爬策略

| 策略 | 实现 |
|------|------|
| 随机延迟 | 每个操作之间等待 2-5 秒（随机） |
| 滚动模拟 | 分多次小幅滚动，间隔 300-800ms |
| 单标签串行 | 同一时间只操作一个标签页 |
| 频率限制应对 | 检测到 300031 错误码 → 暂停 5 分钟后重试 |
| 请求间隔 | 笔记之间间隔 3-8 秒（随机） |
| 登录态依赖 | 使用用户真实 cookie，不伪造请求 |

**登录态检测：** 采集前检查页面是否有登录标识（如用户头像元素）。如果未登录，提示用户先登录。

---

## 9. 错误处理

### 9.1 错误分类与恢复

| 错误类型 | 检测方式 | 恢复策略 |
|----------|----------|----------|
| 选择器失效 | waitFor 超时 | 记录错误，通知用户更新 selectors.json |
| 频率限制 | 页面出现 300031 或验证码 | 暂停 5 分钟，最多重试 3 次 |
| 网络错误 | fetch 失败 | 重试 3 次，间隔 2 秒 |
| 页面加载超时 | 30 秒未加载完 | 重试 2 次 |
| LLM API 失败 | API 返回错误 | 重试 2 次，间隔 5 秒 |
| LLM 返回格式错误 | JSON.parse 失败 | 重试 1 次（换 prompt 措辞） |
| 未登录 | 检测不到用户标识 | 暂停任务，提示用户登录 |

### 9.2 容错原则

- **单条笔记失败不中断整个任务**：记录错误，跳过该笔记，继续下一条
- **评论采集失败不影响笔记数据**：笔记已采集的数据照常保存
- **所有错误都记录到 task.errors**：用户可查看失败原因

---

## 10. 分期交付

### P1：核心采集（MVP）

- [ ] Manifest V3 基础设施 + 消息通信
- [ ] Content Script 命令执行器
- [ ] 站点经验配置 (`site-patterns.json`)
- [ ] TaskManager（创建、执行、完成、失败）
- [ ] Scraper（基于经验库的动作执行引擎）
- [ ] LLMClient（三个提取方法）
- [ ] Storage（IndexedDB 基础 CRUD）
- [ ] SW 保活 + 检查点 + 重启恢复
- [ ] Popup 极简交互界面（单手操作流 + 折叠高级面板）
- [ ] 基础错误处理 + 拟人化反爬延迟

**交付标准：** 输入一个关键词 → 采集 20 条笔记+评论 → 导出 JSON。

### P2：增强功能

- [ ] 多关键词批量任务（支持文本框多行输入）
- [ ] 任务暂停 / 恢复
- [ ] Excel (xlsx) 导出
- [ ] 任务历史列表与本地管理
- [ ] 结果抽屉式预览（在 Popup 中查看）
- [ ] 经验库热更新与在线同步

### P3：进阶功能

- [ ] 截图留证功能
- [ ] 经验自演进（执行反馈自动调整候选选择器权重）
- [ ] 更多站点支持（抖音、微博等只需扩展 site-patterns.json）
- [ ] 数据可视化看板

---

## 11. 极简 UI 设计与交互流程

### 11.1 极简“小白单手操作”设计

Popup 界面严禁冗杂，采用 **默认极简流 + 折叠高级抽屉** 双层布局：

```
┌──────────────────────────────────────┐
│  📕 小红书采集助手            [⚙️设置] │
├──────────────────────────────────────┤
│ 关键词:                              │
│ [ 输入关键词，如：秋冬穿搭搭配       ] │
│                                      │
│ 采集条数: [ 20 篇 ▼ ]                │
│                                      │
│ [ 🚀 开始一键采集                  ] │
├──────────────────────────────────────┤
│ [▼ 高级选项（采集评论、延迟设置）]    │
├──────────────────────────────────────┤
│ 状态: 正在采集第 5/20 篇 (秋冬针织...) │
│ [████████░░░░░░░░░░░░░░░░░░] 25%     │
│                                      │
│ [ 📥 导出 JSON ]    [ 📥 导出 CSV ]   │
└──────────────────────────────────────┘
```

1. **核心极简流（三步直达）：**
   - 填词 → 点【开始一键采集】 → 采集完成自动激活【导出】按钮。
2. **高级选项面板（默认折叠）：**
   - 是否包含评论（默认开启，前 5 条）
   - 爬取安全模式（保守随机 3~8 秒 / 极速模式）
   - Claude API Key 配置与模型选择（Claude 3.5 Sonnet / Haiku）
   - 站点经验/选择器配置快捷查看与重置

---

## 12. 项目结构与技术栈

### 12.1 目录结构

```
xhs/
├── src/
│   ├── manifest.json
│   ├── popup/
│   │   ├── index.html             # 极简 UI 双层设计
│   │   ├── popup.js               # 界面状态与消息发送
│   │   └── popup.css              # 现代化移动端风格轻量样式
│   ├── background/
│   │   ├── service-worker.js      # 入口，注册 alarm/message listener
│   │   ├── task-manager.js        # 任务状态机
│   │   ├── scraper.js             # 经验驱动的采集引擎
│   │   ├── llm-client.js          # 内容结构化提取
│   │   └── storage.js             # IndexedDB 统一管理
│   ├── content/
│   │   └── content-script.js      # 页面 DOM 操作与模拟点击
│   └── config/
│       └── site-patterns.json     # 借鉴 web-access 的站点经验库与动作流
├── doc/
│   ├── brief.md                   # 原始设计（归档）
│   └── spec.md                    # 本文档
├── tests/
└── package.json
```

### 11.2 技术栈

| 用途 | 选型 | 备注 |
|------|------|------|
| 插件规范 | Manifest V3 | |
| UI | 原生 HTML/CSS/JS | 无框架 |
| 存储 | IndexedDB | 浏览器原生 |
| LLM | Claude API (Sonnet/Haiku) | 仅做内容提取 |
| HTTP | fetch | 原生 |
| 构建 | 无（或 esbuild） | JS 文件直接加载，必要时用 esbuild 打包 |
| 导出 CSV | 手写 | 几十行代码，不需要库 |
| 导出 Excel | SheetJS (P2) | P2 阶段再引入 |

### 12.3 Manifest 配置要点

```json
{
  "manifest_version": 3,
  "permissions": ["tabs", "activeTab", "storage", "alarms", "downloads"],
  "host_permissions": ["*://*.xiaohongshu.com/*"],
  "background": {
    "service_worker": "background/service-worker.js"
  },
  "content_scripts": [{
    "matches": ["*://*.xiaohongshu.com/*"],
    "js": ["content/content-script.js"]
  }],
  "action": {
    "default_popup": "popup/index.html"
  }
}
```

---

## 13. 任务状态机

```
           create
             │
             ▼
         ┌────────┐
         │pending │
         └───┬────┘
             │ execute
             ▼
         ┌────────┐   pause    ┌────────┐
         │running │──────────→│ paused │  (P2)
         └┬──┬──┬─┘           └───┬────┘
          │  │  │    resume       │
          │  │  │ ←───────────────┘
          │  │  │
          │  │  └─ cancel ──→ ┌──────────┐
          │  │                │cancelled │
          │  │                └──────────┘
          │  │
          │  └─ 全部完成 ──→ ┌──────────┐
          │                  │completed │
          │                  └──────────┘
          │
          └─── 失败 ──→ ┌────────┐
                        │ failed │
                        └───┬────┘
                            │ retry
                            └──→ running
```

---

## 总结

与原 brief 的关键变化：

1. **砍掉 WorkflowEngine**：不再让 LLM 生成工作流，改为确定性采集代码 + 选择器配置
2. **LLM 专注内容提取**：DOM HTML → 结构化 JSON，做它擅长的事
3. **增加 MV3 生命周期管理**：检查点 + alarm 保活 + 重启恢复
4. **增加反爬策略**：随机延迟、行为模拟、限流应对
5. **分三期交付**：P1 核心采集 MVP → P2 增强 → P3 进阶
6. **精简数据结构**：砍掉 WorkflowDefinition、WorkflowStep 等不再需要的类型
7. **精简技术栈**：无 UI 框架、无构建工具（或最轻量的 esbuild）
