// Scraper — 经验驱动的采集调度器（ESM，供 background Service Worker 使用）。
//
// 设计约定（与仓库其它 background 模块一致）：
// - 依赖注入：storage / llm / patterns / tabs / sleep 全部由外部注入，便于测试。
// - 浏览器边界（chrome.tabs 消息、LLMClient）通过构造参数注入；默认回退到全局 chrome / fetch。
// - 使用全局 indexedDB（经 StorageManager）、全局 fetch（经 LLMClient）。
//
// 对外 API：
//   new Scraper({ storage, llm, patterns, tabs, sleep })
//   run(task)    : 完整采集（搜索 -> 详情+评论），遇到单条失败继续，整体失败则标记 failed
//   resume(task) : 从中断点续传（从 currentNoteIndex+1 继续，不重处理已采集）
//   cancel(id)   : 标记任务 cancelled（SW 的 alarm 将停止调用 resume）
//
// Content-script 协议（§2.3）：Scraper 通过 tabs.sendMessage 发送 {action,...}，
// content script 回复 {ok, data?, error?}。动作包括 waitFor / scroll / click /
// getHTML / closeModal。选择器键（如 search.feedsContainer）由此文件翻译为候选数组。

import { TaskManager } from './task-manager.js';

// 取消信号错误：run/resume 的 catch 会据此把任务置为 cancelled 而非 failed。
class ScraperCancelledError extends Error {
  constructor(taskId) {
    super(`任务 ${taskId} 已被取消`);
    this.name = 'ScraperCancelledError';
    this.isCancellation = true;
  }
}

// 搜索阶段安全上限，避免 LLM 始终返回不足 notesLimit 的 URL 时陷入死循环。
const MAX_SEARCH_SCROLLS = 50;
// 防封控：每次操作之间随机 2~5 秒停顿。
const MIN_PAUSE_MS = 2000;
const MAX_PAUSE_MS = 5000;
// 瞬态错误重试：tabs.sendMessage 偶发失败（如 tab 尚未就绪 / 网络抖动）时重试。
const MAX_RETRIES = 6;
const RETRY_BACKOFF_MS = 600;
// 永久错误（不重试）：选择器缺失、未登录拦截等应快速失败，避免无谓重试。
const TRANSIENT_ERROR_PATTERNS = [
  /TAB_NOT_READY/i,
  /TIMED?[_]?OUT/i,
  /NETWORK/i,
  /CONNECTION/i,
  /RECEIVING END DOES NOT EXIST/i,
  /COULD NOT ESTABLISH CONNECTION/i,
];

// 判断 content-script 返回的错误是否为「瞬态」（可重试）。
function isTransientError(error) {
  if (!error) return false;
  return TRANSIENT_ERROR_PATTERNS.some((re) => re.test(String(error)));
}

// 未登录拦截错误：run/resume 的 catch 会据此把任务置为 failed 且标记 AUTH_REQUIRED（非 generic fatal）。
export class AuthRequiredError extends Error {
  constructor(taskId) {
    super(`任务 ${taskId} 需要先在小红书网页端登录后才能采集（检测到登录弹窗）`);
    this.name = 'AuthRequiredError';
    this.code = 'AUTH_REQUIRED';
  }
}

// 频控与扫码拦截错误：检测到“当前笔记暂时无法浏览/扫码”等拦截时触发熔断保护，防止被小红书风控加重。
export class RateLimitError extends Error {
  constructor(taskId) {
    super(`任务 ${taskId} 触发小红书频控保护（检测到“当前笔记暂时无法浏览/App扫码”拦截），已自动停止并保存当前数据`);
    this.name = 'RateLimitError';
    this.code = 'RATE_LIMITED';
  }
}

/**
 * 将 selectorKey（点路径，如 "search.feedsContainer"）解析为候选选择器数组。
 * 兼容两种 patterns 形态：
 *   - 已解析的平台对象 { patterns: { selectors: {...} } }
 *   - 整站文件 { "xiaohongshu.com": { patterns: { selectors: {...} } } }
 */
export function resolveSelectors(patterns, dotKey) {
  let selRoot;
  if (patterns && patterns.patterns && patterns.patterns.selectors) {
    selRoot = patterns.patterns.selectors;
  } else {
    const platformKey = Object.keys(patterns ?? {})[0];
    selRoot = patterns?.[platformKey]?.patterns?.selectors || patterns?.selectors || patterns;
  }
  if (!selRoot) return [];

  // 1. 优先尝试直接匹配扁平键名（如 "search.sortTabs.time_descending" 或 "search.sortLatest"）
  if (Array.isArray(selRoot[dotKey])) return selRoot[dotKey];
  if (typeof selRoot[dotKey] === 'string') return [selRoot[dotKey]];

  // 2. 尝试标准点路径逐级下钻
  const parts = String(dotKey).split('.');
  let cur = selRoot;
  for (const p of parts) {
    cur = cur?.[p];
    if (cur == null) break;
  }
  if (Array.isArray(cur)) return cur;
  if (cur != null) return [cur];
  return [];
}

