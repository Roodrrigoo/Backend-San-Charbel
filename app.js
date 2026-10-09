import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import mongoose from "mongoose";
import rateLimit from "express-rate-limit";
import {
    sanacionRouter,
    sanacionAdminRouter,
    sanacionWebhookRouter,
} from "./routes/sanacion.routes.js";

/* ───────────── Variables obligatorias ───────────── */
const REQUIRED_ENV = [
    "MONGODB_URI",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_BIENHECHOR",
    "STRIPE_PRICE_GENERAL",
    "SITE_URL",
    "ADMIN_TOKEN", // contraseña del panel /sanacion/admin (usa una larga: openssl rand -hex 24)
];
const missing = REQUIRED_ENV.filter((k) => !process.env[k] || process.env[k].includes("REEMPLAZA"));
if (missing.length) {
    console.error(`❌ Faltan variables en .env: ${missing.join(", ")}`);
    process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3001;
const allowedOrigins = (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

if (process.env.NODE_ENV === "production") app.set("trust proxy", 1); // detrás de nginx/Render/etc.

app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// 1) Webhook primero y con body RAW (antes de express.json)
app.use("/api/sanacion/webhook", sanacionWebhookRouter);

// 2) Resto de la API
app.use(
    cors({
        origin: (origin, cb) => {
            if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
            const err = new Error("Origen no permitido");
            err.status = 403;
            cb(err);
        },
    })
);
app.use(express.json({ limit: "20kb" }));

app.get("/health", (_req, res) => res.json({ ok: true, db: mongoose.connection.readyState === 1 }));
// Evita que alguien llene la base de órdenes "pending"
app.use(
    "/api/sanacion/orders",
    rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false })
);
// Panel de administración (frena intentos de adivinar la contraseña)
app.use(
    "/api/sanacion/admin",
    rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }),
    sanacionAdminRouter
);
app.use("/api/sanacion", sanacionRouter);

/* ───────────── 404 y errores ───────────── */
app.use((_req, res) => res.status(404).json({ error: "Ruta no encontrada" }));

// Express 5 envía aquí también los errores de handlers async
app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    if (status >= 500) console.error("[error]", err);
    res.status(status).json({
        error: status >= 500 ? "Error interno del servidor" : err.message,
    });
});

/* ───────────── Arranque ───────────── */
try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ MongoDB conectado");
    app.listen(PORT, () => console.log(`🚀 Sanación API en http://localhost:${PORT}`));
} catch (err) {
    console.error("❌ No se pudo conectar a MongoDB:", err.message);
    process.exit(1);
}