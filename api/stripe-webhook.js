// api/stripe-webhook.js
// Listens for Stripe events and keeps Supabase profiles in sync.
//
// Required environment variables (set in Vercel Dashboard → Settings → Environment Variables):
//   STRIPE_SECRET_KEY          = sk_live_...
//   STRIPE_WEBHOOK_SECRET      = whsec_...   (from Stripe Dashboard → Webhooks)
//   SUPABASE_URL               = https://xxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  = eyJ...  (service role — NOT the anon key)
//
// To register the webhook endpoint in Stripe:
//   Dashboard → Developers → Webhooks → Add endpoint
//   URL: https://blumi.ca/api/stripe-webhook
//   Events to listen for:
//     checkout.session.completed
//     customer.subscription.updated
//     customer.subscription.deleted
//     invoice.payment_failed

const stripe    = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

// Use the service role key so we can write to profiles without RLS blocking us
function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// Map Stripe Price IDs → our tier names
// Keep this in sync with create-checkout-session.js
const PRICE_TO_TIER = {
  'price_1TbAmADeU3RWQQbVbbnFo0al': 'personal',
  'price_1TbAmADeU3RWQQbVgtExVUZB': 'solo',
  'price_1TbAm9DeU3RWQQbVmdcGdAHM': 'practice',
  'price_1TbAmADeU3RWQQbV53BgTBR9': 'collective',
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end('Method Not Allowed');

  const sig  = req.headers['stripe-signature'];
  const body = req.body; // raw buffer — must be raw, see note below

  let event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const sb = getSupabase();

  // ── checkout.session.completed ──────────────────────────────────────
  // Fired when the customer completes the Stripe Checkout form (card accepted).
  // For subscriptions this fires before the first invoice is paid.
  // For one-time payments this is the only event we need.
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { userId, plan } = session.metadata || {};

    if (!userId || !plan) {
      console.warn('[webhook] checkout.session.completed missing metadata', session.id);
      return res.status(200).json({ received: true });
    }

    const tier = plan; // metadata.plan is already the tier name ('personal', 'solo', etc.)
    const role = tier === 'personal' ? 'client' : 'birth_worker';

    console.log(`[webhook] activating userId=${userId} tier=${tier}`);

    // Upsert the profile row with the paid tier and stripe customer id
    const { error } = await sb.from('profiles').upsert({
      id:                  userId,
      role,
      tier,
      stripe_customer_id:  session.customer   || null,
      stripe_subscription: session.subscription || null,
      paid:                true,
      paid_at:             new Date().toISOString(),
    }, { onConflict: 'id' });

    if (error) {
      console.error('[webhook] profile upsert failed:', error.message);
      // Still return 200 so Stripe doesn't retry infinitely — log it and investigate
    }

    return res.status(200).json({ received: true });
  }

  // ── customer.subscription.updated ──────────────────────────────────
  // Handles plan changes made directly in Stripe (e.g. from the billing portal).
  if (event.type === 'customer.subscription.updated') {
    const sub = event.data.object;
    const { userId, plan } = sub.metadata || {};

    if (!userId) return res.status(200).json({ received: true });

    // If the subscription is active or trialing, ensure the tier is set
    if (['active', 'trialing'].includes(sub.status)) {
      // Derive tier from the price id on the first item
      const priceId = sub.items?.data?.[0]?.price?.id;
      const tier    = (plan || PRICE_TO_TIER[priceId]) || null;

      if (tier) {
        await sb.from('profiles').update({ tier, paid: true }).eq('id', userId);
      }
    }

    return res.status(200).json({ received: true });
  }

  // ── customer.subscription.deleted ──────────────────────────────────
  // Fired when a subscription is fully cancelled (not just paused).
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const { userId } = sub.metadata || {};

    if (userId) {
      console.log(`[webhook] subscription cancelled userId=${userId}`);
      await sb.from('profiles').update({ tier: null, paid: false }).eq('id', userId);
    }

    return res.status(200).json({ received: true });
  }

  // ── invoice.payment_failed ──────────────────────────────────────────
  // Optionally handle failed renewals here (e.g. send a warning email).
  if (event.type === 'invoice.payment_failed') {
    const invoice = event.data.object;
    console.warn(`[webhook] payment failed for customer ${invoice.customer}`);
    // You could look up the user by stripe_customer_id and send them a nudge.
    return res.status(200).json({ received: true });
  }

  // All other events — acknowledge and ignore
  return res.status(200).json({ received: true });
};

// ── IMPORTANT: Vercel raw body ──────────────────────────────────────────
// Stripe signature verification requires the raw request body (not parsed JSON).
// Add this to your vercel.json or a middleware config:
//
//   In vercel.json, add:
//   {
//     "functions": {
//       "api/stripe-webhook.js": { "bodyParser": false }
//     }
//   }
//
// Alternatively, export a config object (works in Next.js API routes):
module.exports.config = {
  api: { bodyParser: false },
};