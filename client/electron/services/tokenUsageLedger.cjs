const crypto = require('node:crypto');

const MAX_LEDGER_ENTRIES = 5000;

const STAGE_RULES = [
  { stage: 'tender-analysis', patterns: ['step02', '招标解析', '投标解析', '评分点解析', '废标', '资格'] },
  { stage: 'outline', patterns: ['step03', '目录', '大纲', 'outline'] },
  { stage: 'global-facts', patterns: ['step04', '全局事实', 'global-facts', '事实变量'] },
  { stage: 'content-planning', patterns: ['正文编排', '内容编排', 'content plan', 'chapter plan'] },
  { stage: 'content-generation', patterns: ['正文生成', '技术方案正文', '原方案优化扩写', '正文优化扩写', 'section-content'] },
  { stage: 'word-adjustment', patterns: ['字数调整', '扩写', '缩写', 'word adjustment'] },
  { stage: 'consistency', patterns: ['一致性', 'consistency', '事实冲突'] },
  { stage: 'table-cleanup', patterns: ['表格转换', '表格清理', 'table cleanup'] },
  { stage: 'original-restore', patterns: ['原方案还原', '原文归属', 'original restore', 'restore'] },
  { stage: 'illustration', patterns: ['配图', 'illustration', 'mermaid', '生图'] },
  { stage: 'json-repair', patterns: ['json修复', 'json repair', 'JSON修复'] },
];

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function inferStage(meta = {}) {
  const explicit = normalizeText(meta.stage || meta.token_stage || meta.phase);
  if (explicit) return explicit;

  const title = normalizeText(meta.logTitle || meta.log_title || meta.title);
  const haystack = title + ' ' + normalizeText(meta.moduleName || meta.module_name);
  for (const rule of STAGE_RULES) {
    if (rule.patterns.some((pattern) => haystack.toLowerCase().includes(String(pattern).toLowerCase()))) {
      return rule.stage;
    }
  }
  return 'other';
}

function inferSectionId(meta = {}) {
  const explicit = normalizeText(meta.sectionId || meta.section_id || meta.nodeId || meta.node_id);
  if (explicit) return explicit;
  const title = normalizeText(meta.logTitle || meta.log_title || meta.title);
  const match = title.match(/(?:^|[-_：: ])((?:\d+\.)+\d+)(?:$|[-_：: ])/);
  return match ? match[1] : '';
}

function measureMessages(messages) {
  let chars = 0;
  let messageCount = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    messageCount += 1;
    chars += String(message?.role || '').length;
    const content = message?.content;
    if (typeof content === 'string') {
      chars += content.length;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        chars += typeof part?.text === 'string'
          ? part.text.length
          : typeof part === 'string'
            ? part.length
            : JSON.stringify(part || '').length;
      }
    } else if (content !== undefined && content !== null) {
      chars += JSON.stringify(content).length;
    }
  }
  return { chars, message_count: messageCount };
}

function stableContextHash(messages) {
  try {
    return crypto.createHash('sha256').update(JSON.stringify(messages || [])).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}

function normalizePositiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function createEmptySnapshot() {
  return {
    request_count: 0,
    success_count: 0,
    error_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cached_tokens: 0,
    reasoning_tokens: 0,
    prompt_chars: 0,
    entries: [],
    by_stage: {},
    by_context_hash: {},
  };
}

let ledger = createEmptySnapshot();
const listeners = new Set();

function addAggregate(target, usage, promptChars) {
  target.request_count += 1;
  target.input_tokens += usage.input_tokens;
  target.output_tokens += usage.output_tokens;
  target.total_tokens += usage.total_tokens;
  target.cached_tokens += usage.cached_tokens;
  target.reasoning_tokens += usage.reasoning_tokens;
  target.prompt_chars += promptChars;
}

function normalizeUsage(usage = {}) {
  return {
    input_tokens: normalizePositiveInteger(usage.prompt_tokens ?? usage.input_tokens),
    output_tokens: normalizePositiveInteger(usage.completion_tokens ?? usage.output_tokens),
    total_tokens: normalizePositiveInteger(usage.total_tokens)
      || normalizePositiveInteger(usage.prompt_tokens ?? usage.input_tokens)
      + normalizePositiveInteger(usage.completion_tokens ?? usage.output_tokens),
    cached_tokens: normalizePositiveInteger(usage.cached_tokens),
    reasoning_tokens: normalizePositiveInteger(usage.reasoning_tokens),
  };
}

function emit() {
  const snapshot = getLedgerSnapshot();
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch {
      // 诊断统计不能阻断正文生成。
    }
  }
}

