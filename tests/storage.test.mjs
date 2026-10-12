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

test('getLatestTask 正确兼容 timestamps.createdAt 结构的真实任务', async () => {
  const sm = makeManager();
  // 故意让较早创建的任务 ID 在字母序上排在前面
  await sm.saveTask({ id: 'task_aaa_early', timestamps: { createdAt: 1000 }, status: 'completed' });
  await sm.saveTask({ id: 'task_zzz_latest', timestamps: { createdAt: 2000 }, status: 'completed' });
  const latest = await sm.getLatestTask();
  assert.equal(latest.id, 'task_zzz_latest', '应返回最新创建的任务 task_zzz_latest');
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

test('getAllTasks 返回按 createdAt 降序排列的任务列表', async () => {
  const sm = makeManager();
  await sm.saveTask({ id: 't1', timestamps: { createdAt: 100 }, status: 'completed' });
  await sm.saveTask({ id: 't2', timestamps: { createdAt: 300 }, status: 'completed' });
  await sm.saveTask({ id: 't3', timestamps: { createdAt: 200 }, status: 'completed' });
  const tasks = await sm.getAllTasks();
  assert.equal(tasks.length, 3);
  assert.equal(tasks[0].id, 't2');
  assert.equal(tasks[1].id, 't3');
  assert.equal(tasks[2].id, 't1');
});

test('getAllNotes 返回按 collectedAt 降序排列的所有笔记', async () => {
  const sm = makeManager();
  await sm.saveNote({ id: 'n1', taskId: 't1', collectedAt: 10, title: 'Note 1' });
  await sm.saveNote({ id: 'n2', taskId: 't2', collectedAt: 30, title: 'Note 2' });
  await sm.saveNote({ id: 'n3', taskId: 't1', collectedAt: 20, title: 'Note 3' });
  const notes = await sm.getAllNotes();
  assert.equal(notes.length, 3);
  assert.equal(notes[0].id, 'n2');
  assert.equal(notes[1].id, 'n3');
  assert.equal(notes[2].id, 'n1');
});

test('deleteTasks 批量删除指定任务并级联删除关联的笔记', async () => {
  const sm = makeManager();
  await sm.saveTask({ id: 't1', status: 'completed' });
  await sm.saveTask({ id: 't2', status: 'completed' });
  await sm.saveTask({ id: 't3', status: 'completed' });

  await sm.saveNote({ id: 'n1', taskId: 't1' });
  await sm.saveNote({ id: 'n2', taskId: 't1' });
  await sm.saveNote({ id: 'n3', taskId: 't2' });
  await sm.saveNote({ id: 'n4', taskId: 't3' });

  // 批量删除 t1 和 t2
  const deletedCount = await sm.deleteTasks(['t1', 't2']);
  assert.equal(deletedCount, 2, '应成功删除 2 个任务');

  assert.equal(await sm.getTask('t1'), null, 't1 应已删除');
  assert.equal(await sm.getTask('t2'), null, 't2 应已删除');
  assert.notEqual(await sm.getTask('t3'), null, 't3 应当保留');

  const notesT1 = await sm.getNotesByTaskId('t1');
  const notesT2 = await sm.getNotesByTaskId('t2');
  const notesT3 = await sm.getNotesByTaskId('t3');
  assert.deepEqual(notesT1, [], 't1 关联笔记应已删除');
  assert.deepEqual(notesT2, [], 't2 关联笔记应已删除');
  assert.equal(notesT3.length, 1, 't3 关联笔记应保留');
});

test('deleteTasks 传入空数组或不存在的任务 ID 时安全执行', async () => {
  const sm = makeManager();
  const res1 = await sm.deleteTasks([]);
  assert.equal(res1, 0);
  const res2 = await sm.deleteTasks(['non_existent']);
  assert.equal(res2, 0);
});

