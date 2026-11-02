// Elder rows drag out with Foundry's standard Item drag data.
import test from 'node:test';
import assert from 'node:assert/strict';
const { elderDragData } = await import('../scripts/elder.mjs');

test('uses the document toDragData when present', () => {
  const item = { uuid: 'Actor.a.Item.b', toDragData: () => ({ type: 'Item', uuid: 'Actor.a.Item.b' }) };
  assert.deepEqual(elderDragData(item), { type: 'Item', uuid: 'Actor.a.Item.b' });
});

test('falls back to type + uuid', () => {
  assert.deepEqual(elderDragData({ uuid: 'Actor.a.Item.c' }), { type: 'Item', uuid: 'Actor.a.Item.c' });
});
