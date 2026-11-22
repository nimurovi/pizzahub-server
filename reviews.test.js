import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import { createTestDatabase } from './test-support/review-db.js';
import { registerReviews, content, target, eligibleFilter, ratingStages } from './reviews.js';

let mongo, client, db, server, url;
const customer = 'customer-1', vendor = 'vendor-1';
const item = '111111111111111111111111';
const accounts = {
  customer: { _id: customer, name: 'Customer One', role: 'customer' },
  other: { _id: 'customer-2', name: 'Customer Two', role: 'customer' },
  vendor: { _id: vendor, name: 'Restaurant', role: 'vendor' },
  admin: { _id: 'admin-1', name: 'Admin', role: 'admin' },
  blocked: { _id: customer, role: 'customer', isBlocked: true },
  incomplete: { _id: customer, role: 'customer', roleSelectionPending: true }
};
// Authentication is a test harness only. Production registration is behind the
// existing signature/session verification; security-check.test.js checks that wiring.
const requireRole = (...roles) => (req, res, next) => roles.includes(req.account.role) && !req.account.roleSelectionPending ? next() : res.status(403).json({ message: 'Forbidden' });
before(async () => {
  if (process.env.REVIEWS_REAL_MONGO === '1') {
    mongo = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION || '7.0.24' } });
    client = await new MongoClient(mongo.getUri()).connect();
    db = client.db('reviews_test');
  } else {
    db = createTestDatabase();
  }
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.account = accounts[req.get('x-test-user')];
    if (!req.account) return res.status(401).json({ message: 'Unauthorized' });
    if (req.account.isBlocked) return res.status(403).json({ message: 'Blocked' });
    next();
  });
  await registerReviews({ app, db, requireRole, requireOrderCustomer: requireRole('customer', 'vendor') });
  app.use((error, req, res, next) => { res.status(500).json({ message: error.message }); });
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  url = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 180000 });
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await client?.close(); await mongo?.stop();
});
beforeEach(async () => {
  await Promise.all(['orders', 'reviews', 'menuItems'].map(name => db.collection(name).deleteMany({})));
  await db.collection('orders').insertOne({ customerId: customer, vendorId: vendor, itemId: item, itemName: 'Margherita', vendorName: 'Restaurant', status: 'accepted', orderDate: '2020-01-01', createdAt: new Date('2020-01-01') });
  await db.collection('menuItems').insertOne({ _id: new ObjectId(item), vendorId: vendor });
});
async function call(path, method = 'GET', body, user = 'customer') {
  const response = await fetch(url + path, { method, headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
}
const payload = (extra = {}) => ({ targetType: 'item', targetId: item, rating: 4, text: 'A delicious fresh pizza.', ...extra });
async function create(extra = {}) {
  const response = await call('/api/reviews', 'POST', payload(extra));
  assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.data._id;
}
async function moderate(reviewId, status = 'approved', reason = '') {
  const review = await db.collection('reviews').findOne({ _id: new ObjectId(reviewId) });
  return call(`/api/admin/reviews/${reviewId}`, 'PATCH', { status, reason, revision: review.revision }, 'admin');
}
async function targetData(type = 'item', targetId = item) { return call(`/api/reviews/target/${type}/${targetId}`); }

test('validation rejects invalid ratings, text, targets, forged identity and status', async () => {
  for (const rating of [0, 6, 2.5, '5', null]) assert.equal((await call('/api/reviews', 'POST', payload({ rating }))).status, 400);
  for (const text of ['', '          ', 'x'.repeat(2001), 42, {}]) assert.equal((await call('/api/reviews', 'POST', payload({ text }))).status, 400);
  for (const extra of [{ customerId: 'other' }, { status: 'approved' }, { orderId: 'forged' }, { targetType: 'user' }, { targetId: 'invalid' }]) assert.equal((await call('/api/reviews', 'POST', payload(extra))).status, 400);
  assert.throws(() => content([])); assert.throws(() => target('restaurant', ''));
  assert.equal(eligibleFilter(customer, {}, new Date('2026-11-22')).orderDate.$lt, '2026-11-22');
});
test('authentication and current account restrictions apply', async () => {
  for (const [user, status] of [[null, 401], ['blocked', 403], ['incomplete', 403], ['admin', 403]]) assert.equal((await call('/api/reviews', 'POST', payload(), user)).status, status);
});
test('only accepted orders on previous dates qualify', async () => {
  for (const status of ['pending', 'rejected', 'cancelled']) {
    await db.collection('orders').updateMany({}, { $set: { status } });
    assert.equal((await call('/api/reviews', 'POST', payload())).status, 403);
  }
  for (const orderDate of [new Date().toISOString().slice(0, 10), '2099-01-01']) {
    await db.collection('orders').updateMany({}, { $set: { status: 'accepted', orderDate } });
    assert.equal((await call('/api/reviews', 'POST', payload())).status, 403);
  }
});
test('another customer’s order and self-owned restaurant cannot qualify', async () => {
  assert.equal((await call('/api/reviews', 'POST', payload(), 'other')).status, 403);
  await db.collection('orders').updateMany({}, { $set: { customerId: vendor } });
  assert.equal((await call('/api/reviews', 'POST', payload(), 'vendor')).status, 403);
});
test('item and restaurant reviews are independent, pending, and server-attributed', async () => {
  await create(); await create({ targetType: 'restaurant', targetId: vendor });
  const mine = await call('/api/reviews/mine');
  assert.equal(mine.body.data.total, 2); assert.equal(mine.cache, 'no-store');
  const stored = await db.collection('reviews').findOne({ targetType: 'item' });
  assert.equal(stored.customerId, customer); assert.equal(stored.authorName, 'Customer One'); assert.equal(stored.status, 'pending'); assert.ok(stored.orderId);
  assert.equal((await targetData()).body.data.reviewCount, 0);
});
test('unique index prevents concurrent duplicate submissions', async () => {
  const results = await Promise.all([call('/api/reviews', 'POST', payload()), call('/api/reviews', 'POST', payload())]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
});
test('approval, edit, rejection and deletion update aggregates immediately', async () => {
  const reviewId = await create(); assert.equal((await moderate(reviewId)).status, 200);
  let data = (await targetData()).body.data;
  assert.equal(data.averageRating, 4); assert.equal(data.reviewCount, 1);
  assert.equal(data.reviews[0].customerId, undefined); assert.equal(data.reviews[0].orderId, undefined);
  assert.equal((await call(`/api/reviews/${reviewId}`, 'PATCH', { rating: 2, text: 'Updated honest experience.' })).status, 200);
  assert.equal((await targetData()).body.data.reviewCount, 0);
  await moderate(reviewId, 'rejected', 'Please remove personal details.');
  assert.equal((await call('/api/reviews/mine')).body.data.reviews[0].moderationReason, 'Please remove personal details.');
  await moderate(reviewId); assert.equal((await targetData()).body.data.averageRating, 2);
  assert.equal((await call(`/api/reviews/${reviewId}`, 'DELETE')).status, 200);
  data = (await targetData()).body.data; assert.equal(data.reviewCount, 0); assert.equal(data.averageRating, 0);
});
test('database average handles multiple reviewers and menu/restaurant separation', async () => {
  const a = await create(); await moderate(a);
  await db.collection('orders').insertOne({ customerId: 'customer-2', vendorId: vendor, itemId: item, status: 'accepted', orderDate: '2020-01-02' });
  const b = await call('/api/reviews', 'POST', payload({ rating: 1 }), 'other'); await moderate(b.body.data._id);
  const c = await create({ targetType: 'restaurant', targetId: vendor, rating: 5 }); await moderate(c);
  const [row] = await db.collection('menuItems').aggregate(ratingStages()).toArray();
  assert.equal(row.averageRating, 2.5); assert.equal(row.reviewCount, 2);
  assert.equal(row.restaurantAverageRating, 5); assert.equal(row.restaurantReviewCount, 1);
});
test('customer cannot edit/delete someone else’s review or call admin routes', async () => {
  const reviewId = await create();
  assert.equal((await call(`/api/reviews/${reviewId}`, 'PATCH', { rating: 1, text: 'Unowned review edit.' }, 'other')).status, 404);
  assert.equal((await call(`/api/reviews/${reviewId}`, 'DELETE', undefined, 'other')).status, 404);
  assert.equal((await call('/api/admin/reviews')).status, 403);
  assert.equal((await call(`/api/admin/reviews/${reviewId}`, 'PATCH', { status: 'approved', reason: '', revision: 1 })).status, 403);
  assert.equal((await call(`/api/admin/reviews/${reviewId}`, 'DELETE')).status, 403);
});
test('moderation guards against approving a revision edited since admin read', async () => {
  const reviewId = await create();
  await call(`/api/reviews/${reviewId}`, 'PATCH', { rating: 3, text: 'Changed review contents.' });
  assert.equal((await call(`/api/admin/reviews/${reviewId}`, 'PATCH', { status: 'approved', reason: '', revision: 1 }, 'admin')).status, 409);
  assert.equal((await targetData()).body.data.reviewCount, 0);
});
test('admin moderation validates reason/status/fields and can remove reviews', async () => {
  const reviewId = await create();
  for (const body of [{ status: 'rejected', reason: '', revision: 1 }, { status: 'invalid', reason: '', revision: 1 }, { status: 'approved', reason: '', revision: 1, rating: 5 }]) assert.equal((await call(`/api/admin/reviews/${reviewId}`, 'PATCH', body, 'admin')).status, 400);
  await moderate(reviewId); await moderate(reviewId, 'pending'); assert.equal((await targetData()).body.data.reviewCount, 0);
  assert.equal((await call(`/api/admin/reviews/${reviewId}`, 'DELETE', undefined, 'admin')).status, 200);
});
test('eligible targets deduplicate repeated orders and include both target types', async () => {
  await db.collection('orders').insertOne({ customerId: customer, vendorId: vendor, itemId: item, itemName: 'Margherita', vendorName: 'Restaurant', status: 'accepted', orderDate: '2020-01-02' });
  const response = await call('/api/reviews/eligible');
  assert.equal(response.status, 200); assert.equal(response.body.data.targets.length, 2);
  assert.equal((await targetData()).body.data.eligible, true);
});
test('invalid identifiers, pagination and status filters fail safely', async () => {
  for (const path of ['/api/reviews/mine?page=0', '/api/reviews/eligible?page[]=1', `/api/reviews/target/item/${item}?page=no`, '/api/reviews/target/user/abc']) assert.equal((await call(path)).status, 400);
  assert.equal((await call('/api/reviews/not-an-id', 'DELETE')).status, 400);
  assert.equal((await call('/api/admin/reviews?status=invalid', 'GET', undefined, 'admin')).status, 400);
});
test('review operations never alter order snapshots', async () => {
  const original = await db.collection('orders').findOne({});
  const reviewId = await create(); await moderate(reviewId); await call(`/api/reviews/${reviewId}`, 'DELETE');
  assert.deepEqual(await db.collection('orders').findOne({}), original);
});
