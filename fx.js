/**
 * routes/fx.js — سعر الصرف الحقيقي (YER/SAR)
 *
 * هذا ما كان مفقوداً في نسخة Netlify الثابتة — هناك كان سعر الصرف رقماً
 * يدوياً ثابتاً في الكود لأن موقعاً ثابتاً بلا خادم لا يستطيع تحديثه تلقائياً.
 * الآن، ولأن عندنا خادماً حقيقياً، نجلب السعر من خدمة صرف مجانية ونخزّنه
 * مؤقتاً (Cache) لساعات، بدل الاعتماد على رقم ثابت للأبد.
 *
 * ملاحظة صادقة: الريال اليمني غير مُدرَج رسمياً في أغلب خدمات الصرف
 * العالمية المجانية بسبب تعدد أسعار الصرف الفعلية داخل اليمن (منطقة
 * صنعاء تختلف عن عدن). لذلك هذا المسار يجلب سعر الريال السعودي دولياً
 * بدقة، ويحسب الريال اليمني بالنسبة إليه عبر معامل تقريبي يُحدَّثه
 * المالك يدوياً من لوحة التحكم كلما تغيّر السوق الموازي — وهذا أدق
 * وأصدق من أي "سعر حي" مزيّف للريال اليمني تحديداً.
 */

const express = require("express");
const { requireAuth, requirePermission } = require("../middleware/security");
const router = express.Router();

let cache = { rate: null, fetchedAt: 0 };
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 ساعات

// معامل تقريبي: كم ريال يمني يعادل 1 ريال سعودي في السوق الموازي.
// حدّثيه من لوحة التحكم (routes/fxOverride.js لاحقاً) كلما تغيّر السعر الفعلي.
let YER_PER_SAR_MANUAL_FACTOR = Number(process.env.YER_PER_SAR_FACTOR) || 106;

router.get("/rate", async (req, res) => {
  const now = Date.now();
  if (cache.rate && now - cache.fetchedAt < CACHE_TTL_MS) {
    return res.json({ ...cache.rate, cached: true });
  }

  try {
    // خدمة مجانية بدون مفتاح API — سعر الريال السعودي مقابل الدولار
    const response = await fetch("https://open.er-api.com/v6/latest/SAR");
    const data = await response.json();
    if (data.result !== "success") throw new Error("فشل جلب سعر الصرف");

    const result = {
      base: "SAR",
      usdRate: data.rates.USD, // سعر الريال السعودي مقابل الدولار (مرجعي)
      yerPerSar: YER_PER_SAR_MANUAL_FACTOR, // معامل يدوي (انظري الملاحظة أعلاه)
      updatedAt: data.time_last_update_utc,
    };
    cache = { rate: result, fetchedAt: now };
    res.json({ ...result, cached: false });
  } catch (err) {
    console.error("تعذّر جلب سعر الصرف الحي:", err.message);
    // فشل الاتصال بالخدمة الخارجية؟ استخدمي آخر قيمة محفوظة أو المعامل اليدوي فقط
    res.json({
      base: "SAR",
      usdRate: null,
      yerPerSar: YER_PER_SAR_MANUAL_FACTOR,
      updatedAt: null,
      cached: true,
      note: "تعذّر الاتصال بخدمة الصرف الخارجية، تم استخدام المعامل اليدوي فقط",
    });
  }
});

// تحديث المعامل اليدوي — محمي، للمالك أو موظف لديه صلاحية الإعدادات فقط
router.post("/rate/manual-factor", requireAuth, requirePermission("settings:write"), (req, res) => {
  const { yerPerSar } = req.body;
  if (!yerPerSar || yerPerSar <= 0) return res.status(400).json({ error: "قيمة غير صحيحة" });
  YER_PER_SAR_MANUAL_FACTOR = Number(yerPerSar);
  cache = { rate: null, fetchedAt: 0 }; // إبطال التخزين المؤقت ليُعاد الحساب بالقيمة الجديدة
  res.json({ success: true, yerPerSar: YER_PER_SAR_MANUAL_FACTOR });
});

module.exports = router;
