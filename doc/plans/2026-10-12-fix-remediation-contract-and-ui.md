# 严格执行先学后采（禁止兜底采集）与自愈契约修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 贯彻用户的核心诉求「必须自学完成且目标达成才开始采集，坚决不走降级兜底采集」：打通 AI 自学习与研判动作的执行链路，确保学习阶段真正生效；若自学习多轮尝试后仍未达成目标契约，严禁擅自降级采集默认数据，而是明确报错终止任务。

**Architecture:** 
1. **严格契约阻断**：在 `scraper.js` 中，若用户指定了非默认排序或开启了 AI 自学习，将排序切换与规则自学作为强前置门禁。必须达成目标契约（`remediationResult.achieved === true`）才放行采集；若最终未达成，**禁止降级采集**，直接抛出 `GoalContractFailedError` 并终止任务，防止抓取错误数据。
2. **打通动作执行链路**：修复 `llm-client.js` 与 `scraper.js` 的接口契约不一致，使 LLM 研判产出的 `action`、`selector`、`diagnosis` 能够被真实派发执行与检验，真正达成页面切换与规则沉淀。
3. **前端状态与流水透明**：研判阶段进度明确展示「AI 规则自学习与状态对齐中」，自愈成功后提示「自学完成，开始采集」，失败则明确展示「自学未达成，已安全终止」，消除多任务与未完成误解。

**Tech Stack:** Chrome MV3, Vanilla JavaScript (ESM in background, Classic Script in popup/content), Node.js native test runner (`node --test`).

**Spec:** 用户明确指示：“我希望的是，要学习完才开始采集，而不是兜底策略”。

## Global Constraints

- **零静默降级**：当用户请求了特定排序或自学习目标时，目标未达成决不允许进入抓取循环。
- **MV3 规范**：无远程 eval，Service Worker 保活 25s 机制不受影响。
- **本地优先**：规则沉淀于 IndexedDB `config.dynamic_site_patterns`。
- **测试守卫**：全量 9 套件现有测试全部通过，新增测试覆盖契约拦截与阻断。

## Review Focus

1. **未达成契约时坚决阻断**：当 `_runGoalRemediationLoop` 返回 `achieved === false` 时，任务必须变为 `failed`，错误信息明确说明排序未达成，不得生成任何笔记数据。
2. **学习阶段动作真实执行**：大模型给出的 `CLICK`/`HOVER_CLICK` 动作能正确解析为 `nextAction`，真实派发给 content-script 执行并等待状态检验。
3. **证据 HTML 准确传递**：`scraper.js` 的 `regionHtml` 必须正确送达大模型清洗与分析，禁止传递空字符串。
4. **前端状态不残留假死**：自愈失败或终止时，流水卡片必须显示终态，禁止残留“待执行 / 现场研判中...”。
5. **任务管理一致性**：终止的任务进入终态 `failed`，清理后台标签页并通知 Popup。

---

### Task 1: 打通自愈研判动作执行链路，消除数据契约 Bug

**Files:**
- Modify: `src/background/llm-client.js:530-565`
- Modify: `src/background/scraper.js:358-525`
- Test: `tests/llm-client.test.mjs`
- Test: `tests/scraper.test.mjs`

**Interfaces:**
- `llmClient.planGoalRemediation(goal, evidence)`:
  - 读取: `evidence?.regionHtml || evidence?.htmlSnippet || ''`
  - 返回: `{ action, selector, reason, diagnosis, nextAction: { action, selector, duration }, raw }`
- `task.progress.remediationState`:
  - 属性: `{ history: Array<Item>, currentPlan, finished: boolean, achieved: boolean, summary: string }`

- [ ] **Step 1: 编写红灯测试**
在 `tests/llm-client.test.mjs` 和 `tests/scraper.test.mjs` 中增加测试用例：
1. 验证 `llmClient.planGoalRemediation` 接收 `evidence.regionHtml` 并产出完整的 `diagnosis` 与 `nextAction`；
2. 验证 `scraper._runGoalRemediationLoop` 能正确读取 `planResult` 并派发 `executeActionRecipe`。

- [ ] **Step 2: 运行测试验证红灯**
Run: `node --test tests/llm-client.test.mjs tests/scraper.test.mjs`
Expected: FAIL

