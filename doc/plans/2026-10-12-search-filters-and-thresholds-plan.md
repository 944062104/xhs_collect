# 多维搜索筛选与数据质量门槛过滤 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为小红书采集助手实现多维搜索筛选（排序扩充、笔记类型、发布时间）及采集数据质量阈值过滤（点赞数、收藏数、评论数、发布日期门槛），确保采集数据高精准度。

**Architecture:** 
1. 页面交互层：`content-script.js` 提供通用的多维筛选交互处理器 `applySearchFilters`，按小标题锚定胶囊按钮并触发拟人点击与状态校验，配合 `site-patterns.json` 静态基线；
2. 调度与过滤层：`scraper.js` 在搜索阶段下发多维筛选指令，并在笔记详情解析后通过独立纯函数模块 `filters.js` 进行阈值判定，未达门槛自动跳过并不占用有效配额；
3. UI 与配置层：Popup 新增结构化多维筛选控件与数据质量阈值配置抽屉，并持久化到 IndexedDB。

**Tech Stack:** Chrome MV3 Extensions (ESM Background + Classic Content/Popup), Vanilla JS, Node.js Test Runner (`node --test`).

**Spec:** `doc/plans/2026-10-12-search-filters-and-thresholds-plan.md`

## Global Constraints

- 保持 MV3 纯原生原则，不引入外部第三方运行依赖。
- 本地优先，所有配置与过滤数据仅存储于 IndexedDB。
- 拟人化交互，筛选操作间保持 200~400ms 随机微停顿，杜绝暴力触发。
- 测试覆盖率 100%，所有新增逻辑均需配对测试用例。

## Review Focus

1. 相对日期格式解析（如“昨天 14:00”、“3天前”、“03-12”、“2023-11-20”）可能格式各异，需确保时间戳转换稳健。
2. 小红书筛选面板部分版本在小屏幕下需要先点击“筛选”展开，设置完后点击“收起”关闭，需避免遮挡笔记卡片。
3. 纯数字/字符串转换安全：点赞数可能为“1.2万”或“0”，阈值判断前需统一规范为纯数值。
4. 阈值跳过计数与进度计算：跳过的笔记不应计入 `notesCollected`，但应计入 `skippedCount`，并向用户透明展示。
5. 配置向后兼容：历史任务或未配置阈值的任务应默认放行全部笔记，行为保持 100% 兼容。

---

### Task 1: 阈值过滤核心判定模块 (`src/background/filters.js`)

**Files:**
- Create: `src/background/filters.js`
- Test: `tests/filters.test.mjs`

**Interfaces:**
- Produces:
  - `parsePublishedDate(dateStr: string, referenceTime?: number): number | null`
  - `isNoteMatchingThresholds(note: object, thresholds?: object): { pass: boolean, reason?: string }`

- [ ] **Step 1: Write the failing test**
  编写 `tests/filters.test.mjs`，覆盖相对日期解析（"刚刚"、"10分钟前"、"昨天"、"3天前"、"03-12"、"2023-11-20"）以及点赞/收藏/评论数/日期阈值判定。

- [ ] **Step 2: Run test to verify it fails**
  运行：`node --test tests/filters.test.mjs`
  预期：FAIL，提示 `filters.js` 不存在。

- [ ] **Step 3: Implement `filters.js`**
  在 `src/background/filters.js` 中实现 `parsePublishedDate` 与 `isNoteMatchingThresholds`，安全解析 "1.5万"、"200" 与多样日期格式。

- [ ] **Step 4: Run test to verify it passes**
  运行：`node --test tests/filters.test.mjs`
  预期：PASS。

- [ ] **Step 5: Commit**
  ```bash
  git add src/background/filters.js tests/filters.test.mjs
  git commit -m "feat(filters): add date parsing and note threshold matching module"
  ```

---

### Task 2: 扩展 `site-patterns.json` 与 `content-script.js` 多维筛选胶囊交互

**Files:**
- Modify: `src/config/site-patterns.json:60-85`
- Modify: `src/content/content-script.js:1050-1150`
- Test: `tests/content-script.test.mjs`

**Interfaces:**
- Consumes: `msg.filters` (`{ sortType, noteType, publishTime }`)
- Produces: `handleApplySearchFilters(msg, sendResponse)` 动作消息响应 `{ ok: true, applied: {...} }`

- [ ] **Step 1: Write the failing test**
  在 `tests/content-script.test.mjs` 中添加针对 `applySearchFilters` 消息处理的测试用例（包括依次点击“最多评论”、“图文”、“一周内”并校验激活态）。

- [ ] **Step 2: Run test to verify it fails**
  运行：`node --test tests/content-script.test.mjs`
  预期：FAIL，找不到 `applySearchFilters` 动作。

- [ ] **Step 3: Implement multi-dimensional filter interaction in `content-script.js`**
  1. 更新 `site-patterns.json` 补充 `comments_descending`、`collects_descending` 以及笔记类型与发布时间选择器。
  2. 在 `content-script.js` 中实现 `handleApplySearchFilters`，按区域（排序依据、笔记类型、发布时间）定位胶囊并点击，最后收起浮层。

