// service-worker.js — XHS Agent 后台 Service Worker 生命周期与任务调度中枢。
//
// 设计约束（与仓库其它 background 模块一致）：
// - ESM（manifest 中 background.service_worker + type:"module"）。
// - 直接引用全局 chrome（浏览器注入；测试通过 install({chromeApi}) 注入替身）。
// - 依赖注入：StorageManager / TaskManager / Scraper / LLMClient 均可注入，便于 TDD。
//
// 关键行为：
//   1. 注册 25s keepalive 闹钟，避免 MV3 Service Worker 被过早回收。
//   2. 闹钟触发时发轻量保活 ping，并对仍处于 running 的任务执行 resume（断点续传）。
//   3. 监听 Popup 消息：START_TASK / CANCEL_TASK / GET_PROGRESS / EXPORT_DATA。

import { StorageManager } from './storage.js';
import { TaskManager } from './task-manager.js';
import { Scraper } from './scraper.js';
import { LLMClient } from './llm-client.js';

// 模块级重入守卫：同一时刻只允许一个 run / resume 在执行（防止闹钟续传与 START_TASK 并发，也防止两个 START_TASK 叠跑）。
let activeRun = null;
let activeScraper = null; // 真实运行中正在执行任务的 Scraper 实例

// 由 install() 注入（浏览器中来自全局 chrome / 真实存储，测试中来自 deps）。
let chromeApi = null;
let storage = null;
let taskManager = null;
let scraper = null; // 注入的替身；浏览器中留空，按需懒构造
let getApiKey = null;
let llmClient = null; // 测试可注入替身

// 浏览器环境懒构造 Scraper：每次任务都用【最新】存储的 apiKey、apiBase、model 与 chrome.tabs。
function makeScraper(llmConfig) {
  const config = typeof llmConfig === 'object' && llmConfig !== null ? llmConfig : { apiKey: llmConfig };
  const llm = new LLMClient(config);
  return new Scraper({ storage, llm, patterns: null, tabs: chromeApi.tabs });
}

// 闹钟唤醒时续传仍在 running 的任务；activeRun 守卫避免与 START_TASK 并发执行。
function resumeRunning() {
  return (async () => {
    const task = await storage.getRunningTask();
    if (task && !activeRun) {
      activeRun = task.id;
      const s = scraper ?? makeScraper(await getApiKey());
      activeScraper = s;
      try {
        await s.resume(task);
      } catch (err) {
        console.error('[xhs] resumeRunning 失败:', err);
      } finally {
        activeRun = null;
        if (activeScraper === s) activeScraper = null;
      }
    }
  })();
}

function handleAlarm(alarm) {
  if (!alarm || alarm.name !== 'keepalive') return;
  // 轻量保活 ping：触发一次无副作用的运行时调用。注意：MV3 中事件处理函数返回后 SW 仍可能休眠，
  // 因此真正可靠的保活网是「闹钟周期性唤醒 → resumeRunning」，本 ping 仅作辅助。
  try {
    chromeApi.runtime?.getPlatformInfo?.(() => {});
  } catch (_) {
    /* 某些环境可能不支持，忽略 */
  }
  return resumeRunning();
}

async function startTask(msg, sendResponse) {
  const llmConfig = await resolveLlmConfig();
  const apiKey = (typeof getApiKey === 'function' ? await getApiKey() : '') || llmConfig.apiKey;
  if (!apiKey) {
    sendResponse({ ok: false, error: 'NO_API_KEY' });
    return;
  }
  // 重入守卫：若已有采集在进行，拒绝新任务（单任务模型，避免两条 Scraper 并发）。
  if (activeRun) {
    sendResponse({ ok: false, error: 'TASK_ALREADY_RUNNING' });
    return;
  }

  const task = await taskManager.createTask(msg.keyword, msg.config || {});
  // 立即回复 Popup，采集在后台异步进行（不阻塞消息通道）。
  sendResponse({ ok: true, taskId: task.id });

  activeRun = task.id;
  const s = scraper ?? makeScraper({ ...llmConfig, apiKey });
  activeScraper = s;
  s.run(task)
    .catch((err) => console.error('[xhs] 任务执行失败:', err))
    .finally(() => {
      activeRun = null;
      if (activeScraper === s) activeScraper = null;
    });
}