- [ ] **Step 3: 修复 `llm-client.js` 与 `scraper.js` 契约**
1. 在 `llm-client.js` 中兼容入参 `evidence?.regionHtml || evidence?.htmlSnippet`；
2. 输出标准化的 `{ action, selector, reason, diagnosis: reason, nextAction: { action, selector } }`；
3. 在 `scraper.js` 中同时支持 `planResult.nextAction` 与扁平属性，在 `state.history` 中准确记录 `diagnosis`、`executed`、`error` 与 `achieved`。

- [ ] **Step 4: 运行测试验证绿灯**
Run: `node --test tests/llm-client.test.mjs tests/scraper.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/background/llm-client.js src/background/scraper.js tests/llm-client.test.mjs tests/scraper.test.mjs
git commit -m "fix(scraper): wire up remediation action execution and fix contract mismatch"
```

---

### Task 2: 严格前置门禁：自学完成才允许采集，禁止兜底降级

**Files:**
- Modify: `src/background/scraper.js:580-615`
- Test: `tests/scraper.test.mjs`

**Interfaces:**
- `GoalContractFailedError`: 导出自定义错误类或携带 `GOAL_CONTRACT_FAILED` 错误码。
- 当 `remediationResult.achieved === false` 时，抛出明确错误终止任务，不进入翻页与抓取。

- [ ] **Step 1: 编写禁止兜底降级的红灯测试**
在 `tests/scraper.test.mjs` 中添加测试：
当配置了非默认排序且自愈循环多轮尝试均未达成契约时，`scraper.run(task)` 应当抛出错误并终止，任务状态变为 `failed`，而不是降级并采集笔记。

- [ ] **Step 2: 运行测试验证红灯**
Run: `node --test tests/scraper.test.mjs`
Expected: FAIL（此前逻辑会 fallback 降级并继续采集笔记）

- [ ] **Step 3: 实现严格前置门禁逻辑**
在 `src/background/scraper.js` 中：
1. 移除 `remediationResult.achieved === false` 时的自动降级采集代码；
2. 若 `!remediationResult.achieved`，更新提示 `task.progress.stepMessage = 页面排序自学与对齐未达成，已安全终止采集以防数据错误`，并抛出 `new Error('页面排序规则自学未达成契约，已终止采集以防抓取错误数据')`；
3. 只有在 `remediationResult.achieved === true` 时，才打印 `已成功切换为“${sortLabel}”，开始采集数据...` 并放行进入后续抓取阶段。

- [ ] **Step 4: 运行测试验证绿灯**
Run: `node --test tests/scraper.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/background/scraper.js tests/scraper.test.mjs
git commit -m "feat(scraper): enforce strict goal contract before scraping, disallowing silent fallback"
```

---

### Task 3: 前端 UI 状态与流水优化，准确表达“学习中/已学完/未达成终止”

**Files:**
- Modify: `src/popup/popup.js:250-275,600-630`
- Modify: `src/popup/popup.css:780-860`
- Modify: `src/popup/index.html:78-85`
- Test: `tests/popup.test.js`

- [ ] **Step 1: 编写前端渲染测试**
在 `tests/popup.test.js` 中新增断言：
1. 准确展示失败轮次的原因为真实错误，不再显示“待执行”；
2. 达成轮次显示“已达成契约”，未生效显示“执行未生效”；
3. 卡片头部展示自愈阶段总体状态标签（自学中 / 自学成功 / 自学失败已终止）。

- [ ] **Step 2: 运行测试验证红灯**
Run: `node --test tests/popup.test.js`
Expected: FAIL

- [ ] **Step 3: 实现 Popup 渲染与状态提示优化**
1. 在 `popup.js` 中完善 `renderRemediationItem` 状态判断逻辑；
2. 卡片标题与头部清晰展示自愈阶段状态；
3. 学习进行中进度提示「🧠 AI 正在自学习页面规则与排序对齐...」，学习成功后再提示「✓ 自学习成功，正在抓取第 X 篇详情...」。

- [ ] **Step 4: 运行测试验证绿灯**
Run: `node --test tests/popup.test.js`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/popup/index.html src/popup/popup.css src/popup/popup.js tests/popup.test.js
git commit -m "fix(popup): display accurate remediation lifecycle and terminal states"
```

---

### Task 4: 9 套件全量回归验证

**Files:**
- All tests

- [ ] **Step 1: 运行全量测试**
```bash
node --test tests/site-patterns.test.js tests/storage.test.mjs tests/llm-client.test.mjs tests/content-script.test.mjs tests/task-manager.test.mjs tests/scraper.test.mjs tests/service-worker.test.mjs tests/popup.test.js tests/integration.test.mjs
```
Expected: 9 套件全部通过，0 失败。
