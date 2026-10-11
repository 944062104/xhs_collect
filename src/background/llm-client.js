// LLMClient — 将小红书网页 HTML 片段结构化为可用数据的模块。
//
// 设计约定（与仓库其它 background 模块一致）：
// - 本文件为 ES module（manifest 中 background.type === "module"）。
// - 使用浏览器 Service Worker / Node 22 原生提供的全局 fetch，不引入任何 HTTP 依赖。
// - 不做缓存、不做流式；每个方法 = 清洗 HTML + 调一次 API + 解析/轻量校验。
//
// 对外 API：
//   new LLMClient(apiKey, model = 'claude-3-5-sonnet-latest')
//   extractNoteList(htmlSnippet)   -> Array<{title,url,author,likes,type}>
//   extractNoteDetail(htmlSnippet) -> {title,content,author,likes,tags,images}
//   extractComments(htmlSnippet)   -> Array<{author,text,likes,publishedAt}>

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-3-5-sonnet-latest';
const MAX_TOKENS = 4096;
const REQUEST_TIMEOUT_MS = 60000; // 防止连接挂起导致 Service Worker 被无声卡死

// ----------------------------------------------------------------------------
// HTML 预清洗：去除 <script>/<style>/<svg> 块与 data: URI，降低 token 成本并提升鲁棒性。
// ----------------------------------------------------------------------------
export function cleanHtml(html) {
  if (typeof html !== 'string') return '';
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/data:[^"')\s]+/gi, ' ') // 去除 data: URI（如 base64 内联资源）
    .replace(/\s+/g, ' ')
    .trim();
}

// ----------------------------------------------------------------------------
// JSON 容错解析
// ----------------------------------------------------------------------------

// 去除 ```json / ``` 代码围栏。
function stripFences(s) {
  return s
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
}

// 在文本中找到最外层平衡的 {..} 或 [..] 片段（尊重字符串与转义）。
// 从指定开括号位置 start 开始扫描，匹配对应的闭合括号。
function extractBracketSpan(text, open, close, start) {
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// 选择文本中【最早出现】的开括号作为最外层容器（数组/对象的首括号一定先于内部元素），
// 避免误把数组内第一个对象的 {} 当成整体返回。
function extractBalancedSpan(text) {
  const iBrace = text.indexOf('{');
  const iBracket = text.indexOf('[');
  if (iBrace === -1 && iBracket === -1) return null;
  if (iBrace === -1) return extractBracketSpan(text, '[', ']', iBracket);
  if (iBracket === -1) return extractBracketSpan(text, '{', '}', iBrace);
  if (iBracket < iBrace) return extractBracketSpan(text, '[', ']', iBracket);
  return extractBracketSpan(text, '{', '}', iBrace);
}

// 去除尾随逗号（}, ] 之前的逗号），作为 JSON 修复的最后兜底。
function removeTrailingCommas(s) {
  return s.replace(/,(\s*[}\]])/g, '$1');
}

function tryParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * 从模型输出中尽可能稳健地解析出 JSON。
 * 处理顺序：直接解析 -> 去除代码围栏 -> 平衡括号提取 -> 去除尾随逗号修复。
 * 若最终仍无法解析，抛出带上下文的明确错误。
 */
export function extractJson(text) {
  if (typeof text !== 'string') {
    throw new Error(`extractJson 需要字符串输入，收到 ${typeof text}`);
  }
  const stripped = stripFences(text);
  let candidate = tryParse(stripped);
  if (candidate !== undefined) return candidate;

  const span = extractBalancedSpan(stripped);
  if (span) {
    candidate = tryParse(span) ?? tryParse(removeTrailingCommas(span));
    if (candidate !== undefined) return candidate;
  }

  candidate = tryParse(removeTrailingCommas(stripped));
  if (candidate !== undefined) return candidate;

  throw new Error(
    `无法从模型输出中解析出 JSON（已尝试去除代码围栏 / 平衡括号提取 / 去除尾随逗号）。原始片段：${text.slice(0, 200)}`
  );
}

// ----------------------------------------------------------------------------
// System Prompt 与字段说明（每个方法独立，聚焦单一任务）
// ----------------------------------------------------------------------------

const SYSTEM_NOTE_LIST = `你是一个小红书网页数据提取器。用户会提供一段网页 HTML 片段（已去除脚本与样式），请从中提取笔记列表。
只输出 JSON 数组，每个元素包含字段：
- title：笔记标题（字符串）
- url：笔记链接（字符串，尽量保留相对或绝对路径）
- author：作者昵称（字符串）
- likes：点赞数（数字或字符串）
- type：类型（如 "图文" 或 "视频"）
不要输出代码围栏或任何解释文字，只输出可被 JSON.parse 解析的纯 JSON。`;

const SYSTEM_NOTE_DETAIL = `你是一个小红书网页数据提取器。用户会提供一段单篇笔记详情页的 HTML 片段（已去除脚本与样式），请提取该笔记的结构化信息。
只输出 JSON 对象，包含字段：
- title：标题
- content：正文内容
- author：作者昵称
- likes：点赞数（数字或字符串）
- tags：标签数组（字符串数组）
- images：图片链接数组（字符串数组）
不要输出代码围栏或任何解释文字，只输出可被 JSON.parse 解析的纯 JSON。`;