async function cancelTask(msg, sendResponse) {
  try {
    const taskId = msg.taskId || activeRun;
    if (!taskId) {
      sendResponse({ ok: true });
      return;
    }
    const currentScraper = activeScraper ?? scraper;
    if (currentScraper && typeof currentScraper.cancel === 'function') {
      await currentScraper.cancel(taskId);
    } else {
      const llmConfig = await resolveLlmConfig();
      const apiKey = (typeof getApiKey === 'function' ? await getApiKey() : '') || llmConfig.apiKey;
      await makeScraper({ ...llmConfig, apiKey }).cancel(taskId);
    }
    activeRun = null;
    activeScraper = null;
    sendResponse({ ok: true });
  } catch (err) {
    sendResponse({ ok: false, error: err?.message ?? 'CANCEL_FAILED' });
  }
}

async function finishEarlyTask(msg, sendResponse) {
  try {
    const taskId = msg.taskId || activeRun;
    if (!taskId) {
      sendResponse({ ok: false, error: 'NO_TASK' });
      return;
    }
    const currentScraper = activeScraper ?? scraper;
    if (currentScraper && typeof currentScraper.finishEarly === 'function') {
      await currentScraper.finishEarly(taskId);
    } else {
      const task = await storage.getTask(taskId);
      if (task && task.status === 'running') {
        task.status = 'completed';
        task.completedAt = Date.now();
        await storage.saveTask(task);
      }
    }
    activeRun = null;
    activeScraper = null;
    sendResponse({ ok: true, taskId });
  } catch (err) {
    sendResponse({ ok: false, error: err?.message ?? 'FINISH_EARLY_FAILED' });
  }
}

async function getProgress(msg, sendResponse) {
  const task = msg.taskId ? await storage.getTask(msg.taskId) : await storage.getRunningTask();
  if (!task) {
    sendResponse({ ok: false, error: 'NO_TASK' });
    return;
  }
  const notes = await storage.getNotesByTaskId(task.id);
  sendResponse({
    ok: true,
    status: task.status,
    progress: task.progress,
    notesCount: notes.length,
    errors: task.errors || [],
  });
}

// CSV 字段转义：含逗号 / 引号 / 换行时整体用双引号包裹，内部引号翻倍。
function csvField(value) {
  if (value == null) return '';
  let s;
  if (Array.isArray(value) || typeof value === 'object') {
    s = JSON.stringify(value);
  } else {
    s = String(value);
  }
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// 注：列名 commentsCount 优先取 note.totalComments，次选 note.commentList 的长度派生。
const CSV_COLUMNS = [
  'id',
  'taskId',
  'url',
  'title',
  'content',
  'author',
  'authorId',
  'likes',
  'collects',
  'commentsCount',
  'publishedAt',
  'coverUrl',
  'tags',
  'collectedAt',
];

function formatCsvDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  const pad = (n) => String(n).padStart(2, '0');
  const Y = d.getFullYear();
  const M = pad(d.getMonth() + 1);
  const D = pad(d.getDate());
  const h = pad(d.getHours());
  const m = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  return `${Y}-${M}-${D} ${h}:${m}:${s}`;
}

