const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();

const db = require("./db");
const app = express();
// [FIX 11] Behind the documented nginx/IIS reverse proxy, req.ip must reflect
//          the client (X-Forwarded-For) rather than the proxy, or the rate
//          limiter buckets every user together. Override with TRUST_PROXY.
app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 1));
const PORT = process.env.PORT || 3001;

// [FIX 1] Warn loudly if running with the default secret.
const JWT_SECRET = process.env.JWT_SECRET || "demirbase-secret-change-me";
if (!process.env.JWT_SECRET)
  console.warn("⚠️  JWT_SECRET ortam değişkeni ayarlanmamış; üretimde mutlaka ayarlayın!");

const ADMIN_EMAIL = (
  process.env.ADMIN_EMAIL || "admin@example.com"
).toLowerCase();
const SALT_ROUNDS = 10;

// ─── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const UPLOAD_DIR = process.env.UPLOAD_DIR || "./uploads";
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use("/uploads", express.static(path.resolve(UPLOAD_DIR)));

// [FIX 4] Rate-limit login and register to 20 attempts per 15 minutes.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Çok fazla istek, lütfen 15 dakika sonra tekrar deneyin." },
});

// ─── Multer ───────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
    if (allowed.includes(path.extname(file.originalname).toLowerCase()))
      cb(null, true);
    else cb(new Error("Sadece resim dosyaları yüklenebilir."));
  },
});

// [FIX 3/4] multer saves the upload to disk before the handler runs, so any
//           non-2xx exit from an asset write route must unlink it or the file
//           is orphaned. Safe to call unconditionally.
function cleanupUpload(req) {
  if (req.file) {
    try {
      fs.unlinkSync(path.join(UPLOAD_DIR, req.file.filename));
    } catch {}
  }
}

// ─── JWT Middleware ───────────────────────────────────────────
function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Yetkilendirme gerekli" });
  }
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Geçersiz veya süresi dolmuş token" });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Admin yetkisi gerekli" });
  }
  next();
}

// ─── Settings yardımcıları ────────────────────────────────────
async function getSetting(key) {
  const r = await db.query(`SELECT value FROM settings WHERE [key] = $1`, [
    key,
  ]);
  if (!r.rows.length) return null;
  // [FIX 7] Guard JSON.parse — a corrupted DB row must not crash all callers.
  try {
    return JSON.parse(r.rows[0].value);
  } catch {
    console.error(`getSetting: '${key}' için geçersiz JSON değeri`);
    return null;
  }
}

async function setSetting(key, value) {
  const exists = await db.query(`SELECT 1 FROM settings WHERE [key] = $1`, [
    key,
  ]);
  if (exists.rows.length) {
    await db.query(`UPDATE settings SET value = $1 WHERE [key] = $2`, [
      JSON.stringify(value),
      key,
    ]);
  } else {
    await db.query(`INSERT INTO settings ([key], value) VALUES ($1, $2)`, [
      key,
      JSON.stringify(value),
    ]);
  }
}

// ─── Barkod ID üretici ────────────────────────────────────────
// [FIX 5] Runs inside the caller's SERIALIZABLE transaction so two concurrent
//         requests cannot read the same MAX(id) before either INSERT commits.
async function generateBarcodeIdInTx(tx) {
  const year = new Date().getFullYear().toString().slice(2);
  const r = await tx
    .request()
    .query(`SELECT ISNULL(MAX(id), 0) + 1 AS next_id FROM demirbaslar`);
  return `DMR${year}${String(r.recordset[0].next_id).padStart(5, "0")}`;
}

// ════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ════════════════════════════════════════════════════════════════

// POST /api/auth/register
app.post("/api/auth/register", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "email ve password zorunludur" });
    if (password.length < 6)
      return res
        .status(400)
        .json({ error: "Şifre en az 6 karakter olmalıdır" });

    const emailLower = email.toLowerCase();

    if (emailLower !== ADMIN_EMAIL) {
      const allowed = (await getSetting("allowed_emails")) || [];
      // [FIX 3] If allowed_emails was stored as a non-array, treat as empty
      //         rather than crashing on .map().
      const list = Array.isArray(allowed) ? allowed : [];
      if (!list.map((e) => e.toLowerCase()).includes(emailLower)) {
        return res
          .status(403)
          .json({ error: "Bu e-posta adresiyle kayıt olmaya izniniz yok" });
      }
    }

    const existing = await db.query(`SELECT id FROM users WHERE email = $1`, [
      emailLower,
    ]);
    if (existing.rows.length)
      return res.status(409).json({ error: "Bu e-posta zaten kayıtlı" });

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const role = emailLower === ADMIN_EMAIL ? "admin" : "user";

    const result = await db.query(
      `INSERT INTO users (email, password, role) OUTPUT INSERTED.id, INSERTED.email, INSERTED.role VALUES ($1, $2, $3)`,
      [emailLower, hash, role],
    );
    const user = result.rows[0];
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: "7d" },
    );
    res.status(201).json({
      token,
      user: { id: user.id, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Sunucu hatası" });
  }
});

