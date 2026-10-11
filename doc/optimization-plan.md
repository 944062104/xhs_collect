# XHS Agent 健壮性与交互对齐优化方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 针对审查中发现的交互模式不一致、后台 Tab 残留、登录墙可见性误判等潜在问题进行专项优化，提升爬虫在真实浏览器中的稳定性与整洁度。

**Architecture:**
- **Tab 生命周期闭环**：在 `Scraper` 中引入受控的 tab 清理逻辑 `_cleanupTab()`，并在任务退出（completed / failed / cancelled）时保证调用，避免后台残留游离标签页。
- **经验模式与代码对齐**：对齐 `site-patterns.json` 与 `Scraper._detailPhase` 中的采集路径，剔除全页导航下的无效 `closeModal` 调用，并支持受控配置。
- **登录弹窗真实可见性判断**：在 `content-script.js` 的 `waitFor` / `isElementVisible` 中加入元素可见性（`offsetParent` 或 computedStyle 判定），杜绝隐藏遮罩层引发的 `AUTH_REQUIRED` 假阳性阻断。

**Tech Stack:** Chrome Extension Manifest V3, ES Modules (background), Classic Scripts (content/popup), Node.js test runner (`node --test`).

**Spec:** [doc/spec.md](file:///D:/code/myself/xhs/doc/spec.md)

---

## Global Constraints

- 不改变现有 113 个测试的核心断言契约；新增行为必须有独立测试覆盖。
- 遵循双模块约定：`background/**` 为 ESM，`content/**` 与 `popup/**` 为 Classic Script。
- 遵循懒人模式（Ponytail）原则：最小可行改动，无多余抽象，修复根因而非表象。
- `Scraper` 与 `Service Worker` 必须继续维持依赖注入（可测性）。

## Review Focus

1. **Tab 关闭异常容错**：当用户在采集过程中手动关闭了 Tab，`Scraper` 清理时调用 `tabs.remove` 不能抛出未捕获异常导致状态机崩溃。
2. **元素在 DOM 但不可见**：页面包含 `display: none` 或 `visibility: hidden` 的 `.modal-mask` 时，不应判定为检测到登录弹窗。
3. **取消状态下的资源释放**：当用户点击取消时，既要正确设置 `cancelled` 终态，也要立刻终止操作并安全释放 Tab。
4. **测试环境下的 tabs Mock 兼容**：测试注入的 fake tabs 必须适配 `tabs.remove(tabId)` 调用，不破坏现有套件。

---

## 实施任务清单

### Task 1: 登录遮罩元素可见性检查（消除误报）

**Files:**
- Modify: `src/content/content-script.js:37-73`
- Modify: `tests/content-script.test.mjs`

**Interfaces:**
- Consumes: `findFirstElement(selectors, checkVisibility?: boolean)`
- Produces: `action: "waitFor"` 支持 `requireVisible: true` 参数，过滤隐藏 DOM。

- [ ] **Step 1: 在 `tests/content-script.test.mjs` 中添加针对不可见元素的测试**
  编写测试：当页面存在 `display: none` 的遮罩层时，带 `requireVisible: true` 的 `waitFor` 应当超时或返回 `ok: false`，而不是直接视为命中。
- [ ] **Step 2: 运行测试验证失败**
  `node --test tests/content-script.test.mjs`
- [ ] **Step 3: 修改 `src/content/content-script.js` 实现可见性检查**
  增加 `isElementVisible(el)` 判定（检查 `el.offsetParent !== null` 以及 `getComputedStyle(el).display !== 'none'`），并在 `waitFor` 选项中支持过滤。
- [ ] **Step 4: 运行测试验证通过**
  `node --test tests/content-script.test.mjs`
- [ ] **Step 5: 提交代码**
  `git commit -m "fix(content): ensure waitFor checks visibility for login dialog detection"`

---

### Task 2: 详情采集流与经验库对齐（清理冗余 closeModal）

**Files:**
- Modify: `src/config/site-patterns.json:10-15`
- Modify: `src/background/scraper.js:329-335`
- Modify: `tests/scraper.test.mjs`

**Interfaces:**
- Consumes: `site-patterns.json` 的 `patterns.interaction` 配置
- Produces: 当通过独立 URL 导航采集时，不再发起无效的 `closeModal` 消息请求，减少通信开销与假告警。

- [ ] **Step 1: 编写测试断言全页导航模式下不再触发无意义的 closeModal**
  在 `tests/scraper.test.mjs` 中检查 `tabs.sendMessage` 的调用列表，确保全页详情模式下不发送 `closeModal`。
- [ ] **Step 2: 运行测试验证失败**
- [ ] **Step 3: 修改 `src/config/site-patterns.json` 与 `src/background/scraper.js`**
  - 在 `site-patterns.json` 将 `openDetailMethod` 标明为当前实现的模式（或根据配置决定是否执行浮层关闭）；
  - 移除 `scraper.js` 中全页导航后的硬编码 `closeModal` 兜底尝试。
- [ ] **Step 4: 运行测试验证通过**
- [ ] **Step 5: 提交代码**
  `git commit -m "refactor(scraper): align detail scraping flow with site patterns, removing redundant closeModal"`

---

### Task 3: 标签页生命周期安全闭环（采集结束关闭 Tab）

**Files:**
- Modify: `src/background/scraper.js:145-157`
- Modify: `src/background/scraper.js:375-438`
- Modify: `tests/scraper.test.mjs`

**Interfaces:**
- Produces:
  - `Scraper.prototype._cleanupTab(): Promise<void>`
  - 保证在 `run()` 和 `resume()` 的 `finally` 阶段调用 `await this._cleanupTab()`
  - 针对 `tabs.remove(tabId)` 异常进行静默吸收（防御已手动关闭的 tab）。

- [ ] **Step 1: 在 `tests/scraper.test.mjs` 中添加针对 tab 自动关闭与释放的测试**
  断言：
  1. 任务 `completed` 后 `tabs.remove` 被调用；
  2. 任务 `failed` 或 `cancelled` 后 `tabs.remove` 同样被调用；
  3. `this._tabId` 被置为 `null`。
- [ ] **Step 2: 运行测试验证失败**
- [ ] **Step 3: 实现 `_cleanupTab()` 并在 `run`/`resume`/`cancel` 中安全调用**
  ```javascript
  async _cleanupTab() {
    if (this._tabId != null && this.tabs?.remove) {
      try {
        await this.tabs.remove(this._tabId);
      } catch (_) {
        // 忽略 tab 已经被用户提前手动关闭的异常
      }
      this._tabId = null;
    }
  }
  ```
- [ ] **Step 4: 运行测试验证全部通过**
  `node --test tests/scraper.test.mjs`
- [ ] **Step 5: 提交代码**
  `git commit -m "feat(scraper): auto-cleanup background tabs on task termination"`

---

### Task 4: 全套件回归验证与自审

**Files:**
- 全局测试回归

- [ ] **Step 1: 运行所有 9 个测试套件**
  ```bash
  for f in tests/site-patterns.test.js tests/storage.test.mjs tests/llm-client.test.mjs \
           tests/content-script.test.mjs tests/task-manager.test.mjs tests/scraper.test.mjs \
           tests/service-worker.test.mjs tests/popup.test.js tests/integration.test.mjs; do
    node --test "$f"; done
  ```
- [ ] **Step 2: 确认无回归报错，所有 113+ 项测试全部 PASS**
- [ ] **Step 3: 检查代码仓库状态与无残留临时文件**
