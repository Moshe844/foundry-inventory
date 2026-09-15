'use strict';

// Keep browser traffic isolated from catalog-wide schedulers. A single Node
// event loop is not a safe local topology once an inventory has tens of
// thousands of SKUs: one forecasting pass must never make /login or / hang.
const { spawn } = require('node:child_process');
const path = require('node:path');

const server = path.join(__dirname, '..', 'src', 'server.js');
const children = new Set();
let stopping = false;

function launch(role) {
  const child = spawn(process.execPath, [server], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, FOUNDRY_PROCESS_ROLE: role },
    stdio: 'inherit',
  });
  children.add(child);
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (stopping) return;
    stopping = true;
    for (const peer of children) peer.kill('SIGTERM');
    process.exitCode = code == null ? 1 : code;
    console.error(`[local] ${role} process stopped${signal ? ` (${signal})` : ` with code ${code}`}.`);
  });
  return child;
}

launch('web');
launch('worker');

function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

