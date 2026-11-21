import express from "express";
import Stripe from "stripe";
import { ObjectId } from "mongodb";
import { randomUUID } from "node:crypto";
import { STRIPE_API_VERSION, FREE_LIMIT, PRICE_MINOR, objectId, premiumActive, paidInvoice, verifiedInvoicePayment } from "./billing-policy.js";

const terminalStatuses = ["canceled", "incomplete_expired"];
const handledEvents = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "invoice.paid",
  "invoice_payment.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
]);
const failure = (status, message) => Object.assign(new Error(message), { httpStatus: status });

export async function createBilling({ client, db, clientUrl, stripeClient }) {
  const users = db.collection("users");
  const menu = db.collection("menuItems");
  const attempts = db.collection("billingAttempts");
  const locks = db.collection("billingLocks");
  const events = db.collection("stripeEvents");
  const transactions = db.collection("transactions");
  const secret = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const priceId = process.env.STRIPE_PREMIUM_PRICE_ID;
  const enabled = Boolean(secret && webhookSecret && priceId);
  if ([secret, webhookSecret, priceId].some(Boolean) && !enabled) {
    throw new Error("Set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PREMIUM_PRICE_ID together.");
  }
  const stripe = enabled ? (stripeClient ?? new Stripe(secret, {
    apiVersion: STRIPE_API_VERSION, timeout: 10000, maxNetworkRetries: 1,
  })) : null;
  let liveMode = false;
  if (stripe) {
    const price = await stripe.prices.retrieve(priceId);
    if (!price.active || price.currency !== "usd" || price.unit_amount !== PRICE_MINOR ||
      price.recurring?.interval !== "month" || price.recurring?.interval_count !== 1 ||
      price.recurring?.usage_type !== "licensed" || price.billing_scheme !== "per_unit") {
      throw new Error("Stripe Price must be an active USD 10.00 monthly recurring, per-unit licensed price.");
    }
    liveMode = price.livemode;
  }
  await attempts.createIndex({ vendorId: 1, createdAt: -1 });
  await attempts.createIndex({ sessionId: 1 }, {
    unique: true, partialFilterExpression: { sessionId: { $type: "string" } },
  });
  await transactions.createIndex({ vendorId: 1, paidAt: -1 });
  await users.createIndex({ "billing.nextReconcileAt": 1 });
  // _id is already unique on attempts, events, transactions, and locks.

  const ids = (id) => /^[a-fA-F0-9]{24}$/.test(String(id))
    ? [String(id), new ObjectId(String(id))] : [String(id)];
  const owner = (id) => ({ _id: { $in: ids(id) } });
  const itemOwner = (id) => ({ vendorId: { $in: ids(id) } });

  // One persistent billing lease per vendor. Token checks fence stale workers.
  async function withLock(vendorId, operation) {
    try { await locks.updateOne({ _id: vendorId }, { $setOnInsert: { until: new Date(0) } }, { upsert: true }); }
    catch (error) { if (error.code !== 11000) throw error; }
    const token = randomUUID();
    const result = await locks.updateOne(
      { _id: vendorId, until: { $lte: new Date() } },
      { $set: { token, until: new Date(Date.now() + 120000) } }
    );
    if (!result.matchedCount) throw failure(409, "Subscription update in progress. Please try again shortly.");
    const guard = async (session) => {
      const check = await locks.updateOne(
        { _id: vendorId, token, until: { $gt: new Date() } },
        { $inc: { version: 1 } }, { session }
      );
      if (!check.matchedCount) throw failure(409, "Subscription update timed out. Please try again.");
    };
    try { return await operation(guard); }
    finally { await locks.updateOne({ _id: vendorId, token }, { $set: { until: new Date(0) } }); }
  }

  async function transaction(operation) {
    const session = client.startSession();
    try {
      return await session.withTransaction(() => operation(session), {
        readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary",
      });
    } finally { await session.endSession(); }
  }

  async function trimFreeItems(user, session) {
    if (premiumActive(user.billing)) return;
    const extra = await menu.find({
      ...itemOwner(user._id), isAvailable: true,
      status: { $in: ["pending", "approved"] },
    }, { session, projection: { _id: 1 } }).sort({ createdAt: 1, _id: 1 }).skip(FREE_LIMIT).toArray();
    if (extra.length) await menu.updateMany({ _id: { $in: extra.map((item) => item._id) } }, {
      $set: { isAvailable: false, availabilityReason: "free_plan_limit", updatedAt: new Date() },
    }, { session });
  }

  // Called from menu write transactions AFTER locking the same user document.
  async function limitFor(account, session) {
    const current = await users.findOne({ _id: account._id }, { session });
    return premiumActive(current?.billing) ? Infinity : FREE_LIMIT;
  }

  function subscriptionView(user) {
    const billing = user.billing;
    const premium = premiumActive(billing);
    return {
      plan: premium ? "premium" : "free", activeItemLimit: premium ? null : FREE_LIMIT,
      checkoutEnabled: enabled, status: billing?.status ?? "none",
      priceMinor: PRICE_MINOR, currency: "USD", interval: "month",
      paidUntil: billing?.paidUntil ?? null,
      cancelAtPeriodEnd: billing?.cancelAtPeriodEnd === true,
      canManage: Boolean(enabled && billing?.subscriptionId && !terminalStatuses.includes(billing.status)),
    };
  }

  // Retrieve CURRENT Stripe state under the vendor lease: old events cannot roll
  // subscription status back. Only this verified-webhook/reconciliation path grants access.
  async function syncSubscription(subscriptionId, guard, event = null, invoiceId = null) {
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const attemptId = sub.metadata?.pizzahubAttemptId;
    const vendorId = sub.metadata?.pizzahubVendorId;
    if (!attemptId || !vendorId) return; // A different product/integration.
    const attempt = await attempts.findOne({ _id: attemptId, vendorId });
    if (!attempt || attempt.priceId !== priceId || sub.livemode !== liveMode) {
      throw failure(400, "Subscription does not match a recorded checkout attempt.");
    }
    const subItem = sub.items.data[0];
    const validProduct = sub.items.data.length === 1 &&
      objectId(subItem?.price) === priceId && subItem.quantity === 1 && !sub.pause_collection;
    const recent = await stripe.invoices.list({ subscription: sub.id, status: "paid", limit: 10 });
    const invoices = [...recent.data];
    if (invoiceId && !invoices.some((invoice) => invoice.id === invoiceId)) {
      invoices.push(await stripe.invoices.retrieve(invoiceId));
    }
    const candidates = invoices.flatMap((invoice) => {
      const period = paidInvoice(invoice, sub.id, priceId);
      return period && objectId(invoice.customer) === objectId(sub.customer) && invoice.livemode === liveMode
        ? [{ invoice, period }] : [];
    });
    const verified = (await Promise.all(candidates.map(async (candidate) => {
      const saved = await transactions.findOne({ _id: candidate.invoice.id, vendorId, subscriptionId: sub.id });
      if (saved) return candidate;
      const payments = await stripe.invoicePayments.list({
        invoice: candidate.invoice.id, status: "paid", limit: 100,
        expand: ["data.payment.payment_intent"]
      });
      // Require a successful Stripe PaymentIntent, not a manually marked-paid invoice.
      return payments.data.some((payment) => verifiedInvoicePayment(payment, candidate.invoice, liveMode)) ? candidate : null;
    }))).filter(Boolean);
    await transaction(async (session) => {
      await guard(session);
      // Same document write as menu mutations: serialize plan and slot changes.
      await users.updateOne(owner(vendorId), { $inc: { menuWriteVersion: 1 } }, { session });
      const user = await users.findOne(owner(vendorId), { session });
      if (!user) throw failure(404, "Vendor account no longer exists.");
      if (event && await events.findOne({ _id: event.id, processed: true }, { session })) return;
      for (const { invoice, period } of verified) {
        await transactions.updateOne({ _id: invoice.id }, {
          $setOnInsert: {
            vendorId, invoiceId: invoice.id, subscriptionId: sub.id, attemptId,
            amountMinor: invoice.amount_paid, currency: "USD", status: "paid",
            paidAt: new Date((invoice.status_transitions?.paid_at ?? invoice.created) * 1000),
            periodStart: period.start, periodEnd: period.end, livemode: liveMode,
            createdAt: new Date(),
          }
        }, { upsert: true, session });
      }
      // Old subscription events may save history, but cannot replace a newer subscription.
      const newer = user.billing?.attemptCreatedAt &&
        new Date(user.billing.attemptCreatedAt) > attempt.createdAt;
      if (!newer) {
        const ledger = await transactions.find({ vendorId, subscriptionId: sub.id, status: "paid" },
          { session }).sort({ periodEnd: -1 }).limit(1).toArray();
        const billing = {
          subscriptionId: sub.id, customerId: objectId(sub.customer),
          attemptId, attemptCreatedAt: attempt.createdAt, verified: true,
          status: validProduct ? sub.status : "unsupported",
          paidUntil: ledger[0]?.periodEnd ?? new Date(0),
          cancelAtPeriodEnd: sub.cancel_at_period_end === true,
          currentPeriodEnd: subItem?.current_period_end ? new Date(subItem.current_period_end * 1000) : null,
          nextReconcileAt: new Date(Date.now() + 5 * 60000), updatedAt: new Date(),
        };
        await users.updateOne({ _id: user._id }, { $set: { billing } }, { session });
        await trimFreeItems({ ...user, billing }, session);
        if (!premiumActive(billing)) await users.updateOne({ _id: user._id }, { $set: { "billing.freeLimitApplied": true } }, { session });
      }
      await attempts.updateOne({ _id: attemptId }, {
        $set: { subscriptionId: sub.id, customerId: objectId(sub.customer), updatedAt: new Date() },
      }, { session });
      if (event) await events.updateOne({ _id: event.id }, {
        $set: { processed: true, processedAt: new Date() },
      }, { session });
    });
  }

  function mountWebhook(app) {
    // Register before express.json().
    app.post(
      "/api/stripe/webhook",
      express.raw({ type: "application/json", limit: "1mb" }),
      async (req, res) => {
        if (!stripe) {
          return res.status(503).send("Billing is not configured.");
        }

        let event;

        try {
          event = stripe.webhooks.constructEvent(
            req.body,
            req.get("stripe-signature"),
            webhookSecret
          );
        } catch {
          return res.status(400).send("Invalid Stripe webhook signature.");
        }

        if (event.livemode !== liveMode) {
          return res.status(400).send("Stripe mode mismatch.");
        }

        if (!handledEvents.has(event.type)) {
          return res.json({ received: true, ignored: true });
        }

        try {
          await events.updateOne(
            { _id: event.id },
            {
              $setOnInsert: {
                type: event.type,
                receivedAt: new Date(),
                processed: false,
              },
            },
            { upsert: true }
          );

          const previous = await events.findOne({ _id: event.id });

          if (previous?.processed === true) {
            return res.json({ received: true });
          }

          const obj = event.data.object;
          let subscriptionId;
          let invoiceId;

          if (event.type.startsWith("checkout.")) {
            const checkout = await stripe.checkout.sessions.retrieve(obj.id);
            subscriptionId = objectId(checkout.subscription);
          } else if (
            event.type === "invoice_payment.paid" ||
            event.type.startsWith("invoice.")
          ) {
            // Invoice payment events contain an invoice reference.
            // Invoice events contain the invoice itself.
            invoiceId =
              event.type === "invoice_payment.paid"
                ? objectId(obj.invoice)
                : obj.id;

            if (!invoiceId) {
              throw new Error("Invoice ID is missing from the Stripe event.");
            }

            const invoice = await stripe.invoices.retrieve(invoiceId);

            subscriptionId = objectId(
              invoice.parent?.subscription_details?.subscription ??
              invoice.subscription
            );

            invoiceId = invoice.id;
          } else if (event.type.startsWith("customer.subscription.")) {
            subscriptionId = obj.id;
          }

          // Checkout without a subscription or a non-subscription invoice.
          if (!subscriptionId) {
            await events.updateOne(
              { _id: event.id },
              {
                $set: {
                  processed: true,
                  ignored: true,
                  processedAt: new Date(),
                },
              }
            );

            return res.json({ received: true, ignored: true });
          }

          const sub = await stripe.subscriptions.retrieve(subscriptionId);
          const vendorId = sub.metadata?.pizzahubVendorId;
          const attemptId = sub.metadata?.pizzahubAttemptId;

          // Ignore subscriptions belonging to another integration.
          if (!vendorId || !attemptId) {
            await events.updateOne(
              { _id: event.id },
              {
                $set: {
                  processed: true,
                  ignored: true,
                  processedAt: new Date(),
                },
              }
            );

            return res.json({ received: true, ignored: true });
          }

          // Existing synchronizer retrieves and verifies invoice payments,
          // checks vendor ownership, and saves changes transactionally.
          await withLock(vendorId, (guard) =>
            syncSubscription(subscriptionId, guard, event, invoiceId)
          );

          console.info("Stripe webhook processed:", {
            eventId: event.id,
            type: event.type,
            subscriptionId,
          });

          return res.json({ received: true });
        } catch (error) {
          console.error("Stripe webhook processing failed:", {
            eventId: event.id,
            type: event.type,
            name: error?.name,
            code: error?.code,
            message: error?.message,
          });

          // A failed operation must remain retryable.
          return res
            .status(500)
            .send("Webhook processing failed; retry required.");
        }
      }
    );
  }

  const route = (handler) => async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    try { await handler(req, res); }
    catch (error) {
      if (error.httpStatus) return res.status(error.httpStatus).json({ success: false, message: error.message });
      next(error);
    }
  };
  function mutation(req, res, next) {
    if (!enabled) return res.status(503).json({ success: false, message: "Payments are not configured yet." });
    if (req.get("origin") !== new URL(clientUrl).origin) return res.status(403).json({ success: false, message: "Request not allowed." });
    if (!req.is("application/json") || !req.body || Array.isArray(req.body) ||
      typeof req.body !== "object" || Object.keys(req.body).length !== 0) {
      return res.status(400).json({ success: false, message: "Send an empty JSON object. Account and pricing are selected by the server." });
    }
    next();
  }

  function mountRoutes(app, requireAccount, requireRole) {
    const admin = [requireAccount, requireRole("admin")];
    const vendor = [requireAccount, requireRole("vendor")];

    // Admin overview: aggregate counts from authoritative collections.
    app.get("/api/admin/overview", ...admin, route(async (req, res) => {
      const [totalUsers, totalVendors, totalCustomers, totalMenuItems, pendingMenuItems, totalTransactions] = await Promise.all([
        users.countDocuments({}),
        users.countDocuments({ role: "vendor" }),
        users.countDocuments({ role: "customer" }),
        menu.countDocuments({}),
        menu.countDocuments({ status: "pending" }),
        transactions.countDocuments({}),
      ]);
      res.set("Cache-Control", "no-store");
      res.json({ success: true, data: { totalUsers, totalVendors, totalCustomers, totalMenuItems, pendingMenuItems, totalTransactions } });
    }));

    // Admin user management. Search and filters are bounded and server-side.
    app.get("/api/admin/users", ...admin, route(async (req, res) => {
      const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 100) : "";
      const role = typeof req.query.role === "string" ? req.query.role : "all";
      if (!(["all", "admin", "vendor", "customer"].includes(role))) throw failure(400, "Invalid role filter.");
      const filter = {};
      if (role !== "all") filter.role = role;
      if (search) {
        const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        filter.$or = [{ name: { $regex: escaped, $options: "i" } }, { email: { $regex: escaped, $options: "i" } }];
      }
      const results = await users.find(filter, { projection: { name: 1, email: 1, role: 1, isBlocked: 1, createdAt: 1 } }).sort({ createdAt: -1 }).limit(200).toArray();
      res.set("Cache-Control", "no-store");
      res.json({ success: true, data: results.map((u) => ({ id: String(u._id), name: u.name ?? "", email: u.email ?? "", role: u.role, isBlocked: u.isBlocked === true, createdAt: u.createdAt ?? null })) });
    }));

    app.patch("/api/admin/users/:id/block", ...admin, route(async (req, res) => {
      const id = req.params.id;
      if (typeof id !== "string" || id.length < 1 || id.length > 200 || !["block", "unblock"].includes(req.body?.action) || Object.keys(req.body ?? {}).some((key) => key !== "action")) throw failure(400, "Invalid user block request.");
      const candidates = /^[a-fA-F0-9]{24}$/.test(id) ? [id, new ObjectId(id)] : [id];
      const target = await users.findOne({ _id: { $in: candidates } }, { projection: { role: 1 } });
      if (!target) throw failure(404, "User not found.");
      if (String(target._id) === String(req.account._id)) throw failure(403, "You cannot block your own admin account.");
      if (target.role === "admin") throw failure(403, "Admin accounts cannot be blocked through this endpoint.");
      const blocked = req.body.action === "block";
      await users.updateOne({ _id: target._id }, { $set: { isBlocked: blocked, updatedAt: new Date() } });
      res.json({ success: true, data: { id, isBlocked: blocked } });
    }));

    // Admin menu moderation. Public browse continues to expose only approved + available items.
    app.get("/api/admin/menu", ...admin, route(async (req, res) => {
      const status = typeof req.query.status === "string" ? req.query.status : "all";
      const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 100) : "";
      if (!["all", "pending", "approved", "rejected"].includes(status)) throw failure(400, "Invalid menu status filter.");
      const filter = {};
      if (status !== "all") filter.status = status;
      if (search) {
        const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        filter.$or = [{ itemName: { $regex: escaped, $options: "i" } }, { vendorName: { $regex: escaped, $options: "i" } }];
      }
      const items = await menu.find(filter).sort({ createdAt: -1 }).limit(250).toArray();
      res.set("Cache-Control", "no-store");
      res.json({ success: true, data: items.map((item) => ({ id: String(item._id), name: item.itemName ?? item.name ?? "", vendorName: item.vendorName ?? "", vendorId: String(item.vendorId ?? ""), category: item.category ?? "", price: item.price ?? null, status: item.status ?? "pending", isAvailable: item.isAvailable === true, createdAt: item.createdAt ?? null })) });
    }));

    app.patch("/api/admin/menu/:id", ...admin, route(async (req, res) => {
      const { status, isAvailable } = req.body ?? {};
      if (Object.keys(req.body ?? {}).some((key) => !["status", "isAvailable"].includes(key)) || (status !== undefined && !["pending", "approved", "rejected"].includes(status)) || (isAvailable !== undefined && typeof isAvailable !== "boolean") || (status === undefined && isAvailable === undefined)) throw failure(400, "Invalid menu moderation request.");
      if (!/^[a-fA-F0-9]{24}$/.test(req.params.id)) throw failure(400, "Invalid menu item ID.");
      const update = { updatedAt: new Date() };
      if (status !== undefined) update.status = status;
      if (isAvailable !== undefined) update.isAvailable = isAvailable;
      if (status === "rejected") update.isAvailable = false;
      const result = await menu.updateOne({ _id: new ObjectId(req.params.id) }, { $set: update });
      if (!result.matchedCount) throw failure(404, "Menu item not found.");
      res.json({ success: true, message: "Menu item updated." });
    }));

    app.delete("/api/admin/menu/:id", ...admin, route(async (req, res) => {
      if (!/^[a-fA-F0-9]{24}$/.test(req.params.id)) throw failure(400, "Invalid menu item ID.");
      const result = await menu.deleteOne({ _id: new ObjectId(req.params.id) });
      if (!result.deletedCount) throw failure(404, "Menu item not found.");
      res.json({ success: true, message: "Menu item deleted." });
    }));

    // Transactions are deliberately read-only: no admin mutation endpoint exists.
    app.get("/api/admin/transactions", ...admin, route(async (req, res) => {
      const rows = await transactions.aggregate([
        { $sort: { paidAt: -1, createdAt: -1 } }, { $limit: 300 },
        { $addFields: { vendorObjectId: { $convert: { input: "$vendorId", to: "objectId", onError: null, onNull: null } } } },
        { $lookup: { from: "users", localField: "vendorObjectId", foreignField: "_id", as: "vendor" } },
        { $unwind: { path: "$vendor", preserveNullAndEmptyArrays: true } },
        { $project: { _id: 1, vendorId: 1, vendorName: { $ifNull: ["$vendor.name", "Unknown vendor"] }, vendorEmail: { $ifNull: ["$vendor.email", ""] }, subscriptionPlan: { $cond: [{ $and: [{ $eq: ["$vendor.billing.verified", true] }, { $in: ["$vendor.billing.status", ["active", "past_due"]] }, { $gt: ["$vendor.billing.paidUntil", "$$NOW"] }] }, "premium", "free"] }, amountMinor: 1, currency: 1, status: 1, paidAt: 1, createdAt: 1, periodEnd: 1, subscriptionId: 1 } },
      ]).toArray();
      res.set("Cache-Control", "no-store");
      res.json({ success: true, data: rows });
    }));
    app.get("/api/vendor/subscription", ...vendor, route(async (req, res) => {
      const history = await transactions.find({ vendorId: String(req.account._id) }, {
        projection: { _id: 1, amountMinor: 1, currency: 1, paidAt: 1, periodEnd: 1, status: 1 },
      }).sort({ paidAt: -1 }).limit(20).toArray();
      res.json({ success: true, data: { subscription: subscriptionView(req.account), transactions: history } });
    }));
    app.post("/api/vendor/subscription/checkout", ...vendor, mutation, route(async (req, res) => {
      const vendorId = String(req.account._id);
      const checkout = await withLock(vendorId, async (guard) => {
        let user = await users.findOne(owner(vendorId));
        const current = user.billing?.subscriptionId;
        if (current) {
          const sub = await stripe.subscriptions.retrieve(current);
          if (!terminalStatuses.includes(sub.status)) throw failure(409, "You already have a subscription. Use Manage billing or refresh its status.");
        }
        let attempt = (await attempts.find({ vendorId }).sort({ createdAt: -1 }).limit(1).toArray())[0];
        if (attempt?.sessionId) {
          const existing = await stripe.checkout.sessions.retrieve(attempt.sessionId);
          if (existing.status === "open") return existing;
          if (existing.status === "complete") {
            const subId = objectId(existing.subscription);
            if (subId && !terminalStatuses.includes((await stripe.subscriptions.retrieve(subId)).status)) {
              throw failure(409, "Payment confirmation is processing or a subscription already exists. Refresh your subscription page.");
            }
          }
          attempt = null;
        }
        if (!attempt) {
          attempt = { _id: randomUUID(), vendorId, priceId, email: user.email, createdAt: new Date() };
          await transaction(async (session) => { await guard(session); await attempts.insertOne(attempt, { session }); });
        }
        // A timed-out creation is retried with IDENTICAL parameters and idempotency key.
        // After Stripe's idempotency retention window, do not risk a duplicate charge.
        if (Date.now() - attempt.createdAt.getTime() > 23 * 3600000 && !attempt.sessionId) {
          throw failure(409, "An earlier checkout could not be confirmed. Contact support before starting another payment.");
        }
        const result = await stripe.checkout.sessions.create({
          mode: "subscription", payment_method_types: ["card"],
          customer_email: attempt.email, client_reference_id: vendorId,
          line_items: [{ price: priceId, quantity: 1 }],
          metadata: { pizzahubVendorId: vendorId, pizzahubAttemptId: attempt._id },
          subscription_data: { metadata: { pizzahubVendorId: vendorId, pizzahubAttemptId: attempt._id } },
          success_url: `${new URL(clientUrl).origin}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${new URL(clientUrl).origin}/payment/cancel`,
        }, { idempotencyKey: `pizzahub-checkout-${attempt._id}` });
        await transaction(async (session) => {
          await guard(session);
          await attempts.updateOne({ _id: attempt._id }, { $set: { sessionId: result.id } }, { session });
        });
        return result;
      });
      res.json({ success: true, data: { url: checkout.url } });
    }));
    app.get("/api/vendor/subscription/checkout-status", ...vendor, route(async (req, res) => {
      const id = req.query.session_id;
      if (typeof id !== "string" || !/^cs_[A-Za-z0-9_]+$/.test(id) || id.length > 255) throw failure(400, "Invalid checkout session.");
      const attempt = await attempts.findOne({ sessionId: id, vendorId: String(req.account._id) });
      if (!attempt) throw failure(404, "Checkout session not found.");
      const payment = await transactions.findOne({ attemptId: attempt._id, vendorId: String(req.account._id) });
      const user = await users.findOne({ _id: req.account._id });
      // This GET NEVER activates Premium or trusts redirect query parameters.
      res.json({ success: true, data: { paymentConfirmed: Boolean(payment), subscription: subscriptionView(user) } });
    }));
    app.post("/api/vendor/subscription/portal", ...vendor, mutation, route(async (req, res) => {
      const user = await users.findOne({ _id: req.account._id });
      if (!user.billing?.customerId) throw failure(409, "No verified billing account exists yet.");
      const portal = await stripe.billingPortal.sessions.create({
        customer: user.billing.customerId,
        return_url: `${new URL(clientUrl).origin}/dashboard/vendor/subscription`,
      });
      res.json({ success: true, data: { url: portal.url } });
    }));
    app.post("/api/vendor/subscription/cancel", ...vendor, mutation, route(async (req, res) => {
      const vendorId = String(req.account._id);
      await withLock(vendorId, async () => {
        const user = await users.findOne(owner(vendorId));
        if (!user.billing?.subscriptionId) throw failure(409, "No subscription to cancel.");
        const sub = await stripe.subscriptions.retrieve(user.billing.subscriptionId);
        if (terminalStatuses.includes(sub.status)) throw failure(409, "Subscription already ended.");
        await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
        // Confirmation will come from the signed webhook/reconciliation.
      });
      res.json({ success: true, message: "Cancellation requested. Paid access lasts until the end of your paid period. Refresh shortly for confirmation." });
    }));
  }
  async function recoverPendingCheckouts() {
  if (!stripe) return;

  const pending = await attempts.find({
    sessionId: { $type: "string" },
    subscriptionId: { $exists: false },
    recoveryClosed: { $ne: true },
    $or: [
      { nextRecoveryAt: { $exists: false } },
      { nextRecoveryAt: { $lte: new Date() } },
    ],
  })
    .sort({ nextRecoveryAt: 1, createdAt: 1 })
    .limit(25)
    .toArray();

  for (const attempt of pending) {
    try {
      // Schedule another check if this attempt is still pending
      // or Stripe is temporarily unreachable.
      await attempts.updateOne(
        { _id: attempt._id },
        {
          $set: {
            nextRecoveryAt: new Date(Date.now() + 120000),
          },
        }
      );

      await withLock(attempt.vendorId, async (guard) => {
        const current = await attempts.findOne({
          _id: attempt._id,
        });

        // A webhook might already have processed this checkout.
        if (!current || current.subscriptionId) return;

        const checkout = await stripe.checkout.sessions.retrieve(
          current.sessionId
        );

        if (
          checkout.mode !== "subscription" ||
          checkout.livemode !== liveMode ||
          checkout.client_reference_id !== current.vendorId ||
          checkout.metadata?.pizzahubVendorId !== current.vendorId ||
          checkout.metadata?.pizzahubAttemptId !== current._id
        ) {
          throw new Error("Checkout does not match its recorded vendor.");
        }

        if (checkout.status === "expired") {
          await attempts.updateOne(
            { _id: current._id },
            { $set: { recoveryClosed: true } }
          );
          return;
        }

        if (checkout.status !== "complete") return;

        const subscriptionId = objectId(checkout.subscription);
        if (!subscriptionId) {
          throw new Error("Completed checkout has no subscription.");
        }

        // Do not activate Premium just because checkout is complete.
        // This function verifies the price, invoice, PaymentIntent,
        // vendor ownership, and paid period before granting access.
        await syncSubscription(
          subscriptionId,
          guard,
          null,
          objectId(checkout.invoice) ?? null
        );

        console.info("Checkout recovery completed:", {
          attemptId: current._id,
          subscriptionId,
        });
      });
    } catch (error) {
      console.error("Checkout recovery will retry:", {
        attemptId: attempt._id,
        name: error?.name,
        message: error?.message,
      });
    }
  }
}

  let running = false;
  async function reconcile() {
    if (running) return;
    running = true;
    try {
      // Enforce expiry even if Stripe is temporarily unreachable.
      const expired = users.find({ "billing.verified": true, "billing.paidUntil": { $lte: new Date() }, "billing.freeLimitApplied": { $ne: true } }).limit(100);
      for await (const user of expired) {
        await transaction(async (session) => {
          await users.updateOne({ _id: user._id }, { $inc: { menuWriteVersion: 1 } }, { session });
          const fresh = await users.findOne({ _id: user._id }, { session });
          await trimFreeItems(fresh, session);
          if (!premiumActive(fresh.billing)) await users.updateOne({ _id: user._id }, { $set: { "billing.freeLimitApplied": true } }, { session });
        });
      }
      if (!stripe) return;
      await recoverPendingCheckouts();
      const due = users.find({ "billing.verified": true, "billing.nextReconcileAt": { $lte: new Date() } })
        .sort({ "billing.nextReconcileAt": 1 }).limit(25);
      for await (const user of due) {
        try { await withLock(String(user._id), (guard) => syncSubscription(user.billing.subscriptionId, guard)); }
        catch (error) { console.error("Billing reconciliation failed:", String(user._id), error.name); }
      }
    } catch (error) { console.error("Billing maintenance failed:", error.name); }
    finally { running = false; }
  }
  function start() {
    void reconcile();
    const timer = setInterval(() => void reconcile(), 60000);
    timer.unref();
    return () => clearInterval(timer);
  }
  return { mountWebhook, mountRoutes, start, limitFor, subscriptionView, trimFreeItems };
}
