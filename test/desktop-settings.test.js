import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadSettings, saveSettings, signalingUrlFor, validateSettings } from '../desktop/settings.mjs';

test('modo local não precisa de endereço', () => {
  assert.deepEqual(validateSettings({ mode: 'local', serverUrl: 'qualquer' }), { ok: true, value: { mode: 'local', serverUrl: '' } });
  assert.equal(validateSettings(null).value.mode, 'local');
});

test('servidor remoto exige HTTPS e guarda só a origem', () => {
  assert.deepEqual(validateSettings({ mode: 'remote', serverUrl: ' https://suporte.exemplo.com/painel?x=1 ' }).value,
    { mode: 'remote', serverUrl: 'https://suporte.exemplo.com' });
  assert.match(validateSettings({ mode: 'remote', serverUrl: 'http://suporte.exemplo.com' }).error, /HTTPS/);
  assert.match(validateSettings({ mode: 'remote', serverUrl: 'ftp://x' }).error, /HTTPS/);
  assert.match(validateSettings({ mode: 'remote', serverUrl: 'javascript:alert(1)' }).error, /HTTPS|inválido/);
  assert.match(validateSettings({ mode: 'remote', serverUrl: '' }).error, /endereço/);
  assert.match(validateSettings({ mode: 'remote', serverUrl: 'https://user:senha@x.com' }).error, /usuário ou senha/);
  // HTTP só no próprio computador (desenvolvimento).
  assert.equal(validateSettings({ mode: 'remote', serverUrl: 'http://localhost:8080' }).ok, true);
});

test('endereço do WebSocket deriva do servidor', () => {
  assert.equal(signalingUrlFor('https://suporte.exemplo.com'), 'wss://suporte.exemplo.com/ws');
  assert.equal(signalingUrlFor('http://localhost:8080'), 'ws://localhost:8080/ws');
});

test('salvar e carregar ajustes; arquivo inválido volta ao padrão', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponte-settings-'));
  try {
    assert.deepEqual(await loadSettings(dir), { mode: 'local', serverUrl: '' });
    await saveSettings(dir, { mode: 'remote', serverUrl: 'https://a.com' });
    assert.deepEqual(await loadSettings(dir), { mode: 'remote', serverUrl: 'https://a.com' });
    if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'settings.json')).mode & 0o777, 0o600);
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ mode: 'remote', serverUrl: 'http://inseguro.com' }));
    assert.deepEqual(await loadSettings(dir), { mode: 'local', serverUrl: '' });
    writeFileSync(join(dir, 'settings.json'), '{quebrado');
    assert.equal((await loadSettings(dir)).mode, 'local');
    assert.ok(readFileSync(join(dir, 'settings.json'), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
