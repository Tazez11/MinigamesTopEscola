const LIMITS = {
  default: { max: 30, windowMs: 5000 },
  'room:create': { max: 5, windowMs: 60000 },
  'room:join': { max: 10, windowMs: 10000 },
  'game:action:stroke': { max: 40, windowMs: 1000 },
  'game:action:clear': { max: 5, windowMs: 2000 },
  'game:action:guess': { max: 6, windowMs: 5000 }
};

function createLimiter() {
  const hits = new Map();

  return function allow(event) {
    const key = LIMITS[event] ? event : 'default';
    const { max, windowMs } = LIMITS[key];
    const now = Date.now();

    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    return true;
  };
}

module.exports = { createLimiter };
