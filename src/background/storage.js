// StorageManager — IndexedDB 本地存储层（ESM，供 background Service Worker 使用）。
//
// 约定：
// - 直接引用全局 `indexedDB`（浏览器原生提供；Node 测试通过 fake-indexeddb/auto 注入）。
// - 不 import indexedDB，以保证浏览器与测试环境使用同一套全局。
// - DB 仅打开一次并复用连接。

const DB_NAME = 'xhs-agent';
const DB_VERSION = 1;
const STORE_TASKS = 'tasks';
const STORE_NOTES = 'notes';
const STORE_CONFIG = 'config';

export class StorageManager {
  // dbName 可传入以隔离测试环境；默认使用正式库名。
  constructor(dbName = DB_NAME) {
    this._dbName = dbName;
    this._db = null;
  }

  // 打开（或复用）数据库连接，返回 Promise<IDBDatabase>。
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this._dbName, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_TASKS)) {
          const tasks = db.createObjectStore(STORE_TASKS, { keyPath: 'id' });
          tasks.createIndex('status', 'status', { unique: false });
          tasks.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_NOTES)) {
          const notes = db.createObjectStore(STORE_NOTES, { keyPath: 'id' });
          notes.createIndex('taskId', 'taskId', { unique: false });
          notes.createIndex('collectedAt', 'collectedAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_CONFIG)) {
          db.createObjectStore(STORE_CONFIG, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => {
        this._db = req.result;
        resolve(this._db);
      };
      req.onerror = () => reject(req.error);
    });
  }

  // 在指定 store 上执行事务。fn(store) 须【同步】发出 IDBRequest 并返回它，
  // 切勿在 fn 内用 Promise.then / await 延后请求——否则真实 Chrome 中事务会因
  // 控制权返回事件循环而被自动关闭，报 "transaction is not active"。
  _withStore(storeName, mode, fn) {
    return this.open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, mode);
          const store = tx.objectStore(storeName);
          let result;
          let request;
          try {
            request = fn(store); // 同步发出请求
          } catch (err) {
            reject(err);
            return;
          }
          if (request) {
            request.onsuccess = () => {
              result = request.result;
            };
            request.onerror = () => reject(request.error);
          }
          tx.oncomplete = () => resolve(result);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
        })
    );
  }

  // ---- Tasks ----

  async saveTask(task) {
    await this._withStore(STORE_TASKS, 'readwrite', (store) => store.put(task));
  }

  async getTask(id) {
    const rec = await this._withStore(STORE_TASKS, 'readonly', (store) => store.get(id));
    return rec || null;
  }

  // 返回当前 status === 'running' 的任务，没有则返回 null（取第一条）。
  async getRunningTask() {
    const list = await this._withStore(STORE_TASKS, 'readonly', (store) => store.index('status').getAll('running'));
    return list && list.length > 0 ? list[0] : null;
  }

  // 返回最新创建的任务（按 createdAt 降序），没有则返回 null。
  async getLatestTask() {
    const list = await this._withStore(STORE_TASKS, 'readonly', (store) => store.getAll());
    if (!list || list.length === 0) return null;
    list.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
    return list[0];
  }

  async updateTaskProgress(id, progress) {
    const task = await this.getTask(id);
    if (!task) throw new Error(`updateTaskProgress: task ${id} not found`);
    task.progress = progress;
    await this.saveTask(task);
  }

  // ---- Notes ----

  async saveNote(note) {
    await this._withStore(STORE_NOTES, 'readwrite', (store) => store.put(note));
  }

  async getNotesByTaskId(taskId) {
    return this._withStore(STORE_NOTES, 'readonly', (store) => store.index('taskId').getAll(taskId));
  }

  // 获取最近采集的笔记（按 collectedAt 降序），默认最多 limit 条
  async getRecentNotes(limit = 10) {
    const list = await this._withStore(STORE_NOTES, 'readonly', (store) => store.getAll());
    if (!list || list.length === 0) return [];
    list.sort((a, b) => (Number(b.collectedAt) || 0) - (Number(a.collectedAt) || 0));
    return list.slice(0, limit);
  }

  // ---- Config ----

  async saveConfig(key, val) {
    await this._withStore(STORE_CONFIG, 'readwrite', (store) => store.put({ key, val }));
  }

  async getConfig(key) {
    const rec = await this._withStore(STORE_CONFIG, 'readonly', (store) => store.get(key));
    return rec ? rec.val : undefined;
  }
}