// POST /api/auth/login
app.post("/api/auth/login", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "email ve password zorunludur" });

    const result = await db.query(`SELECT * FROM users WHERE email = $1`, [
      email.toLowerCase(),
    ]);
    if (!result.rows.length)
      return res.status(401).json({ error: "E-posta veya şifre hatalı" });

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match)
      return res.status(401).json({ error: "E-posta veya şifre hatalı" });

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: "7d" },
    );
    res.json({
      token,
      user: { id: user.id, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Sunucu hatası" });
  }
});

// GET /api/auth/me — token doğrula
app.get("/api/auth/me", authenticate, (req, res) => {
  res.json({ user: req.user });
});

// ════════════════════════════════════════════════════════════════
// SETTINGS ROUTES
// ════════════════════════════════════════════════════════════════

// GET /api/settings — kategoriler + mekanlar
app.get("/api/settings", authenticate, async (req, res) => {
  try {
    const [categories, locations] = await Promise.all([
      getSetting("categories"),
      getSetting("locations"),
    ]);
    res.json({ categories: categories || [], locations: locations || [] });
  } catch (err) {
    res.status(500).json({ error: "Sunucu hatası" });
  }
});

// PUT /api/settings — kategoriler + mekanlar güncelle (admin)
app.put("/api/settings", authenticate, requireAdmin, async (req, res) => {
  try {
    const { categories, locations } = req.body;
    if (categories !== undefined) await setSetting("categories", categories);
    if (locations !== undefined) await setSetting("locations", locations);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Sunucu hatası" });
  }
});

// GET /api/settings/allowed-emails (admin)
app.get(
  "/api/settings/allowed-emails",
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {
      const emails = (await getSetting("allowed_emails")) || [];
      res.json({ emails });
    } catch (err) {
      res.status(500).json({ error: "Sunucu hatası" });
    }
  },
);

// PUT /api/settings/allowed-emails (admin)
app.put(
  "/api/settings/allowed-emails",
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {
      const { emails } = req.body;
      // [FIX 3] Reject non-arrays AND arrays with non-string elements; both
      //         would crash the register flow's .map((e) => e.toLowerCase()).
      if (!Array.isArray(emails) || !emails.every((e) => typeof e === "string"))
        return res
          .status(400)
          .json({ error: "emails bir string dizisi olmalıdır" });
      await setSetting("allowed_emails", emails);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: "Sunucu hatası" });
    }
  },
);

// ════════════════════════════════════════════════════════════════
// ASSETS ROUTES
// ════════════════════════════════════════════════════════════════