function toCsv(notes) {
  const header = CSV_COLUMNS.join(',');
  const rows = notes.map((note) =>
    CSV_COLUMNS.map((col) => {
      if (col === 'commentsCount') {
        if (typeof note.totalComments === 'number' && note.totalComments > 0) {
          return csvField(note.totalComments);
        }
        const list = note.commentList ?? note.comments ?? [];
        return csvField(Array.isArray(list) ? list.length : (note.commentsCount ?? 0));
      }
      if (col === 'tags') {
        if (Array.isArray(note.tags)) {
          return csvField(note.tags.join(', '));
        }
        return csvField(note.tags);
      }
      if (col === 'collectedAt') {
        if (typeof note.collectedAt === 'number' && note.collectedAt > 1e11) {
          return csvField(formatCsvDateTime(note.collectedAt));
        }
        return csvField(note.collectedAt);
      }
      return csvField(note[col]);
    }).join(',')
  );
  return [header, ...rows].join('\n');
}


const COMMENT_CSV_COLUMNS = [
  'noteId',
  'noteTitle',
  'noteUrl',
  'commentAuthor',
  'isAuthor',
  'commentContent',
  'commentLikes',
  'commentLocation',
  'commentLevel',
  'commentTime',
];

function toCommentsCsv(notes) {
  const header = COMMENT_CSV_COLUMNS.join(',');
  const rows = [];
  for (const note of (notes || [])) {
    const comments = note.commentList ?? note.comments ?? [];
    if (Array.isArray(comments)) {
      const seen = new Set();
      for (const c of comments) {
        const text = String(c.content ?? c.text ?? '').trim();
        const author = String(c.author ?? '').trim();
        const key = `${author}::${text}`;
        if (seen.has(key)) continue;
        seen.add(key);

        rows.push([
          csvField(note.id),
          csvField(note.title),
          csvField(note.url),
          csvField(author || '匿名用户'),
          csvField(c.isAuthor ? '是' : '否'),
          csvField(text),
          csvField(c.likes ?? 0),
          csvField(c.location || ''),
          csvField(c.level === 'reply' ? '楼中楼' : '主评'),
          csvField(c.publishedAt ?? c.time ?? ''),
        ].join(','));
      }
    }
  }
  return [header, ...rows].join('\n');
}

async function exportData(msg, sendResponse) {
  const task = await storage.getTask(msg.taskId);
  if (!task) {
    sendResponse({ ok: false, error: 'NO_TASK' });
    return;
  }
  const notes = await storage.getNotesByTaskId(msg.taskId);
  let format = msg.format;
  let data;
  let filename;
  if (format === 'comments_csv') {
    data = toCommentsCsv(notes);
    filename = `xhs_${msg.taskId}_comments.csv`;
  } else if (format === 'csv') {
    data = toCsv(notes);
    filename = `xhs_${msg.taskId}.csv`;
  } else {
    format = 'json';
    data = JSON.stringify(notes, null, 2);
    filename = `xhs_${msg.taskId}.json`;
  }
  sendResponse({ ok: true, format, data, filename });
}

async function testLlmConfig(msg, sendResponse) {
  const llmConfig = await resolveLlmConfig();
  const apiKey = msg.apiKey || llmConfig.apiKey;
  const apiBase = msg.apiBase || llmConfig.apiBase;
  const model = msg.model || llmConfig.model;
  const protocol = msg.protocol || llmConfig.protocol || 'auto';
  if (!apiKey) {
    sendResponse({ ok: false, error: 'NO_API_KEY' });
    return;
  }
  try {
    const client = new LLMClient({ apiKey, apiBase, model, protocol });
    const res = await client.testConnection();
    sendResponse(res);
  } catch (err) {
    sendResponse({ ok: false, error: err?.message || 'TEST_FAILED' });
  }
}

async function getLatestTask(sendResponse) {
  try {
    const running = await storage.getRunningTask();
    const task = running || (await storage.getLatestTask());
    if (!task) {
      sendResponse({ ok: true, task: null, notes: [] });
      return;
    }
    const notes = await storage.getNotesByTaskId(task.id);
    sendResponse({
      ok: true,
      task,
      notes: Array.isArray(notes) ? notes.slice(-10).reverse() : [],
    });
  } catch (err) {
    sendResponse({ ok: false, error: err?.message || 'GET_LATEST_FAILED' });
  }
}

