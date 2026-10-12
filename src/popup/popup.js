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

// 构造 START_TASK 消息。opts = { limit=20, comments=false, format='json', crawlDelay=0, sortType='general' }。
function buildStartMessage(keyword, opts = {}) {
  const limit = typeof opts.limit === 'number' ? opts.limit : 20;
  const commentsPerNote = typeof opts.commentsPerNote === 'number'
    ? opts.commentsPerNote
    : (opts.comments ? DEFAULT_COMMENTS_PER_NOTE : 0);
  const format = opts.format === 'csv' ? 'csv' : 'json';
  const crawlDelay = typeof opts.crawlDelay === 'number' ? opts.crawlDelay : 0;
  const sortType = opts.sortType || 'general';
  const forceAiRemediation = Boolean(opts.forceAiRemediation);
  return {
    type: 'START_TASK',
    keyword,
    config: {
      notesLimit: limit,
      commentsPerNote,
      outputFormat: format,
      crawlDelay,
      sortType,
      forceAiRemediation,
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

// 将笔记数组转为 CSV 字符串（含表头），与 Service Worker 列定义一致。
function notesToCsv(notes) {
  const safeNotes = Array.isArray(notes) ? notes : [];
  const rows = safeNotes.map((note) =>
    CSV_COLUMNS.map((col) => {
      if (col === 'commentsCount') {
        if (typeof note?.totalComments === 'number' && note.totalComments > 0) {
          return csvField(note.totalComments);
        }
        const list = note ? (note.commentList ?? note.comments ?? []) : [];
        return csvField(Array.isArray(list) ? list.length : (note?.commentsCount ?? 0));
      }
      if (col === 'tags') {
        if (Array.isArray(note?.tags)) {
          return csvField(note.tags.join(', '));
        }
        return csvField(note?.tags);
      }
      if (col === 'collectedAt') {
        if (typeof note?.collectedAt === 'number' && note.collectedAt > 1e11) {
          return csvField(formatCsvDateTime(note.collectedAt));
        }
        return csvField(note?.collectedAt);
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

// 将笔记及其评论打平成独立的评论明细 CSV（便于受众情感与互动分析，含唯一性去重）
function commentsToCsv(notes) {
  const safeNotes = Array.isArray(notes) ? notes : [];
  const rows = [];
  for (const note of safeNotes) {
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
  return [COMMENT_CSV_COLUMNS.join(','), ...rows].join('\n');
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

// 生成单条自愈流水条目的 HTML 片段
function renderRemediationItem(item) {
  if (!item) return '';
  const round = item.round || 1;
  const isSuccess = Boolean(item.achieved);
  const badgeText = isSuccess ? '已达成契约' : (item.executed ? '已执行' : '待执行');
  const badgeClass = isSuccess ? 'success' : 'pending';
  const diag = escapeHtml(item.diagnosis || '现场研判中...');
  const actionText = escapeHtml(item.action ? `${item.action} ${item.selector ? JSON.stringify(item.selector) : ''}` : '');

  return `
    <div class="remediation-item">
      <div class="remediation-round">
        <span>第 ${round} 轮研判</span>
        <span class="remediation-badge ${badgeClass}">${badgeText}</span>
      </div>
      <div class="remediation-diag">${diag}</div>
      ${actionText ? `<div class="remediation-action">动作: ${actionText}</div>` : ''}
    </div>
  `.trim();
}

// 格式化任务历史条目的展示信息
function formatTaskHistoryItem(task) {
  if (!task) return { keyword: '', count: 0, statusText: '未知', summary: '' };
  const keyword = task.keyword || '（无关键词）';
  const count = task.progress?.notesCollected ?? task.notesCount ?? 0;
  const statusText = statusLabel(task.status);
  const sortMap = {
    general: '综合',
    popularity_descending: '最热',
    time_descending: '最新',
  };
  const sortText = sortMap[task.config?.sortType] || '默认';
  const summary = `【${keyword}】采集 ${count} 篇 (${sortText}排序) · ${statusText}`;
  return {
    id: task.id,
    keyword,
    count,
    statusText,
    summary,
  };
}

// 渲染单条任务历史条目 HTML
function renderHistoryItemHtml(task, { isActive = false, isChecked = false } = {}) {
  if (!task) return '';
  const item = formatTaskHistoryItem(task);
  const activeCls = isActive ? ' active' : '';
  const checkedAttr = isChecked ? ' checked' : '';
  const timeStr = task.timestamps?.createdAt ? new Date(task.timestamps.createdAt).toLocaleDateString() : '';
  const safeId = escapeHtml(task.id || '');
  const idShort = escapeHtml((task.id || '').slice(0, 16));

  return `
    <div class="history-item${activeCls}" data-task-id="${safeId}">
      <div class="history-item-left">
        <input type="checkbox" class="history-item-check" data-task-id="${safeId}"${checkedAttr}>
        <div class="history-item-main">
          <div class="history-item-title">${escapeHtml(item.summary)}</div>
          <div class="history-item-meta">${timeStr} · 任务ID: ${idShort}...</div>
        </div>
      </div>
      <div class="history-item-actions">
        <div class="history-item-btn view-btn">${isActive ? '当前' : '查看 ➔'}</div>
        <button class="history-del-single-btn" data-task-id="${safeId}" title="删除该记录">🗑️</button>
      </div>
    </div>
  `.trim();
}

// 格式化自适应学习验证报告数据
function formatPatternReport(report) {
  if (!report || typeof report !== 'object') return [];
  const list = [];
  for (const [key, val] of Object.entries(report)) {
    if (!val || typeof val !== 'object') continue;
    list.push({
      key,
      selector: val.selector || '',
      matchCount: Number(val.matchCount) || 0,
      valid: Boolean(val.valid && val.matchCount > 0),
      sampleText: val.sampleText || '',
    });
  }
  return list;
}

// 渲染验证报告 HTML
function renderPatternReportHtml(report) {
  const items = formatPatternReport(report);
  if (items.length === 0) {
    return '<div class="pattern-report-empty" style="font-size:11px;color:#94a3b8;padding:6px;text-align:center;">暂无经沙箱验证的规则报告</div>';
  }
  return items
    .map((item) => {
      const badgeClass = item.valid ? 'badge-success' : 'badge-fail';
      const badgeText = item.valid ? `✅ 命中 ${item.matchCount} 项` : '❌ 未命中';
      const sample = item.sampleText ? `<div class="pattern-sample">示例: "${escapeHtml(item.sampleText)}"</div>` : '';
      return `
        <div class="pattern-report-item">
          <div class="pattern-report-header">
            <span class="pattern-key">${escapeHtml(item.key)}</span>
            <span class="pattern-badge ${badgeClass}">${badgeText}</span>
          </div>
          <div class="pattern-selector"><code>${escapeHtml(item.selector || '(未在当前 DOM 命中可用选择器)')}</code></div>
          ${sample}
        </div>
      `.trim();
    })
    .join('');
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
    newBtn: $('newBtn'),
    progressBar: $('progressBar'),
    progressText: $('progressText'),
    statusText: $('statusText'),
    stepDetail: $('stepDetail'),
    errorBox: $('errorBox'),
    previewSection: $('previewSection'),
    previewCount: $('previewCount'),
    previewList: $('previewList'),
    openTabBtn: $('openTabBtn'),
    sortType: $('sortType'),
    commentsDepth: $('commentsDepth'),
    finishEarlyBtn: $('finishEarlyBtn'),
    exportJsonBtn: $('exportJsonBtn'),
    exportCsvBtn: $('exportCsvBtn'),
    exportCommentsBtn: $('exportCommentsBtn'),
    historyToggleBtn: $('historyToggleBtn'),
    historySection: $('historySection'),
    closeHistoryBtn: $('closeHistoryBtn'),
    historyAllCount: $('historyAllCount'),
    exportAllCsvBtn: $('exportAllCsvBtn'),
    exportAllCommentsBtn: $('exportAllCommentsBtn'),
    exportAllJsonBtn: $('exportAllJsonBtn'),
    historyList: $('historyList'),
    selectAllHistory: $('selectAllHistory'),
    deleteSelectedBtn: $('deleteSelectedBtn'),
    advancedToggle: $('advancedToggle'),
    advancedPanel: $('advancedPanel'),
    apiBase: $('apiBase'),
    model: $('model'),
    apiKey: $('apiKey'),
    protocol: $('protocol'),
    testLlmBtn: $('testLlmBtn'),
    testFeedback: $('testFeedback'),
    comments: $('comments'),
    delay: $('delay'),
    forceAiRemediation: $('forceAiRemediation'),
    saveHint: $('saveHint'),
    resetBtn: $('resetBtn'),
    learnPatternsBtn: $('learnPatternsBtn'),
    learnFeedback: $('learnFeedback'),
    verifyPatternsBtn: $('verifyPatternsBtn'),
    resetPatternsBtn: $('resetPatternsBtn'),
    patternReportCard: $('patternReportCard'),
    patternReportList: $('patternReportList'),
    togglePatternReportBtn: $('togglePatternReportBtn'),
    patternDebugMeta: $('patternDebugMeta'),
    viewDebugHtmlBtn: $('viewDebugHtmlBtn'),
    debugModal: $('debugModal'),
    debugModalTitle: $('debugModalTitle'),
    debugModalPre: $('debugModalPre'),
    closeDebugModalBtn: $('closeDebugModalBtn'),
    remediationCard: $('remediationCard'),
    remediationList: $('remediationList'),
    toggleRemediationBtn: $('toggleRemediationBtn'),
  };

  let taskId = null;
  let pollTimer = null;
  let crawlDelay = 0;

  // --- 配置持久化（chrome.storage.local） ---
  function showSaveHint(text = '设置已保存') {
    if (!els.saveHint) return;
    els.saveHint.textContent = text;
    setTimeout(() => {
      if (els.saveHint) els.saveHint.textContent = '';
    }, 2000);
  }

  function loadConfig() {
    if (!chrome || !chrome.storage || !chrome.storage.local) return;
    chrome.storage.local.get(['apiBase', 'model', 'apiKey', 'protocol', 'comments', 'commentsDepth', 'crawlDelay', 'limit', 'sortType', 'forceAiRemediation'], (cfg) => {
      if (cfg.apiBase && els.apiBase) els.apiBase.value = cfg.apiBase;
      if (cfg.model && els.model) els.model.value = cfg.model;
      if (cfg.apiKey && els.apiKey) els.apiKey.value = cfg.apiKey;
      if (cfg.protocol && els.protocol) els.protocol.value = cfg.protocol;
      if (cfg.sortType && els.sortType) els.sortType.value = cfg.sortType;
      if (els.forceAiRemediation) {
        els.forceAiRemediation.checked = cfg.forceAiRemediation !== undefined ? Boolean(cfg.forceAiRemediation) : true;
      }
      
      let depth = 20;
      if (cfg.commentsDepth !== undefined) {
        depth = Number(cfg.commentsDepth) || 0;
      } else if (typeof cfg.comments === 'boolean') {
        depth = cfg.comments ? 20 : 0;
      }
      if (els.commentsDepth) els.commentsDepth.value = String(depth);
      if (els.comments) els.comments.checked = depth > 0;

      if (typeof cfg.limit === 'number' && els.limit) els.limit.value = String(cfg.limit);
      if (typeof cfg.crawlDelay === 'number' && els.delay) {
        crawlDelay = cfg.crawlDelay;
        els.delay.value = String(cfg.crawlDelay);
      }
    });
  }

  function saveConfig() {
    if (!chrome || !chrome.storage || !chrome.storage.local) return;
    const depthVal = els.commentsDepth ? Number(els.commentsDepth.value) : (els.comments && els.comments.checked ? 20 : 0);
    const commentsChecked = depthVal > 0;
    if (els.comments && els.comments.checked !== commentsChecked) {
      els.comments.checked = commentsChecked;
    }
    chrome.storage.local.set(
      {
        apiBase: els.apiBase ? els.apiBase.value.trim() : '',
        model: els.model ? els.model.value.trim() : '',
        apiKey: els.apiKey ? els.apiKey.value.trim() : '',
        protocol: els.protocol ? els.protocol.value : 'auto',
        comments: commentsChecked,
        commentsDepth: depthVal,
        crawlDelay,
        limit: els.limit ? Number(els.limit.value) || 20 : 20,
        sortType: els.sortType ? els.sortType.value : 'general',
        forceAiRemediation: els.forceAiRemediation ? els.forceAiRemediation.checked : false,
      },
      () => showSaveHint()
    );
  }

  // --- 进度条 / 状态 / 详情刷新 ---
  function setProgress(pct, label, step) {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    els.progressBar.style.width = p + '%';
    els.progressBar.setAttribute('aria-valuenow', String(p));
    els.progressText.textContent = p + '%';
    if (label != null) els.statusText.textContent = label;
    if (els.stepDetail) {
      if (step) {
        els.stepDetail.textContent = step;
        els.stepDetail.style.display = 'block';
      } else {
        els.stepDetail.style.display = 'none';
      }
    }
  }

  function showError(msg) {
    els.errorBox.textContent = msg || '';
    els.errorBox.style.display = msg ? 'block' : 'none';
  }

  function renderPreviews(notes) {
    if (!els.previewSection || !els.previewList) return;
    if (!Array.isArray(notes) || notes.length === 0) {
      els.previewSection.style.display = 'none';
      return;
    }
    els.previewCount.textContent = notes.length;
    els.previewList.innerHTML = notes.slice(0, 5).map(renderNotePreviewRow).join('');
    els.previewSection.style.display = 'flex';
  }

  function updateExportButtons(notesCount) {
    const count = Number(notesCount) || 0;
    const canExport = count > 0 && !!taskId;
    els.exportJsonBtn.disabled = !canExport;
    els.exportCsvBtn.disabled = !canExport;
    if (els.exportCommentsBtn) {
      els.exportCommentsBtn.disabled = !canExport;
    }
    if (count > 0) {
      els.exportCsvBtn.textContent = `导出笔记 CSV (${count}篇)`;
      els.exportJsonBtn.textContent = `导出 JSON (${count}篇)`;
      if (els.exportCommentsBtn) els.exportCommentsBtn.textContent = '导出评论 CSV';
    } else {
      els.exportCsvBtn.textContent = '导出笔记 CSV';
      els.exportJsonBtn.textContent = '导出 JSON';
      if (els.exportCommentsBtn) els.exportCommentsBtn.textContent = '导出评论 CSV';
    }
  }

  function setRunningUI(running, notesCount = 0) {
    els.startBtn.disabled = running;
    els.cancelBtn.disabled = !running;
    if (els.finishEarlyBtn) {
      const count = Number(notesCount) || 0;
      els.finishEarlyBtn.style.display = running && count > 0 ? 'block' : 'none';
      if (running) {
        els.finishEarlyBtn.disabled = false;
        els.finishEarlyBtn.textContent = '就采这些，结束采集';
      }
    }
    updateExportButtons(notesCount);
    if (els.newBtn) {
      els.newBtn.style.display = !running && taskId ? 'block' : 'none';
    }
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
          setProgress(0, '任务丢失', null);
        } else {
          showError('采集异常：' + (resp.error || '未知错误'));
        }
        return;
      }
      const pct = progressToPercent(resp.progress);
      const label = statusLabel(resp.status);
      const step = resp.progress?.stepMessage || null;
      setProgress(pct, label, step);

      const count = resp.notesCount ?? resp.progress?.notesCollected ?? 0;
      updateExportButtons(count);
      if (els.finishEarlyBtn) {
        els.finishEarlyBtn.style.display = (resp.status === 'running' && count > 0) ? 'block' : 'none';
      }

      // 实时渲染 🧠 AI 目标研判与自愈流水
      const remState = resp.progress?.remediationState;
      if (els.remediationCard && els.remediationList) {
        if (remState && Array.isArray(remState.history) && remState.history.length > 0) {
          els.remediationCard.style.display = 'block';
          els.remediationList.innerHTML = remState.history.map(renderRemediationItem).join('');
        } else if (resp.status !== 'running') {
          // 非运行态且无流水时保持隐藏
          els.remediationCard.style.display = 'none';
        }
      }

      // 未登录拦截：明确提示登录，停止轮询（不再无限重试）。
      if (isAuthRequired(resp)) {
        stopPolling();
        setRunningUI(false, count);
        showError('请在小红书网页端登录后再采集');
        return;
      }

      if (['completed', 'failed', 'cancelled'].includes(resp.status)) {
        stopPolling();
        setRunningUI(false, count);
        if (resp.status === 'failed') {
          const errMsg = resp.errors && resp.errors.length > 0
            ? resp.errors[resp.errors.length - 1].message
            : '采集任务失败，请检查网页状态';
          showError(errMsg);
        } else {
          showError('');
        }
        // 完成后拉取预览
        loadLatestTask();
      }
    });
  }

  function startPolling() {
    stopPolling();
    pollOnce();
    pollTimer = setInterval(pollOnce, 1000);
  }

  // --- 任务恢复逻辑 ---
  function loadLatestTask() {
    if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) return;
    chrome.runtime.sendMessage({ type: 'GET_LATEST_TASK' }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok || !resp.task) return;
      const task = resp.task;
      taskId = task.id;
      if (task.keyword && !els.keyword.value) {
        els.keyword.value = task.keyword;
      }
      const pct = progressToPercent(task.progress);
      const label = statusLabel(task.status);
      const step = task.progress?.stepMessage || null;
      setProgress(pct, label, step);
      renderPreviews(resp.notes);

      const notes = resp.notes || [];
      const count = notes.length || task.progress?.notesCollected || 0;
      if (task.status === 'running') {
        setRunningUI(true, count);
        startPolling();
      } else {
        setRunningUI(false, count);
        if (task.status === 'failed') {
          const errMsg = task.errors && task.errors.length > 0
            ? task.errors[task.errors.length - 1].message
            : '采集任务失败，请检查网页状态';
          showError(errMsg);
        } else {
          showError('');
        }
      }
    });
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
    const depth = els.commentsDepth ? Number(els.commentsDepth.value) : (els.comments && els.comments.checked ? 20 : 0);
    const msg = buildStartMessage(keyword, {
      limit: Number(els.limit.value) || 20,
      comments: depth > 0,
      commentsPerNote: depth,
      format: 'json',
      crawlDelay: Number(els.delay.value) || 0,
      sortType: els.sortType ? els.sortType.value : 'general',
      forceAiRemediation: els.forceAiRemediation ? els.forceAiRemediation.checked : false,
    });
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        const detail = chrome.runtime.lastError ? chrome.runtime.lastError.message : '后台未响应';
        showError('与后台通信失败：' + detail);
        return;
      }
      if (!resp.ok) {
        if (resp.error === 'NO_API_KEY') {
          showError('缺少 Claude API Key，请在下方高级设置中填写');
          els.advancedPanel.classList.add('open');
          els.advancedToggle.parentElement.classList.add('open');
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
      setProgress(0, '排队中', '准备初始化浏览器环境...');
      if (els.previewSection) els.previewSection.style.display = 'none';
      startPolling();
    });
  }

  function onCancel() {
    if (taskId == null) return;
    showError('');
    if (els.cancelBtn) {
      els.cancelBtn.disabled = true;
      els.cancelBtn.textContent = '取消中...';
    }
    const currentCancelId = taskId;
    chrome.runtime.sendMessage({ type: 'CANCEL_TASK', taskId: currentCancelId }, (resp) => {
      if (els.cancelBtn) {
        els.cancelBtn.disabled = false;
        els.cancelBtn.textContent = '取消';
      }
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        showError('取消失败：' + (resp ? resp.error : '通信错误'));
        return;
      }
      stopPolling();
      setRunningUI(false);
      showError('');
      setProgress(0, '已取消', '用户已终止采集');
      taskId = null;
    });
  }

  function onNewTask() {
    chrome.runtime.sendMessage({ type: 'RESET_TASK' }, () => {
      stopPolling();
      taskId = null;
      els.keyword.value = '';
      showError('');
      setProgress(0, '待命', null);
      if (els.previewSection) els.previewSection.style.display = 'none';
      setRunningUI(false);
    });
  }

  // --- 测试 API 连接 ---
  function onTestLlm() {
    if (!els.testFeedback) return;
    const key = els.apiKey ? els.apiKey.value.trim() : '';
    const apiBase = els.apiBase ? els.apiBase.value.trim() : '';
    const model = els.model ? els.model.value.trim() : '';
    const protocol = els.protocol ? els.protocol.value : 'auto';
    if (!key) {
      els.testFeedback.className = 'test-feedback fail';
      els.testFeedback.textContent = '请先填写 API Key';
      return;
    }
    els.testFeedback.className = 'test-feedback';
    els.testFeedback.textContent = '测试中...';
    els.testLlmBtn.disabled = true;

    chrome.runtime.sendMessage(
      { type: 'TEST_LLM_CONFIG', apiKey: key, apiBase, model, protocol },
      (resp) => {
        els.testLlmBtn.disabled = false;
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          els.testFeedback.className = 'test-feedback fail';
          els.testFeedback.textContent = '连接失败: ' + (resp?.error || '通信异常');
        } else {
          els.testFeedback.className = 'test-feedback success';
          els.testFeedback.textContent = '✓ 连接成功';
        }
      }
    );
  }

  // --- 动态规则自动学习（沙箱回测闭环）：分析当前页面并沉淀高可靠经验 ---
  let lastCapturedHtml = '';

  function openDebugModal(title, text) {
    if (!els.debugModal || !els.debugModalPre || !els.debugModalTitle) return;
    els.debugModalTitle.textContent = title;
    els.debugModalPre.textContent = text || '（无内容）';
    els.debugModal.style.display = 'flex';
  }

  function closeDebugModal() {
    if (els.debugModal) els.debugModal.style.display = 'none';
  }

  if (els.closeDebugModalBtn) els.closeDebugModalBtn.addEventListener('click', closeDebugModal);
  if (els.debugModal) {
    els.debugModal.addEventListener('click', (e) => {
      if (e.target === els.debugModal) closeDebugModal();
    });
  }
  if (els.viewDebugHtmlBtn) {
    els.viewDebugHtmlBtn.addEventListener('click', () => {
      openDebugModal('捕获的 HTML 骨架片段预览', lastCapturedHtml);
    });
  }

  function updatePatternReport(report, debug = null) {
    if (!els.patternReportCard || !els.patternReportList) return;
    if (!report || Object.keys(report).length === 0) {
      els.patternReportCard.style.display = 'none';
      if (els.patternDebugMeta) els.patternDebugMeta.style.display = 'none';
      if (els.viewDebugHtmlBtn) els.viewDebugHtmlBtn.style.display = 'none';
      return;
    }

    if (debug) {
      lastCapturedHtml = debug.htmlPreview || '';
      if (els.patternDebugMeta) {
        const skeletonText = debug.isSkeleton ? '✨ 智能紧凑骨架' : '整页 DOM';
        els.patternDebugMeta.textContent = `标签页 [ID:${debug.tabId || '当前'}] · 提取方式: ${skeletonText} (${debug.htmlLength} 字符) · 耗时: ${debug.durationMs || 0}ms`;
        els.patternDebugMeta.style.display = 'block';
      }
      if (els.viewDebugHtmlBtn && lastCapturedHtml) {
        els.viewDebugHtmlBtn.style.display = 'inline-block';
      }
    }

    els.patternReportList.innerHTML = renderPatternReportHtml(report);
    els.patternReportCard.style.display = 'flex';
  }

  function onLearnPatterns() {
    if (!els.learnFeedback) return;
    const key = els.apiKey ? els.apiKey.value.trim() : '';
    if (!key) {
      els.learnFeedback.className = 'test-feedback fail';
      els.learnFeedback.textContent = '请先填写 API Key';
      return;
    }
    els.learnFeedback.className = 'test-feedback';
    els.learnFeedback.textContent = '[1/4] 正在连接小红书标签页并提取核心交互骨架...';
    els.learnPatternsBtn.disabled = true;

    // 优先通过 chrome.tabs 查询当前窗口的活动标签或任意小红书标签
    function triggerLearn(targetTabId) {
      els.learnFeedback.textContent = '[2/4] 骨架提取完成，大模型正在勘探定位策略...';
      chrome.runtime.sendMessage({ type: 'LEARN_SITE_PATTERNS', tabId: targetTabId, targetType: 'search' }, (resp) => {
        els.learnPatternsBtn.disabled = false;
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          els.learnFeedback.className = 'test-feedback fail';
          els.learnFeedback.textContent = '学习失败: ' + (resp?.message || resp?.error || '通信异常');
        } else {
          els.learnFeedback.className = 'test-feedback success';
          els.learnFeedback.textContent = '✓ [4/4] 规则自学成功，已完成沙箱验证并沉淀';
          if (resp.report) {
            updatePatternReport(resp.report, resp.debug);
          }
        }
      });
    }

    if (chrome && chrome.tabs && chrome.tabs.query) {
      chrome.tabs.query({ url: '*://*.xiaohongshu.com/*' }, (tabs) => {
        if (tabs && tabs.length > 0) {
          const searchTab = tabs.find((t) => t.url && t.url.includes('search_result'));
          const activeXhs = tabs.find((t) => t.active) || searchTab || tabs[0];
          triggerLearn(activeXhs.id);
        } else {
          chrome.tabs.query({ active: true, currentWindow: true }, (curTabs) => {
            const tid = curTabs && curTabs[0] ? curTabs[0].id : null;
            triggerLearn(tid);
          });
        }
      });
    } else {
      triggerLearn(null);
    }
  }

  function onVerifyPatterns() {
    if (!els.learnFeedback) return;
    els.learnFeedback.className = 'test-feedback';
    els.learnFeedback.textContent = '正在当前页面回测所有动态规则...';
    if (els.verifyPatternsBtn) els.verifyPatternsBtn.disabled = true;

    chrome.runtime.sendMessage({ type: 'VERIFY_DYNAMIC_PATTERNS' }, (resp) => {
      if (els.verifyPatternsBtn) els.verifyPatternsBtn.disabled = false;
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        els.learnFeedback.className = 'test-feedback fail';
        els.learnFeedback.textContent = '测试失败: ' + (resp?.message || resp?.error || '通信异常');
      } else {
        els.learnFeedback.className = 'test-feedback success';
        els.learnFeedback.textContent = '✓ 规则在线回测完成';
        if (resp.report) updatePatternReport(resp.report);
      }
    });
  }

  function onResetDynamicPatterns() {
    if (typeof confirm === 'function' && !confirm('确定清空已学到的动态规则并还原官方基准吗？')) return;
    chrome.runtime.sendMessage({ type: 'RESET_DYNAMIC_PATTERNS' }, (resp) => {
      if (resp && resp.ok) {
        if (els.learnFeedback) {
          els.learnFeedback.className = 'test-feedback success';
          els.learnFeedback.textContent = '✓ 已清空动态规则，恢复默认静态基线';
        }
        updatePatternReport(null);
      }
    });
  }

  // --- 导出：经由 SW 序列化后在本地下载（纯前端下载） ---
  function fallbackBlobDownload(filename, mime, text) {
    const blob = new Blob([text], { type: mime + ';charset=utf-8' });
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
    const isCsv = mime.includes('csv') || filename.endsWith('.csv');
    const content = isCsv && !text.startsWith('\uFEFF') ? '\uFEFF' + text : text;
    if (chrome && chrome.downloads && chrome.downloads.download) {
      const dataUrl = 'data:' + mime + ';charset=utf-8,' + encodeURIComponent(content);
      chrome.downloads.download({ url: dataUrl, filename, saveAs: true }, () => {
        if (chrome.runtime.lastError) fallbackBlobDownload(filename, mime, content);
      });
      return;
    }
    fallbackBlobDownload(filename, mime, content);
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
      const mime = (format === 'csv' || format === 'comments_csv') ? 'text/csv' : 'application/json';
      downloadString(resp.filename || `xhs_${taskId}.${format}`, mime, resp.data);
    });
  }

  // --- 事件绑定 ---
  els.startBtn.addEventListener('click', onStart);
  els.cancelBtn.addEventListener('click', onCancel);
  if (els.finishEarlyBtn) {
    els.finishEarlyBtn.addEventListener('click', () => {
      if (!taskId) return;
      els.finishEarlyBtn.disabled = true;
      els.finishEarlyBtn.textContent = '正在保存并结束...';
      chrome.runtime.sendMessage({ type: 'FINISH_EARLY_TASK', taskId }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          showError('提前结束失败：' + (resp?.error || '通信异常'));
          els.finishEarlyBtn.disabled = false;
          els.finishEarlyBtn.textContent = '就采这些，结束采集';
        } else {
          pollOnce();
        }
      });
    });
  }
  if (els.newBtn) els.newBtn.addEventListener('click', onNewTask);
  els.exportJsonBtn.addEventListener('click', () => onExport('json'));
  els.exportCsvBtn.addEventListener('click', () => onExport('csv'));
  if (els.exportCommentsBtn) els.exportCommentsBtn.addEventListener('click', () => onExport('comments_csv'));
  if (els.testLlmBtn) els.testLlmBtn.addEventListener('click', onTestLlm);
  if (els.learnPatternsBtn) els.learnPatternsBtn.addEventListener('click', onLearnPatterns);
  if (els.verifyPatternsBtn) els.verifyPatternsBtn.addEventListener('click', onVerifyPatterns);
  if (els.resetPatternsBtn) els.resetPatternsBtn.addEventListener('click', onResetDynamicPatterns);
  if (els.togglePatternReportBtn) {
    els.togglePatternReportBtn.addEventListener('click', () => {
      if (!els.patternReportList) return;
      const isHidden = els.patternReportList.style.display === 'none';
      els.patternReportList.style.display = isHidden ? 'flex' : 'none';
      els.togglePatternReportBtn.textContent = isHidden ? '收起' : '展开';
    });
  }

  if (els.openTabBtn) {
    els.openTabBtn.addEventListener('click', () => {
      const targetUrl = chrome?.runtime?.getURL ? chrome.runtime.getURL('popup/index.html') : 'index.html';
      if (chrome && chrome.tabs && chrome.tabs.create) {
        chrome.tabs.create({ url: targetUrl });
      } else if (typeof window !== 'undefined') {
        window.open(targetUrl, '_blank');
      }
    });
  }
  if (els.commentsDepth) {
    els.commentsDepth.addEventListener('change', () => {
      const depth = Number(els.commentsDepth.value) || 0;
      if (els.comments) els.comments.checked = depth > 0;
      saveConfig();
    });
  }
  if (els.comments) {
    els.comments.addEventListener('change', () => {
      if (els.commentsDepth) {
        els.commentsDepth.value = els.comments.checked ? '20' : '0';
      }
      saveConfig();
    });
  }
  if (els.protocol) els.protocol.addEventListener('change', saveConfig);
  if (els.apiBase) els.apiBase.addEventListener('change', saveConfig);
  if (els.model) els.model.addEventListener('change', saveConfig);
  if (els.apiKey) els.apiKey.addEventListener('change', saveConfig);
  if (els.limit) els.limit.addEventListener('change', saveConfig);
  if (els.sortType) els.sortType.addEventListener('change', saveConfig);

  if (els.delay) {
    els.delay.addEventListener('change', () => {
      crawlDelay = Number(els.delay.value) || 0;
      saveConfig();
    });
  }

  // 高级抽屉折叠
  if (els.advancedToggle) {
    els.advancedToggle.addEventListener('click', () => {
      els.advancedPanel.classList.toggle('open');
      els.advancedToggle.parentElement.classList.toggle('open');
      const expanded = els.advancedToggle.getAttribute('aria-expanded') === 'true';
      els.advancedToggle.setAttribute('aria-expanded', String(!expanded));
    });
  }

  // 经验库重置（清除本地存储的 API Key 与设置）
  if (els.resetBtn) {
    els.resetBtn.addEventListener('click', () => {
      if (chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.remove(['apiBase', 'model', 'apiKey', 'comments', 'crawlDelay', 'limit', 'sortType'], () => {
          if (els.apiBase) els.apiBase.value = '';
          if (els.model) els.model.value = '';
          if (els.apiKey) els.apiKey.value = '';
          if (els.comments) els.comments.checked = false;
          if (els.delay) els.delay.value = '0';
          if (els.sortType) els.sortType.value = 'general';
          chrome.runtime.sendMessage({ type: 'RESET_DYNAMIC_PATTERNS' }, () => {});
          showSaveHint('本地配置与 AI 经验库已重置');
        });
      }
    });
  }

  // --- 历史记录面板与全量导出 ---
  function openHistoryPanel() {
    if (!els.historySection) return;
    els.historySection.style.display = 'flex';
    refreshHistoryData();
  }

  function closeHistoryPanel() {
    if (!els.historySection) return;
    els.historySection.style.display = 'none';
  }

  let selectedTaskIds = new Set();
  let currentHistoryTasks = [];

  function updateHistoryToolbar() {
    const total = currentHistoryTasks.length;
    const selectedCount = selectedTaskIds.size;
    if (els.deleteSelectedBtn) {
      els.deleteSelectedBtn.disabled = selectedCount === 0;
      els.deleteSelectedBtn.textContent = `🗑️ 删除所选 (${selectedCount})`;
    }
    if (els.selectAllHistory) {
      els.selectAllHistory.checked = total > 0 && selectedCount === total;
      els.selectAllHistory.indeterminate = selectedCount > 0 && selectedCount < total;
    }
  }

  function deleteTasksAndRefresh(ids) {
    if (!ids || ids.length === 0) return;
    chrome.runtime.sendMessage({ type: 'DELETE_TASKS', taskIds: ids }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        showError('删除历史记录失败：' + (resp?.error || '通信异常'));
        return;
      }
      ids.forEach((id) => selectedTaskIds.delete(id));
      if (ids.includes(taskId)) {
        taskId = null;
        loadLatestTask();
      }
      refreshHistoryData();
    });
  }

  function refreshHistoryData() {
    // 1. 获取全局笔记总数
    chrome.runtime.sendMessage({ type: 'GET_ALL_NOTES', limit: 5000 }, (resp) => {
      if (resp && resp.ok && Array.isArray(resp.notes)) {
        if (els.historyAllCount) els.historyAllCount.textContent = resp.notes.length;
      }
    });

    // 2. 获取历次任务列表
    chrome.runtime.sendMessage({ type: 'GET_TASK_HISTORY', limit: 50 }, (resp) => {
      if (!els.historyList) return;
      if (!resp || !resp.ok || !Array.isArray(resp.tasks) || resp.tasks.length === 0) {
        currentHistoryTasks = [];
        selectedTaskIds.clear();
        updateHistoryToolbar();
        els.historyList.innerHTML = '<div style="font-size:12px;color:#94a3b8;padding:8px;text-align:center;">暂无历史采集任务</div>';
        return;
      }

      currentHistoryTasks = resp.tasks;
      const validSet = new Set(currentHistoryTasks.map((t) => t.id));
      for (const id of selectedTaskIds) {
        if (!validSet.has(id)) selectedTaskIds.delete(id);
      }
      updateHistoryToolbar();

      els.historyList.innerHTML = currentHistoryTasks.map((t) => {
        return renderHistoryItemHtml(t, {
          isActive: t.id === taskId,
          isChecked: selectedTaskIds.has(t.id),
        });
      }).join('');

      // 绑定多选勾选框
      const checkBoxes = els.historyList.querySelectorAll('.history-item-check');
      checkBoxes.forEach((cb) => {
        cb.addEventListener('click', (e) => e.stopPropagation());
        cb.addEventListener('change', () => {
          const tid = cb.getAttribute('data-task-id');
          if (!tid) return;
          if (cb.checked) selectedTaskIds.add(tid);
          else selectedTaskIds.delete(tid);
          updateHistoryToolbar();
        });
      });

      // 绑定单条删除按钮
      const delBtns = els.historyList.querySelectorAll('.history-del-single-btn');
      delBtns.forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const tid = btn.getAttribute('data-task-id');
          if (!tid) return;
          if (typeof confirm === 'function' && !confirm('确定删除该条历史任务及关联笔记吗？此操作不可逆。')) {
            return;
          }
          deleteTasksAndRefresh([tid]);
        });
      });

      // 绑定历史项点击切换
      const items = els.historyList.querySelectorAll('.history-item');
      items.forEach((it) => {
        it.addEventListener('click', (e) => {
          if (e.target.closest('.history-item-check') || e.target.closest('.history-del-single-btn')) return;
          const tid = it.getAttribute('data-task-id');
          if (tid) switchTask(tid);
        });
      });
    });
  }

  function switchTask(targetTaskId) {
    taskId = targetTaskId;
    chrome.runtime.sendMessage({ type: 'GET_PROGRESS', taskId: targetTaskId }, (resp) => {
      if (!resp || !resp.ok) return;
      chrome.runtime.sendMessage({ type: 'EXPORT_DATA', taskId: targetTaskId, format: 'json' }, (noteResp) => {
        let notes = [];
        try {
          if (noteResp && noteResp.ok && noteResp.data) notes = JSON.parse(noteResp.data);
        } catch (_) {}
        const pct = progressToPercent(resp.progress);
        const label = statusLabel(resp.status);
        const step = resp.progress?.stepMessage || null;
        setProgress(pct, label, step);
        renderPreviews(notes);
        setRunningUI(resp.status === 'running', notes.length);
        if (resp.status === 'running') startPolling();
        else stopPolling();
        closeHistoryPanel();
      });
    });
  }

  function onExportAll(format) {
    chrome.runtime.sendMessage({ type: 'EXPORT_ALL_DATA', format }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        showError('导出全量数据失败：' + (resp?.error || '通信异常'));
        return;
      }
      const mime = (format === 'csv' || format === 'comments_csv') ? 'text/csv' : 'application/json';
      downloadString(resp.filename || `xhs_all_notes.${format}`, mime, resp.data);
    });
  }

  if (els.historyToggleBtn) {
    els.historyToggleBtn.addEventListener('click', () => {
      if (els.historySection && els.historySection.style.display === 'flex') {
        closeHistoryPanel();
      } else {
        openHistoryPanel();
      }
    });
  }
  if (els.closeHistoryBtn) els.closeHistoryBtn.addEventListener('click', closeHistoryPanel);
  if (els.exportAllCsvBtn) els.exportAllCsvBtn.addEventListener('click', () => onExportAll('csv'));
  if (els.exportAllCommentsBtn) els.exportAllCommentsBtn.addEventListener('click', () => onExportAll('comments_csv'));
  if (els.exportAllJsonBtn) els.exportAllJsonBtn.addEventListener('click', () => onExportAll('json'));

  if (els.selectAllHistory) {
    els.selectAllHistory.addEventListener('change', () => {
      if (els.selectAllHistory.checked) {
        currentHistoryTasks.forEach((t) => selectedTaskIds.add(t.id));
      } else {
        selectedTaskIds.clear();
      }
      if (els.historyList) {
        const cbs = els.historyList.querySelectorAll('.history-item-check');
        cbs.forEach((cb) => {
          const tid = cb.getAttribute('data-task-id');
          cb.checked = selectedTaskIds.has(tid);
        });
      }
      updateHistoryToolbar();
    });
  }

  if (els.deleteSelectedBtn) {
    els.deleteSelectedBtn.addEventListener('click', () => {
      if (selectedTaskIds.size === 0) return;
      const count = selectedTaskIds.size;
      if (typeof confirm === 'function' && !confirm(`确定删除选中的 ${count} 个历史任务及其全部笔记吗？此操作不可逆。`)) {
        return;
      }
      deleteTasksAndRefresh(Array.from(selectedTaskIds));
    });
  }

  function loadSavedPatternReport() {
    if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) return;
    chrome.runtime.sendMessage({ type: 'VERIFY_DYNAMIC_PATTERNS' }, (resp) => {
      if (resp && resp.ok && resp.report && Object.keys(resp.report).length > 0) {
        updatePatternReport(resp.report);
      }
    });
  }

  if (els.toggleRemediationBtn && els.remediationList) {
    els.toggleRemediationBtn.addEventListener('click', () => {
      const isHidden = els.remediationList.style.display === 'none';
      els.remediationList.style.display = isHidden ? 'flex' : 'none';
      els.toggleRemediationBtn.textContent = isHidden ? '收起' : '展开';
    });
  }

  loadConfig();
  loadLatestTask();
  loadSavedPatternReport();
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
    commentsToCsv,
    notesToJson,
    isAuthRequired,
    formatDetailStatus,
    renderNotePreviewRow,
    formatTaskHistoryItem,
    renderHistoryItemHtml,
    renderRemediationItem,
    escapeHtml,
    formatPatternReport,
    renderPatternReportHtml,
  };
}
