// Popup 纯函数单元测试（TDD: 先写测试，后实现）。
//
// popup.js 是 classic script（扩展 popup 页面非模块），不能用 import/export，
// 但需在 Node 中导出纯函数供测试。实现采用双模：浏览器中 module 未定义跳过，
// Node 中通过 module.exports 导出。本测试仅验证导出的纯函数，不涉及 DOM 接线。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildStartMessage,
  progressToPercent,
  statusLabel,
  notesToCsv,
  notesToJson,
  isAuthRequired,
  formatDetailStatus,
  renderNotePreviewRow,
} = require('../src/popup/popup.js');

// ---------------------------------------------------------------------------
// buildStartMessage
// ---------------------------------------------------------------------------

test('buildStartMessage 默认参数生成标准 START_TASK 消息', () => {
  const msg = buildStartMessage('护肤');
  assert.equal(msg.type, 'START_TASK');
  assert.equal(msg.keyword, '护肤');
  assert.deepEqual(msg.config, {
    notesLimit: 20,
    commentsPerNote: 0,
    outputFormat: 'json',
    crawlDelay: 0,
  });
});

test('buildStartMessage 尊重 opts.limit / comments / format', () => {
  const msg = buildStartMessage('美食', { limit: 50, comments: true, format: 'csv' });
  assert.equal(msg.keyword, '美食');
  assert.equal(msg.config.notesLimit, 50);
  assert.equal(msg.config.commentsPerNote, 20); // 默认每篇评论数 20
  assert.equal(msg.config.outputFormat, 'csv');
  assert.equal(msg.config.crawlDelay, 0);
});

test('buildStartMessage comments=false 时 commentsPerNote 为 0', () => {
  const msg = buildStartMessage('穿搭', { comments: false });
  assert.equal(msg.config.commentsPerNote, 0);
  assert.equal(msg.config.crawlDelay, 0);
});

test('buildStartMessage 部分 opts 走默认值', () => {
  const msg = buildStartMessage('旅行', { limit: 10 });
  assert.equal(msg.config.notesLimit, 10);
  assert.equal(msg.config.commentsPerNote, 0);
  assert.equal(msg.config.outputFormat, 'json');
  assert.equal(msg.config.crawlDelay, 0);
});

test('buildStartMessage 透传 crawlDelay（高级抽屉的爬取延迟）', () => {
  const msg = buildStartMessage('美妆', { limit: 20, crawlDelay: 2000 });
  assert.equal(msg.config.crawlDelay, 2000);
});

// ---------------------------------------------------------------------------
// progressToPercent
// ---------------------------------------------------------------------------

test('progressToPercent 缺省/空进度返回 0', () => {
  assert.equal(progressToPercent(null), 0);
  assert.equal(progressToPercent(undefined), 0);
  assert.equal(progressToPercent({}), 0);
  assert.equal(progressToPercent({ notesTotal: 0, noteUrls: [] }), 0);
});

test('progressToPercent 基于 notesCollected/notesTotal 计算百分比', () => {
  assert.equal(progressToPercent({ notesTotal: 10, notesCollected: 5, noteUrls: [] }), 50);
  assert.equal(progressToPercent({ notesTotal: 3, notesCollected: 1, noteUrls: [] }), 33);
  assert.equal(progressToPercent({ notesTotal: 4, notesCollected: 4, noteUrls: [] }), 100);
});

test('progressToPercent notesTotal=0 时回退到 noteUrls/currentNoteIndex', () => {
  const p = { notesTotal: 0, noteUrls: ['a', 'b'], currentNoteIndex: 0 };
  assert.equal(progressToPercent(p), 50);
  assert.equal(progressToPercent({ notesTotal: 0, noteUrls: ['a', 'b', 'c'], currentNoteIndex: 2 }), 100);
});

test('progressToPercent noteUrls 为空且 notesTotal=0 返回 0', () => {
  assert.equal(progressToPercent({ notesTotal: 0, noteUrls: [], currentNoteIndex: 0 }), 0);
});

test('progressToPercent currentNoteIndex=-1（未开始遍历）应得 0%', () => {
  const p = { notesTotal: 0, noteUrls: ['a', 'b'], currentNoteIndex: -1 };
  assert.equal(progressToPercent(p), 0);
});

test('progressToPercent 结果钳制在 0–100（越界输入不溢出）', () => {
  // notesCollected 超过 notesTotal → 仍不超过 100
  assert.equal(progressToPercent({ notesTotal: 10, notesCollected: 999, noteUrls: [] }), 100);
  // 越界的 currentNoteIndex → 不超过 100
  assert.equal(progressToPercent({ notesTotal: 0, noteUrls: ['a'], currentNoteIndex: 10 }), 100);
  // 负值不应出现
  assert.equal(progressToPercent({ notesTotal: 0, noteUrls: [], currentNoteIndex: -5 }), 0);
});

// ---------------------------------------------------------------------------
// statusLabel
// ---------------------------------------------------------------------------

test('statusLabel 映射标准状态为中文', () => {
  assert.equal(statusLabel('pending'), '排队中');
  assert.equal(statusLabel('running'), '采集中');
  assert.equal(statusLabel('completed'), '已完成');
  assert.equal(statusLabel('failed'), '失败');
  assert.equal(statusLabel('cancelled'), '已取消');
});

test('statusLabel 未知状态原样返回', () => {
  assert.equal(statusLabel('weird'), 'weird');
  assert.equal(statusLabel(null), null);
  assert.equal(statusLabel(undefined), undefined);
});

