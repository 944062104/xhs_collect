import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StorageManager } from '../src/background/storage.js';

// 每个用例使用独立实例 + 独立 DB 名称，避免 store 间数据串扰。
function makeManager(name = `xhs-agent-test-${Math.random().toString(36).slice(2)}`) {
  return new StorageManager(name);
}

test('saveTask + getTask 可正确往返写入与读取', async () => {
  const sm = makeManager();
  const task = {
    id: 'task_1',
    status: 'pending',
    keyword: '护肤推荐',
    config: { notesLimit: 20 },
    progress: { phase: 'idle', notesCollected: 0 },
    createdAt: 1728576000000,
    startedAt: null,
    completedAt: null,
    errors: [],
  };
  await sm.saveTask(task);
  const got = await sm.getTask('task_1');
  assert.ok(got, 'getTask 应返回已保存的任务');
  assert.equal(got.id, 'task_1');
  assert.equal(got.status, 'pending');
  assert.equal(got.keyword, '护肤推荐');
  assert.deepEqual(got.config, { notesLimit: 20 });
});

test('getTask 对不存在的 id 返回 null', async () => {
  const sm = makeManager();
  const got = await sm.getTask('nope');
  assert.equal(got, null);
});

test('updateTaskProgress 更新进度且不影响其他字段', async () => {
  const sm = makeManager();
  await sm.saveTask({
    id: 'task_2',
    status: 'running',
    keyword: '美食',
    config: {},
    progress: { phase: 'idle', notesCollected: 0 },
    createdAt: 1,
    startedAt: null,
    completedAt: null,
    errors: [],
  });
  const progress = { phase: 'collectingNotes', notesCollected: 5, notesTotal: 20 };
  await sm.updateTaskProgress('task_2', progress);
  const got = await sm.getTask('task_2');
  assert.deepEqual(got.progress, progress, '进度应被更新');
  assert.equal(got.status, 'running', '状态等其他字段不应被改动');
  assert.equal(got.keyword, '美食');
});

test('getRunningTask 返回 status 为 running 的任务', async () => {
  const sm = makeManager();
  await sm.saveTask({ id: 't_pending', status: 'pending', keyword: 'a', config: {}, progress: {}, createdAt: 1, startedAt: null, completedAt: null, errors: [] });
  await sm.saveTask({ id: 't_running', status: 'running', keyword: 'b', config: {}, progress: {}, createdAt: 2, startedAt: null, completedAt: null, errors: [] });
  const running = await sm.getRunningTask();
  assert.ok(running, '应存在一个 running 任务');
  assert.equal(running.id, 't_running');
  assert.equal(running.status, 'running');
});

test('getRunningTask 在没有 running 任务时返回 null', async () => {
  const sm = makeManager();
  await sm.saveTask({ id: 't_completed', status: 'completed', keyword: 'c', config: {}, progress: {}, createdAt: 1, startedAt: null, completedAt: 2, errors: [] });
  const running = await sm.getRunningTask();
  assert.equal(running, null);
});

test('saveNote + getNotesByTaskId 批量写入并按 taskId 读取', async () => {
  const sm = makeManager();
  await sm.saveTask({ id: 'task_x', status: 'running', keyword: 'k', config: {}, progress: {}, createdAt: 1, startedAt: null, completedAt: null, errors: [] });
  const notes = [
    { id: 'n1', taskId: 'task_x', url: 'u1', title: 'A', content: 'ca', author: 'au1', commentList: [], collectedAt: 100 },
    { id: 'n2', taskId: 'task_x', url: 'u2', title: 'B', content: 'cb', author: 'au2', commentList: [], collectedAt: 200 },
    { id: 'n3', taskId: 'other', url: 'u3', title: 'C', content: 'cc', author: 'au3', commentList: [], collectedAt: 300 },
  ];
  for (const n of notes) {
    await sm.saveNote(n);
  }
  const got = await sm.getNotesByTaskId('task_x');
  assert.equal(got.length, 2, '应只返回属于 task_x 的笔记');
  const ids = got.map((n) => n.id).sort();
  assert.deepEqual(ids, ['n1', 'n2']);
  // 验证数据完整（含 commentList 等字段）
  const n1 = got.find((n) => n.id === 'n1');
  assert.equal(n1.title, 'A');
  assert.equal(n1.url, 'u1');
});

test('getNotesByTaskId 对无笔记的任务返回空数组', async () => {
  const sm = makeManager();
  const got = await sm.getNotesByTaskId('task_empty');
  assert.deepEqual(got, []);
});

test('saveConfig + getConfig 可正确往返配置键值', async () => {
  const sm = makeManager();
  await sm.saveConfig('apiKey', 'sk-123');
  await sm.saveConfig('prefs', { theme: 'dark', limit: 10 });
  assert.equal(await sm.getConfig('apiKey'), 'sk-123');
  assert.deepEqual(await sm.getConfig('prefs'), { theme: 'dark', limit: 10 });
});

test('getConfig 对未设置的 key 返回 undefined', async () => {
  const sm = makeManager();
  assert.equal(await sm.getConfig('missing'), undefined);
});

test('getLatestTask 返回最新创建的任务，若无任务返回 null', async () => {
  const sm = makeManager();
  assert.equal(await sm.getLatestTask(), null);
  await sm.saveTask({ id: 't1', createdAt: 100, status: 'completed' });
  await sm.saveTask({ id: 't2', createdAt: 200, status: 'completed' });
  await sm.saveTask({ id: 't0', createdAt: 50, status: 'completed' });
  const latest = await sm.getLatestTask();
  assert.equal(latest.id, 't2');
});

test('getRecentNotes 按 collectedAt 倒序返回指定条数笔记', async () => {
  const sm = makeManager();
  await sm.saveNote({ id: 'n1', taskId: 't1', collectedAt: 10, title: 'Note 1' });
  await sm.saveNote({ id: 'n2', taskId: 't1', collectedAt: 20, title: 'Note 2' });
  await sm.saveNote({ id: 'n3', taskId: 't1', collectedAt: 30, title: 'Note 3' });
  const notes = await sm.getRecentNotes(2);
  assert.equal(notes.length, 2);
  assert.equal(notes[0].id, 'n3');
  assert.equal(notes[1].id, 'n2');
});

