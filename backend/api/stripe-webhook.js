// POST /api/stripe-webhook — Stripe event handler
//
// Receives subscription lifecycle events from Stripe and updates the
// user's subscription status in Upstash so the extension + PWA can
// gate Pro features.
//
// Signature verification is done with the raw request body using
// the webhook secret. We cannot use readJsonBody() here because the
// signature is computed over the raw bytes.
//
// Required env vars:
//   STRIPE_SECRET_KEY        — for any follow-up Stripe API calls
//   STRIPE_WEBHOOK_SECRET    — whsec_xxx, used to verify signatures
//   UPSTASH_REDIS_REST_URL / TOKEN — to write subscription state
//
// Set up the webhook in Stripe Dashboard → Webhooks → Add endpoint →
//   URL: https://backend-kappa-nine-57.vercel.app/api/stripe-webhook
//   Events: checkout.session.completed,
//           customer.subscription.created,
//           customer.subscription.updated,
//           customer.subscription.deleted,
//           invoice.payment_failed
import crypto from "crypto";

export const config = {
  api: { bodyParser: false },   // raw body required for signature check
};

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Verify Stripe-Signature header using HMAC-SHA256
function verifyStripeSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  // Format: "t=<timestamp>,v1=<signature>"
  const parts = signatureHeader.split(",").reduce((acc, p) => {
    const [k, v] = p.split("=");
    acc[k] = v;
    return acc;
  }, {});
  if (!parts.t || !parts.v1) return false;
  const signedPayload = parts.t + "." + rawBody.toString("utf8");
  const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
  // Constant-time compare
  if (expected.length !== parts.v1.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  }
  return mismatch === 0;
}

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function upstashSet(key, value, ttlSeconds) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  const path = ttlSeconds
    ? `setex/${encodeURIComponent(key)}/${ttlSeconds}/${encodeURIComponent(JSON.stringify(value))}`
    : `set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`;
  await fetch(`${UPSTASH_URL}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  }).catch(() => {});
}

async function upstashSadd(key, member) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  await fetch(`${UPSTASH_URL}/sadd/${encodeURIComponent(key)}/${encodeURIComponent(member)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  }).catch(() => {});
}

async function recordSubscription(installId, subData) {
  if (!installId) return;
  const key = `kl:subscription:${installId}`;
  await upstashSet(key, subData);

  // Track active Pro users in a set (admin panel uses this for MRR)
  if (subData.status === "active" || subData.status === "trialing") {
    await upstashSadd("kl:pro_users", installId);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).end();
    return;
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET || "";
  const sig = req.headers["stripe-signature"];

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch {
    res.status(400).json({ error: "bad_body" });
    return;
  }

  // Verify signature unless we're missing the secret (dev-only)
  if (secret && !verifyStripeSignature(rawBody, sig, secret)) {
    console.warn("[stripe-webhook] invalid signature");
    res.status(400).json({ error: "invalid_signature" });
    return;
  }

  let event;
  try { event = JSON.parse(rawBody.toString("utf8")); }
  catch { res.status(400).json({ error: "bad_json" }); return; }

  const obj = event?.data?.object || {};
  const installId = obj?.metadata?.installId
    || obj?.subscription_data?.metadata?.installId
    || "";

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        // Subscription created via Checkout. obj is a Checkout Session.
        const subId = obj.subscription;
        const customerId = obj.customer;
        const tier = obj.metadata?.tier || "pro";
        const iid = obj.client_reference_id || installId;
        if (iid) {
          await recordSubscription(iid, {
            tier,
            status: "active",
            customerId,
            subscriptionId: subId,
            createdAt: Date.now(),
          });
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const status = obj.status;   // "active" | "trialing" | "past_due" | "canceled" | ...
        const tier = obj.metadata?.tier || "pro";
        const periodEnd = obj.current_period_end;
        const trialEnd = obj.trial_end;
        if (installId) {
          await recordSubscription(installId, {
            tier,
            status,
            customerId: obj.customer,
            subscriptionId: obj.id,
            currentPeriodEnd: periodEnd ? periodEnd * 1000 : null,
            trialEnd: trialEnd ? trialEnd * 1000 : null,
            updatedAt: Date.now(),
          });
        }
        break;
      }
      case "customer.subscription.deleted": {
        if (installId) {
          await recordSubscription(installId, {
            tier: "founder",
            status: "canceled",
            customerId: obj.customer,
            subscriptionId: obj.id,
            canceledAt: Date.now(),
          });
        }
        break;
      }
      case "invoice.payment_failed": {
        // Mark subscription as past_due so the UI can warn the user
        if (installId) {
          await recordSubscription(installId, {
            tier: "pro",
            status: "past_due",
            customerId: obj.customer,
            subscriptionId: obj.subscription,
            updatedAt: Date.now(),
          });
        }
        break;
      }
      default:
        // Other events not handled (no-op)
        break;
    }

    res.status(200).json({ received: true, type: event.type });
  } catch (e) {
    console.error("[stripe-webhook]", e && e.message);
    res.status(500).json({ error: "handler_failed" });
  }
}
