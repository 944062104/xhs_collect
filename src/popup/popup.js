// popup.js — XHS Agent 极简 Popup 控制脚本（CLASSIC script，非模块）。
//
// 约束（来自 Task 7 规范）：
// - 扩展 popup 页面【不是】ES module，禁止顶层 import/export。
// - 所有浏览器 API 访问（document / window / chrome）必须放在 DOMContentLoaded 等
//   函数/处理器内部，保证在 Node 中 require 本文件只暴露纯函数，不执行任何浏览器代码。
// - 文件底部用 module.exports 守卫导出纯函数，供 Node 测试使用（浏览器中 module 未定义跳过）。

// 每篇笔记默认采集评论数（comments 开关开启时使用）。
const DEFAULT_COMMENTS_PER_NOTE = 20;

// 采集数量可选档位。
const NOTE_LIMITS = [10, 20, 50, 100];

// 爬取延迟可选档位（毫秒）。
const CRAWL_DELAYS = [0, 500, 1000, 2000];

// ---------------------------------------------------------------------------
// 纯函数（TDD 目标，可在 Node 中测试；无任何浏览器依赖）
// ---------------------------------------------------------------------------

// 构造 START_TASK 消息。opts = { limit=20, comments=false, format='json' }。
function buildStartMessage(keyword, opts = {}) {
  const limit = typeof opts.limit === 'number' ? opts.limit : 20;
  const comments = Boolean(opts.comments);
  const format = opts.format === 'csv' ? 'csv' : 'json';
  return {
    type: 'START_TASK',
    keyword,
    config: {
      notesLimit: limit,
      commentsPerNote: comments ? DEFAULT_COMMENTS_PER_NOTE : 0,
      outputFormat: format,
    },
  };
}

// 计算进度百分比（0–100 整数），缺失字段安全返回 0。
function progressToPercent(progress) {
  if (!progress || typeof progress !== 'object') return 0;
  const notesTotal = Number(progress.notesTotal) || 0;
  const notesCollected = Number(progress.notesCollected) || 0;
  const noteUrls = Array.isArray(progress.noteUrls) ? progress.noteUrls : [];
  const currentNoteIndex =
    typeof progress.currentNoteIndex === 'number' ? progress.currentNoteIndex : 0;

  if (notesTotal > 0) {
    return Math.round((notesCollected / notesTotal) * 100);
  }
  if (noteUrls.length > 0) {
    return Math.round(((currentNoteIndex + 1) / noteUrls.length) * 100);
  }
  return 0;
}

