// Worker for scenario I: its own SQLite connection, released at the same instant as its twin.
const { workerData, parentPort } = require('worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { createAccounts } = require('../services/accounts/engine');

const db = new DatabaseSync(workerData.dbPath);
db.exec('PRAGMA busy_timeout = 5000');
const acc = createAccounts(db);
const gate = new Int32Array(workerData.gate);
Atomics.wait(gate, 0, 0);
try {
  acc.allocate({ ...workerData.actor }, { payment_id: workerData.payment_id, lines: [{ invoice_id: workerData.invoice_id, amount: workerData.amount }] });
  parentPort.postMessage({ ok: true });
} catch (e) {
  parentPort.postMessage({ ok: false, error: e.message });
}
