# AGENTS.md — XHS Agent（小红书采集助手）

> 任意层协作规则首读文件。后端改动前另读 `CLAUDE.md`（本仓库暂未建，见「深入文档」）。
> 内容均为**规则与红线**，详细架构/接口/验收见 `doc/`。

## 速查表

| 项 | 值 |
|---|---|
| 项目 | Chrome MV3 原生 JS 扩展，关键词采集小红书笔记/评论并导出 JSON/CSV |
| 源码根 | `src/`（即扩展根目录，`manifest.json` 在此） |
| 测试 | `node --test <文件列表>`（见下方命令坑，当前 9 套件 181/181 通过） |
| 运行时依赖 | 无第三方库；`fake-indexeddb` 仅测试用（devDependency） |
| 数据存储 | 仅 IndexedDB（库 `xhs-agent`，stores: `tasks`/`notes`/`config`），无外部后端 |
| 开发分支 | `master`（所有功能均已集成并保留唯一直线分支） |
| 打包产物 | `dist/xhs-agent-1.0.0.zip`（manifest 在根，可直接 load-unpacked） |

## 模块架构（一图定位）

```
src/
├── manifest.json              MV3 入口；background type:"module"
├── config/site-patterns.json  站点静态基线经验库（选择器备选 + Action Recipe）
├── popup/  (index.html/popup.css/popup.js)   极简 UI + 进度 + 即时/全量导出 + 规则自学习
├── background/
│   ├── service-worker.js      中枢：消息分发 + chrome.alarms 25s 保活 + 续爬 + 跨标签页学习
│   ├── task-manager.js        任务状态机（pending→running→completed/failed/cancelled）
│   ├── scraper.js             经验驱动采集调度（搜索阶段 / 详情评论阶段 / 动态经验热叠加）
│   ├── llm-client.js          LLM 结构化提取与自学习（HTML→JSON / learnSitePatterns，含清洗容错）
│   └── storage.js             IndexedDB 封装（tasks/notes/config，含动态规则持久化）
└── content/content-script.js 页面 DOM 执行器（waitFor/click/scroll/getHTML/seenKeys评论排重）
```
数据流：Popup → Service Worker → Scraper（读 static + dynamic patterns + 调 LLMClient）→ Content Script（拟人化操作）→ Storage。

## 红线 / 全局约束（违反即错误）

- **MV3 规范**：无持久后台；禁止任意远程代码注入（`eval` 拉黑）。
- **零 UI 框架**：Popup 仅原生 HTML/CSS/JS，不引入 React/Vue 等。
- **拟人化操作**：步进滚动、操作间随机 2~5s 停顿、站内浮层交互，禁止暴力抓取。
- **保活 + 断点续传**：Service Worker 必须 25s Alarm 保活；中断后按 `task.progress.currentNoteIndex` 续爬，**不得从头重爬**。
- **本地优先**：数据只落 IndexedDB，不接外部服务器。

## 协作约定（可机械核验）

### 1. 双模块系统——不要混用
- `background/**` 用 **ESM**：`import ... from './x.js'`、`export class/function`。manifest `background.type:"module"`。
- `content/**` 与 `popup/**` 用 **classic script**：`popup.js` 底部有 `module.exports` 守卫导出纯函数供 Node 测试（浏览器中跳过）。
- `package.json` **刻意不写** `"type":"module"`。
- **测试文件后缀约定**：测 ESM 模块用 `*.test.mjs`（Node 按 ESM 解析）；测 classic 脚本用 `*.test.js`（如 `popup.test.js`、`site-patterns.test.js`）。

### 2. site-patterns.json 是行为静态基准真源
- 选择器备选、Action Recipe、反爬参数都进 `config/site-patterns.json`。
- **改采集行为先改经验库，不要在 `scraper.js` 里写死选择器/URL 模板。**
- AI 自学习规则（`learnSitePatterns`）作为运行时热补丁保存在 IndexedDB（`config.dynamic_site_patterns`），与静态基准在内存中深合并（动态优先），不直接改写 Git 跟踪的 `site-patterns.json`。

### 3. 依赖注入（可测性）
- `Scraper` 构造注入 `{ storage, llm, patterns, tabs, sleep }`，**禁止硬编码依赖**。
- `service-worker.js` 通过 `install(deps)` 注入（`export function install(deps = {})`）。
- 测试用 mock 的 tabs/llm/storage 注入，不连真机、不连真 API。

