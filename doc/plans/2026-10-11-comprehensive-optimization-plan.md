# 小红书采集助手综合体验与功能优化计划 (Comprehensive Optimization Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

本计划基于用户在实际采集中的深度反馈，重点解决**频控限流熔断、随时即时导出、提前完成归档、评论采集深度控制、CSV 乱码修复与双表导出、批量关键词队列、以及独立标签页/侧边栏防失焦**等核心痛点。

---

## 模块架构与涉及文件

```
src/
├── config/site-patterns.json     [M] 增加限流/风控陷阱（如“当前笔记暂时无法浏览”、“App扫码”）特征检测
├── popup/
│   ├── index.html                [M] 增加随时导出计数、提前完成按钮、评论深度单选、批量多词输入、新窗口打开
│   ├── popup.css                 [M] 优化状态流布局、卡片高亮、队列指示、独立窗口自适应
│   └── popup.js                  [M] 随时导出逻辑、提前完成消息派发、批量词队列调度、BOM CSV 导出
├── background/
│   ├── scraper.js                [M] 详情页限流熔断检测 (RateLimitError)、提前完成信号处理、评论深度适配
│   ├── task-manager.js           [M] 增加 rate_limited 状态支持（或友好终态标记）
│   ├── service-worker.js         [M] 增加 FINISH_EARLY_TASK、EXPORT_INCREMENTAL、以及批量任务调度
│   └── storage.js                [M] 支持按任务按阶段高效导出笔记与评论
└── content/content-script.js     [M] 增加限流页面特征侦测 (checkRateLimit)、评论数量上限控制
```

---

## 阶段任务划分

### Task 1: 限流与风控拦截自动检测与保护 (Rate Limit & Anti-Crawler Trap Protection)
**目标**：当小红书出现“当前笔记暂时无法浏览 / 请打开小红书App扫码查看 / 验证码”时，立即识别并暂停/熔断，绝不再将其误判为正常笔记正文，且保护已采数据安全。

- **Files:**
  - Modify: `src/config/site-patterns.json`
  - Modify: `src/content/content-script.js`
  - Modify: `src/background/scraper.js`
  - Test: `tests/scraper.test.mjs`, `tests/site-patterns.test.js`

- [ ] **Step 1: 在 `site-patterns.json` 中配置 rateLimit 与 appRedirect 陷阱特征**
  配置检测文本特征：`"当前笔记暂时无法浏览"`, `"请打开小红书App扫码查看"`, `"滑动验证"`, `"安全验证"`。
- [ ] **Step 2: 在 `content-script.js` 中增加 `checkTrap` 逻辑**
  在 `handleGetNoteDetail` 中，优先检测是否存在风控拦截提示；若命中，返回 `{ ok: false, error: 'RATE_LIMITED', code: 300031 }`。
- [ ] **Step 3: 在 `scraper.js` 中捕获 `RATE_LIMITED` 并优雅熔断**
  定义 `RateLimitError`。当捕获到该错误时，更新 `task.status = 'failed'` 且 `error.code = 'RATE_LIMITED'`，同时设置友好提示：`"已触发小红书安全频控保护，已自动停止并保存当前数据，请稍作休息或在页面验证"`，安全退出循环。
- [ ] **Step 4: 编写并运行单元测试**
  在 `tests/scraper.test.mjs` 中添加命中“当前笔记暂时无法浏览”时的熔断测试用例，确保不把拦截页写入笔记列表，并正确退出。
- [ ] **Step 5: 提交代码**
  `git commit -m "feat(anti-crawl): add rate limit trap detection and graceful cooldown stop"`

---

### Task 2: 随时即时导出与“提前完成并保存”功能 (Live Export & Finish Early)
**目标**：采集 $\ge 1$ 篇时导出按钮即时点亮并带数量动态更新；增加【就采这些，提前完成】按钮，让用户随时优雅归档。

- **Files:**
  - Modify: `src/background/service-worker.js`
  - Modify: `src/background/scraper.js`
  - Modify: `src/popup/popup.js`
  - Modify: `src/popup/index.html`
  - Modify: `src/popup/popup.css`
  - Test: `tests/popup.test.js`, `tests/service-worker.test.mjs`

- [ ] **Step 1: 后台支持 `FINISH_EARLY_TASK` 指令**
  在 `service-worker.js` 与 `scraper.js` 中支持用户请求“就采这些”：将当前任务的 `notesLimit` 修正为当前已采集数量，并优雅将任务转移至 `completed` 终态，释放标签页并保留所有已有笔记。
- [ ] **Step 2: 随时导出激活逻辑**
  修改 `popup.js`：轮询时只要 `notesCount > 0`，立即将【导出 JSON】和【导出 CSV】设置为 `disabled = false`。
- [ ] **Step 3: 导出按钮动态数字反馈**
  按钮文字根据当前采集篇数动态更新：如 `导出 JSON (12篇)`、`导出 CSV (12篇)`。
- [ ] **Step 4: 界面增加【就采这些，结束采集】按钮**
  在“采集中”状态下显示该按钮；点击后向后台发送 `FINISH_EARLY_TASK`，界面立即转为已完成，不报错、不抛弃数据。
- [ ] **Step 5: 编写测试并验证**
  测试 `notesCount > 0` 时的导出状态与 `FINISH_EARLY_TASK` 处理逻辑。
