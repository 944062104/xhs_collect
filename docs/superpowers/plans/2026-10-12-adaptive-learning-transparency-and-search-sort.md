# AI 自适应学习去黑盒化与搜索排序精准化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 彻底根治小红书搜索排序误触分类栏与排序失效问题，并为 AI 自适应学习构建“生成-沙箱回测-可视化审计”的完整闭环，消除黑盒感。

**Architecture:** 
1. 在 `content-script.js` 中重构 `setSearchSort`，严格排除分类 Tab，强制“展开浮层 -> 锁定「排序依据」子容器 -> 精准命中排序胶囊”；
2. 在 `content-script.js` 中新增 `verifySelectors` 探针，执行真实 DOM `querySelectorAll` 并提取命中数与样本；
3. 在 `service-worker.js` 中让 `handleLearnSitePatterns` 串联“LLM 提炼 -> 沙箱回测 -> 过滤入库”闭环，并支持 `VERIFY_DYNAMIC_PATTERNS` 主动体检；
4. 在 `popup` 中增加极简勘测报告面板，展示规则命中率、样本及一键体检/清空操作。

**Tech Stack:** Chrome MV3 (原生 ES Modules + Classic Scripts), IndexedDB, Node.js Test Runner (`node --test`)。

**Spec:** [`docs/superpowers/specs/2026-10-12-adaptive-learning-transparency-and-search-sort-design.md`](file:///d:/code/myself/xhs/docs/superpowers/specs/2026-10-12-adaptive-learning-transparency-and-search-sort-design.md)

## Global Constraints

- **MV3 规范**：无持久后台，不注入 `eval`。
- **零外部 UI 框架**：Popup 使用原生 HTML/CSS/JS。
- **双模块系统**：`background/**` 用 ESM；`content/**` 与 `popup/**` 用 classic script。
- **依赖注入**：函数与类保持良好可测性。
- **测试通过率**：现有 9 套测试用例保持 100% 通过（当前 174/174），并新增覆盖。

## Review Focus

1. **分类栏反误触**：页面存在【全部/图文/视频】分类 Tab 时，点击“最新”绝不可触发分类切换。
2. **浮层未开保护**：页面无可见排序浮层时，绝不因页面存在包含“最新”的正文或卡片而提前返回成功。
3. **沙箱过滤有效性**：LLM 给出错误选择器时，`verifySelectors` 检测出 0 命中并剔除，不写入经验库。
4. **Popup 报告容错**：无动态规则或初次加载时，Popup 优雅展示“未配置动态经验”，不抛任何 JS 异常。
5. **状态机不阻断**：若真实页面极端改版导致排序切换彻底超时，返回清晰错误，不卡死采集主循环。

---

### Task 1: 搜索排序精准化重构（排除分类栏与两阶段浮层锚定）

**Files:**
- Modify: `src/content/content-script.js:620-790`
- Test: `tests/content-script.test.mjs`

**Interfaces:**
- Consumes: `msg.sortType` ('time_descending', 'popularity_descending', 'comments_descending', 'general')
- Produces: `{ ok: boolean, switched: boolean, error?: string }`

- [ ] **Step 1: Write the failing tests in `tests/content-script.test.mjs`**
  - 测试用例 1：`onMessage setSearchSort：存在左侧分类栏时必须排除分类栏并准确点击右侧筛选按钮`
  - 测试用例 2：`onMessage setSearchSort：在浮层未展开时绝不误判全局文本为排序项`

- [ ] **Step 2: Run test to verify it fails**
  Run: `node --test tests/content-script.test.mjs`
  Expected: FAIL

- [ ] **Step 3: Implement refined sorting in `src/content/content-script.js`**
  - `findFilterToggleBtn` 增加分类 Tab 排除条件（排除包含 `tab`/`channel` 且文本为“全部/图文/视频/用户”的元素，优先匹配右上角包含“筛选”文本且带有图标或独立区域的按钮）。
  - 移除 `tryClickTarget` 阶段的全局模糊匹配，强制在 `findSortPopup()` 获取到的子容器（以“排序依据”为锚点）中定位胶囊按钮。
  - 增加对“综合 / 最新 / 最多点赞”的显式支持。

- [ ] **Step 4: Run test to verify it passes**
  Run: `node --test tests/content-script.test.mjs`
  Expected: PASS

- [ ] **Step 5: Commit**
  Run: `git add src/content/content-script.js tests/content-script.test.mjs; git commit -m "fix(content): enhance search sort targeting and prevent clicking category tabs"`

---

### Task 2: Content Script 沙箱回放探针 `verifySelectors`

**Files:**
- Modify: `src/content/content-script.js`
- Test: `tests/content-script.test.mjs`

**Interfaces:**
- Consumes: `{ action: 'verifySelectors', candidates: { [field: string]: string[] | string } }`
- Produces: `{ ok: true, results: { [field: string]: { selector: string, matchCount: number, sampleText: string, valid: boolean } } }`

- [ ] **Step 1: Write the failing test for `verifySelectors` in `tests/content-script.test.mjs`**
  - 测试用例：`onMessage verifySelectors：测试候选选择器并返回匹配计数与文本样本`

- [ ] **Step 2: Run test to verify it fails**
  Run: `node --test tests/content-script.test.mjs`
  Expected: FAIL (UNKNOWN_ACTION or action not handled)

- [ ] **Step 3: Implement `handleVerifySelectors` in `src/content/content-script.js`**
  - 遍历 `candidates` 中的选择器，通过 `document.querySelectorAll` 统计节点数。
  - 提取首个匹配节点的 `textContent` 截断前 30 个字符作为样本。
  - 返回验证结果映射表。

- [ ] **Step 4: Run test to verify it passes**
  Run: `node --test tests/content-script.test.mjs`
  Expected: PASS

- [ ] **Step 5: Commit**
  Run: `git add src/content/content-script.js tests/content-script.test.mjs; git commit -m "feat(content): add verifySelectors probe for sandbox validation"`

---

### Task 3: Background Service Worker 接入自学习生成-沙箱验证闭环

**Files:**
- Modify: `src/background/service-worker.js:404-480`
- Test: `tests/service-worker.test.mjs`

**Interfaces:**
- Consumes: 
  - `LEARN_SITE_PATTERNS` 消息
  - `VERIFY_DYNAMIC_PATTERNS` 消息
- Produces: `{ ok: true, patterns: object, report: object }`

- [ ] **Step 1: Write the failing test in `tests/service-worker.test.mjs`**
  - 测试用例 1：`LEARN_SITE_PATTERNS：通过探针回放过滤零命中规则并保存验证报告`
  - 测试用例 2：`VERIFY_DYNAMIC_PATTERNS：能对已保存的动态规则发起在线健康回测`

- [ ] **Step 2: Run test to verify it fails**
  Run: `node --test tests/service-worker.test.mjs`
  Expected: FAIL

- [ ] **Step 3: Implement verification loop in `src/background/service-worker.js`**
  - `handleLearnSitePatterns` 在调用 `learnSitePatterns` 后，向 targetTabId 发送 `verifySelectors`。
  - 仅保留 `matchCount > 0` 的候选选择器；同时组织 `report` 存入 `dynamic_site_patterns.metadata`。
  - 实现 `handleVerifyDynamicPatterns` 消息处理。

- [ ] **Step 4: Run test to verify it passes**
  Run: `node --test tests/service-worker.test.mjs`
  Expected: PASS

- [ ] **Step 5: Commit**
  Run: `git add src/background/service-worker.js tests/service-worker.test.mjs; git commit -m "feat(sw): integrate sandbox verification loop and telemetry report for adaptive learning"`

---

### Task 4: Popup 勘测报告可视化与规则管理面板

**Files:**
- Modify: `src/popup/index.html`
- Modify: `src/popup/popup.css`
- Modify: `src/popup/popup.js`
- Test: `tests/popup.test.js`

**Interfaces:**
- Consumes: `LEARN_SITE_PATTERNS` 返回的 `report`，以及已保存的 `dynamic_site_patterns`
- Produces: 用户可见的结构化勘测结果列表与【在当前页测试】/【清空动态经验】功能

- [ ] **Step 1: Add HTML elements in `src/popup/index.html` and styles in `src/popup/popup.css`**
  - 在 `#learnPatternsBox` 下增加 `#patternReportCard` 容器与操作按钮：
    - `#verifyPatternsBtn`（在当前页重新测试）
    - `#resetPatternsBtn`（清空动态经验）
    - `#patternReportList`（规则与命中状态列表）

- [ ] **Step 2: Implement UI render logic in `src/popup/popup.js`**
  - 在 `triggerLearn` 成功回调中渲染报告卡片（展示字段名、选择器、`✅ 命中 N 项` 或 `❌ 失效`、文本样本）。
  - 绑定 `#verifyPatternsBtn` 发送 `VERIFY_DYNAMIC_PATTERNS` 消息并更新列表。
  - 绑定 `#resetPatternsBtn` 发送 `RESET_DYNAMIC_PATTERNS`。

- [ ] **Step 3: Write tests for Popup render logic in `tests/popup.test.js`**
  - 测试用例：`renderPatternReport：正确生成字段状态徽章与匹配样本`

- [ ] **Step 4: Run test to verify it passes**
  Run: `node --test tests/popup.test.js`
  Expected: PASS

- [ ] **Step 5: Commit**
  Run: `git add src/popup/index.html src/popup/popup.css src/popup/popup.js tests/popup.test.js; git commit -m "feat(popup): add inspection report card and dynamic pattern control UI"`

---

### Task 5: 全链路端到端集成验证与测试

**Files:**
- Test: `tests/integration.test.mjs`
- Verify: 全套 9 个测试文件

- [ ] **Step 1: Run complete test suite**
  Run:
  ```bash
  for f in tests/site-patterns.test.js tests/storage.test.mjs tests/llm-client.test.mjs \
           tests/content-script.test.mjs tests/task-manager.test.mjs tests/scraper.test.mjs \
           tests/service-worker.test.mjs tests/popup.test.js tests/integration.test.mjs; do
    node --test "$f"; done
  ```
  Expected: All suites PASS.

- [ ] **Step 2: Commit any final tweaks**
  Run: `git commit -m "chore: complete adaptive learning transparency and search sort optimization"`
