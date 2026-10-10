import Stripe from "stripe";

let client;

const getStripe = () => {
    if (!client) client = new Stripe(process.env.STRIPE_SECRET_KEY);
    return client;
};

/**
 * Verifica la firma del webhook. `rawBody` debe ser el Buffer SIN parsear.
 * Lanza error si la firma no es válida.
 */
export const constructWebhookEvent = (rawBody, signature) =>
    getStripe().webhooks.constructEvent(
        rawBody,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
    );

/**
 * Crea una Checkout Session con la cantidad exacta de lugares.
 * El folio viaja en client_reference_id y vuelve en el webhook.
 * Los métodos de pago (tarjeta, OXXO…) se activan en el Dashboard de Stripe.
 */
export const createCheckoutSession = ({ folio, priceId, quantity }) => {
    const site = process.env.SITE_URL;
    return getStripe().checkout.sessions.create({
        mode: "payment",
        line_items: [{ price: priceId, quantity }],
        client_reference_id: folio,
        locale: "es",
        phone_number_collection: { enabled: true },
        success_url: `${site}/sanacion?pago=ok`,
        cancel_url: `${site}/sanacion`,
    });
};

/* ───────────── Precios: la fuente de verdad es Stripe ─────────────
 * Lee el monto de cada Price (en pesos) y lo guarda 10 min en memoria,
 * así la página y el backend siempre muestran lo mismo que cobra Stripe.
 */
const priceCache = new Map(); // priceId -> { amount, at }
const PRICE_TTL = 10 * 60_000;

export const getPriceAmount = async (priceId) => {
    const hit = priceCache.get(priceId);
    if (hit && Date.now() - hit.at < PRICE_TTL) return hit.amount;
    const price = await getStripe().prices.retrieve(priceId);
    if (price.unit_amount == null) throw new Error(`El precio ${priceId} no tiene monto fijo`);
    const amount = price.unit_amount / 100;
    priceCache.set(priceId, { amount, at: Date.now() });
    return amount;
};

/* ───────────── Método de pago ─────────────
 * Devuelve cómo pagó la persona (tarjeta/Apple Pay/Google Pay/OXXO)
 * y, si es OXXO, la liga a su ficha y cuándo vence.
 */
export const getPaymentInfo = async (paymentIntentId) => {
    if (!paymentIntentId) return null;
    const pi = await getStripe().paymentIntents.retrieve(paymentIntentId, {
        expand: ["payment_method", "latest_charge"],
    });

    const charge = typeof pi.latest_charge === "object" ? pi.latest_charge : null;
    const details = charge?.payment_method_details;
    const pm = typeof pi.payment_method === "object" ? pi.payment_method : null;

    const type = details?.type ?? pm?.type ?? pi.payment_method_types?.[0] ?? "";
    const card = details?.card ?? pm?.card;
    const method = {
        type, // "card" | "oxxo" | …
        brand: card?.brand ?? "",
        last4: card?.last4 ?? "",
        wallet: card?.wallet?.type ?? "", // "apple_pay" | "google_pay" | ""
    };

    const oxxo = pi.next_action?.oxxo_display_details;
    return {
        method,
        oxxoVoucherUrl: oxxo?.hosted_voucher_url ?? undefined,
        oxxoExpiresAt: oxxo?.expires_after ? new Date(oxxo.expires_after * 1000) : undefined,
    };
};