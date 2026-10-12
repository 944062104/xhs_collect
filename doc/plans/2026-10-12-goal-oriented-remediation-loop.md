# 目标契约驱动的自愈与自适应任务循环 (Goal-Oriented Remediation Loop) 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 借鉴 `web-access` 的浏览哲学与任务就绪契约，将当前机械死板的 2 轮 LLM 重试升级为「先定义目标契约、基于实时现场证据持续观测与纠偏、直到目标完成为止」的 Agent 闭环自愈系统。

**Architecture:** 
- 定义通用的 `GoalContract`（如排序目标契约 `search_sort`，包含成功判定标准 `isAchieved`）。
- Content Script 提供统一的现场状态探测（`checkGoalContract`）与动作执行器（`executeActionRecipe`）。
- LLMClient 升级为调度大脑（`planGoalRemediation`），根据当前目标、现场 DOM 证据和历史失败反馈，规划下一步最优动作（点击、悬停、改传 URL 参数、等待异步渲染）。
- Scraper 运行自适应循环（`_runGoalRemediationLoop`），持续推进直到契约满足或确认不可逆受阻，成功后自动将有效策略持久化至 `dynamic_site_patterns` 经验库。

**Tech Stack:** 原生 JavaScript (Chrome MV3 ESM + Classic Content Script), Node.js 原生测试套件 (`node --test`), IndexedDB。

**Spec:** `doc/spec.md`, `references/web-access` 规范。

## Global Constraints
- MV3 规范：无远程 eval，Service Worker 保活 25s 机制不受影响。
- 本地优先：动态经验存储于 IndexedDB `config.dynamic_site_patterns`，不依赖外部后端。
- 测试覆盖：所有新增逻辑遵循 TDD，现有 191 项测试 100% 保持通过，新增独立测试覆盖自愈循环。

## Review Focus
1. 循环终止保护：若 LLM 连续返回相同动作或 DOM 毫无变化，必须检测并防止死循环。
2. 异步状态竞态：动作执行后给 React DOM 充分的 Diff 观察窗口，避免因过早判定导致无效重试。
3. 不可逆阻碍（登录墙/滑块）快速识别：一旦检测到硬拦截，立即中断循环并标记状态，杜绝无效消耗 token。
4. 动态规则持久化：只有真正达成目标契约的动作才沉淀到经验库，防止污染静态模式。
5. 优雅降级：在彻底耗尽策略预算仍未达成时，明确记录告警并安全降级采集，不崩溃整个任务。

---

### Task 1: LLMClient 增加目标导向决策规划接口 (`planGoalRemediation`)

**Files:**
- Modify: `src/background/llm-client.js:155-200, 420-470`
- Test: `tests/llm-client.test.mjs`

**Interfaces:**
- Produces: `llmClient.planGoalRemediation(goal, evidence)`
  - `goal: { type: string, targetValue: string, targetLabel: string }`
  - `evidence: { htmlSnippet: string, lastAction?: object, lastError?: string, history: Array<object> }`
  - 返回: `{ action: 'CLICK' | 'HOVER_CLICK' | 'URL_PARAM' | 'WAIT', selector?: string[], param?: string, reason: string }`

- [ ] **Step 1: 编写失败测试**
  在 `tests/llm-client.test.mjs` 中添加针对 `planGoalRemediation` 的测试用例：
  - 测试根据 HTML 骨架和失败反馈输出规范的 `action` 建议；
  - 测试当 LLM 返回非标准格式时能自动清洗与兜底结构。
- [ ] **Step 2: 运行测试验证失败**
  `node --test tests/llm-client.test.mjs`
- [ ] **Step 3: 实现 `planGoalRemediation`**
  在 `src/background/llm-client.js` 中新增系统提示词 `SYSTEM_GOAL_PLANNER` 和方法 `planGoalRemediation`，支持解析与清洗动作建议。
- [ ] **Step 4: 运行测试验证通过**
  `node --test tests/llm-client.test.mjs`