// GET /api/assets
app.get("/api/assets", authenticate, async (req, res) => {
  try {
    const { search = "", category = "", location = "" } = req.query;
    // [FIX 10] Clamp page to ≥1 so OFFSET is never negative.
    const pageNum = Math.max(1, parseInt(req.query.page) || 1);
    const limitNum = Math.max(1, Math.min(500, parseInt(req.query.limit) || 200));
    const offset = (pageNum - 1) * limitNum;

    let conditions = [],
      params = [],
      i = 1;
    if (search) {
      conditions.push(
        `(name LIKE $${i} OR location LIKE $${i} OR barcode_id LIKE $${i} OR description LIKE $${i})`,
      );
      params.push(`%${search}%`);
      i++;
    }
    if (category) {
      conditions.push(`category = $${i++}`);
      params.push(category);
    }
    if (location) {
      conditions.push(`location LIKE $${i++}`);
      params.push(`%${location}%`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const countResult = await db.query(
      `SELECT COUNT(*) AS cnt FROM demirbaslar ${where}`,
      params,
    );
    const total = parseInt(countResult.rows[0].cnt);

    const dataResult = await db.query(
      `SELECT * FROM demirbaslar ${where}
       ORDER BY created_at DESC
       OFFSET $${i} ROWS FETCH NEXT $${i + 1} ROWS ONLY`,
      [...params, offset, limitNum],
    );

    res.json({
      data: dataResult.rows,
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Sunucu hatası" });
  }
});

// GET /api/assets/barcode/:barcodeId — QR lookup
app.get("/api/assets/barcode/:barcodeId", authenticate, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM demirbaslar WHERE barcode_id = $1`,
      [req.params.barcodeId],
    );
    if (!result.rows.length)
      return res.status(404).json({ error: "Bulunamadı" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Sunucu hatası" });
  }
});

// GET /api/assets/:id
app.get("/api/assets/:id", authenticate, async (req, res) => {
  try {
    const result = await db.query(`SELECT * FROM demirbaslar WHERE id = $1`, [
      req.params.id,
    ]);
    if (!result.rows.length)
      return res.status(404).json({ error: "Bulunamadı" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Sunucu hatası" });
  }
});

// POST /api/assets
app.post(
  "/api/assets",
  authenticate,
  upload.single("image"),
  async (req, res) => {
    const { name, location, category, description, quantity } = req.body;
    if (!name || !location) {
      cleanupUpload(req);
      return res.status(400).json({ error: "name ve location zorunludur" });
    }

    const imagePath = req.file ? `/uploads/${req.file.filename}` : null;
    const qty = Math.max(1, parseInt(quantity) || 1);

    try {
      // [FIX 5] Serialize barcode generation with an application lock so two
      //         concurrent requests cannot derive the same next_id. Unlike a
      //         SERIALIZABLE range lock (MAX read + INSERT → mutual deadlock),
      //         sp_getapplock queues callers cleanly with no deadlock.
      const pool = await db.getPool();
      const tx = new db.sql.Transaction(pool);
      await tx.begin();

      let insertedRow;
      try {
        const lockReq = tx.request();
        lockReq.input("res", "barcode_gen");
        const lockRes = await lockReq.query(
          `DECLARE @rc INT;
           EXEC @rc = sp_getapplock @Resource = @res, @LockMode = 'Exclusive',
                @LockOwnerType = 'Transaction', @LockTimeout = 5000;
           SELECT @rc AS rc;`,
        );
        if ((lockRes.recordset[0]?.rc ?? -1) < 0)
          throw new Error("Barkod kilidi alınamadı");

        const barcodeId = await generateBarcodeIdInTx(tx);
        const r = tx.request();
        r.input("p1", barcodeId);
        r.input("p2", name);
        r.input("p3", location);
        r.input("p4", category || "Diğer");
        r.input("p5", description || null);
        r.input("p6", imagePath);
        r.input("p7", qty);
        const result = await r.query(
          `INSERT INTO demirbaslar (barcode_id, name, location, category, description, image_path, quantity)
           OUTPUT INSERTED.*
           VALUES (@p1, @p2, @p3, @p4, @p5, @p6, @p7)`,
        );
        await tx.commit();
        insertedRow = result.recordset[0];
      } catch (txErr) {
        try { await tx.rollback(); } catch {}
        throw txErr;
      }

      res.status(201).json(insertedRow);
    } catch (err) {
      // Clean up the already-saved upload if the DB write failed.
      cleanupUpload(req);
      console.error(err);
      res.status(500).json({ error: "Sunucu hatası" });
    }
  },
);

// PUT /api/assets/:id
app.put(
  "/api/assets/:id",
  authenticate,
  upload.single("image"),
  async (req, res) => {
    try {
      const { name, location, category, description, quantity } = req.body;
      const { id } = req.params;

      const existing = await db.query(
        `SELECT * FROM demirbaslar WHERE id = $1`,
        [id],
      );
      if (!existing.rows.length) {
        cleanupUpload(req);
        return res.status(404).json({ error: "Bulunamadı" });
      }

      let imagePath = existing.rows[0].image_path;
      const removeImage = req.body.remove_image === "true";

      if (removeImage && imagePath) {
        const oldFile = path.join(UPLOAD_DIR, path.basename(imagePath));
        if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
        imagePath = null;
      } else if (req.file) {
        if (imagePath) {
          const oldFile = path.join(UPLOAD_DIR, path.basename(imagePath));
          if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
        }
        imagePath = `/uploads/${req.file.filename}`;
      }

      const qty =
        quantity !== undefined
          ? Math.max(1, parseInt(quantity) || 1)
          : existing.rows[0].quantity;

      const result = await db.query(
        `UPDATE demirbaslar
         SET name=$1, location=$2, category=$3, description=$4, image_path=$5, quantity=$6
         OUTPUT INSERTED.*
         WHERE id=$7`,
        [
          name || existing.rows[0].name,
          location || existing.rows[0].location,
          category || existing.rows[0].category,
          description !== undefined
            ? description
            : existing.rows[0].description,
          imagePath,
          qty,
          id,
        ],
      );
      // [FIX 8] Guard against a concurrent DELETE between the SELECT and UPDATE.
      if (!result.rows.length) {
        cleanupUpload(req);
        return res.status(404).json({ error: "Bulunamadı" });
      }
      res.json(result.rows[0]);
    } catch (err) {
      cleanupUpload(req);
      console.error(err);
      res.status(500).json({ error: "Sunucu hatası" });
    }
  },
);

// PATCH /api/assets/:id/quantity — hızlı adet güncelle
app.patch("/api/assets/:id/quantity", authenticate, async (req, res) => {
  try {
    const qty = Math.max(1, parseInt(req.body.quantity) || 1);
    const result = await db.query(
      `UPDATE demirbaslar SET quantity=$1 OUTPUT INSERTED.* WHERE id=$2`,
      [qty, req.params.id],
    );
    if (!result.rows.length)
      return res.status(404).json({ error: "Bulunamadı" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Sunucu hatası" });
  }
});

// DELETE /api/assets/:id
app.delete("/api/assets/:id", authenticate, async (req, res) => {
  try {
    const existing = await db.query(`SELECT * FROM demirbaslar WHERE id = $1`, [
      req.params.id,
    ]);
    if (!existing.rows.length)
      return res.status(404).json({ error: "Bulunamadı" });

    // [FIX 6] Delete the DB record first. If this fails the file is preserved.
    //         If it succeeds but the unlink fails, that is acceptable disk waste.
    await db.query(`DELETE FROM demirbaslar WHERE id = $1`, [req.params.id]);

    if (existing.rows[0].image_path) {
      const filePath = path.join(
        UPLOAD_DIR,
        path.basename(existing.rows[0].image_path),
      );
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Sunucu hatası" });
  }
});

// GET /api/stats
app.get("/api/stats", authenticate, async (req, res) => {
  try {
    const [stats, categories, locations] = await Promise.all([
      db.query(`SELECT * FROM demirbase_stats`),
      db.query(
        `SELECT category, COUNT(*) AS count FROM demirbaslar GROUP BY category ORDER BY count DESC`,
      ),
      db.query(
        `SELECT TOP 10 location, COUNT(*) AS count FROM demirbaslar GROUP BY location ORDER BY count DESC`,
      ),
    ]);
    res.json({
      ...stats.rows[0],
      categories: categories.rows,
      top_locations: locations.rows,
    });
  } catch (err) {
    res.status(500).json({ error: "Sunucu hatası" });
  }
});

// GET /api/health
app.get("/api/health", (req, res) =>
  res.json({ status: "ok", time: new Date() }),
);

// ─── Hata yönetimi ────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE")
    return res.status(400).json({ error: "Dosya 5MB'dan büyük olamaz" });
  // Multer file-type rejection: message is a safe hardcoded string.
  if (err.message === "Sadece resim dosyaları yüklenebilir.")
    return res.status(400).json({ error: err.message });
  console.error(err);
  // [FIX 9] Never expose raw err.message — it may contain SQL fragments or
  //         internal paths from mssql/other libraries.
  res.status(500).json({ error: "Sunucu hatası" });
});

// ─── Başlat ───────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Demirbaş API çalışıyor → http://localhost:${PORT}`);
  console.log(`   POST   /api/auth/register`);
  console.log(`   POST   /api/auth/login`);
  console.log(`   GET    /api/auth/me`);
  console.log(`   GET    /api/settings`);
  console.log(`   PUT    /api/settings              (admin)`);
  console.log(`   GET    /api/settings/allowed-emails (admin)`);
  console.log(`   PUT    /api/settings/allowed-emails (admin)`);
  console.log(`   GET    /api/assets`);
  console.log(`   POST   /api/assets`);
  console.log(`   GET    /api/assets/:id`);
  console.log(`   GET    /api/assets/barcode/:id`);
  console.log(`   PUT    /api/assets/:id`);
  console.log(`   PATCH  /api/assets/:id/quantity`);
  console.log(`   DELETE /api/assets/:id`);
  console.log(`   GET    /api/stats`);
});
