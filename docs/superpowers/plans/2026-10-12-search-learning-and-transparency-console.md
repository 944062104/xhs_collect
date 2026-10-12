# 搜索页学习可靠性与全透明自适应控制台实施计划 (Search Learning & Transparency Console)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 根治小红书搜索页（`search_result`）DOM 巨大导致盲目截断无法自学的问题，并在 Popup 打造全透明的自适应学习调试控制台（展示捕获的 HTML 骨架、LLM 思考过程与原始候选规则）。

**Architecture:**
1. **智能骨架提取（Smart Skeleton Extraction）**：Content Script 在采集供学习的 DOM 时，不再抓取整个动辄几十万字符的 `body`，而是精准提取【筛选与排序操作栏】+【前 3~5 个笔记卡片】，打包成完整、轻量（<15KB）的关键交互骨架，彻底杜绝 `slice(0, 25000)` 截断导致丢失排序组件的问题；
2. **标签页双向绑定与健康嗅探**：Popup 与 Service Worker 在发起自学前，准确锁定背后的活跃小红书标签页，检测 Content Script 是否活跃，若未就绪提示一键刷新；
3. **去黑盒可视化控制台（Transparency Console UI）**：
   - 步骤进度（提取 DOM -> 调用 LLM -> 沙箱回测 -> 结果沉淀）；
   - 提供「查看捕获的 HTML 骨架」弹层或折叠区，让用户亲眼看到插件喂给 AI 的网页内容；
   - 展示大模型返回的原始策略 JSON 与各规则的真实回测详情。

**Tech Stack:** Chrome MV3 原生 JavaScript (Service Worker ESM + Content/Popup Classic Script)。

**Spec:** `docs/superpowers/specs/2026-10-12-adaptive-learning-transparency-and-search-sort-design.md`

## Global Constraints

- 严禁引入外部 UI 库，Popup 保持纯原生 HTML/CSS/JS。
- 测试驱动开发（TDD），每步保持 100% 测试通过。
- 保证断网/API 错误时的友好交互，绝不允许控制台卡死在加载态。

## Review Focus

1. **超长搜索页 DOM 压缩提取**：当小红书搜索页包含海量图文时，骨架提取器提取出包含筛选栏、排序项与卡片的骨架，体积在 15KB 以内且关键节点完好。
2. **标签页不在前台或未刷新**：当标签页尚未注入 Content Script 时，立即返回友好提示（如“未检测到活跃的小红书标签页，请点击刷新页面”），而非超时卡死。
3. **大模型返回原始策略留存**：即使某个选择器在当前页面命中为 0，也在控制台的原始规则中完整展示，并标注未命中原因，不再直接吃掉输出。
4. **HTML 骨架查看安全性**：展示捕获的 HTML 片段时必须使用 `textContent` 或经过安全转义，防止 XSS。
5. **向后兼容**：不破坏现有的单篇笔记详情页学习与通用规则存储格式。

---

### Task 1: 在 Content Script 中实现搜索页智能交互骨架提取器

**Files:**
- Modify: `src/content/content-script.js:325-350`
- Test: `tests/content-script.test.mjs`

**Interfaces:**
- Consumes: `{ action: 'getHTML', targetType: 'search' | 'detail' | 'auto', expandFilter: true }`
- Produces: `{ ok: true, data: string, meta: { length: number, sections: string[] } }`

- [ ] **Step 1: 编写搜索页核心骨架提取的单元测试**

```javascript
test('handleGetHTML：当针对搜索页时，智能提取筛选栏与前若干卡片构成的紧凑骨架，避免整页截断', async () => {
  resetDoc();
  // 构建包含巨量干扰节点与位于中后部的筛选栏和卡片
  // 验证 getHTML 返回的 HTML 字符串中包含筛选容器与卡片且长度受控
});
```

- [ ] **Step 2: 运行测试验证**

Run: `node --test tests/content-script.test.mjs`

- [ ] **Step 3: 实现 `extractSearchSkeleton()` 并集成到 `handleGetHTML`**

在 `src/content/content-script.js` 中：
- 识别当前页面是否为搜索结果页（URL 包含 `search_result` 或存在搜索输入框）；
- 若为搜索页，优先寻找：
  1. 顶部操作栏容器（包含筛选按钮、分类栏等）；
  2. 展开的筛选与排序面板（若已展开）；
  3. 瀑布流容器内的前 3~5 个卡片（截断多余卡片）；
