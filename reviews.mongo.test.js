// Never reads the application's .env or connects to production data.
process.env.REVIEWS_REAL_MONGO = '1';
await import('./reviews.test.js');
