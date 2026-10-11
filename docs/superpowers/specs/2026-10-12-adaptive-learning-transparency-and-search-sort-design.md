# 设计规范：AI 自适应学习透明化 (去黑盒) 与搜索排序精准化重构

## 1. 概述与背景

小红书采集助手（XHS Agent）通过 `site-patterns.json`（静态基线）结合 LLM 自学习（`dynamic_site_patterns`）实现 DOM 结构自愈与经验演进。
然而在实际使用中存在两大核心痛点：
1. **AI 自适应学习“黑盒感”严重**：
   - 输入不可见：未展开关键面板直接采集 HTML，大模型缺乏关键 DOM；
   - 输出无验证：LLM 生成的选择器未经页面沙箱回放即盲目入库，易受幻觉干扰；
   - 结果不透明：Popup 仅展示一句成功文字，用户看不到学到了什么、命中了多少元素、无法审计和测试。
2. **搜索排序偶发误触与失效**：
   - 误触分类栏：筛选按钮选择器过于宽松（如 `[class*="filter-btn"]`），误将顶部的【全部/图文/视频】分类栏容器识别为“筛选”按钮，导致误切分类；
   - 排序未生效：未展开浮层时盲目在全局查找“最新”文本，误命中页面其他不相干文字，误报成功并跳过真实筛选；且单页 SPA 对 URL `?sort=` 参数无响应，导致采集的数据仍为默认综合排序。

本设计旨在打造**“生成-沙箱验证-透明可视化”的自适应学习闭环**，并**彻底根治搜索排序的识别与触发链路**。

---

## 2. 详细设计

### 模块一：搜索排序交互重构（精准防误触与状态验证）

#### 1. 严格排斥左侧分类栏
- **筛选按钮定位规则**：
  - 必须包含“筛选”文本或具备筛选/滑块图标特征。
  - 明确排除位于分类栏内部的容器（例如其父级或自身包含 `tab`、`channel`、`nav` 且属于【全部/图文/视频/用户】集合的元素）。
  - 限定在视口右侧或搜索栏下方右侧区域（`rect.right > window.innerWidth * 0.5` 或属于独立操作区）。
- **彻底废除全局盲测**：
  - 移除 `findFirstElement(["//*[normalize-space(.)='" + targetName + "']", targetName])` 的预判跳过逻辑。
  - **强制两阶段执行**：
    1. 阶段 1：定位并点击真正的「筛选」按钮展开浮层。
    2. 阶段 2：在带有“排序依据”或“排序”标题的专属子容器内，定位目标胶囊（“综合”、“最新”、“最多点赞”、“最多评论”）。

#### 2. 状态感知与重载确认（Verification）
- 触发点击后，轮询检测：
  - 目标胶囊是否添加了高亮/激活属性（`active`、`selected`、`primary` 或 `color` 变化）。
  - 若检测到激活态，记录确认信息；
  - 瀑布流容器监听变化，给予必要的数据重载等待，确保爬虫读取到的是排好序后的全新卡片。

---

### 模块二：AI 自适应学习沙箱验证与闭环（去黑盒化核心）

#### 1. 采态前置触发（Pre-capture Exploration）
- 在执行自适应学习提取 HTML 时：
  - 若当前处于搜索结果页，Content Script 先主动模拟触发一次「筛选」展开，确保截取的 HTML 包含排序浮层 DOM。

#### 2. 沙箱即时回测（Sandbox Probe: `VERIFY_SELECTORS`）
- 流程定义：
  ```
  Popup 点击学习 
    ──> SW 获取准备好的页面 HTML 
    ──> LLMClient 提取候选规则 (Candidate Selectors)
    ──> SW 发送 VERIFY_SELECTORS 到当前页面 Content Script
    ──> Content Script 在真实 DOM 中执行 document.querySelectorAll 
    ──> 统计各选择器的 matchCount 与 提取文本 sampleText
    ──> 过滤：仅保留 matchCount > 0 的有效规则
    ──> 写入 IndexedDB (dynamic_site_patterns)，附带验证元数据
    ──> 返回验证报告 (Verification Report) 给 Popup
  ```

