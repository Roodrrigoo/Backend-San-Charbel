import crypto from "node:crypto";
import mongoose from "mongoose";
import SanacionQuestion, { QUESTION_STATUS } from "../models/SanacionQuestion.js";
import SanacionSettings from "../models/SanacionSettings.js";
import { HttpError, getPublicPrices } from "./sanacion.service.js";

/* ───────────── Preguntas iniciales ─────────────
 * Se guardan en la base la primera vez que arranca el servidor;
 * desde ahí se editan en /sanacion/admin → Preguntas.
 */
const OLD_BIENHECHOR_ANSWER =
    "Por cada lugar Bienhechor, además de tu acceso preferente, la comunidad regala un acceso a alguien que lo necesita. Tú le escribes un mensaje, y se lo entregamos junto con su lugar.";
const BIENHECHOR_ANSWER =
    "Cada lugar Bienhechor incluye 2 accesos: el tuyo, en zona preferente, y uno más para regalar. Al pagar recibes los dos códigos QR. El de regalo lo puedes mandar tú mismo por WhatsApp a quien quieras, con un mensaje tuyo, o donarlo a la Iglesia para que la comunidad lo entregue a alguien que lo necesite.";

const DEFAULT_FAQS = [
    {
        q: "¿Necesito pertenecer a algún grupo?",
        a: "No. Todo aquel que desee encontrarse con Jesús es bienvenido, en el momento de fe en que se encuentre.",
    },
    {
        q: "¿Puedo traer a un familiar enfermo?",
        a: "Sí, también es para ellos. Si necesita apoyo para desplazarse, escríbenos por WhatsApp y te orientamos.",
    },
    {
        q: "Si no puedo dar la ofrenda, ¿puedo asistir?",
        a: "Es un encuentro de evangelización sin costo. La ofrenda sostiene la logística; si hoy no te es posible, escríbenos por WhatsApp.",
    },
    {
        q: "¿Qué significa ser Bienhechor?",
        a: BIENHECHOR_ANSWER,
    },
    {
        q: "¿Cómo recibo mi acceso?",
        a: "Al confirmarse tu pago verás en pantalla un código QR por persona y podrás enviártelos a tu WhatsApp. Lo muestras en la entrada desde tu celular; cada QR sólo se puede usar una vez.",
    },
    {
        q: "¿Cómo llego?",
        a: "Lo más práctico es el Metro: la estación Popotla está a unos pasos del Deportivo.",
    },
];

export const seedFaqs = async () => {
    // Actualiza la respuesta de "Bienhechor" sólo si nadie la ha editado
    await SanacionQuestion.updateOne(
        { question: "¿Qué significa ser Bienhechor?", answer: OLD_BIENHECHOR_ANSWER },
        { $set: { answer: BIENHECHOR_ANSWER } }
    );
    if ((await SanacionQuestion.estimatedDocumentCount()) > 0) return;
    const now = new Date();
    await SanacionQuestion.insertMany(
        DEFAULT_FAQS.map((f, i) => ({
            question: f.q,
            answer: f.a,
            status: "published",
            order: i + 1,
            source: "admin",
            answeredAt: now,
        }))
    );
    console.log("[sanacion] preguntas frecuentes iniciales creadas");
};

/* ───────────── Helpers ───────────── */
const oneLine = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max + 1);
const multiLine = (v, max) =>
    String(v ?? "")
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, max + 1);

const checkId = (id) => {
    if (!mongoose.isValidObjectId(id)) throw new HttpError(404, "No encontramos esa pregunta.");
};

const nextOrder = async () => {
    const last = await SanacionQuestion.findOne({ status: "published" }).sort({ order: -1 }).lean();
    return (last?.order ?? 0) + 1;
};

const publicQuestion = (d) => ({
    id: String(d._id),
    question: d.question,
    answer: d.answer ?? "",
    name: d.name ?? "",
    status: d.status,
    order: d.order ?? 0,
    source: d.source,
    createdAt: d.createdAt,
    answeredAt: d.answeredAt ?? null,
});

