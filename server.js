/**
 * server.js — الباك إند لمتجر "التنوع الراقي"
 * Node.js (18+) + Express + Prisma + Nodemailer
 *
 * قبل التشغيل:
 *   npm install express prisma @prisma/client nodemailer cors dotenv jsonwebtoken
 *   npm install cloudinary multer multer-storage-cloudinary
 *   npm install helmet express-rate-limit bcryptjs
 *   npx prisma migrate dev
 *
 * ملف .env المطلوب:
 *   DATABASE_URL="postgresql://user:pass@host:5432/altanawwu"
 *   SMTP_HOST=...  SMTP_USER=...  SMTP_PASS=...
 *   ADMIN_EMAIL=owner@example.com
 *   JWT_SECRET=... (نص عشوائي طويل وسري)
 *   CLOUDINARY_CLOUD_NAME=...  CLOUDINARY_API_KEY=...  CLOUDINARY_API_SECRET=...
 *   FRONTEND_ORIGIN=https://your-store.netlify.app
 *   YER_PER_SAR_FACTOR=106   (اختياري — معامل الصرف اليدوي، راجعي routes/fx.js)
 */

const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { PrismaClient } = require("@prisma/client");

const {
  securityHeaders, generalLimiter, authLimiter, sanitizeInput,
} = require("./middleware/security");

const prisma = new PrismaClient();
const app = express();

/* ============================================================
   طبقة الحماية — تُفعَّل قبل أي شيء آخر
   ============================================================ */
app.use(securityHeaders);
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || "*", // حدّدي نطاق متجرك الفعلي في الإنتاج بدل *
  credentials: true,
}));
app.use(express.json({ limit: "2mb" }));
app.use(sanitizeInput);
app.use("/api", generalLimiter);

/* ============================================================
   تركيب كل المسارات (Routers)
   ============================================================ */
app.use("/api/products", require("./routes/products"));
app.use("/api/orders", require("./routes/orders"));
app.use("/api/fx", require("./routes/fx"));
app.use("/api/staff", require("./routes/staffAuth").router);

/* ============================================================
   تسجيل دخول العملاء عبر OTP (منفصل عن دخول الموظفين/المالك)
   ============================================================ */
app.post("/api/auth/request-otp", authLimiter, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "رقم الهاتف مطلوب" });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  await prisma.customer.upsert({
    where: { phone },
    update: { otpCode: otp, otpExpires: new Date(Date.now() + 5 * 60 * 1000) },
    create: { phone, otpCode: otp, otpExpires: new Date(Date.now() + 5 * 60 * 1000) },
  });

  // في الإنتاج: أرسلي عبر بوابة SMS يمنية حقيقية بدل الطباعة في السجل
  console.log(`OTP for ${phone}: ${otp}`); // للتطوير فقط — احذفي هذا السطر في الإنتاج

  res.json({ success: true, message: "تم إرسال رمز التحقق" });
});

app.post("/api/auth/verify-otp", authLimiter, async (req, res) => {
  const { phone, otp } = req.body;
  const customer = await prisma.customer.findUnique({ where: { phone } });

  if (!customer || customer.otpCode !== otp || customer.otpExpires < new Date()) {
    return res.status(400).json({ success: false, message: "رمز غير صحيح أو منتهي" });
  }

  await prisma.customer.update({ where: { phone }, data: { isVerified: true, otpCode: null } });
  const token = jwt.sign({ customerId: customer.id }, process.env.JWT_SECRET, { expiresIn: "30d" });
  res.json({ success: true, token });
});

/* ============================================================
   البحث الذكي (Autocomplete) عبر الوسوم الخفية (15+ مرادف)
   ============================================================ */
app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json([]);

  const products = await prisma.product.findMany({
    where: {
      isActive: true,
      OR: [
        { title: { contains: q, mode: "insensitive" } },
        { seoTags: { has: q } },
        { seoTags: { hasSome: q.split(" ") } },
      ],
    },
    take: 8,
    select: { id: true, title: true, images: true, priceFinal: true },
  });

  res.json(products);
});

/* ============================================================
   فحص صحة السيرفر (تستخدمه Render/Railway للتأكد أن الخدمة تعمل)
   ============================================================ */
app.get("/api/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

app.listen(process.env.PORT || 4000, () => console.log("✅ Server running"));
