'use strict';

const test = require('node:test');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('policy migration preserves fresh and legacy policies across retry and Windows file replacement failures',
  { skip: process.platform !== 'win32' }, () => {
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'policy-migration.fixture.ps1')
    ], { timeout: 30000, windowsHide: true, stdio: 'pipe' });
  });