/* ───────────── Video: liga → algo que se puede insertar ───────────── */
export const toEmbed = (raw) => {
    let u;
    try {
        u = new URL(String(raw ?? "").trim());
    } catch {
        throw new HttpError(400, "Pega una liga válida (https://…).");
    }
    if (u.protocol !== "https:") throw new HttpError(400, "La liga debe empezar con https://");
    const host = u.hostname.replace(/^(www|m)\./, "");

    // YouTube: watch?v=, youtu.be/, shorts/, embed/, live/
    let yt = null;
    let vertical = false;
    if (host === "youtu.be") yt = u.pathname.slice(1).split("/")[0];
    else if (host === "youtube.com" || host === "youtube-nocookie.com") {
        if (u.searchParams.get("v")) yt = u.searchParams.get("v");
        else {
            const m = u.pathname.match(/^\/(shorts|embed|live)\/([\w-]+)/);
            if (m) {
                yt = m[2];
                vertical = m[1] === "shorts";
            }
        }
    }
    if (yt) {
        if (!/^[\w-]{6,20}$/.test(yt)) throw new HttpError(400, "No reconocimos el video de YouTube.");
        return { kind: "iframe", src: `https://www.youtube-nocookie.com/embed/${yt}?rel=0&playsinline=1`, vertical };
    }

    // Vimeo
    if (host === "vimeo.com" || host === "player.vimeo.com") {
        const m = u.pathname.match(/(\d{6,})/);
        if (m) return { kind: "iframe", src: `https://player.vimeo.com/video/${m[1]}`, vertical: false };
    }

    // Facebook (videos, reels, fb.watch)
    if (host === "facebook.com" || host === "fb.watch") {
        return {
            kind: "iframe",
            src: `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(u.href)}&show_text=false`,
            vertical: /\/reel\//.test(u.pathname),
        };
    }

    // Archivo directo
    if (/\.(mp4|webm|mov)$/i.test(u.pathname)) return { kind: "file", src: u.href, vertical: false };

    throw new HttpError(400, "Por ahora aceptamos ligas de YouTube, Facebook, Vimeo o un archivo .mp4.");
};

const getSettings = () =>
    SanacionSettings.findOneAndUpdate(
        { key: "sanacion" },
        { $setOnInsert: { key: "sanacion" } },
        { upsert: true, new: true }
    ).lean();

const publicVideo = (v) => ({
    id: String(v._id),
    title: v.title ?? "",
    url: v.url,
    kind: v.kind,
    src: v.src,
    vertical: !!v.vertical,
});

/* ═════════════ PÚBLICO ═════════════ */

// GET /api/sanacion/content -> preguntas publicadas + video activo
export const getPublicContent = async () => {
    const [faqs, settings, prices] = await Promise.all([
        SanacionQuestion.find({ status: "published" }).sort({ order: 1, createdAt: 1 }).lean(),
        SanacionSettings.findOne({ key: "sanacion" }).lean(),
        getPublicPrices(),
    ]);
    const active = settings?.activeVideoId
        ? settings.videos?.find((v) => String(v._id) === String(settings.activeVideoId))
        : null;
    return {
        faqs: faqs.map((f) => ({ id: String(f._id), q: f.question, a: f.answer })),
        video: active ? { title: active.title ?? "", kind: active.kind, src: active.src, vertical: !!active.vertical } : null,
        prices, // { general, bienhechor } en pesos, leídos de Stripe
    };
};

