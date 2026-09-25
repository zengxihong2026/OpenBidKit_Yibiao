const assert = require('node:assert/strict');
const ledger = require('./tokenUsageLedger.cjs');

ledger.resetLedger();

ledger.recordTokenUsageEvent({
  requestId: 'req-1',
  logTitle: '正文生成-1.2-施工组织',
  modelName: 'test-model',
  messages: [{ role: 'user', content: 'abc' }],
}, {
  prompt_tokens: 100,
  completion_tokens: 40,
  total_tokens: 140,
  cached_tokens: 80,
});

ledger.recordTokenUsageEvent({
  requestId: 'req-2',
  logTitle: '一致性审计-1.2',
  modelName: 'test-model',
  messages: [{ role: 'user', content: 'defgh' }],
}, {
  prompt_tokens: 200,
  completion_tokens: 20,
  total_tokens: 220,
  cached_tokens: 100,
}, { success: false, error: 'test' });

const snapshot = ledger.getLedgerSnapshot();
assert.equal(snapshot.request_count, 2);
assert.equal(snapshot.input_tokens, 300);
assert.equal(snapshot.output_tokens, 60);
assert.equal(snapshot.total_tokens, 360);
assert.equal(snapshot.cached_tokens, 180);
assert.equal(snapshot.by_stage['content-generation'].request_count, 1);
assert.equal(snapshot.by_stage.consistency.error_count, 1);
assert.equal(snapshot.entries[0].section_id, '1.2');
assert.equal(snapshot.entries[1].stage, 'consistency');

console.log('tokenUsageLedger tests passed');
