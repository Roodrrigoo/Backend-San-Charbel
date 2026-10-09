import mongoose from "mongoose";

const { Schema } = mongoose;

/* ───────────── Videos que el admin puede mostrar en /sanacion ───────────── */
const videoSchema = new Schema(
    {
        title: { type: String, default: "", trim: true, maxlength: 120 },
        url: { type: String, required: true, trim: true }, // la liga original que pegó el admin
        kind: { type: String, enum: ["iframe", "file"], required: true },
        src: { type: String, required: true }, // la liga lista para insertar
        vertical: { type: Boolean, default: false }, // Shorts / Reels
    },
    { timestamps: true }
);

/* Un solo documento de ajustes con key "sanacion" */
const sanacionSettingsSchema = new Schema(
    {
        key: { type: String, required: true, unique: true },
        videos: { type: [videoSchema], default: [] },
        activeVideoId: { type: Schema.Types.ObjectId, default: null }, // null = no mostrar video
    },
    { timestamps: true, collection: "sanacion_settings" }
);

export default mongoose.model("SanacionSettings", sanacionSettingsSchema);