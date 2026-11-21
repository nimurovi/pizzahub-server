export const STRIPE_API_VERSION = "2025-06-30.basil";
export const PRICE_MINOR = 1000;
export const FREE_LIMIT = 3;
export const objectId = (value) => typeof value === "string" ? value : value?.id;
export function premiumActive(billing, now = new Date()) {
  return billing?.verified === true &&
    ["active", "past_due"].includes(billing.status) &&
    new Date(billing.paidUntil ?? 0).getTime() > now.getTime();
}
export function premiumExpression(prefix = "$billing") {
  return { $and: [
    { $eq: [`${prefix}.verified`, true] },
    { $in: [`${prefix}.status`, ["active", "past_due"]] },
    { $gt: [{ $ifNull: [`${prefix}.paidUntil`, new Date(0)] }, "$$NOW"] },
  ] };
}
export function paidInvoice(invoice, subscriptionId, priceId) {
  const invoiceSubscription = objectId(invoice.parent?.subscription_details?.subscription ?? invoice.subscription);
  if (invoice.status !== "paid" || invoice.paid_out_of_band === true ||
      invoice.currency !== "usd" || invoice.amount_paid !== PRICE_MINOR ||
      invoiceSubscription !== subscriptionId || invoice.lines?.has_more) return null;
  const lines = invoice.lines?.data ?? [];
  if (lines.length !== 1) return null;
  const line = lines[0];
  const price = objectId(line.pricing?.price_details?.price ?? line.price);
  const prorated = line.parent?.subscription_item_details?.proration ?? line.proration;
  if (price !== priceId || line.quantity !== 1 || prorated || line.amount !== PRICE_MINOR ||
      !Number.isInteger(line.period?.start) || !Number.isInteger(line.period?.end) ||
      line.period.end <= line.period.start) return null;
  return { start: new Date(line.period.start * 1000), end: new Date(line.period.end * 1000) };
}

export function verifiedInvoicePayment(payment, invoice, livemode) {
  const intent = payment.payment?.payment_intent;
  return payment.status === "paid" && payment.currency === "usd" &&
    payment.amount_paid === PRICE_MINOR && objectId(payment.invoice) === invoice.id &&
    payment.livemode === livemode && payment.payment?.type === "payment_intent" &&
    intent && typeof intent !== "string" && intent.status === "succeeded" &&
    intent.currency === "usd" && intent.amount_received === PRICE_MINOR &&
    intent.livemode === livemode && objectId(intent.customer) === objectId(invoice.customer);
}
