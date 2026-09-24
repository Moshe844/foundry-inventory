'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(root, 'data', 'frontend-acceptance-'));
const child = fork(path.join(root, 'tests/helpers/weekly-operations-server.js'), [], {
  cwd: root, env: { ...process.env, NODE_ENV: 'test', DATABASE_PATH: path.join(directory, 'acceptance.sqlite') },
});
child.once('message', (state) => {
  fs.writeFileSync(path.join(root, 'artifacts', 'frontend-acceptance-state.json'), JSON.stringify(state));
  console.log(`Frontend acceptance workspace: http://127.0.0.1:${state.port}/login`);
});
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.once('exit', (code) => process.exit(code || 0));
