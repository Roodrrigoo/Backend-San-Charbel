import crypto from "node:crypto";
import express, { Router } from "express";
import {
    checkIn,
    checkInStats,
    createOrder,
    getPass,
    getPublicOrder,
    handleStripeEvent,
    listGiftOrders,
    searchOrders,
    undoCheckIn,
    updateGift,
} from "../services/sanacion.service.js";
import { constructWebhookEvent } from "../services/stripe.service.js";
import {
    addVideo,
    createFaq,
    deleteQuestion,
    deleteVideo,
    getPublicContent,
    getVideoSettings,
    listQuestions,
    reorderQuestions,
    setActiveVideo,
    submitQuestion,
    updateQuestion,
} from "../services/content.service.js";

/* ───────────── API pública (JSON) ───────────── */
export const sanacionRouter = Router();

// POST /api/sanacion/orders  { name, phone, tier?, quantity?, messages? }
// Crea la orden "pending" y regresa el link de pago de Stripe con el folio adjunto.
// accessKey: llave privada para ver los QR en /sanacion/boleto/<accessKey> al pagar.
sanacionRouter.post("/orders", async (req, res) => {
    const { order, paymentUrl } = await createOrder(req.body ?? {});
    res.status(201).json({
        folio: order.folio,
        accessKey: order.accessKey,
        status: order.status,
        amount: order.expectedAmount,
        currency: order.currency,
        paymentUrl,
    });
});

// GET /api/sanacion/orders/:folio  -> estado (para la pantalla de "gracias")
sanacionRouter.get("/orders/:folio", async (req, res) => {
    res.json(await getPublicOrder(req.params.folio));
});

// GET /api/sanacion/pass/:key  -> QR de una orden (accessKey) o de un regalo (código)
sanacionRouter.get("/pass/:key", async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await getPass(req.params.key));
});

// GET /api/sanacion/content -> preguntas publicadas + video activo (para la página)
sanacionRouter.get("/content", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await getPublicContent());
});

// POST /api/sanacion/questions { question, name? } -> llega al admin como "nueva"
sanacionRouter.post("/questions", async (req, res) => {
    res.status(201).json(await submitQuestion(req.body ?? {}));
});

/* ───────────── Admin (Authorization: Bearer ADMIN_TOKEN) ───────────── */
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();

const requireAdmin = (req, res, next) => {
    const expected = process.env.ADMIN_TOKEN;
    const got = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    // comparación en tiempo constante
    if (!expected || !got || !crypto.timingSafeEqual(sha(got), sha(expected))) {
        return res.status(401).json({ error: "No autorizado" });
    }
    next();
};

export const sanacionAdminRouter = Router();
sanacionAdminRouter.use(requireAdmin);

// GET /api/sanacion/admin/gifts -> bienhechores pagados con sus boletos de regalo
sanacionAdminRouter.get("/gifts", async (_req, res) => {
    res.json({ orders: await listGiftOrders() });
});

// PATCH /api/sanacion/admin/gifts/:code { recipientName?, recipientPhone?, status? }
sanacionAdminRouter.patch("/gifts/:code", async (req, res) => {
    res.json({ gift: await updateGift(req.params.code, req.body ?? {}) });
});

// POST /api/sanacion/admin/checkin { code } -> valida y marca el QR como usado
sanacionAdminRouter.post("/checkin", async (req, res) => {
    res.json(await checkIn(req.body?.code));
});

// POST /api/sanacion/admin/checkin/undo { code } -> reactiva un QR escaneado por error
sanacionAdminRouter.post("/checkin/undo", async (req, res) => {
    res.json(await undoCheckIn(req.body?.code));
});

// GET /api/sanacion/admin/checkin/stats -> { total, used }
sanacionAdminRouter.get("/checkin/stats", async (_req, res) => {
    res.json(await checkInStats());
});

// GET /api/sanacion/admin/orders?q= -> asistentes pagados (todos los accesos)
sanacionAdminRouter.get("/orders", async (req, res) => {
    res.json({ orders: await searchOrders(req.query.q) });
});

// ── Preguntas ──
// GET /api/sanacion/admin/questions -> todas (nuevas, publicadas, ocultas)
sanacionAdminRouter.get("/questions", async (_req, res) => {
    res.json({ questions: await listQuestions() });
});

// POST /api/sanacion/admin/questions { question, answer } -> pregunta frecuente ya publicada
sanacionAdminRouter.post("/questions", async (req, res) => {
    res.status(201).json({ question: await createFaq(req.body ?? {}) });
});

// PUT /api/sanacion/admin/questions/order { ids } -> orden de las publicadas
sanacionAdminRouter.put("/questions/order", async (req, res) => {
    res.json({ questions: await reorderQuestions(req.body?.ids) });
});

// PATCH /api/sanacion/admin/questions/:id { question?, answer?, status? }
sanacionAdminRouter.patch("/questions/:id", async (req, res) => {
    res.json({ question: await updateQuestion(req.params.id, req.body ?? {}) });
});

// DELETE /api/sanacion/admin/questions/:id
sanacionAdminRouter.delete("/questions/:id", async (req, res) => {
    res.json(await deleteQuestion(req.params.id));
});

// ── Video ──
// GET /api/sanacion/admin/video -> { activeVideoId, videos }
sanacionAdminRouter.get("/video", async (_req, res) => {
    res.json(await getVideoSettings());
});

// POST /api/sanacion/admin/video { url, title?, vertical?, activate? }
sanacionAdminRouter.post("/video", async (req, res) => {
    res.status(201).json(await addVideo(req.body ?? {}));
});

// PUT /api/sanacion/admin/video/active { id } -> id null = no mostrar video
sanacionAdminRouter.put("/video/active", async (req, res) => {
    res.json(await setActiveVideo(req.body?.id ?? null));
});

// DELETE /api/sanacion/admin/video/:id
sanacionAdminRouter.delete("/video/:id", async (req, res) => {
    res.json(await deleteVideo(req.params.id));
});

/* ───────────── Webhook de Stripe (body RAW) ─────────────
 * Se monta en app.js ANTES de express.json(); Stripe firma el cuerpo
 * exacto y si se parsea antes, la verificación falla.
 */
export const sanacionWebhookRouter = Router();

sanacionWebhookRouter.post(
    "/",
    express.raw({ type: "application/json" }),
    async (req, res) => {
        let event;
        try {
            event = constructWebhookEvent(req.body, req.headers["stripe-signature"]);
        } catch (err) {
            console.warn("[sanacion] webhook con firma inválida:", err.message);
            return res.status(400).send("Invalid signature");
        }

        // Si algo falla aquí lanzamos error -> 500 -> Stripe reintenta el evento.
        await handleStripeEvent(event);
        res.json({ received: true });
    }
);