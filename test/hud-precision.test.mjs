import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildConversationHudMetrics,
  computeTps,
  formatHudUsd,
  formatTurnDurationCard,
  formatTurnDurationCompact,
  parseLatestGenMetadataBlob,
  ConversationMetricsEngine,
} from '../dist/hud.js';

const { DatabaseSync } = await import('node:sqlite');

function varint(value) {
  let remaining = BigInt(value);
  const bytes = [];
  do {
    const byte = Number(remaining & 127n);
    remaining >>= 7n;
    bytes.push(byte | (remaining ? 128 : 0));
  } while (remaining);
  return bytes;
}
const scalar = (field, value) => [...varint(field * 8), ...varint(value)];
const message = (field, bytes) => [...varint(field * 8 + 2), ...varint(bytes.length), ...bytes];
const string = (field, value) => message(field, Buffer.from(value));
function seconds(field, value) {
  const whole = Math.floor(value);
  return message(field, [...scalar(1, whole), ...scalar(2, Math.round((value - whole) * 1e9))]);
}

function usage(overrides = {}) {
  return {
    rawInputTokens: 100, cachedReadTokens: 200, cacheWriteTokens: 30,
    outputTokens: 120, reasoningTokens: 80, candidateTokens: 40,
    ...overrides,
  };
}
function usageBytes(value) {
  return [
    ...scalar(2, value.rawInputTokens), ...scalar(3, value.outputTokens),
    ...scalar(4, value.cacheWriteTokens), ...scalar(5, value.cachedReadTokens),
    ...scalar(9, value.reasoningTokens), ...scalar(10, value.candidateTokens),
  ];
}
function step(overrides = {}) {
  return {
    idx: 50, stepType: 15, status: 3, hasUsage: true,
    startTimeSeconds: 100, firstTokenSeconds: 109, endTimeSeconds: 110,
    ...usage(), ...overrides,
  };
}
const metrics = (steps, overrides = {}) => buildConversationHudMetrics({
  conversationId: 'precision', sessionRevision: 1, modelId: 'gemini-3.8-flash',
  steps, ...overrides,
});
function closeTo(actual, expected, label = '') {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);
}

test('TPS uses total output / total full request duration, not a mean of step rates', () => {
  const result = metrics([
    step({ outputTokens: 100, generation: { timeToFirstTokenSeconds: 2, streamingDurationSeconds: 8 } }),
    step({ idx: 51, outputTokens: 900, generation: { timeToFirstTokenSeconds: 0.5, streamingDurationSeconds: 1.5 } }),
  ]);
  closeTo(result.session.outputTps, 1000 / 12, 'weighted TPS');
  assert.notEqual(result.session.outputTps, (100 / 10 + 900 / 2) / 2);
  assert.equal(result.session.modelDurationSeconds, 12);
  assert.equal(result.session.outputTpsFormatted, '83.3 tok/s');
});

test('authoritative generation durations beat timestamps and never infer thinking phases', () => {
  const result = metrics([step({
    outputTokens: 65352, reasoningTokens: 50329, candidateTokens: 15023,
    startTimeSeconds: 100, firstTokenSeconds: 1278.91, endTimeSeconds: 1463,
    generation: { timeToFirstTokenSeconds: 2.25, streamingDurationSeconds: 7.75 },
  })]);
  assert.equal(result.session.modelDurationSeconds, 10);
  assert.equal(result.session.outputTps, 6535.2);
  assert.equal(result.session.averageTtftSeconds, 2.25);
  const fallback = metrics([step({
    outputTokens: 65352, reasoningTokens: 50329, candidateTokens: 15023,
    startTimeSeconds: 100, firstTokenSeconds: 1278.91, endTimeSeconds: 1463,
  })]);
  closeTo(fallback.session.outputTps, 65352 / 1363);
  closeTo(fallback.session.averageTtftSeconds, 1178.91);
});

test('missing timing, active steps and missing usage never leak output into the timed numerator', () => {
  const result = metrics([
    step({ outputTokens: 120 }),
    step({ idx: 51, startTimeSeconds: null, endTimeSeconds: null, outputTokens: 9000 }),
    ...[1, 2, 8, 9].map((status, i) => step({
      idx: 52 + i, status, outputTokens: 1000,
      generation: { timeToFirstTokenSeconds: 1, streamingDurationSeconds: 1 },
    })),
    step({ idx: 56, hasUsage: false, outputTokens: 3000 }),
  ]);
  assert.equal(result.tokens.outputTokens, 16120, 'the cumulative ledger still includes reported output');
  assert.equal(result.session.outputTps, 12);
  assert.equal(result.session.modelDurationSeconds, 20, 'completed duration without usage remains observable');
  assert.equal(result.session.averageTtftSeconds, 9);
});

test('zero output with valid usage contributes its completed duration', () => {
  const result = metrics([step({ outputTokens: 100 }), step({ idx: 51, outputTokens: 0 })]);
  assert.equal(result.session.outputTps, 5);
});

test('raw TTFT zero survives protobuf parsing and participates in the average', () => {
  const raw = parseLatestGenMetadataBlob(Buffer.from(message(1, [
    ...message(11, []), ...seconds(12, 2),
  ])));
  assert.equal(raw.timeToFirstTokenSeconds, 0, 'an empty Duration is an explicit zero');
  const zero = metrics([step({ generation: raw })]);
  assert.equal(zero.session.averageTtftSeconds, 0);
  assert.equal(zero.session.averageTtftFormatted, '0 秒');
  assert.equal(zero.session.averageTtftFormattedEn, '0s');
  const average = metrics([
    step({ generation: raw }),
    step({ idx: 51, firstTokenSeconds: 104 }),
    step({ idx: 52, firstTokenSeconds: null }),
    step({ idx: 53, status: 2, generation: { timeToFirstTokenSeconds: 100 } }),
  ]);
  assert.equal(average.session.averageTtftSeconds, 2);
});

test('incomplete raw duration pairs fall back to step timestamps, while raw TTFT stays authoritative', () => {
  const result = metrics([step({ generation: { timeToFirstTokenSeconds: 0 } })]);
  assert.equal(result.session.outputTps, 12);
  assert.equal(result.session.modelDurationSeconds, 10);
  assert.equal(result.session.averageTtftSeconds, 0);
});

test('TPS has no 500 tok/s cap or artificial minimum duration', () => {
  const result = computeTps(0.001, 100);
  assert.equal(result.status, 'calculated');
  assert.equal(result.rawTps, 100000);
  assert.equal(result.outputTps, 100000);
  assert.equal(result.formatted, '100K tok/s');
  assert.equal(metrics([step({
    outputTokens: 1000, generation: { timeToFirstTokenSeconds: 0, streamingDurationSeconds: 0.25 },
  })]).session.outputTps, 4000);
  for (const duration of [0, -1, NaN, Infinity]) {
    assert.equal(computeTps(duration, 100).status, 'pending_or_fallback');
  }
});

test('invalid token values and reversed intervals cannot create a TPS sample', () => {
  for (const outputTokens of [-1, 1.5, NaN, Infinity]) {
    const result = metrics([step({ outputTokens })]);
    assert.equal(result.session.outputTpsFormatted, '—');
    assert.equal(result.tokens.outputTokens, 0);
  }
  const reversed = metrics([step({ endTimeSeconds: 99 })]);
  assert.equal(reversed.session.modelDurationSeconds, 0);
  assert.equal(reversed.session.outputTpsFormatted, '—');
});

test('actual context is independent of generator estimates and output tokens', () => {
  for (const estimatedTokensUsed of [1, 190000]) {
    const result = metrics([step({ outputTokens: 99999 })], {
      genMetadata: { estimatedTokensUsed, systemTokens: 90000, maxContextTokens: 1000 },
    });
    assert.equal(result.context.hasUsageData, true);
    assert.equal(result.context.usedTokens, 330);
    assert.equal(result.context.breakdown.cachedContextTokens, 200);
    assert.equal(result.context.breakdown.uncachedContextTokens, 130);
    assert.equal(result.context.breakdown.latestOutputTokens, 99999);
    assert.equal(result.context.usedRatio, 0.33);
    assert.equal(result.context.usedRatioFormatted, '33%');
  }
});

test('missing context usage differs from an explicitly reported zero input', () => {
  const missing = metrics([], { genMetadata: { estimatedTokensUsed: 90000 } });
  assert.equal(missing.context.hasUsageData, false);
  assert.equal(missing.context.usedTokens, 0);
  const zero = metrics([step({ ...usage({ rawInputTokens: 0, cachedReadTokens: 0, cacheWriteTokens: 0 }) })]);
  assert.equal(zero.context.hasUsageData, true);
  assert.equal(zero.context.usedTokens, 0);
});

test('an observed 226412-token context never guesses 256K or clamps the reported ratio', () => {
  const result = metrics([step({ rawInputTokens: 8312, cachedReadTokens: 218100, cacheWriteTokens: 0 })]);
  assert.equal(result.context.usedTokens, 226412);
  assert.equal(result.context.peakContextTokens, 226412);
  assert.equal(result.context.capacityTokens, 200000);
  assert.equal(result.context.capacityTokensCompact, '~200K');
  assert.equal(result.context.isFallbackCapacity, true);
  assert.equal(result.context.hasExplicitDbCapacity, false);
  closeTo(result.context.usedRatio, 1.13206);
  assert.equal(result.context.usedRatioFormatted, '113%');
  for (const overrides of [
    { modelCapacity: 262144 }, { genMetadata: { maxContextTokens: 262144 } },
  ]) {
    const explicit = metrics([step()], overrides);
    assert.equal(explicit.context.capacityTokens, 262144);
    assert.equal(explicit.context.isFallbackCapacity, false);
    assert.equal(explicit.context.hasExplicitDbCapacity, true);
  }
});

test('contextSteps isolates parent context, peak, compactions and turns from child accounting', () => {
  const main = [
    { stepType: 14, status: 3 },
    step({ rawInputTokens: 1000 }),
    { stepType: 23, status: 3 },
    { stepType: 23, status: 2 },
    step({ idx: 51 }),
    step({ idx: 52, hasUsage: false, rawInputTokens: 999999 }),
  ];
  const child = [
    { stepType: 14, status: 3 }, { stepType: 23, status: 3 },
    step({ rawInputTokens: 900000, modelMaxTokens: 1000000 }),
  ];
  const result = metrics([...main, ...child], { contextSteps: main });
  assert.equal(result.session.turns, 1);
  assert.equal(result.session.compactionCount, 1);
  assert.equal(result.session.modelSteps, 4);
  assert.equal(result.context.usedTokens, 330);
  assert.equal(result.context.peakContextTokens, 1230);
  assert.equal(result.context.capacityTokens, 200000);
  assert.equal(result.tokens.uncachedInputTokens, 1000 + 100 + 999999 + 900000);
});

function databaseFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gravitybox-hud-precision-'));
  const databases = [];
  t.after(() => {
    for (const db of databases) db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  function create(id, { parentBlob, legacy = false } = {}) {
    const db = new DatabaseSync(path.join(directory, `${id}.db`));
    databases.push(db);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL,
        status INTEGER NOT NULL, metadata BLOB, render_info BLOB, step_payload BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER NOT NULL DEFAULT 0);
    `);
    if (!legacy) {
      db.exec(`
        CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT, trajectory_type INTEGER);
        CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
      `);
      db.prepare('INSERT INTO trajectory_meta VALUES (?, ?, ?)').run(id, id, 0);
      if (parentBlob) db.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', parentBlob);
    }
    return db;
  }
  return { create, engine: new ConversationMetricsEngine({ conversationsDir: directory }) };
}
const ids = {
  main: '11111111-1111-4111-8111-111111111111',
  child: '22222222-2222-4222-8222-222222222222',
  grandchild: '33333333-3333-4333-8333-333333333333',
  leaf: '44444444-4444-4444-8444-444444444444',
  unrelated: '55555555-5555-4555-8555-555555555555',
  impostor: '66666666-6666-4666-8666-666666666666',
};
const parentMetadata = (parent, root = ids.main) => Buffer.from([
  ...string(5, parent), ...string(6, root),
]);
function insertStep(db, { idx = 50, value = usage(), execution = 'execution-a', timing = true, status = 3 } = {}) {
  const metadata = Buffer.from([
    ...(timing ? [...seconds(1, 100), ...seconds(6, 109), ...seconds(7, 110)] : []),
    ...message(9, usageBytes(value)), ...string(12, execution),
  ]);
  db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, 15, ?, ?)').run(idx, status, metadata);
}
function generationBlob({ indices = [50], packed = true, execution = 'execution-a', value = usage(), ttft = 0, streaming = 2 } = {}) {
  return Buffer.from([
    ...message(1, [
      ...message(4, usageBytes(value)), ...seconds(11, ttft), ...seconds(12, streaming),
      ...string(19, 'gemini-3.8-flash'),
    ]),
    ...(packed ? message(2, indices.flatMap(varint)) : indices.flatMap(index => scalar(2, index))),
    ...string(4, execution),
  ]);
}
function insertGeneration(db, options = {}, idx = 1) {
  const data = generationBlob(options);
  db.prepare('INSERT INTO gen_metadata VALUES (?, ?, ?)').run(idx, data, data.length);
}
function invoke(db, idx, children, { payload = false, name = 'invoke_subagent' } = {}) {
  const metadata = Buffer.from(message(4, string(2, name)));
  const references = Buffer.from(string(5, children.join(' ')));
  db.prepare('INSERT INTO steps (idx, step_type, status, metadata, render_info, step_payload) VALUES (?, ?, 3, ?, ?, ?)')
    .run(idx, name === 'invoke_subagent' ? 127 : 21, metadata, payload ? null : references, payload ? references : null);
}

for (const packed of [true, false]) {
  test(`SQLite links gen idx=1 to step idx=50 using ${packed ? 'packed' : 'unpacked'} step_indices`, async t => {
    const { create, engine } = databaseFixture(t);
    const db = create(ids.main);
    insertStep(db);
    insertGeneration(db, { packed, indices: [49, 50] });
    const result = await engine.getConversationMetrics({ conversationId: ids.main });
    assert.equal(result.session.steps, 1);
    assert.equal(result.session.modelDurationSeconds, 2);
    assert.equal(result.session.outputTps, 60);
    assert.equal(result.session.averageTtftSeconds, 0);
  });
}

test('SQLite permits distinct steps sharing one execution ID without deduplicating their generations', async t => {
  const { create, engine } = databaseFixture(t);
  const db = create(ids.main);
  insertStep(db);
  const second = usage({ outputTokens: 900, reasoningTokens: 600, candidateTokens: 300 });
  insertStep(db, { idx: 51, value: second });
  insertGeneration(db, { ttft: 2, streaming: 8 });
  insertGeneration(db, { indices: [51], value: second, ttft: 0, streaming: 2 }, 2);
  const result = await engine.getConversationMetrics({ conversationId: ids.main });
  assert.equal(result.tokens.outputTokens, 1020);
  assert.equal(result.session.modelDurationSeconds, 12);
  assert.equal(result.session.outputTps, 85);
  assert.equal(result.session.averageTtftSeconds, 1);
});

for (const [label, options] of [
  ['execution mismatch', { execution: 'execution-b' }],
  ['usage mismatch', { value: usage({ cachedReadTokens: 201 }) }],
  ['unrelated step index', { indices: [999] }],
  ['ambiguous model steps', { indices: [50, 51] }],
]) {
  test(`SQLite rejects generation timing on ${label}`, async t => {
    const { create, engine } = databaseFixture(t);
    const db = create(ids.main);
    insertStep(db);
    if (label === 'ambiguous model steps') insertStep(db, { idx: 51 });
    insertGeneration(db, options);
    const result = await engine.getConversationMetrics({ conversationId: ids.main });
    assert.equal(result.session.outputTps, 12, 'use step timing, never borrow the unrelated 2-second gen');
    assert.equal(result.session.averageTtftSeconds, 9);
  });
}

test('SQLite concurrent repeated reads do not accumulate steps or output', async t => {
  const { create, engine } = databaseFixture(t);
  const db = create(ids.main);
  insertStep(db);
  insertGeneration(db);
  for (let batch = 0; batch < 3; batch++) {
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      engine.getConversationMetrics({ conversationId: ids.main })));
    for (const result of results) {
      assert.equal(result.session.steps, 1);
      assert.equal(result.tokens.totalTokens, 450);
      assert.equal(result.session.outputTps, 60);
      assert.equal(result.session.modelDurationSeconds, 2);
    }
  }
  assert.equal(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy, 0);
});

test('SQLite refreshes late generation timing written at the same gen idx', async t => {
  const { create, engine } = databaseFixture(t);
  const db = create(ids.main);
  insertStep(db);
  db.prepare('INSERT INTO gen_metadata VALUES (1, ?, 0)').run(Buffer.alloc(0));
  const before = await engine.getConversationMetrics({ conversationId: ids.main });
  assert.equal(before.session.outputTps, 12);
  const data = generationBlob({ ttft: 0.25, streaming: 1.75 });
  db.prepare('UPDATE gen_metadata SET data = ?, size = ? WHERE idx = 1').run(data, data.length);

  const after = await engine.getConversationMetrics({ conversationId: ids.main });
  assert.equal(after.session.outputTps, 60);
  assert.equal(after.session.averageTtftSeconds, 0.25);
  assert.equal(after.session.steps, 1);
  assert.equal(after.tokens.totalTokens, before.tokens.totalTokens);
});

test('SQLite reads adjacent protobuf parent field 5 and root field 6 without regex word boundaries', async t => {
  const { create, engine } = databaseFixture(t);
  const main = create(ids.main);
  const blob = parentMetadata(ids.main, ids.unrelated);
  assert.equal(blob[38], 0x32, 'field 6 tag immediately follows the 36-byte parent UUID');
  const child = create(ids.child, { parentBlob: blob });
  insertStep(main);
  insertStep(child, { value: usage({ outputTokens: 500 }) });
  invoke(main, 51, [ids.child]);
  const result = await engine.getConversationMetrics({ conversationId: ids.main });
  assert.equal(result.session.subagentCount, 1);
  assert.equal(result.session.subagentSteps, 1);
  assert.equal(result.tokens.outputTokens, 620);
});

test('SQLite recursively aggregates three descendant levels once, rejects cycles and unrelated UUIDs', async t => {
  const { create, engine } = databaseFixture(t);
  const main = create(ids.main);
  const child = create(ids.child, { parentBlob: parentMetadata(ids.main) });

  const grandchild = create(ids.grandchild, { parentBlob: parentMetadata(ids.main) });
  const leaf = create(ids.leaf, { parentBlob: parentMetadata(ids.grandchild) });
  const unrelated = create(ids.unrelated, { parentBlob: parentMetadata(ids.impostor, ids.impostor) });
  const impostor = create(ids.impostor, { parentBlob: Buffer.from([
    ...string(1, `body mentions ${ids.main}`),
    ...string(5, `${ids.main}suffix`), ...string(6, ids.unrelated),
  ]) });
  for (const [db, input, output] of [
    [main, 1000, 100], [child, 90000, 200], [grandchild, 150000, 300],
    [leaf, 500000, 400], [unrelated, 999999, 9000], [impostor, 999999, 9000],
  ]) {
    db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (1, 14, 3)').run();
    db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (2, 23, 3)').run();
    insertStep(db, { value: usage({ rawInputTokens: input, outputTokens: output }) });
  }
  invoke(main, 51, [ids.child, ids.impostor, ids.unrelated]);
  invoke(main, 52, [ids.unrelated], { name: 'run_command' });
  invoke(child, 51, [ids.grandchild], { payload: true });
  invoke(grandchild, 51, [ids.leaf]);
  invoke(leaf, 51, [ids.main, ids.child]);
  const result = await engine.getConversationMetrics({
    conversationId: ids.main, childConversationIds: [ids.unrelated],
  });
  assert.equal(result.session.subagentCount, 3);
  assert.equal(result.session.subagentSteps, 12);
  assert.equal(result.session.steps, 17);
  assert.equal(result.tokens.outputTokens, 1000);
  assert.equal(result.tokens.uncachedInputTokens, 741000);
  assert.equal(result.session.turns, 1);
  assert.equal(result.session.compactionCount, 1);
  assert.equal(result.context.usedTokens, 1230);
  assert.equal(result.context.peakContextTokens, 1230);
  assert.equal(result.context.capacityTokens, 200000);
});

test('SQLite ignores UUIDs in metadata body, nested fields and non-exact parent fields', async t => {
  const { create, engine } = databaseFixture(t);
  const main = create(ids.main);
  insertStep(main);
  const badBlobs = [
    Buffer.from(string(1, ids.main)),
    Buffer.from(message(1, string(5, ids.main))),
    Buffer.from(string(5, ` ${ids.main}`)),
    Buffer.from(string(6, `${ids.main}suffix`)),
  ];
  for (const [index, blob] of badBlobs.entries()) {
    const id = [ids.child, ids.grandchild, ids.leaf, ids.impostor][index];
    const child = create(id, { parentBlob: blob });
    insertStep(child);
    invoke(main, 51 + index, [id]);
  }
  const result = await engine.getConversationMetrics({ conversationId: ids.main });
  assert.equal(result.session.subagentCount, 0);
  assert.equal(result.session.subagentSteps, 0);
  assert.equal(result.tokens.outputTokens, 120);
});

test('SQLite legacy child without parent metadata tables needs an explicit tool reference, not a DOM hint', async t => {
  const { create, engine } = databaseFixture(t);
  const main = create(ids.main);
  const child = create(ids.child, { legacy: true });
  insertStep(main);
  insertStep(child);
  const hinted = await engine.getConversationMetrics({ conversationId: ids.main, childConversationIds: [ids.child] });
  assert.equal(hinted.session.subagentSteps, 0);
  invoke(main, 51, [ids.child]);
  const explicit = await engine.getConversationMetrics({ conversationId: ids.main });
  assert.equal(explicit.session.subagentCount, 1);
  assert.equal(explicit.session.subagentSteps, 1);
  assert.equal(explicit.tokens.outputTokens, 240);
});

test('SQLite refreshes a parent reference written after the first child lookup', async t => {
  const { create, engine } = databaseFixture(t);
  const main = create(ids.main);
  const child = create(ids.child);
  insertStep(main);
  insertStep(child);
  invoke(main, 51, [ids.child]);
  const before = await engine.getConversationMetrics({ conversationId: ids.main });
  assert.equal(before.session.subagentCount, 0);
  child.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', parentMetadata(ids.main));
  const after = await engine.getConversationMetrics({ conversationId: ids.main });
  assert.equal(after.session.subagentCount, 1);
  assert.equal(after.tokens.outputTokens, 240);
});

test('SQLite drops removed child references and replays generations after timeline shrink', async t => {
  const { create, engine } = databaseFixture(t);
  const main = create(ids.main);
  const child = create(ids.child, { parentBlob: parentMetadata(ids.main) });
  insertStep(main);
  insertStep(child);
  insertGeneration(main, { ttft: 1, streaming: 1 });
  invoke(main, 51, [ids.child]);
  const before = await engine.getConversationMetrics({ conversationId: ids.main });
  assert.equal(before.session.subagentCount, 1);
  main.exec('DELETE FROM steps WHERE idx = 51; DELETE FROM gen_metadata');
  insertGeneration(main, { ttft: 2, streaming: 2 }, 0);
  const after = await engine.getConversationMetrics({ conversationId: ids.main });
  assert.equal(after.session.subagentCount, 0);
  assert.equal(after.session.steps, 1);
  assert.equal(after.session.outputTps, 30);
});

test('activityPhase separates model generating (solid blue), script executing (breathing blue), and idle (gray)', () => {
  const idleResult = metrics([step({ idx: 1, stepType: 14 }), step({ idx: 2, stepType: 15, status: 3 })], {
    isStreaming: false,
    allowDbActiveStepInference: true,
  });
  assert.equal(idleResult.activityPhase, 'idle');

  const modelGenerating = metrics(
    [
      step({ idx: 1, stepType: 14 }),
      step({ idx: 2, stepType: 15, status: 8, endTimeSeconds: null }),
    ],
    { isStreaming: true, allowDbActiveStepInference: true }
  );
  assert.equal(modelGenerating.activityPhase, 'generating');

  const scriptExecuting = metrics(
    [
      step({ idx: 1, stepType: 14 }),
      step({ idx: 2, stepType: 15, status: 3 }),
      step({ idx: 3, stepType: 21, status: 2, endTimeSeconds: null }),
    ],
    { isStreaming: true, allowDbActiveStepInference: true }
  );
  assert.equal(scriptExecuting.activityPhase, 'executing');
});

test('本轮用时 (Current Turn Duration) 精准切分与模型/工具耗时分解', () => {
  // 第 1 轮：step 1 (USER_INPUT), step 2 (PLANNER_RESPONSE 耗时 10s)
  // 第 2 轮：step 3 (USER_INPUT), step 4 (PLANNER_RESPONSE 思考/生成耗时 14.2s), step 5 (工具执行耗时 4.2s)
  const result = metrics([
    step({ idx: 1, stepType: 14, startTimeSeconds: 100, endTimeSeconds: 100 }),
    step({ idx: 2, stepType: 15, status: 3, startTimeSeconds: 100, endTimeSeconds: 110, rawInputTokens: 50, outputTokens: 20 }),
    step({ idx: 3, stepType: 14, startTimeSeconds: 200, endTimeSeconds: 200 }),
    step({
      idx: 4,
      stepType: 15,
      status: 3,
      startTimeSeconds: 200,
      endTimeSeconds: 214.2,
      rawInputTokens: 100,
      outputTokens: 50,
      generation: { timeToFirstTokenSeconds: 2.2, streamingDurationSeconds: 12.0 },
    }),
    step({ idx: 5, stepType: 21, status: 3, startTimeSeconds: 214.2, endTimeSeconds: 218.4 }),
  ]);

  // 全会话累计
  assert.equal(result.session.turns, 2);
  assert.equal(Number(result.session.modelDurationSeconds.toFixed(1)), 24.2);
  assert.equal(Number(result.session.toolDurationSeconds.toFixed(1)), 4.2);

  // 本轮用时切分
  assert.equal(Number(result.session.currentTurnModelDurationSeconds.toFixed(1)), 14.2);
  assert.equal(Number(result.session.currentTurnToolDurationSeconds.toFixed(1)), 4.2);
  assert.equal(Number(result.session.currentTurnDurationSeconds.toFixed(1)), 18.4);
  assert.equal(result.session.currentTurnDurationFormatted, '18秒');
  assert.equal(result.session.currentTurnDurationFormattedEn, '18s');
  assert.equal(result.session.currentTurnDurationCompactZh, '本轮 18s');
  assert.equal(result.session.currentTurnDurationCompactEn, 'Turn 18s');
});

test('本轮用时常驻栏与展开卡片格式规则（s/m/h 与汉字时分秒，省略零分零秒，非活跃旧库不推算 now-start）', () => {
  assert.equal(formatTurnDurationCompact(0, 'zh'), '本轮 0s');
  assert.equal(formatTurnDurationCompact(1, 'zh'), '本轮 1s');
  assert.equal(formatTurnDurationCompact(59, 'zh'), '本轮 59s');
  assert.equal(formatTurnDurationCompact(60, 'zh'), '本轮 1m');
  assert.equal(formatTurnDurationCompact(637, 'zh'), '本轮 10m');
  assert.equal(formatTurnDurationCompact(3600, 'zh'), '本轮 1h');
  assert.equal(formatTurnDurationCompact(3661, 'zh'), '本轮 1h1m');
  assert.equal(formatTurnDurationCompact(3661, 'en'), 'Turn 1h1m');

  assert.equal(formatTurnDurationCard(0, 'zh'), '0秒');
  assert.equal(formatTurnDurationCard(18.4, 'zh'), '18秒');
  assert.equal(formatTurnDurationCard(59.96, 'zh'), '1分');
  assert.equal(formatTurnDurationCard(61, 'zh'), '1分1秒');
  assert.equal(formatTurnDurationCard(119.96, 'en'), '2m');
  assert.equal(formatTurnDurationCard(3600, 'zh'), '1小时');
  assert.equal(formatTurnDurationCard(3600, 'en'), '1h');
  assert.equal(formatTurnDurationCard(3601, 'zh'), '1小时1秒');
  assert.equal(formatTurnDurationCard(3660, 'zh'), '1小时1分');
  assert.equal(formatTurnDurationCard(3661.2, 'zh'), '1小时1分1秒');
  assert.equal(formatTurnDurationCard(3661.2, 'en'), '1h1m1s');

  const staleDbMetrics = metrics(
    [
      step({ idx: 1, stepType: 14 }),
      step({ idx: 2, stepType: 15, status: 1, startTimeSeconds: 1000, endTimeSeconds: null }),
    ],
    { isStreaming: false, allowDbActiveStepInference: false }
  );
  assert.equal(staleDbMetrics.session.currentTurnDurationSeconds, 0);
});

test('长耗时工具运行超5分钟且带占位end时间戳、即使DOM进入空闲也不得回退冻结本轮用时', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-hud-long-tool-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const convId = 'long-running-tool';
  const dbPath = path.join(tmp, `${convId}.db`);
  const nowSec = Date.now() / 1000;
  const toolStartSec = nowSec - 600; // 工具已持续运行 10 分钟 (>5 分钟)

  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,status INTEGER,metadata BLOB); CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);');
  db.prepare('INSERT INTO steps VALUES(0,14,3,NULL)').run();
  const modelMeta = Buffer.from([...seconds(1, toolStartSec - 188), ...seconds(7, toolStartSec)]);
  db.prepare('INSERT INTO steps VALUES(1,15,3,?)').run(modelMeta);
  const runningToolMeta = Buffer.from([...seconds(1, toolStartSec), ...seconds(7, toolStartSec + 0.002)]);
  db.prepare('INSERT INTO steps VALUES(2,132,2,?)').run(runningToolMeta);
  db.close();

  const tenMinAgo = new Date(Date.now() - 600_000);
  fs.utimesSync(dbPath, tenMinAgo, tenMinAgo);

  const engine = new ConversationMetricsEngine({ conversationsDir: tmp });
  const result = await engine.getConversationMetrics({
    conversationId: convId,
    isStreaming: false,
    activityPhase: 'idle',
  });
  // 后台工具活跃时 isStreaming=true 维持轮询与本轮计时，但前台模型未运行因此 activityPhase 保持 idle（灰色）
  assert.equal(result.isStreaming, true);
  assert.equal(result.activityPhase, 'idle');
  assert.ok(
    result.session.currentTurnDurationSeconds >= 780,
    `应持续累计 188s + 600s (>=780s)，不能回退冻结在 188s，实际 ${result.session.currentTurnDurationSeconds}`
  );
  assert.ok(result.session.inFlightToolDurationSeconds >= 599);
});

test('异步与并行子智能体期间本轮用时不暂停、不重复叠加且完成后不回退', () => {
  const nowSec = Date.now() / 1000;
  const turnStart = nowSec - 23;
  // 场景 1: 异步 invoke_subagent 本身仅耗时 0.02s，后台子智能体运行至当前时刻 (总墙钟 23s)
  const mainSteps = [
    step({ idx: 0, stepType: 14, startTimeSeconds: null, endTimeSeconds: null }),
    step({ idx: 1, stepType: 15, status: 3, startTimeSeconds: turnStart, endTimeSeconds: turnStart + 10, rawInputTokens: 50, outputTokens: 20 }),
    step({ idx: 2, stepType: 132, status: 3, isSubagentStep: true, toolCallName: 'invoke_subagent', startTimeSeconds: turnStart + 10, endTimeSeconds: turnStart + 10.02 }),
    step({ idx: 3, stepType: 15, status: 3, startTimeSeconds: turnStart + 10.02, endTimeSeconds: turnStart + 20, rawInputTokens: 60, outputTokens: 15 }),
  ];
  const childRunningSteps = [
    step({ idx: 0, stepType: 14 }),
    step({ idx: 1, stepType: 15, status: 2, startTimeSeconds: turnStart + 10.05, endTimeSeconds: null }),
  ];
  const activeSubagentMetrics = buildConversationHudMetrics({
    conversationId: 'subagent-active-wall',
    isStreaming: false,
    isSubagentRunning: true,
    runningSubagentCount: 1,
    contextSteps: mainSteps,
    steps: [...mainSteps, ...childRunningSteps],
  });
  assert.ok(
    activeSubagentMetrics.session.currentTurnDurationSeconds >= 22.8,
    `子智能体后台运行 23s 时不能冻结在 20s，实际 ${activeSubagentMetrics.session.currentTurnDurationSeconds}`
  );

  // 场景 2: 两个并行子智能体同时跑 20s，本轮用时应按墙钟区间合并为 20s，而非 40s
  const parallelSteps = [
    step({ idx: 0, stepType: 14, startTimeSeconds: 100, endTimeSeconds: 100 }),
    step({ idx: 1, stepType: 132, status: 3, isSubagentStep: true, startTimeSeconds: 100, endTimeSeconds: 120 }),
    step({ idx: 2, stepType: 132, status: 3, isSubagentStep: true, startTimeSeconds: 100, endTimeSeconds: 120 }),
  ];
  const parallelMetrics = buildConversationHudMetrics({
    conversationId: 'subagent-parallel-wall',
    isStreaming: false,
    isSubagentRunning: false,
    contextSteps: parallelSteps,
    steps: parallelSteps,
  });
  assert.equal(Number(parallelMetrics.session.currentTurnDurationSeconds.toFixed(1)), 20);
});

test('进行中模型与工具耗时通过 inFlight 字段实时可观测，且不污染已完成累计值与 TPS', () => {
  const nowSec = Date.now() / 1000;
  const activeSteps = [
    step({ idx: 0, stepType: 14, startTimeSeconds: nowSec - 20, endTimeSeconds: nowSec - 20 }),
    step({
      idx: 1,
      stepType: 15,
      status: 3,
      startTimeSeconds: nowSec - 20,
      endTimeSeconds: nowSec - 10,
      outputTokens: 500,
      generation: { timeToFirstTokenSeconds: 2, streamingDurationSeconds: 8 },
    }),
    step({
      idx: 2,
      stepType: 15,
      status: 2,
      startTimeSeconds: nowSec - 4,
      endTimeSeconds: null,
      hasUsage: false,
      outputTokens: 0,
    }),
    step({
      idx: 3,
      stepType: 21,
      status: 2,
      startTimeSeconds: nowSec - 6,
      endTimeSeconds: null,
    }),
  ];
  const live = metrics(activeSteps, { isStreaming: true, allowDbActiveStepInference: true });
  assert.equal(live.session.modelDurationSeconds, 10, '已完成模型用时不得混入未完结步骤');
  assert.equal(live.session.outputTps, 50, 'TPS 仍仅基于已完成计时请求');
  assert.equal(live.session.activeModelStepCount, 1);
  assert.ok(live.session.inFlightModelDurationSeconds >= 3.8 && live.session.inFlightModelDurationSeconds <= 6);
  assert.equal(live.session.toolDurationSeconds, 0);
  assert.equal(live.session.activeToolStepCount, 1);
  assert.ok(live.session.inFlightToolDurationSeconds >= 5.8 && live.session.inFlightToolDurationSeconds <= 8);

  const stale = metrics(activeSteps, { isStreaming: false, allowDbActiveStepInference: false });
  assert.equal(stale.session.activeModelStepCount, 0);
  assert.equal(stale.session.inFlightModelDurationSeconds, 0);
  assert.equal(stale.session.activeToolStepCount, 0);
  assert.equal(stale.session.inFlightToolDurationSeconds, 0);
});

test('主对话模型停止时即使子智能体仍在运行，activityPhase 也保持 idle 而保留子智能体标识与计时', () => {
  const nowSec = Date.now() / 1000;
  const activeWithSubagent = buildConversationHudMetrics({
    conversationId: 'subagent-only-idle-dot',
    isStreaming: false,
    activityPhase: 'idle',
    isSubagentRunning: true,
    runningSubagentCount: 1,
    steps: [
      step({ idx: 0, stepType: 14, startTimeSeconds: nowSec - 15, endTimeSeconds: nowSec - 15 }),
      step({ idx: 1, stepType: 15, status: 3, startTimeSeconds: nowSec - 15, endTimeSeconds: nowSec - 5, outputTokens: 100 }),
    ],
  });
  assert.equal(activeWithSubagent.isSubagentRunning, true);
  assert.equal(activeWithSubagent.isStreaming, true);
  assert.equal(activeWithSubagent.activityPhase, 'idle');

  const foregroundExecuting = buildConversationHudMetrics({
    conversationId: 'foreground-tool-executing',
    isStreaming: true,
    activityPhase: 'executing',
    steps: [
      step({ idx: 0, stepType: 14, startTimeSeconds: nowSec - 10, endTimeSeconds: nowSec - 10 }),
      step({ idx: 1, stepType: 21, status: 2, startTimeSeconds: nowSec - 3, endTimeSeconds: null }),
    ],
  });
  assert.equal(foregroundExecuting.activityPhase, 'executing');
});

test('latestStepOutputTps 真实记录最近一个完结前台模型步速度，不被短工具步均值与子智能体步骤覆盖', () => {
  const shortSteps = Array.from({ length: 6 }, (_, i) =>
    step({
      idx: i * 2 + 1,
      stepType: 15,
      status: 3,
      startTimeSeconds: 100 + i * 4,
      endTimeSeconds: 100 + i * 4 + 3.4,
      outputTokens: 150,
      generation: { timeToFirstTokenSeconds: 3.2, streamingDurationSeconds: 0.2 },
    })
  );
  const longFinalStep = step({
    idx: 16,
    stepType: 15,
    status: 3,
    startTimeSeconds: 200,
    endTimeSeconds: 224.12,
    outputTokens: 4324,
    generation: { timeToFirstTokenSeconds: 0.12, streamingDurationSeconds: 24.0 },
  });
  const pendingNextStep = step({
    idx: 17,
    stepType: 15,
    status: 2,
    startTimeSeconds: 225,
    endTimeSeconds: null,
    hasUsage: false,
    outputTokens: 0,
  });
  const subagentWorkerStep = step({
    idx: 18,
    stepType: 15,
    status: 3,
    isSubagentStep: true,
    startTimeSeconds: 226,
    endTimeSeconds: 236,
    outputTokens: 100,
    generation: { timeToFirstTokenSeconds: 5, streamingDurationSeconds: 5 },
  });

  const fgSteps = [step({ idx: 0, stepType: 14 }), ...shortSteps, longFinalStep, pendingNextStep];
  const res = buildConversationHudMetrics({
    conversationId: 'latest-step-tps-isolated',
    isStreaming: true,
    activityPhase: 'generating',
    contextSteps: fgSteps,
    steps: [...fgSteps, subagentWorkerStep],
  });

  // 全会话累计均速被前 6 步与子智能体摊薄，但 latestStepOutputTps 忠实锁定前台最近完结的第 16 步 (4324 / 24.12 ≈ 179.27 tok/s)
  assert.ok(res.session.outputTps < 120, `均速应低于长步单步速度，实际 ${res.session.outputTps}`);
  assert.ok(
    Math.abs((res.session.latestStepOutputTps || 0) - 4324 / 24.12) < 0.01,
    `latestStepOutputTps 应精确等于 4324 / 24.12，实际 ${res.session.latestStepOutputTps}`
  );
  assert.equal(res.session.latestStepOutputTpsFormatted, '179 tok/s');

  // 无有效计时步骤时，不应编造 latestStepOutputTps
  const untimed = buildConversationHudMetrics({
    conversationId: 'latest-step-tps-empty',
    isStreaming: true,
    steps: [step({ idx: 0, stepType: 14 }), pendingNextStep],
  });
  assert.equal(untimed.session.latestStepOutputTps, undefined);
  assert.equal(untimed.session.latestStepOutputTpsFormatted, undefined);
  assert.equal(untimed.session.currentTurnOutputTps, 0);
  assert.equal(untimed.session.currentTurnOutputTpsFormatted, '计算中...');
  assert.equal(untimed.session.currentTurnTimedSamples, 0);
});

test('currentTurnOutputTps 仅统计本轮已完结前台模型步并隔离历史轮次与子智能体步骤', () => {
  const prevTurnStep = step({
    idx: 1,
    stepType: 15,
    status: 3,
    startTimeSeconds: 10,
    endTimeSeconds: 30,
    outputTokens: 600,
    generation: { timeToFirstTokenSeconds: 1, streamingDurationSeconds: 19 },
  });
  const turnStep1 = step({
    idx: 3,
    stepType: 15,
    status: 3,
    startTimeSeconds: 50,
    endTimeSeconds: 55,
    outputTokens: 500,
    generation: { timeToFirstTokenSeconds: 1, streamingDurationSeconds: 4 },
  });
  const turnStep2 = step({
    idx: 4,
    stepType: 15,
    status: 3,
    startTimeSeconds: 60,
    endTimeSeconds: 70,
    outputTokens: 1500,
    generation: { timeToFirstTokenSeconds: 2, streamingDurationSeconds: 8 },
  });
  const subagentStep = step({
    idx: 5,
    stepType: 15,
    status: 3,
    isSubagentStep: true,
    startTimeSeconds: 72,
    endTimeSeconds: 92,
    outputTokens: 200,
    generation: { timeToFirstTokenSeconds: 10, streamingDurationSeconds: 10 },
  });

  const fgSteps = [
    step({ idx: 0, stepType: 14 }),
    prevTurnStep,
    step({ idx: 2, stepType: 14 }),
    turnStep1,
    turnStep2,
  ];
  const res = buildConversationHudMetrics({
    conversationId: 'current-turn-tps-isolated',
    isStreaming: false,
    contextSteps: fgSteps,
    steps: [...fgSteps, subagentStep],
  });

  // 本轮仅汇总 turnStep1 (500 / 5s) 与 turnStep2 (1500 / 10s) => 2000 / 15 ≈ 133.33 tok/s
  assert.equal(res.session.currentTurnTimedSamples, 2);
  assert.ok(
    Math.abs((res.session.currentTurnOutputTps || 0) - 2000 / 15) < 0.01,
    `currentTurnOutputTps 应为 2000 / 15，实际 ${res.session.currentTurnOutputTps}`
  );
  assert.equal(res.session.currentTurnOutputTpsFormatted, '133 tok/s');
  assert.equal(res.session.latestStepOutputTpsFormatted, '150 tok/s');
  assert.ok((res.session.outputTps || 0) < 100, `全会话均速受上一轮与子智能体拉低，实际 ${res.session.outputTps}`);
});

test('并行工具与并行子智能体时长按物理区间去重，且不影响 TPS 累计口径', () => {
  const baseSec = Date.now() / 1000 - 10;
  const parallelTools = Array.from({ length: 6 }, (_, i) =>
    step({
      idx: 3 + i,
      stepType: 21,
      status: 2,
      startTimeSeconds: baseSec + 5,
      endTimeSeconds: baseSec + 5.002,
      toolCallName: 'edit_file',
      hasUsage: false,
      rawInputTokens: 0,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      candidateTokens: 0,
    })
  );
  const modelStep = step({
    idx: 2,
    stepType: 15,
    status: 3,
    startTimeSeconds: baseSec,
    endTimeSeconds: baseSec + 5,
    outputTokens: 500,
    generation: { timeToFirstTokenSeconds: 1, streamingDurationSeconds: 4 },
  });
  const baseSteps = [step({ idx: 1, stepType: 14, startTimeSeconds: baseSec, endTimeSeconds: baseSec }), modelStep];

  const running = metrics([...baseSteps, ...parallelTools], {
    isStreaming: true,
    allowDbActiveStepInference: true,
  });
  assert.equal(running.session.activeToolStepCount, 6);
  assert.ok(
    running.session.inFlightToolDurationSeconds >= 4.9 && running.session.inFlightToolDurationSeconds < 6,
    `6 个并行活跃工具仅计 ~5s，实际 ${running.session.inFlightToolDurationSeconds}`
  );
  assert.ok(
    running.session.currentTurnToolDurationSeconds >= 4.9 && running.session.currentTurnToolDurationSeconds < 6,
    `本轮并行工具用时应 ~5s，实际 ${running.session.currentTurnToolDurationSeconds}`
  );
  assert.ok(
    running.session.currentTurnDurationSeconds >= 9.9 && running.session.currentTurnDurationSeconds < 11,
    `本轮总用时应为 5s(模型)+5s(并行工具)=~10s，实际 ${running.session.currentTurnDurationSeconds}`
  );
  assert.equal(running.session.outputTps, 100);

  const finishedTools = parallelTools.map((tool) => ({
    ...tool,
    status: 3,
    endTimeSeconds: baseSec + 10,
  }));
  const completed = metrics([...baseSteps, ...finishedTools], {
    isStreaming: false,
  });
  assert.equal(completed.session.toolDurationSeconds, 5);
  assert.equal(completed.session.inFlightToolDurationSeconds, 0);
  assert.equal(completed.session.currentTurnToolDurationSeconds, 5);
  assert.equal(completed.session.currentTurnDurationSeconds, 10);
  assert.equal(completed.session.outputTps, 100);

  // 并行子智能体：一个完成 [childBase, childBase+10]，一个活跃 [childBase, now]（elapsed ~12s） => inFlight 仅计增量 ~2s
  const childBase = Date.now() / 1000 - 12;
  const mainTurn = [
    step({ idx: 1, stepType: 14, startTimeSeconds: childBase, endTimeSeconds: childBase }),
    step({ idx: 2, stepType: 127, status: 2, startTimeSeconds: childBase, endTimeSeconds: childBase + 0.01, hasUsage: false }),
  ];
  const childDone = step({
    idx: 1,
    stepType: 15,
    status: 3,
    startTimeSeconds: childBase,
    endTimeSeconds: childBase + 10,
    outputTokens: 200,
  });
  const childActive = step({
    idx: 1,
    stepType: 15,
    status: 8,
    startTimeSeconds: childBase,
    endTimeSeconds: null,
    outputTokens: 0,
  });
  const childParallel = metrics([...mainTurn, childDone, childActive], {
    contextSteps: mainTurn,
    isStreaming: true,
    isSubagentRunning: true,
    allowDbActiveStepInference: true,
  });
  assert.equal(childParallel.session.modelDurationSeconds, 10);
  assert.ok(
    childParallel.session.inFlightModelDurationSeconds >= 1.9 && childParallel.session.inFlightModelDurationSeconds < 3,
    `并行子智能体重叠部分不得重复计入 inFlight，实际 ${childParallel.session.inFlightModelDurationSeconds}`
  );
});

test('历史轮次残留未闭合步与 status=6/7 终止态步不污染 activeCount 与 inFlight', () => {
  const turn2Base = Date.now() / 1000 - 10;
  const result = metrics(
    [
      step({ idx: 1, stepType: 14, startTimeSeconds: 10, endTimeSeconds: 10 }),
      step({ idx: 2, stepType: 132, status: 2, startTimeSeconds: 10, endTimeSeconds: null, hasUsage: false }),
      step({ idx: 3, stepType: 132, status: 6, startTimeSeconds: 15, endTimeSeconds: null, hasUsage: false }),
      step({ idx: 10, stepType: 14, startTimeSeconds: turn2Base, endTimeSeconds: turn2Base }),
      step({ idx: 11, stepType: 15, status: 3, startTimeSeconds: turn2Base, endTimeSeconds: turn2Base + 5, outputTokens: 100 }),
      step({ idx: 12, stepType: 132, status: 7, startTimeSeconds: turn2Base + 5, endTimeSeconds: null, hasUsage: false }),
    ],
    { isStreaming: true, allowDbActiveStepInference: true }
  );
  assert.equal(result.session.activeModelStepCount, 0);
  assert.equal(result.session.activeToolStepCount, 0);
  assert.equal(result.session.inFlightModelDurationSeconds, 0);
  assert.equal(result.session.inFlightToolDurationSeconds, 0);
  assert.equal(result.session.currentTurnDurationSeconds, 5);
});

test('latestStepTtft 仅取最近已完结前台模型步并隔离历史步与子智能体', () => {
  const olderFg = step({
    idx: 1,
    stepType: 15,
    status: 3,
    startTimeSeconds: 10,
    endTimeSeconds: 20,
    generation: { timeToFirstTokenSeconds: 4.5, streamingDurationSeconds: 5.5 },
  });
  const latestFg = step({
    idx: 3,
    stepType: 15,
    status: 3,
    startTimeSeconds: 30,
    endTimeSeconds: 38,
    generation: { timeToFirstTokenSeconds: 1.244, streamingDurationSeconds: 6.756 },
  });
  const subagentLater = step({
    idx: 4,
    stepType: 15,
    status: 3,
    isSubagentStep: true,
    startTimeSeconds: 40,
    endTimeSeconds: 50,
    generation: { timeToFirstTokenSeconds: 9.8, streamingDurationSeconds: 0.2 },
  });
  const pendingFg = step({
    idx: 5,
    stepType: 15,
    status: 2,
    startTimeSeconds: 52,
    endTimeSeconds: null,
    generation: { timeToFirstTokenSeconds: 0.2, streamingDurationSeconds: 0 },
  });

  const fgSteps = [step({ idx: 0, stepType: 14 }), olderFg, step({ idx: 2, stepType: 14 }), latestFg, pendingFg];
  const res = buildConversationHudMetrics({
    conversationId: 'latest-step-ttft',
    isStreaming: true,
    contextSteps: fgSteps,
    steps: [...fgSteps, subagentLater],
  });

  closeTo(res.session.latestStepTtftSeconds, 1.244, 'latestStepTtftSeconds');
  assert.equal(res.session.latestStepTtftFormatted, '1.24 秒');
  assert.equal(res.session.latestStepTtftFormattedEn, '1.24s');

  const emptyTtft = buildConversationHudMetrics({
    conversationId: 'latest-step-ttft-empty',
    isStreaming: true,
    steps: [step({ idx: 0, stepType: 14 }), pendingFg],
  });
  assert.equal(emptyTtft.session.latestStepTtftSeconds, undefined);
  assert.equal(emptyTtft.session.latestStepTtftFormatted, undefined);
  assert.equal(emptyTtft.session.latestStepTtftFormattedEn, undefined);
});

test('formatHudUsd 与 tokens 估算费用/缓存节省严守零编造规则', () => {
  assert.equal(formatHudUsd(0), '$0');
  assert.equal(formatHudUsd(0.00426), '~$0.0043');
  assert.equal(formatHudUsd(0.005), '~$0.005');
  assert.equal(formatHudUsd(0.00999), '~$0.01');
  assert.equal(formatHudUsd(0.184), '~$0.18');
  assert.equal(formatHudUsd(2.0), '~$2');
  assert.equal(formatHudUsd(15.5), '~$15.5');
  assert.equal(formatHudUsd(12.345), '~$12.35');

  const pricedSingle = buildConversationHudMetrics({
    conversationId: 'cost-single',
    modelId: 'gemini-3.8-flash',
    steps: [
      step({
        idx: 1,
        modelName: 'gemini-3.8-flash',
        rawInputTokens: 100000,
        cachedReadTokens: 800000,
        cacheWriteTokens: 0,
        outputTokens: 20000,
      }),
    ],
  });
  assert.equal(pricedSingle.tokens.pricedStepCount, 1);
  assert.equal(Boolean(pricedSingle.tokens.hasUnpricedSteps), false);
  assert.ok(Number.isFinite(pricedSingle.tokens.estimatedCostUsd) && pricedSingle.tokens.estimatedCostUsd > 0);
  assert.ok(Number.isFinite(pricedSingle.tokens.cacheSavedUsd) && pricedSingle.tokens.cacheSavedUsd > 0);
  assert.match(pricedSingle.tokens.estimatedCostFormatted, /^~\$\d+/);
  assert.match(pricedSingle.tokens.cacheSavedFormatted, /^~\$\d+/);

  // 多模型 + 含 cacheWrite 模型（claude-sonnet-4-6 支持 cacheWrite 定价）
  const multiModel = buildConversationHudMetrics({
    conversationId: 'cost-multi-model',
    modelId: 'gemini-3.8-flash',
    steps: [
      step({
        idx: 1,
        modelName: 'gemini-3.8-flash',
        rawInputTokens: 100000,
        cachedReadTokens: 800000,
        cacheWriteTokens: 0,
        outputTokens: 20000,
      }),
      step({
        idx: 2,
        modelName: 'claude-sonnet-4-6',
        rawInputTokens: 100000,
        cachedReadTokens: 200000,
        cacheWriteTokens: 50000,
        outputTokens: 10000,
      }),
    ],
  });
  assert.equal(multiModel.tokens.pricedStepCount, 2);
  assert.equal(Boolean(multiModel.tokens.hasUnpricedSteps), false);
  assert.ok(multiModel.tokens.estimatedCostUsd > pricedSingle.tokens.estimatedCostUsd);
  assert.ok(multiModel.tokens.cacheSavedUsd > pricedSingle.tokens.cacheSavedUsd);

  // 加倍用量应使估算费用与缓存节省严格线性翻倍
  const pricedDoubled = buildConversationHudMetrics({
    conversationId: 'cost-double',
    modelId: 'gemini-3.8-flash',
    steps: [
      step({
        idx: 1,
        modelName: 'gemini-3.8-flash',
        rawInputTokens: 200000,
        cachedReadTokens: 1600000,
        cacheWriteTokens: 0,
        outputTokens: 40000,
      }),
    ],
  });
  closeTo(pricedDoubled.tokens.estimatedCostUsd, pricedSingle.tokens.estimatedCostUsd * 2, 'cost linearity');
  closeTo(pricedDoubled.tokens.cacheSavedUsd, pricedSingle.tokens.cacheSavedUsd * 2, 'cacheSaved linearity');

  // 混合已定价与未知模型（或无 cacheWrite 定价却写入缓存）步：标记 hasUnpricedSteps=true 且只汇总已匹配步
  const mixed = buildConversationHudMetrics({
    conversationId: 'cost-mixed',
    modelId: 'gemini-3.8-flash',
    steps: [
      step({
        idx: 1,
        modelName: 'gemini-3.8-flash',
        rawInputTokens: 100000,
        cachedReadTokens: 800000,
        cacheWriteTokens: 0,
        outputTokens: 20000,
      }),
      step({
        idx: 2,
        modelName: 'gemini-3.8-flash',
        rawInputTokens: 100000,
        cachedReadTokens: 800000,
        cacheWriteTokens: 50000,
        outputTokens: 20000,
      }),
      step({
        idx: 3,
        modelName: 'unknown-unpriced-model-xyz',
        rawInputTokens: 500000,
        cachedReadTokens: 500000,
        cacheWriteTokens: 0,
        outputTokens: 50000,
      }),
    ],
  });
  assert.equal(mixed.tokens.pricedStepCount, 1);
  assert.equal(mixed.tokens.hasUnpricedSteps, true);
  closeTo(mixed.tokens.estimatedCostUsd, pricedSingle.tokens.estimatedCostUsd, 'mixed ignores unpriced steps');

  // 完全无匹配定价或空费率表：严禁编造费率，费用与节省保留 undefined
  const unpriced = buildConversationHudMetrics({
    conversationId: 'cost-unpriced',
    modelId: 'unknown-unpriced-model-xyz',
    pricingTable: {},
    steps: [
      step({
        idx: 1,
        modelName: 'unknown-unpriced-model-xyz',
        rawInputTokens: 100000,
        cachedReadTokens: 800000,
        cacheWriteTokens: 0,
        outputTokens: 20000,
      }),
    ],
  });
  assert.equal(unpriced.tokens.pricedStepCount, undefined);
  assert.equal(unpriced.tokens.estimatedCostUsd, undefined);
  assert.equal(unpriced.tokens.estimatedCostFormatted, undefined);
  assert.equal(unpriced.tokens.cacheSavedUsd, undefined);
  assert.equal(unpriced.tokens.cacheSavedFormatted, undefined);
});

test('本轮用时按挂钟时间计算：上下文压缩与步骤间空档计入，结束后不回退', () => {
  const done = metrics([
    step({ idx: 1, stepType: 14, startTimeSeconds: 100, endTimeSeconds: 100 }),
    step({ idx: 2, stepType: 15, status: 3, startTimeSeconds: 100, endTimeSeconds: 110, rawInputTokens: 50, outputTokens: 20 }),
    step({ idx: 3, stepType: 23, status: 3, startTimeSeconds: 112, endTimeSeconds: 112 }),
    step({ idx: 4, stepType: 15, status: 3, startTimeSeconds: 150, endTimeSeconds: 160, rawInputTokens: 50, outputTokens: 20 }),
  ]);
  assert.equal(Number(done.session.currentTurnDurationSeconds.toFixed(1)), 60);

  const nowSec = Date.now() / 1000;
  const running = metrics(
    [
      step({ idx: 1, stepType: 14, startTimeSeconds: nowSec - 300, endTimeSeconds: nowSec - 300 }),
      step({ idx: 2, stepType: 15, status: 3, startTimeSeconds: nowSec - 300, endTimeSeconds: nowSec - 290, rawInputTokens: 50, outputTokens: 20 }),
    ],
    { isStreaming: true }
  );
  assert.ok(running.session.currentTurnDurationSeconds >= 299, `实际 ${running.session.currentTurnDurationSeconds}`);

  // 多轮会话隔离回归：第 1 轮数小时前产生子代理，第 2 轮刚起步 (USER_INPUT 无时间戳) 且新子代理活跃时，不得将第 1 轮子代理 startTimeSeconds 混入本轮墙钟起点
  const turn1Start = nowSec - 7200;
  const turn2ChildStart = nowSec - 8;
  const multiTurnMain = [
    step({ idx: 0, stepType: 14, startTimeSeconds: turn1Start, endTimeSeconds: turn1Start }),
    step({ idx: 1, stepType: 127, status: 3, isSubagentStep: true, startTimeSeconds: turn1Start + 1, endTimeSeconds: turn1Start + 30 }),
    step({ idx: 2, stepType: 15, status: 3, startTimeSeconds: turn1Start + 30, endTimeSeconds: turn1Start + 45 }),
    step({ idx: 3, stepType: 14, startTimeSeconds: null, endTimeSeconds: null, createdAtSeconds: null, hasUsage: false }),
  ];
  const turn1OldChild = step({
    idx: 0,
    stepType: 15,
    status: 3,
    startTimeSeconds: turn1Start + 2,
    endTimeSeconds: turn1Start + 28,
    outputTokens: 300,
  });
  const turn2NewChild = step({
    idx: 0,
    stepType: 15,
    status: 2,
    startTimeSeconds: turn2ChildStart,
    endTimeSeconds: null,
    outputTokens: 0,
    hasUsage: false,
  });
  const isolatedTurn2 = buildConversationHudMetrics({
    conversationId: 'multi-turn-subagent-boundary',
    isStreaming: true,
    isSubagentRunning: true,
    runningSubagentCount: 1,
    contextSteps: multiTurnMain,
    steps: [...multiTurnMain, turn1OldChild, turn2NewChild],
  });
  assert.ok(
    isolatedTurn2.session.currentTurnDurationSeconds >= 7.5 && isolatedTurn2.session.currentTurnDurationSeconds < 20,
    `第 2 轮本轮用时应仅围绕新子代理 ~8s 累计，不得被第 1 轮子代理拉至 7200s，实际 ${isolatedTurn2.session.currentTurnDurationSeconds}`
  );
});

test('P1-1 & P1-2: 主/子代理并发重叠模型耗时按并集去重且 TPS 不受影响，hasSubagentInTurn 精准隔离历史轮次子代理', () => {
  const mainTurn1And2 = [
    step({ idx: 0, stepType: 14, startTimeSeconds: 100, endTimeSeconds: 100 }),
    step({ idx: 1, stepType: 127, status: 3, isSubagentStep: true, startTimeSeconds: 100, endTimeSeconds: 120, hasUsage: false }),
    step({ idx: 2, stepType: 15, status: 3, startTimeSeconds: 100, endTimeSeconds: 115, outputTokens: 300 }),
    step({ idx: 3, stepType: 14, startTimeSeconds: 200, endTimeSeconds: 200 }),
    step({ idx: 4, stepType: 15, status: 3, startTimeSeconds: 200, endTimeSeconds: 210, outputTokens: 200 }),
  ];
  const turn1ChildModel = step({
    idx: 0,
    stepType: 15,
    status: 3,
    startTimeSeconds: 105,
    endTimeSeconds: 120,
    outputTokens: 150,
  });
  const res = buildConversationHudMetrics({
    conversationId: 'p1-overlap-and-turn-subagent',
    isStreaming: false,
    isSubagentRunning: false,
    subagentCount: 1,
    subagentSteps: 1,
    contextSteps: mainTurn1And2,
    steps: [...mainTurn1And2, turn1ChildModel],
  });
  assert.equal(res.session.modelDurationSeconds, 30);
  closeTo(res.session.outputTps, 650 / 40, 'TPS keeps sum of generation durations');
  assert.equal(res.session.subagentCount, 1);
  assert.equal(res.session.hasSubagentInTurn, false);
});

test('P0-2 & P1-5: 子智能体本轮模型/工具耗时纳入当轮分解且支持 >30s 逆向嗅探窗口与无关会话负向缓存', async (t) => {
  const nowSec = Date.now() / 1000;
  const turnStart = nowSec - 30;
  const mainTurnSteps = [
    step({ idx: 0, stepType: 14, startTimeSeconds: turnStart, endTimeSeconds: turnStart }),
    step({ idx: 1, stepType: 15, status: 3, startTimeSeconds: turnStart, endTimeSeconds: turnStart + 5, outputTokens: 100 }),
    step({ idx: 2, stepType: 127, status: 3, isSubagentStep: true, startTimeSeconds: turnStart + 5, endTimeSeconds: turnStart + 5.02, hasUsage: false }),
  ];
  const childCompletedModel = step({
    idx: 1,
    stepType: 15,
    status: 3,
    startTimeSeconds: turnStart + 6,
    endTimeSeconds: turnStart + 16,
    outputTokens: 200,
  });
  const childActiveTool = step({
    idx: 2,
    stepType: 21,
    status: 2,
    startTimeSeconds: nowSec - 4,
    endTimeSeconds: null,
    hasUsage: false,
  });
  const liveTurn = buildConversationHudMetrics({
    conversationId: 'subagent-turn-breakdown',
    isStreaming: false,
    isSubagentRunning: true,
    runningSubagentCount: 1,
    contextSteps: mainTurnSteps,
    steps: [...mainTurnSteps, childCompletedModel, childActiveTool],
  });
  // 本轮模型用时 = 主对话 5s + 子智能体 10s = 15s
  assert.equal(Number(liveTurn.session.currentTurnModelDurationSeconds.toFixed(1)), 15);
  // 本轮工具用时包含子智能体进行中的 ~4s 工具执行，且 inFlightToolDurationSeconds 同步可见
  assert.ok(liveTurn.session.currentTurnToolDurationSeconds >= 3.8 && liveTurn.session.currentTurnToolDurationSeconds < 6);
  assert.ok(liveTurn.session.inFlightToolDurationSeconds >= 3.8 && liveTurn.session.inFlightToolDurationSeconds < 6);

  // 逆向嗅探 5 分钟窗口：子会话无显式 UUID 引用且其 mtime 为 90 秒前（>30s 旧阈值，<=300s 新阈值）仍可被发现并汇总
  const { create, engine } = databaseFixture(t);
  const mainDb = create(ids.main);
  const sniffChildDb = create(ids.child, { parentBlob: parentMetadata(ids.main) });
  const otherDb = create(ids.unrelated, { parentBlob: parentMetadata(ids.impostor, ids.impostor) });
  mainDb.prepare('INSERT INTO steps (idx, step_type, status) VALUES (1, 14, 3)').run();
  insertStep(mainDb, { idx: 2, value: usage({ outputTokens: 100 }) });
  insertStep(sniffChildDb, { idx: 1, status: 2, value: usage({ outputTokens: 300 }) });
  insertStep(otherDb, { idx: 1, status: 3, value: usage({ outputTokens: 999 }) });
  sniffChildDb.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  otherDb.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();

  const childDbPath = engine.resolveDbPath(ids.child);
  const otherDbPath = engine.resolveDbPath(ids.unrelated);
  const ninetySecAgo = new Date(Date.now() - 90_000);
  fs.utimesSync(childDbPath, ninetySecAgo, ninetySecAgo);
  fs.utimesSync(otherDbPath, ninetySecAgo, ninetySecAgo);

  const sniffedRes1 = await engine.getConversationMetrics({
    conversationId: ids.main,
    isSubagentRunning: true,
    runningSubagentCount: 1,
  });
  assert.equal(sniffedRes1.session.subagentCount, 1);
  assert.equal(sniffedRes1.tokens.outputTokens, 400);

  // 第二次轮询命中负向 mtime 缓存，保持无关会话零混入且结果幂等
  const sniffedRes2 = await engine.getConversationMetrics({
    conversationId: ids.main,
    isSubagentRunning: true,
    runningSubagentCount: 1,
  });
  assert.equal(sniffedRes2.session.subagentCount, 1);
  assert.equal(sniffedRes2.tokens.outputTokens, 400);
});

test('P0-03 & P1-05 & P1-08: 中止/报错步保留真实挂钟不倒退、过渡空档 awaitingFirstTurnStep 精准置位、子分栏活跃圆点同步', () => {
  // P0-03: 无子智能体的普通对话轮次，步骤 1 耗时 25s (100->125)，步骤 2 运行至 155s 被用户停止 (status=6)
  const abortedTurn = metrics(
    [
      step({ idx: 1, stepType: 14, startTimeSeconds: 100, endTimeSeconds: 100 }),
      step({
        idx: 2,
        stepType: 15,
        status: 3,
        startTimeSeconds: 100,
        endTimeSeconds: 125,
        outputTokens: 500,
        generation: { timeToFirstTokenSeconds: 1, streamingDurationSeconds: 24 },
      }),
      step({
        idx: 3,
        stepType: 15,
        status: 6,
        startTimeSeconds: 125,
        endTimeSeconds: 155,
        hasUsage: false,
        outputTokens: 0,
      }),
    ],
    { isStreaming: false }
  );
  assert.equal(abortedTurn.session.turnAborted, true);
  assert.equal(abortedTurn.session.currentTurnDurationSeconds, 55, '被停止步骤的结束时间戳必须纳入本轮挂钟用时，不得退回 25s');
  assert.equal(abortedTurn.session.outputTps, 20, '被停止步骤不混入 TPS 样本');

  // P1-05: 工具执行完毕进入下一轮思考空档时 awaitingFirstTurnStep=true；模型步刚完结等待工具审批时保持 false
  const afterToolGap = metrics(
    [
      step({ idx: 1, stepType: 14, startTimeSeconds: 100, endTimeSeconds: 100 }),
      step({ idx: 2, stepType: 15, status: 3, startTimeSeconds: 100, endTimeSeconds: 108, outputTokens: 160 }),
      step({ idx: 3, stepType: 21, status: 3, startTimeSeconds: 108, endTimeSeconds: 112, hasUsage: false }),
    ],
    { isStreaming: true, activityPhase: 'generating' }
  );
  assert.equal(afterToolGap.session.awaitingFirstTurnStep, true);

  const afterModelApprovalWait = metrics(
    [
      step({ idx: 1, stepType: 14, startTimeSeconds: 100, endTimeSeconds: 100 }),
      step({ idx: 2, stepType: 15, status: 3, startTimeSeconds: 100, endTimeSeconds: 108, outputTokens: 160 }),
    ],
    { isStreaming: true, activityPhase: 'generating' }
  );
  assert.equal(Boolean(afterModelApprovalWait.session.awaitingFirstTurnStep), false);

  // P1-08: 独立子智能体分栏即使 DOM 未检测到停止按钮 (isStreaming=false)，只要数据库存在活跃前台步即同步 generating/executing
  const nowSec = Date.now() / 1000;
  const subpaneGen = buildConversationHudMetrics({
    conversationId: 'subpane-active-model',
    isStreaming: false,
    isSubagentTrajectory: true,
    allowDbActiveStepInference: true,
    steps: [
      step({ idx: 1, stepType: 14, startTimeSeconds: nowSec - 6, endTimeSeconds: nowSec - 6 }),
      step({ idx: 2, stepType: 15, status: 8, startTimeSeconds: nowSec - 4, endTimeSeconds: null, hasUsage: false }),
    ],
  });
  assert.equal(subpaneGen.activityPhase, 'generating');

  const subpaneExec = buildConversationHudMetrics({
    conversationId: 'subpane-active-tool',
    isStreaming: false,
    isSubagentTrajectory: true,
    allowDbActiveStepInference: true,
    steps: [
      step({ idx: 1, stepType: 14, startTimeSeconds: nowSec - 6, endTimeSeconds: nowSec - 6 }),
      step({ idx: 2, stepType: 21, status: 2, startTimeSeconds: nowSec - 3, endTimeSeconds: null, hasUsage: false }),
    ],
  });
  assert.equal(subpaneExec.activityPhase, 'executing');
});

test('P1-06 & P1-07: 多子代理步骤间空档防抖不掉数 + 历史多代理会话冷启动反向嗅探补齐', async (t) => {
  const { create, engine } = databaseFixture(t);
  const mainDb = create(ids.main);
  const child1Db = create(ids.child, { parentBlob: parentMetadata(ids.main) });
  const child2Db = create(ids.grandchild, { parentBlob: parentMetadata(ids.main) });

  // P1-06: 两个子代理已由主会话派发，child1 刚跑完第 1 步正处于等待第 2 步落盘的间隙 (<15s 且未写入 step_type=2 结束步)，child2 正在运行步骤
  mainDb.prepare('INSERT INTO steps (idx, step_type, status) VALUES (1, 14, 3)').run();
  invoke(mainDb, 2, [ids.child, ids.grandchild]);
  child1Db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (1, 14, 3)').run();
  insertStep(child1Db, { idx: 2, status: 3, value: usage({ outputTokens: 120 }) });
  child2Db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (1, 14, 3)').run();
  insertStep(child2Db, { idx: 2, status: 2, value: usage({ outputTokens: 80 }) });

  const liveMulti = await engine.getConversationMetrics({
    conversationId: ids.main,
    isStreaming: false,
    isSubagentRunning: true,
    runningSubagentCount: 1, // 模拟页面仅渲染汇总按钮 "Stop All Subagents" (DOM count=1)
  });
  assert.equal(liveMulti.runningSubagentCount, 2, '步骤间 15s 窗口内未完结的子代理不得闪烁跌落');

  // child1 写入轮次完结步 (step_type=2, status=3) 后，立即准确收敛为 1 个运行中子代理
  child1Db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (3, 2, 3)').run();
  const afterChild1Done = await engine.getConversationMetrics({
    conversationId: ids.main,
    isStreaming: false,
    isSubagentRunning: true,
    runningSubagentCount: 1,
  });
  assert.equal(afterChild1Done.runningSubagentCount, 1);

  // P1-07: 全新引擎实例冷启动打开 2 小时前已完成的历史多代理会话（主库含 invoke_subagent 工具步但无内联子 UUID）
  const histDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-hud-cold-sniff-'));
  t.after(() => fs.rmSync(histDir, { recursive: true, force: true }));
  const histMainId = '77777777-7777-4777-8777-777777777777';
  const histChildId = '88888888-8888-4888-8888-888888888888';
  const twoHoursAgoSec = Math.floor(Date.now() / 1000) - 7200;

  const mkHistDb = (id, parentBlob = null) => {
    const db = new DatabaseSync(path.join(histDir, `${id}.db`));
    db.exec(`
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, status INTEGER NOT NULL, metadata BLOB, render_info BLOB, step_payload BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT, trajectory_type INTEGER);
      CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
    `);
    db.prepare('INSERT INTO trajectory_meta VALUES (?, ?, 0)').run(id, id);
    if (parentBlob) db.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', parentBlob);
    return db;
  };

  const hMain = mkHistDb(histMainId);
  const hChild = mkHistDb(histChildId, parentMetadata(histMainId, histMainId));
  hMain.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (1, 14, 3, ?)').run(
    Buffer.from([...seconds(1, twoHoursAgoSec), ...seconds(7, twoHoursAgoSec)])
  );
  // 主库步骤 2 为 invoke_subagent (step_type=127)，但 metadata/render_info 未内联子 UUID
  hMain.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (2, 127, 3, ?)').run(
    Buffer.from([...seconds(1, twoHoursAgoSec + 2), ...seconds(7, twoHoursAgoSec + 2.1), ...message(4, string(2, 'invoke_subagent'))])
  );
  hMain.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (3, 15, 3, ?)').run(
    Buffer.from([...seconds(1, twoHoursAgoSec + 20), ...seconds(6, twoHoursAgoSec + 21), ...seconds(7, twoHoursAgoSec + 25), ...message(9, usageBytes(usage({ outputTokens: 150 })))])
  );
  hChild.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (1, 15, 3, ?)').run(
    Buffer.from([...seconds(1, twoHoursAgoSec + 3), ...seconds(6, twoHoursAgoSec + 4), ...seconds(7, twoHoursAgoSec + 18), ...message(9, usageBytes(usage({ outputTokens: 450 })))])
  );
  hMain.close();
  hChild.close();

  const twoHoursAgoDate = new Date(twoHoursAgoSec * 1000 + 30_000);
  fs.utimesSync(path.join(histDir, `${histMainId}.db`), twoHoursAgoDate, twoHoursAgoDate);
  fs.utimesSync(path.join(histDir, `${histChildId}.db`), twoHoursAgoDate, twoHoursAgoDate);

  const coldEngine = new ConversationMetricsEngine({ conversationsDir: histDir });
  const coldMetrics = await coldEngine.getConversationMetrics({
    conversationId: histMainId,
    isStreaming: false,
    isSubagentRunning: false,
  });
  assert.equal(coldMetrics.session.subagentCount, 1, '冷启动历史多代理会话应通过反向嗅探找回关联子库');
  assert.equal(coldMetrics.tokens.outputTokens, 600, '主库 150 + 子库 450 = 600 outputTokens');
});

test('已完结或已中止轮次闲置后收到瞬时 isStreaming 脉冲时，严禁把跨轮挂机时间外推入本轮用时', () => {
  const nowSec = Date.now() / 1000;
  const oldStart = nowSec - 2688; // 44m48s 前开始
  const oldEnd = oldStart + 404; // 6m44s 后完成，距今已闲置 38 分钟

  // 场景 1: 末步为已完成的模型步 (stepType=15, status=3)，闲置 38 分钟后瞬时收到 isStreaming=true
  const staleModelTurn = metrics(
    [
      step({ idx: 0, stepType: 14, startTimeSeconds: null, endTimeSeconds: null }),
      step({
        idx: 1,
        stepType: 15,
        status: 3,
        startTimeSeconds: oldStart,
        endTimeSeconds: oldEnd,
        outputTokens: 200,
        generation: { timeToFirstTokenSeconds: 2, streamingDurationSeconds: 402 },
      }),
    ],
    { isStreaming: true, allowDbActiveStepInference: true }
  );
  assert.equal(
    Math.round(staleModelTurn.session.currentTurnDurationSeconds),
    404,
    `已完结 38 分钟的轮次收到瞬时 isStreaming 不得计入空闲挂机时间，实际 ${staleModelTurn.session.currentTurnDurationSeconds}`
  );

  // 场景 2: 末步为明确收尾步 (stepType=2, status=3)，即使刚结束 2s 内收到 isStreaming=true 也不得外推旧轮挂钟
  const closedTurn = metrics(
    [
      step({ idx: 0, stepType: 14, startTimeSeconds: nowSec - 120, endTimeSeconds: nowSec - 120 }),
      step({ idx: 1, stepType: 15, status: 3, startTimeSeconds: nowSec - 120, endTimeSeconds: nowSec - 2 }),
      step({ idx: 2, stepType: 2, status: 3, startTimeSeconds: nowSec - 2, endTimeSeconds: nowSec - 2, hasUsage: false }),
    ],
    { isStreaming: true, allowDbActiveStepInference: true }
  );
  assert.equal(Math.round(closedTurn.session.currentTurnDurationSeconds), 118);

  // 场景 3: 含历史已完成子智能体的中止轮次 (status=6)，无运行中子智能体时收到 isStreaming=true 不得继续计时
  const abortedWithDoneSub = buildConversationHudMetrics({
    conversationId: 'aborted-with-historical-subagent',
    isStreaming: true,
    isSubagentRunning: false,
    allowDbActiveStepInference: true,
    contextSteps: [
      step({ idx: 0, stepType: 14, startTimeSeconds: oldStart, endTimeSeconds: oldStart }),
      step({ idx: 1, stepType: 127, status: 3, isSubagentStep: true, toolCallName: 'invoke_subagent', startTimeSeconds: oldStart + 1, endTimeSeconds: oldStart + 10 }),
      step({ idx: 2, stepType: 15, status: 6, startTimeSeconds: oldStart + 10, endTimeSeconds: oldStart + 50, hasUsage: false }),
    ],
    steps: [
      step({ idx: 0, stepType: 14, startTimeSeconds: oldStart, endTimeSeconds: oldStart }),
      step({ idx: 1, stepType: 127, status: 3, isSubagentStep: true, toolCallName: 'invoke_subagent', startTimeSeconds: oldStart + 1, endTimeSeconds: oldStart + 10 }),
      step({ idx: 2, stepType: 15, status: 6, startTimeSeconds: oldStart + 10, endTimeSeconds: oldStart + 50, hasUsage: false }),
      step({ idx: 3, stepType: 15, status: 3, startTimeSeconds: oldStart + 1, endTimeSeconds: oldStart + 9 }),
    ],
  });
  assert.equal(Math.round(abortedWithDoneSub.session.currentTurnDurationSeconds), 50);
});

test('多模型与曾用模型 (history) 压缩归因、当前模型峰值解耦及角色去重守恒', () => {
  // 场景 1：历史 Opus 压缩 2 次后切换到 Orchestrator (Carbon 规划 0 次 + Hydrogen 执行 1 次)
  const opusStep1 = step({
    idx: 1,
    rawInputTokens: 20000,
    cachedReadTokens: 165000,
    cacheWriteTokens: 0,
    outputTokens: 1200,
    generation: {
      responseModel: 'claude-opus-4-6-thinking',
      modelDisplayName: 'Claude Opus 4.6 (Thinking)',
      maxContextTokens: 200000,
    },
  });
  const opusStep2 = step({
    idx: 3,
    rawInputTokens: 15000,
    cachedReadTokens: 175000,
    cacheWriteTokens: 0,
    outputTokens: 900,
    generation: {
      responseModel: 'claude-opus-4-6-thinking',
      modelDisplayName: 'Claude Opus 4.6 (Thinking)',
      maxContextTokens: 200000,
    },
  });
  const carbonStep = step({
    idx: 6,
    rawInputTokens: 12000,
    cachedReadTokens: 244000,
    cacheWriteTokens: 0,
    outputTokens: 800,
    generation: {
      modelEnum: 1667,
      responseModel: 'gemini-pro-orchestrator',
      modelDisplayName: 'Orchestrator (Carbon)',
      maxContextTokens: 512000,
    },
  });
  const hydrogenStep = step({
    idx: 7,
    rawInputTokens: 40000,
    cachedReadTokens: 360000,
    cacheWriteTokens: 0,
    outputTokens: 1500,
    generation: {
      modelEnum: 1669,
      responseModel: 'gemini-flash-worker-agy',
      modelDisplayName: 'Gemini 4 Hydrogen (Orchestrator)',
      maxContextTokens: 512000,
    },
  });

  // 刚切到 Carbon 时：Opus 压缩 2 次（含一次由后台轻量摘要模型执行的 CHECKPOINT，不得生成幽灵模型阶段），Carbon 自身压缩 0 次
  const atCarbon = buildConversationHudMetrics({
    conversationId: 'conv-compaction-history-orch',
    modelId: 'Orchestrator (Carbon)',
    steps: [
      { idx: 0, stepType: 14, status: 3 },
      opusStep1,
      { idx: 2, stepType: 23, status: 3 }, // 无 metadata 的常规 CHECKPOINT -> 归因至紧邻前置 Opus
      opusStep2,
      {
        idx: 4,
        stepType: 23,
        status: 5,
        generation: { responseModel: 'gemini-2.5-flash-lite', modelDisplayName: 'Internal Summarizer' },
      }, // 后台摘要模型不在对话阶段列表中 -> 回退归因至 Opus 且不产生幽灵阶段
      { idx: 5, stepType: 14, status: 3 },
      carbonStep,
    ],
  });

  assert.equal(atCarbon.session.compactionCount, 2);
  assert.equal(atCarbon.context.activeModelCompactionCount, 0);
  assert.equal(atCarbon.context.modelStages?.length, 3);
  const carbonStage1 = atCarbon.context.modelStages?.find((s) => s.slotKey === 'orchestrator:carbon');
  const opusHistoryStage = atCarbon.context.modelStages?.find((s) => s.shortLabel === 'Opus');
  assert.equal(carbonStage1?.isActive, true);
  assert.equal(carbonStage1?.compactionCount, undefined);
  assert.equal(opusHistoryStage?.section, 'history');
  assert.equal(opusHistoryStage?.compactionCount, 2);

  // Hydrogen 执行器介入并触发 1 次压缩后：总压缩 3 次，当前活跃 Hydrogen 压缩 1 次，曾用模型 Opus 保持 2 次
  const atHydrogen = buildConversationHudMetrics({
    conversationId: 'conv-compaction-history-orch',
    modelId: 'Orchestrator (Carbon)',
    steps: [
      { idx: 0, stepType: 14, status: 3 },
      opusStep1,
      { idx: 2, stepType: 23, status: 3 },
      opusStep2,
      { idx: 4, stepType: 23, status: 5 },
      { idx: 5, stepType: 14, status: 3 },
      carbonStep,
      hydrogenStep,
      { idx: 8, stepType: 23, status: 3 },
    ],
  });
  assert.equal(atHydrogen.session.compactionCount, 3);
  assert.equal(atHydrogen.context.activeModelCompactionCount, 1);
  const carbonStage2 = atHydrogen.context.modelStages?.find((s) => s.slotKey === 'orchestrator:carbon');
  const hydrogenStage2 = atHydrogen.context.modelStages?.find((s) => s.slotKey === 'orchestrator:hydrogen');
  const opusHistory2 = atHydrogen.context.modelStages?.find((s) => s.shortLabel === 'Opus');
  assert.equal(carbonStage2?.compactionCount, undefined);
  assert.equal(hydrogenStage2?.isActive, true);
  assert.equal(hydrogenStage2?.compactionCount, 1);
  assert.equal(opusHistory2?.section, 'history');
  assert.equal(opusHistory2?.compactionCount, 2);

  // 场景 2：Orchestrator Hydrogen 压缩 1 次后切回独立 Gemini 4 Hydrogen (High)，去重合并时压缩次数守恒不丢失
  const standaloneHydrogenStep = step({
    idx: 10,
    rawInputTokens: 30000,
    cachedReadTokens: 50000,
    cacheWriteTokens: 0,
    outputTokens: 600,
    generation: {
      responseModel: 'gemini-4-hydrogen',
      modelDisplayName: 'Gemini 4 Hydrogen (High)',
      maxContextTokens: 200000,
    },
  });
  const deduped = buildConversationHudMetrics({
    conversationId: 'conv-compaction-dedup',
    modelId: 'Gemini 4 Hydrogen (High)',
    steps: [
      { idx: 0, stepType: 14, status: 3 },
      carbonStep,
      hydrogenStep,
      { idx: 8, stepType: 23, status: 3 },
      { idx: 9, stepType: 14, status: 3 },
      standaloneHydrogenStep,
    ],
  });
  assert.equal(deduped.session.compactionCount, 1);
  assert.equal(deduped.context.activeModelCompactionCount, 1);
  assert.equal(deduped.context.modelStages?.length, 2);
  assert.equal(deduped.context.modelStages?.[1]?.slotKey, 'model:gemini-4-hydrogen');
  assert.equal(deduped.context.modelStages?.[1]?.compactionCount, 1);
});

test('SQLite 压缩步 (step_type=23) 关联 gen_metadata 时兼具模型阶段归因与独立计费 Token 守恒', async (t) => {
  const { create, engine } = databaseFixture(t);
  const db = create(ids.main);

  // step 1: Claude Opus 4.6 模型步 (100 + 200 + 30 + 120 = 450 tok)
  insertStep(db, { idx: 1, execution: 'exec-opus-1', value: usage() });
  const opusGen = Buffer.from([
    ...message(1, [
      ...message(4, usageBytes(usage())),
      ...string(19, 'claude-opus-4-6-thinking'),
    ]),
    ...message(2, varint(1)),
    ...string(4, 'exec-opus-1'),
  ]);
  db.prepare('INSERT INTO gen_metadata VALUES (?, ?, ?)').run(1, opusGen, opusGen.length);

  // step 2: CHECKPOINT (step_type=23)，计费仅存于 gen_metadata idx=2 (500 + 1500 + 0 + 100 = 2100 tok)
  db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, 23, 3, ?)').run(2, null);
  const cpUsage = usage({
    rawInputTokens: 500,
    cachedReadTokens: 1500,
    cacheWriteTokens: 0,
    outputTokens: 100,
    reasoningTokens: 0,
    candidateTokens: 100,
  });
  const cpGen = Buffer.from([
    ...message(1, [
      ...message(4, usageBytes(cpUsage)),
      ...string(19, 'claude-opus-4-6-thinking'),
    ]),
    ...message(2, varint(2)),
    ...string(4, 'exec-cp-1'),
  ]);
  db.prepare('INSERT INTO gen_metadata VALUES (?, ?, ?)').run(2, cpGen, cpGen.length);

  // step 3: 切换到 Gemini 3.8 Flash 模型步 (100 + 200 + 30 + 120 = 450 tok)，无压缩
  insertStep(db, { idx: 3, execution: 'exec-flash-1', value: usage() });
  insertGeneration(db, { indices: [3], execution: 'exec-flash-1' }, 3);

  const result = await engine.getConversationMetrics({ conversationId: ids.main });
  assert.equal(result.session.compactionCount, 1);
  assert.equal(result.context.isMultiModel, true);
  assert.equal(result.context.activeModelCompactionCount, 0);
  // Token 守恒：450 (Opus) + 2100 (CHECKPOINT unmatchedUsageGenerations) + 450 (Flash) = 3000 tok
  assert.equal(result.tokens.totalTokens, 3000);
  const opusStage = result.context.modelStages?.find((s) => s.shortLabel === 'Opus');
  const flashStage = result.context.modelStages?.find((s) => s.modelId === 'gemini-3.8-flash');
  assert.equal(opusStage?.compactionCount, 1);
  assert.equal(flashStage?.isActive, true);
  assert.equal(flashStage?.compactionCount, undefined);
});

test('SQLite 跨模型压缩归因：Model A 命中精确匹配且与 Model B 共用 step_type=23 索引时不得被 Model B 抢占', async (t) => {
  const { create, engine } = databaseFixture(t);
  const db = create(ids.main);

  db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (0, 14, 3, ?)').run(
    Buffer.from(seconds(1, 1000))
  );
  // step 1: Model A (Opus) 精确匹配自身 usage，同时关联压缩步 idx=2 (exec-A)
  insertStep(db, { idx: 1, execution: 'exec-A', value: usage({ rawInputTokens: 40_000, cachedReadTokens: 120_000, outputTokens: 800 }) });
  const genA = Buffer.from([
    ...message(1, [
      ...message(4, usageBytes(usage({ rawInputTokens: 40_000, cachedReadTokens: 120_000, outputTokens: 800 }))),
      ...string(19, 'claude-opus-4-6-thinking'),
      ...string(21, 'Claude Opus 4.6 (Thinking)'),
    ]),
    ...message(2, [1, 2].flatMap(varint)),
    ...string(4, 'exec-A'),
  ]);
  db.prepare('INSERT INTO gen_metadata VALUES (?, ?, ?)').run(0, genA, genA.length);

  // step 2: 压缩步 (step_type=23) 自身带 executionId = exec-A（依赖 sqlite-worker 放开 step_type=23 读取）
  db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (2, 23, 3, ?)').run(
    Buffer.from([...seconds(1, 1008), ...string(12, 'exec-A')])
  );

  // step 3: 接手的 Model B (Sonnet) 未命中 exactMatch（cacheWrite 不同）且 stepIndices 也覆盖了 [2, 3]
  insertStep(db, { idx: 3, execution: 'exec-B', value: usage({ rawInputTokens: 20_000, cachedReadTokens: 30_000, cacheWriteTokens: 0, outputTokens: 500 }) });
  const genB = Buffer.from([
    ...message(1, [
      ...message(4, usageBytes(usage({ rawInputTokens: 20_000, cachedReadTokens: 30_000, cacheWriteTokens: 500, outputTokens: 500 }))),
      ...string(19, 'claude-sonnet-4-6'),
      ...string(21, 'Claude Sonnet 4.6'),
    ]),
    ...message(2, [2, 3].flatMap(varint)),
    ...string(4, 'exec-B'),
  ]);
  db.prepare('INSERT INTO gen_metadata VALUES (?, ?, ?)').run(1, genB, genB.length);

  const res = await engine.getConversationMetrics({ conversationId: ids.main });
  assert.equal(res.session.compactionCount, 1);
  assert.equal(res.context.activeModelCompactionCount, 0);
  const opusStage = res.context.modelStages?.find((s) => s.shortLabel === 'Opus');
  const sonnetStage = res.context.modelStages?.find((s) => s.shortLabel === 'Sonnet');
  assert.equal(opusStage?.compactionCount, 1, '压缩步 exec-A 必须精准归因至触发压缩的 Opus');
  assert.equal(sonnetStage?.isActive, true);
  assert.equal(sonnetStage?.compactionCount, undefined, '接手模型 Sonnet 不得抢占 Opus 的压缩归因');
});

test('Orchestrator 吸收同名独立模型阶段及单物理模型跨角色合并时均保留历史峰值与激活阶段', () => {
  const standaloneHydrogenHighPeak = step({
    idx: 1,
    rawInputTokens: 180_000,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 400,
    generation: {
      responseModel: 'gemini-4-hydrogen',
      modelDisplayName: 'Gemini 4 Hydrogen (High)',
      maxContextTokens: 512000,
    },
  });
  const carbonStep = step({
    idx: 4,
    rawInputTokens: 20_000,
    cachedReadTokens: 200_000,
    cacheWriteTokens: 0,
    outputTokens: 600,
    generation: {
      modelEnum: 1667,
      responseModel: 'gemini-pro-orchestrator',
      modelDisplayName: 'Orchestrator (Carbon)',
      maxContextTokens: 512000,
    },
  });
  const hydrogenExecLowPeak = step({
    idx: 5,
    rawInputTokens: 50_000,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 300,
    generation: {
      modelEnum: 1669,
      responseModel: 'gemini-flash-worker-agy',
      modelDisplayName: 'Gemini 4 Hydrogen (Orchestrator)',
      maxContextTokens: 512000,
    },
  });

  // 1. Orchestrator 吸收同名独立 Hydrogen 时保留历史峰值 180K 与压缩次数
  const orchMerged = buildConversationHudMetrics({
    conversationId: 'conv-orch-absorb-peak',
    modelId: 'Orchestrator (Carbon)',
    steps: [
      { idx: 0, stepType: 14, status: 3 },
      standaloneHydrogenHighPeak,
      { idx: 2, stepType: 23, status: 3 },
      { idx: 3, stepType: 14, status: 3 },
      carbonStep,
      hydrogenExecLowPeak,
    ],
  });
  assert.equal(orchMerged.context.peakContextTokens, 180_000);
  assert.equal(orchMerged.context.activeModelCompactionCount, 1);
  assert.equal(orchMerged.context.modelStages?.some((s) => s.isActive), true);

  // 2. Turn 2 独立 Hydrogen 为最后一步，选择器切回 Orchestrator (Carbon) 未发言时，执行器吸收后仍保持 isActive
  const selectorBack = buildConversationHudMetrics({
    conversationId: 'conv-orch-absorb-active',
    modelId: 'Orchestrator (Carbon)',
    steps: [
      { idx: 0, stepType: 14, status: 3 },
      carbonStep,
      hydrogenExecLowPeak,
      { idx: 6, stepType: 14, status: 3 },
      { ...standaloneHydrogenHighPeak, idx: 7 },
    ],
  });
  assert.equal(selectorBack.context.modelStages?.some((s) => s.isActive), true);

  // 3. 仅有单个物理模型跨角色合并（orderedEntries.length === 1）时保留历史峰值 190K 与压缩 1 次
  const singlePhysMerged = buildConversationHudMetrics({
    conversationId: 'conv-single-phys-merge',
    modelId: 'Gemini 4 Hydrogen (High)',
    steps: [
      { idx: 0, stepType: 14, status: 3 },
      { ...hydrogenExecLowPeak, idx: 1, rawInputTokens: 190_000 },
      { idx: 2, stepType: 23, status: 3 },
      { idx: 3, stepType: 14, status: 3 },
      { ...standaloneHydrogenHighPeak, idx: 4, rawInputTokens: 80_000 },
    ],
  });
  assert.equal(Boolean(singlePhysMerged.context.isMultiModel), false);
  assert.equal(singlePhysMerged.context.peakContextTokens, 190_000);
  assert.equal(singlePhysMerged.context.activeModelCompactionCount, 1);
});


