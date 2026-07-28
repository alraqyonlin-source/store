/**
 * routes/orders.js — إدارة الطلبات لمتجر "التنوع الراقي"
 *
 * يجمع بين: إنشاء الطلب من العميل (يتضمن رفع سند التحويل + إرسال بريد
 * فوري للإدارة + توليد كوبون تلقائي) وإدارته من لوحة التحكم (قائمة،
 * تفاصيل، تحديث الحالة) بصلاحيات محمية وسجل مراقبة.
 */

const express = require("express");
const nodemailer = require("nodemailer");
const { PrismaClient } = require("@prisma/client");
const { uploadPaymentProof } = require("../utils/upload");
const { requireAuth, requirePermission } = require("../middleware/security");
const { logAction } = require("./staffAuth");

const router = express.Router();
const prisma = new PrismaClient();

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: 465,
  secure: true,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

/* ============================================================
   POST /api/orders — إنشاء طلب جديد (من العميل، بدون تسجيل دخول إداري)
   ============================================================ */
router.post("/", uploadPaymentProof.single("paymentProof"), async (req, res) => {
  try {
    const { customerId, items, paymentMethod, transactionNumber, totalAmount } =
      typeof req.body.payload === "string" ? JSON.parse(req.body.payload) : req.body;

    if (!customerId || !items || !items.length || !paymentMethod) {
      return res.status(400).json({ error: "بيانات الطلب غير مكتملة" });
    }

    const order = await prisma.order.create({
      data: {
        customerId,
        totalAmount,
        paymentMethod,
        transactionNumber,
        paymentProofUrl: req.file ? req.file.path : null,
        items: {
          create: items.map((it) => ({
            productId: it.productId,
            quantity: it.quantity,
            unitPrice: it.unitPrice,
            selectedOptions: it.selectedOptions,
          })),
        },
      },
      include: { items: { include: { product: true } }, customer: true },
    });

    await sendOrderEmail(order);
    await maybeIssueCoupon(order);

    res.status(201).json({ success: true, orderId: order.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "تعذّر إنشاء الطلب" });
  }
});

/* ============================================================
   GET /api/orders — قائمة الطلبات (لوحة التحكم فقط)
   Query: status, page, limit
   ============================================================ */
router.get("/", requireAuth, requirePermission("orders:read"), async (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;
  const where = status ? { status } : {};
  const [items, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: { customer: true, items: { include: { product: true } } },
      orderBy: { createdAt: "desc" },
      skip: (Number(page) - 1) * Number(limit),
      take: Number(limit),
    }),
    prisma.order.count({ where }),
  ]);
  res.json({ items, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) });
});

/* ============================================================
   GET /api/orders/:id — تفاصيل طلب واحد (لوحة التحكم)
   ============================================================ */
router.get("/:id", requireAuth, requirePermission("orders:read"), async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: { customer: true, items: { include: { product: true } } },
  });
  if (!order) return res.status(404).json({ error: "الطلب غير موجود" });
  res.json(order);
});

/* ============================================================
   PATCH /api/orders/:id/status — تحديث حالة الطلب (محمي + مسجَّل)
   body: { status: "CONFIRMED" | "PROCESSING" | "SHIPPED" | "DELIVERED" | "CANCELLED" }
   ============================================================ */
const VALID_STATUSES = ["PENDING", "CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED"];
router.patch("/:id/status", requireAuth, requirePermission("orders:write"), async (req, res) => {
  const { status } = req.body;
  if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: "حالة غير صحيحة" });

  const order = await prisma.order.update({ where: { id: req.params.id }, data: { status } });
  await logAction(req.staff.staffId, "order.status_update", "Order", order.id, { newStatus: status });
  res.json(order);
});

/* ============================================================
   دوال مساعدة (بريد الإدارة + كوبون تلقائي)
   ============================================================ */
async function sendOrderEmail(order) {
  const rows = order.items
    .map((it) => {
      const opts = it.selectedOptions || {};
      return `<tr>
        <td style="padding:8px;border:1px solid #eee">${it.product.title}</td>
        <td style="padding:8px;border:1px solid #eee">${it.quantity}</td>
        <td style="padding:8px;border:1px solid #eee">${opts.color || "-"}</td>
        <td style="padding:8px;border:1px solid #eee">${opts.size || "-"}</td>
        <td style="padding:8px;border:1px solid #eee">${opts.engraveName || opts.customerNote || "-"}</td>
      </tr>`;
    })
    .join("");

  const html = `<div style="font-family:Tahoma,Arial;direction:rtl;text-align:right">
    <h2>طلب جديد رقم #${order.id.slice(-6)}</h2>
    <p><b>العميل:</b> ${order.customer.name || "-"} — ${order.customer.phone}</p>
    <p><b>طريقة الدفع:</b> ${order.paymentMethod} — رقم العملية: ${order.transactionNumber || "-"}</p>
    ${order.paymentProofUrl ? `<p><b>سند التحويل:</b> <a href="${order.paymentProofUrl}">عرض الصورة</a></p>` : ""}
    <table style="border-collapse:collapse;width:100%">
      <tr style="background:#3D1F3D;color:#fff"><th style="padding:8px">المنتج</th><th>الكمية</th><th>اللون</th><th>المقاس</th><th>ملاحظات/اسم منقوش</th></tr>
      ${rows}
    </table>
    <h3>الإجمالي: ${order.totalAmount} ريال يمني</h3>
  </div>`;

  await transporter.sendMail({
    from: `"متجر التنوع الراقي" <${process.env.SMTP_USER}>`,
    to: process.env.ADMIN_EMAIL,
    subject: `🛍️ طلب جديد #${order.id.slice(-6)} — ${order.totalAmount} ريال`,
    html,
  });

  await prisma.order.update({ where: { id: order.id }, data: { emailSentAt: new Date() } });
}

async function maybeIssueCoupon(order) {
  if (Number(order.totalAmount) < 10000) return;
  const code = "VIP-" + Math.random().toString(36).slice(2, 8).toUpperCase();
  const coupon = await prisma.coupon.create({
    data: {
      code,
      customerId: order.customerId,
      percentOff: 10,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
  if (!order.customer.email) return; // لا بريد للعميل، تخطّي إرسال الكوبون
  await transporter.sendMail({
    from: `"متجر التنوع الراقي" <${process.env.SMTP_USER}>`,
    to: order.customer.email,
    subject: "🎁 هدية لك! كود خصم 10٪ على طلبك القادم",
    html: `<div style="direction:rtl;font-family:Tahoma">
      <p>شكراً لثقتك بنا! كود الخصم الخاص بك:</p>
      <h2 style="color:#C9A227">${code}</h2>
      <p>صالح حتى ${coupon.expiresAt.toLocaleDateString("ar-YE")}</p>
    </div>`,
  });
}

module.exports = router;
