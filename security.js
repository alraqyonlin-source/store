/**
 * middleware/security.js — طبقة الحماية الحقيقية لمتجر "التنوع الراقي"
 *
 * تثبيت الحزم:
 *   npm install helmet express-rate-limit express-mongo-sanitize xss-clean jsonwebtoken
 *
 * ملاحظة مهمة وصادقة عن SQL Injection:
 * بما أن `server.js` يستخدم Prisma ORM حصرياً (وليس استعلامات SQL خام
 * مكتوبة يدوياً)، فإن Prisma يُبنيها كـ Prepared Statements تلقائياً —
 * أي أن الحماية من SQL Injection موجودة بالفعل من خلال طريقة بناء
 * الاستعلامات نفسها، وليست شيئاً يُضاف كطبقة منفصلة. الخطر الحقيقي الوحيد
 * هو لو استخدم أحد مستقبلاً `prisma.$queryRawUnsafe()` ببيانات من المستخدم
 * مباشرة — تجنبي ذلك دائماً.
 */

const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");

/* ============================================================
   1) ترويسات أمان عامة (تمنع هجمات شائعة على مستوى المتصفح)
   ============================================================ */
const securityHeaders = helmet({
  contentSecurityPolicy: false, // فعّليها لاحقاً بقائمة نطاقات محددة (Cloudinary، الخط...) بعد النشر
  crossOriginResourcePolicy: { policy: "cross-origin" }, // لعرض صور Cloudinary في متجرك
});

/* ============================================================
   2) حد لعدد الطلبات (Rate Limiting) — يمنع هجمات التخمين
   وإغراق السيرفر بطلبات وهمية (Brute Force / DoS بسيط)
   ============================================================ */
// حد عام لكل الـ API
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 دقيقة
  max: 300, // 300 طلب لكل IP خلال 15 دقيقة
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "طلبات كثيرة جداً من هذا الجهاز، حاولي بعد قليل" },
});

// حد صارم جداً لمحاولات تسجيل الدخول و OTP تحديداً (منع Brute Force على كلمات المرور/الرموز)
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 8, // 8 محاولات كحد أقصى كل 10 دقائق لكل IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "محاولات كثيرة جداً، الرجاء الانتظار قبل إعادة المحاولة" },
});

/* ============================================================
   3) تنظيف المدخلات (يمنع XSS — النصوص الضارة التي تُحقن كأكواد)
   ============================================================ */
function sanitizeInput(req, res, next) {
  const clean = (val) => {
    if (typeof val === "string") {
      return val
        .replace(/<script.*?>.*?<\/script>/gis, "")
        .replace(/<\/?[^>]+(>|$)/g, "") // إزالة أي وسوم HTML من النصوص المُدخلة
        .trim();
    }
    if (Array.isArray(val)) return val.map(clean);
    if (val && typeof val === "object") {
      const out = {};
      for (const k in val) out[k] = clean(val[k]);
      return out;
    }
    return val;
  };
  if (req.body) req.body = clean(req.body);
  if (req.query) req.query = clean(req.query);
  next();
}

/* ============================================================
   4) حماية CSRF — عبر التحقق من رأس Origin على الطلبات المُغيِّرة للبيانات
   (بديل عملي وخفيف لتوكن CSRF التقليدي، مناسب لواجهة SPA/Static منفصلة)
   ============================================================ */
function csrfOriginGuard(allowedOrigins = []) {
  return (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (!origin || !allowedOrigins.includes(origin)) {
      return res.status(403).json({ error: "مصدر الطلب غير موثوق" });
    }
    next();
  };
}

/* ============================================================
   5) التحقق من هوية الموظف/المالك (JWT) + التحقق من الصلاحية
   ============================================================ */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "الرجاء تسجيل الدخول" });
  try {
    req.staff = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "جلسة الدخول منتهية، الرجاء تسجيل الدخول مجدداً" });
  }
}

// المالك يتجاوز كل شيء؛ الموظف يجب أن تحتوي صلاحياته على المفتاح المطلوب
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.staff) return res.status(401).json({ error: "الرجاء تسجيل الدخول" });
    if (req.staff.role === "OWNER") return next();
    if ((req.staff.permissions || []).includes(permission)) return next();
    return res.status(403).json({ error: "ليست لديك صلاحية لتنفيذ هذا الإجراء" });
  };
}

module.exports = {
  securityHeaders,
  generalLimiter,
  authLimiter,
  sanitizeInput,
  csrfOriginGuard,
  requireAuth,
  requirePermission,
};
