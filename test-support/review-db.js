// Test-only in-memory adapter. Mingo evaluates the actual MongoDB query and
// aggregation expressions. Run test:integration for native MongoDB verification.
import { Query, aggregate } from 'mingo';
import { ObjectId } from 'mongodb';
export function createTestDatabase() {
  const collections = new Map();
  function collection(name) {
    if (collections.has(name)) return collections.get(name);
    let rows = [];
    const unique = [];
    const matches = filter => new Query(filter);
    // Mingo has no BSON ObjectId type: normalize BSON only at its boundary.
    const normalize = value => value instanceof ObjectId ? value.toHexString() : value instanceof Date ? value : Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry)])) : value;
    const pipeline = (data, stages) => aggregate(normalize(data), stages, { collectionResolver: key => normalize(collection(key).rows()) });
    const api = {
      rows: () => rows,
      async createIndex(fields, options = {}) { if (options.unique) unique.push(Object.keys(fields)); },
      async insertOne(document) {
        const row = { ...document, _id: document._id ?? new ObjectId() };
        if (unique.some(keys => rows.some(existing => keys.every(key => String(existing[key]) === String(row[key]))))) throw Object.assign(new Error('Duplicate'), { code: 11000 });
        rows.push(row); return { insertedId: row._id };
      },
      find(filter, options = {}) {
        let result = rows.filter(row => matches(filter).test(row));
        const cursor = {
          sort(value) { result = pipeline(result, [{ $sort: value }]); return cursor; },
          skip(value) { result = result.slice(value); return cursor; },
          limit(value) { result = result.slice(0, value); return cursor; },
          async toArray() { return options.projection ? pipeline(result, [{ $project: options.projection }]) : result.map(row => ({ ...row })); }
        };
        return cursor;
      },
      async findOne(filter, options = {}) {
        const cursor = api.find(filter, options); if (options.sort) cursor.sort(options.sort);
        return (await cursor.limit(1).toArray())[0] ?? null;
      },
      async countDocuments(filter) { return rows.filter(row => matches(filter).test(row)).length; },
      aggregate(stages) { return { async toArray() { return pipeline(rows, stages); } }; },
      async updateOne(filter, update) { return updateRows(filter, update, true); },
      async updateMany(filter, update) { return updateRows(filter, update, false); },
      async deleteOne(filter) { const index = rows.findIndex(row => matches(filter).test(row)); if (index < 0) return { deletedCount: 0 }; rows.splice(index, 1); return { deletedCount: 1 }; },
      async deleteMany(filter) { const old = rows.length; rows = rows.filter(row => !matches(filter).test(row)); return { deletedCount: old - rows.length }; }
    };
    function updateRows(filter, update, one) {
      let count = 0;
      rows = rows.map(row => {
        if ((one && count) || !matches(filter).test(row)) return row;
        count++; const next = { ...row, ...update.$set };
        for (const key of Object.keys(update.$unset ?? {})) delete next[key];
        for (const [key, increment] of Object.entries(update.$inc ?? {})) next[key] = (next[key] ?? 0) + increment;
        return next;
      }); return { matchedCount: count, modifiedCount: count };
    }
    collections.set(name, api); return api;
  }
  return { collection };
}