// POST /api/sanacion/questions { question, name?, website? }
export const submitQuestion = async ({ question, name, website } = {}) => {
    // "website" es un campo oculto: sólo los bots lo llenan. Fingimos éxito.
    if (website) return { ok: true };

    const q = multiLine(question, 500);
    if (q.length < 8) throw new HttpError(400, "Escribe tu pregunta (al menos unas palabras).");
    if (q.length > 500) throw new HttpError(400, "Tu pregunta es muy larga (máximo 500 caracteres).");
    const n = oneLine(name, 80);
    if (n.length > 80) throw new HttpError(400, "El nombre es demasiado largo.");

    const pending = await SanacionQuestion.countDocuments({ status: "pending" });
    if (pending >= 300) {
        throw new HttpError(429, "Recibimos muchas preguntas; intenta más tarde o escríbenos por WhatsApp.");
    }

    await SanacionQuestion.create({ question: q, name: n, status: "pending", source: "web" });
    return { ok: true };
};

/* ═════════════ ADMIN: PREGUNTAS ═════════════ */

export const listQuestions = async () => {
    const docs = await SanacionQuestion.find().sort({ createdAt: -1 }).lean();
    return docs.map(publicQuestion);
};

// Crea una pregunta frecuente ya respondida y publicada
export const createFaq = async ({ question, answer } = {}) => {
    const q = multiLine(question, 500);
    const a = multiLine(answer, 2000);
    if (q.length < 3) throw new HttpError(400, "Escribe la pregunta.");
    if (q.length > 500) throw new HttpError(400, "La pregunta es muy larga (máximo 500).");
    if (!a) throw new HttpError(400, "Escribe la respuesta.");
    if (a.length > 2000) throw new HttpError(400, "La respuesta es muy larga (máximo 2000).");

    const doc = await SanacionQuestion.create({
        question: q,
        answer: a,
        status: "published",
        order: await nextOrder(),
        source: "admin",
        answeredAt: new Date(),
    });
    return publicQuestion(doc.toObject());
};

export const updateQuestion = async (id, body = {}) => {
    checkId(id);
    const doc = await SanacionQuestion.findById(id);
    if (!doc) throw new HttpError(404, "No encontramos esa pregunta.");

    if (body.question !== undefined) {
        const q = multiLine(body.question, 500);
        if (q.length < 3) throw new HttpError(400, "La pregunta no puede quedar vacía.");
        if (q.length > 500) throw new HttpError(400, "La pregunta es muy larga (máximo 500).");
        doc.question = q;
    }
    if (body.answer !== undefined) {
        const a = multiLine(body.answer, 2000);
        if (a.length > 2000) throw new HttpError(400, "La respuesta es muy larga (máximo 2000).");
        doc.answer = a;
    }
    if (body.status !== undefined) {
        if (!QUESTION_STATUS.includes(body.status)) throw new HttpError(400, "Estado no válido.");
        if (body.status === "published") {
            if (!doc.answer.trim()) throw new HttpError(400, "Escribe una respuesta antes de publicar.");
            if (doc.status !== "published") {
                doc.order = await nextOrder();
                doc.answeredAt = new Date();
            }
        }
        doc.status = body.status;
    }
    if (doc.status === "published" && !doc.answer.trim()) {
        throw new HttpError(400, "Una pregunta publicada necesita respuesta.");
    }

    await doc.save();
    return publicQuestion(doc.toObject());
};

// PUT /admin/questions/order { ids: [...] } -> orden de las publicadas
export const reorderQuestions = async (ids = []) => {
    if (!Array.isArray(ids) || ids.length > 200 || !ids.every((id) => mongoose.isValidObjectId(id))) {
        throw new HttpError(400, "Orden no válido.");
    }
    if (ids.length) {
        await SanacionQuestion.bulkWrite(
            ids.map((id, i) => ({ updateOne: { filter: { _id: id }, update: { $set: { order: i + 1 } } } }))
        );
    }
    return listQuestions();
};

export const deleteQuestion = async (id) => {
    checkId(id);
    const res = await SanacionQuestion.deleteOne({ _id: id });
    if (!res.deletedCount) throw new HttpError(404, "No encontramos esa pregunta.");
    return { ok: true };
};

/* ═════════════ ADMIN: VIDEO ═════════════ */

export const getVideoSettings = async () => {
    const s = await getSettings();
    return {
        activeVideoId: s.activeVideoId ? String(s.activeVideoId) : null,
        videos: (s.videos ?? []).map(publicVideo).reverse(), // más recientes primero
    };
};

