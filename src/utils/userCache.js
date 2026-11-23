// Tiny in-process cache of raw user records, used by the auth middleware. Models clear entries when a user is saved.
const TTL_MS = 15000;
const cache = new Map();
const drop = (id) => { if (id) cache.delete(String(id)); };
const get = (id) => { const h = cache.get(String(id)); return h && h.expires > Date.now() ? h.raw : null; };
const set = (id, raw) => { if (cache.size > 5000) cache.clear(); cache.set(String(id), { raw, expires: Date.now() + TTL_MS }); };
const clear = () => cache.clear();
module.exports = { drop, get, set, clear };
