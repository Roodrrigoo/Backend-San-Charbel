import crypto from "node:crypto";
import SanacionOrder from "../models/SanacionOrder.js";
import { createCheckoutSession } from "./stripe.service.js";

export class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

/* ───────────── Catálogo de accesos ─────────────
 * Cada acceso usa un Price de Stripe (STRIPE_PRICE_*) en el .env.
 * La cantidad la elige el usuario en la página y se manda a Checkout.
 * Cada lugar Bienhechor genera además 1 boleto de regalo (gift) con el
 * mensaje que escribió el bienhechor; la comunidad lo asigna desde /sanacion/admin.
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
const newGift = (message = "") => ({
    code: generateCode("REG", 6),
    message,
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

const isDuplicateKey = (err) => err?.code === 11000;

/* ───────────── Accesos (QR) ─────────────
 * Garantiza que una orden pagada tenga su accessKey y un QR por lugar.
 * Los filtros evitan duplicar si dos peticiones llegan a la vez.
 */
const ensureTickets = async (order) => {
    if (!order || order.status !== "paid") return order;
    let changed = false;

    if (!order.accessKey) {
        await SanacionOrder.updateOne(
            { _id: order._id, accessKey: { $exists: false } },
            { $set: { accessKey: newAccessKey() } }
        );
        changed = true;
    }

    const have = order.tickets?.length ?? 0;
    if (have < order.quantity) {
        const extra = Array.from({ length: order.quantity - have }, newTicket);
        await SanacionOrder.updateOne(
            { _id: order._id, [`tickets.${have}`]: { $exists: false } },
            { $push: { tickets: { $each: extra } } }
        );
        changed = true;
    }

    return changed ? SanacionOrder.findById(order._id).lean() : order;
};

// Al arrancar: órdenes pagadas antes de existir los QR reciben los suyos.
export const backfillPaidOrders = async () => {
    const orders = await SanacionOrder.find({
        status: "paid",
        $or: [
            { accessKey: { $exists: false } },
            { $expr: { $lt: [{ $size: { $ifNull: ["$tickets", []] } }, "$quantity"] } },
        ],
    }).lean();
    for (const o of orders) await ensureTickets(o);
    if (orders.length) console.log(`[sanacion] QR generados para ${orders.length} órdenes ya pagadas`);
};