- [ ] **Step 6: 提交代码**
  `git commit -m "feat(export): allow live incremental export and finish early graceful action"`

---

### Task 3: 导出格式升级（Excel BOM 乱码修复与双表导出）
**目标**：彻底解决 CSV 在 Windows Excel 双击乱码问题，并支持笔记主表 + 评论明细双表导出。

- **Files:**
  - Modify: `src/background/service-worker.js`
  - Modify: `src/popup/popup.js`
  - Modify: `src/popup/index.html`
  - Test: `tests/popup.test.js`, `tests/service-worker.test.mjs`

- [ ] **Step 1: CSV 文件前置 UTF-8 BOM (`\uFEFF`)**
  在 `toCsv` 与前端导出下载 Blob 时注入 `\uFEFF` 字节标记，确保 Windows Excel 双击直接正常显示中文，绝不乱码。
- [ ] **Step 2: 支持独立【导出评论明细 CSV】**
  增加按评论展平的明细表：列包括 `笔记ID, 笔记标题, 评论人, 评论内容, 点赞数, 发布时间`。
- [ ] **Step 3: 编写测试用例并验证 BOM 及双表生成逻辑**
- [ ] **Step 4: 提交代码**
  `git commit -m "fix(export): add UTF-8 BOM for Excel compatibility and support comment detail table"`

---

### Task 4: 评论采集挡位与深度控制 (Comment Depth Control)
**目标**：允许用户选择采集模式（0 条极速正文模式 / 20 条热评模式 / 50 条深度挖掘模式），让不同场景用户自主平衡速度与数据深度。

- **Files:**
  - Modify: `src/popup/index.html`
  - Modify: `src/popup/popup.js`
  - Modify: `src/content/content-script.js`
  - Modify: `src/background/scraper.js`
  - Test: `tests/popup.test.js`

- [ ] **Step 1: 在 Popup 核心区增加“评论采集深度”配置**
  提供清晰单选/下拉：
  - 🚀 仅采笔记正文（0 条评论，抓取速度提升 5 倍）
  - 🔥 热门精选（前 10~20 条评论）
  - 💬 深度挖掘（前 50 条评论，自动展开回复）
- [ ] **Step 2: 传递 `commentsPerNote` 配置并在 content-script 中生效**
  当为 0 时跳过评论 DOM 读取；当为 50 时滚动加载更多评论节点。
- [ ] **Step 3: 编写测试并验证**
- [ ] **Step 4: 提交代码**
  `git commit -m "feat(comments): add flexible comment depth options from fast-note to deep-comments"`

---

### Task 5: 界面形态优化与防失焦（独立页面 / 侧边栏模式）
**目标**：支持在独立标签页打开采集仪表盘，防止鼠标误点导致 Popup 关闭，彻底消除“失焦中断”焦虑。

- **Files:**
  - Modify: `src/popup/index.html`
  - Modify: `src/popup/popup.js`
  - Modify: `src/popup/popup.css`
  - Modify: `src/manifest.json`

- [ ] **Step 1: Popup 标题栏增加【在新窗口/标签页中打开】图标**
  点击调用 `chrome.tabs.create({ url: chrome.runtime.getURL('popup/index.html') })`。
- [ ] **Step 2: 响应式适配宽屏大页面**
  在独立窗口或侧边栏打开时，卡片宽度自适应扩展为优雅的左右两栏（左边控制面板，右边实时预览瀑布流）。
- [ ] **Step 3: 优化分段进度指示条**
  搜索阶段提供动态波浪/计数动画，详情阶段展示当前笔记卡片与实时进度。
- [ ] **Step 4: 提交代码**
  `git commit -m "feat(ui): support standalone tab mode and split-pane layout to prevent popup auto-close"`

---

### Task 6: 批量关键词队列采集 (Batch Keywords Queue)
**目标**：支持一行一个粘贴多个关键词，后台自动依次排队采集并支持合并导出。

- **Files:**
  - Modify: `src/popup/index.html`
  - Modify: `src/popup/popup.js`
  - Modify: `src/background/service-worker.js`
  - Test: `tests/popup.test.js`

- [ ] **Step 1: UI 支持“单词搜索”与“批量多词”切换**
  批量模式下为多行文本框，支持按行分割关键词。
- [ ] **Step 2: Popup / Service Worker 实现队列调度机**
  词 1 完成 ➔ 自动触发词 2 ➔ 全部完成汇总。
- [ ] **Step 3: 编写测试并验证批量队列解析**
- [ ] **Step 4: 提交代码**
  `git commit -m "feat(batch): implement multi-keyword batch collection queue"`

---

## 验证与验收标准

1. **限流熔断验证**：页面出现“当前笔记暂时无法浏览”或扫码弹窗时，扩展在 1 秒内暂停并提示，已有笔记安全保留并可即时导出。
2. **随时导出验证**：采集到第 5 篇时，点击【导出 CSV (已采 5 篇)】即可立即下载前 5 篇，且在 Windows Excel 中打开中文无乱码。
3. **提前完成验证**：采集中点击【就采这些，结束采集】，任务干净收尾，状态变为已完成。
4. **测试回归**：运行所有测试套件，用例数增至 140+ 且 100% 通过。
