import crypto from "node:crypto";
import SanacionOrder from "../models/SanacionOrder.js";
import { createCheckoutSession, getPaymentInfo, getPriceAmount } from "./stripe.service.js";

export class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

/* ───────────── Catálogo de accesos ─────────────
 * Cada acceso usa un Price de Stripe (STRIPE_PRICE_*) en el .env.
 * El monto real se lee de Stripe (getPriceAmount); `price` es sólo el respaldo.
 * Cada lugar Bienhechor = 2 accesos: 1 para quien compra + 1 de regalo, que
 * el bienhechor comparte por WhatsApp o dona a la Iglesia.
 */
const TIERS = {
    bienhechor: {
        label: "Bienhechor",
        price: 350,
        enabled: true,
        givesGift: true,
        priceId: () => process.env.STRIPE_PRICE_BIENHECHOR,
    },
    general: {
        label: "General",
        price: 150,
        enabled: true,
        givesGift: false,
        priceId: () => process.env.STRIPE_PRICE_GENERAL,
    },
};

// Máximo de lugares por pago (OXXO limita cada ficha a $10,000 MXN).
// Debe coincidir con MAX_QTY en Sanacion.tsx.
const MAX_QUANTITY = 10;
export const MAX_MESSAGE = 280;
export const GIFT_STATUSES = ["available", "assigned", "delivered"];

