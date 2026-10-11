// popup.js — XHS Agent 极简 Popup 控制脚本（CLASSIC script，非模块）。
//
// 约束（来自 Task 7 规范）：
// - 扩展 popup 页面【不是】ES module，禁止顶层 import/export。
// - 所有浏览器 API 访问（document / window / chrome）必须放在 DOMContentLoaded 等
//   函数/处理器内部，保证在 Node 中 require 本文件只暴露纯函数，不执行任何浏览器代码。
// - 文件底部用 module.exports 守卫导出纯函数，供 Node 测试使用（浏览器中 module 未定义跳过）。

// 每篇笔记默认采集评论数（comments 开关开启时使用）。
const DEFAULT_COMMENTS_PER_NOTE = 20;

// ---------------------------------------------------------------------------
// 纯函数（TDD 目标，可在 Node 中测试；无任何浏览器依赖）
// ---------------------------------------------------------------------------

// 构造 START_TASK 消息。opts = { limit=20, comments=false, format='json', crawlDelay=0 }。
function buildStartMessage(keyword, opts = {}) {
  const limit = typeof opts.limit === 'number' ? opts.limit : 20;
  const comments = Boolean(opts.comments);
  const format = opts.format === 'csv' ? 'csv' : 'json';
  const crawlDelay = typeof opts.crawlDelay === 'number' ? opts.crawlDelay : 0;
  return {
    type: 'START_TASK',
    keyword,
    config: {
      notesLimit: limit,
      commentsPerNote: comments ? DEFAULT_COMMENTS_PER_NOTE : 0,
      outputFormat: format,
      crawlDelay,
    },
  };
}

// 计算进度百分比（0–100 整数），缺失字段安全返回 0；结果钳制在 0–100 防止越界。
function progressToPercent(progress) {
  if (!progress || typeof progress !== 'object') return 0;
  const notesTotal = Number(progress.notesTotal) || 0;
  const notesCollected = Number(progress.notesCollected) || 0;
  const noteUrls = Array.isArray(progress.noteUrls) ? progress.noteUrls : [];
  const currentNoteIndex =
    typeof progress.currentNoteIndex === 'number' ? progress.currentNoteIndex : 0;

  let pct = 0;
  if (notesTotal > 0) {
    pct = (notesCollected / notesTotal) * 100;
  } else if (noteUrls.length > 0) {
    pct = ((currentNoteIndex + 1) / noteUrls.length) * 100;
  }
  return Math.max(0, Math.min(100, Math.round(pct)));
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

// 判断进度响应是否表示「未登录拦截」：后端在 task.errors 中写入 code:AUTH_REQUIRED。
// 纯函数，便于测试；浏览器轮询与启动失败路径复用。
function isAuthRequired(resp) {
  if (!resp || !resp.ok) return false;
  return Array.isArray(resp.errors) && resp.errors.some((e) => e && e.code === 'AUTH_REQUIRED');
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

// 辅助：HTML 字符串实体转义
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 组合格式化详细状态描述
function formatDetailStatus(resp) {
  if (!resp) return '待命';
  const label = statusLabel(resp.status);
  const step = resp.progress?.stepMessage;
  if (step && resp.status === 'running') {
    return `${label} · ${step}`;
  }
  const count = resp.notesCount ?? resp.progress?.notesCollected ?? 0;
  if (resp.status === 'completed') {
    return `${label}（共采集 ${count} 篇）`;
  }
  return `${label}（已采集 ${count} 篇）`;
}

// 生成单条笔记预览条目的 HTML 片段
function renderNotePreviewRow(note) {
  if (!note) return '';
  const title = escapeHtml(note.title || '（无标题）');
  const author = escapeHtml(note.author || '未知作者');
  const likes = Number(note.likes) || 0;
  const url = escapeHtml(note.url || '#');
  return `
    <div class="note-item">
      <div class="note-main">
        <a class="note-title" href="${url}" target="_blank" title="${title}">${title}</a>
        <div class="note-sub">
          <span class="note-author">👤 ${author}</span>
          <span class="note-likes">❤️ ${likes} 赞</span>
        </div>
      </div>
    </div>
  `.trim();
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
    apiBase: $('apiBase'),
    model: $('model'),
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
    chrome.storage.local.get(['apiBase', 'model', 'apiKey', 'comments', 'crawlDelay', 'limit'], (cfg) => {
      if (cfg.apiBase && els.apiBase) els.apiBase.value = cfg.apiBase;
      if (cfg.model && els.model) els.model.value = cfg.model;
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
      apiBase: els.apiBase ? els.apiBase.value.trim() : '',
      model: els.model ? els.model.value.trim() : '',
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
      // 任务丢失（NO_TASK）或通信异常：停止轮询并复位 UI，避免无限轮询与界面卡死。
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        stopPolling();
        setRunningUI(false);
        if (chrome.runtime.lastError || !resp) {
          showError('与后台通信失败，请刷新页面重试');
        } else if (resp.error === 'NO_TASK') {
          showError('任务已不存在，请重新采集');
          setProgress(0, '任务丢失');
        } else {
          showError('采集异常：' + (resp.error || '未知错误'));
        }
        return;
      }
      const pct = progressToPercent(resp.progress);
      setProgress(pct, statusLabel(resp.status) + `（已采集 ${resp.notesCount ?? 0} 篇）`);

      // 未登录拦截：明确提示登录，停止轮询（不再无限重试）。
      if (isAuthRequired(resp)) {
        stopPolling();
        setRunningUI(false);
        showError('请在小红书网页端登录后再采集');
        return;
      }

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
      crawlDelay: Number(els.delay.value) || 0,
    });
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        const detail = chrome.runtime.lastError ? chrome.runtime.lastError.message : '后台未响应';
        showError('与后台通信失败：' + detail);
        return;
      }
      if (!resp.ok) {
        // 注意：未登录(AUTH_REQUIRED) 不会在 START 响应中返回，而是由 pollOnce 通过
        // GET_PROGRESS 的 errors 在采集过程中检测并提示，故此处仅处理启动阶段的即时错误。
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
    chrome.runtime.sendMessage({ type: 'CANCEL_TASK', taskId }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        showError('取消失败：' + (resp ? resp.error : '通信错误'));
        return;
      }
      stopPolling();
      setRunningUI(false);
      setProgress(0, '已取消');
    });
  }

  // --- 导出：经由 SW 序列化后在本地下载（纯前端下载） ---
  // Blob URL 兜底：当 chrome.downloads 不可用或下载报错时使用。
  function fallbackBlobDownload(filename, mime, text) {
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

  function downloadString(filename, mime, text) {
    if (chrome && chrome.downloads && chrome.downloads.download) {
      const dataUrl = 'data:' + mime + ';charset=utf-8,' + encodeURIComponent(text);
      chrome.downloads.download({ url: dataUrl, filename, saveAs: true }, () => {
        // 下载失败（含 data: URL 策略拦截）时回退到 Blob 方式，避免静默失败。
        if (chrome.runtime.lastError) fallbackBlobDownload(filename, mime, text);
      });
      return;
    }
    fallbackBlobDownload(filename, mime, text);
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
  if (els.apiBase) els.apiBase.addEventListener('change', saveConfig);
  if (els.model) els.model.addEventListener('change', saveConfig);
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
      chrome.storage.local.remove(['apiBase', 'model', 'apiKey', 'comments', 'crawlDelay', 'limit'], () => {
        if (els.apiBase) els.apiBase.value = '';
        if (els.model) els.model.value = '';
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
    isAuthRequired,
    formatDetailStatus,
    renderNotePreviewRow,
    escapeHtml,
  };
}
