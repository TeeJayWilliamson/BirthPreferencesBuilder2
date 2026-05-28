// api/stripe-webhook.js
// Listens for Stripe events and keeps Supabase profiles in sync.
//
// Required environment variables:
//   STRIPE_SECRET_KEY          = sk_live_...
//   STRIPE_WEBHOOK_SECRET      = whsec_...
//   SUPABASE_URL               = https://xxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  = eyJ...
//
// Stripe Dashboard → Webhooks → Add endpoint
//   URL: https://blumi.ca/api/stripe-webhook
//   Events:
//     checkout.session.completed
//     customer.subscription.updated
//     customer.subscription.deleted
//     invoice.payment_failed

const stripe         = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

const PRICE_TO_TIER = {
  'price_1TbAmADeU3RWQQbVbbnFo0al': 'personal',
  'price_1TbAmADeU3RWQQbVgtExVUZB': 'solo',
  'price_1TbAm9DeU3RWQQbVmdcGdAHM': 'practice',
  'price_1TbAmADeU3RWQQbV53BgTBR9': 'collective',
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end('Method Not Allowed');

  const sig  = req.headers['stripe-signature'];
  const body = req.body;

  let event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const sb = getSupabase();

  // ── checkout.session.completed ────────────────────────────────────────
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { userId, plan } = session.metadata || {};

    if (!userId || !plan) {
      console.warn('[webhook] checkout.session.completed missing metadata', session.id);
      return res.status(200).json({ received: true });
    }

    const role = plan === 'personal' ? 'client' : 'birth_worker';
    console.log(`[webhook] activating userId=${userId} tier=${plan}`);

    const { error } = await sb.from('profiles').upsert({
      id:                  userId,
      role,
      tier:                plan,
      stripe_customer_id:  session.customer      || null,
      stripe_subscription: session.subscription  || null,
      paid:                true,
      paid_at:             new Date().toISOString(),
    }, { onConflict: 'id' });

    if (error) console.error('[webhook] profile upsert failed:', error.message);

    // For team tiers: if admin metadata was stored on the user, create the
    // admin provider row now (in case they signed up via /pricing/ and it
    // wasn't created yet).
    if (['practice', 'collective'].includes(plan)) {
      const { data: profile } = await sb
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

      // Check metadata from Supabase auth user
      const { data: { user } } = await sb.auth.admin.getUserById(userId).catch(() => ({ data: { user: null } }));
      const meta = user?.user_metadata || {};
      if (meta.admin_name && meta.admin_pin) {
        const { data: existing } = await sb
          .from('practice_providers')
          .select('id')
          .eq('birth_worker_id', userId)
          .eq('is_admin', true)
          .maybeSingle();

        if (!existing) {
          await sb.from('practice_providers').insert({
            birth_worker_id: userId,
            name:     meta.admin_name,
            pin:      meta.admin_pin,
            is_admin: true,
          });
        }
      }
    }

    return res.status(200).json({ received: true });
  }

  // ── customer.subscription.updated ────────────────────────────────────
  if (event.type === 'customer.subscription.updated') {
    const sub = event.data.object;
    const { userId, plan } = sub.metadata || {};

    if (!userId) return res.status(200).json({ received: true });

    if (['active', 'trialing'].includes(sub.status)) {
      const priceId = sub.items?.data?.[0]?.price?.id;
      const tier    = plan || PRICE_TO_TIER[priceId] || null;
      if (tier) {
        await sb.from('profiles').update({ tier, paid: true }).eq('id', userId);
      }
    }

    // If subscription moves to past_due / unpaid, mark as unpaid
    if (['past_due', 'unpaid', 'incomplete_expired'].includes(sub.status)) {
      await sb.from('profiles').update({ paid: false }).eq('id', userId);
    }

    return res.status(200).json({ received: true });
  }

  // ── customer.subscription.deleted ────────────────────────────────────
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const { userId } = sub.metadata || {};

    if (userId) {
      console.log(`[webhook] subscription cancelled userId=${userId}`);
      await sb.from('profiles').update({
        tier:                null,
        paid:                false,
        stripe_subscription: null,
      }).eq('id', userId);
    }

    return res.status(200).json({ received: true });
  }

  // ── invoice.payment_failed ────────────────────────────────────────────
  if (event.type === 'invoice.payment_failed') {
    const invoice = event.data.object;
    console.warn(`[webhook] payment failed for customer ${invoice.customer}`);
    // Optionally: look up user by stripe_customer_id and send an email nudge
    return res.status(200).json({ received: true });
  }

  return res.status(200).json({ received: true });
};

module.exports.config = {
  api: { bodyParser: false },
};