/* ───────────── Helpers ───────────── */
export const normalizePhone = (value = "") => {
    const digits = String(value).replace(/\D/g, "");
    // acepta +52 / 52 / 521 al inicio y se queda con los 10 dígitos
    return digits.length > 10 ? digits.slice(-10) : digits;
};

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sin 0/O/1/I
const generateCode = (prefix, length) => {
    let code = "";
    for (let i = 0; i < length; i++) {
        code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
    return `${prefix}-${code}`;
};
const generateFolio = () => generateCode("ES26", 5);
const newAccessKey = () => crypto.randomBytes(18).toString("base64url"); // 24 caracteres
const newTicket = () => ({ code: generateCode("T26", 8), usedAt: null });
const newGift = (message = "", mode = "pending") => ({
    code: generateCode("REG", 6),
    message,
    mode,
    sharedAt: null,
    status: "available",
    recipientName: "",
    recipientPhone: "",
    usedAt: null,
});

// Acepta el código tal cual o una URL /sanacion/boleto/<código>
const normalizeCode = (raw) => {
    let s = String(raw ?? "").trim();
    const m = s.match(/\/sanacion\/boleto\/([^/?#\s]+)/i);
    if (m) s = decodeURIComponent(m[1]);
    s = s.toUpperCase();
    return s.length > 0 && s.length <= 40 ? s : "";
};

const cleanText = (value, max) => String(value ?? "").trim().replace(/[ \t]+/g, " ").slice(0, max + 1);
const cleanName = (value) => String(value ?? "").trim().replace(/\s+/g, " ");

const isDuplicateKey = (err) => err?.code === 11000;

/* ───────────── Precios (de Stripe, con respaldo) ───────────── */
export const getTierPrice = async (tier) => {
    const t = TIERS[tier];
    try {
        return await getPriceAmount(t.priceId());
    } catch (err) {
        console.warn(`[sanacion] no se pudo leer el precio de ${tier} en Stripe; uso ${t.price}:`, err.message);
        return t.price;
    }
};

export const getPublicPrices = async () => ({
    general: await getTierPrice("general"),
    bienhechor: await getTierPrice("bienhechor"),
});

/* ───────────── Accesos (QR) ─────────────
 * Garantiza que una orden pagada tenga su accessKey, un QR por lugar y,
 * si es Bienhechor, un regalo por lugar. Los filtros evitan duplicar si
 * dos peticiones llegan a la vez.
 */
const ensureTickets = async (order) => {
    if (!order) return order;
    let changed = false;

    if (!order.accessKey) {
        await SanacionOrder.updateOne(
            { _id: order._id, accessKey: { $exists: false } },
            { $set: { accessKey: newAccessKey() } }
        );
        changed = true;
    }

    if (order.status === "paid") {
        const have = order.tickets?.length ?? 0;
        if (have < order.quantity) {
            const extra = Array.from({ length: order.quantity - have }, newTicket);
            await SanacionOrder.updateOne(
                { _id: order._id, [`tickets.${have}`]: { $exists: false } },
                { $push: { tickets: { $each: extra } } }
            );
            changed = true;
        }

        if (order.tier === "bienhechor") {
            const haveGifts = order.gifts?.length ?? 0;
            if (haveGifts < order.quantity) {
                const extra = Array.from({ length: order.quantity - haveGifts }, () => newGift(""));
                await SanacionOrder.updateOne(
                    { _id: order._id, [`gifts.${haveGifts}`]: { $exists: false } },
                    { $push: { gifts: { $each: extra } } }
                );
                changed = true;
            }
        }
    }

    return changed ? SanacionOrder.findById(order._id).lean() : order;
};

// Al arrancar: órdenes pagadas antes de existir los QR/regalos reciben los suyos.
export const backfillPaidOrders = async () => {
    const orders = await SanacionOrder.find({
        status: "paid",
        $or: [
            { accessKey: { $exists: false } },
            { $expr: { $lt: [{ $size: { $ifNull: ["$tickets", []] } }, "$quantity"] } },
            {
                tier: "bienhechor",
                $expr: { $lt: [{ $size: { $ifNull: ["$gifts", []] } }, "$quantity"] },
            },
        ],
    }).lean();
    for (const o of orders) await ensureTickets(o);
    if (orders.length) console.log(`[sanacion] QR generados para ${orders.length} órdenes ya pagadas`);
};

/* ───────────── Crear orden (antes de ir a Stripe) ─────────────
 * giftMode (sólo Bienhechor): "self" = los comparto yo · "church" = los dono a la Iglesia
 */
export const createOrder = async ({ name, phone, tier = "bienhechor", quantity = 1, messages = [], giftMode = "self", payMethod }) => {
    const n = cleanName(name);
    if (n.length < 2) throw new HttpError(400, "Escribe tu nombre para emitir tu acceso.");
    if (n.length > 120) throw new HttpError(400, "El nombre es demasiado largo.");

    const cleanPhone = normalizePhone(phone);
    if (cleanPhone.length !== 10) throw new HttpError(400, "Escribe tu WhatsApp a 10 dígitos.");

    const tierConfig = TIERS[tier];
    if (!tierConfig) throw new HttpError(400, "Acceso no válido.");
    if (!tierConfig.enabled || !tierConfig.priceId()) {
        throw new HttpError(400, `El acceso ${tierConfig.label} aún no está disponible para pago en línea.`);
    }

    const qty = Number(quantity) || 1;
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QUANTITY) {
        throw new HttpError(400, `Puedes reservar de 1 a ${MAX_QUANTITY} lugares por pago.`);
    }

    // Un regalo (con mensaje opcional) por lugar Bienhechor
    let gifts = [];
    if (tierConfig.givesGift) {
        const list = Array.isArray(messages) ? messages : [];
        const msgs = Array.from({ length: qty }, (_, i) => cleanText(list[i], MAX_MESSAGE));
        if (msgs.some((m) => m.length > MAX_MESSAGE)) {
            throw new HttpError(400, `Cada mensaje puede tener hasta ${MAX_MESSAGE} caracteres.`);
        }
        const mode = giftMode === "church" ? "church" : "pending";
        gifts = msgs.map((m) => newGift(m, mode));
    }

    const unitPrice = await getTierPrice(tier);

    // El folio es aleatorio; reintenta si por casualidad ya existe.
    let order;
    for (let attempt = 0; attempt < 5 && !order; attempt++) {
        try {
            order = await SanacionOrder.create({
                folio: generateFolio(),
                accessKey: newAccessKey(),
                name: n,
                phone: cleanPhone,
                tier,
                quantity: qty,
                expectedAmount: unitPrice * qty,
                source: "web",
                gifts,
            });
        } catch (err) {
            if (!isDuplicateKey(err)) throw err;
        }
    }
    if (!order) throw new HttpError(500, "No pudimos generar tu folio. Intenta de nuevo.");

    try {
        const session = await createCheckoutSession({
            folio: order.folio,
            priceId: tierConfig.priceId(),
            quantity: qty,
            method: payMethod === "oxxo" || payMethod === "card" ? payMethod : undefined,
        });
        await SanacionOrder.updateOne(
            { _id: order._id },
            {
                $set: {
                    "stripe.sessionId": session.id,
                    "stripe.checkoutUrl": session.url,
                    "stripe.checkoutExpiresAt": session.expires_at ? new Date(session.expires_at * 1000) : undefined,
                },
            }
        );
        return { order, paymentUrl: session.url };
    } catch (err) {
        await SanacionOrder.deleteOne({ _id: order._id }); // no dejar órdenes huérfanas
        console.error("[sanacion] error creando checkout session:", err.message);
        throw new HttpError(502, "No pudimos iniciar tu pago. Intenta de nuevo.");
    }
};

/* ───────────── Consultar estado (para la página de éxito) ───────────── */
export const getPublicOrder = async (folio) => {
    const order = await SanacionOrder.findOne({ folio: String(folio).toUpperCase() }).lean();
    if (!order) throw new HttpError(404, "No encontramos ese folio.");
    return {
        folio: order.folio,
        status: order.status,
        tier: order.tier,
        quantity: order.quantity,
        firstName: order.name.split(" ")[0], // nunca exponemos el teléfono
        paidAt: order.paidAt ?? null,
    };
};

/* ───────────── Página pública de accesos: /sanacion/boleto/:key ─────────────
 * key = accessKey de la orden (sus QR + sus regalos) o código de un regalo (su QR).
 */
const publicTicket = (t) => ({ code: t.code, usedAt: t.usedAt ?? null });

const publicMethod = (o) => {
    const m = o.stripe?.paymentMethod;
    return m?.type ? { type: m.type, brand: m.brand ?? "", last4: m.last4 ?? "", wallet: m.wallet ?? "" } : null;
};

// Lo que ve el bienhechor de cada regalo (sin el teléfono de quien lo recibe)
const ownerGift = (g) => ({
    code: g.code,
    message: g.message ?? "",
    mode: g.mode ?? "pending",
    sharedAt: g.sharedAt ?? null,
    recipientName: g.mode === "shared" ? g.recipientName ?? "" : "",
    assigned: g.mode === "church" && (g.status ?? "available") !== "available",
    usedAt: g.usedAt ?? null,
});

const orderPass = (order) => {
    const paid = order.status === "paid";
    return {
        kind: "order",
        status: order.status,
        folio: order.folio,
        name: order.name,
        tier: order.tier,
        quantity: order.quantity,
        tickets: paid ? (order.tickets ?? []).map(publicTicket) : [],
        gifts: paid && order.tier === "bienhechor" ? (order.gifts ?? []).map(ownerGift) : [],
        paymentMethod: publicMethod(order),
        oxxoVoucherUrl: order.status === "processing" ? order.stripe?.oxxoVoucherUrl ?? null : null,
        oxxoExpiresAt: order.status === "processing" ? order.stripe?.oxxoExpiresAt ?? null : null,
        // Mientras no elija método de pago, la liga de WhatsApp le deja retomar el checkout
        paymentUrl:
            order.status === "pending" &&
            order.stripe?.checkoutUrl &&
            (!order.stripe?.checkoutExpiresAt || new Date(order.stripe.checkoutExpiresAt) > new Date())
                ? order.stripe.checkoutUrl
                : null,
    };
};

export const getPass = async (rawKey) => {
    const key = String(rawKey ?? "").trim();
    if (!key || key.length > 64) throw new HttpError(404, "No encontramos este acceso.");

    let order = await SanacionOrder.findOne({ accessKey: key }).lean();
    if (order) return orderPass(await ensureTickets(order));

    const code = normalizeCode(key);
    order = await SanacionOrder.findOne({ "gifts.code": code, status: "paid" }).lean();
    const gift = order?.gifts?.find((g) => g.code === code);
    if (gift) {
        // No revelamos quién lo regaló
        return {
            kind: "gift",
            status: "paid",
            recipientName: gift.recipientName ?? "",
            message: gift.message ?? "",
            tickets: [publicTicket(gift)],
            gifts: [],
        };
    }

    throw new HttpError(404, "No encontramos este acceso.");
};

/* ───────────── El bienhechor decide qué hacer con sus regalos ─────────────
 * POST /pass/:key/gifts/:code { action, recipientName? }
 *   share:       lo mandó por WhatsApp (queda "shared", con nombre opcional)
 *   church:      lo dona a la Iglesia
 *   reset:       cancela un envío por WhatsApp; el regalo vuelve a estar libre.
 *                Donar a la Iglesia es DEFINITIVO: un regalo donado no se puede recuperar.
 *                Si ya se había compartido, cambia el código: la liga anterior deja de servir.
 *   church-all:  dona todos los que aún no decide (code = "all")
 */
export const ownerGiftAction = async (rawKey, rawCode, body = {}) => {
    const key = String(rawKey ?? "").trim();
    const order = await SanacionOrder.findOne({ accessKey: key, status: "paid", tier: "bienhechor" }).lean();
    if (!order) throw new HttpError(404, "No encontramos este acceso.");

    const action = String(body.action ?? "");

    if (action === "church-all") {
        await SanacionOrder.updateOne(
            { _id: order._id },
            { $set: { "gifts.$[g].mode": "church" } },
            { arrayFilters: [{ "g.mode": { $in: ["pending", null] }, "g.usedAt": null }] } // null = regalos de antes de este cambio
        );
        return orderPass(await SanacionOrder.findById(order._id).lean());
    }

    const code = normalizeCode(rawCode);
    const gift = order.gifts?.find((g) => g.code === code);
    if (!gift) throw new HttpError(404, "No encontramos ese regalo.");
    if (gift.usedAt) throw new HttpError(400, "Este regalo ya se usó en la entrada.");

    const p = "gifts.$.";
    const set = {};
    const mode = gift.mode ?? "pending";

    if (action === "share") {
        if (mode === "church") throw new HttpError(400, "Este lugar ya lo donaste a la Iglesia.");
        const rn = cleanName(body.recipientName);
        if (rn.length > 120) throw new HttpError(400, "El nombre es demasiado largo.");
        set[p + "mode"] = "shared";
        set[p + "sharedAt"] = new Date();
        if (body.recipientName !== undefined) set[p + "recipientName"] = rn;
    } else if (action === "church") {
        if (mode === "shared") throw new HttpError(400, "Este lugar ya lo compartiste. Cancela el envío primero.");
        set[p + "mode"] = "church";
    } else if (action === "reset") {
        // Donar a la Iglesia es definitivo
        if (mode === "church") throw new HttpError(400, "Este lugar ya lo donaste a la Iglesia; esa decisión no se puede cambiar.");
        if (mode === "shared") set[p + "code"] = generateCode("REG", 6); // la liga enviada deja de servir
        set[p + "mode"] = "pending";
        set[p + "sharedAt"] = null;
        set[p + "recipientName"] = "";
        set[p + "recipientPhone"] = "";
    } else {
        throw new HttpError(400, "Acción no válida.");
    }

    await SanacionOrder.updateOne({ _id: order._id, gifts: { $elemMatch: { code, usedAt: null } } }, { $set: set });
    return orderPass(await SanacionOrder.findById(order._id).lean());
};

/* ───────────── Admin: entrada con QR ───────────── */
const describe = (order, code, result) => {
    const ti = (order.tickets ?? []).findIndex((t) => t.code === code);
    if (ti >= 0) {
        const t = order.tickets[ti];
        return {
            result,
            code,
            kind: "ticket",
            tier: order.tier,
            holder: order.name,
            folio: order.folio,
            index: ti + 1,
            of: order.tickets.length,
            usedAt: t.usedAt ?? null,
        };
    }
    const gi = (order.gifts ?? []).findIndex((g) => g.code === code);
    const g = order.gifts?.[gi];
    return {
        result,
        code,
        kind: "gift",
        tier: order.tier,
        holder: g?.recipientName || "",
        giver: order.name,
        message: g?.message ?? "",
        folio: order.folio,
        index: gi + 1,
        of: order.gifts?.length ?? 0,
        usedAt: g?.usedAt ?? null,
    };
};

// Valida y "quema" el QR en una sola operación atómica: dos escáneres a la vez
// nunca dejan pasar el mismo código dos veces.
export const checkIn = async (rawCode) => {
    const code = normalizeCode(rawCode);
    if (!code) throw new HttpError(400, "Código vacío.");
    const now = new Date();

    let order = await SanacionOrder.findOneAndUpdate(
        { status: "paid", tickets: { $elemMatch: { code, usedAt: null } } },
        { $set: { "tickets.$.usedAt": now } },
        { new: true }
    ).lean();
    if (order) return describe(order, code, "ok");

    order = await SanacionOrder.findOneAndUpdate(
        { status: "paid", gifts: { $elemMatch: { code, usedAt: null } } },
        { $set: { "gifts.$.usedAt": now } },
        { new: true }
    ).lean();
    if (order) return describe(order, code, "ok");

    order = await SanacionOrder.findOne({ $or: [{ "tickets.code": code }, { "gifts.code": code }] }).lean();
    if (!order) return { result: "invalid", code };
    if (order.status !== "paid") return describe(order, code, "unpaid");
    return describe(order, code, "used");
};

// Por si se escaneó por error: vuelve a activar el QR
export const undoCheckIn = async (rawCode) => {
    const code = normalizeCode(rawCode);
    if (!code) throw new HttpError(400, "Código vacío.");

    let order = await SanacionOrder.findOneAndUpdate(
        { "tickets.code": code },
        { $set: { "tickets.$.usedAt": null } },
        { new: true }
    ).lean();
    if (!order) {
        order = await SanacionOrder.findOneAndUpdate(
            { "gifts.code": code },
            { $set: { "gifts.$.usedAt": null } },
            { new: true }
        ).lean();
    }
    if (!order) throw new HttpError(404, "No encontramos ese código.");
    return describe(order, code, "undone");
};

export const checkInStats = async () => {
    const orders = await SanacionOrder.find({ status: "paid" }, { tickets: 1, gifts: 1 }).lean();
    let total = 0;
    let used = 0;
    for (const o of orders) {
        for (const t of [...(o.tickets ?? []), ...(o.gifts ?? [])]) {
            total++;
            if (t.usedAt) used++;
        }
    }
    return { total, used };
};

// Buscar asistentes por nombre, WhatsApp, folio o código.
// status: "paid" (pagados) o "processing" (esperando pago en OXXO)
export const searchOrders = async (rawQ = "", rawStatus = "paid") => {
    const status = rawStatus === "processing" ? "processing" : "paid";
    const q = String(rawQ).trim().slice(0, 80);
    const filter = { status };
    if (q) {
        const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        const digits = q.replace(/\D/g, "");
        filter.$or = [
            { name: rx },
            { folio: rx },
            { "tickets.code": q.toUpperCase() },
            { "gifts.code": q.toUpperCase() },
            ...(digits.length >= 4 ? [{ phone: { $regex: digits } }] : []),
        ];
    }

    const found = await SanacionOrder.find(filter)
        .sort(status === "paid" ? { paidAt: -1 } : { updatedAt: -1 })
        .limit(50)
        .lean();
    const orders = [];
    for (const o of found) orders.push(await ensureTickets(o));

    return orders.map((o) => ({
        folio: o.folio,
        name: o.name,
        phone: o.phone ?? "",
        tier: o.tier,
        quantity: o.quantity,
        status: o.status,
        paidAt: o.paidAt ?? null,
        createdAt: o.createdAt ?? null,
        accessKey: o.accessKey,
        paymentMethod: publicMethod(o),
        oxxoExpiresAt: o.stripe?.oxxoExpiresAt ?? null,
        amount: o.stripe?.amountTotal != null ? o.stripe.amountTotal / 100 : o.expectedAmount,
        tickets: (o.tickets ?? []).map(publicTicket),
        gifts: (o.gifts ?? []).map((g) => ({ code: g.code, mode: g.mode ?? "pending", usedAt: g.usedAt ?? null })),
    }));
};

/* ───────────── Admin: boletos de regalo ───────────── */
const publicGift = (g) => ({
    code: g.code,
    message: g.message ?? "",
    mode: g.mode ?? "pending",
    sharedAt: g.sharedAt ?? null,
    status: g.status ?? "available",
    recipientName: g.recipientName ?? "",
    recipientPhone: g.recipientPhone ?? "",
    assignedAt: g.assignedAt ?? null,
    deliveredAt: g.deliveredAt ?? null,
    usedAt: g.usedAt ?? null,
});

// Bienhechores pagados con sus regalos
export const listGiftOrders = async () => {
    const found = await SanacionOrder.find({ tier: "bienhechor", status: "paid" })
        .sort({ paidAt: -1 })
        .lean();
    const orders = [];
    for (const o of found) orders.push(await ensureTickets(o));

    return orders.map((o) => ({
        folio: o.folio,
        name: o.name,
        phone: o.phone,
        quantity: o.quantity,
        paidAt: o.paidAt ?? null,
        source: o.source,
        paymentMethod: publicMethod(o),
        gifts: (o.gifts ?? []).map(publicGift),
    }));
};

export const updateGift = async (rawCode, body = {}) => {
    const code = normalizeCode(rawCode);
    const p = "gifts.$.";
    const set = {};
    let newCode = null;

    const current = await SanacionOrder.findOne({ "gifts.code": code, status: "paid" }, { "gifts.$": 1 }).lean();
    const gift = current?.gifts?.[0];
    if (!gift) throw new HttpError(404, "No encontramos ese boleto de regalo.");

    // Pasar a la Iglesia un regalo que el bienhechor no ha decidido
    if (body.mode === "church") {
        if ((gift.mode ?? "pending") === "shared") {
            throw new HttpError(400, "El bienhechor ya compartió este lugar.");
        }
        set[p + "mode"] = "church";
    }

    if (body.recipientName !== undefined) {
        const n = cleanName(body.recipientName);
        if (n.length > 120) throw new HttpError(400, "El nombre es demasiado largo.");
        set[p + "recipientName"] = n;
    }
    if (body.recipientPhone !== undefined) {
        const ph = normalizePhone(body.recipientPhone);
        if (ph && ph.length !== 10) throw new HttpError(400, "El WhatsApp debe tener 10 dígitos.");
        set[p + "recipientPhone"] = ph;
    }
    if (body.status !== undefined) {
        if (!GIFT_STATUSES.includes(body.status)) throw new HttpError(400, "Estado no válido.");
        if ((gift.mode ?? "pending") === "shared") {
            throw new HttpError(400, "Este lugar lo compartió el propio bienhechor.");
        }
        set[p + "mode"] = "church"; // si la comunidad lo asigna, es de la Iglesia
        set[p + "status"] = body.status;
        if (body.status === "assigned") {
            set[p + "assignedAt"] = new Date();
            set[p + "deliveredAt"] = null;
        }
        if (body.status === "delivered") set[p + "deliveredAt"] = new Date();
        if (body.status === "available") {
            if (gift.usedAt) throw new HttpError(400, "Este regalo ya se usó en la entrada; no se puede liberar.");
            // Código nuevo: el QR que tenía la persona anterior deja de servir
            newCode = generateCode("REG", 6);
            set[p + "code"] = newCode;
            set[p + "recipientName"] = "";
            set[p + "recipientPhone"] = "";
            set[p + "assignedAt"] = null;
            set[p + "deliveredAt"] = null;
        }
    }
    if (!Object.keys(set).length) throw new HttpError(400, "Nada que actualizar.");

    const order = await SanacionOrder.findOneAndUpdate(
        { "gifts.code": code, status: "paid" },
        { $set: set },
        { new: true }
    ).lean();
    if (!order) throw new HttpError(404, "No encontramos ese boleto de regalo.");

    const finalCode = newCode ?? code;
    return publicGift(order.gifts.find((g) => g.code === finalCode));
};

/* ───────────── Webhook de Stripe ───────────── */
const stripeFieldsFromSession = (session) => ({
    "stripe.sessionId": session.id,
    "stripe.paymentIntentId":
        typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id,
    "stripe.paymentStatus": session.payment_status,
    "stripe.amountTotal": session.amount_total,
    "stripe.currency": session.currency,
    "stripe.customerEmail": session.customer_details?.email,
    "stripe.customerName": session.customer_details?.name,
});

const compact = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

// Guarda cómo pagó (y la ficha OXXO si aplica). Si Stripe falla, no rompe el webhook.
const savePaymentInfo = async (session, filter) => {
    const piId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
    try {
        const info = await getPaymentInfo(piId);
        if (!info) return;
        await SanacionOrder.updateOne(
            filter,
            {
                $set: compact({
                    "stripe.paymentMethod": info.method,
                    "stripe.oxxoVoucherUrl": info.oxxoVoucherUrl,
                    "stripe.oxxoExpiresAt": info.oxxoExpiresAt,
                }),
            }
        );
    } catch (err) {
        console.warn(`[sanacion] no se pudo leer el método de pago (${piId}):`, err.message);
    }
};

const markPaid = async (session) => {
    const folio = session.client_reference_id;
    const fields = compact({ ...stripeFieldsFromSession(session), status: "paid", paidAt: new Date() });

    if (folio) {
        // $ne:"paid" => idempotente: si Stripe reenvía el evento no se pisa nada
        const updated = await SanacionOrder.findOneAndUpdate(
            { folio, status: { $ne: "paid" } },
            { $set: fields },
            { new: true }
        ).lean();
        if (updated) {
            // Pago confirmado: genera un QR por lugar (+ regalos si es Bienhechor)
            await ensureTickets(updated);
            await savePaymentInfo(session, { _id: updated._id });
            // Stripe da el monto en centavos; avisa si no coincide con lo esperado
            if (session.amount_total != null && session.amount_total !== Math.round(updated.expectedAmount * 100)) {
                console.warn(
                    `[sanacion] ⚠️ monto distinto en ${updated.folio}: esperado ${updated.expectedAmount * 100}, cobrado ${session.amount_total}`
                );
            }
            return console.log(`[sanacion] ✅ pago confirmado ${updated.folio} (${updated.name}) · ${updated.quantity} lugar(es)`);
        }

        if (await SanacionOrder.exists({ folio })) {
            return console.log(`[sanacion] evento repetido, ${folio} ya estaba pagado`);
        }
        console.warn(`[sanacion] ⚠️ client_reference_id ${folio} sin orden; se registra como directa`);
    }

    // Pago sin orden previa: no perdemos el registro.
    await SanacionOrder.findOneAndUpdate(
        { "stripe.sessionId": session.id },
        {
            $setOnInsert: {
                folio: generateFolio(),
                accessKey: newAccessKey(),
                name: session.customer_details?.name || "Sin nombre",
                phone: normalizePhone(session.customer_details?.phone || ""),
                tier: "bienhechor",
                quantity: 1,
                expectedAmount: TIERS.bienhechor.price,
                source: "stripe_direct",
                tickets: [newTicket()],
                gifts: [newGift("", "church")],
            },
            $set: fields,
        },
        { upsert: true }
    );
    await savePaymentInfo(session, { "stripe.sessionId": session.id });
    console.log(`[sanacion] ✅ pago directo registrado (session ${session.id})`);
};

const setStatusBySession = async (session, status) => {
    const filter = session.client_reference_id
        ? { folio: session.client_reference_id, status: { $ne: "paid" } }
        : { "stripe.sessionId": session.id, status: { $ne: "paid" } };
    await SanacionOrder.updateOne(
        filter,
        { $set: compact({ ...stripeFieldsFromSession(session), status }) }
    );
    // OXXO: guarda la ficha para que la persona pueda volver a verla
    if (status === "processing") await savePaymentInfo(session, filter);
    console.log(`[sanacion] orden ${session.client_reference_id ?? session.id} -> ${status}`);
};

export const handleStripeEvent = async (event) => {
    const session = event.data.object;

    switch (event.type) {
        case "checkout.session.completed":
            // Con tarjeta/Apple Pay viene "paid"; con OXXO viene "unpaid" hasta que pagan en tienda.
            return session.payment_status === "paid"
                ? markPaid(session)
                : setStatusBySession(session, "processing");
        case "checkout.session.async_payment_succeeded":
            return markPaid(session);
        case "checkout.session.async_payment_failed":
            return setStatusBySession(session, "failed");
        case "checkout.session.expired":
            return setStatusBySession(session, "expired");
        default:
            return; // eventos que no nos interesan
    }
};