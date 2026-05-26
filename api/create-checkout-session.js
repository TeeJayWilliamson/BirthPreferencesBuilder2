// api/create-checkout-session.js
// Called by the frontend to create a Stripe Checkout session.
// Set these in Vercel Dashboard → Project → Settings → Environment Variables:
//   STRIPE_SECRET_KEY      = sk_live_...
//   NEXT_PUBLIC_SITE_URL   = https://yourdomain.com  (no trailing slash)

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const PRICE_IDS = {
  personal:   'price_1TbAmADeU3RWQQbVbbnFo0al',
  solo:       'price_1TbAmADeU3RWQQbVgtExVUZB',
  practice:   'price_1TbAm9DeU3RWQQbVmdcGdAHM',
  collective: 'price_1TbAmADeU3RWQQbV53BgTBR9',
};

// Personal is a one-time payment; the rest are subscriptions
const ONE_TIME = ['personal'];

module.exports = async (req, res) => {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { plan, userId, email, successPath, cancelPath } = req.body;

  if (!plan || !PRICE_IDS[plan]) {
    return res.status(400).json({ error: 'Invalid plan' });
  }
  if (!userId || !email) {
    return res.status(400).json({ error: 'userId and email are required' });
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://blumi.ca';
  const isOneTime = ONE_TIME.includes(plan);

  try {
    const sessionParams = {
      mode:               isOneTime ? 'payment' : 'subscription',
      customer_email:     email,
      line_items: [{ price: PRICE_IDS[plan], quantity: 1 }],
      // Pass userId and plan through so the webhook can update Supabase
      metadata: { userId, plan },
      success_url: `${siteUrl}${successPath || '/'}?session_id={CHECKOUT_SESSION_ID}&plan=${plan}`,
      cancel_url:  `${siteUrl}${cancelPath  || '/pricing/'}`,
      // Allow promo codes entered at checkout
      allow_promotion_codes: true,
    };

    // For subscriptions, also store metadata on the subscription itself
    if (!isOneTime) {
      sessionParams.subscription_data = { metadata: { userId, plan } };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error('[create-checkout-session]', err.message);
    return res.status(500).json({ error: err.message });
  }
};