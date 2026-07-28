/**
 * routes/products.js — Products API لمتجر "التنوع الراقي"
 *
 * يُركَّب في server.js هكذا:
 *   const productsRouter = require("./routes/products");
 *   app.use("/api/products", productsRouter);
 *
 * الحزم المطلوبة (نفس حزم server.js):
 *   express, @prisma/client, multer
 *
 * ملاحظة: بما أنك لم تذكر قائمة الـ Endpoints بالتفصيل، بنيت المجموعة
 * القياسية الكاملة لإدارة المنتجات (قراءة/بحث/إنشاء/تعديل/حذف/مخزون/SEO)
 * بناءً على schema.prisma الذي بنيناه سابقاً. أخبريني إن كان هناك Endpoint
 * إضافي تحتاجينه بالتحديد وسأضيفه.
 */

const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { uploadProductImages, deleteImageByUrl } = require("../utils/upload");
const { requireAuth, requirePermission } = require("../middleware/security");
const { logAction } = require("./staffAuth");

const router = express.Router();
const prisma = new PrismaClient();

// رفع الصور أصبح سحابياً (Cloudinary) عبر utils/upload.js بدل القرص المحلي
const upload = uploadProductImages;

// ============================================================
// أدوات مساعدة
// ============================================================

// تحقق مبسّط من توافق optionsData مع نوع الكتلوج المختار
function validateOptionsForCatalogType(type, optionsData = {}) {
  const errors = [];
  switch (type) {
    case "FREE_SIZE_CLOTHING":
      // لا يُسمح بإرسال مقاسات هنا — يُقفل تلقائياً على فري سايز
      if (optionsData.sizes) errors.push("قسم الفري سايز لا يقبل تحديد مقاسات");
      break;
    case "MULTI_SIZE_CLOTHING":
      if (!Array.isArray(optionsData.sizes) || optionsData.sizes.length === 0)
        errors.push("يجب تحديد قائمة المقاسات (sizes)");
      if (!Array.isArray(optionsData.colors) || optionsData.colors.length === 0)
        errors.push("يجب تحديد قائمة الألوان (colors)");
      break;
    case "ACCESSORIES":
      if (!optionsData.customSizeLabel) errors.push("يجب تحديد نص المقاس المخصص (customSizeLabel)");
      break;
    case "COSMETICS":
      if (!Array.isArray(optionsData.cosmeticSizes) || optionsData.cosmeticSizes.length === 0)
        errors.push("يجب تحديد أحجام المنتج ووزنها (cosmeticSizes: [{label, weight}])");
      break;
    case "ENGRAVED_GIFTS":
      if (!Array.isArray(optionsData.colors) || optionsData.colors.length === 0)
        errors.push("يجب تحديد الألوان المتاحة من الإدارة (colors)");
      break;
    case "CUSTOM_TAILORING":
      if (!Array.isArray(optionsData.fabrics) || optionsData.fabrics.length === 0)
        errors.push("يجب تحديد أنواع القماش (fabrics)");
      if (!Array.isArray(optionsData.stitchStyles) || optionsData.stitchStyles.length === 0)
        errors.push("يجب تحديد أنواع الخياطة (stitchStyles)");
      break;
  }
  return errors;
}

function buildSeoSchema(product) {
  return {
    "@context": "https://schema.org/",
    "@type": "Product",
    name: product.title,
    image: product.images,
    description: product.description,
    keywords: (product.seoTags || []).join(", "),
    offers: {
      "@type": "Offer",
      priceCurrency: "YER",
      price: product.priceFinal,
      availability: product.stock > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
    },
  };
}

// ============================================================
// GET /api/products — قائمة المنتجات (فلترة + بحث + ترقيم صفحات)
// Query params: catalogId, q, minPrice, maxPrice, page, limit, activeOnly
// ============================================================
router.get("/", async (req, res) => {
  try {
    const { catalogId, q, minPrice, maxPrice, page = 1, limit = 20, activeOnly = "true" } = req.query;

    const where = {
      ...(activeOnly === "true" ? { isActive: true } : {}),
      ...(catalogId ? { catalogId } : {}),
      ...(minPrice || maxPrice
        ? { priceFinal: { ...(minPrice ? { gte: Number(minPrice) } : {}), ...(maxPrice ? { lte: Number(maxPrice) } : {}) } }
        : {}),
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: "insensitive" } },
              { description: { contains: q, mode: "insensitive" } },
              { seoTags: { has: q } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.product.findMany({
        where,
        include: { catalog: true },
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
        orderBy: { createdAt: "desc" },
      }),
      prisma.product.count({ where }),
    ]);

    res.json({ items, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "تعذّر جلب المنتجات" });
  }
});

// ============================================================
// GET /api/products/:id — تفاصيل منتج واحد
// ============================================================
router.get("/:id", async (req, res) => {
  const product = await prisma.product.findUnique({
    where: { id: req.params.id },
    include: { catalog: true },
  });
  if (!product) return res.status(404).json({ error: "المنتج غير موجود" });
  res.json(product);
});

// ============================================================
// GET /api/products/:id/seo-schema — Schema.org Markup لصفحة المنتج
// ============================================================
router.get("/:id/seo-schema", async (req, res) => {
  const product = await prisma.product.findUnique({ where: { id: req.params.id } });
  if (!product) return res.status(404).json({ error: "المنتج غير موجود" });
  res.json(buildSeoSchema(product));
});