### 4. 错误分类——别混
- 用户取消 → `ScraperCancelledError` → 任务 `cancelled`（**不是** `failed`）。
- 登录墙 → `AuthRequiredError`（导出自 `scraper.js`）→ 任务 `failed` + `error.code:'AUTH_REQUIRED'`，Popup 经 `GET_PROGRESS` 的 `errors` 提示（START 响应不带此错误）。
- 网络失败 ≠ 解析失败：仅「API 成功但 JSON 解析失败」才走 LLMClient 重试；`content-script` 的 `SELECTOR_NOT_FOUND` 为永久失败、快速失败，`TAB_NOT_READY`/超时/网络类为瞬时失败、带退避重试。

### 5. 状态机边界与并发控制
- 终态：`completed`/`failed`/`cancelled`；`TaskManager.ALLOWED_TRANSITIONS` 之外一律拒绝（测试已覆盖非法转移）。
- 并发保护：`service-worker` 用模块级 `activeRun` 守卫，重复 `START_TASK` 返回 `{ok:false,error:'TASK_ALREADY_RUNNING'}`。
- 取消与停止中断真源：`service-worker` 维护模块级 `activeScraper` 单例跟踪，`cancelTask` 与 `finishEarly` 必须精准送达真实抓取循环；`scraper` 采用 `cancellableSleep` 轮询中断并在收到取消信号时**立即物理关闭后台标签页**。
- 搜索排序真实定位：小红书搜索页排序在右上角「筛选」面板内，必须以小标题「排序依据」为锚点，点击内部的「最新」或「最多点赞」胶囊按钮，杜绝误触左侧分类栏标签。
- 历史记录管理：`DELETE_TASKS` 消息支持批量勾选删除已完成任务并级联清理关联笔记，跳过正在 running 的任务。

## 命令速查

```bash
# 跑全部测试（必须显式列出文件——node --test 把目录当单文件，会漏跑！）
for f in tests/site-patterns.test.js tests/storage.test.mjs tests/llm-client.test.mjs \
         tests/content-script.test.mjs tests/task-manager.test.mjs tests/scraper.test.mjs \
         tests/service-worker.test.mjs tests/popup.test.js tests/integration.test.mjs; do
  node --test "$f"; done

# 加载调试：chrome://extensions → 开发者模式 → 加载已解压的扩展 → 选 src/
```

## Git 安全（本仓库红线）

- 对 git 做写操作（建/切分支、`reset --hard`、stash）前，**先确认无别的会话在同仓库并行编辑**——曾因并发 git 把 `.git` 整体清空。
- 提交按 conventional commits（`feat/fix/test/chore(scope): ...`）；本机推送经 Clash `127.0.0.1:7890`（详见用户级记忆，不在此复制）。

## 已知缺口（非阻断）

- `manifest.json` 未声明 `icons`：加载后用 Chrome 默认图标，功能不受影响；正式上架前需补 16/48/128 图标并在 manifest 声明。
- 真实 Chrome 端到端采集（plan Task 8 Step 1）仍待**手动**验证：代码逻辑已被 9 套件 181 测试覆盖（原 141 测试已全面扩展），但真机跑通需真实小红书页面 + 有效 Claude/OpenAI API Key，Agent 无法代跑。

## 深入文档

| 文档 | 用途 | 何时读 |
|---|---|---|
| `doc/plan.md` | P1 基础版 8 阶段任务、接口契约、架构与红线 | 查阅初始系统基石设计时 |
| `doc/plans/2026-10-11-comprehensive-optimization-plan.md` | 体验与功能综合优化（限流保护/即时导出/评论深度/批量词等） | 查阅最新特性演进细节时 |
| `doc/spec.md` | P1 详细规格（字段/枚举/边界） | 实现细节不确定时 |
| `doc/brief.md` | 需求背景与产品目标 | 理解「为什么这么做」 |
| `.workbuddy/memory/` | 本仓库每日日志 + 长期笔记 | 接手近期改动、长期约定 |

> 若后续引入后端改动（如 LLMClient 协议变更、Storage schema 变更），请在 `CLAUDE.md` 落成必读规则并同步 `doc/`；本文件保持「跨层协作规则」定位，不与 `CLAUDE.md` 合并。