- [ ] **Step 5: 提交代码**
  `git commit -m "feat(llm): implement planGoalRemediation for adaptive task planning"`

---

### Task 2: Content Script 增加契约检查与动作执行器 (`checkGoalContract` & `executeActionRecipe`)

**Files:**
- Modify: `src/content/content-script.js:1000-1100, 1240-1300`
- Test: `tests/content-script.test.mjs`

**Interfaces:**
- Consumes: Action 对象 `{ action: 'CLICK' | 'HOVER_CLICK' | 'URL_PARAM', selector: string[] }`
- Produces:
  - 消息响应 `checkGoalContract`: `{ ok: true, achieved: boolean, currentActive: string }`
  - 消息响应 `executeActionRecipe`: `{ ok: true, executed: boolean, error?: string }`

- [ ] **Step 1: 编写失败测试**
  在 `tests/content-script.test.mjs` 中添加测试：
  - 测试 `checkGoalContract` 能准确返回当前目标（如最新排序）是否已激活；
  - 测试 `executeActionRecipe` 能接收 LLM 给出的任意候选选择器并执行全套拟人交互。
- [ ] **Step 2: 运行测试验证失败**
  `node --test tests/content-script.test.mjs`
- [ ] **Step 3: 实现消息处理器**
  在 `src/content/content-script.js` 中接入 `handleCheckGoalContract` 和 `handleExecuteActionRecipe`。
- [ ] **Step 4: 运行测试验证通过**
  `node --test tests/content-script.test.mjs`
- [x] **Step 5: 提交代码**
  `git commit -m "feat(content): add checkGoalContract and executeActionRecipe message handlers"`

---

### Task 3: Scraper 重构为目标驱动的任务自愈循环 (`_runGoalRemediationLoop`)

**Files:**
- Modify: `src/background/scraper.js:380-450`
- Test: `tests/scraper.test.mjs`

**Interfaces:**
- Consumes: `llmClient.planGoalRemediation`, `tabs.sendMessage(checkGoalContract / executeActionRecipe)`
- Produces: `scraper._runGoalRemediationLoop(task, tabId, goal)`
  - 返回: `{ success: boolean, rounds: number, learnedPatterns?: object }`

- [x] **Step 1: 编写失败测试**
  在 `tests/scraper.test.mjs` 中添加集成测试：
  - 模拟初次点击未激活，进入自愈循环后经由 LLM 规划的第二/第三步成功达成契约；
  - 验证成功后自动调用 `storage.saveConfig('dynamic_site_patterns', ...)` 保存有效规则；
  - 验证当遇到不可逆错误或策略重复无进展时，安全降级不卡死。
- [x] **Step 2: 运行测试验证失败**
  `node --test tests/scraper.test.mjs`
- [x] **Step 3: 实现 `_runGoalRemediationLoop` 并集成到 `_searchPhase`**
  替换此前死板的 `while (round < 2)`，引入证据驱动的自适应任务循环。
- [x] **Step 4: 运行测试验证通过**
  `node --test tests/scraper.test.mjs`
- [x] **Step 5: 提交代码**
  `git commit -m "feat(scraper): implement goal-oriented remediation loop inspired by web-access"`

---

### Task 4: 端到端全量验证与经验热重载回归

**Files:**
- Verify: 全部 9 套测试用例

- [x] **Step 1: 运行全量测试**
  ```bash
  node --test tests/site-patterns.test.js tests/storage.test.mjs tests/llm-client.test.mjs tests/content-script.test.mjs tests/task-manager.test.mjs tests/scraper.test.mjs tests/service-worker.test.mjs tests/popup.test.js tests/integration.test.mjs
  ```
- [x] **Step 2: 确认所有 191+ 测试用例全部通过（实测 197/197 100% 全绿）**
- [x] **Step 3: 整体整理提交**
  `git commit -m "chore: complete goal-oriented adaptive task remediation loop"`