async function resetTask(sendResponse) {
  try {
    const currentScraper = activeScraper ?? scraper;
    if (activeRun && currentScraper && typeof currentScraper.cancel === 'function') {
      await currentScraper.cancel(activeRun).catch(() => {});
    }
    activeRun = null;
    activeScraper = null;
    sendResponse({ ok: true });
  } catch (err) {
    sendResponse({ ok: false, error: err?.message || 'RESET_FAILED' });
  }
}

async function getTaskHistory(msg, sendResponse) {
  try {
    const limit = typeof msg?.limit === 'number' ? msg.limit : 50;
    const tasks = await storage.getAllTasks(limit);
    sendResponse({ ok: true, tasks });
  } catch (err) {
    sendResponse({ ok: false, error: err?.message || 'GET_HISTORY_FAILED' });
  }
}

async function getAllNotes(msg, sendResponse) {
  try {
    const limit = typeof msg?.limit === 'number' ? msg.limit : 500;
    const notes = await storage.getAllNotes(limit);
    sendResponse({ ok: true, notes });
  } catch (err) {
    sendResponse({ ok: false, error: err?.message || 'GET_NOTES_FAILED' });
  }
}

async function exportAllData(msg, sendResponse) {
  try {
    const notes = await storage.getAllNotes(5000);
    let format = msg.format;
    let data;
    let filename;
    if (format === 'comments_csv') {
      data = toCommentsCsv(notes);
      filename = 'xhs_all_comments.csv';
    } else if (format === 'csv') {
      data = toCsv(notes);
      filename = 'xhs_all_notes.csv';
    } else {
      format = 'json';
      data = JSON.stringify(notes, null, 2);
      filename = 'xhs_all_notes.json';
    }
    sendResponse({ ok: true, format, data, filename });
  } catch (err) {
    sendResponse({ ok: false, error: err?.message || 'EXPORT_ALL_FAILED' });
  }
}

// 递归展平规则对象为 path -> selectors 映射
function flattenSelectors(obj, prefix = '') {
  const res = {};
  for (const k of Object.keys(obj || {})) {
    if (k === 'metadata') continue;
    const path = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(obj[k])) {
      res[path] = obj[k];
    } else if (obj[k] && typeof obj[k] === 'object') {
      Object.assign(res, flattenSelectors(obj[k], path));
    }
  }
  return res;
}

// 根据沙箱验证报告过滤规则树，剔除有效度为 0 的假规则
function filterVerifiedRules(obj, report, prefix = '') {
  const out = {};
  for (const k of Object.keys(obj || {})) {
    if (k === 'metadata') continue;
    const path = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(obj[k])) {
      if (report[path] && report[path].valid) {
        out[k] = obj[k];
      }
    } else if (obj[k] && typeof obj[k] === 'object') {
      const nested = filterVerifiedRules(obj[k], report, path);
      if (Object.keys(nested).length > 0) {
        out[k] = nested;
      }
    }
  }
  return out;
}

