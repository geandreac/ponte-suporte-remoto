// Histórico local de sessões (somente neste navegador). Guarda metadados mínimos:
// papel, nome da outra pessoa, horários, motivo de encerramento e permissões usadas.
// Nunca guarda códigos, tokens, mensagens ou arquivos.

const KEY = 'ponte.history.v1';
const MAX_ENTRIES = 20;

export function loadHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.slice(0, MAX_ENTRIES) : [];
  } catch {
    return [];
  }
}

export function addHistory(entry) {
  const clean = {
    role: entry.role === 'host' ? 'host' : 'viewer',
    peerName: String(entry.peerName ?? '').slice(0, 64),
    startedAt: Number(entry.startedAt) || Date.now(),
    endedAt: Number(entry.endedAt) || Date.now(),
    endReason: String(entry.endReason ?? '').slice(0, 40),
    permissions: Array.isArray(entry.permissions) ? entry.permissions.slice(0, 5) : [],
  };
  try {
    localStorage.setItem(KEY, JSON.stringify([clean, ...loadHistory()].slice(0, MAX_ENTRIES)));
  } catch {
    // armazenamento indisponível (aba anônima, cota): o histórico é só uma conveniência
  }
}

export function clearHistory() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignorado
  }
}
