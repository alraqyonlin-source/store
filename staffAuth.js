/**
 * routes/staffAuth.js — دخول المالك والموظفين (RBAC حقيقي)
 *
 * npm install bcryptjs jsonwebtoken
 *
 * هذا منفصل تماماً عن تسجيل دخول العملاء (OTP) الموجود في server.js —
 * لأن حساب الإدارة يحتاج كلمة مرور مشفّرة حقيقية وصلاحيات، بينما حساب
 * العميل يحتاج فقط تحقق سريع برقم الهاتف.
 */

const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { PrismaClient } = require("@prisma/client");
const { authLimiter, requireAuth } = require("../middleware/security");

const router = express.Router();
const prisma = new PrismaClient();

/* ============================================================
   إنشاء أول حساب مالك (يُستخدم مرة واحدة فقط عند إطلاق المتجر)
   بعدها يُغلق هذا المسار تلقائياً — لا يمكن إنشاء مالك ثانٍ منه
   ============================================================ */
router.post("/setup-owner", async (req, res) => {
  const existingOwner = await prisma.staffUser.findFirst({ where: { role: "OWNER" } });
  if (existingOwner) {
    return res.status(403).json({ error: "تم تعيين حساب المالك مسبقاً — استخدمي تسجيل الدخول العادي" });
  }
  const { name, email, password } = req.body;
  if (!name || !email || !password || password.length < 8) {
    return res.status(400).json({ error: "الاسم والبريد وكلمة مرور من 8 أحرف على الأقل مطلوبة" });
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const owner = await prisma.staffUser.create({
    data: { name, email, passwordHash, role: "OWNER", permissions: [] },
  });
  res.status(201).json({ success: true, id: owner.id, message: "تم إنشاء حساب المالك بنجاح" });
});

/* ============================================================
   المالك يضيف موظفاً جديداً بصلاحيات محددة
   ============================================================ */
router.post("/staff", requireAuth, async (req, res) => {
  if (req.staff.role !== "OWNER") return res.status(403).json({ error: "فقط المالك يمكنه إضافة موظفين" });
  const { name, email, password, permissions } = req.body;
  if (!name || !email || !password || password.length < 8) {
    return res.status(400).json({ error: "الاسم والبريد وكلمة مرور من 8 أحرف على الأقل مطلوبة" });
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const staff = await prisma.staffUser.create({
    data: { name, email, passwordHash, role: "STAFF", permissions: permissions || [] },
  });
  await logAction(req.staff.staffId, "staff.create", "StaffUser", staff.id);
  res.status(201).json({ id: staff.id, name: staff.name, email: staff.email, permissions: staff.permissions });
});

/* ============================================================
   تسجيل الدخول (مالك أو موظف) — محمي بحد صارم لمنع تخمين كلمات المرور
   ============================================================ */
router.post("/login", authLimiter, async (req, res) => {
  const { email, password } = req.body;
  const staff = await prisma.staffUser.findUnique({ where: { email } });
  if (!staff || !staff.isActive) return res.status(401).json({ error: "بيانات الدخول غير صحيحة" });

  const valid = await bcrypt.compare(password, staff.passwordHash);
  if (!valid) return res.status(401).json({ error: "بيانات الدخول غير صحيحة" });

  const token = jwt.sign(
    { staffId: staff.id, role: staff.role, permissions: staff.permissions },
    process.env.JWT_SECRET,
    { expiresIn: "12h" }
  );
  await logAction(staff.id, "auth.login", "StaffUser", staff.id);
  res.json({ token, name: staff.name, role: staff.role, permissions: staff.permissions });
});

/* ============================================================
   سجل المراقبة (Audit Log) — لمراجعة المالك لعمليات موظفيه
   ============================================================ */
router.get("/audit-log", requireAuth, async (req, res) => {
  if (req.staff.role !== "OWNER") return res.status(403).json({ error: "فقط المالك يمكنه مراجعة سجل العمليات" });
  const logs = await prisma.auditLog.findMany({
    include: { staff: { select: { name: true, email: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  res.json(logs);
});

// دالة مساعدة يستخدمها أي Router آخر لتسجيل عملية في سجل المراقبة
async function logAction(staffId, action, targetType, targetId, details) {
  try {
    await prisma.auditLog.create({ data: { staffId, action, targetType, targetId, details } });
  } catch (err) {
    console.error("تعذّر تسجيل العملية في سجل المراقبة:", err.message);
  }
}

module.exports = { router, logAction };