// 借鉴 web-access 思想：主动截取当前小红书标签页 HTML，交由大模型自动提取稳定选择器并经沙箱回测后沉淀到本地
async function handleLearnSitePatterns(msg, sendResponse) {
  try {
    const llmConfig = await resolveLlmConfig();
    const apiKey = (typeof getApiKey === 'function' ? await getApiKey() : '') || llmConfig.apiKey;
    if (!apiKey) {
      sendResponse({ ok: false, error: 'NO_API_KEY' });
      return;
    }

    let targetTabId = msg.tabId;
    let targetTabUrl = '';
    if (!targetTabId && chromeApi?.tabs?.query) {
      const xhsTabs = await new Promise((resolve) => {
        chromeApi.tabs.query({ url: '*://*.xiaohongshu.com/*' }, resolve);
      });
      if (xhsTabs && xhsTabs.length > 0) {
        // 优先在包含 search_result 的搜索页或当前激活标签
        const searchTab = xhsTabs.find((t) => t.url && t.url.includes('search_result'));
        const activeXhs = xhsTabs.find((t) => t.active) || searchTab || xhsTabs[0];
        targetTabId = activeXhs.id;
        targetTabUrl = activeXhs.url || '';
      } else {
        const curTabs = await new Promise((resolve) => {
          chromeApi.tabs.query({ active: true, currentWindow: true }, resolve);
        });
        if (curTabs && curTabs[0]) {
          targetTabId = curTabs[0].id;
          targetTabUrl = curTabs[0].url || '';
        }
      }
    }

    let html = msg.html;
    let isSkeleton = false;
    if (!html && targetTabId && chromeApi?.tabs?.sendMessage) {
      try {
        const domResp = await new Promise((resolve) => {
          chromeApi.tabs.sendMessage(
            targetTabId,
            { action: 'getHTML', selectors: ['body'], targetType: msg.targetType || 'search', expandFilter: true },
            (res) => {
              if (chromeApi.runtime?.lastError) resolve(null);
              else resolve(res);
            }
          );
        });
        if (domResp && domResp.ok && domResp.data) {
          html = domResp.data;
          isSkeleton = Boolean(domResp.isSkeleton);
        }
      } catch (_) {}
    }

    if (!html) {
      sendResponse({
        ok: false,
        error: 'NO_HTML_FOUND',
        message: '无法获取小红书页面 DOM。请确保当前浏览器打开了小红书页面（例如搜索页），并刷新一次该页面后再点击学习。',
      });
      return;
    }

    const client = llmClient ?? new LLMClient({ ...llmConfig, apiKey });
    const startTime = Date.now();
    const learned = await client.learnSitePatterns(html, msg.targetType || 'all');
    if (!learned || typeof learned !== 'object') {
      sendResponse({ ok: false, error: 'LEARN_FAILED', message: '模型未能识别出有效选择器规则' });
      return;
    }

    // 沙箱回测：通知 Content Script 在真实 DOM 中测试选择器命中度
    let verifyReport = {};
    if (targetTabId && chromeApi?.tabs?.sendMessage) {
      try {
        const candidates = flattenSelectors(learned);
        const probeResp = await new Promise((resolve) => {
          chromeApi.tabs.sendMessage(targetTabId, { action: 'verifySelectors', candidates }, (res) => {
            if (chromeApi.runtime?.lastError) resolve(null);
            else resolve(res);
          });
        });
        if (probeResp && probeResp.ok && probeResp.results) {
          verifyReport = probeResp.results;
        }
      } catch (_) {}
    }

    // 过滤掉命中数为 0 的假规则
    const verifiedLearned = Object.keys(verifyReport).length > 0 ? filterVerifiedRules(learned, verifyReport) : learned;

    // 沉淀到 IndexedDB 的 Site Experience Store，附带元数据
    const oldPatterns = (await storage.getConfig('dynamic_site_patterns')) || {};
    const merged = { ...oldPatterns, ...verifiedLearned };
    merged.metadata = {
      lastLearnedAt: Date.now(),
      report: verifyReport,
    };
    await storage.saveConfig('dynamic_site_patterns', merged);

    // 构造全透明调试元数据
    const debug = {
      tabId: targetTabId,
      tabUrl: targetTabUrl,
      htmlLength: html.length,
      isSkeleton: isSkeleton,
      htmlPreview: html.slice(0, 1500),
      rawLearned: learned,
      durationMs: Date.now() - startTime,
    };

    sendResponse({ ok: true, patterns: merged, report: verifyReport, debug });
  } catch (err) {
    sendResponse({ ok: false, error: err?.message || 'LEARN_ERROR' });
  }
}

