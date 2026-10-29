// Token bucket por chave (ex.: IP + ação). Limita força bruta de códigos e inundação de mensagens.

export function createRateLimiter({ capacity, refillPerSecond, now = Date.now, maxKeys = 10_000 }) {
  const buckets = new Map();

  const refill = (b, t) => Math.min(capacity, b.tokens + ((t - b.last) / 1000) * refillPerSecond);

  function prune(t = now()) {
    for (const [key, b] of buckets) if (refill(b, t) >= capacity) buckets.delete(key);
    // Se ainda estiver cheio, descarta os mais antigos (Map preserva ordem de inserção).
    for (const key of buckets.keys()) {
      if (buckets.size < maxKeys) break;
      buckets.delete(key);
    }
  }

  function take(key, cost = 1) {
    const t = now();
    let b = buckets.get(key);
    if (!b) {
      if (buckets.size >= maxKeys) prune(t);
      b = { tokens: capacity, last: t };
      buckets.set(key, b);
    }
    b.tokens = refill(b, t);
    b.last = t;
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }

  return { take, prune, get size() { return buckets.size; } };
}
