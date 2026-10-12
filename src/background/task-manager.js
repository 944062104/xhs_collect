// TaskManager — 采集任务的状态机与生命周期管理（ESM，供 background Service Worker 使用）。
//
// 约定：
// - 依赖注入 StorageManager（真实或测试替身），自身不接触 indexedDB 全局。
// - 任务状态机：pending -> running -> completed | failed | cancelled
//   - failed -> running 允许重试（不重置 startedAt）
//   - cancelled / completed 为终态
// - 进度以嵌套对象 task.progress 维护，每次 CHECKPOINT 合并后持久化。

// 合法状态转移表。
const ALLOWED_TRANSITIONS = {
  pending: ['running'],
  running: ['completed', 'failed', 'cancelled'],
  failed: ['running'],
  cancelled: [], // 终态
  completed: [], // 终态
};

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];

export class TaskManager {
  constructor(storage) {
    if (!storage) throw new Error('TaskManager 需要注入 storage');
    this.storage = storage;
  }

  // 创建任务。config 缺省值：notesLimit=20, commentsPerNote=0, outputFormat='json'。
  async createTask(keyword, config = {}) {
    const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const task = {
      id,
      status: 'pending',
      keyword,
      createdAt: now,
      config: {
        notesLimit: config.notesLimit ?? 20,
        commentsPerNote: config.commentsPerNote ?? 0,
        outputFormat: config.outputFormat ?? 'json',
        ...config,
      },
      progress: {
        phase: 'idle',
        notesCollected: 0,
        notesTotal: 0,
        currentNoteIndex: -1,
        commentsCollected: 0,
        scrollCount: 0,
        noteUrls: [],
      },
      timestamps: {
        createdAt: now,
        startedAt: null,
        completedAt: null,
      },
      errors: [],
    };
    await this.storage.saveTask(task);
    return task;
  }

  // 校验并执行状态转移；同时维护时间戳。返回（被原地修改的）task。
  async updateStatus(task, status) {
    if (task.status === status) {
      // 相同状态视为幂等，无需转移也不报错。
      return task;
    }
    const allowed = ALLOWED_TRANSITIONS[task.status];
    if (!allowed || !allowed.includes(status)) {
      throw new Error(`非法状态转移: ${task.status} -> ${status}`);
    }
    const now = Date.now();
    if (status === 'running' && task.timestamps.startedAt == null) {
      task.timestamps.startedAt = now;
    }
    if (TERMINAL_STATUSES.includes(status)) {
      task.timestamps.completedAt = now;
    }
    task.status = status;
    await this.storage.saveTask(task);
    return task;
  }

  // 读取任务（透传 StorageManager）。
  async getTask(id) {
    return this.storage.getTask(id);
  }

  // 合并部分进度到 task.progress 并持久化（CHECKPOINT）。
  async saveProgress(task, progress) {
    task.progress = { ...task.progress, ...progress };
    await this.storage.updateTaskProgress(task.id, task.progress);
    return task;
  }
}
