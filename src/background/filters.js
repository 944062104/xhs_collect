/**
 * filters.js - 小红书采集数据质量阈值过滤与日期解析模块
 */

/**
 * 将计数字符串或数值（如 1200, "1.2万", "3k", "500+"）转换为规范纯数字
 * @param {string|number} raw
 * @returns {number}
 */
export function parseCount(raw) {
  if (typeof raw === 'number') return isNaN(raw) ? 0 : raw;
  if (!raw) return 0;
  const s = String(raw).trim().replace(/,/g, '');
  if (/^\d+(\.\d+)?万$/.test(s)) {
    return Math.round(parseFloat(s) * 10000);
  }
  if (/^\d+(\.\d+)?[kK]$/.test(s)) {
    return Math.round(parseFloat(s) * 1000);
  }
  const m = s.match(/\d+/);
  return m ? parseInt(m[0], 10) : 0;
}

/**
 * 解析小红书多样化的发布时间字符串为毫秒时间戳
 * 格式包括：“刚刚”、“10分钟前”、“2小时前”、“昨天 14:00”、“3天前”、“03-12”、“2025-05-20”等
 * @param {string} dateStr
 * @param {number} [referenceTime=Date.now()]
 * @returns {number|null} 毫秒时间戳，解析失败返回 null
 */
export function parsePublishedDate(dateStr, referenceTime = Date.now()) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const raw = dateStr.trim().replace(/^(编辑于|发布于)\s*/, '');
  if (!raw) return null;

  const now = typeof referenceTime === 'number' ? new Date(referenceTime) : new Date();

  // 1. 刚刚
  if (raw === '刚刚') {
    return now.getTime();
  }

  // 2. X秒前 / X分钟前 / X小时前 / X天前
  let match = raw.match(/^(\d+)\s*秒前$/);
  if (match) {
    return now.getTime() - parseInt(match[1], 10) * 1000;
  }
  match = raw.match(/^(\d+)\s*分钟前$/);
  if (match) {
    return now.getTime() - parseInt(match[1], 10) * 60 * 1000;
  }
  match = raw.match(/^(\d+)\s*小时前$/);
  if (match) {
    return now.getTime() - parseInt(match[1], 10) * 3600 * 1000;
  }
  match = raw.match(/^(\d+)\s*天前$/);
  if (match) {
    return now.getTime() - parseInt(match[1], 10) * 86400 * 1000;
  }

  // 3. 昨天 / 前天 [HH:mm]
  match = raw.match(/^(昨天|前天)(?:\s+(\d{1,2}):(\d{1,2}))?$/);
  if (match) {
    const daysAgo = match[1] === '昨天' ? 1 : 2;
    const target = new Date(now.getTime());
    target.setDate(target.getDate() - daysAgo);
    if (match[2] !== undefined && match[3] !== undefined) {
      target.setHours(parseInt(match[2], 10), parseInt(match[3], 10), 0, 0);
    }
    return target.getTime();
  }

  // 4. 年-月-日 (如 2025-05-20, 2024/01/01)
  match = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (match) {
    const y = parseInt(match[1], 10);
    const m = parseInt(match[2], 10) - 1;
    const d = parseInt(match[3], 10);
    const dt = new Date(y, m, d);
    return dt.getTime();
  }

  // 5. 月-日 (如 03-12, 10/05)
  match = raw.match(/^(\d{1,2})[-/.](\d{1,2})/);
  if (match) {
    const m = parseInt(match[1], 10) - 1;
    const d = parseInt(match[2], 10);
    let dt = new Date(now.getFullYear(), m, d);
    // 如果算出的日期在未来，则说明是去年的该月日
    if (dt.getTime() > now.getTime()) {
      dt.setFullYear(now.getFullYear() - 1);
    }
    return dt.getTime();
  }

  // 6. 原生 Date.parse 尝试
  const parsed = Date.parse(raw);
  if (!isNaN(parsed)) {
    return parsed;
  }

  return null;
}

/**
 * 判断单篇笔记是否符合指定的数据质量门槛
 * @param {object} note 笔记对象 (含 likes, collects, totalComments, publishedAt)
 * @param {object} [thresholds] 过滤阈值配置
 * @param {number} [thresholds.minLikes] 最小点赞数
 * @param {number} [thresholds.minCollects] 最小收藏数
 * @param {number} [thresholds.minComments] 最小评论数
 * @param {number} [thresholds.minDate] 最早发布时间（毫秒时间戳）
 * @param {number} [referenceTime] 参考基准时间
 * @returns {{ pass: boolean, reason?: string }}
 */
export function isNoteMatchingThresholds(note, thresholds, referenceTime = Date.now()) {
  if (!note || !thresholds) return { pass: true };

  const { minLikes, minCollects, minComments, minDate } = thresholds;

  // 1. 点赞门槛
  if (minLikes !== undefined && minLikes !== null && minLikes > 0) {
    const likes = parseCount(note.likes);
    if (likes < minLikes) {
      return { pass: false, reason: `点赞数 (${likes}) 未达门槛 (${minLikes})` };
    }
  }

  // 2. 收藏门槛
  if (minCollects !== undefined && minCollects !== null && minCollects > 0) {
    const collects = parseCount(note.collects);
    if (collects < minCollects) {
      return { pass: false, reason: `收藏数 (${collects}) 未达门槛 (${minCollects})` };
    }
  }

  // 3. 评论门槛
  if (minComments !== undefined && minComments !== null && minComments > 0) {
    const comments = parseCount(note.totalComments ?? (Array.isArray(note.commentList) ? note.commentList.length : 0));
    if (comments < minComments) {
      return { pass: false, reason: `评论数 (${comments}) 未达门槛 (${minComments})` };
    }
  }

  // 4. 发布时间门槛
  if (minDate !== undefined && minDate !== null && minDate > 0) {
    const pubTime = parsePublishedDate(note.publishedAt, referenceTime);
    if (pubTime !== null && pubTime < minDate) {
      return { pass: false, reason: `发布时间早于指定门槛` };
    }
  }

  return { pass: true };
}