const SYSTEM_NOTE_COMMENTS = `你是一个小红书网页数据提取器。用户会提供一段笔记评论区的 HTML 片段（已去除脚本与样式），请提取评论列表。
只输出 JSON 数组，每个元素包含字段：
- author：评论者昵称
- text：评论内容
- likes：点赞数（数字或字符串）
- publishedAt：发布时间（字符串，尽量保留原文）
不要输出代码围栏或任何解释文字，只输出可被 JSON.parse 解析的纯 JSON。`;

const STRICT_RETRY_NOTE = '\n\n【重试】严格要求：仅输出纯 JSON，禁止使用代码围栏、不要添加任何解释文字。';

// ----------------------------------------------------------------------------
// LLMClient
// ----------------------------------------------------------------------------

export class LLMClient {
  constructor(apiKeyOrOpts, modelOpt = DEFAULT_MODEL) {
    let apiKey = '';
    let model = DEFAULT_MODEL;
    let apiBase = '';
    let protocol = 'auto';

    if (typeof apiKeyOrOpts === 'object' && apiKeyOrOpts !== null) {
      apiKey = apiKeyOrOpts.apiKey;
      model = apiKeyOrOpts.model || DEFAULT_MODEL;
      apiBase = apiKeyOrOpts.apiBase || apiKeyOrOpts.baseUrl || '';
      protocol = apiKeyOrOpts.protocol || 'auto';
    } else {
      apiKey = apiKeyOrOpts;
      model = modelOpt || DEFAULT_MODEL;
    }

    if (!apiKey || typeof apiKey !== 'string') {
      throw new Error('LLMClient 需要一个非空的 apiKey');
    }
    this.apiKey = apiKey;
    this.model = model;

    const trimmedBase = (apiBase || '').trim().replace(/\/+$/, '');

    // 显式指定协议优先：
    if (protocol === 'openai') {
      this.protocol = 'openai';
      if (!trimmedBase) {
        this.apiUrl = 'https://api.openai.com/v1/chat/completions';
      } else if (trimmedBase.includes('/chat/completions')) {
        this.apiUrl = trimmedBase;
      } else {
        this.apiUrl = trimmedBase.endsWith('/v1') ? `${trimmedBase}/chat/completions` : `${trimmedBase}/v1/chat/completions`;
      }
    } else if (protocol === 'anthropic') {
      this.protocol = 'anthropic';
      if (!trimmedBase) {
        this.apiUrl = API_URL;
      } else if (trimmedBase.includes('/messages')) {
        this.apiUrl = trimmedBase;
      } else {
        this.apiUrl = trimmedBase.endsWith('/v1') ? `${trimmedBase}/messages` : `${trimmedBase}/v1/messages`;
      }
    } else {
      // 自动识别 (auto)：
      const isExplicitOpenAi =
        /\/chat\/completions\b/i.test(trimmedBase) ||
        /openai/i.test(trimmedBase) ||
        /deepseek|qwen|glm|moonshot|yi|baichuan|gpt/i.test(model);
      const isExplicitAnthropic =
        /anthropic|claude/i.test(trimmedBase) ||
        /claude/i.test(model) ||
        apiKey.startsWith('sk-ant-');

      if (!trimmedBase) {
        // 无 apiBase 时：如果显式用 OpenAI 格式（如 gpt 开头或标准 sk- key 且不是 sk-ant-），默认走 OpenAI
        if (isExplicitOpenAi || (apiKey.startsWith('sk-') && !apiKey.startsWith('sk-ant-') && !isExplicitAnthropic)) {
          this.protocol = 'openai';
          this.apiUrl = 'https://api.openai.com/v1/chat/completions';
        } else {
          this.protocol = 'anthropic';
          this.apiUrl = API_URL;
        }
      } else if (trimmedBase.includes('/chat/completions')) {
        this.protocol = 'openai';
        this.apiUrl = trimmedBase;
      } else if (trimmedBase.includes('/messages')) {
        this.protocol = 'anthropic';
        this.apiUrl = trimmedBase;
      } else if (isExplicitAnthropic) {
        this.protocol = 'anthropic';
        this.apiUrl = trimmedBase.endsWith('/v1') ? `${trimmedBase}/messages` : `${trimmedBase}/v1/messages`;
      } else if (isExplicitOpenAi) {
        this.protocol = 'openai';
        this.apiUrl = trimmedBase.endsWith('/v1') ? `${trimmedBase}/chat/completions` : `${trimmedBase}/v1/chat/completions`;
      } else if (apiKey.startsWith('sk-') && !apiKey.startsWith('sk-ant-')) {
        this.protocol = 'openai';
        this.apiUrl = trimmedBase.endsWith('/v1')
          ? `${trimmedBase}/chat/completions`
          : `${trimmedBase}/v1/chat/completions`;
      } else {
        this.protocol = 'anthropic';
        this.apiUrl = trimmedBase.endsWith('/v1') ? `${trimmedBase}/messages` : `${trimmedBase}/v1/messages`;
      }
    }
  }