// ---------------------------------------------------------------------------
// notesToCsv
// ---------------------------------------------------------------------------

test('notesToCsv 始终输出含正确表头的单行', () => {
  const csv = notesToCsv([]);
  assert.equal(
    csv,
    'id,taskId,url,title,content,author,likes,tags,commentsCount,collectedAt'
  );
});

test('notesToCsv 单行数据且逐列映射', () => {
  const notes = [
    {
      id: 'n1',
      taskId: 't1',
      url: 'https://xhs.com/n1',
      title: '标题A',
      content: '正文',
      author: '张三',
      likes: 10,
      tags: ['美', '食'],
      commentList: [{ id: 'c1' }],
      collectedAt: '2026-01-01',
    },
  ];
  const csv = notesToCsv(notes);
  const lines = csv.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], 'id,taskId,url,title,content,author,likes,tags,commentsCount,collectedAt');
  // tags 数组被 JSON 序列化；commentsCount 来自 commentList.length
  assert.ok(lines[1].startsWith('n1,t1,https://xhs.com/n1,标题A,正文,张三,10,'));
  assert.ok(lines[1].includes('"[""美"",""食""]"'), `tags 未正确转义: ${lines[1]}`);
  assert.ok(lines[1].endsWith('1,2026-01-01'), `commentsCount 应为 1: ${lines[1]}`);
});

test('notesToCsv 含逗号/引号/换行的字段需整体加引号并翻倍内部引号', () => {
  const notes = [
    {
      id: 'n1',
      taskId: 't1',
      url: 'u',
      title: '含,逗号',
      content: '含"引号"',
      author: '换\n行',
      likes: 0,
      tags: [],
      commentList: [],
      collectedAt: 't',
    },
  ];
  const csv = notesToCsv(notes);
  // 含逗号的字段被引号包裹
  assert.ok(csv.includes('"含,逗号"'), `逗号未转义: ${csv}`);
  // 含引号字段翻倍且被引号包裹
  assert.ok(csv.includes('"含""引号"""'), `引号未翻倍: ${csv}`);
  // 含换行字段被引号包裹（嵌入换行是合法 CSV，需整体加引号）
  assert.ok(csv.includes('"换\n行"'), `换行未转义: ${csv}`);
});

test('notesToCsv commentsCount 回退到 comments 字段', () => {
  const notes = [{ id: 'n1', taskId: 't1', url: 'u', title: 't', content: 'c', author: 'a', likes: 0, tags: [], comments: [{}, {}, {}], collectedAt: 'x' }];
  const lines = notesToCsv(notes).split('\n');
  assert.ok(lines[1].endsWith('3,x'), `commentsCount 应为 3: ${lines[1]}`);
});

// ---------------------------------------------------------------------------
// notesToJson
// ---------------------------------------------------------------------------

test('notesToJson 返回带缩进的 JSON 字符串', () => {
  const notes = [{ id: 'n1', title: 't' }];
  const json = notesToJson(notes);
  assert.equal(json, JSON.stringify(notes, null, 2));
  assert.ok(json.includes('\n'), '应含换行缩进');
});

// ---------------------------------------------------------------------------
// isAuthRequired
// ---------------------------------------------------------------------------

test('isAuthRequired 在 errors 含 AUTH_REQUIRED 时返回 true', () => {
  assert.equal(
    isAuthRequired({ ok: true, status: 'failed', errors: [{ code: 'AUTH_REQUIRED', phase: 'searching' }] }),
    true
  );
});

test('isAuthRequired 在其它错误或无错误时返回 false', () => {
  assert.equal(isAuthRequired({ ok: true, status: 'failed', errors: [{ code: 'SELECTOR_NOT_FOUND' }] }), false);
  assert.equal(isAuthRequired({ ok: true, status: 'completed', errors: [] }), false);
  assert.equal(isAuthRequired({ ok: false, error: 'NO_TASK' }), false);
  assert.equal(isAuthRequired(null), false);
  assert.equal(isAuthRequired(undefined), false);
});

// ---------------------------------------------------------------------------
// formatDetailStatus
// ---------------------------------------------------------------------------

test('formatDetailStatus 优先展示具体步骤描述 stepMessage', () => {
  const resp = {
    ok: true,
    status: 'running',
    notesCount: 2,
    progress: {
      stepMessage: '正在抓取第 2/5 篇详情...',
      currentTitle: '小红书护肤心得',
    },
  };
  const str = formatDetailStatus(resp);
  assert.equal(str, '采集中 · 正在抓取第 2/5 篇详情...');
});

test('formatDetailStatus 无 stepMessage 时回退到状态与篇数', () => {
  const resp = {
    ok: true,
    status: 'completed',
    notesCount: 5,
  };
  const str = formatDetailStatus(resp);
  assert.equal(str, '已完成（共采集 5 篇）');
});

// ---------------------------------------------------------------------------
// renderNotePreviewRow
// ---------------------------------------------------------------------------

test('renderNotePreviewRow 转义 HTML 并生成预览卡片内容', () => {
  const note = {
    title: '特惠<script>',
    author: '博主&团队',
    likes: 120,
    url: 'https://www.xiaohongshu.com/explore/123',
  };
  const html = renderNotePreviewRow(note);
  assert.ok(html.includes('&lt;script&gt;'), '应转义 HTML 标签');
  assert.ok(html.includes('博主&amp;团队'), '应转义特殊字符');
  assert.ok(html.includes('120 赞'), '应显示点赞数');
  assert.ok(html.includes('https://www.xiaohongshu.com/explore/123'), '应含链接');
});

