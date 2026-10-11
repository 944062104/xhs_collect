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

// 由 install() 注入（浏览器中来自全局 chrome / 真实存储，测试中来自 deps）。
let chromeApi = null;
let storage = null;
let taskManager = null;
let scraper = null; // 注入的替身；浏览器中留空，按需懒构造
let getApiKey = null;

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
      try {
        const s = scraper ?? makeScraper(await getApiKey());
        await s.resume(task);
      } catch (err) {
        console.error('[xhs] resumeRunning 失败:', err);
      } finally {
        activeRun = null;
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
  s.run(task)
    .catch((err) => console.error('[xhs] 任务执行失败:', err))
    .finally(() => {
      activeRun = null;
    });
}

async function cancelTask(msg, sendResponse) {
  try {
    const llmConfig = await resolveLlmConfig();
    const apiKey = (typeof getApiKey === 'function' ? await getApiKey() : '') || llmConfig.apiKey;
    await (scraper ?? makeScraper({ ...llmConfig, apiKey })).cancel(msg.taskId);
    sendResponse({ ok: true });
  } catch (err) {
    sendResponse({ ok: false, error: err?.message ?? 'CANCEL_FAILED' });
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

// 注：列名 commentsCount 并非 note 上的独立字段，而是由 note.commentList 的长度派生（见 toCsv）。
const CSV_COLUMNS = ['id', 'taskId', 'url', 'title', 'content', 'author', 'likes', 'tags', 'commentsCount', 'collectedAt'];

function toCsv(notes) {
  const header = CSV_COLUMNS.join(',');
  const rows = notes.map((note) =>
    CSV_COLUMNS.map((col) => {
      if (col === 'commentsCount') {
        const list = note.commentList ?? note.comments ?? [];
        return csvField(Array.isArray(list) ? list.length : 0);
      }
      return csvField(note[col]);
    }).join(',')
  );
  return [header, ...rows].join('\n');
}

async function exportData(msg, sendResponse) {
  const task = await storage.getTask(msg.taskId);
  if (!task) {
    sendResponse({ ok: false, error: 'NO_TASK' });
    return;
  }
  const notes = await storage.getNotesByTaskId(msg.taskId);
  const format = msg.format === 'csv' ? 'csv' : 'json';
  const data = format === 'csv' ? toCsv(notes) : JSON.stringify(notes, null, 2);
  sendResponse({ ok: true, format, data, filename: `xhs_${msg.taskId}.${format}` });
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
      case 'GET_PROGRESS':
        await getProgress(message, sendResponse);
        break;
      case 'EXPORT_DATA':
        await exportData(message, sendResponse);
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
  if (chromeApi?.storage?.local?.get) {
    try {
      const cfg = await new Promise((resolve) => {
        chromeApi.storage.local.get(['apiKey', 'apiBase', 'model'], resolve);
      });
      if (cfg) {
        apiKey = cfg.apiKey || '';
        apiBase = cfg.apiBase || '';
        model = cfg.model || '';
      }
    } catch (_) {
      // 忽略存储读取异常
    }
  }
  if (!apiKey) {
    apiKey = await storage.getConfig('apiKey');
  }
  return { apiKey, apiBase, model };
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
  activeRun = null;

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