- 拼接成一段紧凑、语义完整的 HTML 片段（附带基础结构），整体长度控制在 10KB~15KB 内。

- [ ] **Step 4: 运行测试并确保通过**

Run: `node --test tests/content-script.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交改动**

```bash
git add src/content/content-script.js tests/content-script.test.mjs
git commit -m "feat(content): extract compact search skeleton to prevent token truncation"
```

---

### Task 2: 优化 Service Worker 学习管道并透传调试元数据

**Files:**
- Modify: `src/background/service-worker.js:445-530`
- Test: `tests/service-worker.test.mjs`

**Interfaces:**
- Consumes: `LEARN_SITE_PATTERNS` 消息
- Produces: 返回对象增加 `debug: { capturedHtmlSnippet: string, rawLearned: object, tabUrl: string }`

- [ ] **Step 1: 编写透传调试信息的测试**

```javascript
test('LEARN_SITE_PATTERNS：响应中包含调试元数据（捕获的骨架预览与模型原始输出）', async () => {
  // 验证 resp.debug 存在且包含 capturedHtmlSnippet 和 rawLearned
});
```

- [ ] **Step 2: 运行测试验证**

Run: `node --test tests/service-worker.test.mjs`

- [ ] **Step 3: 更新 `handleLearnSitePatterns`**

在 `src/background/service-worker.js` 中：
- 强化小红书标签页锁定算法，检查标签 URL 与有效性；
- 若获取 HTML 失败给出包含当前标签状态的明晰错误；
- 在响应中回传 `debug` 字段，包含截取 HTML 的前 1000 字符预览、模型原始输出与耗时统计。

- [ ] **Step 4: 运行 service-worker 测试**

Run: `node --test tests/service-worker.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交改动**

```bash
git add src/background/service-worker.js tests/service-worker.test.mjs
git commit -m "feat(sw): attach transparency debug metadata to pattern learning pipeline"
```

---

### Task 3: 在 Popup 中构建全透明的自适应学习调试控制台

**Files:**
- Modify: `src/popup/index.html`
- Modify: `src/popup/popup.css`
- Modify: `src/popup/popup.js`
- Test: `tests/popup.test.js`

**Interfaces:**
- Consumes: `resp.debug`, `resp.report`, `resp.patterns`
- Produces: 实时日志流展示、HTML 骨架查看模态窗口、模型原始规则 JSON 展开区。

- [ ] **Step 1: 编写 Popup 报告格式化与调试展示的单元测试**

```javascript
test('renderDebugConsoleHtml：正确渲染包含步骤状态、捕获 DOM 摘要与模型输出的调试面板', () => {
  // 验证调试面板渲染逻辑
});
```

- [ ] **Step 2: 运行测试验证**

Run: `node --test tests/popup.test.js`

- [ ] **Step 3: 编写 HTML 结构与 CSS 样式**

在 `src/popup/index.html` 与 `src/popup/popup.css` 中：
- 增加「自学控制台」调试区域（默认折叠，学习时自动展开）；
- 包含【当前标签状态】、【捕获骨架查看】、【模型原始规则】3 大透明模块；
- 美化代码展示块与实测标记。

- [ ] **Step 4: 实现 `popup.js` 逻辑交互**

在 `src/popup/popup.js` 中：
- `onLearnPatterns` 过程中分阶段更新状态提示；
- 接收到响应后渲染 `debug` 详情；
- 页面初始化时自动读取并展示已存储规则的实测报告，杜绝关闭后信息丢失。

- [ ] **Step 5: 运行全量测试**

Run: `node --test tests/popup.test.js`
Expected: PASS

- [ ] **Step 6: 提交改动**

```bash
git add src/popup/index.html src/popup/popup.css src/popup/popup.js tests/popup.test.js
git commit -m "feat(popup): build transparency console for adaptive site pattern learning"
```

---

### Task 4: 全量回归与端到端验证

**Files:**
- Run: 全部 9 套自动化测试

- [ ] **Step 1: 运行全量测试**

```bash
for f in tests/site-patterns.test.js tests/storage.test.mjs tests/llm-client.test.mjs \
         tests/content-script.test.mjs tests/task-manager.test.mjs tests/scraper.test.mjs \
         tests/service-worker.test.mjs tests/popup.test.js tests/integration.test.mjs; do
  node --test "$f"; done
```
Expected: 全部通过（PASS）。

- [ ] **Step 2: 整理提交**

```bash
git commit -am "chore: finalize search learning reliability and transparency console"
```