  // 调用大模型 API（支持 Anthropic 与 OpenAI 兼容协议），返回文本字符串。
  async _callApi(systemPrompt, userPrompt) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res;

    const headers = {
      'content-type': 'application/json',
    };
    let bodyObj;

    if (this.protocol === 'openai') {
      headers['authorization'] = `Bearer ${this.apiKey}`;
      bodyObj = {
        model: this.model,
        messages: [
          ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
      };
    } else {
      headers['x-api-key'] = this.apiKey;
      headers['anthropic-version'] = '2023-06-01';
      bodyObj = {
        model: this.model,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      };
    }

    try {
      res = await fetch(this.apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(bodyObj),
        signal: controller.signal,
      });
    } catch (networkErr) {
      throw new Error(`LLM API 网络请求失败：${networkErr?.message || networkErr}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      let detail = '';
      try {
        const errBody = await res.json();
        if (errBody?.error?.message) detail = `: ${errBody.error.message}`;
        else if (typeof errBody?.error === 'string') detail = `: ${errBody.error}`;
        else if (errBody?.message) detail = `: ${errBody.message}`;
      } catch {
        /* 响应体非 JSON，忽略 */
      }
      throw new Error(`LLM API 请求失败：HTTP ${res.status}${detail}`);
    }

    const data = await res.json();

    // 提取响应文本
    if (this.protocol === 'openai') {
      const choice = data?.choices?.[0];
      const text = choice?.message?.content;
      if (typeof text !== 'string') {
        throw new Error('OpenAI 兼容 API 返回格式异常：缺少 choices[0].message.content');
      }
      return text;
    }

    // Anthropic 格式
    const textBlock = Array.isArray(data?.content)
      ? data.content.find((b) => b?.type === 'text')
      : null;
    const text = textBlock?.text;
    if (typeof text !== 'string') {
      throw new Error('Anthropic API 返回格式异常：缺少文本类型的 content 块');
    }
    return text;
  }

  // 调 API + 解析 JSON。仅当 API 调用【成功】但 JSON 解析失败时，
  // 以更严格的系统提示重试一次；网络/HTTP 错误不会进入此分支（直接上抛）。
  async _extract(systemPrompt, userPrompt) {
    const text = await this._callApi(systemPrompt, userPrompt);
    try {
      return extractJson(text);
    } catch {
      const strictText = await this._callApi(systemPrompt + STRICT_RETRY_NOTE, userPrompt);
      return extractJson(strictText); // 仍失败则抛出（已是解析错误，不再重试，避免死循环）
    }
  }

  _buildPrompt(instruction, cleanedHtml) {
    return `${instruction}\n\n以下是网页 HTML 片段：\n"""\n${cleanedHtml}\n"""`;
  }

  async extractNoteList(htmlSnippet) {
    const cleaned = cleanHtml(htmlSnippet);
    const prompt = this._buildPrompt('请提取该页面中的笔记列表。', cleaned);
    const data = await this._extract(SYSTEM_NOTE_LIST, prompt);
    if (!Array.isArray(data)) {
      throw new Error('extractNoteList 预期返回数组');
    }
    return data.map((it) => ({
      title: it?.title ?? '',
      url: it?.url ?? '',
      author: it?.author ?? '',
      likes: it?.likes ?? 0,
      type: it?.type ?? '',
    }));
  }

  async extractNoteDetail(htmlSnippet) {
    const cleaned = cleanHtml(htmlSnippet);
    const prompt = this._buildPrompt('请提取该笔记的详情信息。', cleaned);
    const data = await this._extract(SYSTEM_NOTE_DETAIL, prompt);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('extractNoteDetail 预期返回对象');
    }
    return {
      title: data.title ?? '',
      content: data.content ?? '',
      author: data.author ?? '',
      likes: data.likes ?? 0,
      tags: Array.isArray(data.tags) ? data.tags : [],
      images: Array.isArray(data.images) ? data.images : [],
    };
  }

  async extractComments(htmlSnippet) {
    const cleaned = cleanHtml(htmlSnippet);
    const prompt = this._buildPrompt('请提取该页面的评论列表。', cleaned);
    const data = await this._extract(SYSTEM_NOTE_COMMENTS, prompt);
    if (!Array.isArray(data)) {
      throw new Error('extractComments 预期返回数组');
    }
    return data.map((it) => ({
      author: it?.author ?? '',
      text: it?.text ?? '',
      likes: it?.likes ?? 0,
      publishedAt: it?.publishedAt ?? '',
    }));
  }

  // 测试连接：发送轻量请求验证 API Key / URL / 模型可用性
  async testConnection() {
    try {
      const text = await this._callApi('You are a ping tester.', 'Hello, reply with "OK".');
      return { ok: Boolean(text && text.length > 0) };
    } catch (err) {
      return { ok: false, error: err?.message || '连接失败' };
    }
  }
}

