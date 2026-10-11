# 交互体验与界面体验优化方案 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全面提升 XHS Agent 的用户交互体验，包括：LLM 配置即时测试与连接诊断、采集过程细粒度状态与当前笔记反馈、Popup 重新打开时任务状态恢复与笔记列表预览、一键清空/重新开始重置、以及更精致清晰的视觉分栏。

**Architecture:** 
- 后端新增 `TEST_LLM_CONFIG` 与 `GET_LATEST_NOTES` 消息处理；在 `StorageManager` 中补充最近任务查询和笔记获取能力。
- 在 `Scraper` 的采集流中增加 `currentNoteTitle` 等微步状态反馈，使 `task.progress` 不仅能报百分比，还能让用户看到正在采集哪篇。
- 前端 `popup` 采用双 Tab/折叠设计（采集控制 + 数据预览），支持页面打开时自动恢复当前或最近一次任务状态，配置区提供“测试连接”状态指示与即时保存提示，采集控制区增加“重置/新采集”按钮。

**Tech Stack:** Chrome Extension MV3, 原生 JavaScript (Classic Script in Popup, ESM in Background), 原生 CSS3, IndexedDB, Node.js 原生测试套件 (`node --test`).

**Spec:** [doc/spec.md](file:///d:/code/myself/xhs/doc/spec.md) 及用户交互优化决策需求。

## Global Constraints

- **MV3 规范**：背景使用 ESM，保持 25s 闹钟保活；禁止 `eval`。
- **纯原生前端**：Popup 仅用原生 HTML/CSS/JS，不引入 Vue/React 等第三方 UI 库。
- **双模块契约**：`popup/` 与 `content/` 保持 classic script，不写顶层 import/export，导出纯函数供 Node 测试；`background/` 保持 ESM。
- **严格通信规范**：`service-worker.js` 中的消息监听器保持同步返回字面量 `true`。
- **本地优先**：数据只落 IndexedDB 与 chrome.storage.local，无外部服务器中转。

## Review Focus

1. **LLM 测试连接失败处理**：当 API Key 无效、网络超时或 Base URL 格式错误时，应有清晰具体的错误提示，而不是无响应或崩溃。
2. **Popup 重新打开状态恢复**：用户关闭并重新打开 Popup 弹窗时，如果后台任务正在运行，能够无缝继续轮询；如果任务已完成，能够恢复显示采集结果与导出按钮。
3. **并发任务与重置状态同步**：用户点击“清空/新任务”时，如果当前有任务正在运行，应提示先取消或自动触发取消，避免状态冲突。
4. **数据预览性能与截断**：采集 50~100 篇笔记时，本地预览列表应限制最大渲染行数（如只显示最近 5~10 篇），避免在小弹窗中卡顿。
5. **回归测试完整性**：所有新增纯函数必须有对应的单元测试覆盖，现有 118 个测试必须全部保持通过。

---

### Task 1: 存储层与模型层扩展 (StorageManager & LLMClient)

**Files:**
- Modify: `src/background/storage.js`
- Modify: `src/background/llm-client.js`
- Test: `tests/storage.test.mjs`
- Test: `tests/llm-client.test.mjs`

**Interfaces:**
- `StorageManager.prototype.getLatestTask(): Promise<Task|null>`
- `StorageManager.prototype.getRecentNotes(limit = 10): Promise<Array<Note>>`
- `LLMClient.prototype.testConnection(): Promise<{ ok: boolean, error?: string }>`

- [ ] **Step 1: Write failing test for `getLatestTask` and `getRecentNotes` in `tests/storage.test.mjs`**

```javascript
test('getLatestTask 返回最新创建的任务，若无任务返回 null', async () => {
  const storage = makeStorage();
  assert.equal(await storage.getLatestTask(), null);
  await storage.saveTask({ id: 't1', createdAt: 100, status: 'completed' });
  await storage.saveTask({ id: 't2', createdAt: 200, status: 'completed' });
  const latest = await storage.getLatestTask();
  assert.equal(latest.id, 't2');
});

test('getRecentNotes 按 collectedAt 倒序返回指定条数笔记', async () => {
  const storage = makeStorage();
  await storage.saveNote({ id: 'n1', taskId: 't1', collectedAt: 10, title: 'Note 1' });
  await storage.saveNote({ id: 'n2', taskId: 't1', collectedAt: 20, title: 'Note 2' });
  await storage.saveNote({ id: 'n3', taskId: 't1', collectedAt: 30, title: 'Note 3' });
  const notes = await storage.getRecentNotes(2);
  assert.equal(notes.length, 2);
  assert.equal(notes[0].id, 'n3');
  assert.equal(notes[1].id, 'n2');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/storage.test.mjs`
Expected: FAIL (methods not defined).

- [ ] **Step 3: Implement `getLatestTask` and `getRecentNotes` in `src/background/storage.js`**

在 `StorageManager` 中实现：
- `getLatestTask`: 读取 `STORE_TASKS` 的 `createdAt` 索引或全部任务，按 `createdAt` 倒序取第一条。
- `getRecentNotes(limit = 10)`: 读取 `STORE_NOTES` 的 `collectedAt` 索引，倒序取出最新的 `limit` 条。

- [ ] **Step 4: Implement `testConnection` in `src/background/llm-client.js` and add unit test**

在 `LLMClient` 中增加：
```javascript
async testConnection() {
  try {
    const text = await this._callApi('You are a ping tester.', 'Hello, reply with "OK".');
    return { ok: Boolean(text && text.length > 0) };
  } catch (err) {
    return { ok: false, error: err?.message || '连接失败' };
  }
}
```
并在 `tests/llm-client.test.mjs` 中添加相应测试。

- [ ] **Step 5: Run tests and verify they pass**

Run: `node --test tests/storage.test.mjs tests/llm-client.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/background/storage.js src/background/llm-client.js tests/storage.test.mjs tests/llm-client.test.mjs
git commit -m "feat(storage,llm): add getLatestTask, getRecentNotes and testConnection"
```

---

### Task 2: Scraper 采集细粒度状态反馈 (Scraper Progress Enhancement)

**Files:**
- Modify: `src/background/scraper.js`
- Test: `tests/scraper.test.mjs`

**Interfaces:**
- `task.progress.currentTitle`: 正在抓取的笔记标题（若已解析到）
- `task.progress.stepMessage`: 描述当前具体动作（如：`正在搜索关键词...`、`正在采集第 3/10 篇：<标题>`）

- [ ] **Step 1: Write test for detailed progress message in `tests/scraper.test.mjs`**

验证在进入搜索阶段与详情阶段时，`task.progress.stepMessage` 与 `task.progress.phase` 会记录具体执行细节。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/scraper.test.mjs`

- [ ] **Step 3: Implement step updates in `src/background/scraper.js`**

在 `_searchPhase` 与 `_detailPhase` 中：
- 搜索阶段保存进度时注入：`stepMessage: '正在搜索小红书笔记...'`
- 抓取单篇详情时保存：`stepMessage: '正在抓取第 ' + (i + 1) + '/' + task.progress.noteUrls.length + ' 篇笔记...', currentTitle: detail.title || ''`

- [ ] **Step 4: Run scraper tests and verify they pass**

Run: `node --test tests/scraper.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/background/scraper.js tests/scraper.test.mjs
git commit -m "feat(scraper): record detailed step messages in task progress"
```

---

### Task 3: 后端消息分发扩展 (Service Worker Message Dispatch)

**Files:**
- Modify: `src/background/service-worker.js`
- Test: `tests/service-worker.test.mjs`

**Interfaces:**
- 消息 `TEST_LLM_CONFIG`: 入参 `{ type: 'TEST_LLM_CONFIG', apiKey?, apiBase?, model? }`，返回 `{ ok: boolean, error?: string }`
- 消息 `GET_LATEST_TASK`: 入参 `{ type: 'GET_LATEST_TASK' }`，返回 `{ ok: boolean, task: Task|null, notes: Array }`
- 消息 `RESET_TASK`: 入参 `{ type: 'RESET_TASK' }`，返回 `{ ok: boolean }`

- [ ] **Step 1: Write failing tests for new messages in `tests/service-worker.test.mjs`**

```javascript
test('TEST_LLM_CONFIG 调用 llm.testConnection 并回复结果', async () => { ... });
test('GET_LATEST_TASK 返回最近任务与前 5 条笔记', async () => { ... });
test('RESET_TASK 清除当前活动运行状态', async () => { ... });
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test tests/service-worker.test.mjs`

- [ ] **Step 3: Implement new message handlers in `src/background/service-worker.js`**

在 `handleMessage` 的 switch 分支中增加：
- `TEST_LLM_CONFIG`: 初始化临时 LLMClient 测试连接，返回测试结果。
- `GET_LATEST_TASK`: 读取 `storage.getRunningTask()`，若无则读取 `storage.getLatestTask()`，同时查出关联的笔记列表。
- `RESET_TASK`: 若有正在运行的任务则尝试取消，复位 `activeRun = null`。

- [ ] **Step 4: Run service-worker tests to verify pass**

Run: `node --test tests/service-worker.test.mjs`
Expected: 18/18 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/background/service-worker.js tests/service-worker.test.mjs
git commit -m "feat(sw): add TEST_LLM_CONFIG, GET_LATEST_TASK and RESET_TASK handlers"
```

---

### Task 4: 前端纯函数逻辑扩展与测试 (Popup Pure Functions)

**Files:**
- Modify: `src/popup/popup.js`
- Modify: `tests/popup.test.js`

**Interfaces:**
- `formatDetailStatus(resp)`: 格式化详细执行信息（将 status, progress.stepMessage, currentTitle 等组合成易读中文）。
- `renderNotePreviewRow(note)`: 纯函数，生成单条笔记预览条目的 HTML 结构字符串。

- [ ] **Step 1: Write tests for formatDetailStatus and renderNotePreviewRow in `tests/popup.test.js`**

```javascript
test('formatDetailStatus 优先展示具体步骤描述 stepMessage', () => { ... });
test('renderNotePreviewRow 正确转义标题与作者并生成标签 HTML', () => { ... });
```

- [ ] **Step 2: Run test to verify failure**

Run: `node --test tests/popup.test.js`

- [ ] **Step 3: Implement helper pure functions in `src/popup/popup.js`**

导出并实现状态组合器与单行渲染模板工具。

- [ ] **Step 4: Run tests and verify pass**

Run: `node --test tests/popup.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/popup/popup.js tests/popup.test.js
git commit -m "feat(popup): add formatDetailStatus and note preview formatting"
```

---

### Task 5: 界面重构与交互闭环 (Popup UI & Interactive Wiring)

**Files:**
- Modify: `src/popup/index.html`
- Modify: `src/popup/popup.css`
- Modify: `src/popup/popup.js`

**Interfaces:**
- 高级设置面板增加：【测试连接】按钮 + 状态反馈标签；输入框变动自动显示“已自动保存”指示。
- 核心操作区增加：【重新开始 / 新建采集】按钮（复位当前任务状态）。
- 进度区增强：显示当前小红书采集动作（如正在搜索 / 正在抓取第 X 篇《标题》）。
- 数据区增强：增加可折叠【已采集数据预览（最近 5 篇）】卡片，展示抓取到的标题、作者、获赞与链接快捷跳转。
- 生命周期钩子：Popup 打开时自动向后台请求 `GET_LATEST_TASK`，自动恢复上次进度或恢复采集中状态。

- [ ] **Step 1: Update `src/popup/index.html`**

- 引入“测试连接”按钮与测试结果反馈节点。
- 引入“新建采集/复位”辅助按钮。
- 增加数据预览卡片容器 `<section id="previewCard" class="preview-card">`。
- 调整各区块视觉层级与微标签。

- [ ] **Step 2: Update `src/popup/popup.css`**

- 优化整体视觉间距、卡片边框阴影与圆角。
- 增加标签状态高亮样式（如“采集中”呼吸闪烁、“测试成功”绿色提示、“测试失败”警示）。
- 增加笔记预览卡片的轻量滚动列表样式（限制高度，保证 320~360px 宽度内精致展现）。

- [ ] **Step 3: Wire interactive events in `src/popup/popup.js`**

- 接入打开时 `GET_LATEST_TASK` 初始化逻辑。
- 接入“测试连接”按钮逻辑，显示 Testing... 与结果。
- 接入配置更改时自动保存微提示（“设置已保存”）。
- 接入“新建采集”按钮逻辑，重置输入框与任务 ID。
- 接入数据预览区动态渲染。

- [ ] **Step 4: Run all 9 test suites to verify no regression**

Run: `node --test tests/site-patterns.test.js tests/storage.test.mjs tests/llm-client.test.mjs tests/content-script.test.mjs tests/task-manager.test.mjs tests/scraper.test.mjs tests/service-worker.test.mjs tests/popup.test.js tests/integration.test.mjs`
Expected: 100% PASS.

- [ ] **Step 5: Commit**

```bash
git add src/popup/index.html src/popup/popup.css src/popup/popup.js
git commit -m "feat(popup): complete UI overhaul with live preview, connection test, and auto-resume"
```

---

### Task 6: 最终集成验证 (End-to-End Verification)

**Files:**
- Test: `tests/integration.test.mjs`
- Modify: `doc/optimization-plan.md`

- [ ] **Step 1: Run full test suite and verify clean execution**

确保全部单元测试和集成测试顺利通过。

- [ ] **Step 2: Manual checklist guide for user**

提供明确的浏览器重新加载和手动操作校验指引。

- [ ] **Step 3: Commit**

```bash
git commit -am "docs: update optimization plan with UX overhaul completion"
```
