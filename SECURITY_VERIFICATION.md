# PizzaHub JWT security verification

## Covered by the code
- Better Auth issues 5-minute JWTs; the frontend fetches access tokens using its existing HttpOnly authentication cookie and sends Bearer tokens to the configured API only. Tokens are not saved to localStorage or sessionStorage.
- Backend verifies JWT signature, `iss`, `aud`, `sub`, `iat`, and expiration, and checks the current authenticated session and fresh database account.
- The global `/api` guard protects all application API routes except public menu listings. Better Auth endpoints use their own authentication scheme; the Stripe webhook validates Stripe signatures.
- Admin, Vendor and Customer role middleware uses the database role. The self-service role selection only permits Customer or Vendor.
- Menu update/delete and order cancellation/status mutations use account-scoped database predicates.
- Server-side validation exists for application request payloads; invalid credentials return 401, inadequate access returns 403.

## Verification performed
- `node --check` on `index.js`, `billing.js`, and `billing-policy.js`.
- `node --test security-check.test.js`: static regression tests. These tests check the presence and wiring of important authorization controls, **not live execution** of the API or database.

## Still required before production
- Install packages using `npm ci` for frontend and backend and run their normal build/start processes. Package installation could not be completed in the review environment, so a runtime integration test was not performed.
- Use fresh secrets in `.env` (server) and the correct API origin in `.env.local` (frontend), following the supplied `.env.example` files. The uploaded ZIP included secrets; rotate exposed credentials and keep real environment files outside shared ZIPs and source control.
- Test actual signup, Google sign-in, JWT expiry, revoked sessions, blocked accounts, and unauthorized access to another user's order/menu records with a test MongoDB environment. Test Stripe webhooks with verified events.
- Serve frontend/backend over HTTPS in production with correct cookie/CORS settings and set BETTER_AUTH_URL to the backend's externally reachable canonical origin.

## Changes made
- Prevent auth responses from being cached.
- Reject unexpected fields in the role-onboarding endpoint.
- Reject unexpected request fields when cancelling orders.
- Added security test coverage and environment templates.
- No unrelated UI, business logic, or database schema modifications.
