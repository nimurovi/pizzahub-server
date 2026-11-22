# PizzaHub Reviews & Ratings

## What changed

- Ratings (integer 1–5) and written reviews (10–2,000 trimmed characters) for menu items and restaurants. A restaurant is the existing vendor account; no duplicate restaurant model was introduced.
- Menu cards display the item and restaurant averages/counts. The item detail page contains separate review sections for both targets.
- My Orders links to `/dashboard/my-reviews`: eligible orders, create/edit/delete, approval status and rejection feedback. Eligible targets and review lists are paginated.
- Admin Dashboard → Reviews: filter by status, approve, reject/hide with a reason, return to pending, or delete. Moderation uses revision checks so a stale Admin screen cannot approve newly edited text.
- Every new or edited review starts pending. Only approved reviews appear in shared lists and contribute to live database averages/counts. Empty averages are zero and the UI displays “No reviews yet”.
- One review per account per target, enforced with a unique compound index. One order can qualify for both an item review and a restaurant review.
- All review endpoints remain behind the existing global Bearer JWT, current-session and account-block checks. Write routes also check the current account role and ownership. Client-supplied author IDs, order IDs and moderation statuses are rejected.
- Existing users, orders, payments, subscriptions, Stripe handlers, JWT verification and theme CSS are untouched. New UI uses existing theme-compatible classes.

## Verified-order policy

The supplied project has pending, accepted, rejected and cancelled orders, with no completed/delivered status. Eligibility therefore requires an accepted order whose scheduled `orderDate` is earlier than the current UTC date. The server finds the order for the signed-in account and requested item/vendor; the client cannot nominate an order. Vendors may review their customer orders at another restaurant, matching the existing order permissions, but cannot review themselves. Admins cannot submit customer reviews.

“Verified order” means an eligible recorded order. It does not claim verified delivery or payment. Stripe in this project handles vendor billing and was not repurposed for customer reviews. Deleting or disabling a menu item does not remove historical reviews; eligible historical targets remain manageable from My Reviews.

## Install and run

1. Extract both ZIPs side by side as `pizzahub/` and `pizzahub-server/`.
2. Keep/copy your existing `pizzahub/.env.local` and `pizzahub-server/.env` from the original projects. Real environment files are excluded from these source ZIPs; unchanged `.env.example` files are included. No new environment variables are required by the feature.
3. Run `npm ci` in both folders. Start the backend with `npm start`; start the frontend with `npm run dev`.
4. Backend startup automatically creates the new `reviews` collection indexes. No existing-data migration is needed. The database user must have the same index-creation permissions used by existing startup code.
5. Sign in as a customer with an accepted order dated before today. Use My Orders → My Reviews or open an item detail page. Approve the submitted review using a separate Admin account. Refresh the menu/details to see updated totals.

Source packages exclude `.git`, installed dependencies, generated Next.js output, test binaries and real environment files. Public images and original source/configuration files are retained.

## API

All routes require the existing application JWT plus session cookie.

| Method and path | Access / behavior |
| --- | --- |
| GET `/api/reviews/target/:type/:targetId?page=1` | Signed-in users; approved reviews, averages/counts, own review and eligibility. `type` is `item` or `restaurant`. |
| GET `/api/reviews/eligible?page=1` | Customer/order-capable vendor; distinct eligible targets, 20 per page. |
| GET `/api/reviews/mine?page=1` | Customer/order-capable vendor; own reviews and moderation feedback, 10 per page. |
| POST `/api/reviews` | Eligible customer; `{targetType,targetId,rating,text}`. |
| PATCH `/api/reviews/:id` | Owner; `{rating,text}`; rechecks eligibility and returns to pending. |
| DELETE `/api/reviews/:id` | Owner; delete review. |
| GET `/api/admin/reviews?status=pending&page=1` | Admin; `pending`, `approved`, `rejected`, or `all`. |
| PATCH `/api/admin/reviews/:id` | Admin; `{status,reason,revision}`; reason required for rejection, maximum 500 characters. |
| DELETE `/api/admin/reviews/:id` | Admin; delete review. |

Menu API responses additionally expose `averageRating`, `reviewCount`, `restaurantAverageRating`, and `restaurantReviewCount`. Totals are computed after page limits on browse/featured queries, with an indexed approved-review lookup.

## Verification and limitations (2026-11-22)

- Backend `npm test`: **24/24 passed**. Includes the 10 original static security checks and 14 new HTTP route/query tests. Tests cover validation, eligibility, account restrictions, owner isolation, separate targets, duplicates, moderation races, aggregate updates, pagination validation and unchanged orders.
- The default route tests use a test-only in-memory adapter with Mingo executing the query/aggregation expressions. Authentication middleware is a fixture; the existing security checks inspect production JWT wiring. These are not a replacement for live JWT/MongoDB integration tests.
- `npm run test:integration` runs the same review suite against an isolated native MongoDB process. It downloads a test MongoDB binary on first use and never reads application `.env` or contacts the production database. This environment prevented MongoDB startup: MongoDB 8.2 failed its CPU detection, and MongoDB 7.0.24 failed with `open: Operation not permitted`. Native integration tests therefore remain unverified. Run this command on your development machine/CI before deploying. `MONGOMS_VERSION` can select a compatible binary version.
- Frontend `npx tsc --noEmit`: **passed**.
- Frontend `npm run lint`: **zero errors**, one pre-existing unused `Image` import warning in `app/page.tsx`.
- Backend syntax checks for `index.js` and `reviews.js`: **passed**.
- Frontend `npm run build`: compilation and TypeScript succeeded; prerendering failed at the original `components/shared/Footer.tsx:175` (`new Date().getFullYear()` with Cache Components enabled). Rebuilding the original uploaded frontend reproduced the same failure at `/auth/complete`. Footer and layout were left unchanged to honor the requested scope. The existing Footer prerender issue must be addressed before a production build can succeed.
- No live Stripe transactions, production database mutations or full browser end-to-end tests were performed.

## Changed source files

Frontend: `types.ts`, `components/menu/MenuCard.tsx`, `components/admin/AdminDashboard.tsx`, `app/(main)/menu/[id]/page.tsx`, `app/(main)/dashboard/my-orders/page.tsx`; new `components/reviews/Reviews.tsx` and `app/(main)/dashboard/my-reviews/page.tsx`.

Backend: `index.js`, `package.json`, `package-lock.json`; new `reviews.js`, `reviews.test.js`, `reviews.mongo.test.js`, `test-support/review-db.js`. Added test-only dev dependencies: `mingo`, `mongodb-memory-server-core`. Production dependencies remain unchanged.

Both packages include this `REVIEWS_AND_RATINGS.md` guide.