// 状态中文标签映射；未知状态原样返回。
function statusLabel(status) {
  const map = {
    pending: '排队中',
    running: '采集中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  };
  return Object.prototype.hasOwnProperty.call(map, status) ? map[status] : status;
}

// CSV 字段转义：数组/对象 → JSON 字符串；含逗号/引号/换行整体加引号；内部引号翻倍。
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

const CSV_COLUMNS = ['id', 'taskId', 'url', 'title', 'content', 'author', 'likes', 'tags', 'commentsCount', 'collectedAt'];

// 将笔记数组转为 CSV 字符串（含表头），与 Service Worker 列定义一致。
function notesToCsv(notes) {
  const safeNotes = Array.isArray(notes) ? notes : [];
  const rows = safeNotes.map((note) =>
    CSV_COLUMNS.map((col) => {
      if (col === 'commentsCount') {
        const list = note.commentList ?? note.comments ?? [];
        return csvField(Array.isArray(list) ? list.length : 0);
      }
      return csvField(note ? note[col] : undefined);
    }).join(',')
  );
  return [CSV_COLUMNS.join(','), ...rows].join('\n');
}

// 将笔记数组转为带缩进的 JSON 字符串。
function notesToJson(notes) {
  return JSON.stringify(Array.isArray(notes) ? notes : [], null, 2);
}

// ---------------------------------------------------------------------------
// 浏览器接线（仅在此块内访问 document / chrome）
// ---------------------------------------------------------------------------

function initPopup() {
  const $ = (id) => document.getElementById(id);

  const els = {
    keyword: $('keyword'),
    limit: $('limit'),
    startBtn: $('startBtn'),
    cancelBtn: $('cancelBtn'),
    progressBar: $('progressBar'),
    progressText: $('progressText'),
    statusText: $('statusText'),
    errorBox: $('errorBox'),
    exportJsonBtn: $('exportJsonBtn'),
    exportCsvBtn: $('exportCsvBtn'),
    advancedToggle: $('advancedToggle'),
    advancedPanel: $('advancedPanel'),
    apiKey: $('apiKey'),
    comments: $('comments'),
    delay: $('delay'),
    resetBtn: $('resetBtn'),
  };

  let taskId = null;
  let pollTimer = null;
  let crawlDelay = 0;

  // --- 配置持久化（chrome.storage.local） ---
  function loadConfig() {
    if (!chrome || !chrome.storage || !chrome.storage.local) return;
    chrome.storage.local.get(['apiKey', 'comments', 'crawlDelay', 'limit'], (cfg) => {
      if (cfg.apiKey) els.apiKey.value = cfg.apiKey;
      if (typeof cfg.comments === 'boolean') els.comments.checked = cfg.comments;
      if (typeof cfg.limit === 'number') els.limit.value = String(cfg.limit);
      if (typeof cfg.crawlDelay === 'number') {
        crawlDelay = cfg.crawlDelay;
        els.delay.value = String(cfg.crawlDelay);
      }
    });
  }

  function saveConfig() {
    if (!chrome || !chrome.storage || !chrome.storage.local) return;
    chrome.storage.local.set({
      apiKey: els.apiKey.value.trim(),
      comments: els.comments.checked,
      crawlDelay,
      limit: Number(els.limit.value) || 20,
    });
  }

  // --- 进度条 / 状态刷新 ---
  function setProgress(pct, label) {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    els.progressBar.style.width = p + '%';
    els.progressBar.setAttribute('aria-valuenow', String(p));
    els.progressText.textContent = p + '%';
    if (label != null) els.statusText.textContent = label;
  }

  function showError(msg) {
    els.errorBox.textContent = msg || '';
    els.errorBox.style.display = msg ? 'block' : 'none';
  }

  function setRunningUI(running) {
    els.startBtn.disabled = running;
    els.cancelBtn.disabled = !running;
    els.exportJsonBtn.disabled = running;
    els.exportCsvBtn.disabled = running;
  }

  // --- 轮询进度 ---
  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function pollOnce() {
    if (taskId == null) return;
    chrome.runtime.sendMessage({ type: 'GET_PROGRESS', taskId }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) return; // 任务丢失时静默忽略
      const pct = progressToPercent(resp.progress);
      setProgress(pct, statusLabel(resp.status) + `（已采集 ${resp.notesCount ?? 0} 篇）`);
      if (['completed', 'failed', 'cancelled'].includes(resp.status)) {
        stopPolling();
        setRunningUI(false);
      }
    });
  }

  function startPolling() {
    stopPolling();
    pollOnce();
    pollTimer = setInterval(pollOnce, 1000);
  }

  // --- 开始采集 ---
  function onStart() {
    showError('');
    const keyword = els.keyword.value.trim();
    if (!keyword) {
      showError('请输入采集关键词');
      els.keyword.focus();
      return;
    }
    const msg = buildStartMessage(keyword, {
      limit: Number(els.limit.value) || 20,
      comments: els.comments.checked,
      format: 'json',
    });
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        showError('与后台通信失败，请刷新页面重试');
        return;
      }
      if (!resp.ok) {
        if (resp.error === 'NO_API_KEY') {
          showError('缺少 Claude API Key，请在下方高级设置中填写');
          els.advancedPanel.classList.add('open');
          els.apiKey.focus();
        } else if (resp.error === 'TASK_ALREADY_RUNNING') {
          showError('已有采集任务在进行中');
        } else {
          showError('启动失败：' + resp.error);
        }
        return;
      }
      taskId = resp.taskId;
      setRunningUI(true);
      setProgress(0, '排队中');
      startPolling();
    });
  }

  function onCancel() {
    if (taskId == null) return;
    chrome.runtime.sendMessage({ type: 'CANCEL_TASK', taskId }, () => {
      stopPolling();
      setRunningUI(false);
      setProgress(0, '已取消');
    });
  }

  // --- 导出：经由 SW 序列化后在本地下载（纯前端下载） ---
  function downloadString(filename, mime, text) {
    if (chrome && chrome.downloads && chrome.downloads.download) {
      const dataUrl = 'data:' + mime + ';charset=utf-8,' + encodeURIComponent(text);
      chrome.downloads.download({ url: dataUrl, filename, saveAs: true });
      return;
    }
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function onExport(format) {
    if (taskId == null) {
      showError('请先执行一次采集任务');
      return;
    }
    chrome.runtime.sendMessage({ type: 'EXPORT_DATA', taskId, format }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        showError('导出失败：' + (resp ? resp.error : '通信错误'));
        return;
      }
      const mime = format === 'csv' ? 'text/csv' : 'application/json';
      downloadString(resp.filename || `xhs_${taskId}.${format}`, mime, resp.data);
    });
  }

  // --- 事件绑定 ---
  els.startBtn.addEventListener('click', onStart);
  els.cancelBtn.addEventListener('click', onCancel);
  els.exportJsonBtn.addEventListener('click', () => onExport('json'));
  els.exportCsvBtn.addEventListener('click', () => onExport('csv'));
  els.apiKey.addEventListener('change', saveConfig);
  els.comments.addEventListener('change', saveConfig);
  els.limit.addEventListener('change', saveConfig);

  els.delay.addEventListener('change', () => {
    crawlDelay = Number(els.delay.value) || 0;
    saveConfig();
  });

  // 高级抽屉折叠
  els.advancedToggle.addEventListener('click', () => {
    els.advancedPanel.classList.toggle('open');
    els.advancedToggle.parentElement.classList.toggle('open');
    const expanded = els.advancedToggle.getAttribute('aria-expanded') === 'true';
    els.advancedToggle.setAttribute('aria-expanded', String(!expanded));
  });

  // 经验库重置（清除本地存储的 API Key 与设置）
  els.resetBtn.addEventListener('click', () => {
    if (chrome && chrome.storage && chrome.storage.local) {
      chrome.storage.local.remove(['apiKey', 'comments', 'crawlDelay', 'limit'], () => {
        els.apiKey.value = '';
        els.comments.checked = false;
        els.delay.value = '0';
        showError('经验库已重置');
      });
    }
  });

  loadConfig();
}

// 浏览器中：DOM 就绪后接线。
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('DOMContentLoaded', initPopup);
}

// Node 测试入口（浏览器中 module 未定义，跳过；不影响页面运行）。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildStartMessage,
    progressToPercent,
    statusLabel,
    notesToCsv,
    notesToJson,
  };
}