export class Scraper {
  constructor({ storage, llm, patterns = null, tabs = null, sleep = null }) {
    if (!storage) throw new Error('Scraper 需要注入 storage');
    if (!llm) throw new Error('Scraper 需要注入 llm');
    this.storage = storage;
    this.llm = llm;
    this.patterns = patterns;
    this.tabs = tabs ?? globalThis.chrome?.tabs ?? null;
    const cancellableSleep = (ms, taskId = null) =>
      new Promise((resolve, reject) => {
        if (taskId && this._cancelled.has(taskId)) {
          return reject(new ScraperCancelledError(taskId));
        }
        let timer = null;
        let check = null;
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          if (check) clearInterval(check);
        };
        timer = setTimeout(() => {
          cleanup();
          resolve();
        }, ms);
        if (taskId) {
          check = setInterval(() => {
            if (this._cancelled.has(taskId)) {
              cleanup();
              reject(new ScraperCancelledError(taskId));
            }
          }, 80);
        }
      });
    this.sleep = sleep ?? cancellableSleep;
    // 内部协作对象：状态机由 storage 派生的 TaskManager 管理（保持 DI 边界，storage 已是注入点）。
    this.taskManager = new TaskManager(storage);
    this._tabId = null; // 复用的标签页 id，避免每次导航都开新标签
    this._cancelled = new Set(); // 取消中的任务 id；循环边界检查，使 cancel 能中断进行中的 run/resume
  }

  // 若任务已被取消则抛出取消信号（由 run/resume 的 catch 转为 cancelled 状态）。
  _throwIfCancelled(taskId) {
    if (this._cancelled.has(taskId)) {
      throw new ScraperCancelledError(taskId);
    }
  }

  // ---- 模式加载 / 选择器 / URL 解析 --------------------------------------

  // 浏览器环境可默认从扩展包读取 config/site-patterns.json；优先合并 IndexedDB 中的动态学习经验（web-access 思想）
  async _ensurePatterns() {
    if (!this.patterns) {
      const url =
        globalThis.chrome?.runtime?.getURL &&
        globalThis.chrome.runtime.getURL('config/site-patterns.json');
      if (url) {
        try {
          const res = await fetch(url);
          if (res.ok) this.patterns = await res.json();
        } catch (_) {}
      }
    }
    if (!this.patterns) {
      this.patterns = {};
    }

    // 检查并合并 Storage 中由大模型动态学习并沉淀的经验 (Site Experience Store)
    if (this.storage && typeof this.storage.getConfig === 'function') {
      try {
        const dynamicPatterns = await this.storage.getConfig('dynamic_site_patterns');
        if (dynamicPatterns && typeof dynamicPatterns === 'object') {
          this._mergeDynamicPatterns(dynamicPatterns);
        }
      } catch (_) {}
    }

    return this.patterns;
  }

  // 深度合并动态规则（动态优先于静态，保留静态作为兜底）
  _mergeDynamicPatterns(dynamic) {
    const root = this._root();
    if (!root || !root.patterns || !root.patterns.selectors) return;
    const target = root.patterns.selectors;

    function merge(src, dst) {
      for (const k of Object.keys(src)) {
        if (Array.isArray(src[k])) {
          // 动态规则前置，原规则后置
          const oldList = Array.isArray(dst[k]) ? dst[k] : [];
          dst[k] = Array.from(new Set([...src[k], ...oldList]));
        } else if (src[k] && typeof src[k] === 'object') {
          if (!dst[k] || typeof dst[k] !== 'object') dst[k] = {};
          merge(src[k], dst[k]);
        }
      }
    }
    merge(dynamic, target);
  }

  // 取得平台根对象（兼容整站文件 / 已解析平台对象两种形态）。
  _root() {
    const p = this.patterns;
    if (p && p.patterns && p.patterns.selectors) return p;
    const key = Object.keys(p ?? {})[0];
    return p?.[key];
  }

  _sel(dotKey) {
    return resolveSelectors(this.patterns, dotKey);
  }

  _searchUrl(keyword) {
    const tpl = this._root()?.meta?.searchUrlTemplate;
    if (!tpl) throw new Error('site-patterns 缺少 meta.searchUrlTemplate');
    return tpl.replace('{keyword}', encodeURIComponent(keyword));
  }

  // ---- 与 content-script 通信 --------------------------------------------

  // 等待页面初始加载完成（status === 'complete'），避免向未就绪页面发送消息导致连接中断。
  async _waitForTabLoaded(tabId, timeoutMs = 8000) {
    if (!this.tabs?.get && !this.tabs?.onUpdated) return;
    if (typeof this.tabs?.get === 'function') {
      try {
        const curTab = await this.tabs.get(tabId);
        if (curTab && curTab.status === 'complete') return;
      } catch (_) {}
    }
    if (!this.tabs?.onUpdated?.addListener) return;

    return new Promise((resolve) => {
      let timer = null;
      const listener = (tid, changeInfo) => {
        if (tid === tabId && changeInfo.status === 'complete') {
          cleanup();
          resolve();
        }
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        try {
          this.tabs?.onUpdated?.removeListener?.(listener);
        } catch (_) {}
      };
      timer = setTimeout(() => {
        cleanup();
        resolve(); // 超时放行，由后续 waitFor 与瞬态重试兜底
      }, timeoutMs);
      try {
        this.tabs.onUpdated.addListener(listener);
      } catch (_) {
        cleanup();
        resolve();
      }
    });
  }

  // 复用（或新建）标签页并导航到 url，返回 tabId。
  async _navigate(url) {
    if (this.tabs == null) throw new Error('Scraper: 未注入 tabs（chrome.tabs）');
    if (this._tabId != null) {
      await this.tabs.update(this._tabId, { url });
      await this._waitForTabLoaded(this._tabId);
      return this._tabId;
    }
    const tab = await this.tabs.create({ url });
    this._tabId = tab.id;
    await this._waitForTabLoaded(this._tabId);
    return this._tabId;
  }

  // 任务终态时安全关闭后台创建的标签页，保持用户浏览器整洁。
  async _cleanupTab() {
    if (this._tabId != null && typeof this.tabs?.remove === 'function') {
      try {
        await this.tabs.remove(this._tabId);
      } catch (_) {
        // 忽略标签页已被用户手动提前关闭的异常
      }
      this._tabId = null;
    }
  }

  // 向 content-script 发消息；带瞬态错误重试。
  // - tabs.sendMessage 抛错（tab 崩溃 / 连接中断等通信层错误）→ 视为瞬态，退避后重试。
  // - 回复 {ok:false} 且 error 命中 TRANSIENT_ERROR_PATTERNS → 退避后重试。
  // - 回复 {ok:false} 且为永久错误（如 SELECTOR_NOT_FOUND / AUTH_REQUIRED）→ 立即抛出，不重试。
  async _send(tabId, msg) {
    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let res;
      try {
        res = await this.tabs.sendMessage(tabId, msg);
      } catch (err) {
        // 通信层抛错（瞬态），记录后进入退避重试。
        lastErr = err;
        if (attempt < MAX_RETRIES) await this.sleep(RETRY_BACKOFF_MS);
        continue;
      }
      if (res && res.ok === true) return res;
      const error = res?.error || 'NO_RESPONSE';
      if (!isTransientError(error)) {
        // 永久错误：不重试，原样抛出。
        const e = new Error(`content script 返回错误: ${error} (action=${msg.action})`);
        e.permanent = true;
        e.code = error;
        throw e;
      }
      lastErr = new Error(`content script 返回错误: ${error} (action=${msg.action})`);
      if (attempt < MAX_RETRIES) await this.sleep(RETRY_BACKOFF_MS);
    }
    throw lastErr;
  }

  // 防封控随机停顿：默认 2~5s 随机；当任务显式配置 crawlDelay > 0 时改为该固定延迟（防封微调）。
  async _randomPause(task) {
    const crawlDelay = task?.config?.crawlDelay;
    let delay;
    if (typeof crawlDelay === 'number' && crawlDelay > 0) {
      delay = crawlDelay; // 用户显式设定的固定延迟（毫秒）
    } else {
      delay = MIN_PAUSE_MS + Math.floor(Math.random() * (MAX_PAUSE_MS - MIN_PAUSE_MS + 1));
    }
    await this.sleep(delay);
  }

  // 鉴权拦截检测：导航到搜索结果页后，检查是否存在登录弹窗（未登录墙）。
  // 若 content script 报告登录弹窗存在（waitFor 命中登录选择器 → res.ok===true），抛出 AuthRequiredError。
  // 注意：本方法直接调用 tabs.sendMessage（不走 _send 的「ok:false 即抛错」），以便区分「无弹窗(ok:false)」与真实错误。
  async _detectAuth(task, tabId) {
    const root = this._root();
    const detectSelector = root?.patterns?.traps?.loginDialog?.detectSelector;
    if (!detectSelector) return; // 无陷阱配置则跳过检测
    let res;
    try {
      res = await this.tabs.sendMessage(tabId, {
        action: 'waitFor',
        selectors: String(detectSelector)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        requireVisible: true,
        timeout: 3000,
      });
    } catch {
      return; // 通信瞬态失败不阻断采集，仅跳过本次检测
    }
    if (res && res.ok === true) {
      throw new AuthRequiredError(task.id);
    }
    // ok:false → 未出现登录弹窗，正常继续
  }

  // ---- 搜索阶段 ----------------------------------------------------------

  async _searchPhase(task) {
    const rawKeywords = task.config?.keywords || String(task.keyword || '').split(/[,，\n]+/).map((s) => s.trim()).filter(Boolean);
    const keywords = rawKeywords.length > 0 ? rawKeywords : [task.keyword || ''];
    const limit = task.config.notesLimit;

    for (let k = 0; k < keywords.length; k++) {
      if (task.progress.noteUrls.length >= limit) break;
      const kw = keywords[k];
      let url = this._searchUrl(kw);
      const sortType = task.config?.sortType;
      // 1. 若指定了排序规则，优先在 URL 查询参数中附加 sort（小红书最新接口支持在 URL 中直传）
      if (sortType && sortType !== 'general') {
        url += (url.includes('?') ? '&' : '?') + `sort=${encodeURIComponent(sortType)}`;
      }

      task.progress.stepMessage = `正在打开搜索页采集关键词“${kw}”${keywords.length > 1 ? ` (${k + 1}/${keywords.length})` : ''}...`;
      await this.taskManager.saveProgress(task, { stepMessage: task.progress.stepMessage });

      const tabId = await this._navigate(url);
      await this._detectAuth(task, tabId);
      await this._send(tabId, {
        action: 'waitFor',
        selectors: this._sel('search.feedsContainer'),
        timeout: 10000,
      });

      // 2. 双重保障与闭环自愈：在页面中模拟点击对应的排序标签（如“最新”、“最多点赞”）
      if (sortType && sortType !== 'general') {
        try {
          this._throwIfCancelled(task.id);
          const sortLabelMap = {
            time_descending: '最新发布',
            popularity_descending: '最多点赞',
            comments_descending: '最多评论',
          };
          const sortLabel = sortLabelMap[sortType] || sortType;
          task.progress.stepMessage = `正在切换排序为“${sortLabel}”...`;
          await this.taskManager.saveProgress(task, { stepMessage: task.progress.stepMessage });

          // 步骤 1：先执行
          let sortRes = await this._send(tabId, {
            action: 'setSearchSort',
            sortType,
            timeout: 5000,
          }).catch(() => null);

          // 步骤 2：判断有没有成功 (若返回 active: false 或 ok: false 则判定未生效)
          let isSuccess = Boolean(sortRes && sortRes.ok && sortRes.active !== false);

          // 步骤 3：如果失败或未激活，进入闭环多轮自学习与验证流程（学习 -> 验证 -> 失败带反馈重学 -> 再验证）
          const MAX_LEARN_ROUNDS = 2;
          let round = 0;
          let lastFailedRule = null;

          while (!isSuccess && round < MAX_LEARN_ROUNDS && this.llm && typeof this.llm.learnSearchSortRegion === 'function') {
            round++;
            try {
              task.progress.stepMessage = `排序未生效，正在进行第 ${round} 轮 AI 区域定位与自学习...`;
              await this.taskManager.saveProgress(task, { stepMessage: task.progress.stepMessage });

              // 抓取顶部交互控制区域 HTML 骨架（content-script 会确保展开浮层后再抓取）
              const regionResp = await this._send(tabId, { action: 'getInteractiveRegionHtml' }).catch(() => null);
              const regionHtml = regionResp?.html || '';

              if (regionHtml && regionHtml.length > 30) {
                const feedback = lastFailedRule
                  ? `上一轮尝试的规则 ${JSON.stringify(lastFailedRule)} 点击后未检测到 active 激活态，请重新定位容器与胶囊。`
                  : '';
                const learned = await this.llm.learnSearchSortRegion(regionHtml, sortType, feedback);

                if (learned && (learned.regionSelector?.length > 0 || learned.sortOption?.length > 0 || learned.filterButton?.length > 0)) {
                  lastFailedRule = { region: learned.regionSelector, sort: learned.sortOption };
                  task.progress.stepMessage = `第 ${round} 轮 AI 学习完成 (${learned.reason || '已调整规则'})，正在验证执行...`;
                  await this.taskManager.saveProgress(task, { stepMessage: task.progress.stepMessage });

                  // 动态保存与热重载规则
                  const dynamicPatterns = (await this.storage?.getConfig('dynamic_site_patterns')) || {};
                  dynamicPatterns.search = dynamicPatterns.search || {};
                  if (learned.regionSelector?.length) dynamicPatterns.search.sortRegion = learned.regionSelector;
                  if (learned.filterButton?.length) dynamicPatterns.search.filterButton = learned.filterButton;
                  if (learned.sortOption?.length) {
                    dynamicPatterns.search.sortTabs = dynamicPatterns.search.sortTabs || {};
                    dynamicPatterns.search.sortTabs[sortType] = learned.sortOption;
                  }
                  await this.storage?.saveConfig('dynamic_site_patterns', dynamicPatterns);
                  if (typeof this._mergeDynamicPatterns === 'function') {
                    this._mergeDynamicPatterns(dynamicPatterns);
                  }

                  // 再次执行
                  sortRes = await this._send(tabId, {
                    action: 'setSearchSort',
                    sortType,
                    regionSelector: learned.regionSelector,
                    filterButton: learned.filterButton,
                    sortOption: learned.sortOption,
                    timeout: 5000,
                  }).catch(() => null);

                  // 再次严格验证判断
                  isSuccess = Boolean(sortRes && sortRes.ok && sortRes.active !== false);
                }
              }
            } catch (_) {
              // 自学异常降级处理
            }
          }

          if (isSuccess) {
            task.progress.stepMessage = `已成功切换为“${sortLabel}”，正在加载数据...`;
            await this.taskManager.saveProgress(task, { stepMessage: task.progress.stepMessage });
            // 切换排序后小红书瀑布流会异步拉取新数据，等待 3 秒确保新排序卡片渲染完成
            await this.sleep(3000, task.id);
          } else {
            // 降级兜底：尝试使用 site-patterns 中的选择器点击
            let fallbackClicked = false;
            const sortSelectors = this._sel(`search.sortTabs.${sortType}`);
            if (sortSelectors && sortSelectors.length > 0) {
              const clickRes = await this._send(tabId, { action: 'click', selectors: sortSelectors }).catch(() => null);
              if (clickRes && clickRes.ok) {
                fallbackClicked = true;
                await this.sleep(2500, task.id);
              }
            }
            if (!fallbackClicked) {
              task.progress.stepMessage = `⚠️ 页面排序未成功切换（已自动降级按当前内容采集）...`;
              await this.taskManager.saveProgress(task, { stepMessage: task.progress.stepMessage });
              await this.sleep(1500, task.id);
            }
          }
        } catch (_) {
          // 排序切换失败不阻断采集，继续按页面当前内容进行
        }
      }

      let kwScrolls = 0;
      const maxKwScrolls = Math.max(10, Math.ceil(MAX_SEARCH_SCROLLS / keywords.length));
      while (task.progress.noteUrls.length < limit && kwScrolls < maxKwScrolls && task.progress.scrollCount < MAX_SEARCH_SCROLLS) {
        this._throwIfCancelled(task.id);
        task.progress.stepMessage = `正在搜索“${kw}”（已发现 ${task.progress.noteUrls.length}/${limit} 篇）...`;
        await this.taskManager.saveProgress(task, { stepMessage: task.progress.stepMessage });

        await this._send(tabId, { action: 'scroll', distance: 600, duration: 800 });
        task.progress.scrollCount += 1;
        kwScrolls += 1;

        // 1. 优先通过 content-script 在真实 DOM 中精准提取当前可见的笔记链接（毫秒级、0 Token）
        let foundDirectly = false;
        try {
          const linkRes = await this._send(tabId, {
            action: 'getNoteUrls',
            selectors: this._sel('search.noteLink'),
          });
          if (linkRes && Array.isArray(linkRes.data) && linkRes.data.length > 0) {
            for (const rawUrl of linkRes.data) {
              if (task.progress.noteUrls.length >= limit) break;
              let u = String(rawUrl).trim();
              if (u.startsWith('/')) u = 'https://www.xiaohongshu.com' + u;
              if (!task.progress.noteUrls.includes(u)) {
                task.progress.noteUrls.push(u);
                foundDirectly = true;
              }
            }
          }
        } catch (_) {}

        // 2. 若 DOM 未直接命中（如特殊页面结构或测试环境），回退到 LLM 从 HTML 中提取
        if (!foundDirectly && task.progress.noteUrls.length < limit) {
          try {
            const htmlRes = await this._send(tabId, { action: 'getHTML', selectors: this._sel('search.feedsContainer') });
            if (htmlRes && htmlRes.data) {
              const list = await this.llm.extractNoteList(htmlRes.data);
              if (Array.isArray(list)) {
                for (const item of list) {
                  if (task.progress.noteUrls.length >= limit) break;
                  if (item && item.url) {
                    let u = String(item.url).trim();
                    if (u.startsWith('/')) {
                      u = 'https://www.xiaohongshu.com' + u;
                    }
                    if (!task.progress.noteUrls.includes(u)) {
                      task.progress.noteUrls.push(u);
                    }
                  }
                }
              }
            }
          } catch (searchLlmErr) {
            console.warn('[xhs] 搜索阶段回退 LLM 提取笔记链接异常:', searchLlmErr);
          }
        }
        // CHECKPOINT：每轮滚动后保存已采集的 URL 列表，保证断点可恢复。
        await this.taskManager.saveProgress(task, {
          noteUrls: task.progress.noteUrls,
          scrollCount: task.progress.scrollCount,
          stepMessage: `正在搜索“${kw}”（已发现 ${task.progress.noteUrls.length}/${limit} 篇）...`,
        });
        await this._randomPause(task);
      }
    }

    if (task.progress.noteUrls.length > limit) {
      task.progress.noteUrls = task.progress.noteUrls.slice(0, limit);
    }
    task.progress.notesTotal = task.progress.noteUrls.length;
    if (task.progress.notesTotal === 0) {
      task.progress.stepMessage = `搜索完成：未发现与关键词相关的笔记（可能为敏感词或无搜索结果）`;
    } else {
      task.progress.stepMessage = `搜索完成，共获取 ${task.progress.notesTotal} 篇笔记，准备提取详情与评论...`;
    }
    await this.taskManager.saveProgress(task, {
      notesTotal: task.progress.notesTotal,
      stepMessage: task.progress.stepMessage,
    });
  }

  // ---- 详情 + 评论阶段 ---------------------------------------------------

  async _detailPhase(task) {
    if (!task.progress.noteUrls || task.progress.noteUrls.length === 0) {
      task.progress.phase = 'done';
      task.progress.stepMessage = '采集完成：未发现与关键词相关的笔记（可能为敏感词或无搜索结果）';
      await this.taskManager.saveProgress(task, { phase: 'done', stepMessage: task.progress.stepMessage });
      return;
    }

    task.progress.phase = 'collectingNotes';
    task.progress.stepMessage = '正在准备提取笔记详情...';
    await this.taskManager.saveProgress(task, { phase: 'collectingNotes', stepMessage: task.progress.stepMessage });

    // 关键：从 currentNoteIndex+1 开始（run 起始为 -1，故首条为 0）。
    // resume 时 task.progress.currentNoteIndex 已指向最后成功采集的索引，因此自动跳过已处理项。
    const start = task.progress.currentNoteIndex + 1;
    for (let i = start; i < task.progress.noteUrls.length; i++) {
      this._throwIfCancelled(task.id);
      const url = task.progress.noteUrls[i];
      task.progress.stepMessage = `正在抓取第 ${i + 1}/${task.progress.noteUrls.length} 篇详情...`;
      await this.taskManager.saveProgress(task, { stepMessage: task.progress.stepMessage });

      let tabId = null;
      try {
        tabId = await this._navigate(url);
        await this._send(tabId, {
          action: 'waitFor',
          selectors: this._sel('noteDetail.container'),
          timeout: 8000,
        });

        let detail = null;
        let comments = [];

        // 1. 优先尝试从 DOM 毫秒级直接提取（0.005 秒，零 Token 消耗，准确度 100%）
        try {
          const dRes = await this._send(tabId, { action: 'getNoteDetail', selectors: this._sel('noteDetail.title') });
          if (dRes && dRes.data && (dRes.data.title || dRes.data.content)) {
            // 防御：若标题或正文命中限流提示，触发熔断保护
            if (
              dRes.data.title.includes('当前笔记暂时无法浏览') ||
              dRes.data.content.includes('当前笔记暂时无法浏览') ||
              dRes.data.title.includes('请打开小红书App扫码查看')
            ) {
              throw new RateLimitError(task.id);
            }
            detail = dRes.data;
          }
        } catch (err) {
          if (err && (err.code === 'RATE_LIMITED' || err instanceof RateLimitError || String(err).includes('RATE_LIMITED'))) {
            throw new RateLimitError(task.id);
          }
        }

        const commentDepth = task.config?.commentsPerNote ?? (task.config?.comments === false ? 0 : 20);
        let commentsDomSuccess = false;
        if (commentDepth > 0) {
          try {
            // 向下平滑滚动一次以触发评论懒加载（小红书评论区进入视口才发起请求渲染）
            await this._send(tabId, { action: 'scroll', distance: 500, duration: 600 }).catch(() => {});
            await this.sleep(600);

            const cRes = await this._send(tabId, { action: 'getComments', limit: commentDepth });
            if (cRes && Array.isArray(cRes.data)) {
              comments = cRes.data;
              // 若抓取到了评论，或者 DOM 成功定位到了评论区（确认为 0 评论），则无需回退 LLM
              if (comments.length > 0 || cRes.sectionFound !== false) {
                commentsDomSuccess = true;
              }
            }
          } catch (_) {}
        }

        // 2. 若 DOM 未直接命中（如特殊页面结构或测试环境），回退到 LLM 提取
        if (!detail || (!detail.title && !detail.content)) {
          const detailHtml = (
            await this._send(tabId, { action: 'getHTML', selectors: this._sel('noteDetail.container') })
          ).data;
          detail = await this.llm.extractNoteDetail(detailHtml);
        }

        if (commentDepth > 0 && comments.length === 0 && !commentsDomSuccess) {
          try {
            const commentsHtml = (
              await this._send(tabId, { action: 'getHTML', selectors: this._sel('noteDetail.commentSection') })
            ).data;
            comments = await this.llm.extractComments(commentsHtml);
          } catch (_) {}
        }

        // 最终保障：对评论列表做一次唯一性去重（author + text）
        if (Array.isArray(comments) && comments.length > 1) {
          const seen = new Set();
          comments = comments.filter((c) => {
            const text = String(c?.text ?? c?.content ?? '').trim();
            const author = String(c?.author ?? '').trim();
            const key = `${author}::${text}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        }

        const note = {
          id: `note_${task.id}_${i}`,
          taskId: task.id,
          url,
          collectedAt: Date.now(),
          ...detail,
          commentList: comments,
        };
        await this.storage.saveNote(note);

        // CHECKPOINT：每成功采集一条即推进进度，确保中断后可续传。
        task.progress.currentNoteIndex = i;
        task.progress.notesCollected += 1;
        task.progress.commentsCollected += Array.isArray(comments) ? comments.length : 0;
        task.progress.currentTitle = detail.title || '';

        this._throwIfCancelled(task.id);

        task.progress.stepMessage = `已抓取：${detail.title ? `《${detail.title.slice(0, 15)}...》` : `第 ${i + 1} 篇`}`;
        await this.taskManager.saveProgress(task, {
          currentNoteIndex: task.progress.currentNoteIndex,
          notesCollected: task.progress.notesCollected,
          commentsCollected: task.progress.commentsCollected,
          currentTitle: task.progress.currentTitle,
          stepMessage: task.progress.stepMessage,
        });
      } catch (err) {
        if (
          this._cancelled.has(task.id) ||
          (err && (err.isCancellation || err.code === 'RATE_LIMITED' || err instanceof RateLimitError || err.code === 'AUTH_REQUIRED')) ||
          (this._cancelled.has(task.id) && String(err?.message || '').toLowerCase().includes('aborted'))
        ) {
          throw err;
        }
        // 单条失败：记录错误，将 currentNoteIndex 推进到本索引（标记已处理，避免 resume 时死重试），继续后续。
        // 通过 saveTask 落库，确保 task.errors 增量持久化（而非污染 task.progress）。
        task.errors.push({
          index: i,
          url,
          phase: 'collectingNotes',
          message: String(err?.message ?? err),
          error: String(err?.message ?? err),
          at: Date.now(),
        });
        task.progress.currentNoteIndex = i;
        task.progress.stepMessage = `第 ${i + 1} 篇抓取失败，继续下一篇...`;
        await this.storage.saveTask(task);
        continue;
      }
      await this._randomPause(task);
    }
  }

  // ---- 对外 API ----------------------------------------------------------

  async run(task) {
    await this._ensurePatterns();
    try {
      await this.taskManager.updateStatus(task, 'running');
      task.progress.phase = 'searching';
      await this.taskManager.saveProgress(task, { phase: 'searching' });

      await this._searchPhase(task);
      await this._detailPhase(task);

      task.progress.phase = 'done';
      await this.taskManager.saveProgress(task, { phase: 'done' });
      await this.taskManager.updateStatus(task, 'completed');
    } catch (err) {
      if (this._cancelled.has(task.id) || (err && err.isCancellation) || (this._cancelled.has(task.id) && String(err?.message || '').toLowerCase().includes('aborted'))) {
        if (this._finishedEarly && this._finishedEarly.has(task.id)) {
          task.progress.phase = 'done';
          task.progress.stepMessage = `提前完成采集，已保存全部 ${task.progress.notesCollected} 篇数据`;
          await this.taskManager.saveProgress(task, { phase: 'done', stepMessage: task.progress.stepMessage });
          await this.taskManager.updateStatus(task, 'completed');
        }
        return;
      }
      if (err && err.code === 'AUTH_REQUIRED') {
        // 未登录拦截：标记 failed 且记录 AUTH_REQUIRED（区别于 generic fatal）。
        task.errors.push({
          code: 'AUTH_REQUIRED',
          phase: task.progress.phase,
          message: String(err?.message ?? err),
          at: Date.now(),
        });
        task.progress.stepMessage = '采集失败：需要先在小红书网页端登录（检测到登录弹窗）';
        await this.taskManager.updateStatus(task, 'failed');
        return;
      }
      if (err && (err.code === 'RATE_LIMITED' || err instanceof RateLimitError)) {
        // 频控熔断保护：优雅终止并保留已采集数据，提醒用户稍作休息
        task.errors.push({
          code: 'RATE_LIMITED',
          phase: task.progress.phase,
          message: String(err?.message ?? err),
          at: Date.now(),
        });
        task.progress.stepMessage = '触发小红书频控保护（当前笔记暂时无法浏览），已自动停止并保存当前数据';
        await this.taskManager.updateStatus(task, 'failed');
        return;
      }
      task.errors.push({
        phase: task.progress.phase,
        fatal: true,
        message: String(err?.message ?? err),
        at: Date.now(),
      });
      task.progress.stepMessage = `采集失败：${err?.message ?? err}`;
      // updateStatus 会通过 saveTask 落库整个 task（含 task.errors），无需经 saveProgress 污染 progress。
      await this.taskManager.updateStatus(task, 'failed');
    } finally {
      this._cancelled.delete(task.id); // 释放取消标志，避免长生命周期 SW 中集合无限增长
      if (this._finishedEarly) this._finishedEarly.delete(task.id);
      await this._cleanupTab();
    }
  }

  async resume(task) {
    await this._ensurePatterns();
    try {
      if (task.status !== 'running') {
        await this.taskManager.updateStatus(task, 'running');
      }
      // 搜索阶段未完成（phase 仍为 'searching'，或 noteUrls 仍为空）时先补完搜索；
      // 否则直接进入详情阶段从断点（currentNoteIndex+1）继续。搜索重跑安全（URL 去重）。
      if (task.progress.phase === 'searching' || !task.progress.noteUrls || task.progress.noteUrls.length === 0) {
        await this._searchPhase(task);
      }
      await this._detailPhase(task);

      task.progress.phase = 'done';
      await this.taskManager.saveProgress(task, { phase: 'done' });
      await this.taskManager.updateStatus(task, 'completed');
    } catch (err) {
      if (this._cancelled.has(task.id) || (err && err.isCancellation) || (this._cancelled.has(task.id) && String(err?.message || '').toLowerCase().includes('aborted'))) {
        if (this._finishedEarly && this._finishedEarly.has(task.id)) {
          task.progress.phase = 'done';
          task.progress.stepMessage = `提前完成采集，已保存全部 ${task.progress.notesCollected} 篇数据`;
          await this.taskManager.saveProgress(task, { phase: 'done', stepMessage: task.progress.stepMessage });
          await this.taskManager.updateStatus(task, 'completed');
        }
        return;
      }
      if (err && err.code === 'AUTH_REQUIRED') {
        // 未登录拦截：标记 failed 且记录 AUTH_REQUIRED（区别于 generic fatal）。
        task.errors.push({
          code: 'AUTH_REQUIRED',
          phase: task.progress.phase,
          resume: true,
          message: String(err?.message ?? err),
          at: Date.now(),
        });
        task.progress.stepMessage = '采集失败：需要先在小红书网页端登录（检测到登录弹窗）';
        await this.taskManager.updateStatus(task, 'failed');
        return;
      }
      if (err && (err.code === 'RATE_LIMITED' || err instanceof RateLimitError)) {
        // 频控熔断保护：优雅终止并保留已采集数据
        task.errors.push({
          code: 'RATE_LIMITED',
          phase: task.progress.phase,
          resume: true,
          message: String(err?.message ?? err),
          at: Date.now(),
        });
        task.progress.stepMessage = '触发小红书频控保护（当前笔记暂时无法浏览），已自动停止并保存当前数据';
        await this.taskManager.updateStatus(task, 'failed');
        return;
      }
      task.errors.push({
        phase: task.progress.phase,
        fatal: true,
        resume: true,
        message: String(err?.message ?? err),
        at: Date.now(),
      });
      task.progress.stepMessage = `采集失败：${err?.message ?? err}`;
      // updateStatus 会通过 saveTask 落库整个 task（含 task.errors），无需经 saveProgress 污染 progress。
      await this.taskManager.updateStatus(task, 'failed');
    } finally {
      this._cancelled.delete(task.id); // 释放取消标志，避免长生命周期 SW 中集合无限增长
      if (this._finishedEarly) this._finishedEarly.delete(task.id);
      await this._cleanupTab();
    }
  }

  async cancel(taskId) {
    const task = await this.taskManager.getTask(taskId);
    if (!task) throw new Error(`cancel: 任务 ${taskId} 不存在`);
    // 仅对 running 任务执行转移；其余状态（pending/completed/failed/cancelled）幂等返回，
    // 既避免「非法状态转移」抛错，也保证取消标志不泄漏到 _cancelled 集合。
    if (task.status !== 'running') return task;
    this._cancelled.add(taskId);
    await this._cleanupTab();
    try {
      await this.taskManager.updateStatus(task, 'cancelled');
    } catch (err) {
      this._cancelled.delete(taskId);
      throw err;
    }
    return task;
  }

  async finishEarly(taskId) {
    const task = await this.taskManager.getTask(taskId);
    if (!task) throw new Error(`finishEarly: 任务 ${taskId} 不存在`);
    if (task.status !== 'running') return task;
    this._cancelled.add(taskId);
    await this._cleanupTab();
    try {
      task.progress.phase = 'done';
      task.progress.stepMessage = `提前完成采集，已保存全部 ${task.progress.notesCollected} 篇数据`;
      await this.taskManager.saveProgress(task, { phase: 'done', stepMessage: task.progress.stepMessage });
      await this.taskManager.updateStatus(task, 'completed');
    } catch (err) {
      this._cancelled.delete(taskId);
      throw err;
    }
    return task;
  }
}