- [ ] **Step 4: Run test to verify it passes**
  运行：`node --test tests/content-script.test.mjs`
  预期：PASS。

- [ ] **Step 5: Commit**
  ```bash
  git add src/config/site-patterns.json src/content/content-script.js tests/content-script.test.mjs
  git commit -m "feat(content): implement applySearchFilters for multi-dimensional capsule clicking"
  ```

---

### Task 3: `scraper.js` 集成多维搜索筛选与详情阈值门禁

**Files:**
- Modify: `src/background/scraper.js:580-640` (搜索阶段)
- Modify: `src/background/scraper.js:830-870` (详情阶段)
- Test: `tests/scraper.test.mjs`

**Interfaces:**
- Consumes: `src/background/filters.js:isNoteMatchingThresholds`
- Produces: 
  - `task.progress.skippedThresholdCount`
  - 过滤后的笔记入库与进度推进

- [ ] **Step 1: Write the failing test**
  在 `tests/scraper.test.mjs` 中增加测试用例：
  1. 验证 `_searchPhase` 派发 `applySearchFilters` 并携带 `noteType` / `publishTime`；
  2. 验证详情阶段若笔记点赞数未达 `minLikes`，不保存到 storage 且 `notesCollected` 不增加，`skippedThresholdCount` 递增。

- [ ] **Step 2: Run test to verify it fails**
  运行：`node --test tests/scraper.test.mjs`
  预期：FAIL。

- [ ] **Step 3: Integrate filters into `scraper.js`**
  1. 引入 `isNoteMatchingThresholds`；
  2. 在 `_searchPhase` 构造筛选消息并发送到标签页；
  3. 在详情采集完成获得 `detail` 后，执行门禁校验；若未达门槛，记录跳过日志，不执行 `saveNote`，继续下一篇。

- [ ] **Step 4: Run test to verify it passes**
  运行：`node --test tests/scraper.test.mjs`
  预期：PASS。

- [ ] **Step 5: Commit**
  ```bash
  git add src/background/scraper.js tests/scraper.test.mjs
  git commit -m "feat(scraper): integrate multi-dimensional search filtering and note threshold gate"
  ```

---

### Task 4: Popup 界面与配置升级（多维筛选与数据门槛抽屉）

**Files:**
- Modify: `src/popup/index.html:30-60, 140-180`
- Modify: `src/popup/popup.js:20-60, 460-520`
- Modify: `src/popup/popup.css`
- Test: `tests/popup.test.js`

**Interfaces:**
- Produces:
  - `buildStartMessage` 携带 `sortType`, `noteType`, `publishTime`, `thresholds: { minLikes, minCollects, minComments, minDate }`
  - 进度区显示跳过统计（`已过滤跳过 N 篇`）

- [ ] **Step 1: Write the failing test**
  在 `tests/popup.test.js` 中增加测试用例：验证 `buildStartMessage` 正确打包 `noteType`、`publishTime` 与 `thresholds` 对象，并测试进度格式化函数展示跳过计数。

- [ ] **Step 2: Run test to verify it fails**
  运行：`node --test tests/popup.test.js`
  预期：FAIL。

- [ ] **Step 3: Update Popup HTML, CSS and JS**
  1. 排序下拉框扩充：增加“最多评论”、“最多收藏”；
  2. 搜索区新增“笔记类型”（不限/视频/图文）与“发布时间”（不限/一天内/一周内/半年内）；
  3. 高级抽屉新增“数据质量阈值”表单卡片（点赞、收藏、评论、最早发布时间）；
  4. 更新 `buildStartMessage` 与 `loadConfig` / `saveConfig`。

- [ ] **Step 4: Run test to verify it passes**
  运行：`node --test tests/popup.test.js`
  预期：PASS。

- [ ] **Step 5: Commit**
  ```bash
  git add src/popup/index.html src/popup/popup.js src/popup/popup.css tests/popup.test.js
  git commit -m "feat(popup): add multi-filter controls and threshold settings UI"
  ```

---

### Task 5: 10 套件全量回归验证与打包

**Files:**
- Test: 全部测试套件（`tests/*.test.*`）

- [ ] **Step 1: Run all test suites**
  ```powershell
  $files = @("tests/site-patterns.test.js", "tests/storage.test.mjs", "tests/llm-client.test.mjs", "tests/content-script.test.mjs", "tests/task-manager.test.mjs", "tests/scraper.test.mjs", "tests/service-worker.test.mjs", "tests/popup.test.js", "tests/integration.test.mjs", "tests/filters.test.mjs"); foreach ($f in $files) { node --test $f }
  ```

- [ ] **Step 2: Verify 100% pass without regressions**
  确保所有测试套件全部通过。

- [ ] **Step 3: Final commit & documentation sync**
  ```bash
  git add doc/
  git commit -m "docs: document multi-filter and data threshold implementation"
  ```
