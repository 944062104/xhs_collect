# 意图驱动自适应学习与去过度限制重构计划 (Intent-Driven Adaptive Learning Refactor)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重构自适应学习与页面操作机制，从“强硬编码+死板固定嵌套 Schema”转变为“目标意图驱动（Intent-Driven）+ 模型自主发现定位策略 + 结果导向沙箱验证”。

**Architecture:** 
1. **意图层**：Prompt 与接口不再写死固定多层 JSON 结构，而是以“业务意图（目标：排序、列表、详情、评论）”为导向，由模型自主输出稳健定位器（CSS/XPath/文本锚点）；
2. **执行与自愈层**：Scraper 消除特化硬编码依赖，由通用动作执行器按照模型识别的最佳选择器与意图降级链（模型学到规则 -> 静态经验库 -> 通用拟人交互）统一调度；
3. **闭环验证层**：沙箱验证从简单的纯 CSS 节点数统计升级为支持 XPath/语义文本的真实命中与意图达成检测。

**Tech Stack:** Chrome MV3 原生 JavaScript (ESM 后台 + Classic 前端)，Node.js 内置 test runner。

**Spec:** `docs/superpowers/specs/2026-10-12-adaptive-learning-transparency-and-search-sort-design.md`

## Global Constraints

- 遵循 MV3 原生架构，后台 ESM，Content Script 与 Popup 为原生 JavaScript，无外部运行时依赖。
- 遵循 Ponytail 极简原则：不引入多余抽象类，删除硬编码特化分支，统一合并到轻量级的意图执行链中。
- 测试必须 100% 通过（当前全部 9 套测试均需持续保持通过）。

## Review Focus

1. **扁平化与动态意图结构兼容**：旧版存储的 `dynamic_site_patterns` 无论包含旧版嵌套格式还是新版意图列表，均能无缝合并与读取。
2. **XPath 与语义选择器回测**：沙箱探针不仅回测 CSS，且能原生地回测模型产出的 XPath（如 `//div[text()='最新']`）与属性表达式。
3. **排序动作的自愈降级**：当模型学到了新选择器时，优先采用模型规则；即使模型规则为空，依然平稳降级到通用筛选流程，绝不抛出未捕获异常。
4. **LLM 容错与无废话输出**：Prompt 彻底解除过载的规则指导，仅约束核心业务意图目标与 JSON 契约。
5. **Popup 报告自适应渲染**：UI 不再假设写死的字段结构，支持渲染任意层级的意图发现结果。

---

### Task 1: 松绑与重构 LLMClient 规则自学习 Prompt (Intent-Driven)

**Files:**
- Modify: `src/background/llm-client.js:155-175, 450-460`
- Test: `tests/llm-client.test.mjs`

**Interfaces:**
- Consumes: `htmlSnippet: string`, `targetType: string`
- Produces: `learnSitePatterns(htmlSnippet, targetType) -> Promise<Record<string, string[]>>`，输出以意图为 key（如 `search.sortLatest`, `search.noteCard`, `search.filterTrigger` 等），值为稳健选择器候选数组的自适应映射对象。

- [ ] **Step 1: 编写松绑后 Prompt 与动态意图输出测试**

```javascript
test('learnSitePatterns：支持意图驱动的通用选择器映射，不再强制嵌套死板结构', async () => {
  const client = new LLMClient({ apiKey: 'fake-key', model: 'mock-model' });
  client._callApi = async () => JSON.stringify({
    'search.filterTrigger': ['button[class*="filter"]', '//button[contains(.,"筛选")]'],
    'search.sortLatest': ['//div[text()="最新"]', '.sort-item-latest'],
    'search.noteCard': ['a[href*="/explore/"]', '.note-item']
  });
  const res = await client.learnSitePatterns('<div>mock</div>');
  assert.equal(Array.isArray(res['search.sortLatest']), true);
  assert.equal(res['search.sortLatest'].length, 2);
});
```

- [ ] **Step 2: 运行测试验证**

Run: `node --test tests/llm-client.test.mjs`
Expected: 观察当前行为。

- [ ] **Step 3: 重写 `SYSTEM_PATTERN_LEARNER` 系统提示词与标准化解析**

在 `src/background/llm-client.js` 中：
- 将 Prompt 调整为目标意图驱动：明确我们需要的关键意图（搜索卡片、排序最新、排序最热、筛选入口、标题、正文、评论区）；
- 允许模型自主输出扁平化的意图键名，或者兼容嵌套对象；
- 在 `learnSitePatterns` 返回前，自动将嵌套对象平铺为标准意图路径（如 `search.sortTabs.time_descending` 或 `search.sortLatest`），确保下游透明消费。

- [ ] **Step 4: 运行测试并确保通过**

