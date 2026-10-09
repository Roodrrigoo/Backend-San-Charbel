import mongoose from "mongoose";

const { Schema } = mongoose;

export const ORDER_STATUS = ["pending", "processing", "paid", "expired", "failed"];
export const GIFT_STATUS = ["available", "assigned", "delivered"];

/* ───────────── Acceso (QR) ─────────────
 * Uno por lugar pagado. El QR contiene el `code`; al escanearlo en la
 * entrada se llena `usedAt` y ya no vuelve a servir.
 */
const ticketSchema = new Schema(
    {
        code: { type: String, required: true, uppercase: true, trim: true }, // p. ej. T26-7K3QXP2M
        usedAt: { type: Date, default: null },
    },
    { _id: false }
);

/* ───────────── Boleto de regalo ─────────────
 * Cada lugar Bienhechor genera uno. Lleva el mensaje que escribió el
 * bienhechor y la comunidad lo asigna/entrega desde /sanacion/admin.
 * Su `code` también es su QR de entrada.
 */
const giftSchema = new Schema(
    {
        // Código de acceso del regalo (p. ej. REG-7K3QXP)
        code: { type: String, required: true, uppercase: true, trim: true },

        // Mensaje del bienhechor para quien lo reciba (opcional)
        message: { type: String, default: "", trim: true, maxlength: 280 },

        // available: sin asignar · assigned: ya tiene destinatario · delivered: entregado
        status: { type: String, enum: GIFT_STATUS, default: "available" },

        recipientName: { type: String, default: "", trim: true, maxlength: 120 },
        recipientPhone: { type: String, default: "", trim: true },
        assignedAt: { type: Date, default: null },
        deliveredAt: { type: Date, default: null },

        // Se llena cuando el QR del regalo se escanea en la entrada
        usedAt: { type: Date, default: null },
    },
    { _id: false }
);

const sanacionOrderSchema = new Schema(
    {
        // Folio visible para el asistente (también viaja a Stripe como client_reference_id)
        folio: { type: String, required: true, unique: true, index: true },

        // Llave privada para ver los QR en /sanacion/boleto/<accessKey>
        accessKey: { type: String },

        // Datos que captura el asistente antes de pagar (en lugar de login)
        name: { type: String, required: true, trim: true, maxlength: 120 },
        phone: {
            type: String,
            trim: true,
            // sólo obligatorio cuando la orden nace desde nuestra página
            required: function () {
                return this.source === "web";
            },
        },

        tier: { type: String, enum: ["general", "bienhechor"], required: true },
        quantity: { type: Number, default: 1, min: 1, max: 10 },

        // Lo que esperábamos cobrar (pesos MXN)
        expectedAmount: { type: Number, required: true },
        currency: { type: String, default: "mxn" },

        // pending: creada, aún sin pagar · processing: pago asíncrono en curso (p. ej. OXXO)
        // paid: confirmado por webhook · expired / failed: no se concretó
        status: { type: String, enum: ORDER_STATUS, default: "pending", index: true },
        paidAt: Date,

        // "web" = creada por nuestra API · "stripe_direct" = alguien pagó con el link sin pasar por la página
        source: { type: String, enum: ["web", "stripe_direct"], default: "web" },

        // Accesos con QR (se generan al confirmarse el pago): uno por lugar
        tickets: { type: [ticketSchema], default: [] },

        // Boletos de regalo (sólo Bienhechor): uno por lugar, con el mensaje del bienhechor
        gifts: { type: [giftSchema], default: [] },

        stripe: {
            sessionId: String,
            paymentIntentId: String,
            paymentStatus: String,
            amountTotal: Number, // centavos, tal como lo reporta Stripe
            currency: String,
            customerEmail: String,
            customerName: String,
        },
    },
    { timestamps: true, collection: "sanacion_orders" }
);

sanacionOrderSchema.index({ phone: 1 });
sanacionOrderSchema.index({ "stripe.sessionId": 1 }, { unique: true, sparse: true });
sanacionOrderSchema.index({ accessKey: 1 }, { unique: true, sparse: true });
// Panel de admin: bienhechores pagados, más recientes primero
sanacionOrderSchema.index({ tier: 1, status: 1, paidAt: -1 });
// Escanear: buscar un QR por su código
sanacionOrderSchema.index(
    { "tickets.code": 1 },
    { unique: true, partialFilterExpression: { "tickets.code": { $exists: true } } }
);
sanacionOrderSchema.index({ "gifts.code": 1 });

export default mongoose.model("SanacionOrder", sanacionOrderSchema);