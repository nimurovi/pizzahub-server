import { ObjectId } from 'mongodb';

const statuses = ['pending', 'approved', 'rejected'];
const fail = (status, message) => Object.assign(new Error(message), { status });
const id = value => {
  if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) throw fail(400, 'Invalid review ID.');
  return new ObjectId(value);
};
export function target(type, targetId) {
  if (!['item', 'restaurant'].includes(type) || typeof targetId !== 'string' || !targetId.trim() || targetId.length > 200 || (type === 'item' && !/^[a-f\d]{24}$/i.test(targetId))) throw fail(400, 'Invalid review target.');
  return { targetType: type, targetId: type === 'item' ? targetId.toLowerCase() : targetId };
}
export function content(body, allowed = ['rating', 'text']) {
  if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some(key => !allowed.includes(key))) throw fail(400, 'Unsupported review fields.');
  if (!Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5) throw fail(400, 'Choose an integer rating from 1 to 5.');
  if (typeof body.text !== 'string' || body.text.trim().length < 10 || body.text.trim().length > 2000) throw fail(400, 'Write a review between 10 and 2,000 characters.');
  return { rating: body.rating, text: body.text.trim() };
}
export function eligibleFilter(customerId, selection = {}, now = new Date()) {
  return { customerId, status: 'accepted', orderDate: { $lt: now.toISOString().slice(0, 10) }, ...selection };
}
function pageOf(query) {
  if (Object.keys(query).some(key => !['page', 'status'].includes(key))) throw fail(400, 'Unsupported review query.');
  const page = query.page ?? '1';
  if (typeof page !== 'string' || !/^[1-9]\d{0,5}$/.test(page)) throw fail(400, 'Invalid page.');
  return Number(page);
}
const publicFields = { _id: 1, authorName: 1, rating: 1, text: 1, createdAt: 1, updatedAt: 1, targetType: 1, targetId: 1, targetName: 1, status: 1 };

// Calculated from approved documents, so edits/deletions/moderation never leave stale totals.
export function ratingStages() {
  return ['item', 'restaurant'].flatMap(type => {
    const prefix = type === 'item' ? '' : 'restaurant';
    const average = prefix ? 'restaurantAverageRating' : 'averageRating';
    const count = prefix ? 'restaurantReviewCount' : 'reviewCount';
    return [
      { $lookup: { from: 'reviews', let: { target: { $toString: type === 'item' ? '$_id' : '$vendorId' } }, pipeline: [
        { $match: { status: 'approved', targetType: type, $expr: { $eq: ['$targetId', '$$target'] } } },
        { $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } }
      ], as: '_rating' } },
      { $set: { [average]: { $ifNull: [{ $arrayElemAt: ['$_rating.average', 0] }, 0] }, [count]: { $ifNull: [{ $arrayElemAt: ['$_rating.count', 0] }, 0] } } },
      { $unset: '_rating' }
    ];
  });
}