function recordTokenUsageEvent(meta = {}, usage = null, outcome = {}) {
  const normalizedUsage = normalizeUsage(usage || {});
  const measured = measureMessages(meta.messages || meta.requestMessages || []);
  const stage = inferStage(meta);
  const sectionId = inferSectionId(meta);
  const entry = {
    timestamp: new Date().toISOString(),
    request_id: normalizeText(meta.requestId || meta.request_id),
    stage,
    section_id: sectionId,
    batch_id: normalizeText(meta.batchId || meta.batch_id),
    log_title: normalizeText(meta.logTitle || meta.log_title || meta.title),
    model_provider: normalizeText(meta.modelProvider || meta.model_provider),
    model_name: normalizeText(meta.modelName || meta.model_name),
    request_mode: normalizeText(meta.requestMode || meta.request_mode),
    success: outcome.success !== false,
    duration_ms: Math.max(0, normalizePositiveInteger(outcome.durationMs ?? meta.durationMs)),
    input_tokens: normalizedUsage.input_tokens,
    output_tokens: normalizedUsage.output_tokens,
    total_tokens: normalizedUsage.total_tokens,
    cached_tokens: normalizedUsage.cached_tokens,
    cache_ratio: normalizedUsage.input_tokens > 0
      ? normalizedUsage.cached_tokens / normalizedUsage.input_tokens
      : 0,
    reasoning_tokens: normalizedUsage.reasoning_tokens,
    prompt_chars: measured.chars,
    message_count: measured.message_count,
    context_hash: stableContextHash(meta.messages || meta.requestMessages || []),
    retry_count: normalizePositiveInteger(meta.retryCount ?? meta.retry_count),
    error: normalizeText(outcome.error || meta.error).slice(0, 240),
  };

  addAggregate(ledger, normalizedUsage, measured.chars);
  if (entry.success) ledger.success_count += 1;
  else ledger.error_count += 1;

  if (!ledger.by_stage[stage]) {
    ledger.by_stage[stage] = {
      request_count: 0,
      success_count: 0,
      error_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      cached_tokens: 0,
      reasoning_tokens: 0,
      prompt_chars: 0,
    };
  }
  const stageAggregate = ledger.by_stage[stage];
  addAggregate(stageAggregate, normalizedUsage, measured.chars);
  if (entry.success) stageAggregate.success_count += 1;
  else stageAggregate.error_count += 1;

  if (entry.context_hash) {
    const contextAggregate = ledger.by_context_hash[entry.context_hash] || {
      request_count: 0,
      total_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      cached_tokens: 0,
      prompt_chars: 0,
      stages: {},
      last_seen: '',
    };
    contextAggregate.request_count += 1;
    contextAggregate.total_tokens += entry.total_tokens;
    contextAggregate.input_tokens += entry.input_tokens;
    contextAggregate.output_tokens += entry.output_tokens;
    contextAggregate.cached_tokens += entry.cached_tokens;
    contextAggregate.prompt_chars += entry.prompt_chars;
    contextAggregate.last_seen = entry.timestamp;
    contextAggregate.stages[entry.stage] = (contextAggregate.stages[entry.stage] || 0) + 1;
    ledger.by_context_hash[entry.context_hash] = contextAggregate;
  }

  ledger.entries.push(entry);
  if (ledger.entries.length > MAX_LEDGER_ENTRIES) {
    ledger.entries.splice(0, ledger.entries.length - MAX_LEDGER_ENTRIES);
  }
  emit();
  return entry;
}

function getLedgerSnapshot(options = {}) {
  const limit = normalizePositiveInteger(options.limit) || 200;
  const stage = normalizeText(options.stage);
  const entries = (stage
    ? ledger.entries.filter((entry) => entry.stage === stage)
    : ledger.entries
  ).slice(-Math.min(limit, MAX_LEDGER_ENTRIES));

  const byStage = {};
  for (const [name, aggregate] of Object.entries(ledger.by_stage)) {
    byStage[name] = {
      ...aggregate,
      cache_ratio: aggregate.input_tokens > 0
        ? aggregate.cached_tokens / aggregate.input_tokens
        : 0,
    };
  }

  const repeatedContexts = Object.entries(ledger.by_context_hash)
    .filter(([, aggregate]) => aggregate.request_count > 1)
    .sort((a, b) => (
      b[1].total_tokens - a[1].total_tokens
      || b[1].request_count - a[1].request_count
    ))
    .slice(0, 30)
    .map(([contextHash, aggregate]) => ({
      context_hash: contextHash,
      ...aggregate,
      cache_ratio: aggregate.input_tokens > 0 ? aggregate.cached_tokens / aggregate.input_tokens : 0,
    }));

  return {
    request_count: ledger.request_count,
    success_count: ledger.success_count,
    error_count: ledger.error_count,
    input_tokens: ledger.input_tokens,
    output_tokens: ledger.output_tokens,
    total_tokens: ledger.total_tokens,
    cached_tokens: ledger.cached_tokens,
    cache_ratio: ledger.input_tokens > 0 ? ledger.cached_tokens / ledger.input_tokens : 0,
    reasoning_tokens: ledger.reasoning_tokens,
    prompt_chars: ledger.prompt_chars,
    by_stage: byStage,
    repeated_contexts: repeatedContexts,
    entries,
  };
}

function resetLedger() {
  ledger = createEmptySnapshot();
  emit();
  return getLedgerSnapshot();
}

function onLedgerChanged(listener) {
  if (typeof listener !== 'function') return () => undefined;
  listeners.add(listener);
  return () => listeners.delete(listener);
}

module.exports = {
  inferStage,
  inferSectionId,
  measureMessages,
  recordTokenUsageEvent,
  getLedgerSnapshot,
  resetLedger,
  onLedgerChanged,
};