/* ───────────── Crear orden (antes de ir a Stripe) ───────────── */
export const createOrder = async ({ name, phone, tier = "bienhechor", quantity = 1, messages = [] }) => {
    const cleanName = String(name ?? "").trim().replace(/\s+/g, " ");
    if (cleanName.length < 2) throw new HttpError(400, "Escribe tu nombre para emitir tu acceso.");
    if (cleanName.length > 120) throw new HttpError(400, "El nombre es demasiado largo.");

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

    // Un mensaje por lugar Bienhechor (opcionales; vacíos se permiten)
    let giftMessages = [];
    if (tierConfig.givesGift) {
        const list = Array.isArray(messages) ? messages : [];
        giftMessages = Array.from({ length: qty }, (_, i) => cleanText(list[i], MAX_MESSAGE));
        if (giftMessages.some((m) => m.length > MAX_MESSAGE)) {
            throw new HttpError(400, `Cada mensaje puede tener hasta ${MAX_MESSAGE} caracteres.`);
        }
    }

    // El folio es aleatorio; reintenta si por casualidad ya existe.
    let order;
    for (let attempt = 0; attempt < 5 && !order; attempt++) {
        try {
            order = await SanacionOrder.create({
                folio: generateFolio(),
                accessKey: newAccessKey(),
                name: cleanName,
                phone: cleanPhone,
                tier,
                quantity: qty,
                expectedAmount: tierConfig.price * qty,
                source: "web",
                gifts: giftMessages.map((m) => newGift(m)),
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
        });
        await SanacionOrder.updateOne(
            { _id: order._id },
            { $set: { "stripe.sessionId": session.id } }
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
 * key = accessKey de la orden (todos sus QR) o código de un regalo (su QR).
 */
const publicTicket = (t) => ({ code: t.code, usedAt: t.usedAt ?? null });

export const getPass = async (rawKey) => {
    const key = String(rawKey ?? "").trim();
    if (!key || key.length > 64) throw new HttpError(404, "No encontramos este acceso.");

    let order = await SanacionOrder.findOne({ accessKey: key }).lean();
    if (order) {
        order = await ensureTickets(order);
        const paid = order.status === "paid";
        return {
            kind: "order",
            status: order.status,
            folio: order.folio,
            name: order.name,
            tier: order.tier,
            quantity: order.quantity,
            tickets: paid ? (order.tickets ?? []).map(publicTicket) : [],
        };
    }

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
        };
    }

    throw new HttpError(404, "No encontramos este acceso.");
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

// Buscar asistentes pagados por nombre, WhatsApp, folio o código
export const searchOrders = async (rawQ = "") => {
    const q = String(rawQ).trim().slice(0, 80);
    const filter = { status: "paid" };
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

    const found = await SanacionOrder.find(filter).sort({ paidAt: -1 }).limit(50).lean();
    const orders = [];
    for (const o of found) orders.push(await ensureTickets(o));

    return orders.map((o) => ({
        folio: o.folio,
        name: o.name,
        phone: o.phone ?? "",
        tier: o.tier,
        quantity: o.quantity,
        paidAt: o.paidAt ?? null,
        accessKey: o.accessKey,
        tickets: (o.tickets ?? []).map(publicTicket),
    }));
};

/* ───────────── Admin: boletos de regalo ───────────── */
const publicGift = (g) => ({
    code: g.code,
    message: g.message ?? "",
    status: g.status ?? "available",
    recipientName: g.recipientName ?? "",
    recipientPhone: g.recipientPhone ?? "",
    assignedAt: g.assignedAt ?? null,
    deliveredAt: g.deliveredAt ?? null,
    usedAt: g.usedAt ?? null,
});

// Bienhechores pagados con sus regalos. Si una orden tiene menos regalos que
// lugares (p. ej. pagada antes de este cambio), los completa sin mensaje.
export const listGiftOrders = async () => {
    const orders = await SanacionOrder.find({ tier: "bienhechor", status: "paid" })
        .sort({ paidAt: -1 })
        .lean();

    for (const o of orders) {
        const have = o.gifts?.length ?? 0;
        if (have < o.quantity) {
            const extra = Array.from({ length: o.quantity - have }, () => newGift(""));
            // el filtro evita duplicar si dos admins cargan a la vez
            const res = await SanacionOrder.updateOne(
                { _id: o._id, [`gifts.${have}`]: { $exists: false } },
                { $push: { gifts: { $each: extra } } }
            );
            if (res.modifiedCount) o.gifts = [...(o.gifts ?? []), ...extra];
        }
    }

    return orders.map((o) => ({
        folio: o.folio,
        name: o.name,
        phone: o.phone,
        quantity: o.quantity,
        paidAt: o.paidAt ?? null,
        source: o.source,
        gifts: (o.gifts ?? []).map(publicGift),
    }));
};

export const updateGift = async (rawCode, body = {}) => {
    const code = normalizeCode(rawCode);
    const p = "gifts.$.";
    const set = {};
    let newCode = null;

    if (body.recipientName !== undefined) {
        const n = String(body.recipientName).trim().replace(/\s+/g, " ");
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
        set[p + "status"] = body.status;
        if (body.status === "assigned") {
            set[p + "assignedAt"] = new Date();
            set[p + "deliveredAt"] = null;
        }
        if (body.status === "delivered") set[p + "deliveredAt"] = new Date();
        if (body.status === "available") {
            const current = await SanacionOrder.findOne(
                { "gifts.code": code, status: "paid" },
                { "gifts.$": 1 }
            ).lean();
            if (current?.gifts?.[0]?.usedAt) {
                throw new HttpError(400, "Este regalo ya se usó en la entrada; no se puede liberar.");
            }
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
            // Pago confirmado: genera un QR por lugar
            await ensureTickets(updated);
            // Stripe da el monto en centavos; avisa si no coincide con lo esperado
            if (session.amount_total != null && session.amount_total !== updated.expectedAmount * 100) {
                console.warn(
                    `[sanacion] ⚠️ monto distinto en ${updated.folio}: esperado ${updated.expectedAmount * 100}, cobrado ${session.amount_total}`
                );
            }
            return console.log(`[sanacion] ✅ pago confirmado ${updated.folio} (${updated.name}) · ${updated.quantity} QR`);
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
                gifts: [newGift("")],
            },
            $set: fields,
        },
        { upsert: true }
    );
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