Run: `node --test tests/llm-client.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交改动**

```bash
git add src/background/llm-client.js tests/llm-client.test.mjs
git commit -m "refactor(llm): make site pattern learner intent-driven and schema-flexible"
```

---

### Task 2: 统一 Content Script 的沙箱探针与选择器执行引擎

**Files:**
- Modify: `src/content/content-script.js:265-350`
- Test: `tests/content-script.test.mjs`

**Interfaces:**
- Consumes: `msg.candidates: Record<string, string[]>`
- Produces: `verifySelectors` 响应中的各意图项统计：`{ selector, matchCount, sampleText, valid, type: 'css' | 'xpath' | 'text' }`

- [ ] **Step 1: 编写测试覆盖通用 XPath 与文本锚点意图的回测**

```javascript
test('onMessage verifySelectors：原生支持回测 XPath 与文本锚点选择器', async () => {
  resetDoc();
  const el = makeElement('span', { textContent: '最新发布' });
  docState.textMatches['最新发布'] = el;
  const { response } = dispatch({
    action: 'verifySelectors',
    candidates: {
      'search.sortLatest': ["//*[text()='最新发布']"]
    }
  });
  const resp = await response;
  assert.equal(resp.ok, true);
  assert.equal(resp.results['search.sortLatest'].valid, true);
  assert.equal(resp.results['search.sortLatest'].matchCount >= 1, true);
});
```

- [ ] **Step 2: 运行测试验证**

Run: `node --test tests/content-script.test.mjs`
Expected: 验证当前回测能力。

- [ ] **Step 3: 增强 `handleVerifySelectors`**

在 `src/content/content-script.js` 中：
- 统一调用底层 `findFirstElement` 和 `document.evaluate`；
- 避免过度硬编码类型判断，支持将 CSS 类选择器、XPath 轴表达式与包含文本统一进行沙箱计数与样本拾取；
- 保留检测到包含排序/筛选时自动前置触发展开的通用动作，确保动态渲染元素回测准确。

- [ ] **Step 4: 运行测试并验证通过**

Run: `node --test tests/content-script.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交改动**

```bash
git add src/content/content-script.js tests/content-script.test.mjs
git commit -m "feat(content): enhance verifySelectors to transparently evaluate xpath and intent rules"
```

---

### Task 3: 优化 Service Worker 动态规则合并与分发机制

**Files:**
- Modify: `src/background/service-worker.js:490-575`
- Test: `tests/service-worker.test.mjs`

**Interfaces:**
- Consumes: `LEARN_SITE_PATTERNS`, `VERIFY_DYNAMIC_PATTERNS` 消息
- Produces: 存储标准化的 `dynamic_site_patterns`，使 Scraper 和 Popup 都能同时读取意图选择器与回测质量报告。

- [ ] **Step 1: 编写动态规则灵活合并与过滤单元测试**

```javascript
test('LEARN_SITE_PATTERNS：支持灵活意图格式的动态规则沉淀与验证过滤', async () => {
  // 验证扁平意图规则在沙箱过滤后正确持久化，并生成清晰的报告元数据
});
```

- [ ] **Step 2: 运行测试验证失败/通过**

Run: `node --test tests/service-worker.test.mjs`

- [ ] **Step 3: 重构 `flattenSelectors` 与 `filterVerifiedRules`**

在 `src/background/service-worker.js` 中：
- 消除对固定四层嵌套结构的硬编码假设；
- 支持递归/扁平双重兼容提取选择器数组；
- 过滤后仅将真正被沙箱 DOM 验证通过的有效定位规则合并入库。

- [ ] **Step 4: 运行全部 service worker 测试**

Run: `node --test tests/service-worker.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交改动**

```bash
git add src/background/service-worker.js tests/service-worker.test.mjs
git commit -m "refactor(sw): relax pattern structure constraints and robustly merge verified rules"
```

---

### Task 4: 提升 Scraper 调度对动态意图规则的优先消费

**Files:**
- Modify: `src/background/scraper.js`
- Test: `tests/scraper.test.mjs`

**Interfaces:**
- Consumes: `this.patterns` (静态经验与动态自适应经验深度合并)
- Produces: 动态学习到的选择器在搜索排序、卡片发现、详情采集阶段获得首选优先级。

- [ ] **Step 1: 编写 Scraper 消费动态自学选择器优先级的测试**

```javascript
test('Scraper 在搜索排序时，若动态自适应规则存在，优先使用自适应选择器进行操作', async () => {
  // 测试验证动态规则高于默认静态规则的调度逻辑
});
```

- [ ] **Step 2: 运行测试**

Run: `node --test tests/scraper.test.mjs`

- [ ] **Step 3: 简化 `scraper.js` 排序与发现动作调度**

在 `src/background/scraper.js` 中：
- 减少对特定函数名称的特殊条件硬编码；
- 统一通过选择器候选列表驱动：动态自适应规则 -> 静态配置规则 -> 语义降级兜底。

- [ ] **Step 4: 运行测试确保通过**

Run: `node --test tests/scraper.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交改动**

```bash
git add src/background/scraper.js tests/scraper.test.mjs
git commit -m "feat(scraper): prioritize learned intent patterns over hardcoded fallbacks"
```

---

### Task 5: 全量回归与端到端验证

**Files:**
- Test: 全部 9 套测试文件

- [ ] **Step 1: 运行全量 9 套测试套件**

```bash
for f in tests/site-patterns.test.js tests/storage.test.mjs tests/llm-client.test.mjs \
         tests/content-script.test.mjs tests/task-manager.test.mjs tests/scraper.test.mjs \
         tests/service-worker.test.mjs tests/popup.test.js tests/integration.test.mjs; do
  node --test "$f"; done
```
Expected: 所有套件 100% 通过（PASS）。

- [ ] **Step 2: 提交最终重构总结并更新文档**

```bash
git commit -am "chore: complete intent-driven adaptive learning refactor"
```
