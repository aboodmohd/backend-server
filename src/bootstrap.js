import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function isExpectedBrowserCloseError(error) {
  const message = String(error?.stack || error?.message || error || '').toLowerCase();
  return (
    message.includes('target page, context or browser has been closed') ||
    message.includes('target closed')
  );
}

process.on('unhandledRejection', (reason) => {
  if (isExpectedBrowserCloseError(reason)) {
    console.warn(
      new Date().toISOString(),
      '[process] ignored expected browser-close rejection',
      reason?.message || String(reason)
    );
    return;
  }

  console.error(new Date().toISOString(), '[process] unhandled rejection', reason);
});

function loadLocalEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return;
  }

  const content = readFileSync(filePath, 'utf8');

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (!key || process.env[key]) {
      continue;
    }

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

const currentDir = dirname(fileURLToPath(import.meta.url));
loadLocalEnvFile(resolve(currentDir, '../.env.local'));

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.NOVA_MANAGED_BACKEND !== '1') {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
}

await import('./index.js');