export async function registerReviews({ app, db, requireRole, requireOrderCustomer }) {
  const reviews = db.collection('reviews');
  const orders = db.collection('orders');
  await reviews.createIndex({ customerId: 1, targetType: 1, targetId: 1 }, { unique: true });
  await reviews.createIndex({ targetType: 1, targetId: 1, status: 1, createdAt: -1, _id: -1 });
  await reviews.createIndex({ status: 1, createdAt: -1, _id: -1 });
  const route = fn => async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try { await fn(req, res); } catch (error) {
      if (error.code === 11000) return res.status(409).json({ success: false, message: 'You already reviewed this target. Edit your existing review.' });
      if (error.status) return res.status(error.status).json({ success: false, message: error.message });
      next(error);
    }
  };
  const owner = req => String(req.account._id);
  async function eligibility(req, selection) {
    const field = selection.targetType === 'item' ? 'itemId' : 'vendorId';
    const order = await orders.findOne(eligibleFilter(owner(req), { [field]: selection.targetId }), { sort: { createdAt: -1 } });
    if (!order || String(order.vendorId) === owner(req)) throw fail(403, 'An accepted order from a previous date is required. You cannot review your own restaurant.');
    return order;
  }
  async function list(res, filter, page, projection = publicFields) {
    const [rows, total] = await Promise.all([
      reviews.find(filter, { projection }).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * 10).limit(10).toArray(),
      reviews.countDocuments(filter)
    ]);
    res.json({ success: true, data: { reviews: rows, page, total, totalPages: Math.max(1, Math.ceil(total / 10)) } });
  }
  app.get('/api/reviews/mine', requireOrderCustomer, route(async (req, res) => {
    await list(res, { customerId: owner(req) }, pageOf(req.query), { ...publicFields, moderationReason: 1 });
  }));
  app.get('/api/reviews/eligible', requireOrderCustomer, route(async (req, res) => {
    const page = pageOf(req.query);
    const rows = await orders.aggregate([
      { $match: eligibleFilter(owner(req), { vendorId: { $ne: owner(req) } }) },
      { $project: { targets: [
        { targetType: 'item', targetId: '$itemId', targetName: '$itemName' },
        { targetType: 'restaurant', targetId: '$vendorId', targetName: '$vendorName' }
      ] } }, { $unwind: '$targets' },
      { $group: { _id: { type: '$targets.targetType', id: '$targets.targetId' }, target: { $first: '$targets' } } },
      { $sort: { '_id.type': 1, '_id.id': 1 } },
      { $facet: { targets: [{ $skip: (page - 1) * 20 }, { $limit: 20 }, { $replaceRoot: { newRoot: '$target' } }], total: [{ $count: 'count' }] } }
    ]).toArray();
    const data = rows[0];
    res.json({ success: true, data: { targets: data?.targets ?? [], page, totalPages: Math.max(1, Math.ceil((data?.total[0]?.count ?? 0) / 20)) } });
  }));
  app.get('/api/reviews/target/:type/:targetId', route(async (req, res) => {
    const selection = target(req.params.type, req.params.targetId);
    const page = pageOf(req.query);
    const filter = { ...selection, status: 'approved' };
    const [rows, summary, mine] = await Promise.all([
      reviews.find(filter, { projection: publicFields }).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * 10).limit(10).toArray(),
      reviews.aggregate([{ $match: filter }, { $group: { _id: null, averageRating: { $avg: '$rating' }, reviewCount: { $sum: 1 } } }]).toArray(),
      reviews.findOne({ ...selection, customerId: owner(req) }, { projection: { ...publicFields, moderationReason: 1 } })
    ]);
    let eligible = false;
    if (['customer', 'vendor'].includes(req.account.role) && !req.account.roleSelectionPending) {
      try { await eligibility(req, selection); eligible = true; } catch (error) { if (error.status !== 403) throw error; }
    }
    const stats = summary[0] ?? { averageRating: 0, reviewCount: 0 };
    res.json({ success: true, data: { reviews: rows, averageRating: stats.averageRating, reviewCount: stats.reviewCount, mine, eligible, page, totalPages: Math.max(1, Math.ceil(stats.reviewCount / 10)) } });
  }));
  app.post('/api/reviews', requireOrderCustomer, route(async (req, res) => {
    const fields = content(req.body, ['rating', 'text', 'targetType', 'targetId']);
    const selection = target(req.body.targetType, req.body.targetId);
    const order = await eligibility(req, selection);
    const now = new Date();
    const review = { ...selection, ...fields, customerId: owner(req), authorName: req.account.name || 'Customer', targetName: selection.targetType === 'item' ? order.itemName : order.vendorName, orderId: String(order._id), status: 'pending', createdAt: now, updatedAt: now, revision: 1 };
    const result = await reviews.insertOne(review);
    res.status(201).json({ success: true, data: { _id: String(result.insertedId), status: 'pending' } });
  }));
  app.patch('/api/reviews/:id', requireOrderCustomer, route(async (req, res) => {
    const fields = content(req.body);
    const filter = { _id: id(req.params.id), customerId: owner(req) };
    const review = await reviews.findOne(filter);
    if (!review) throw fail(404, 'Review not found.');
    await eligibility(req, review);
    const result = await reviews.updateOne(filter, { $set: { ...fields, status: 'pending', updatedAt: new Date() }, $inc: { revision: 1 }, $unset: { moderationReason: '', moderatedBy: '', moderatedAt: '' } });
    if (!result.matchedCount) throw fail(404, 'Review not found.');
    res.json({ success: true });
  }));
  app.delete('/api/reviews/:id', requireOrderCustomer, route(async (req, res) => {
    const result = await reviews.deleteOne({ _id: id(req.params.id), customerId: owner(req) });
    if (!result.deletedCount) throw fail(404, 'Review not found.');
    res.json({ success: true });
  }));
  app.get('/api/admin/reviews', requireRole('admin'), route(async (req, res) => {
    const status = req.query.status ?? 'pending';
    if (!['all', ...statuses].includes(status)) throw fail(400, 'Invalid review status.');
    await list(res, status === 'all' ? {} : { status }, pageOf(req.query), { ...publicFields, moderationReason: 1, revision: 1 });
  }));
  app.patch('/api/admin/reviews/:id', requireRole('admin'), route(async (req, res) => {
    const body = req.body;
    if (!body || Array.isArray(body) || Object.keys(body).some(key => !['status', 'reason', 'revision'].includes(key)) || !statuses.includes(body.status) || !Number.isInteger(body.revision) || body.revision < 1 || typeof body.reason !== 'string' || body.reason.trim().length > 500 || (body.status === 'rejected' && !body.reason.trim())) throw fail(400, 'Provide a valid status, review revision, and reason (required for rejection; maximum 500 characters).');
    const result = await reviews.updateOne({ _id: id(req.params.id), revision: body.revision }, { $set: { status: body.status, moderationReason: body.reason.trim(), moderatedBy: owner(req), moderatedAt: new Date() }, $inc: { revision: 1 } });
    if (!result.matchedCount) throw fail(409, 'Review changed or was deleted. Refresh before moderating.');
    res.json({ success: true });
  }));
  app.delete('/api/admin/reviews/:id', requireRole('admin'), route(async (req, res) => {
    const result = await reviews.deleteOne({ _id: id(req.params.id) });
    if (!result.deletedCount) throw fail(404, 'Review not found.');
    res.json({ success: true });
  }));
}
