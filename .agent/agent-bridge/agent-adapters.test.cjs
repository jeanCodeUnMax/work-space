const test = require('node:test');
const assert = require('node:assert');
const adapters = require('./agent-adapters');

test('acquireAcpLock: premier verrouillage reussit', () => {
    adapters.releaseAcpLock('kilo');
    const res = adapters.acquireAcpLock('kilo', 5000);
    assert.strictEqual(res.acquired, true);
    assert.strictEqual(res.agent, 'kilo');
    assert.strictEqual(adapters.isAcpLocked('kilo', 5000), true);
});

test('acquireAcpLock: double verrouillage dans le TTL echoue avec raison explicite', () => {
    const res = adapters.acquireAcpLock('kilo', 5000);
    assert.strictEqual(res.acquired, false);
    assert.strictEqual(typeof res.remainingMs, 'number');
    assert.strictEqual(res.reason, 'Session ACP deja active pour cet agent (protection anti-doublon)');
});

test('releaseAcpLock: libere le verrou et permet une nouvelle acquisition', () => {
    adapters.releaseAcpLock('kilo');
    assert.strictEqual(adapters.isAcpLocked('kilo', 5000), false);
    const res = adapters.acquireAcpLock('kilo', 5000);
    assert.strictEqual(res.acquired, true);
    adapters.releaseAcpLock('kilo');
});
