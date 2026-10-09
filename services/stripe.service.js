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