#### 3. 验证元数据与经验库结构
`config.dynamic_site_patterns` 扩展存储形态：
```json
{
  "selectors": {
    "search": {
      "filterButton": ["..."],
      "sortTabs": { "time_descending": ["..."] },
      "noteCard": ["..."]
    },
    "noteDetail": {
      "title": ["..."],
      "content": ["..."]
    }
  },
  "metadata": {
    "lastLearnedAt": 1773200000000,
    "report": {
      "search.filterButton": { "selector": "...", "count": 1, "sample": "筛选" },
      "search.sortTabs.time_descending": { "selector": "...", "count": 1, "sample": "最新" },
      "search.noteCard": { "selector": "...", "count": 18, "sample": "卡片示例..." }
    }
  }
}
```

---

### 模块三：Popup 可视化经验卡片与人机协同（Transparency UI）

在 Popup 的「规则自愈」区域提供直观的观测与管理界面：
1. **勘测报告折叠卡片（Inspection Report）**：
   - 学习完成后自动展开（平时可手动折叠/展开）。
   - 按字段罗列学到的规则与健康状态：
     - `筛选按钮`: `button.filter-btn` ➔ `✅ 命中 1 个节点`
     - `最新排序`: `.sort-box .latest` ➔ `✅ 命中 1 个节点`
     - `笔记卡片`: `section.note-card` ➔ `✅ 命中 20 个节点`
     - `正文详情`: `div.desc` ➔ `⚠️ 未命中`（自动过滤或高亮提醒）
2. **操作工具栏**：
   - 【重新在当前页检测】：一键用当前经验在当前页面重跑沙箱验证，评估规则是否老化。
   - 【查看/导出规则 JSON】：展开查看干净合并后的动态规则。
   - 【清空动态经验】：一键将动态规则重置为官方 `site-patterns.json` 基准。

---

## 3. 影响范围与改动文件

- `src/content/content-script.js`:
  - 优化 `setSearchSort`：严格排除分类 Tab、定位筛选按钮与“排序依据”容器、点击与激活确认。
  - 新增 `handleVerifySelectors`：沙箱回放测试任意候选选择器并返回统计样本。
- `src/background/llm-client.js`:
  - 增强 `SYSTEM_PATTERN_LEARNER` 提示词，明确排序浮层与搜索卡片层级结构。
- `src/background/service-worker.js`:
  - `handleLearnSitePatterns` 接入两阶段“生成 -> 沙箱验证 -> 沉淀有效规则”闭环。
  - 新增 `VERIFY_DYNAMIC_PATTERNS` 消息处理供用户主动体检。
- `src/popup/index.html` & `src/popup/popup.js` & `src/popup/popup.css`:
  - 升级学习反馈区为结构化报告面板与工具栏。
- `tests/**`:
  - `tests/content-script.test.mjs`: 增加防误触分类栏、浮层精准点击、`verifySelectors` 沙箱测试。
  - `tests/service-worker.test.mjs`: 增加自学习验证过滤机制的单测覆盖。

---

## 4. 验收标准

1. **排序零误触**：在具有分类 Tab（全部/图文/视频）的页面上执行 `setSearchSort`，绝不触发分类切换，100% 展开筛选浮层并点击指定的排序依据。
2. **排序真生效**：若浮层未展开或选项不存在，返回明确的错误或重试，绝不静默假装成功。
3. **自学习去黑盒**：
   - 学习过程有即时页面回放验证，命中数为 0 的选择器不被盲目写入；
   - 学习完成后在 Popup 界面直观展示学到的选择器、命中节点数与抽样文本；
   - 用户可随时在 Popup 中查看生效规则或一键清空还原。
4. **全量测试通过**：现有 9 套测试用例保持 100% 通过，并追加新特性的测试。