// ============================================================
// POST /api/products — إنشاء منتج جديد (متعدد الصور حتى 10)
// body (multipart/form-data):
//   catalogId, title, description, priceOriginal, priceFinal, stock,
//   optionsData (JSON string), seoTags (JSON array string), images[] (files)
// ============================================================
router.post("/", requireAuth, requirePermission("products:write"), upload.array("images", 10), async (req, res) => {
  try {
    const { catalogId, title, description, priceOriginal, priceFinal, stock } = req.body;

    if (!catalogId || !title || !priceOriginal || !priceFinal) {
      return res.status(400).json({ error: "الحقول الأساسية مطلوبة: catalogId, title, priceOriginal, priceFinal" });
    }

    const catalog = await prisma.catalog.findUnique({ where: { id: catalogId } });
    if (!catalog) return res.status(404).json({ error: "القسم (الكتلوج) غير موجود" });

    const optionsData = req.body.optionsData ? JSON.parse(req.body.optionsData) : {};
    const seoTags = req.body.seoTags ? JSON.parse(req.body.seoTags) : [];

    const validationErrors = validateOptionsForCatalogType(catalog.type, optionsData);
    if (validationErrors.length) return res.status(400).json({ errors: validationErrors });

    if (seoTags.length < 15) {
      // تنبيه وليس رفض — يُشجَّع الوصول لـ 15+ كلمة لأفضل أرشفة، لكن لا يمنع الحفظ
      console.warn(`تنبيه: المنتج "${title}" أُنشئ بعدد كلمات مفتاحية أقل من 15 (${seoTags.length})`);
    }

    // f.path هو الرابط الدائم الذي يعيده Cloudinary لكل صورة مرفوعة
    const images = (req.files || []).map((f) => f.path);

    const product = await prisma.product.create({
      data: {
        catalogId,
        title,
        description: description || "",
        images,
        priceOriginal,
        priceFinal,
        stock: Number(stock) || 0,
        optionsData,
        seoTags,
      },
    });

    res.status(201).json({ ...product, seoSchema: buildSeoSchema(product) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "تعذّر إنشاء المنتج" });
  }
});

// ============================================================
// PUT /api/products/:id — تعديل منتج (بيانات + إمكانية إضافة صور جديدة)
// ============================================================
router.put("/:id", requireAuth, requirePermission("products:write"), upload.array("images", 10), async (req, res) => {
  try {
    const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "المنتج غير موجود" });

    const { title, description, priceOriginal, priceFinal, stock, isActive } = req.body;
    const optionsData = req.body.optionsData ? JSON.parse(req.body.optionsData) : existing.optionsData;
    const seoTags = req.body.seoTags ? JSON.parse(req.body.seoTags) : existing.seoTags;

    const newImages = (req.files || []).map((f) => f.path);
    const images = newImages.length ? [...existing.images, ...newImages].slice(0, 10) : existing.images;

    const updated = await prisma.product.update({
      where: { id: req.params.id },
      data: {
        ...(title && { title }),
        ...(description !== undefined && { description }),
        ...(priceOriginal && { priceOriginal }),
        ...(priceFinal && { priceFinal }),
        ...(stock !== undefined && { stock: Number(stock) }),
        ...(isActive !== undefined && { isActive: isActive === "true" || isActive === true }),
        optionsData,
        seoTags,
        images,
      },
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "تعذّر تعديل المنتج" });
  }
});

// ============================================================
// PATCH /api/products/:id/stock — تحديث المخزون فقط (مفيد لعمليات سريعة)
// body: { stock: number }  أو  { delta: number } للزيادة/النقصان
// ============================================================
router.patch("/:id/stock", requireAuth, requirePermission("products:write"), async (req, res) => {
  const { stock, delta } = req.body;
  const product = await prisma.product.findUnique({ where: { id: req.params.id } });
  if (!product) return res.status(404).json({ error: "المنتج غير موجود" });

  const newStock = stock !== undefined ? Number(stock) : product.stock + Number(delta || 0);
  const updated = await prisma.product.update({
    where: { id: req.params.id },
    data: { stock: Math.max(0, newStock) },
  });
  res.json(updated);
});

// ============================================================
// DELETE /api/products/:id — حذف منتج
// Query: ?hard=true لحذف نهائي، افتراضياً حذف ناعم (isActive=false)
// ============================================================
router.delete("/:id", requireAuth, requirePermission("products:write"), async (req, res) => {
  const product = await prisma.product.findUnique({ where: { id: req.params.id } });
  if (!product) return res.status(404).json({ error: "المنتج غير موجود" });

  if (req.query.hard === "true") {
    await Promise.all((product.images || []).map((url) => deleteImageByUrl(url)));
    await prisma.product.delete({ where: { id: req.params.id } });
    await logAction(req.staff.staffId, "product.delete_hard", "Product", req.params.id);
    return res.json({ success: true, deleted: "hard" });
  }

  await prisma.product.update({ where: { id: req.params.id }, data: { isActive: false } });
  await logAction(req.staff.staffId, "product.delete_soft", "Product", req.params.id);
  res.json({ success: true, deleted: "soft" });
});

// ============================================================
// GET /api/products/catalog/:catalogId/schema — إرجاع optionsSchema
// الخاص بالقسم لبناء نموذج إضافة منتج ديناميكياً في الواجهة
// ============================================================
router.get("/catalog/:catalogId/schema", async (req, res) => {
  const catalog = await prisma.catalog.findUnique({ where: { id: req.params.catalogId } });
  if (!catalog) return res.status(404).json({ error: "القسم غير موجود" });
  res.json({ type: catalog.type, optionsSchema: catalog.optionsSchema });
});

module.exports = router;
