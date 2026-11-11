// Run in an isolated container with only a COPY of the production database.
import assert from 'node:assert/strict';
import { createStore } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';

const store = createStore('/migration/workspace.sqlite');
const counts = () => Object.fromEntries(['users', 'projects', 'threads', 'messages'].map(table => [table, store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n]));
const before = counts();
const app = createApp({ store, config: { model: 'gpt-6.1-sol', workRoutingMode: 'enforce', dataDir: '/unused', cookieSecure: false },
  runtime: { setPrimaryAssistant() {}, approvals: () => [], interrupt: async () => {} } });
assert.deepEqual(counts(), before);
assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
assert.equal(store.db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
for (const name of ['kibot_jobs','kibot_tool_calls','kibot_task_notifications','kibot_memory','kibot_task_references']) {
  assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
await app.locals.supervisor.close();
store.close();
console.log(JSON.stringify({ migration: 'passed', originalCountsPreserved: before, foreignKeys: 'ok' }));
