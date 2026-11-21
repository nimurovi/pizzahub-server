// Static security regression checks; do not substitute for deployed integration tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const server = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const billing = readFileSync(new URL('./billing.js', import.meta.url), 'utf8');
const frontendPath = new URL('../pizzahub/lib/api-fetch.ts', import.meta.url);
const frontend = existsSync(frontendPath) ? readFileSync(frontendPath, 'utf8') : null;

test('JWT is signature/issuer/audience/expiry verified', () => {
  for (const fragment of ['jwtVerify(match[1], jwtKeys', 'algorithms: ["EdDSA"]', 'issuer: jwtIssuer', 'audience: jwtAudience', 'requiredClaims: ["sub", "iat", "exp"]', 'maxTokenAge: "5m"']) assert.ok(server.includes(fragment),fragment);
});
test('current session and server-stored role are authoritative', () => {
  for (const fragment of ['auth.api.getSession(', 'session.user.id !== payload.sub', 'usersCollection.findOne({', 'req.account = account', 'allowedRoles.includes(account.role)']) assert.ok(server.includes(fragment),fragment);
});
test('non-public application API routes use global JWT authentication', () => {
  assert.match(server,/app\.use\("\/api", \(req, res, next\) => \{/);
  assert.match(server,/const publicApiReads = new Set\(\[\s*"\/menu",\s*"\/menu\/featured",/);
  assert.match(server,/return requireAccount\(req, res, next\);/);
  assert.match(server,/app\.use\("\/api\/vendor", requireRole\("vendor"\)\)/);
  assert.match(server,/app\.use\("\/api\/admin", requireRole\("admin"\)\)/);
  assert.match(server,/app\.use\("\/api\/customer", requireRole\("customer"\)\)/);
});
test('order and menu writes use database-bound ownership filters', () => {
  for (const fragment of ['customerId: String(req.account._id)', 'vendorId: String(req.account._id)', 'vendorMenuFilter(req.account, req.params.id)', 'deleteOne(filter', 'updateOne(\n                    {\n                        ...ownershipFilter,']) assert.ok(server.includes(fragment),fragment);
});
test('role onboarding cannot set admin or foreign identities', () => {
  assert.ok(server.includes('Object.keys(body).length !== 1'));
  assert.ok(server.includes('role !== "customer" && role !== "vendor"'));
  assert.ok(server.includes('_id: req.account._id,\n                        role: "customer"'));
});
test('tokens are requested as needed and not persisted in web storage', { skip: frontend === null }, () => {
  assert.ok(frontend.includes('/api/auth/token'));
  assert.ok(frontend.includes('Authorization", `Bearer ${tokenResult.token}`'));
  assert.ok(frontend.includes('redirect: "error"'));
  assert.ok(!/localStorage|sessionStorage/.test(frontend));
});
test('Stripe webhook authenticates signature independently', () => {
  assert.ok(billing.includes('stripe.webhooks.constructEvent('));
  assert.ok(billing.includes('req.get("stripe-signature")'));
});
test('auth responses disable caching and 401/403 are distinguished', () => {
  assert.ok(server.includes('res.set("Cache-Control", "no-store")'));
  assert.ok(server.includes('res.status(401).json('));
  assert.ok(server.includes('res.status(403).json('));
});

test('admin dashboard endpoints are role-protected and expose required management operations', () => {
  for (const fragment of [
    'app.get("/api/admin/overview"',
    'app.get("/api/admin/users"',
    'app.patch("/api/admin/users/:id/block"',
    'app.get("/api/admin/menu"',
    'app.patch("/api/admin/menu/:id"',
    'app.delete("/api/admin/menu/:id"',
    'app.get("/api/admin/transactions"',
    'filter.$or = [{ itemName:',
    'subscriptionPlan:',
  ]) assert.ok(billing.includes(fragment), fragment);
  assert.match(billing, /app\.get\("\/api\/admin\/transactions"[\s\S]*?\n    \}\)\);/);
  assert.doesNotMatch(billing, /app\.(?:patch|post|put|delete)\("\/api\/admin\/transactions/);
});

test('admin dashboard UI is present and guarded by the admin role', () => {
  const adminPage = readFileSync(new URL('../pizzahub/components/admin/AdminDashboard.tsx', import.meta.url), 'utf8');
  const adminLayout = readFileSync(new URL('../pizzahub/app/(main)/dashboard/admin/layout.tsx', import.meta.url), 'utf8');
  assert.ok(adminLayout.includes('<RequireAuth role="admin">'));
  for (const fragment of ['Total registered users', 'Total vendors', 'Total customers', 'Total menu items', 'Pending menu items', 'Total transactions', 'Block', 'Unblock', 'Approve', 'Reject', 'Deactivate', 'Delete', 'Payment records are read-only']) assert.ok(adminPage.includes(fragment), fragment);
});
