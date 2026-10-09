import mongoose from "mongoose";

const { Schema } = mongoose;

export const QUESTION_STATUS = ["pending", "published", "hidden"];

/* ───────────── Preguntas de la página /sanacion ─────────────
 * pending:   la escribió alguien en la página y espera respuesta
 * published: se ve en la sección "Preguntas" (con su respuesta)
 * hidden:    no se ve (spam, repetida, ya no aplica…)
 */
const sanacionQuestionSchema = new Schema(
    {
        question: { type: String, required: true, trim: true, maxlength: 500 },
        answer: { type: String, default: "", maxlength: 2000 },
        name: { type: String, default: "", trim: true, maxlength: 80 }, // quién preguntó (opcional)
        status: { type: String, enum: QUESTION_STATUS, default: "pending", index: true },
        order: { type: Number, default: 0 }, // posición en la página (sólo publicadas)
        source: { type: String, enum: ["web", "admin"], default: "web" },
        answeredAt: { type: Date, default: null },
    },
    { timestamps: true, collection: "sanacion_questions" }
);

sanacionQuestionSchema.index({ status: 1, order: 1 });

export default mongoose.model("SanacionQuestion", sanacionQuestionSchema);