// POST /admin/video { url, title?, vertical?, activate? }
export const addVideo = async ({ url, title, vertical, activate = true } = {}) => {
    const embed = toEmbed(url);
    const t = oneLine(title, 120);
    if (t.length > 120) throw new HttpError(400, "El título es muy largo (máximo 120).");

    const _id = new mongoose.Types.ObjectId();
    const update = {
        $push: {
            videos: {
                _id,
                title: t,
                url: String(url).trim(),
                kind: embed.kind,
                src: embed.src,
                vertical: typeof vertical === "boolean" ? vertical : embed.vertical,
            },
        },
    };
    if (activate) update.$set = { activeVideoId: _id };
    await SanacionSettings.updateOne({ key: "sanacion" }, update, { upsert: true });
    return getVideoSettings();
};

// PUT /admin/video/active { id } -> id = null para no mostrar video
export const setActiveVideo = async (id) => {
    if (id === null || id === "" || id === undefined) {
        await SanacionSettings.updateOne({ key: "sanacion" }, { $set: { activeVideoId: null } }, { upsert: true });
        return getVideoSettings();
    }
    if (!mongoose.isValidObjectId(id)) throw new HttpError(404, "No encontramos ese video.");
    const res = await SanacionSettings.updateOne(
        { key: "sanacion", "videos._id": id },
        { $set: { activeVideoId: id } }
    );
    if (!res.matchedCount) throw new HttpError(404, "No encontramos ese video.");
    return getVideoSettings();
};

export const deleteVideo = async (id) => {
    if (!mongoose.isValidObjectId(id)) throw new HttpError(404, "No encontramos ese video.");
    const s = await getSettings();
    const update = { $pull: { videos: { _id: id } } };
    if (String(s.activeVideoId) === String(id)) update.$set = { activeVideoId: null };
    await SanacionSettings.updateOne({ key: "sanacion" }, update);
    return getVideoSettings();
};

/* ═════════════ ADMIN: SUBIR VIDEO DESDE EL DISPOSITIVO ═════════════
 * El navegador del admin sube el archivo directo a Cloudinary (no pasa por
 * Render). El backend sólo firma la subida para que nadie más pueda subir.
 * Variable (opcional): CLOUDINARY_URL=cloudinary://<api_key>:<api_secret>@<cloud_name>
 * (cópiala tal cual de Cloudinary → Dashboard → "API environment variable")
 */
const CLOUDINARY_FOLDER = "sanacion";

const readCloudinaryUrl = () => {
    const raw = String(process.env.CLOUDINARY_URL ?? "").trim().replace(/^CLOUDINARY_URL=/, "");
    if (!raw) return null;
    try {
        const u = new URL(raw);
        if (u.protocol !== "cloudinary:") return null;
        const cfg = {
            cloudName: decodeURIComponent(u.hostname),
            apiKey: decodeURIComponent(u.username),
            apiSecret: decodeURIComponent(u.password),
        };
        return cfg.cloudName && cfg.apiKey && cfg.apiSecret ? cfg : null;
    } catch {
        return null;
    }
};

export const getUploadSignature = () => {
    const cfg = readCloudinaryUrl();
    if (!cfg) {
        throw new HttpError(
            400,
            "Falta configurar CLOUDINARY_URL en el servidor (cloudinary://API_KEY:API_SECRET@CLOUD_NAME)."
        );
    }
    const timestamp = Math.floor(Date.now() / 1000);
    // Cloudinary firma los parámetros en orden alfabético + el secreto (SHA-1)
    const toSign = `folder=${CLOUDINARY_FOLDER}&timestamp=${timestamp}`;
    const signature = crypto.createHash("sha1").update(toSign + cfg.apiSecret).digest("hex");
    return { cloudName: cfg.cloudName, apiKey: cfg.apiKey, timestamp, folder: CLOUDINARY_FOLDER, signature };
};