async function handleVerifyDynamicPatterns(msg, sendResponse) {
  try {
    const patterns = await storage.getConfig('dynamic_site_patterns');
    if (!patterns || typeof patterns !== 'object') {
      sendResponse({ ok: true, report: {}, message: '暂未沉淀动态规则' });
      return;
    }

    let targetTabId = msg.tabId;
    if (!targetTabId && chromeApi?.tabs?.query) {
      const curTabs = await new Promise((resolve) => {
        chromeApi.tabs.query({ active: true, currentWindow: true }, resolve);
      });
      if (curTabs && curTabs[0]) targetTabId = curTabs[0].id;
    }

    if (!targetTabId || !chromeApi?.tabs?.sendMessage) {
      sendResponse({ ok: false, error: 'NO_ACTIVE_TAB', message: '未找到可供测试的活动标签页' });
      return;
    }

    const candidates = flattenSelectors(patterns);
    const probeResp = await new Promise((resolve) => {
      chromeApi.tabs.sendMessage(targetTabId, { action: 'verifySelectors', candidates }, (res) => {
        if (chromeApi.runtime?.lastError) resolve(null);
        else resolve(res);
      });
    });

    if (!probeResp || !probeResp.ok || !probeResp.results) {
      sendResponse({ ok: false, error: 'PROBE_FAILED', message: '探针测试失败或未连接到页面' });
      return;
    }

    patterns.metadata = patterns.metadata || {};
    patterns.metadata.report = probeResp.results;
    patterns.metadata.lastVerifiedAt = Date.now();
    await storage.saveConfig('dynamic_site_patterns', patterns);

    sendResponse({ ok: true, report: probeResp.results });
  } catch (err) {
    sendResponse({ ok: false, error: err?.message || 'VERIFY_ERROR' });
  }
}

async function handleResetDynamicPatterns(sendResponse) {
  try {
    await storage.saveConfig('dynamic_site_patterns', null);
    sendResponse({ ok: true });
  } catch (err) {
    sendResponse({ ok: false, error: err?.message || 'RESET_ERROR' });
  }
}

async function handleDeleteTasks(message, sendResponse) {
  try {
    const rawIds = Array.isArray(message.taskIds) ? message.taskIds : (message.taskId ? [message.taskId] : []);
    const validIds = rawIds.filter((id) => typeof id === 'string' && id.trim().length > 0);
    if (validIds.length === 0) {
      sendResponse({ ok: true, deletedCount: 0, skippedRunningCount: 0 });
      return;
    }

    // 检查并过滤掉处于 running 状态的任务，以防破坏正在进行的爬取
    const runningTask = await storage.getRunningTask();
    const runningId = runningTask ? runningTask.id : null;

    const toDeleteIds = [];
    let skippedRunningCount = 0;
    for (const id of validIds) {
      if (id === runningId) {
        skippedRunningCount += 1;
      } else {
        toDeleteIds.push(id);
      }
    }

    const deletedCount = await storage.deleteTasks(toDeleteIds);
    sendResponse({ ok: true, deletedCount, skippedRunningCount });
  } catch (err) {
    sendResponse({ ok: false, error: err?.message || 'DELETE_ERROR' });
  }
}

// 统一的消息入口：处理逻辑为 async 函数，返回 Promise，便于单元测试与 await。
async function handleMessage(message, _sender, sendResponse) {
  if (!message || !message.type) {
    sendResponse({ ok: false, error: 'INVALID_MESSAGE' });
    return true;
  }
  try {
    switch (message.type) {
      case 'START_TASK':
        await startTask(message, sendResponse);
        break;
      case 'CANCEL_TASK':
        await cancelTask(message, sendResponse);
        break;
      case 'FINISH_EARLY_TASK':
        await finishEarlyTask(message, sendResponse);
        break;
      case 'GET_PROGRESS':
        await getProgress(message, sendResponse);
        break;
      case 'EXPORT_DATA':
        await exportData(message, sendResponse);
        break;
      case 'TEST_LLM_CONFIG':
        await testLlmConfig(message, sendResponse);
        break;
      case 'GET_LATEST_TASK':
        await getLatestTask(sendResponse);
        break;
      case 'RESET_TASK':
        await resetTask(sendResponse);
        break;
      case 'GET_TASK_HISTORY':
        await getTaskHistory(message, sendResponse);
        break;
      case 'GET_ALL_NOTES':
        await getAllNotes(message, sendResponse);
        break;
      case 'EXPORT_ALL_DATA':
        await exportAllData(message, sendResponse);
        break;
      case 'LEARN_SITE_PATTERNS':
        await handleLearnSitePatterns(message, sendResponse);
        break;
      case 'VERIFY_DYNAMIC_PATTERNS':
        await handleVerifyDynamicPatterns(message, sendResponse);
        break;
      case 'RESET_DYNAMIC_PATTERNS':
        await handleResetDynamicPatterns(sendResponse);
        break;
      case 'DELETE_TASKS':
        await handleDeleteTasks(message, sendResponse);
        break;
      default:
        sendResponse({ ok: false, error: 'UNKNOWN_TYPE' });
    }
  } catch (err) {
    sendResponse({ ok: false, error: err?.message ?? 'INTERNAL_ERROR' });
  }
  return true;
}

