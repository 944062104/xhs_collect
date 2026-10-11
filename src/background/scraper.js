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
    selRoot = patterns?.[platformKey]?.patterns?.selectors;
  }
  if (!selRoot) return [];
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
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
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

  // 浏览器环境可默认从扩展包读取 config/site-patterns.json；测试直接注入 patterns。
  async _ensurePatterns() {
    if (this.patterns) return this.patterns;
    const url =
      globalThis.chrome?.runtime?.getURL &&
      globalThis.chrome.runtime.getURL('config/site-patterns.json');
    if (!url) {
      throw new Error('Scraper: 未注入 patterns，且无法定位默认 site-patterns.json（请用 new Scraper({ patterns }) 注入）');
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`加载 site-patterns.json 失败: HTTP ${res.status}`);
    this.patterns = await res.json();
    return this.patterns;
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

  // 复用（或新建）标签页并导航到 url，返回 tabId。
  async _navigate(url) {
    if (this.tabs == null) throw new Error('Scraper: 未注入 tabs（chrome.tabs）');
    if (this._tabId != null) {
      await this.tabs.update(this._tabId, { url });
      return this._tabId;
    }
    const tab = await this.tabs.create({ url });
    this._tabId = tab.id;
    return this._tabId;
  }

  // 向 content-script 发消息；ok===false 时抛错（交由上层容错处理）。
  async _send(tabId, msg) {
    const res = await this.tabs.sendMessage(tabId, msg);
    if (!res || res.ok === false) {
      throw new Error(`content script 返回错误: ${res?.error || 'NO_RESPONSE'} (action=${msg.action})`);
    }
    return res;
  }

  // 防封控随机停顿：计算 2~5s 延迟，再 await 注入的 sleep。
  async _randomPause() {
    const delay = MIN_PAUSE_MS + Math.floor(Math.random() * (MAX_PAUSE_MS - MIN_PAUSE_MS + 1));
    await this.sleep(delay);
  }

  // ---- 搜索阶段 ----------------------------------------------------------

  async _searchPhase(task) {
    const url = this._searchUrl(task.keyword);
    const tabId = await this._navigate(url);
    await this._send(tabId, {
      action: 'waitFor',
      selectors: this._sel('search.feedsContainer'),
      timeout: 10000,
    });

    const limit = task.config.notesLimit;
    while (task.progress.noteUrls.length < limit && task.progress.scrollCount < MAX_SEARCH_SCROLLS) {
      this._throwIfCancelled(task.id);
      await this._send(tabId, { action: 'scroll', distance: 600, duration: 800 });
      task.progress.scrollCount += 1;
      const html = (
        await this._send(tabId, { action: 'getHTML', selectors: this._sel('search.feedsContainer') })
      ).data;
      const list = await this.llm.extractNoteList(html);
      for (const item of list) {
        if (item && item.url && !task.progress.noteUrls.includes(item.url)) {
          task.progress.noteUrls.push(item.url);
        }
      }
      // CHECKPOINT：每轮滚动后保存已采集的 URL 列表，保证断点可恢复。
      await this.taskManager.saveProgress(task, {
        noteUrls: task.progress.noteUrls,
        scrollCount: task.progress.scrollCount,
      });
      await this._randomPause();
    }

    task.progress.notesTotal = task.progress.noteUrls.length;
    await this.taskManager.saveProgress(task, { notesTotal: task.progress.notesTotal });
  }

  // ---- 详情 + 评论阶段 ---------------------------------------------------

  async _detailPhase(task) {
    task.progress.phase = 'collectingNotes';
    await this.taskManager.saveProgress(task, { phase: 'collectingNotes' });

    // 关键：从 currentNoteIndex+1 开始（run 起始为 -1，故首条为 0）。
    // resume 时 task.progress.currentNoteIndex 已指向最后成功采集的索引，因此自动跳过已处理项。
    const start = task.progress.currentNoteIndex + 1;
    for (let i = start; i < task.progress.noteUrls.length; i++) {
      this._throwIfCancelled(task.id);
      const url = task.progress.noteUrls[i];
      try {
        const tabId = await this._navigate(url);
        await this._send(tabId, {
          action: 'waitFor',
          selectors: this._sel('noteDetail.container'),
          timeout: 8000,
        });
        const detailHtml = (
          await this._send(tabId, { action: 'getHTML', selectors: this._sel('noteDetail.container') })
        ).data;
        const detail = await this.llm.extractNoteDetail(detailHtml);

        const commentsHtml = (
          await this._send(tabId, { action: 'getHTML', selectors: this._sel('noteDetail.commentSection') })
        ).data;
        const comments = await this.llm.extractComments(commentsHtml);

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
        await this.taskManager.saveProgress(task, {
          currentNoteIndex: task.progress.currentNoteIndex,
          notesCollected: task.progress.notesCollected,
          commentsCollected: task.progress.commentsCollected,
        });

        await this._send(tabId, { action: 'closeModal' });
        await this._randomPause();
      } catch (err) {
        // 单条失败：记录错误，将 currentNoteIndex 推进到本索引（标记已处理，避免 resume 时死重试），继续后续。
        task.errors.push({
          index: i,
          url,
          phase: 'collectingNotes',
          message: String(err?.message ?? err),
          at: Date.now(),
        });
        task.progress.currentNoteIndex = i;
        await this.taskManager.saveProgress(task, {
          currentNoteIndex: task.progress.currentNoteIndex,
          errors: task.errors,
        });
        continue;
      }
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
      if (err && err.isCancellation) return; // 取消：保持 cancelled 状态，不记为失败
      task.errors.push({
        phase: task.progress.phase,
        fatal: true,
        message: String(err?.message ?? err),
        at: Date.now(),
      });
      await this.taskManager.saveProgress(task, { errors: task.errors });
      await this.taskManager.updateStatus(task, 'failed');
    }
  }

  async resume(task) {
    await this._ensurePatterns();
    try {
      if (task.status !== 'running') {
        await this.taskManager.updateStatus(task, 'running');
      }
      // noteUrls 为空说明搜索阶段未完成，先补完搜索；否则直接进入详情阶段从断点继续。
      if (!task.progress.noteUrls || task.progress.noteUrls.length === 0) {
        await this._searchPhase(task);
      }
      await this._detailPhase(task);

      task.progress.phase = 'done';
      await this.taskManager.saveProgress(task, { phase: 'done' });
      await this.taskManager.updateStatus(task, 'completed');
    } catch (err) {
      if (err && err.isCancellation) return; // 取消：保持 cancelled 状态，不记为失败
      task.errors.push({
        phase: task.progress.phase,
        fatal: true,
        resume: true,
        message: String(err?.message ?? err),
        at: Date.now(),
      });
      await this.taskManager.saveProgress(task, { errors: task.errors });
      await this.taskManager.updateStatus(task, 'failed');
    }
  }

  async cancel(taskId) {
    this._cancelled.add(taskId);
    const task = await this.taskManager.getTask(taskId);
    if (!task) throw new Error(`cancel: 任务 ${taskId} 不存在`);
    await this.taskManager.updateStatus(task, 'cancelled');
    return task;
  }
}