// 统一读取 LLM 配置：优先从 chrome.storage.local（Popup 写入处），兜底从 IndexedDB
async function resolveLlmConfig() {
  let apiKey = '';
  let apiBase = '';
  let model = '';
  let protocol = 'auto';
  if (chromeApi?.storage?.local?.get) {
    try {
      const cfg = await new Promise((resolve) => {
        chromeApi.storage.local.get(['apiKey', 'apiBase', 'model', 'protocol'], resolve);
      });
      if (cfg) {
        apiKey = cfg.apiKey || '';
        apiBase = cfg.apiBase || '';
        model = cfg.model || '';
        protocol = cfg.protocol || 'auto';
      }
    } catch (_) {
      // 忽略存储读取异常
    }
  }
  if (!apiKey) {
    apiKey = await storage.getConfig('apiKey');
  }
  return { apiKey, apiBase, model, protocol };
}

// 供向下兼容与外部依赖注入
async function resolveApiKey() {
  const cfg = await resolveLlmConfig();
  return cfg.apiKey;
}

export function install(deps = {}) {
  chromeApi = deps.chromeApi ?? globalThis.chrome;
  storage = deps.storage ?? new StorageManager();
  taskManager = deps.taskManager ?? new TaskManager(storage);
  scraper = deps.scraper ?? null; // 注入的替身；浏览器中留空，按需懒构造
  getApiKey = deps.getApiKey ?? resolveApiKey;
  llmClient = deps.llmClient ?? null;
  activeRun = null;
  activeScraper = null;

  if (!chromeApi) {
    throw new Error('install: 缺少 chromeApi（浏览器中应为全局 chrome）');
  }

  // 注册 25 秒 keepalive 闹钟。
  // 注意：生产环境 Chrome 要求 periodInMinutes >= 0.5（即 30s），25s 仅用于开发调试；
  // 生产构建需改为 0.5 或更高，否则该闹钟会被浏览器忽略。
  chromeApi.alarms.create('keepalive', { periodInMinutes: 25 / 60 });

  chromeApi.alarms.onAlarm.addListener(handleAlarm);

  // Chrome MV3 消息通道适配器：真实 Chrome 中异步调用 sendResponse 必须【同步返回字面量 true】！
  // 任何返回 Promise、undefined 或其它值的函数都会导致 Chrome 原生通信端口当即关闭，
  // 从而在前端抛出: "The message port closed before a response was received."
  const listenerAdapter = (message, sender, sendResponse) => {
    const promise = handleMessage(message, sender, sendResponse);
    listenerAdapter._lastPromise = promise;
    return true; // 必须是字面量 true
  };
  chromeApi.runtime.onMessage.addListener(listenerAdapter);
}

// 浏览器自动启动；测试通过 globalThis.__XHS_NO_AUTOINSTALL__ 阻止。
if (!globalThis.__XHS_NO_AUTOINSTALL__) {
  install();
}
