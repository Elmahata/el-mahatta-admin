/**
 * Cloudflare Pages Function — API تطبيق «المحطة» — توكتوك بسعر ثابت
 *
 * النموذج: سعر ثابت منشور + سباق قبول بين السائقين (أول من يقبل يأخذ المشوار).
 * لا مزايدة ولا مفاصلة — السعر يُحسب على الخادم دائماً ولا يُؤخذ من العميل أبداً.
 *
 * Bindings المطلوبة:
 *   DB        → قاعدة بيانات D1
 *   ADMIN_USER → اسم مستخدم الإدارة (لو مش مضبوط = admin)
 *   ADMIN_PASS → باسورد الإدارة (Secret) — ولو مش مضبوط بيستعمل ADMIN_PIN
 *
 * المسارات:
 *   GET    /api/public               عام — المناطق والنقاط والأسعار
 *   POST   /api/request              عام — إنشاء طلب → { id, token }
 *   GET    /api/track/:id?token=     عام — متابعة حالة الطلب (+ كود الركوب بعد القبول)
 *   GET    /api/share/:id?s=         عام — صفحة «شارك رحلتك» للأهل (بدون أرقام)
 *   POST   /api/report               عام — بلاغ من الراكب (مثلاً: طلب أكتر من السعر)
 *   POST   /api/code-on              عام — الراكب يفعّل كود الركوب (اختياري)
 *   POST   /api/driver/start         سائق — بدء الرحلة (بالكود لو الراكب فعّله)
 *   POST   /api/phone-request        إدارة — طلب بالتليفون تدخّله الإدارة
 *   POST   /api/driver/login         سائق — رقم الموبايل + الكود
 *   GET    /api/driver/feed          سائق — الطلبات المتاحة + مشواره الحالي
 *   POST   /api/driver/claim         سائق — قبول طلب (ذرّي، أول من يصل)
 *   POST   /api/driver/finish        سائق — إنهاء أو ترك المشوار
 *   POST   /api/driver/online        سائق — أونلاين/أوفلاين
 *   POST   /api/login                إدارة — التحقق من الرقم السرّي
 *   GET    /api/state                إدارة — كل البيانات
 *   PUT    /api/doc/:kind/:id        إدارة — إضافة/تعديل
 *   DELETE /api/doc/:kind/:id        إدارة — حذف
 *   POST   /api/consent              عام — تسجيل موافقة على الشروط (الإصدار + الوقت + الرقم + IP)
 *   GET    /api/consents             إدارة — سجل الموافقات
 */

const KINDS = ["zones", "places", "drivers", "requests", "config", "reports", "riders", "joins"];
/* اسم السائق اللي بيظهر للراكب والأهل: الاسم الأول والتاني بس */
const name2 = (n) => String(n || "").trim().split(/\s+/).slice(0, 2).join(" ");
const LOW_BAL = 5; /* أول ما الرصيد يوصل ٥ ج أو أقل، بيظهر بانر «اشحن» */
const PUBLIC_KINDS = ["zones", "places", "config"];
const MAX_BODY = 16 * 1024;
const ONLINE_MS = 90 * 1000;              // يُعتبر السائق أونلاين إن نبض خلال هذه المدة
const CLAIM_WINDOW_MS = 10 * 60 * 1000;   // الطلب اللي محدش أخده خلال ١٠ دقايق بيتلغي لوحده

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/** مقارنة ثابتة الزمن حتى لا يُخمَّن السرّ بقياس وقت الرد */
function safeEqual(a, b) {
  const x = String(a ?? ""), y = String(b ?? "");
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

const str = (v, max) => String(v ?? "").trim().slice(0, max);
const digits = (v) => String(v ?? "").replace(/\D/g, "");
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function newToken() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function readDocs(env, kinds) {
  const marks = kinds.map(() => "?").join(",");
  const { results } = await env.DB
    .prepare(`SELECT kind, id, data FROM docs WHERE kind IN (${marks})`).bind(...kinds).all();
  const out = {};
  for (const k of kinds) out[k] = [];
  for (const row of results || []) {
    try {
      const doc = JSON.parse(row.data);
      doc.id = doc.id || row.id;
      (out[row.kind] ||= []).push(doc);
    } catch { /* صف تالف: نتجاهله بدل إسقاط الطلب كله */ }
  }
  for (const k of kinds) out[k].sort((a, b) => (a.order || 0) - (b.order || 0));
  return out;
}

async function getDoc(env, kind, id) {
  const row = await env.DB.prepare("SELECT data FROM docs WHERE kind=? AND id=?").bind(kind, id).first();
  if (!row) return null;
  try { return JSON.parse(row.data); } catch { return null; }
}

async function putDoc(env, kind, id, data) {
  await env.DB.prepare(
    `INSERT INTO docs (kind,id,data,updated) VALUES (?,?,?,?)
     ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data, updated=excluded.updated`
  ).bind(kind, id, JSON.stringify(data), Date.now()).run();
}
/* نفس الحاجة بس كـ «خطوة» جوه batch — كله يتنفّذ مع بعض أو مايتنفّذش خالص */
const putSt = (env, kind, id, data) => env.DB.prepare(
  `INSERT INTO docs (kind,id,data,updated) VALUES (?,?,?,?)
   ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data, updated=excluded.updated`
).bind(kind, id, JSON.stringify(data), Date.now());
const delSt = (env, kind, id) => env.DB.prepare("DELETE FROM docs WHERE kind=? AND id=?").bind(kind, id);

async function parseBody(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY) throw new Error("too_large");
  return JSON.parse(raw || "{}");
}

/* دخول الإدارة بيوزر وباسورد: ADMIN_USER + ADMIN_PASS (ولو ADMIN_PASS مش مضبوط بيستعمل ADMIN_PIN القديم) */
const adminPass = (env) => env.ADMIN_PASS || env.ADMIN_PIN || "";
const adminUser = (env) => String(env.ADMIN_USER || "admin").trim().toLowerCase();
const hdrUser = (req) => { try { return decodeURIComponent(req.headers.get("x-user") || "").trim().toLowerCase(); } catch (e) { return ""; } };
const isAdmin = (req, env) =>
  Boolean(adminPass(env)) && safeEqual(hdrUser(req), adminUser(env)) && safeEqual(req.headers.get("x-pin"), adminPass(env));
const sha = async (s) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)))), (b) => b.toString(16).padStart(2, "0")).join("");
/* الإدارة: الباسورد بيتبعت مرة واحدة عند الدخول، وبعدها «تذكرة» عشوائية بتتجدد لوحدها طول ما البورتال بيتفتح (٣٠ يوم من آخر استخدام). الخروج بيلغيها */
const ADMIN_TTL = 30 * 864e5;
async function adminOk(req, env) {
  const t = String(req.headers.get("x-admin-token") || "");
  if (t.length < 32) return false;
  const s = await getDoc(env, "adminsess", await sha(t));
  if (!s || s.exp < Date.now()) return false;
  if (s.exp - Date.now() < ADMIN_TTL - 864e5) { s.exp = Date.now() + ADMIN_TTL; await putDoc(env, "adminsess", s.id, s); }
  return true;
}
/* دخول السائق: الكود ٤ أرقام صالح ٢٤ ساعة ولمرة واحدة. ٥ محاولات غلط ← يتقفل ربع ساعة. بعد الدخول بياخد تذكرة دايمة على موبايله */
const DRV_TRIES = 5, DRV_LOCK_MS = 15 * 6e4, CODE_TTL = 24 * 36e5;
const LOCK_MSG = "محاولات كتير غلط — جرّب بعد ربع ساعة";
const codeLive = (d) => !d.codeUsed && Boolean(d.codeExp) && d.codeExp > Date.now();
/* الأكواد القديمة اللي مالهاش صلاحية: أول مرة تتشاف بتاخد ٢٤ ساعة من دلوقتي */
async function stampCode(env, d) { if (d.code && !d.codeExp && !d.codeUsed) { d.codeExp = Date.now() + CODE_TTL; await putDoc(env, "drivers", d.id, d); } }
async function drvLock(env, phone) { const l = await getDoc(env, "loginfail", "drv-" + phone); return Boolean(l && l.until > Date.now()); }
async function drvFail(env, phone) {
  /* العدّ بيحصل جوه قاعدة البيانات نفسها — محاولتين في نفس اللحظة بيتحسبوا اتنين */
  const k = "drv-" + phone, now = Date.now();
  const row = await env.DB.prepare(`INSERT INTO docs (kind,id,data,updated) VALUES ('loginfail',?,json_object('id',?,'n',1,'until',0),?)
    ON CONFLICT(kind,id) DO UPDATE SET updated=excluded.updated, data=json_set(data,
      '$.n', CASE WHEN IFNULL(json_extract(data,'$.until'),0)>0 AND json_extract(data,'$.until')<=? THEN 1 ELSE IFNULL(json_extract(data,'$.n'),0)+1 END,
      '$.until', CASE WHEN IFNULL(json_extract(data,'$.until'),0)>0 AND json_extract(data,'$.until')<=? THEN 0 ELSE IFNULL(json_extract(data,'$.until'),0) END)
    RETURNING data`).bind(k, k, now, now, now).first();
  const l = row ? JSON.parse(row.data) : { id: k, n: 1, until: 0 };
  if (l.n >= DRV_TRIES) { l.until = now + DRV_LOCK_MS; l.n = 0; await putDoc(env, "loginfail", k, l); }
  return l;
}

/** السائق يُعرَّف برقم موبايله + كود خاص به تضبطه الإدارة + الموبايل اللي حسابه مربوط بيه */
const devOf = (v) => str(v, 40).replace(/[^\w-]/g, "");
const HOLD_MSG = "حسابك متوقف مؤقتاً لحد ما الإدارة تراجع بلاغ — كلّم الإدارة";
const DEV_MSG = "حسابك مربوط بموبايل تاني. لو غيّرت موبايلك، ادخل من الموبايل الجديد والإدارة توافق";
async function getDriverEx(req, env) {
  const phone = digits(req.headers.get("x-driver-phone"));
  const code = String(req.headers.get("x-driver-code") || "").trim();
  if (!phone || !code) return { d: null };
  const { drivers } = await readDocs(env, ["drivers"]);
  const d = drivers.find((x) => digits(x.phone) === phone);
  if (!d || d.active === false) return { d: null };
  if (code.length >= 32) {
    if (!d.sess || !safeEqual(await sha(code), d.sess)) return { d: null };
  } else {
    /* موبايل لسه بالكود القديم (قبل التحديث) — بنعدّيه بنفس القفل علشان محدش يجرّب أكواد */
    if (await drvLock(env, phone)) return { d: null, why: LOCK_MSG };
    await stampCode(env, d);
    if (!d.code || !codeLive(d) || !safeEqual(digits(code), String(d.code))) { await drvFail(env, phone); return { d: null }; }
  }
  if (d.hold) return { d: null, why: HOLD_MSG };
  const dev = devOf(req.headers.get("x-driver-device"));
  if (d.deviceId && dev !== d.deviceId) return { d: null, why: DEV_MSG };
  /* السواقين اللي كانوا داخلين قبل التحديث: أول موبايل يبعت طلب يتربط بالحساب */
  if (!d.deviceId && dev.length >= 8) { d.deviceId = dev; d.deviceAt = Date.now(); await putDoc(env, "drivers", d.id, d); }
  return { d };
}
async function getDriver(req, env) { return (await getDriverEx(req, env)).d; }
/* حقول السيرفر بس اللي بيكتبها — لو الإدارة حفظت نسخة قديمة من السائق مانمسحهاش. الإدارة بتمسحها بإنها تبعتها null */
const DRIVER_SERVER_KEYS = ["deviceId", "deviceAt", "pendingDevice", "hold", "impostorBy", "sess", "sessAt", "codeUsed"];

/* نظام الرصيد: السائق بيشحن رصيد كاش عند الإدارة/الوكيل، وكل مشوار بيخلص بيتخصم منه tripFee.
   مجاني لحد ما الإدارة تشغّله (creditOn) وييجي يوم البداية (creditFrom). لو الرصيد أقل من رسم مشوار — الطلبات بتوقف. */
const addDays = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
async function subCfg(env) {
  const p = (await getDoc(env, "config", "pricing")) || {};
  /* أوتوماتيك: كل مستخدم مجاني ١٢٠ يوم من يوم تسجيله، وبعدها الرصيد بيشتغل لوحده. الإدارة تقدر توقفه مؤقتاً (creditPaused) */
  return { on: p.creditOn === true, from: +p.creditOnAt || 0, freeDays: Number(p.freeDays) > 0 ? Number(p.freeDays) : FREE_DAYS, fee: Number(p.tripFee) > 0 ? Number(p.tripFee) : 1 };
}
const FREE_DAYS = 90;
const joinedOf = (d) => +(d.joinedAt || d.createdAt || 0) || Date.now();
/** حالة رصيد المستخدم (سائق أو راكب): free | ok | low | stopped */
function subState(d, c) {
  /* التطبيق مجاني للكل لحد ما الإدارة تشغّل الرصيد (creditOn). والـ ٩٠ يوم بتتحسب من يوم التشغيل، مش من يوم التسجيل */
  const freeTill = Math.max(joinedOf(d), c.from || 0) + c.freeDays * 864e5;
  if (!c.on || Date.now() < freeTill) return { state: "free" };
  const bal = +(d.credit || 0);
  if (bal < c.fee) return { state: "stopped", credit: bal, fee: c.fee };
  /* «اشحن قريب» بيظهر لما يفضل ٣ مشاوير أو أقل (أو ٥ ج — الأكبر) */
  return { state: bal <= Math.max(LOW_BAL, c.fee * 3) ? "low" : "ok", credit: bal, fee: c.fee, trips: Math.floor(bal / c.fee) };
}
/* رصيد الراكب: نفس النظام، والرسم بيتخصم من رصيده مش بيتضاف على الأجرة. المستند بيتحفظ بآخر ١٠ أرقام من الموبايل */
const riderKey = (p) => digits(p).slice(-10);
async function riderWallet(env, phone, c) {
  const k = riderKey(phone);
  let d = await getDoc(env, "riders", k);
  /* أول مرة نشوف الراكب ده = يوم تسجيله (بداية الـ ٣ شهور المجانية) */
  if (!d && k.length >= 9) { d = { id: k, phone: digits(phone), joinedAt: Date.now(), credit: 0 }; await putDoc(env, "riders", k, d); }
  return { doc: d || {}, ...subState(d || {}, c) };
}
const subActive = (d, c) => !c || subState(d, c).state !== "stopped";
const todayStr = () => new Date().toISOString().slice(0, 10);
/* التعليقات المختصرة: الكويسة بس بتظهر للركاب · والحمرا بتنبّه الإدارة لو اتكررت من راكبين مختلفين */
const GOOD_TAGS = ["سواقة هادية", "محترم", "وصل بسرعة", "التوكتوك نضيف"];
const RED_TAGS = ["مش محترم"];
const praiseOf = (d) => Object.entries(d.tagCount || {}).filter(([t, n]) => GOOD_TAGS.includes(t) && n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([t]) => t);
/* ترتيب السائق: متوسط التقييم + عدد التقييمات (علشان تقييم واحد ٣ نجوم مايظلمش سائق جديد) */
function tierOf(d) {
  const n = d.ratingCount || 0, avg = n ? d.ratingSum / n : 0;
  /* ٣ مستويات: عادي / فضي (٤٫٥ ★ و٣٠ تقييم) / ذهبي (٤٫٨ ★ و١٠٠ تقييم).
     متوسط متوازن: كأن كل سائق بادئ بـ ٥ تقييمات ٥ نجوم، علشان أول تقييم وحش مايظلمهوش.
     بلاغ «طلب أكتر من السعر» اتأكد في آخر ٣٠ يوم (فضي) / ٦٠ يوم (ذهبي) بيمنع المستوى. والإدارة تقدر تنزّله بإيدها. */
  const bal = (d.ratingSum + 25) / (n + 5), now = Date.now(), lastBad = d.lastConfirmedReport || 0;
  const cancels = d.releaseCount || 0, taken = (d.rideCount || n) + cancels, cancelRate = taken ? cancels / taken : 0;
  let t = "normal";
  if (n >= 100 && bal >= 4.8 && cancelRate < 0.05 && now - lastBad > 60 * 864e5) t = "gold";
  else if (n >= 30 && bal >= 4.5 && now - lastBad > 30 * 864e5) t = "silver";
  if (d.tierCap === "normal" || (d.tierCap === "silver" && t === "gold")) t = d.tierCap;
  return { rating: n ? +avg.toFixed(1) : null, ratingCount: n, tier: t };
}
/* وقت القاهرة — للمشاوير الثابتة */
function cairoNow() {
  const s = new Date().toLocaleString("sv-SE", { timeZone: "Africa/Cairo" });
  const asUtc = Date.parse(s.replace(" ", "T") + "Z");
  return { day: s.slice(0, 10), dow: new Date(asUtc).getUTCDay(), off: asUtc - Date.now() };
}
let repeatsRunAt = 0;
async function runRepeats(env) {
  if (Date.now() - repeatsRunAt < 60000) return;
  repeatsRunAt = Date.now();
  const { repeats } = await readDocs(env, ["repeats"]);
  const c = cairoNow();
  for (const rp of repeats || []) {
    if (rp.paused || rp.lastDay === c.day || rp.skipDay === c.day || !(rp.days || []).includes(c.dow)) continue;
    const at = Date.parse(c.day + "T" + rp.time + ":00Z") - c.off;
    const mins = (at - Date.now()) / 60000;
    /* تنبيه قبل الطلب بـ ١٠ دقايق: «هنطلبلك المشوار اليومي بعد ١٠ دقايق» — الراكب يلحق يوقفه لو مش محتاجه */
    if (mins > 55 && mins <= 66 && rp.warnDay !== c.day) {
      rp.warnDay = c.day; rp.warnAt = Date.now();
      await putDoc(env, "repeats", rp.id, rp);
      try { await pushTo(env, "rider", l10(rp.phone), { kind: "daily", title: "مشوارك اليومي " + rp.time, body: "هنطلبلك المشوار بعد ١٠ دقايق علشان السواق يوصلك في المعاد", url: "/", tag: "daily" }); } catch (e) {}
      continue;
    }
    if (mins < 21 || mins > 55) continue;
    rp.lastDay = c.day;
    /* سواق امبارح بياخد أولوية: أول ٣ دقايق الطلب بيظهرله هو بس (لو أونلاين وفاضي) */
    const res = await createRequest(env, { ...rp.body, scheduledAt: at, repeatId: rp.id, prefDriverId: rp.lastDriverId || "" }, "repeat");
    rp.current = res && res.ok ? { id: res.id, token: res.token, day: c.day } : null;
    await putDoc(env, "repeats", rp.id, rp);
  }
}

/** أقرب نقطة معروفة تحدد المنطقة — لا حاجة لحدود مرسومة */
function resolveLeg(places, o) {
  const lat = Number(o.lat), lng = Number(o.lng);
  if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  let near = null, bd = Infinity;
  for (const p of places) {
    if (p.lat == null || p.lng == null) continue;
    const dLat = (p.lat - lat) * 111320;
    const dLng = (p.lng - lng) * 111320 * Math.cos((lat * Math.PI) / 180);
    const d = Math.sqrt(dLat * dLat + dLng * dLng);
    if (d < bd) { bd = d; near = p; }
  }
  return {
    lat: +lat.toFixed(6), lng: +lng.toFixed(6),
    label: str(o.label, 120) || (near ? "جنب " + near.name : "موقع على الخريطة"),
    zoneId: near ? near.zoneId || "" : "",
    nearId: near ? near.id : "", nearMetres: near ? Math.round(bd) : null,
  };
}

/** ما يراه السائق قبل القبول: بلا اسم الراكب ولا رقمه */
const teaser = (r) => ({
  id: r.id, from: r.from, to: r.to, fare: r.fare, sameZone: r.sameZone, outside: Boolean(r.outside), distKm: r.distKm ?? null, perKm: r.perKm || null, multi: Boolean(r.multi), createdAt: r.createdAt, source: r.source || "app",
  scheduledAt: r.scheduledAt || null, forOther: Boolean(r.forOther),
});

/* الطلب المحجوز لبعدين بيظهر للسواقين قبل معاده بـ ١٥ دقيقة */
const LEAD_MS = 15 * 60 * 1000;
const openAt = (r) => (r.scheduledAt ? r.scheduledAt - LEAD_MS : r.createdAt || 0);
/* الطلب اللي رجع للسواقين (السائق سابه أو الراكب طلب سائق تاني) بياخد ١٠ دقايق جديدة */
const winAt = (r) => Math.max(openAt(r), r.reopenedAt || 0);
const PREF_MS = 3 * 60e3;  // المشوار اليومي: سواق امبارح بياخد أول ٣ دقايق لوحده
const PRIORITY_MS = 5000;   // سواقين المنطقة المفضّلة بيشوفوا الطلب قبل الباقي بـ ٥ ثواني
const URGENT_MS = 5 * 60e3, URGENT_M = 2000; // الراكب اللي مستني ٥ دقايق بيطلع فوق عند السواقين اللي في حدود ٢ كم
const REF_OFF = 5;          // خصم الدعوة
const refCode = (phone) => "M" + digits(phone).slice(-6);

const rideCode = () => String(1000 + (crypto.getRandomValues(new Uint16Array(1))[0] % 9000));
const tokOk = (given, real) => Boolean(real) && safeEqual(given, real);

/** إنشاء طلب — مشترك بين تطبيق الراكب وطلبات التليفون من الإدارة */

/* ===== تأكيد الرقم بكود على واتساب (WhatsApp Cloud API — رسالة Authentication) =====
   المتغيرات: WA_TOKEN + WA_PHONE_ID (+ WA_TEMPLATE اختياري، افتراضي mahatta_otp).
   لو مش موجودين ← التأكيد بيعدّي لوحده (التطبيق مايبوظش). */
const OTP_TTL = 10 * 60 * 1000, OTP_WAIT = 60 * 1000, OTP_DAY_MAX = 5, OTP_TRIES = 5;
const SESSION_TTL = 180 * 864e5;
const otpOn = (env) => Boolean(env.WA_TOKEN && env.WA_PHONE_ID);

/* ===== تأكيد عكسي على واتساب (Reverse OTP) — مش محتاج قالب ولا توثيق بيزنس =====
   الراكب بيبعت رسالة فيها كود من ٦ أرقام لرقم المحطة على واتساب، والـ Webhook بيتأكد إن الرقم اللي بعت هو نفس الرقم اللي اتكتب.
   المتغيرات: WA_VERIFY (كلمة سر تأكيد الـ Webhook، إنت بتختارها) + WA_APP_SECRET (App secret من Meta).
   اختياري: WA_NUMBER (افتراضي 201131207998)، و WA_TOKEN + WA_PHONE_ID علشان يرد على الراكب «تم التأكيد».
   لو الاتنين الأولانيين موجودين، ده بيشتغل بدل كود القالب. */
const ROTP_TTL = 15 * 60 * 1000;
const rotpOn = (env) => Boolean(env.WA_VERIFY && env.WA_APP_SECRET);
const verifyOn = (env) => rotpOn(env) || otpOn(env);
const waNumber = (env) => digits(env.WA_NUMBER || "201131207998");
const latinDigits = (t) => String(t || "").replace(/[\u0660-\u0669]/g, (d) => d.charCodeAt(0) - 0x660).replace(/[\u06F0-\u06F9]/g, (d) => d.charCodeAt(0) - 0x6F0);
async function hmacHex(secret, raw) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}
/** رد نصي جوه نافذة الـ ٢٤ ساعة (العميل هو اللي بدأ، فمش محتاج قالب). بيشتغل بس لو WA_TOKEN و WA_PHONE_ID موجودين */
async function waReply(env, to, text) {
  if (!(env.WA_TOKEN && env.WA_PHONE_ID)) return;
  try {
    await fetch("https://graph.facebook.com/v21.0/" + env.WA_PHONE_ID + "/messages", {
      method: "POST",
      headers: { authorization: "Bearer " + env.WA_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: digits(to), type: "text", text: { body: text } }),
    });
  } catch (e) {}
}
async function waWebhook(request, env) {
  const raw = await request.text();
  if (raw.length > 200000) return new Response("too large", { status: 413 });
  const sig = str(request.headers.get("x-hub-signature-256"), 100);
  if (!env.WA_APP_SECRET || !safeEqual(sig, "sha256=" + (await hmacHex(env.WA_APP_SECRET, raw)))) return new Response("bad signature", { status: 401 });
  let body = {};
  try { body = JSON.parse(raw); } catch (e) { return json({ ok: true }); }
  const now = Date.now();
  for (const en of body.entry || []) for (const ch of en.changes || []) {
    for (const m of (ch.value && ch.value.messages) || []) {
      const from = digits(m.from);
      const txt = latinDigits(m.type === "text" ? m.text && m.text.body : m.button ? m.button.text : "");
      const hit = txt.replace(/[\s-]/g, "").match(/\d{6}/);
      if (!hit) continue;
      const o = await getDoc(env, "rotp", hit[0]);
      if (!o || o.done || now - o.at > ROTP_TTL) { await waReply(env, from, "الكود ده خلص أو مش صحيح. ارجع للتطبيق ودوس «كود جديد»."); continue; }
      if (l10(from) === o.phone) {
        o.done = true; o.doneAt = now; o.wrong = false;
        await putDoc(env, "rotp", hit[0], o);
        await waReply(env, from, "✓ تم تأكيد رقمك في المحطة. ارجع للتطبيق وكمّل 🛺");
      } else {
        o.wrong = true;
        await putDoc(env, "rotp", hit[0], o);
        await waReply(env, from, "الرسالة دي اتبعتت من رقم غير الرقم اللي اتكتب في التطبيق. ابعتها من نفس الرقم.");
      }
    }
  }
  return json({ ok: true });
}
const l10 = (p) => digits(p).slice(-10);
const intl = (p) => { const d = digits(p); return d.startsWith("20") ? d : d.startsWith("0") ? "20" + d.slice(1) : "20" + d; };
const rnd = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => (b % 10)).join("");
const tok = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");

/* ===== ربط الأهل: الراكب بيضيف رقم، صاحب الرقم بيوافق من التطبيق، وبعدها بيوصله (ركب / وصل / طوارئ) ===== */
const famId = (rider, fam) => l10(rider) + "_" + l10(fam);
async function pushFam(env, riderPhone, item, onlyAuto) {
  if (!riderPhone) return 0;
  const { links } = await readDocs(env, ["links"]);
  const mine = (links || []).filter((k) => k.rider === l10(riderPhone) && k.status === "ok" && (!onlyAuto || k.auto !== false));
  for (const k of mine) {
    const box = (await getDoc(env, "famalerts", k.fam)) || { id: k.fam, items: [] };
    box.items = box.items.filter((x) => Date.now() - x.at < 864e5).concat([{ id: uid(), at: Date.now(), riderName: k.riderName || "", riderPhone: k.riderPhoneFull || "", ...item }]).slice(-20);
    await putDoc(env, "famalerts", k.fam, box);
    const who = k.riderName || "قريبك";
    const T = {
      sos: ["⚠ طوارئ من " + who, "محتاج مساعدة دلوقتي — دوس علشان تشوف مكانه"],
      start: [who + " ركب توكتوك", "دوس علشان تتابع الرحلة"],
      done: [who + " وصل بالسلامة ✓", ""],
    }[item.type] || ["المحطة", ""];
    await pushTo(env, "rider", k.fam, { kind: item.type === "sos" ? "sos" : "family", title: T[0], body: T[1], url: "/?fam=1", tag: "fam-" + k.rider });
  }
  return mine.length;
}

/* ===== Firebase Cloud Messaging (HTTP v1) — شغال بس لو FCM_SA متحط في Cloudflare ===== */
let FCM_TOK = null;
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uStr = (s) => b64u(new TextEncoder().encode(s));
function fcmSA(env) { try { return env.FCM_SA ? JSON.parse(env.FCM_SA) : null; } catch (e) { return null; } }
async function fcmAccess(sa) {
  if (FCM_TOK && FCM_TOK.exp > Date.now() + 60e3) return FCM_TOK.t;
  const now = Math.floor(Date.now() / 1000);
  const head = b64uStr(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64uStr(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(head + "." + body));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + head + "." + body + "." + b64u(sig),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("fcm auth");
  FCM_TOK = { t: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return FCM_TOK.t;
}
/** يبعت إشعار لصاحب الرقم ده (role: driver | rider). أي غلطة بتتتجاهل — الإشعار إضافة، ومش بيوقف الطلب */
async function pushTo(env, role, phone10, data) {
  const sa = fcmSA(env);
  if (!sa || !phone10) return false;
  try {
    const id = role + "_" + phone10;
    const p = await getDoc(env, "push", id);
    if (!p || !p.token) return false;
    const at = await fcmAccess(sa);
    const strs = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v ?? "")]));
    const r = await fetch("https://fcm.googleapis.com/v1/projects/" + sa.project_id + "/messages:send", {
      method: "POST", headers: { authorization: "Bearer " + at, "content-type": "application/json" },
      body: JSON.stringify({ message: { token: p.token, data: strs, android: { priority: "HIGH" }, webpush: { headers: { Urgency: "high", TTL: data.kind === "request" ? "120" : "600" } } } }),
    });
    if (r.status === 404 || r.status === 400) await env.DB.prepare("DELETE FROM docs WHERE kind=? AND id=?").bind("push", id).run();
    return r.ok;
  } catch (e) { return false; }
}
/* الطلب بيوصل الأول للتكاتك اللي في نص قطر ٥٠٠ متر من مكان الراكب.
   لو محدش قبل خلال دقيقة، الدايرة بتكبر لـ ١٫٥ كم، وبعد دقيقتين بيوصل لكل السواقين (علشان الطلب مايضيعش). */
const RADIUS_M = 500;
const RINGS = [[60e3, RADIUS_M], [120e3, 1500]];
const LOC_FRESH_MS = 3 * 60e3;
function meters(a, b) {
  const R = 6371e3, t = Math.PI / 180, dLat = (b.lat - a.lat) * t, dLng = (b.lng - a.lng) * t;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
/* أي طلب محدش أخده في ١٠ دقايق بيتلغي من السيرفر نفسه (مش مستني موبايل الراكب) */
async function expireStale(env, requests) {
  const now = Date.now(), stale = requests.filter((r) => r.status === "pending" && now - winAt(r) >= CLAIM_WINDOW_MS && now >= openAt(r));
  for (const r of stale.slice(0, 25)) {
    r.status = "cancelled"; r.cancelReason = "expired"; r.cancelledBy = "system"; r.cancelledAt = now;
    try { await putDoc(env, "requests", r.id, r); } catch (e) {}
  }
  return stale.length;
}
/* ===== أكتر من سائق يوافق، والراكب يختار =====
   السائق بيدوس «وافق» ← بيتضاف لـ offers. الراكب بيشوفهم مترتبين من الأقرب ويختار.
   لو الراكب مااختارش في دقيقة من أول موافقة، السيرفر بيختار الأقرب لوحده. */
const AUTO_PICK_MS = 60 * 1000;
/* كل موافقة سائق بتفضل ٣٠ ثانية بس. لو الراكب مااختارش، بتختفي من عنده والسائق بيشوف «الراكب ماردّش». مفيش اختيار أوتوماتيك */
const OFFER_TTL_MS = 30 * 1000;
const offerLive = (o, now) => now - (o.at || 0) < OFFER_TTL_MS;
/* بعد ما الموافقة تتلغي، الطلب بيختفي من عند السائق ٥ ثواني، وبعدين بيرجع يظهرله تاني لو لسه محدش أخده */
const REOFFER_MS = 5 * 1000;
const MAX_OFFERS = 8;
function liveOffers(r, drivers, busy) {
  const now = Date.now(), byId = new Map(drivers.map((d) => [d.id, d]));
  return (r.offers || []).map((o) => {
    const d = byId.get(o.d);
    if (!offerLive(o, now)) return null;
    if (!d || busy.has(d.id) || d.online === false || d.active === false || now - (d.lastSeen || 0) > 3 * 60e3) return null;
    const loc = d.loc && now - d.loc.at < LOC_FRESH_MS ? d.loc : null;
    const m = loc && r.from && isFinite(+r.from.lat) ? Math.round(meters(r.from, loc)) : o.distM;
    return { d, at: o.at, expiresAt: o.at + OFFER_TTL_MS, distM: m != null ? m : null, etaMin: m != null ? Math.max(1, Math.round((m * 1.3) / 250)) : null };
  }).filter(Boolean).sort((a, b) => (a.distM ?? 1e9) - (b.distM ?? 1e9) || a.at - b.at);
}
const busySet = (requests) => new Set(requests.filter((x) => x.status === "assigned" && x.driverId).map((x) => x.driverId));
/* التعيين ذرّي: أول تحديث يوصل والطلب لسه pending هو اللي بيكسب.
   وكمان السائق نفسه مايكونش اتعيّن لمشوار تاني في نفس اللحظة (راكبين اختاروه سوا) — الشرط جوه نفس الجملة */
const ASSIGN_SQL = `UPDATE docs SET data=?, updated=? WHERE kind='requests' AND id=? AND json_extract(data,'$.status')='pending'
  AND NOT EXISTS (SELECT 1 FROM docs AS o WHERE o.kind='requests' AND o.id<>? AND json_extract(o.data,'$.driverId')=? AND json_extract(o.data,'$.status')='assigned')`;
async function assignTo(env, r, d) {
  /* حسابات مراجعة جوجل معزولة: سائق تجريبي ماياخدش طلب حقيقي، والعكس — إلا في «فترة التجربة» */
  if (Boolean(d.reviewer) !== Boolean(r.review) && (await isolateOn(env))) return null;
  const next = { ...r, status: "assigned", driverId: d.id, assignedAt: Date.now() };
  const res = await env.DB.prepare(ASSIGN_SQL).bind(JSON.stringify(next), Date.now(), r.id, r.id, d.id).run();
  if (!res.meta || res.meta.changes !== 1) return null;
  try { await pushTo(env, "driver", l10(d.phone), { kind: "ride", title: "الراكب اختارك ✓", body: "روح للراكب — " + ((r.from && r.from.label) || ""), url: "/driver.html", tag: "ride-" + r.id }); } catch (e) {}
  try { await pushTo(env, "rider", l10(next.bookerPhone || next.riderPhone), { kind: "ride", title: d.name + " جاي ليك", body: "السعر " + next.fare + " ج — افتح علشان تشوفه على الخريطة", url: "/", tag: "ride-" + r.id }); } catch (e) {}
  return next;
}
async function autoPick(env, r, drivers, requests) {
  return null; /* اتشال: الراكب هو اللي بيختار دايماً */
  if (r.status !== "pending" || !(r.offers || []).length || Date.now() - r.offers[0].at < AUTO_PICK_MS) return null;
  const best = liveOffers(r, drivers, busySet(requests))[0];
  return best ? assignTo(env, r, best.d) : null;
}

function reachM(age) { for (const [ms, m] of RINGS) if (age < ms) return m; return Infinity; }
/** هل السائق ده جوه دايرة الطلب دلوقتي؟ age = بقاله قد إيه مفتوح */
function inReach(r, d, age) {
  const lim = reachM(age);
  if (lim === Infinity) return true;
  if (!r.from || !isFinite(+r.from.lat) || !isFinite(+r.from.lng)) return true;
  if (!d.loc || Date.now() - d.loc.at > LOC_FRESH_MS) return false;
  return meters(r.from, d.loc) <= lim;
}
/* طلب جديد: إشعار لكل سائق أونلاين مش في مشوار، وفي نص قطر ٥٠٠ متر من الراكب */
async function pushDrivers(env, r) {
  if (!fcmSA(env)) return;
  try {
    const { drivers, requests } = await readDocs(env, ["drivers", "requests"]);
    const busy = new Set(requests.filter((x) => x.status === "assigned").map((x) => x.driverId));
    /* نفس فصل حساب المراجعة: طلب حقيقي مايوصلش إشعاره لسائق المراجعة، والعكس */
    const iso = await isolateOn(env);
    const list = drivers.filter((d) => (!iso || Boolean(d.reviewer) === Boolean(r.review)) && d.active !== false && d.online !== false && !busy.has(d.id) && Date.now() - (d.lastSeen || 0) < 12 * 3600e3 && inReach(r, d, 0));
    const body = (r.from && r.from.label ? r.from.label : "") + " ← " + (r.to && r.to.label ? r.to.label : "") + " · " + r.fare + " ج";
    await Promise.all(list.map((d) => pushTo(env, "driver", l10(d.phone), { kind: "request", title: "طلب جديد · " + r.fare + " ج", body, url: "/driver.html", tag: "req" })));
  } catch (e) {}
}

async function newSession(env, phone, role) {
  const t = tok();
  await putDoc(env, "sessions", t, { phone: l10(phone), role, at: Date.now() });
  return t;
}
/** لو التأكيد شغال: لازم جلسة صحيحة لنفس الرقم. بيرجّع null لو تمام، أو رد خطأ */
async function needSession(request, env, phone, role) {
  if (!verifyOn(env)) return null;
  const t = str(request.headers.get("x-session"), 80);
  const s = t ? await getDoc(env, "sessions", t) : null;
  if (!s || s.role !== role || s.phone !== l10(phone) || Date.now() - s.at > SESSION_TTL)
    return json({ error: "أكّد رقمك الأول — دوس تاني", reverify: role }, 401);
  /* الدخول بيفضل محفوظ: كل ما يستخدم التطبيق المدة بتتجدد */
  if (Date.now() - s.at > 7 * 864e5) { s.at = Date.now(); await putDoc(env, "sessions", t, s); }
  return null;
}
async function sendOtp(env, phone, code) {
  const r = await fetch("https://graph.facebook.com/v21.0/" + env.WA_PHONE_ID + "/messages", {
    method: "POST",
    headers: { authorization: "Bearer " + env.WA_TOKEN, "content-type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp", to: intl(phone), type: "template",
      template: {
        name: env.WA_TEMPLATE || "mahatta_otp", language: { code: env.WA_LANG || "ar" },
        components: [
          { type: "body", parameters: [{ type: "text", text: code }] },
          { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] },
        ],
      },
    }),
  });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error((j.error && j.error.message) || "wa " + r.status); }
}

/* التسعير الموحّد: الكيلو بـ perKm (٨ ج) جوه وبرّه كفر صقر · أقل مشوار minFare (١٠ ج) · الإجمالي بيتقرّب لأعلى ٥ ج.
   المشوار المتعدد بالعدّاد: المسافة اللي اتمشت فعلاً + انتظار: freeMin دقايق ببلاش في كل وقفة، وبعدها waitPerMin لكل دقيقة كاملة، وأقصى وقفة maxWaitMin */
const PR = (c) => { c = c || {}; const n = (v, d) => (v === undefined || v === null || v === "" || !isFinite(+v) || +v < 0) ? d : +v;
  return { perKm: n(c.perKm, 8) || 8, minFare: n(c.minFare, 10), freeMin: n(c.freeMin, 3), waitPerMin: n(c.waitPerMin, 1), maxWaitMin: n(c.maxWaitMin, 15) || 15 }; };
const up5 = (x) => Math.ceil((x - 1e-9) / 5) * 5;
async function pricingCfg(env) { const { config } = await readDocs(env, ["config"]); return (config || []).find((c) => c.id === "pricing") || {}; }
/* أقرب طريق على الخريطة بين نقطتين (بالكيلو) — لو الخدمة مارديتش: null والحساب يرجع لخط مستقيم × ١٫٣ */
async function roadKm(a, b) {
  try {
    const u = "https://router.project-osrm.org/route/v1/driving/" + (+a.lng) + "," + (+a.lat) + ";" + (+b.lng) + "," + (+b.lat) + "?overview=false";
    const res = await fetch(u, { signal: AbortSignal.timeout(2500), cf: { cacheTtl: 86400 } });
    const j = await res.json(); const m = j && j.routes && j.routes[0] && j.routes[0].distance;
    return m > 0 ? m / 1000 : null;
  } catch (e) { return null; }
}
function meterView(r, pr, now) {
  const free = pr.freeMin * 60e3, max = pr.maxWaitMin * 60e3;
  const ws = (r.waits || []).concat(r.waitOn ? [{ s: r.waitOn.s, e: now }] : []);
  let paidMin = 0, freeMs = 0, totalMs = 0;
  ws.forEach((w) => { const d = Math.max(0, Math.min(w.e - w.s, max)); totalMs += d; freeMs += Math.min(d, free); paidMin += Math.floor(Math.max(0, d - free) / 60e3); });
  const km = +(((r.meter && r.meter.km) || 0)).toFixed(2), distCost = +(km * pr.perKm).toFixed(1), waitCost = paidMin * pr.waitPerMin, sum = +(distCost + waitCost).toFixed(1);
  return { km, distCost, paidMin, waitCost, freeSec: Math.round(freeMs / 1000), waitSec: Math.round(totalMs / 1000), stops: ws.length, sum, final: Math.max(pr.minFare, up5(sum)),
    waitOn: r.waitOn ? { s: r.waitOn.s } : null, weak: Boolean(r.meter && r.meter.weakAt && now - r.meter.weakAt < 20000), now, ...pr };
}

/* حساب مراجعة جوجل: رقم راكب تجريبي بيدخل من غير واتساب، وطلباته بتظهر لسائق المراجعة بس (مابتوصلش لسواقين حقيقيين) */
async function isReview(env, phone) {
  const p = l10(phone); if (p.length < 10) return false;
  const c = await getDoc(env, "config", "review");
  return Boolean(c && c.on !== false && c.bypass !== false && c.riderPhone && l10(c.riderPhone) === p);
}
/* «فترة التجربة»: لو العزل مقفول، سائق المراجعة بيشوف الطلبات الحقيقية وبيظهر للركاب، وطلبات راكب المراجعة بتوصل لكل السواقين */
const ISO_OFF_MS = 7 * 864e5;
async function isolateOn(env) {
  const c = await getDoc(env, "config", "review");
  if (!c || c.isolate !== false) return true;
  /* فترة التجربة بتقفل لوحدها بعد ٧ أيام علشان ماتتنسيش مفتوحة */
  return Boolean(c.isoOffAt && Date.now() - c.isoOffAt > ISO_OFF_MS);
}
async function isReviewOld(env, phone) {
  const p = l10(phone); if (p.length < 10) return false;
  const c = await getDoc(env, "config", "review");
  return Boolean(c && c.on !== false && l10(c.riderPhone) === p);
}
/* أرشيف الإدارة: لما حد يحذف حسابه، سجل رحلاته وبياناته الأساسية بتتحفظ هنا سنة (الأمان والشكاوى وتسجيل التكاتك)،
   وبعدها بتتمسح لوحدها. البورتال بس اللي بيشوفه */
const ARCH_MS = 365 * 864e5;
async function archive(env, role, phone, data) {
  const id = role + "_" + l10(phone) + "_" + Date.now().toString(36);
  await putDoc(env, "archive", id, { id, role, phone: l10(phone), at: Date.now(), exp: Date.now() + ARCH_MS, ...data });
}
let archPurgedAt = 0;
async function purgeArchive(env) {
  if (Date.now() - archPurgedAt < 36e5) return;
  archPurgedAt = Date.now();
  /* مسح دوري: الأرشيف اللي خلصت سنته، والشات بعد ٢٤ ساعة (زي سياسة الخصوصية)، ومفاتيح الطلبات والعدّادات القديمة */
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a).run().catch(() => {});
  await q("DELETE FROM docs WHERE kind='archive' AND json_extract(data,'$.exp')<?", Date.now());
  await q("DELETE FROM docs WHERE kind='chat' AND updated<?", Date.now() - 864e5);
  await q("DELETE FROM docs WHERE kind IN ('rl','reqkey') AND updated<?", Date.now() - 2 * 864e5);
}
/* اللي بيتحفظ في الأرشيف بس (زي ما سياسة الخصوصية بتقول): مفيش أكواد ولا جلسات ولا بيانات الجهاز.
   مقصود يفضل: رقم التليفون والاسم (الشكاوى)، وللسائق الرقم القومي والرخصة ورقم التوكتوك (تسجيل التكاتك) — سنة وبعدين يتمسح */
const pickKeys = (o, ks) => Object.fromEntries(ks.filter((k) => o && o[k] !== undefined).map((k) => [k, o[k]]));
const ARCH_RIDE = (r) => ({ ...pickKeys(r, ["id", "createdAt", "startedAt", "finishedAt", "cancelledAt", "status", "cancelReason", "fare", "driverId", "riderName", "riderPhone", "bookerPhone", "rating", "multi", "outside"]), from: r.from && r.from.label, to: r.to && r.to.label });
const ARCH_REPORT = (x) => pickKeys(x, ["id", "kind", "status", "note", "fare", "asked", "driverId", "requestId", "createdAt", "closedAt"]);
const ARCH_DRIVER = (d) => pickKeys(d, ["id", "name", "phone", "plate", "licence", "licExpiry", "nid", "owner", "village", "createdAt", "joinedAt", "rideCount", "releaseCount", "ratingSum", "ratingCount"]);
/* حذف حساب السائق: بياناته ورحلاته بتروح للأرشيف، وبعدين كارت السائق والإشعارات والجلسة بيتمسحوا */
async function wipeDriver(env, d) {
  const p10 = l10(d.phone);
  const { requests, consents } = await readDocs(env, ["requests", "consents"]);
  const mine = requests.filter((r) => r.driverId === d.id);
  if (mine.some((r) => r.status === "assigned")) return { error: "في مشوار شغال — خلّصه الأول", status: 409 };
  const { reports } = await readDocs(env, ["reports"]);
  const aid = "driver_" + p10 + "_" + Date.now().toString(36);
  /* كله مرة واحدة: الأرشيف + المسح. لو أي خطوة فشلت مفيش حاجة بتتغيّر */
  await env.DB.batch([
    putSt(env, "archive", aid, { id: aid, role: "driver", phone: p10, at: Date.now(), exp: Date.now() + ARCH_MS, name: d.name || "", driver: ARCH_DRIVER(d),
      rides: mine.slice(-500).map(ARCH_RIDE).map(({ riderPhone, bookerPhone, ...x }) => x),
      reports: (reports || []).filter((x) => x.driverId === d.id).map(ARCH_REPORT) }),
    delSt(env, "drivers", d.id), delSt(env, "push", "driver_" + p10), delSt(env, "loginfail", "drv-" + digits(d.phone)),
    ...(consents || []).filter((c) => c.role === "driver" && l10(c.phone) === p10).map((c) => putSt(env, "consents", c.id, { ...c, phone: "", name: "", deletedAt: Date.now() })),
  ]);
  return { ok: true, rides: mine.length };
}

async function createRequest(env, b, source) {
  const name = str(b.riderName, 60);
  const phone = digits(b.riderPhone).slice(0, 15);
  if (!name || phone.length < 9) return { error: "الاسم ورقم الموبايل مطلوبان", status: 400 };

  const { places, config, zones = [] } = await readDocs(env, PUBLIC_KINDS);
  const cfg = config.find((c) => c.id === "pricing") || { same: 10, cross: 15 };

  const pick = (idKey, objKey) => {
    const pid = str(b[idKey], 40);
    if (pid) {
      const p = places.find((x) => x.id === pid);
      return p ? { lat: p.lat, lng: p.lng, label: p.name, zoneId: p.zoneId || "", nearId: p.id, nearMetres: 0 } : null;
    }
    return b[objKey] && typeof b[objKey] === "object" ? resolveLeg(places, b[objKey]) : null;
  };
  const from = pick("fromId", "from");
  const to = pick("toId", "to");
  const multi = Boolean(b.multi);
  const to2 = to || (multi ? { label: "مشوار متعدد — هيقول للسواق", lat: null, lng: null, zoneId: "" } : null);
  if (!from || !to2) return { error: "حدّد مكان الركوب والوجهة", status: 400 };
  const pr = PR(cfg);

  /* السعر يُحسب هنا فقط — لا يُقرأ من العميل */
  /* بالمسافة على الشارع × سعر الكيلو، مقرّب لأعلى ٥ ج، وأقل أجرة minFare. مكان من غير إحداثيات = أقل أجرة */
  const hasXY = (p) => p && p.lat != null && p.lng != null && isFinite(+p.lat) && isFinite(+p.lng);
  let same, fare, distKm = null, roadKmV = null;
  const outside = false, perKm = pr.perKm;
  if (multi) { same = false; fare = pr.minFare; }
  else if (hasXY(from) && hasXY(to2)) {
    roadKmV = await roadKm(from, to2);
    distKm = roadKmV != null ? Math.round(roadKmV * 10) / 10 : Math.round(meters({ lat: +from.lat, lng: +from.lng }, { lat: +to2.lat, lng: +to2.lng }) * 1.3 / 100) / 10;
    fare = Math.max(pr.minFare, up5(distKm * pr.perKm)); same = distKm <= 2;
  } else {
    /* مكان من غير إحداثيات: أقل أجرة (التسعير الموحّد بس — مفيش أسعار مناطق) */
    same = true; fare = pr.minFare;
  }
  const now = Date.now();

  /* احجز لبعدين: من ٢٠ دقيقة لحد ٧ أيام */
  let scheduledAt = null;
  if (b.scheduledAt) {
    const t = Number(b.scheduledAt);
    if (!isFinite(t) || t < now + 20 * 60000 || t > now + 7 * 864e5) return { error: "المعاد لازم يكون بعد ٢٠ دقيقة على الأقل وخلال أسبوع", status: 400 };
    scheduledAt = Math.round(t);
  }

  /* ادعي صاحبك: خصم ٥ ج لأول رحلة للمدعو، و٥ ج للي دعاه في رحلته الجاية. الإدارة بتعوّض السائق. */
  let refBy = "", refDiscount = 0;
  /* «ادعي صاحبك» (خصم ٥ ج) اتلغى — المشاركة بقت لينك التطبيق بس */
  if (false && source === "app") {
    const { requests } = await readDocs(env, ["requests"]);
    const mine = requests.filter((r) => r.riderPhone === phone);
    const ref = str(b.ref, 12).toUpperCase();
    if (ref && ref !== refCode(phone) && !mine.length) {
      const inviter = requests.find((r) => refCode(r.riderPhone) === ref);
      if (inviter) { refBy = inviter.riderPhone; refDiscount = REF_OFF; }
    }
    if (!refDiscount) {
      const earned = requests.filter((r) => r.refBy === phone && r.status === "done").length;
      const used = mine.filter((r) => r.refCredit && r.status !== "cancelled").length;
      if (earned > used) refDiscount = REF_OFF;
    }
  }
  /* نظام الرصيد للراكب: لو شغال ورصيده أقل من رسم المشوار، مايقدرش يطلب من التطبيق (طلب التليفون من الإدارة بيعدّي) */
  if (source === "app") {
    const sc = await subCfg(env);
    const w = await riderWallet(env, b.forOther ? digits(b.bookerPhone) : phone, sc);
    if (w.state === "stopped") return { error: "رصيدك خلص — اشحن من الإدارة أو الوكيل علشان تطلب", status: 403 };
  }
  const discount = Math.min(refDiscount, fare - 5 > 0 ? refDiscount : 0);
  fare -= discount;

  const rv = await isReview(env, b.forOther ? b.bookerPhone : phone);
  const id = uid(), tok = newToken(), share = newToken().slice(0, 12);
  await putDoc(env, "requests", id, {
    id, token: tok, shareToken: share, code: rideCode(), source, reqKey: str(b.reqKey, 40), review: rv,
    riderName: name, riderPhone: phone, note: str(b.note, 140), from, to: to2, multi, ip: str(b.__ip, 64),
    fare, sameZone: same, distKm, roadKm: roadKmV != null, outside, perKm, status: "pending", driverId: "",
    createdAt: now, day: todayStr(), scheduledAt,
    forOther: Boolean(b.forOther), bookerPhone: b.forOther ? digits(b.bookerPhone).slice(0, 15) : "",
    discount, refBy: discount && refBy ? refBy : "", refCredit: Boolean(discount && !refBy),
    repeatId: source === "repeat" ? str(b.repeatId, 40) : "", prefDriver: source === "repeat" ? str(b.prefDriverId, 40) : "",
  });
  if (!scheduledAt || scheduledAt - now < 15 * 60e3) await pushDrivers(env, { from, to: to2, fare: multi ? "بالعدّاد" : fare, review: rv });
  return { ok: true, id, token: tok, shareToken: share, fare, multi, sameZone: same, distKm, outside, perKm, discount, scheduledAt, refCode: refCode(phone) };
}

/* لو النت فصل والطلب اتبعت تاني بنفس المفتاح: بنرجّع نفس الطلب بدل ما نعمل واحد جديد */
async function dupReq(env, key) {
  key = str(key, 40);
  if (key.length < 12) return null;
  const row = await env.DB.prepare("SELECT data FROM docs WHERE kind='requests' AND json_extract(data,'$.reqKey')=? LIMIT 1").bind(key).first();
  if (!row) return null;
  const r = JSON.parse(row.data);
  return { ok: true, id: r.id, token: r.token, shareToken: r.shareToken, fare: r.fare, multi: Boolean(r.multi), sameZone: r.sameZone, distKm: r.distKm, outside: r.outside, perKm: r.perKm, discount: r.discount || 0, scheduledAt: r.scheduledAt || null, refCode: refCode(r.riderPhone), dup: true };
}
/* المفتاح بيتحجز في قاعدة البيانات الأول (مرة واحدة بس) — لو طلبين وصلوا في نفس اللحظة، واحد بس بيعدّي */
/* لو النت فصل والطلب اتبعت تاني: المفتاح بيتحجز بعد ما البيانات تعدّي، ولو الطلب فشل المفتاح بيتفكّ */
async function reserveKey(env, key) {
  key = str(key, 40);
  if (key.length < 12) return null;
  const res = await env.DB.prepare("INSERT OR IGNORE INTO docs (kind,id,data,updated) VALUES ('reqkey',?,'{}',?)").bind(key, Date.now()).run();
  if (res.meta && res.meta.changes === 1) return null;
  await new Promise((ok) => setTimeout(ok, 1500));
  return (await dupReq(env, key)) || { error: "طلبك بيتبعت — استنى ثانية", status: 409 };
}
const releaseKey = (env, key) => env.DB.prepare("DELETE FROM docs WHERE kind='reqkey' AND id=?").bind(str(key, 40)).run().catch(() => {});
async function createOnce(env, b, source) {
  const held = await reserveKey(env, b.reqKey);
  if (held) return held;
  let out;
  try { out = await createRequest(env, b, source); } catch (e) { await releaseKey(env, b.reqKey); throw e; }
  if (out.error) await releaseKey(env, b.reqKey);
  return out;
}
async function onceReq(env, key) {
  key = str(key, 40);
  if (key.length < 12) return null;
  return await dupReq(env, key);
}
/* حد بسيط لعدد الطلبات في الدقيقة (مفتاح لكل جلسة أو IP) */
async function rateOk(env, key, max) {
  const id = key + ":" + Math.floor(Date.now() / 6e4);
  await env.DB.prepare("INSERT INTO docs (kind,id,data,updated) VALUES ('rl',?,'1',?) ON CONFLICT(kind,id) DO UPDATE SET data=CAST(data AS INTEGER)+1").bind(id, Date.now()).run();
  const row = await env.DB.prepare("SELECT data FROM docs WHERE kind='rl' AND id=?").bind(id).first();
  if (Math.random() < 0.02) { try { await env.DB.prepare("DELETE FROM docs WHERE kind IN ('rl','reqkey') AND updated<?").bind(Date.now() - 2 * 864e5).run(); } catch (e) {} }
  return +(row && row.data) <= max;
}
/* تحديث مشروط: بيكتب بس لو حالة الطلب لسه زي ما قريناها — علشان دوستين ورا بعض مايتحسبوش مرتين */
async function casReq(env, r, next) {
  const res = await env.DB.prepare("UPDATE docs SET data=?, updated=? WHERE kind='requests' AND id=? AND json_extract(data,'$.status')=? AND IFNULL(json_extract(data,'$.startedAt'),0)=?")
    .bind(JSON.stringify(next), Date.now(), r.id, r.status, r.startedAt || 0).run();
  return Boolean(res.meta && res.meta.changes === 1);
}

/* حذف كل بيانات الراكب: الرحلات (بتفضل من غير اسم ولا رقم علشان الحسابات)، الشات، الرصيد، المشاوير الثابتة،
   ربط الأهل، الإشعارات، الجلسات، البلاغات. سجل الموافقة على الشروط بيفضل من غير الرقم (إثبات إن الشروط اتوافق عليها) */
async function wipeRider(env, phone, mineR) {
  const p10 = l10(phone), st = [];
  const { links, repeats, reports, consents } = await readDocs(env, ["links", "repeats", "reports", "consents"]);
  const myReports = (reports || []).filter((x) => l10(x.phone) === p10 || l10(x.riderPhone) === p10);
  /* الأرشيف الأول، وبعده المسح — وكله جوه batch واحد: يا يتنفّذ كله يا مايتنفّذش خالص */
  const aid = "rider_" + p10 + "_" + Date.now().toString(36);
  st.push(putSt(env, "archive", aid, { id: aid, role: "rider", phone: p10, at: Date.now(), exp: Date.now() + ARCH_MS,
    name: (mineR.find((r) => r.riderName) || {}).riderName || "", rides: mineR.slice(-500).map(ARCH_RIDE), reports: myReports.map(ARCH_REPORT) }));
  for (const r of mineR) {
    const open = r.status === "pending" || r.status === "assigned";
    st.push(putSt(env, "requests", r.id, { ...r, riderName: "(محذوف)", riderPhone: "", note: "", bookerPhone: "", ip: "", token: newToken(), shareToken: "", reqKey: "", from: r.from && { label: r.from.label, zoneId: r.from.zoneId }, to: r.to && { label: r.to.label, zoneId: r.to.zoneId }, ...(open ? { status: "cancelled", cancelledBy: "rider", cancelReason: "deleted", cancelledAt: Date.now() } : {}) }));
    st.push(delSt(env, "chat", r.id));
  }
  /* تنبيهات الأهل: صندوقه هو (لو كان مربوط كـ «أهل»)، وأي تنبيه عنه عند أهله */
  st.push(delSt(env, "famalerts", p10));
  for (const k of (links || []).filter((k) => l10(k.rider) === p10)) {
    const box = await getDoc(env, "famalerts", k.fam);
    if (box && Array.isArray(box.items)) st.push(putSt(env, "famalerts", k.fam, { ...box, items: box.items.filter((x) => l10(x.riderPhone) !== p10) }));
  }
  st.push(delSt(env, "riders", p10), delSt(env, "push", "rider_" + p10));
  (links || []).filter((k) => l10(k.rider) === p10 || l10(k.fam) === p10).forEach((k) => st.push(delSt(env, "links", k.id)));
  (repeats || []).filter((x) => l10(x.phone) === p10).forEach((x) => st.push(delSt(env, "repeats", x.id)));
  st.push(env.DB.prepare("DELETE FROM docs WHERE kind='sessions' AND json_extract(data,'$.phone')=? AND json_extract(data,'$.role')='rider'").bind(p10));
  myReports.forEach((x) => st.push(putSt(env, "reports", x.id, { ...x, phone: "", riderPhone: "", riderName: "(محذوف)", name: "(محذوف)", note: x.deleteReq ? "طلب حذف — اتنفذ" : "(اتحذف بطلب صاحبه)", status: "closed", closedAt: Date.now() })));
  (consents || []).filter((c) => l10(c.phone) === p10).forEach((c) => st.push(putSt(env, "consents", c.id, { ...c, phone: "", name: "", deletedAt: Date.now() })));
  await env.DB.batch(st);
  return { cleared: mineR.length };
}

export async function onRequest({ request, env, params }) {
  const parts = Array.isArray(params.path) ? params.path : [params.path].filter(Boolean);
  const [route, sub, third] = parts;
  const method = request.method;
  const url = new URL(request.url);
  if (!env.DB) return json({ error: "قاعدة البيانات غير مربوطة (binding: DB)" }, 500);

  try {
    /* ================= عام ================= */

    if (route === "public" && method === "GET") {
      const pub = await readDocs(env, PUBLIC_KINDS);
      try { await purgeArchive(env); } catch (e) {}
      /* إعدادات حساب المراجعة مابتطلعش للتطبيق خالص */
      pub.config = (pub.config || []).filter((c) => c.id !== "review");
      /* الأماكن اللي اتحددت تلقائياً وطلعت بعيد عن البلد (أكتر من ٤ كم) مابتظهرش للراكب لحد ما الإدارة تراجعها */
      if (Array.isArray(pub.places)) {
        const C = { lat: 30.7964, lng: 31.6261 };
        pub.places = pub.places.filter((p) => !p.auto || p.lat == null || meters(C, { lat: +p.lat, lng: +p.lng }) <= 4000);
      }
      return json(pub);
    }

    /* طلب انضمام سائق جديد — بيوصل للإدارة (اسم + رقم بس) */
    if (route === "join" && method === "POST") {
      const b = await parseBody(request);
      const name = str(b.name, 60).trim(), phone = digits(b.phone);
      if (name.length < 3) return json({ error: "اكتب اسمك كامل" }, 400);
      if (!/^01[0125]\d{8}$/.test(phone)) return json({ error: "رقم الموبايل لازم يكون ١١ رقم ويبدأ بـ 01" }, 400);
      const ip = str(request.headers.get("CF-Connecting-IP"), 64);
      const { drivers, joins } = await readDocs(env, ["drivers", "joins"]);
      if (drivers.some((d) => l10(d.phone) === l10(phone))) return json({ error: "الرقم ده متسجّل كسائق — ادخل بالكود بتاعك" }, 409);
      if (joins.some((j) => l10(j.phone) === l10(phone) && j.status !== "rejected")) return json({ error: "طلبك وصل قبل كده — الإدارة هتكلمك" }, 409);
      if (ip && joins.filter((j) => j.ip === ip && Date.now() - (j.createdAt || 0) < 3600e3).length >= 3) return json({ error: "طلبات كتير — جرّب بعد ساعة" }, 429);
      const id = uid();
      await putDoc(env, "joins", id, { id, name, phone, ip, status: "new", createdAt: Date.now() });
      return json({ ok: true });
    }

    /* سجل الموافقة على الشروط — دليل إن المستخدم وافق (إمتى، وعلى أنهي إصدار، ومن أنهي جهاز) */
    if (route === "consent" && method === "POST") {
      const b = await parseBody(request);
      const role = b.role === "driver" ? "driver" : "rider";
      const v = str(b.v, 10), device = str(b.device, 40).replace(/[^\w-]/g, "");
      if (!v || device.length < 8) return json({ error: "بيانات ناقصة" }, 400);
      const id = role + "-" + device + "-" + v;
      const old = (await getDoc(env, "consents", id)) || {};
      const phone = digits(b.phone).slice(0, 15) || old.phone || "";
      await putDoc(env, "consents", id, {
        id, role, v, device, phone, text: old.text || str(b.text, 600),
        acceptedAt: old.acceptedAt || str(b.at, 40), serverAt: old.serverAt || Date.now(),
        linkedAt: phone && !old.phone ? Date.now() : (old.linkedAt || 0),
        ip: old.ip || str(request.headers.get("cf-connecting-ip"), 64), ua: old.ua || str(request.headers.get("user-agent"), 200),
      });
      return json({ ok: true });
    }

    if (route === "otp" && sub === "start" && method === "POST") {
      const b = await parseBody(request);
      const phone = digits(b.phone), role = "rider";
      if (phone.length < 10) return json({ error: "رقم الموبايل مش صحيح" }, 400);
      if (await isReview(env, phone)) return json({ skip: true, token: await newSession(env, phone, role) });
      if (!verifyOn(env)) return json({ skip: true, token: await newSession(env, phone, role) });
      const now = Date.now(), key = l10(phone);
      const log = (await getDoc(env, "otplog", key)) || { sends: [] };
      log.sends = log.sends.filter((t) => now - t < 864e5);
      const lastAt = log.sends[log.sends.length - 1] || 0;
      if (now - lastAt < OTP_WAIT) return json({ error: "استنى دقيقة وجرّب تاني" }, 429);
      if (log.sends.length >= OTP_DAY_MAX) return json({ error: "وصلت لآخر عدد أكواد النهارده — جرّب بكرة أو كلّم الإدارة" }, 429);
      if (rotpOn(env)) {
        let code = "";
        for (let i = 0; i < 6 && !code; i++) {
          const c = rnd(6), old = await getDoc(env, "rotp", c);
          if (!old || old.done || now - old.at > ROTP_TTL) code = c;
        }
        if (!code) return json({ error: "حصلت مشكلة — جرّب تاني" }, 503);
        const id = tok().slice(0, 20);
        await putDoc(env, "rotp", code, { code, id, phone: key, role, at: now, done: false });
        log.sends.push(now);
        await putDoc(env, "otplog", key, log);
        const text = "كود تأكيد المحطة: " + code;
        return json({ mode: "wa", id, code, to: waNumber(env), wa: "https://wa.me/" + waNumber(env) + "?text=" + encodeURIComponent(text), ttl: ROTP_TTL / 1000, wait: OTP_WAIT / 1000 });
      }
      const code = rnd(6), id = tok().slice(0, 20);
      try { await sendOtp(env, phone, code); }
      catch (e) { return json({ error: "ماقدرناش نبعت الكود — اتأكد إن الرقم عليه واتساب", detail: String(e.message).slice(0, 200) }, 502); }
      log.sends.push(now);
      await putDoc(env, "otplog", key, log);
      await putDoc(env, "otp", id, { phone: key, role, code, at: now, tries: 0 });
      return json({ id, wait: OTP_WAIT / 1000 });
    }

    if (route === "otp" && sub === "check" && method === "POST") {
      const b = await parseBody(request);
      const code = digits(b.code).slice(0, 6), o = code.length === 6 ? await getDoc(env, "rotp", code) : null;
      if (!o || !safeEqual(str(b.id, 40), o.id)) return json({ error: "الكود ده مش موجود — دوس «كود جديد»" }, 400);
      if (!o.done) {
        if (Date.now() - o.at > ROTP_TTL) return json({ error: "الكود خلص — دوس «كود جديد»" }, 400);
        return json({ pending: true, wrong: Boolean(o.wrong) });
      }
      if (!o.token) { o.token = await newSession(env, o.phone, o.role); await putDoc(env, "rotp", code, o); }
      return json({ token: o.token });
    }

    /* Webhook واتساب (Meta): GET للتأكيد وقت الإعداد، و POST للرسايل الجاية */
    if (route === "wa" && sub === "webhook") {
      if (method === "GET") {
        const ok = url.searchParams.get("hub.mode") === "subscribe" && env.WA_VERIFY && safeEqual(url.searchParams.get("hub.verify_token"), env.WA_VERIFY);
        return ok ? new Response(url.searchParams.get("hub.challenge") || "", { status: 200, headers: { "content-type": "text/plain" } }) : new Response("forbidden", { status: 403 });
      }
      if (method === "POST") return await waWebhook(request, env);
    }

    if (route === "otp" && sub === "verify" && method === "POST") {
      const b = await parseBody(request);
      const id = str(b.id, 40), o = id ? await getDoc(env, "otp", id) : null;
      if (!o || o.used || Date.now() - o.at > OTP_TTL) return json({ error: "الكود خلص — دوس «ابعت تاني»" }, 400);
      if (o.tries >= OTP_TRIES) return json({ error: "جرّبت كتير — دوس «ابعت تاني»" }, 429);
      if (!safeEqual(digits(b.code), o.code)) {
        o.tries++; await putDoc(env, "otp", id, o);
        return json({ error: "الكود غلط — فاضللك " + (OTP_TRIES - o.tries) + " محاولات" }, 400);
      }
      o.used = true; await putDoc(env, "otp", id, o);
      return json({ token: await newSession(env, o.phone, o.role) });
    }

    if (route === "request" && method === "POST") {
      const b = await parseBody(request);
      const deny = await needSession(request, env, b.forOther && b.bookerPhone ? b.bookerPhone : b.riderPhone, "rider");
      if (deny) return deny;
      const again = await onceReq(env, b.reqKey);
      if (again) return again.error ? json({ error: again.error }, again.status) : json(again);
      /* ضد الطلبات الوهمية: ٣ طلبات مفتوحة بالكتير لكل رقم، وطلب واحد كل دقيقة من نفس الرقم أو الموبايل */
      const ip = str(request.headers.get("CF-Connecting-IP"), 64);
      const rp = digits(b.riderPhone).slice(0, 15);
      const { requests: allR } = await readDocs(env, ["requests"]);
      if (allR.filter((r) => r.riderPhone === rp && (r.status === "pending" || r.status === "assigned")).length >= 3)
        return json({ error: "عندك ٣ طلبات مفتوحة — استنى أو الغي واحد الأول" }, 429);
      /* شبكات الموبايل في مصر بتدّي ناس كتير نفس الـ IP، فالحد على الـ IP بس لو ٤ طلبات في الدقيقة */
      if (allR.some((r) => r.riderPhone === rp && Date.now() - (r.createdAt || 0) < 60000)
        || (ip && allR.filter((r) => r.ip === ip && Date.now() - (r.createdAt || 0) < 60000).length >= 4))
        return json({ error: "استنى دقيقة قبل ما تطلب تاني" }, 429);
      b.__ip = ip;
      const out = await createOnce(env, b, "app");
      return out.error ? json({ error: out.error }, out.status) : json(out);
    }

    /* التكاتك القريبة للراكب: أونلاين + فاضية + مكانها وصل من دقيقتين. المكان تقريبي (~١٠٠ م) ومن غير أي اسم أو رقم */
    if (route === "nearby" && method === "GET") {
      /* للركاب المسجّلين بس (لما التأكيد شغال)، وبحد ٣٠ مرة في الدقيقة — علشان محدش يتتبّع السواقين */
      const st = str(request.headers.get("x-session"), 80);
      const s = st ? await getDoc(env, "sessions", st) : null;
      if (verifyOn(env) && (!s || s.role !== "rider" || Date.now() - s.at > SESSION_TTL)) return json({ count: 0, near: 0, nearestM: null, drivers: [] });
      if (!(await rateOk(env, "nb-" + (st ? st.slice(0, 16) : str(request.headers.get("CF-Connecting-IP") || "x", 64)), 30))) return json({ error: "استنى شوية" }, 429);
      const lat = +url.searchParams.get("lat"), lng = +url.searchParams.get("lng");
      const { drivers, requests } = await readDocs(env, ["drivers", "requests"]);
      const busy = new Set(requests.filter((r) => r.status === "assigned" && r.driverId).map((r) => r.driverId));
      const now = Date.now(), hour = Math.floor(now / 36e5);
      const hash = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) | 0; return h; };
      const isoN = await isolateOn(env);
      /* راكب المراجعة بيشوف سائق المراجعة بس، والراكب الحقيقي مابيشوفهوش */
      const rvMe = Boolean(isoN && s && s.role === "rider" && (await isReview(env, s.phone)));
      const out = drivers.filter((d) => (!isoN || (rvMe ? Boolean(d.reviewer) : !d.reviewer)) && d.active !== false && d.online !== false && d.lastSeen && now - d.lastSeen < ONLINE_MS && d.loc && now - d.loc.at < 2 * 60 * 1000 && !busy.has(d.id))
        .map((d) => {
          const h = hash(d.id + ":" + hour), ox = ((h & 0xff) / 255 - 0.5) * 0.0018, oy = (((h >> 8) & 0xff) / 255 - 0.5) * 0.0018;
          return { k: (hash(d.id) >>> 0).toString(36), lat: +(d.loc.lat + oy).toFixed(5), lng: +(d.loc.lng + ox).toFixed(5), h: d.loc.h };
        })
        .filter((p) => !isFinite(lat) || !isFinite(lng) || (Math.abs(p.lat - lat) < 0.05 && Math.abs(p.lng - lng) < 0.05))
        .slice(0, 25);
      /* قريب = في نص كيلو (نفس أول دايرة بيوصلها الطلب). غير كده بنقول أقرب واحد على بعد كام */
      const ds = isFinite(lat) && isFinite(lng) ? out.map((p) => meters({ lat, lng }, p)) : [];
      const near = ds.length ? ds.filter((m) => m <= RADIUS_M).length : out.length;
      const nearestM = ds.length ? Math.round(Math.min(...ds)) : null;
      return json({ count: out.length, near, nearestM, drivers: out });
    }

    /* متابعة الراكب — بيانات السائق تظهر فقط بعد ما يَقبل */
    if (route === "track" && sub && method === "GET") {
      const r = await getDoc(env, "requests", str(sub, 40));
      if (!r) return json({ error: "طلب غير موجود" }, 404);
      if (!r.token || !safeEqual(url.searchParams.get("token"), r.token))
        return json({ error: "غير مصرّح" }, 401);
      if (r.status === "pending" && Date.now() - winAt(r) >= CLAIM_WINDOW_MS) {
        r.status = "cancelled"; r.cancelReason = "expired"; r.cancelledBy = "system"; r.cancelledAt = Date.now();
        await putDoc(env, "requests", r.id, r);
      }
      let offers = [], autoAt = null;
      if (r.status === "pending" && (r.offers || []).length) {
        const { drivers, requests } = await readDocs(env, ["drivers", "requests"]);
        const picked = await autoPick(env, r, drivers, requests);
        if (picked) Object.assign(r, picked);
        else {
          offers = liveOffers(r, drivers, busySet(requests)).map((x) => ({
            id: x.d.id, name: (x.d.name || "").trim().split(/\s+/)[0] || "سائق", photo: x.d.photo || "", expiresAt: x.expiresAt,
            distM: x.distM, etaMin: x.etaMin, ...tierOf(x.d), praise: praiseOf(x.d),
          }));
        }
      }
      let driver = null, driverLoc = null;
      if (r.driverId && (r.status === "assigned" || r.status === "done")) {
        const d = await getDoc(env, "drivers", r.driverId);
        if (d) {
          /* رقم السائق بيظهر للراكب حتى بعد الرحلة — لو نسي حاجة في التوكتوك (رقم الراكب مابيظهرش للسائق) */
          driver = { name: name2(d.name), plate: d.plate, photo: d.photo || "", phone: d.phone || "", ...tierOf(d) };
          if (r.status === "assigned" && d.loc && Date.now() - d.loc.at < 2 * 60 * 1000) driverLoc = d.loc;
        }
      }
      const pt = (p) => (p && p.lat != null ? { lat: p.lat, lng: p.lng, label: p.label } : null);
      return json({
        id: r.id, status: r.status, fare: r.fare, outside: Boolean(r.outside), distKm: r.distKm ?? null, perKm: r.perKm || null, driver, driverLoc, from: pt(r.from), to: pt(r.to), createdAt: r.createdAt, assignedAt: r.assignedAt || null, scheduledAt: r.scheduledAt || null, discount: r.discount || 0,
        code: r.status === "assigned" && r.codeOn ? r.code : null, codeOn: Boolean(r.codeOn), startedAt: r.startedAt || null,
        multi: Boolean(r.multi), meter: r.multi && r.startedAt && r.status === "assigned" ? meterView(r, PR(await pricingCfg(env)), Date.now()) : null, bill: r.bill || null,
        arrivedAt: r.arrivedAt || null, cancelReason: r.cancelReason || null,
        shareToken: r.shareToken || null, reported: Boolean(r.reported), impostorReported: Boolean(r.impostorReported),
        canRate: r.status === "done" && r.driverId && !r.rating && riderKey(r.riderPhone).length >= 9
          ? !(await getDoc(env, "rated", r.driverId + ":" + riderKey(r.riderPhone))) : false,
        offers, autoPickAt: offers.length ? Math.min(...offers.map((o) => o.expiresAt)) : null, now: Date.now(),
      });
    }

    /* الراكب بيختار سائق من اللي وافقوا */
    if (route === "pick" && method === "POST") {
      const b = await parseBody(request);
      const r = await getDoc(env, "requests", str(b.id, 40));
      if (!r || !r.token || !safeEqual(b.token, r.token)) return json({ error: "غير مصرّح" }, 401);
      if (r.status !== "pending") return json({ error: "الطلب اتقفل خلاص" }, 409);
      const { drivers, requests } = await readDocs(env, ["drivers", "requests"]);
      const o = liveOffers(r, drivers, busySet(requests)).find((x) => x.d.id === str(b.driverId, 40));
      if (!o) return json({ error: "السائق ده مابقاش متاح — اختار حد تاني" }, 409);
      const next = await assignTo(env, r, o.d);
      if (!next) {
        const now2 = await getDoc(env, "requests", r.id);
        return json({ error: now2 && now2.status === "pending" ? "السائق ده لسه اتحجز لراكب تاني — اختار حد تاني" : "الطلب اتقفل خلاص" }, 409);
      }
      return json({ ok: true });
    }

    /* «شارك رحلتك»: الأهل يشوفوا الحالة واسم السائق ولوحته — من غير أي أرقام تليفونات */
    if (route === "share" && sub && method === "GET") {
      const r = await getDoc(env, "requests", str(sub, 40));
      if (!r || !tokOk(url.searchParams.get("s"), r.shareToken)) return json({ error: "اللينك ده مش صحيح" }, 404);
      let driver = null, driverLoc = null;
      if (r.driverId) {
        const d = await getDoc(env, "drivers", r.driverId);
        if (d) {
          driver = { name: name2(d.name), plate: d.plate, photo: d.photo || "", tier: tierOf(d).tier };
          /* مكان التوكتوك لايف للأهل — وقت الرحلة بس */
          if (r.status === "assigned" && d.loc && Date.now() - d.loc.at < 2 * 60 * 1000) driverLoc = { lat: d.loc.lat, lng: d.loc.lng, h: d.loc.h };
        }
      }
      const first = (r.riderName || "").trim().split(/\s+/)[0] || "";
      return json({
        status: r.status, rider: first,
        from: { label: r.from.label, lat: r.from.lat, lng: r.from.lng },
        to: { label: r.to.label, lat: r.to.lat, lng: r.to.lng }, driver, driverLoc,
        createdAt: r.createdAt, assignedAt: r.assignedAt || null, startedAt: r.startedAt || null, finishedAt: r.finishedAt || null,
      });
    }

    /* الراكب يلغي — أو يرجّع الطلب للسواقين التانيين لو السائق اتأخر */
    if (route === "rider-cancel" && method === "POST") {
      const b = await parseBody(request);
      const r = await getDoc(env, "requests", str(b.id, 40));
      if (!r || !r.token || !safeEqual(b.token, r.token)) return json({ error: "غير مصرّح" }, 401);
      if (r.status === "done" || r.status === "cancelled") return json({ ok: true, status: r.status });
      if (r.startedAt) return json({ error: "الرحلة بدأت خلاص — مينفعش تتلغي" }, 409);
      const reason = ["changed", "late", "noshow", "wrong", "other"].includes(b.reason) ? b.reason : "other";
      if (r.driverId && (reason === "late" || reason === "noshow")) {
        const d = await getDoc(env, "drivers", r.driverId);
        if (d) await putDoc(env, "drivers", d.id, { ...d, lateCount: (d.lateCount || 0) + 1, lateLog: [...(d.lateLog || []), { at: Date.now(), rid: r.id }].slice(-20) });
      }
      /* أقصى حاجة ٣ مرات «سواق تاني» في نفس الطلب */
      if (b.rebook && (r.rebooked || 0) >= 3) return json({ error: "طلبت سواق تاني ٣ مرات في نفس الطلب — الغي واطلب من جديد" }, 409);
      if (b.rebook && r.status === "assigned" && !r.startedAt) {
        await putDoc(env, "requests", r.id, { ...r, status: "pending", driverId: "", assignedAt: null, offers: [], reopenedAt: Date.now(), skipDrivers: [...(r.skipDrivers || []), r.driverId].slice(-5), rebooked: (r.rebooked || 0) + 1 });
        return json({ ok: true, status: "pending" });
      }
      await putDoc(env, "requests", r.id, { ...r, status: "cancelled", cancelledBy: "rider", cancelReason: reason, cancelledAt: Date.now() });
      return json({ ok: true, status: "cancelled" });
    }

    /* احذف حسابي: بيمسح كل البيانات المربوطة بالرقم. لازم يثبت إنه صاحب الرقم:
       تأكيد واتساب لو شغال، أو تذكرة رحلة من رحلاته (محفوظة على موبايله). غير كده الطلب بيروح للإدارة تتأكد بنفسها */
    if (route === "delete-account" && method === "POST") {
      const b = await parseBody(request);
      const phone = digits(b.phone).slice(0, 15), p10 = l10(phone);
      if (phone.length < 9) return json({ error: "اكتب رقمك" }, 400);
      /* السائق من صفحة الحذف: الطلب بيروح للإدارة تتأكد منه وتحذف */
      if (b.role === "driver") {
        if (!(await rateOk(env, "del-" + p10, 3))) return json({ error: "استنى شوية وجرّب تاني" }, 429);
        const rid = uid();
        await putDoc(env, "reports", rid, { id: rid, kind: "other", status: "open", phone, name: str(b.name, 60), note: "طلب حذف حساب سائق — اتأكد إنه هو اللي طالب (كلّمه على الرقم ده) وبعدين احذف", deleteReq: true, deleteRole: "driver", createdAt: Date.now() });
        return json({ ok: true, queued: true });
      }
      const { requests } = await readDocs(env, ["requests"]);
      const mineR = requests.filter((x) => l10(x.riderPhone) === p10 || l10(x.bookerPhone) === p10);
      let proven = false;
      /* الحذف المباشر محتاج تأكيد واتساب لنفس الرقم (أو حساب المراجعة). غير كده الطلب بيروح للإدارة تتأكد بنفسها */
      if (verifyOn(env) || (await isReview(env, phone))) {
        const t = str(request.headers.get("x-session"), 80), s = t ? await getDoc(env, "sessions", t) : null;
        proven = Boolean(s && s.role === "rider" && s.phone === p10 && Date.now() - s.at <= SESSION_TTL);
        if (!proven && verifyOn(env)) return json({ error: "أكّد رقمك الأول — دوس تاني", reverify: "rider" }, 401);
      }
      if (!proven) {
        if (!(await rateOk(env, "del-" + p10, 3))) return json({ error: "استنى شوية وجرّب تاني" }, 429);
        const rid = uid();
        await putDoc(env, "reports", rid, { id: rid, kind: "other", status: "open", phone, riderPhone: phone, riderName: str(b.name, 60), name: str(b.name, 60), note: "طلب حذف الحساب — اتأكد إن صاحب الرقم هو اللي طالب (كلّمه على الرقم ده) وبعدين احذف", deleteReq: true, createdAt: Date.now() });
        return json({ ok: true, queued: true });
      }
      return json({ ok: true, ...(await wipeRider(env, phone, mineR)) });
    }

    /* تقييم السائق بعد الرحلة — مرة واحدة لكل رحلة */
    if (route === "rate" && method === "POST") {
      const b = await parseBody(request);
      const r = await getDoc(env, "requests", str(b.id, 40));
      if (!r || !tokOk(b.token, r.token)) return json({ error: "غير مصرّح" }, 401);
      if (r.status !== "done" || !r.driverId) return json({ error: "التقييم بعد ما الرحلة تخلص" }, 409);
      if (r.rating) return json({ error: "قيّمت الرحلة دي قبل كده" }, 409);
      /* كل راكب (برقم موبايله) يقيّم نفس السائق مرة واحدة بس — حتى لو ركب معاه كذا مرة */
      const rk = riderKey(r.riderPhone);
      if (rk.length < 9) return json({ error: "التقييم محتاج رقم موبايل مسجّل" }, 409);
      const pairId = r.driverId + ":" + rk;
      if (await getDoc(env, "rated", pairId)) return json({ error: "قيّمت السائق ده قبل كده — التقييم مرة واحدة بس لكل سائق" }, 409);
      const stars = Math.max(1, Math.min(5, parseInt(b.stars, 10) || 0));
      const note = str(b.note, 200), tags = (Array.isArray(b.tags) ? b.tags : []).map((x) => str(x, 30)).slice(0, 5);
      await putDoc(env, "rated", pairId, { id: pairId, driverId: r.driverId, rider: rk, requestId: r.id, stars, at: Date.now() });
      await putDoc(env, "requests", r.id, { ...r, rating: stars, ratingNote: note, ratingTags: tags });
      const d = await getDoc(env, "drivers", r.driverId);
      if (d) {
        /* التعليقات المختصرة بتتجمّع كأرقام (من غير أسماء) · والكلام المكتوب للإدارة بس */
        const tc = { ...(d.tagCount || {}) }; tags.forEach((t) => { tc[t] = (tc[t] || 0) + 1; });
        const bad = tags.filter((t) => RED_TAGS.includes(t)), redBy = { ...(d.redBy || {}) };
        bad.forEach((t) => { redBy[t] = Array.from(new Set((redBy[t] || []).concat(rk))).slice(-20); });
        const redAlert = Object.keys(redBy).filter((t) => redBy[t].length >= 2);
        await putDoc(env, "drivers", d.id, { ...d, ratingSum: (d.ratingSum || 0) + stars, ratingCount: (d.ratingCount || 0) + 1,
          tagCount: tc, tagRated: (d.tagRated || 0) + (tags.length ? 1 : 0), redBy, redAlert,
          reviews: (d.reviews || []).concat(note || tags.length ? [{ s: stars, n: note, t: tags, at: Date.now(), r: rk.slice(-4) }] : []).slice(-30) });
      }
      return json({ ok: true });
    }

    /* ===== مشوار كل يوم: الطلب بيتعمل لوحده قبل المعاد بـ ٢١–٥٥ دقيقة ===== */
    if (route === "repeat") {
      const b = method === "GET" ? Object.fromEntries(new URL(request.url).searchParams) : await parseBody(request);
      const phone = digits(b.phone);
      if (phone.length < 10) return json({ error: "اكتب رقمك في البروفايل الأول" }, 400);
      const deny = await needSession(request, env, phone, "rider");
      if (deny) return deny;
      /* الراكب كمان بيشغّل المشاوير الثابتة (مش مستنيين سواق يفتح التطبيق) */
      if (method === "GET") { try { await runRepeats(env); } catch (e) {} }
      const { repeats } = await readDocs(env, ["repeats"]);
      const mine = (repeats || []).filter((x) => l10(x.phone) === l10(phone));
      const c = cairoNow();
      if (!sub && method === "GET") {
        const cur = mine.map((x) => x.current).find((x) => x && x.day === c.day) || null;
        const soonX = mine.find((x) => !x.paused && x.warnDay === c.day && x.lastDay !== c.day && x.skipDay !== c.day);
        const soon = soonX ? { id: soonX.id, day: c.day, time: soonX.time, to: soonX.body.to && soonX.body.to.label, warnAt: soonX.warnAt } : null;
        return json({ items: mine.map((x) => ({ id: x.id, time: x.time, days: x.days, from: x.body.from && x.body.from.label, to: x.body.to && x.body.to.label, paused: !!x.paused, driver: x.lastDriverName || "", skippedToday: x.skipDay === c.day })), current: cur, soon });
      }
      if (sub === "add" && method === "POST") {
        if (mine.length >= 3) return json({ error: "أقصى حاجة ٣ مشاوير ثابتة" }, 400);
        const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(b.time) ? b.time : "";
        const days = (Array.isArray(b.days) ? b.days : []).map(Number).filter((n) => n >= 0 && n <= 6);
        if (!time || !days.length) return json({ error: "اختار المعاد والأيام" }, 400);
        if (!b.from || !b.to) return json({ error: "حدّد مكان الركوب والوجهة" }, 400);
        const id = uid();
        const leg = (p) => ({ lat: +p.lat, lng: +p.lng, label: str(p.label, 80) });
        await putDoc(env, "repeats", id, { id, phone, time, days, lastDay: "", body: { riderName: str(b.name, 60), riderPhone: phone, note: str(b.note, 140), from: leg(b.from), to: leg(b.to) }, at: Date.now() });
        return json({ ok: true });
      }
      /* «مش محتاجه النهارده»: يوقف مشوار النهارده بس — ولو الطلب اتعمل ولسه محدش أخده، بيتلغي */
      if (sub === "skip" && method === "POST") {
        const x = mine.find((r) => r.id === str(b.id, 40));
        if (!x) return json({ error: "المشوار ده مش موجود" }, 404);
        x.skipDay = b.undo ? "" : c.day;
        await putDoc(env, "repeats", x.id, x);
        if (!b.undo && x.current && x.current.day === c.day) {
          const rq = await getDoc(env, "requests", x.current.id);
          if (rq && rq.status === "pending") await putDoc(env, "requests", rq.id, { ...rq, status: "cancelled", cancelledBy: "rider", cancelReason: "changed", cancelledAt: Date.now() });
        }
        return json({ ok: true });
      }
      if (sub === "remove" && method === "POST") {
        const x = mine.find((r) => r.id === str(b.id, 40));
        if (x) await env.DB.prepare("DELETE FROM docs WHERE kind=? AND id=?").bind("repeats", x.id).run();
        return json({ ok: true });
      }
      return json({ error: "not found" }, 404);
    }

    /* تسجيل توكن الإشعارات للموبايل ده */
    if (route === "push" && sub === "register" && method === "POST") {
      const b = await parseBody(request);
      const token = str(b.token, 400);
      if (token.length < 20) return json({ error: "توكن غلط" }, 400);
      let phone = "";
      if (b.role === "driver") {
        const d = await getDriver(request, env);
        if (!d) return json({ error: "ادخل الأول" }, 401);
        phone = d.phone;
      } else {
        phone = digits(b.phone);
        if (phone.length < 10) return json({ error: "رقمك مش متسجّل" }, 400);
        const deny = await needSession(request, env, phone, "rider");
        if (deny) return deny;
      }
      const role = b.role === "driver" ? "driver" : "rider";
      await putDoc(env, "push", role + "_" + l10(phone), { token, at: Date.now() });
      return json({ ok: true });
    }

    /* ===== الأهل ===== */
    if (route === "family") {
      const b = method === "GET" ? Object.fromEntries(new URL(request.url).searchParams) : await parseBody(request);
      const phone = digits(b.phone);
      if (phone.length < 10) return json({ error: "رقمك مش متسجّل — اكتبه في البروفايل" }, 400);
      const deny = await needSession(request, env, phone, "rider");
      if (deny) return deny;
      const me = l10(phone);
      const { links } = await readDocs(env, ["links"]);
      const all = links || [];
      const view = (k) => ({ id: k.id, status: k.status, auto: k.auto !== false, riderName: k.riderName, famName: k.famName || "", fam: "0" + k.fam, rider: "0" + k.rider, riderPhone: k.status === "ok" ? k.riderPhoneFull : "" });

      if (!sub && method === "GET") {
        return json({
          mine: all.filter((k) => k.rider === me).map(view),
          invites: all.filter((k) => k.fam === me && k.status === "pending").map(view),
          watching: all.filter((k) => k.fam === me && k.status === "ok").map(view),
        });
      }
      if (sub === "add" && method === "POST") {
        const fam = digits(b.fam);
        if (!/^01\d{9}$/.test(fam)) return json({ error: "اكتب رقم موبايل مصري صحيح" }, 400);
        if (l10(fam) === me) return json({ error: "ده رقمك إنت" }, 400);
        if (all.filter((k) => k.rider === me).length >= 3) return json({ error: "أقصى حاجة ٣ أرقام" }, 400);
        const id = famId(phone, fam);
        const old = all.find((k) => k.id === id);
        if (old) return json({ ok: true, link: view(old) });
        const k = { id, rider: me, fam: l10(fam), riderName: str(b.name, 60), famName: str(b.famName, 40), riderPhoneFull: phone, status: "pending", auto: true, at: Date.now() };
        await putDoc(env, "links", id, k);
        return json({ ok: true, link: view(k) });
      }
      if (sub === "answer" && method === "POST") {
        const k = all.find((x) => x.id === str(b.id, 40) && x.fam === me);
        if (!k) return json({ error: "الطلب مش موجود" }, 404);
        if (b.ok) await putDoc(env, "links", k.id, { ...k, status: "ok", okAt: Date.now() });
        else await env.DB.prepare("DELETE FROM docs WHERE kind=? AND id=?").bind("links", k.id).run();
        return json({ ok: true });
      }
      if (sub === "remove" && method === "POST") {
        const k = all.find((x) => x.id === str(b.id, 40) && (x.fam === me || x.rider === me));
        if (k) await env.DB.prepare("DELETE FROM docs WHERE kind=? AND id=?").bind("links", k.id).run();
        return json({ ok: true });
      }
      if (sub === "auto" && method === "POST") {
        const k = all.find((x) => x.id === str(b.id, 40) && x.rider === me);
        if (!k) return json({ error: "مش موجود" }, 404);
        await putDoc(env, "links", k.id, { ...k, auto: Boolean(b.auto) });
        return json({ ok: true });
      }
      if (sub === "alerts" && method === "GET") {
        const box = (await getDoc(env, "famalerts", me)) || { items: [] };
        const since = +b.since || 0;
        return json({ items: box.items.filter((x) => x.at > since), invites: all.filter((k) => k.fam === me && k.status === "pending").length, now: Date.now() });
      }
      if (sub === "sos" && method === "POST") {
        const r = await getDoc(env, "requests", str(b.requestId, 40));
        if (!r || !safeEqual(str(b.token, 80), String(r.token || "")) || l10(r.riderPhone) !== me) return json({ error: "الرحلة مش موجودة" }, 404);
        const d = r.driverId ? await getDoc(env, "drivers", r.driverId) : null;
        const lat = +b.lat, lng = +b.lng;
        const n = await pushFam(env, r.riderPhone, {
          type: "sos", requestId: r.id, share: r.shareToken || "", driver: d ? d.name + (d.plate ? " · لوحة " + d.plate : "") : "",
          loc: isFinite(lat) && isFinite(lng) && lat ? { lat, lng } : null,
        }, false);
        await putDoc(env, "requests", r.id, { ...r, sosAt: Date.now() });
        return json({ ok: true, sent: n });
      }
      return json({ error: "not found" }, 404);
    }

    /* الدعم والشكاوى — من غير رحلة محددة */
    if (route === "support" && method === "POST") {
      const b = await parseBody(request);
      const phone = digits(b.phone).slice(0, 15);
      const note = str(b.note, 600);
      if (phone.length < 9 || !note) return json({ error: "اكتب رقمك والمشكلة" }, 400);
      const kinds = ["overcharge", "late", "behaviour", "lost", "suggest", "other"];
      const rid = uid();
      await putDoc(env, "reports", rid, {
        id: rid, requestId: str(b.requestId, 40), driverId: "", riderName: str(b.name, 60), riderPhone: phone,
        kind: kinds.includes(b.kind) ? b.kind : "other", asked: 0, fare: 0, note, status: "open", createdAt: Date.now(), source: "support",
      });
      return json({ ok: true });
    }

    /* رصيد الشحن للراكب — بيرجّع free طول ما النظام مقفول أو في الفترة المجانية */
    if (route === "wallet" && method === "GET") {
      const phone = digits(url.searchParams.get("phone"));
      if (phone.length < 9) return json({ error: "رقم غير صحيح" }, 400);
      const w = await riderWallet(env, phone, await subCfg(env));
      return json(w.state === "low" || w.state === "stopped" ? { state: w.state, credit: w.credit, fee: w.fee } : { state: "free" });
    }

    /* رصيد الدعوات للراكب */
    if (route === "referral" && method === "GET") {
      const phone = digits(url.searchParams.get("phone"));
      if (phone.length < 9) return json({ error: "رقم غير صحيح" }, 400);
      const { requests } = await readDocs(env, ["requests"]);
      const invited = requests.filter((r) => r.refBy === phone);
      const earned = invited.filter((r) => r.status === "done").length;
      const used = requests.filter((r) => r.riderPhone === phone && r.refCredit && r.status !== "cancelled").length;
      return json({ code: refCode(phone), joined: invited.length, credit: Math.max(0, earned - used) * REF_OFF, off: REF_OFF });
    }

    /* كود الركوب اختياري: الراكب بيفعّله بنفسه لحد ما الرحلة تبدأ، وبعدها السائق لازم يكتبه */
    if (route === "code-on" && method === "POST") {
      const b = await parseBody(request);
      const r = await getDoc(env, "requests", str(b.id, 40));
      if (!r || !tokOk(b.token, r.token)) return json({ error: "غير مصرّح" }, 401);
      if (r.status !== "assigned" || r.startedAt) return json({ error: "الرحلة بدأت خلاص — مينفعش تفعّل الكود دلوقتي" }, 409);
      if (!r.codeOn) {
        await putDoc(env, "requests", r.id, { ...r, codeOn: true, codeOnAt: Date.now() });
        const d = r.driverId ? await getDoc(env, "drivers", r.driverId) : null;
        if (d) { try { await pushTo(env, "driver", l10(d.phone), { kind: "ride", title: "الراكب فعّل كود الركوب 🔒", body: "اسأله على الكود قبل ما تبدأ الرحلة", url: "/driver.html" }); } catch (e) {} }
      }
      return json({ ok: true, code: r.code });
    }

    /* بلاغ من الراكب — بيوصل للإدارة في تبويب «البلاغات» */
    if (route === "report" && method === "POST") {
      const b = await parseBody(request);
      const r = await getDoc(env, "requests", str(b.id, 40));
      if (!r || !tokOk(b.token, r.token)) return json({ error: "غير مصرّح" }, 401);
      const kinds = ["overcharge", "late", "behaviour", "lost", "impostor", "other"];
      const kind = kinds.includes(b.kind) ? b.kind : "other";
      const asked = Math.max(0, Math.min(1000, parseInt(b.asked, 10) || 0));
      const rid = uid();
      /* «السائق مش هو اللي في الصورة»: الحساب بيتوقف مؤقتاً على طول لحد ما الإدارة تراجع.
         ٣ بلاغات من ٣ ركاب مختلفين = إيقاف نهائي (الإدارة بس هي اللي ترجّعه) */
      if (kind === "impostor") {
        if (!r.driverId) return json({ error: "البلاغ ده بعد ما سائق يقبل" }, 409);
        /* بلاغ «مش هو» متاح وقت الرحلة ولحد ساعة بعد ما تخلص بس — علشان محدش يوقّف سائق بعد أيام */
        if (r.status === "cancelled" || (r.status === "done" && Date.now() - (r.finishedAt || 0) > 3600e3))
          return json({ error: "البلاغ ده بيبقى متاح لحد ساعة بعد الرحلة — اختار «حاجة تانية» واكتب اللي حصل" }, 409);
        if (r.impostorReported) return json({ ok: true });
        const d = await getDoc(env, "drivers", r.driverId);
        if (d) {
          const rk = riderKey(r.riderPhone) || r.id;
          const by = [...new Set([...(d.impostorBy || []), rk])].slice(-20);
          await putDoc(env, "drivers", d.id, { ...d, hold: { at: Date.now(), reportId: rid, requestId: r.id }, impostorBy: by, online: false, ...(by.length >= 3 ? { active: false, bannedFor: "impostor" } : {}) });
        }
        r.impostorReported = true;
      }
      await putDoc(env, "reports", rid, {
        id: rid, requestId: r.id, driverId: r.driverId || "", riderName: r.riderName, riderPhone: r.riderPhone,
        kind, asked, fare: r.fare, note: str(b.note, 400), status: "open", createdAt: Date.now(),
      });
      await putDoc(env, "requests", r.id, { ...r, reported: true });
      return json({ ok: true });
    }

    /* ================= رسايل + مكالمات بالنت بين الراكب والسائق =================
       رقم الراكب مابيظهرش للسائق. الرسايل مفتوحة والمشوار شغال، ونص ساعة بعد ما يخلص (لو حد نسي حاجة).
       المكالمة WebRTC (صوت بس)، والسيرفر بينقل رسايل الإعداد بس (offer/answer/bye). */
    if (route === "ice" && method === "GET") {
      const stun = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
      if (env.TURN_KEY_ID && env.TURN_KEY_TOKEN) {
        try {
          const r = await fetch("https://rtc.live.cloudflare.com/v1/turn/keys/" + env.TURN_KEY_ID + "/credentials/generate", {
            method: "POST", headers: { authorization: "Bearer " + env.TURN_KEY_TOKEN, "content-type": "application/json" },
            body: JSON.stringify({ ttl: 3600 }),
          });
          const j = await r.json();
          if (j.iceServers) return json({ iceServers: stun.concat(Array.isArray(j.iceServers) ? j.iceServers : [j.iceServers]) });
        } catch (e) {}
      }
      return json({ iceServers: stun });
    }

    if (route === "chat" && sub) {
      const r = await getDoc(env, "requests", str(sub, 40));
      if (!r) return json({ error: "طلب غير موجود" }, 404);
      let who = "";
      if (r.token && safeEqual(url.searchParams.get("token"), r.token)) who = "r";
      else { const me = await getDriver(request, env); if (me && me.id === r.driverId) who = "d"; }
      if (!who) return json({ error: "غير مصرّح" }, 401);
      const open = r.driverId && (r.status === "assigned" || (r.status === "done" && Date.now() - (r.finishedAt || 0) < 5 * 60 * 1000));
      const c = (await getDoc(env, "chat", r.id)) || { m: [], s: [] };
      if (method === "GET") {
        const after = +url.searchParams.get("after") || 0;
        let peer = "";
        if (who === "r" && r.driverId) { const d = await getDoc(env, "drivers", r.driverId); peer = d ? d.name : ""; }
        else peer = (r.riderName || "").trim().split(/\s+/)[0] || "الراكب";
        /* الرسايل بتتمسح خالص بعد ٢٤ ساعة من قفل المشوار */
        const old = !open && Date.now() - (r.finishedAt || r.cancelledAt || r.createdAt || 0) > 864e5;
        if (old && (c.m.length || c.s.length)) { try { await env.DB.prepare("DELETE FROM docs WHERE kind='chat' AND id=?").bind(r.id).run(); } catch (e) {} }
        return json({
          me: who, peer, open: Boolean(open), status: r.status, now: Date.now(),
          m: old ? [] : c.m.filter((x) => x.at > after),
          s: old || !open ? [] : c.s.filter((x) => x.at > after && x.f !== who && Date.now() - x.at < 5 * 60 * 1000),
        });
      }
      if (method === "POST") {
        if (!open) return json({ error: "الرسايل اتقفلت — المشوار خلص" }, 403);
        const b = await parseBody(request), now = Date.now();
        if (b.sig && typeof b.sig === "object") {
          const t = str(b.sig.type, 12);
          if (!["offer", "answer", "bye", "decline"].includes(t)) return json({ error: "نوع غير معروف" }, 400);
          c.s = c.s.filter((x) => now - x.at < 5 * 60 * 1000).concat([{ i: uid(), f: who, type: t, call: str(b.sig.call, 20), sdp: String(b.sig.sdp ?? "").slice(0, 15000), at: now }]).slice(-20);
          if (t === "offer") c.m = c.m.concat([{ i: uid(), f: who, sys: "call", t: "", at: now }]).slice(-200);
        } else {
          const t = str(b.text, 500);
          if (!t) return json({ error: "الرسالة فاضية" }, 400);
          c.m = c.m.concat([{ i: uid(), f: who, t, at: now }]).slice(-200);
        }
        await putDoc(env, "chat", r.id, c);
        return json({ ok: true, at: now });
      }
    }

    /* ================= السائق ================= */

    if (route === "driver") {
      if (sub === "login" && method === "POST") {
        const b = await parseBody(request);
        const phone = digits(b.phone), code = digits(b.code);
        if (phone.length < 9) return json({ error: "اكتب رقم الموبايل صح" }, 400);
        if (await drvLock(env, phone)) return json({ error: LOCK_MSG, code: "locked" }, 429);
        const { drivers } = await readDocs(env, ["drivers"]);
        const d = drivers.find((x) => digits(x.phone) === phone);
        if (d) await stampCode(env, d);
        if (!d || !d.code || !safeEqual(code, String(d.code))) {
          const l = await drvFail(env, phone);
          return l.until ? json({ error: LOCK_MSG, code: "locked" }, 429) : json({ error: "الرقم أو الكود غير صحيح — فاضل " + (DRV_TRIES - l.n) + " محاولات" }, 401);
        }
        if (!d.reviewer && !codeLive(d)) return json({ error: "الكود ده خلصت صلاحيته — اطلب كود جديد من الإدارة", code: "code_expired" }, 401);
        if (d.active === false) return json({ error: "حسابك موقوف — كلّم الإدارة" }, 403);
        if (d.hold) return json({ error: HOLD_MSG, code: "hold" }, 403);
        /* ربط الحساب بموبايل واحد: أول دخول بيربطه، وأي موبايل تاني لازم الإدارة توافق عليه */
        const dev = devOf(b.device);
        if (dev.length < 8) return json({ error: "حدّث التطبيق وجرّب تاني" }, 400);
        /* كود جديد من الإدارة (ليه صلاحية) = موافقة على الموبايل اللي هيدخل بيه */
        if (d.reviewer || !d.deviceId || (d.codeExp && d.deviceId !== dev)) { d.deviceId = dev; d.deviceAt = Date.now(); delete d.pendingDevice; }
        else if (d.deviceId !== dev) {
          d.pendingDevice = { id: dev, at: Date.now(), ua: str(request.headers.get("user-agent"), 160) };
          await putDoc(env, "drivers", d.id, d);
          return json({ error: "الموبايل ده جديد على حسابك. طلبك وصل للإدارة — أول ما توافق، ادخل تاني", code: "device_pending" }, 403);
        }
        const stok = tok() + tok();
        d.sess = await sha(stok); d.sessAt = Date.now(); d.codeUsed = !d.reviewer;
        await putDoc(env, "drivers", d.id, d);
        try { await env.DB.prepare("DELETE FROM docs WHERE kind='loginfail' AND id=?").bind("drv-" + phone).run(); } catch (e) {}
        if (!subActive(d, await subCfg(env))) return json({ error: "رصيدك خلص — اشحن من الإدارة علشان تستقبل مشاوير", token: stok, driver: { id: d.id, name: d.name, plate: d.plate } }, 403);
        return json({ ok: true, token: stok, driver: { id: d.id, name: d.name, plate: d.plate } });
      }

      const gx = await getDriverEx(request, env), me = gx.d;
      if (!me) return json({ error: gx.why || "غير مصرّح" }, gx.why ? 403 : 401);
      /* السائق بيحذف حسابه بنفسه من «حسابي» */
      if (sub === "delete-account" && method === "POST") {
        const o = await wipeDriver(env, me);
        return o.error ? json({ error: o.error }, o.status) : json(o);
      }
      const sc = await subCfg(env);
      const ss = subState(me, sc);
      if (!me.joinedAt && !me.createdAt) { me.joinedAt = Date.now(); await putDoc(env, "drivers", me.id, me); }
      /* السائق اللي اشتراكه وقف يقدر يفتح الصفحة ويشوف الرسالة، بس مايقدرش ياخد مشاوير */
      if (ss.state === "stopped" && !(method === "GET") && sub !== "online" && sub !== "loc" && sub !== "finish" && sub !== "start") return json({ error: "رصيدك خلص — اشحن من الإدارة علشان تاخد مشاوير" }, 403);

      /* مكان السائق لايف — بيتبعت وهو في مشوار بس، والراكب بيشوفه من /api/track */
      if (sub === "loc" && method === "POST") {
        const b = await parseBody(request);
        const lat = +b.lat, lng = +b.lng;
        if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return json({ error: "مكان غير صحيح" }, 400);
        /* أقل من ٤ ثواني بنتجاهل — إلا لو ده أول اتجاه يوصل (علشان التوكتوك يلف على طول عند الراكب) */
        /* وهو في مشوار: كل ثانيتين (التوكتوك لايف عند الراكب والأهل) · وهو فاضي: كل ٤ ثواني بالكتير */
        if (me.loc && Date.now() - me.loc.at < (b.idle ? 4000 : 1500) && !(me.loc.h == null && b.h != null && isFinite(+b.h))) return json({ ok: true });
        me.loc = { lat: +lat.toFixed(6), lng: +lng.toFixed(6), h: b.h != null && isFinite(+b.h) ? Math.round(+b.h) : (me.loc && me.loc.h != null ? me.loc.h : null), at: Date.now(), idle: Boolean(b.idle) };
        /* عدّاد المشوار المتعدد: بنجمع المسافة اللي اتمشت فعلاً. لو الإشارة قطعت (فجوة > ١٥ ث) بنحسب أقرب طريق على الخريطة بين النقطتين */
        if (me.meterId) {
          try {
            const r = await getDoc(env, "requests", me.meterId);
            if (!r || r.status !== "assigned" || !r.multi) me.meterId = null;
            else if (r.startedAt) {
              const m = r.meter || { km: 0 }, p = { lat: me.loc.lat, lng: me.loc.lng, at: me.loc.at };
              if (!m.last) m.last = p;
              else {
                const d = meters(m.last, p), gap = p.at - m.last.at;
                if (d >= 15) {
                  let km = d / 1000;
                  if (gap > 15000 && d > 150) { const rk = await roadKm(m.last, p); km = rk != null ? rk : km * 1.3; m.weakAt = p.at; }
                  m.km = +((+m.km || 0) + km).toFixed(3); m.last = p; m.moveAt = p.at;
                  /* التوكتوك اتحرك أكتر من ٥٠ م من مكان الوقفة ← الانتظار بيقف لوحده */
                  if (r.waitOn && r.waitOn.lat != null && meters(r.waitOn, p) > 50) { r.waits = [...(r.waits || []), { s: r.waitOn.s, e: p.at, auto: true }]; r.waitOn = null; }
                } else m.last = { ...m.last, at: p.at };
              }
              r.meter = m; await putDoc(env, "requests", r.id, r);
            }
          } catch (e) {}
        }
        await putDoc(env, "drivers", me.id, me);
        return json({ ok: true });
      }

      /* المشوار المتعدد: «انتظار» / «كمّل المشوار» */
      if (sub === "wait" && method === "POST") {
        const b = await parseBody(request);
        const r = await getDoc(env, "requests", str(b.requestId, 40));
        if (!r || r.driverId !== me.id || r.status !== "assigned" || !r.startedAt || !r.multi) return json({ error: "مفيش مشوار متعدد شغال" }, 409);
        const now = Date.now();
        if (b.on) {
          if (!r.waitOn) {
            if (r.meter && r.meter.moveAt && now - r.meter.moveAt < 6000) return json({ error: "اقف الأول وبعدين دوس «انتظار»" }, 409);
            r.waitOn = { s: now, lat: me.loc ? me.loc.lat : null, lng: me.loc ? me.loc.lng : null };
          }
        } else if (r.waitOn) { r.waits = [...(r.waits || []), { s: r.waitOn.s, e: now }]; r.waitOn = null; }
        await putDoc(env, "requests", r.id, r);
        return json({ ok: true, meter: meterView(r, PR(await pricingCfg(env)), now) });
      }

      if (sub === "online" && method === "POST") {
        const b = await parseBody(request);
        me.online = b.online !== false;
        me.lastSeen = Date.now();
        await putDoc(env, "drivers", me.id, me);
        return json({ ok: true, online: me.online });
      }

      if (sub === "feed" && method === "GET") {
        try { await runRepeats(env); } catch (e) {}
        /* بنكتب «آخر ظهور» مرة كل ٣٠ ثانية بس — الكتابة كل ٤ ثواني كانت بتعمل ضغط (503) */
        if (Date.now() - (me.lastSeen || 0) > 30000) { me.lastSeen = Date.now(); await putDoc(env, "drivers", me.id, me); }
        const { requests } = await readDocs(env, ["requests"]);
        const now = Date.now();
        if (now - (globalThis.__mhSweep || 0) > 60000) { globalThis.__mhSweep = now; try { await expireStale(env, requests); } catch (e) {} }
        /* الراكب مااختارش في دقيقة؟ نختار الأقرب له */
        const due = requests.filter((r) => r.status === "pending" && (r.offers || []).length && now - r.offers[0].at >= AUTO_PICK_MS);
        if (due.length && now - (globalThis.__mhPick || 0) > 8000) {
          globalThis.__mhPick = now;
          try {
            const { drivers } = await readDocs(env, ["drivers"]);
            for (const r of due.slice(0, 10)) { const n = await autoPick(env, r, drivers, requests); if (n) Object.assign(r, n); }
          } catch (e) {}
        }

        /* المشوار اليومي فتح: إشعار لسواق امبارح إن الطلب ليه لوحده ٣ دقايق */
        for (const r of requests.filter((x) => x.status === "pending" && x.prefDriver && !x.prefPushed && now >= openAt(x) && now - openAt(x) < PREF_MS).slice(0, 5)) {
          try {
            const fr = await getDoc(env, "requests", r.id);
            if (!fr || fr.prefPushed || fr.status !== "pending") continue;
            fr.prefPushed = true; await putDoc(env, "requests", fr.id, fr); r.prefPushed = true;
            const pd = await getDoc(env, "drivers", fr.prefDriver);
            if (pd) await pushTo(env, "driver", l10(pd.phone), { kind: "request", title: "⭐ راكبك الدائم · " + fr.fare + " ج", body: "المشوار اليومي ليك لوحدك ٣ دقايق — " + (fr.from && fr.from.label || "") + " ← " + (fr.to && fr.to.label || ""), url: "/driver.html", tag: "req" });
          } catch (e) {}
        }
        /* مشواره الحالي بالتفاصيل كاملة */
        const mineFull = requests
          .filter((r) => r.driverId === me.id && r.status === "assigned")
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0] || null;
        /* الكود والتوكنات متبعتش للسائق — لازم يسأل الراكب */
        const mine = mineFull ? (({ code, token, shareToken, riderPhone, bookerPhone, refBy, ...rest }) => rest)(mineFull) : null;
        if (mine && mine.multi && mine.startedAt) mine.meterV = meterView(mineFull, PR(await pricingCfg(env)), Date.now());

        const blocked = ss.state === "stopped";
        const zones = Array.isArray(me.zones) ? me.zones : [];
        const heading = me.heading && me.heading.day === todayStr() && me.heading.active ? me.heading : null;

        /* السباق: كل الطلبات المفتوحة معروضة على كل سائق أونلاين بلا مرسال.
           سواق المنطقة المفضّلة بيشوف الطلب على طول، والباقي بعد ٥ ثواني. */
        /* المشوار اليومي: سواق امبارح بيشوفه لوحده أول ٣ دقايق — بشرط يكون أونلاين وفاضي، غير كده بيفتح للكل على طول */
        const busyNow = busySet(requests), prefFree = {};
        for (const pid of new Set(requests.filter((r) => r.status === "pending" && r.prefDriver && r.prefDriver !== me.id).map((r) => r.prefDriver))) {
          const pd = await getDoc(env, "drivers", pid);
          prefFree[pid] = Boolean(pd && pd.active !== false && pd.online !== false && now - (pd.lastSeen || 0) < ONLINE_MS && !busyNow.has(pid));
        }
        const forMe = (r) => r.prefDriver === me.id;
        const prefHold = (r) => r.prefDriver && !forMe(r) && now - openAt(r) < PREF_MS && prefFree[r.prefDriver];
        const iso = await isolateOn(env);
        const open = (me.online === false || mine || blocked) ? [] : requests
          .filter((r) => r.status === "pending" && now >= openAt(r) && now - winAt(r) < CLAIM_WINDOW_MS)
          .filter((r) => !(r.skipDrivers || []).includes(me.id))
          .filter((r) => !iso || (me.reviewer ? Boolean(r.review) : !r.review))
          .filter((r) => !(r.offers || []).some((o) => o.d === me.id && !offerLive(o, now) && now - o.at < OFFER_TTL_MS + REOFFER_MS))
          .filter((r) => !prefHold(r))
          .filter((r) => forMe(r) || inReach(r, me, now - openAt(r)))
          .filter((r) => forMe(r) || now - openAt(r) >= PRIORITY_MS || zones.includes(r.from && r.from.zoneId));
        /* مشوار واحد بس: لو عنده مشوار شغال مابيشوفش طلبات تانية. والطلبات مترتبة من الأقرب لمكانه */
        const myLoc = me.loc && now - me.loc.at < LOC_FRESH_MS ? me.loc : null;
        const far = (r) => myLoc && r.from && isFinite(+r.from.lat) ? meters(r.from, myLoc) : Infinity;
        /* اللي مستني من ٥ دقايق أو أكتر (وفي حدود ٢ كم) بيطلع فوق — الأقدم الأول. الباقي من الأقرب */
        const waitOf = (r) => now - (r.scheduledAt ? openAt(r) : (r.createdAt || now));
        const urgent = (r) => waitOf(r) >= URGENT_MS && far(r) <= URGENT_M;
        const available = (mineFull ? [] : open)
          .filter((r) => !heading || (r.to && r.to.zoneId === heading.zoneId))
          .sort((a, b) => (urgent(b) - urgent(a)) || (urgent(a) && urgent(b) ? waitOf(b) - waitOf(a) : 0) || (far(a) - far(b)) || (openAt(b) - openAt(a)))
          .slice(0, 20)
          .map((r) => ({ ...teaser(r), forYou: forMe(r), distM: isFinite(far(r)) ? Math.round(far(r)) : null, waitMin: Math.floor(waitOf(r) / 60e3), urgent: urgent(r), offered: (r.offers || []).some((o) => o.d === me.id && offerLive(o, now)), offers: (r.offers || []).filter((o) => offerLive(o, now)).length }));
        const hidden = open.length - available.length;
        /* موافقاتي اللي عدّى عليها ٣٠ ثانية والراكب مااختارش حد */
        const noReply = requests.filter((r) => r.status === "pending" && (r.offers || []).some((o) => o.d === me.id && !offerLive(o, now) && now - o.at < OFFER_TTL_MS + 60e3)).map((r) => r.id);
        /* طلبات وافقت عليها والراكب لغاها — علشان التطبيق يقول «الراكب لغى» مش «اختار سائق تاني» */
        const cancelled = requests.filter((r) => r.status === "cancelled" && now - (r.cancelledAt || 0) < 3 * 60e3 && (r.offers || []).some((o) => o.d === me.id)).map((r) => r.id);

        const done = requests.filter((r) => r.driverId === me.id && r.status === "done" && r.day === todayStr());
        return json({
          me: { id: me.id, name: me.name, plate: me.plate, online: me.online !== false, zones, heading, ...tierOf(me) },
          sub: ss,
          available: blocked ? [] : available, mine, hidden, noReply, cancelled,
          today: { rides: done.length, earned: done.reduce((s, r) => s + (r.fare || 0), 0) },
        });
      }

      /* أرباحي + اشتراكي + تقييمي */
      if (sub === "stats" && method === "GET") {
        const { requests } = await readDocs(env, ["requests"]);
        const days = [];
        for (let i = 6; i >= 0; i--) {
          const d = addDays(todayStr(), -i);
          const list = requests.filter((r) => r.driverId === me.id && r.status === "done" && r.day === d);
          days.push({
            day: d, rides: list.length,
            earned: list.reduce((s, r) => s + (r.fare || 0) + (r.discount || 0), 0),
            cross: list.filter((r) => !r.sameZone).length,
          });
        }
        return json({
          name: me.name || "", photo: me.photo || "", plate: me.plate || "", village: me.village || "",
          days, rating: me.ratingCount ? +(me.ratingSum / me.ratingCount).toFixed(1) : null, ratingCount: me.ratingCount || 0, tier: tierOf(me).tier,
          /* آراء الركاب مجمّعة من غير أسماء — بتظهر بعد ٥ تقييمات فيها تعليقات (علشان مايعرفش مين قال إيه) */
          tagSummary: (me.tagRated || 0) >= 5 ? Object.entries(me.tagCount || {}).map(([t, n]) => ({ t, n, good: GOOD_TAGS.includes(t) })).sort((a, b) => (b.good - a.good) || (b.n - a.n)) : null,
          tagNeed: Math.max(0, 5 - (me.tagRated || 0)),
          sub: ss, paidLog: (me.creditLog || []).filter((x) => x.t === "topup").slice(-6).reverse(),
          zones: Array.isArray(me.zones) ? me.zones : [], heading: me.heading || null,
        });
      }

      /* مناطقي المفضّلة (لحد ٣) + رايح ناحية (مرتين في اليوم) */
      if (sub === "prefs" && method === "POST") {
        const b = await parseBody(request);
        if (Array.isArray(b.zones)) me.zones = b.zones.map((z) => str(z, 20)).filter(Boolean).slice(0, 3);
        if (b.heading !== undefined) {
          const t = todayStr();
          const h = me.heading && me.heading.day === t ? me.heading : { day: t, uses: 0 };
          if (b.heading && b.heading.zoneId) {
            if ((h.uses || 0) >= 2 && !(h.active && h.zoneId === b.heading.zoneId)) return json({ error: "استخدمت «رايح ناحية» مرتين النهارده" }, 409);
            me.heading = { day: t, zoneId: str(b.heading.zoneId, 20), active: true, uses: (h.active && h.zoneId === b.heading.zoneId) ? h.uses : (h.uses || 0) + 1 };
          } else {
            me.heading = { ...h, active: false };
          }
        }
        await putDoc(env, "drivers", me.id, me);
        return json({ ok: true, zones: me.zones || [], heading: me.heading || null });
      }

      if (sub === "claim" && method === "POST") {
        const b = await parseBody(request);
        const rid = str(b.requestId, 40);
        if (!rid) return json({ error: "طلب غير محدّد" }, 400);

        const { requests } = await readDocs(env, ["requests"]);
        if (requests.some((r) => r.driverId === me.id && r.status === "assigned"))
          return json({ error: "عندك مشوار شغّال — خلّصه الأول" }, 409);

        const r = await getDoc(env, "requests", rid);
        if (!r) return json({ error: "الطلب غير موجود" }, 404);
        if (r.status === "cancelled") return json({ error: "الراكب لغى الطلب" }, 409);
        if (Boolean(me.reviewer) !== Boolean(r.review) && (await isolateOn(env))) return json({ error: "الطلب غير موجود" }, 404);
        if (r.status !== "pending") return json({ error: "سائق تاني خد المشوار" }, 409);
        if (Date.now() < openAt(r)) return json({ error: "الطلب ده محجوز لبعدين" }, 409);
        if ((r.skipDrivers || []).includes(me.id)) return json({ error: "سبت المشوار ده قبل كده — استنى الطلب الجاي" }, 409);

        /* طلبات التطبيق: موافقة بس، والراكب هو اللي بيختار. طلبات التليفون (الإدارة): أول واحد ياخدها */
        if (r.source !== "phone") {
          const offers = Array.isArray(r.offers) ? r.offers : [];
          const mineO = offers.find((o) => o.d === me.id);
          if (mineO && !offerLive(mineO, Date.now()) && Date.now() - mineO.at < OFFER_TTL_MS + REOFFER_MS) return json({ error: "الراكب ماردّش على موافقتك — استنى الطلب الجاي" }, 409);
          if (mineO && offerLive(mineO, Date.now())) return json({ ok: true, offered: true });
          if (offers.filter((o) => offerLive(o, Date.now())).length >= MAX_OFFERS) return json({ error: "الراكب وصله موافقات كفاية" }, 409);
          if (mineO) {
            /* موافقة تانية بعد ما الطلب رجع ظهر: بنبدّل القديمة بجديدة */
            const myLoc2 = me.loc && Date.now() - me.loc.at < LOC_FRESH_MS ? me.loc : null;
            const o2 = { d: me.id, at: Date.now(), distM: myLoc2 && r.from && isFinite(+r.from.lat) ? Math.round(meters(r.from, myLoc2)) : null };
            const nx = { ...r, offers: offers.filter((o) => o.d !== me.id).concat([o2]) };
            const res2 = await env.DB.prepare(
              `UPDATE docs SET data=?, updated=? WHERE kind='requests' AND id=? AND json_extract(data,'$.status')='pending'`
            ).bind(JSON.stringify(nx), Date.now(), rid).run();
            if (!res2.meta || res2.meta.changes !== 1) return json({ error: "الطلب اتقفل" }, 409);
            return json({ ok: true, offered: true });
          }
          const myLoc = me.loc && Date.now() - me.loc.at < LOC_FRESH_MS ? me.loc : null;
          const o = { d: me.id, at: Date.now(), distM: myLoc && r.from && isFinite(+r.from.lat) ? Math.round(meters(r.from, myLoc)) : null };
          const res = await env.DB.prepare(
            `UPDATE docs SET data=json_insert(json_set(data,'$.offers',json(coalesce(json_extract(data,'$.offers'),'[]'))),'$.offers[#]',json(?)), updated=?
             WHERE kind='requests' AND id=? AND json_extract(data,'$.status')='pending'`
          ).bind(JSON.stringify(o), Date.now(), rid).run();
          if (!res.meta || res.meta.changes !== 1) return json({ error: "الطلب اتقفل" }, 409);
          if (!offers.length) try { await pushTo(env, "rider", l10(r.bookerPhone || r.riderPhone), { kind: "ride", title: "سواقين وافقوا على طلبك 🛺", body: "افتح واختار السائق اللي يناسبك", url: "/", tag: "ride-" + rid }); } catch (e) {}
          return json({ ok: true, offered: true });
        }

        /* القبول ذرّي: الشرط جوّه جملة UPDATE نفسها، فأول طلب يوصل للقاعدة هو الفائز */
        const next = { ...r, status: "assigned", driverId: me.id, assignedAt: Date.now() };
        const res = await env.DB.prepare(ASSIGN_SQL).bind(JSON.stringify(next), Date.now(), rid, rid, me.id).run();

        if (!res.meta || res.meta.changes !== 1) return json({ error: "سائق تاني خد المشوار" }, 409);
        await pushTo(env, "rider", l10(next.bookerPhone || next.riderPhone), { kind: "ride", title: me.name + " جاي ليك", body: "السعر " + next.fare + " ج — افتح علشان تشوفه على الخريطة", url: "/", tag: "ride-" + rid });
        return json({ ok: true, ride: (({ code, token, shareToken, riderPhone, bookerPhone, refBy, ...rest }) => rest)(next) });
      }

      /* السائق وصل عند الراكب — الراكب بيشوف arrivedAt من /api/track وبيجيله تنبيه + عدّاد ٣ دقايق */
      if (sub === "arrived" && method === "POST") {
        const b = await parseBody(request);
        const r = await getDoc(env, "requests", str(b.requestId, 40));
        if (!r) return json({ error: "الطلب غير موجود" }, 404);
        if (r.driverId !== me.id || r.status !== "assigned") return json({ error: "المشوار ده مش بتاعك" }, 403);
        if (r.startedAt) return json({ error: "الرحلة بدأت خلاص" }, 409);
        if (!r.arrivedAt) {
          await putDoc(env, "requests", r.id, { ...r, arrivedAt: Date.now() });
          await pushTo(env, "rider", l10(r.bookerPhone || r.riderPhone), { kind: "ride", title: "السائق وصل عندك 📍", body: me.name + " مستنيك — قدامك ٣ دقايق", url: "/", tag: "ride-" + r.id });
        }
        return json({ ok: true });
      }

      /* الراكب ماجاش: مسموح بس بعد ٣ دقايق من «وصلت»، ومفيش رسم بيتخصم */
      if (sub === "noshow" && method === "POST") {
        const b = await parseBody(request);
        const r = await getDoc(env, "requests", str(b.requestId, 40));
        if (!r) return json({ error: "الطلب غير موجود" }, 404);
        if (r.driverId !== me.id || r.status !== "assigned" || r.startedAt) return json({ error: "المشوار ده مش بتاعك" }, 403);
        if (!r.arrivedAt || Date.now() - r.arrivedAt < 3 * 60000 - 5000) return json({ error: "استنى لحد ما الـ ٣ دقايق يخلصوا" }, 409);
        await putDoc(env, "requests", r.id, { ...r, status: "cancelled", cancelReason: "noshow", cancelledAt: Date.now() });
        return json({ ok: true });
      }

      if (sub === "start" && method === "POST") {
        const b = await parseBody(request);
        const r = await getDoc(env, "requests", str(b.requestId, 40));
        if (!r) return json({ error: "الطلب غير موجود" }, 404);
        if (r.driverId !== me.id || r.status !== "assigned") return json({ error: "المشوار ده مش بتاعك" }, 403);
        if (r.codeOn) {
          /* ٥ محاولات غلط في كود الركوب ← يتقفل ربع ساعة */
          if ((r.codeFails || 0) >= 5 && Date.now() - (r.codeFailAt || 0) < 15 * 6e4) return json({ error: "الكود اتكتب غلط ٥ مرات — استنى ربع ساعة أو كلّم الإدارة" }, 429);
          if (!safeEqual(digits(b.code), String(r.code || ""))) {
            const now3 = Date.now();
            const row = await env.DB.prepare(`UPDATE docs SET data=json_set(data,
                '$.codeFails', CASE WHEN ?-IFNULL(json_extract(data,'$.codeFailAt'),0) < 900000 THEN IFNULL(json_extract(data,'$.codeFails'),0)+1 ELSE 1 END,
                '$.codeFailAt', ?) WHERE kind='requests' AND id=? AND json_extract(data,'$.status')='assigned' RETURNING json_extract(data,'$.codeFails') AS n`).bind(now3, now3, r.id).first();
            const n = +(row && row.n) || 1;
            return json({ error: "الكود غلط — اسأل الراكب تاني (فاضل " + Math.max(0, 5 - n) + ")" }, 400);
          }
        }
        if (r.startedAt) return json({ ok: true });
        const st = Date.now();
        if (!(await casReq(env, r, { ...r, startedAt: st, ...(r.multi ? { meter: { km: 0, last: me.loc ? { lat: me.loc.lat, lng: me.loc.lng, at: st } : null }, waits: [], waitOn: null } : {}) })))
          return json({ error: "المشوار اتغيّر — حدّث الصفحة" }, 409);
        if (r.multi) { me.meterId = r.id; await putDoc(env, "drivers", me.id, me); }
        const dd = me;
        try { await pushFam(env, r.bookerPhone || r.riderPhone, { type: "start", requestId: r.id, share: r.shareToken || "", driver: dd.name + (dd.plate ? " · لوحة " + dd.plate : ""), to: r.to && r.to.label }, true); } catch (e) {}
        return json({ ok: true });
      }

      if (sub === "finish" && method === "POST") {
        const b = await parseBody(request);
        const rid = str(b.requestId, 40);
        const r = await getDoc(env, "requests", rid);
        if (!r) return json({ error: "الطلب غير موجود" }, 404);
        if (r.driverId !== me.id) return json({ error: "المشوار ده مش بتاعك" }, 403);
        if (r.status !== "assigned") return json({ error: "المشوار اتقفل قبل كده" }, 409);
        /* بعد ما الراكب ركب مينفعش السائق يسيبه في نص الطريق — يكمّل أو يكلّم الإدارة */
        if (b.status === "released" && r.startedAt) return json({ error: "الراكب معاك خلاص — كمّل الرحلة أو كلّم الإدارة" }, 409);
        if (b.status !== "released" && !r.startedAt)
          return json({ error: r.codeOn ? "اكتب كود الركوب الأول علشان تبدأ الرحلة" : "دوس «ابدأ الرحلة» الأول" }, 409);
        /* الترك يرجّع الطلب للسباق بدل ما يضيع على الراكب */
        const next = b.status === "released"
          ? { ...r, status: "pending", driverId: "", assignedAt: null, startedAt: null, arrivedAt: null, offers: [], reopenedAt: Date.now(), skipDrivers: [...(r.skipDrivers || []), me.id].slice(-5) }
          : { ...r, status: "done", finishedAt: Date.now(), day: todayStr() };
        /* المشوار المتعدد: الأجرة النهائية من العدّاد */
        if (next.status === "done" && r.multi) {
          const nw = Date.now();
          if (next.waitOn) { next.waits = [...(next.waits || []), { s: next.waitOn.s, e: nw }]; next.waitOn = null; }
          const mv = meterView(next, PR(await pricingCfg(env)), nw); delete mv.waitOn; delete mv.weak;
          next.bill = mv; next.fare = mv.final;
        }
        /* نحجز القفلة الأول: لو دوستين وصلوا سوا، واحدة بس بتعدّي والتانية بترجع من غير ما تخصم حاجة */
        if (!(await casReq(env, r, next))) return json({ error: "المشوار اتقفل قبل كده" }, 409);
        if (next.status === "done" || b.status === "released") me.meterId = null;
        /* عدّادات المستوى: كام مشوار خلص وكام مرة ساب المشوار */
        try {
          if (next.status === "done" && r.status !== "done") me.rideCount = (me.rideCount || 0) + 1;
          if (b.status === "released") me.releaseCount = (me.releaseCount || 0) + 1;
          await putDoc(env, "drivers", me.id, me);
        } catch (e) {}
        /* المشوار اليومي: نفتكر مين وصّله — بكرة ياخد الأولوية */
        if (next.status === "done" && r.repeatId) {
          try { const rp = await getDoc(env, "repeats", r.repeatId); if (rp) { rp.lastDriverId = me.id; rp.lastDriverName = me.name; await putDoc(env, "repeats", rp.id, rp); } } catch (e) {}
        }
        /* نظام الرصيد: رسم المشوار بيتخصم مرة واحدة بس لما يخلص */
        if (next.status === "done" && !r.feeTaken && ss.state !== "free") {
          next.fee = sc.fee; next.feeTaken = true;
          const fresh = (await getDoc(env, "drivers", me.id)) || me;
          fresh.credit = +((+(fresh.credit || 0)) - sc.fee).toFixed(2);
          fresh.creditUsed = +((+(fresh.creditUsed || 0)) + sc.fee).toFixed(2);
          await putDoc(env, "drivers", me.id, fresh);
          /* أول ما الرصيد يدخل منطقة «قرب يخلص» (٣ مشاوير): إشعار واحد للسائق قبل ما يتقفل فجأة */
          try {
            const lowAt = Math.max(LOW_BAL, sc.fee * 3), was = fresh.credit + sc.fee;
            if (was > lowAt && fresh.credit <= lowAt) await pushTo(env, "driver", l10(fresh.phone), { kind: "credit", title: "رصيدك قرب يخلص",
              body: fresh.credit >= sc.fee ? "فاضل لك " + Math.floor(fresh.credit / sc.fee) + " مشوار — اشحن من الإدارة أو الوكيل" : "رصيدك خلص — اشحن علشان توصلك الطلبات", url: "/driver.html", tag: "credit" });
          } catch (e) {}
          /* نفس الرسم من رصيد الراكب (صاحب الحساب اللي طلب) — مش بيتضاف على الأجرة */
          if (r.source === "app") {
            const rk = riderKey(r.bookerPhone || r.riderPhone);
            if (rk.length >= 9) {
              const rd = (await getDoc(env, "riders", rk)) || { id: rk, phone: r.bookerPhone || r.riderPhone, name: r.riderName };
              rd.credit = +((+(rd.credit || 0)) - sc.fee).toFixed(2);
              rd.creditUsed = +((+(rd.creditUsed || 0)) + sc.fee).toFixed(2);
              await putDoc(env, "riders", rk, rd);
              next.riderFee = sc.fee;
            }
          }
        }
        await putDoc(env, "requests", rid, next);
        if (next.status === "done") { try { await pushFam(env, r.bookerPhone || r.riderPhone, { type: "done", requestId: r.id, to: r.to && r.to.label }, true); } catch (e) {} }
        /* كسب السائق النهارده (بيظهر له في آخر الرحلة) */
        let today = null;
        if (next.status === "done") {
          try {
            const { requests } = await readDocs(env, ["requests"]), dy = todayStr();
            const mine = requests.filter((x) => x.driverId === me.id && x.status === "done" && x.day === dy);
            if (!mine.some((x) => x.id === next.id)) mine.push(next);
            today = { rides: mine.length, km: +mine.reduce((t, x) => t + (+(x.bill ? x.bill.km : x.distKm) || 0), 0).toFixed(1),
              fare: mine.reduce((t, x) => t + (+x.fare || 0), 0), paidMin: mine.reduce((t, x) => t + ((x.bill && x.bill.paidMin) || 0), 0),
              waitCost: mine.reduce((t, x) => t + ((x.bill && x.bill.waitCost) || 0), 0) };
          } catch (e) {}
        }
        return json({ ok: true, status: next.status, fare: next.fare, bill: next.bill || null, today });
      }

      return json({ error: "غير موجود" }, 404);
    }

    /* ================= الإدارة ================= */

    if (route === "login" && method === "POST") {
      const b = await parseBody(request);
      if (!adminPass(env)) return json({ error: "الباسورد مش مضبوط على الخادم" }, 500);
      /* ١٠ محاولات غلط من نفس الجهاز ← يقف ١٥ دقيقة */
      const ipK = "adm-" + str(request.headers.get("cf-connecting-ip") || "x", 64).replace(/[^\w.:-]/g, "");
      const lf = (await getDoc(env, "loginfail", ipK)) || { id: ipK, n: 0, at: 0 };
      if (lf.n >= 10 && Date.now() - lf.at < 15 * 6e4) return json({ error: "محاولات كتير غلط — جرّب بعد ١٥ دقيقة" }, 429);
      const u = String(b.user || "").trim().toLowerCase();
      if (!safeEqual(u, adminUser(env)) || !safeEqual(b.pin, adminPass(env))) {
        await putDoc(env, "loginfail", ipK, { id: ipK, n: (Date.now() - lf.at < 15 * 6e4 ? lf.n : 0) + 1, at: Date.now() });
        return json({ error: "اسم المستخدم أو الباسورد غلط" }, 401);
      }
      if (lf.n) await putDoc(env, "loginfail", ipK, { id: ipK, n: 0, at: 0 });
      const at = tok() + tok(), ah = await sha(at);
      await putDoc(env, "adminsess", ah, { id: ah, at: Date.now(), exp: Date.now() + ADMIN_TTL, ua: str(request.headers.get("user-agent"), 160) });
      return json({ ok: true, token: at });
    }

    if (!(await adminOk(request, env))) return json({ error: "غير مصرّح" }, 401);

    if (route === "logout" && method === "POST") {
      try { await env.DB.prepare("DELETE FROM docs WHERE kind='adminsess' AND id=?").bind(await sha(request.headers.get("x-admin-token"))).run(); } catch (e) {}
      return json({ ok: true });
    }

    /* أوامر الإدارة على المشاوير — بنفس قواعد التطبيق (مفيش سائق في مشوارين، ومفيش كتابة فوق طلب اتغيّر) */
    if (route === "admin-assign" && method === "POST") {
      const b = await parseBody(request);
      const r = await getDoc(env, "requests", str(b.requestId, 40)), d = await getDoc(env, "drivers", str(b.driverId, 40));
      if (!r || !d) return json({ error: "الطلب أو السائق مش موجود" }, 404);
      if (r.status !== "pending") return json({ error: "الطلب ده اتاخد أو اتقفل — حدّث الصفحة" }, 409);
      if (d.active === false || d.hold) return json({ error: "السائق ده موقوف" }, 409);
      const next = await assignTo(env, { ...r, assignedBy: "admin" }, d);
      if (!next) return json({ error: "السائق ده في مشوار دلوقتي، أو الطلب اتاخد" }, 409);
      return json({ ok: true });
    }
    if (route === "admin-wipe" && method === "POST") {
      const b = await parseBody(request);
      const phone = digits(b.phone).slice(0, 15), p10 = l10(phone);
      if (p10.length < 9) return json({ error: "رقم غير صحيح" }, 400);
      if (b.role === "driver") {
        const { drivers } = await readDocs(env, ["drivers"]);
        const d = drivers.find((x) => l10(x.phone) === p10);
        if (!d) return json({ error: "مفيش سائق بالرقم ده" }, 404);
        const o = await wipeDriver(env, d);
        return o.error ? json({ error: o.error }, o.status) : json({ ok: true, cleared: o.rides });
      }
      const { requests } = await readDocs(env, ["requests"]);
      const out = await wipeRider(env, phone, requests.filter((x) => l10(x.riderPhone) === p10 || l10(x.bookerPhone) === p10));
      return json({ ok: true, ...out });
    }
    /* أرشيف المحذوفين (سنة) */
    if (route === "archive" && method === "GET") {
      archPurgedAt = 0; await purgeArchive(env);
      if (sub) { const a = await getDoc(env, "archive", str(sub, 80)); return a ? json(a) : json({ error: "مش موجود" }, 404); }
      const { results } = await env.DB.prepare("SELECT data FROM docs WHERE kind='archive' ORDER BY updated DESC LIMIT 500").all();
      return json({ items: (results || []).map((x) => { const a = JSON.parse(x.data); return { id: a.id, role: a.role, phone: a.phone, name: a.name, at: a.at, exp: a.exp, rides: (a.rides || []).length }; }) });
    }
    /* حساب مراجعة جوجل: راكب + سائق تجريبيين، كود السائق ثابت ومابيخلصش، ومابيشوفوش غير بعض */
    if (route === "admin-review" && method === "POST") {
      const b = await parseBody(request);
      /* bypass = راكب المراجعة يدخل من غير واتساب (لجوجل) · isolate = طلبات المراجعة معزولة عن السواقين الحقيقيين */
      const bypass = b.bypass !== false, isolate = b.isolate !== false;
      const rp = bypass ? digits(b.riderPhone) : "", dp = digits(b.driverPhone);
      if ((bypass && rp.length !== 11) || dp.length !== 11 || (bypass && rp === dp)) return json({ error: bypass ? "اكتب رقمين مختلفين (١١ رقم)" : "اكتب رقم السائق (١١ رقم)" }, 400);
      const { drivers } = await readDocs(env, ["drivers"]);
      const clash = drivers.find((d) => l10(d.phone) === l10(dp) && !d.reviewer);
      if (clash) return json({ error: "رقم السائق ده متسجّل لسائق حقيقي" }, 409);
      /* رقم الراكب التجريبي (اللي بيدخل من غير واتساب) لازم يبقى جديد خالص — مالوش أي رحلات أو حساب حقيقي */
      const cfgOld = await getDoc(env, "config", "review");
      if (bypass && (!cfgOld || l10(cfgOld.riderPhone) !== l10(rp))) {
        const used = await env.DB.prepare("SELECT 1 FROM docs WHERE (kind='riders' AND id=?) OR (kind='requests' AND (substr(json_extract(data,'$.riderPhone'),-10)=? OR substr(json_extract(data,'$.bookerPhone'),-10)=?)) OR (kind='sessions' AND json_extract(data,'$.phone')=?) LIMIT 1").bind(l10(rp), l10(rp), l10(rp), l10(rp)).first();
        if (used || drivers.some((d) => l10(d.phone) === l10(rp))) return json({ error: "رقم الراكب ده اتاستخدم قبل كده — استخدم رقم جديد خالص" }, 409);
      }
      const st = [];
      /* أي تغيير (إيقاف، أو رقم راكب جديد، أو قفل «من غير واتساب»): جلسات رقم المراجعة القديم كلها بتتلغي،
         علشان مايفضلش داخل ويتحسب راكب عادي */
      if (cfgOld && cfgOld.riderPhone && (b.on === false || !bypass || l10(cfgOld.riderPhone) !== l10(rp)))
        st.push(env.DB.prepare("DELETE FROM docs WHERE kind='sessions' AND json_extract(data,'$.phone')=?").bind(l10(cfgOld.riderPhone)));
      const old = drivers.find((d) => d.reviewer) || {};
      const code = old.code || String(1000 + (crypto.getRandomValues(new Uint16Array(1))[0] % 9000));
      const kick = b.on === false || (old.phone && l10(old.phone) !== l10(dp));
      const d = { ...old, id: old.id || "review-driver", name: str(b.driverName, 60) || old.name || "سائق التجربة", phone: dp, plate: str(b.plate, 20) || old.plate || "TEST", code, reviewer: true, active: b.on !== false, online: false, ...(kick ? { sess: null } : {}), createdAt: old.createdAt || Date.now(), joinedAt: old.joinedAt || Date.now() };
      const isoOffAt = isolate ? 0 : (cfgOld && cfgOld.isolate === false && cfgOld.isoOffAt ? cfgOld.isoOffAt : Date.now());
      st.push(putSt(env, "drivers", d.id, d));
      st.push(putSt(env, "config", "review", { id: "review", on: b.on !== false, bypass, isolate, isoOffAt, riderPhone: bypass ? rp : "", driverPhone: dp, at: Date.now() }));
      /* السائق والإعدادات بيتحفظوا مع بعض — يا الاتنين يا ولا حاجة */
      await env.DB.batch(st);
      return json({ ok: true, riderPhone: bypass ? rp : "", driverPhone: dp, code, on: b.on !== false, bypass, isolate, isoUntil: isoOffAt ? isoOffAt + ISO_OFF_MS : 0 });
    }
    /* إنهاء فترة التجربة: الحسابات (ركاب وسواقين) بتفضل زي ما هي ويطلبوا ويستقبلوا عادي،
       والسجل بيتمسح: المشاوير والشات والبلاغات والتقييمات والمشاوير المحفوظة. والعزل بيرجع يشتغل */
    if (route === "admin-trial-end" && method === "POST") {
      const b = await parseBody(request);
      if (b.confirm !== "امسح") return json({ error: "اكتب «امسح» للتأكيد" }, 400);
      const busy = await env.DB.prepare("SELECT 1 FROM docs WHERE kind='requests' AND json_extract(data,'$.status')='assigned' LIMIT 1").first();
      if (busy) return json({ error: "في مشوار شغال دلوقتي — استنى لما يخلص" }, 409);
      const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM docs WHERE kind='requests'").first();
      const cfgR = await getDoc(env, "config", "review");
      const now = Date.now();
      await env.DB.batch([
        env.DB.prepare("DELETE FROM docs WHERE kind IN ('requests','chat','reports','famalerts','repeats','rated','reqkey','rl')"),
        env.DB.prepare("UPDATE docs SET data=json_remove(json_set(data,'$.ratingSum',0,'$.ratingCount',0,'$.rideCount',0,'$.releaseCount',0,'$.tagRated',0),'$.lastConfirmedReport','$.tagCount','$.redBy','$.redAlert','$.reviews'), updated=? WHERE kind='drivers'").bind(now),
        ...(cfgR ? [putSt(env, "config", "review", { ...cfgR, isolate: true, isoOffAt: 0, at: now })] : []),
        putSt(env, "config", "trialEnd", { id: "trialEnd", at: now, rides: (cnt && cnt.n) || 0 }),
      ]);
      return json({ ok: true, rides: (cnt && cnt.n) || 0 });
    }
    if (route === "admin-cancel" && method === "POST") {
      const b = await parseBody(request);
      const r = await getDoc(env, "requests", str(b.requestId, 40));
      if (!r) return json({ error: "الطلب مش موجود" }, 404);
      if (r.status === "done" || r.status === "cancelled") return json({ error: "المشوار اتقفل قبل كده" }, 409);
      const next = { ...r, status: "cancelled", cancelReason: "admin", cancelNote: str(b.reason, 140), cancelledBy: "admin", cancelledAt: Date.now() };
      if (!(await casReq(env, r, next))) return json({ error: "المشوار اتغيّر — حدّث الصفحة وجرّب تاني" }, 409);
      if (r.driverId) { try { const d = await getDoc(env, "drivers", r.driverId); if (d) { if (d.meterId === r.id) { d.meterId = null; await putDoc(env, "drivers", d.id, d); } await pushTo(env, "driver", l10(d.phone), { kind: "ride", title: "المشوار اتلغى من الإدارة", body: (r.from && r.from.label) || "", url: "/driver.html", tag: "ride-" + r.id }); } } catch (e) {} }
      try { await pushTo(env, "rider", l10(r.bookerPhone || r.riderPhone), { kind: "ride", title: "المشوار اتلغى", body: "الإدارة لغت المشوار — لو محتاج حاجة كلّمنا", url: "/", tag: "ride-" + r.id }); } catch (e) {}
      return json({ ok: true });
    }
    /* استرجاع نسخة احتياطية: بيرجّع الناقص بس. أي سجل موجود دلوقتي بيفضل زي ما هو (التذاكر، المشاوير الشغالة، الأرصدة).
       dry = بيقول هيرجّع كام من غير ما يكتب حاجة */
    if (route === "restore" && method === "POST") {
      const raw = await request.text();
      if (raw.length > 8e6) return json({ error: "الملف كبير" }, 413);
      let b; try { b = JSON.parse(raw); } catch (e) { return json({ error: "الملف مش نسخة صحيحة" }, 400); }
      if (!b || b.app !== "el-mahatta") return json({ error: "الملف ده مش نسخة من المحطة" }, 400);
      const dry = Boolean(b.dry), have = {}, plan = {};
      for (const k of KINDS) {
        const { results } = await env.DB.prepare("SELECT id FROM docs WHERE kind=?").bind(k).all();
        have[k] = new Set((results || []).map((x) => x.id));
        const arr = (Array.isArray(b[k]) ? b[k] : (k === "config" && b.configDocs) || []).filter((x) => x && typeof x === "object" && !Array.isArray(x) && typeof x.id === "string" && x.id && x.id.length <= 80);
        const seen = new Set();
        plan[k] = { add: arr.filter((x) => !have[k].has(x.id) && !seen.has(x.id) && seen.add(x.id)), keep: arr.filter((x) => have[k].has(x.id)).length };
      }
      const summary = {}; let add = 0, keep = 0;
      for (const k of KINDS) { summary[k] = { add: plan[k].add.length, keep: plan[k].keep }; add += plan[k].add.length; keep += plan[k].keep; }
      if (dry) return json({ ok: true, dry: true, add, keep, summary, at: str(b.at, 40) });
      const stmts = [];
      for (const k of KINDS) for (const x of plan[k].add) {
        const y = { ...x };
        if (k === "requests") { if (!y.token) y.token = newToken(); delete y.reqKey; if (y.status === "pending" || y.status === "assigned") { y.status = "cancelled"; y.cancelReason = "restored"; y.cancelledAt = Date.now(); } }
        if (k === "drivers") { delete y.sess; y.codeUsed = true; delete y.isOnline; }
        stmts.push(env.DB.prepare("INSERT OR IGNORE INTO docs (kind,id,data,updated) VALUES (?,?,?,?)").bind(k, y.id, JSON.stringify(y), Date.now()));
      }
      for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
      const lid = uid();
      await putDoc(env, "restorelog", lid, { id: lid, at: Date.now(), from: str(b.at, 40), add, keep, summary });
      return json({ ok: true, count: add, keep });
    }

    /* مساعد الإدارة (AI): بيقرا إحصائيات من غير أسامي أو أرقام ركاب، وبيقترح تغييرات في إعدادات البورتال بس.
       التنفيذ بيحصل من البورتال بعد ما الإدارة تدوس «موافق» — المساعد نفسه مابيغيّرش حاجة */
    if (route === "ai" && method === "POST") {
      if (!env.ANTHROPIC_API_KEY) return json({ error: "مفتاح الـ AI مش متضبط — ضيف ANTHROPIC_API_KEY في Cloudflare" }, 400);
      const b = await parseBody(request);
      const msgs = (Array.isArray(b.messages) ? b.messages : []).slice(-12)
        .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: str(m.content, 2000) })).filter((m) => m.content);
      if (!msgs.length || msgs[msgs.length - 1].role !== "user") return json({ error: "اكتب سؤالك" }, 400);
      const { drivers, requests, reports, zones, places, config } = await readDocs(env, ["drivers", "requests", "reports", "zones", "places", "config"]);
      const now = Date.now(), day = todayStr(), wk = now - 7 * 864e5;
      const pricing = (config || []).find((c) => c.id === "pricing") || {};
      const recent = requests.filter((r) => (r.createdAt || 0) > now - 30 * 864e5);
      const cnt = (arr, f) => arr.reduce((a, x) => { const k = f(x); if (k) a[k] = (a[k] || 0) + 1; return a; }, {});
      const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
      const stats = {
        now: new Date(now).toISOString(), today: day,
        pricing: { same: pricing.same, cross: pricing.cross, cutKm: pricing.cutKm, outPerKm: pricing.outPerKm, outKm: pricing.outKm },
        zones: zones.map((z) => ({ id: z.id, name: z.name, same: z.same ?? null, cross: z.cross ?? null })),
        places: { total: places.length, noLocation: places.filter((p) => p.lat == null).length },
        rides: {
          today: cnt(requests.filter((r) => r.day === day || new Date(r.createdAt || 0).toISOString().slice(0, 10) === day), (r) => r.status),
          last7days: cnt(requests.filter((r) => (r.createdAt || 0) > wk), (r) => r.status),
          last30days: cnt(recent, (r) => r.status),
          cancelReasons30d: cnt(recent.filter((r) => r.status === "cancelled"), (r) => r.cancelReason || "other"),
          outsideShare30d: recent.length ? +(recent.filter((r) => r.outside).length / recent.length).toFixed(2) : 0,
          avgFare30d: recent.length ? Math.round(recent.reduce((a, r) => a + (+r.fare || 0), 0) / recent.length) : 0,
          byHour30d: cnt(recent, (r) => String(new Date((r.createdAt || 0) + 2 * 36e5).getUTCHours())),
          topDestinations30d: top(cnt(recent, (r) => r.to && r.to.label), 10),
          topPickups30d: top(cnt(recent, (r) => r.from && r.from.label), 10),
        },
        drivers: drivers.map((d) => {
          const mine = recent.filter((r) => r.driverId === d.id);
          return { name: name2(d.name), plate: d.plate || "", active: d.active !== false, online: d.online !== false, hold: Boolean(d.hold),
            done30d: mine.filter((r) => r.status === "done").length, released30d: d.released || 0,
            rating: d.ratingAvg || d.rating || null, ...tierOf(d) };
        }),
        reports: reports.filter((r) => r.status === "open").map((r) => ({ kind: r.kind, asked: r.asked || 0, fare: r.fare, driver: name2((drivers.find((d) => d.id === r.driverId) || {}).name || ""), note: str(r.note, 200), at: new Date(r.createdAt || 0).toISOString().slice(0, 10) })),
      };
      const system = `إنت مساعد إدارة «المحطة» — تطبيق توكتوك في مدينة كفر صقر (الشرقية، مصر). بترد بالعامية المصرية، باختصار ووضوح، والأرقام بالأرقام العربية العادية.
قواعد:
- اعتمد على البيانات اللي تحت بس. لو المعلومة مش موجودة قول كده ومتألفش.
- مفيش أي أسامي أو أرقام ركاب في البيانات، ومتطلبهاش.
- لو الإدارة طلبت تغيير في التسعير أو سعر منطقة، استخدم أداة propose_change. ده اقتراح بس — الإدارة هي اللي بتوافق.
- مش بتقدر تعدّل كود التطبيق ولا توقف سواقين ولا تمسح حاجة. لو اتطلب منك كده قول إن ده بيتعمل يدوي من البورتال أو مع المطوّر.
- الأجرة برا المدينة = الكيلو × سعر الكيلو، وبتتقرّب لفوق لأقرب ٥ ج، ومتقلش عن سعر المشوار الطويل.
البيانات (JSON):
${JSON.stringify(stats)}`;
      const tools = [{
        name: "propose_change",
        description: "اقتراح تغيير في إعدادات البورتال. مابيتنفذش غير بعد موافقة الإدارة.",
        input_schema: { type: "object", properties: {
          summary: { type: "string", description: "شرح التغيير بالعامية في سطر" },
          pricing: { type: "object", properties: { same: { type: "number" }, cross: { type: "number" }, cutKm: { type: "number" }, outPerKm: { type: "number" }, outKm: { type: "number" } } },
          zones: { type: "array", description: "سعر خاص لمنطقة: same = مشوار قصير، cross = مشوار طويل", items: { type: "object", properties: { id: { type: "string" }, same: { type: "number" }, cross: { type: "number" } }, required: ["id"] } },
        }, required: ["summary"] },
      }];
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: env.AI_MODEL || "claude-sonnet-4-5", max_tokens: 1200, system, tools, messages: msgs }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) return json({ error: "الـ AI مش راد: " + ((out.error && out.error.message) || res.status) }, 502);
      const text = (out.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
      const prop = (out.content || []).find((c) => c.type === "tool_use" && c.name === "propose_change");
      let proposal = null;
      if (prop && prop.input) {
        const p = prop.input, okNum = (v, lo, hi) => typeof v === "number" && isFinite(v) && v >= lo && v <= hi;
        const pr = {};
        if (p.pricing) for (const [k, lo, hi] of [["same", 1, 500], ["cross", 1, 500], ["cutKm", 0.3, 20], ["outPerKm", 0.5, 100], ["outKm", 0.3, 20]]) if (okNum(p.pricing[k], lo, hi)) pr[k] = p.pricing[k];
        const zs = (p.zones || []).filter((z) => zones.some((x) => x.id === z.id) && (okNum(z.same, 1, 500) || okNum(z.cross, 1, 500)))
          .map((z) => ({ id: z.id, name: zones.find((x) => x.id === z.id).name, ...(okNum(z.same, 1, 500) ? { same: Math.round(z.same) } : {}), ...(okNum(z.cross, 1, 500) ? { cross: Math.round(z.cross) } : {}) }));
        if (Object.keys(pr).length || zs.length) proposal = { summary: str(p.summary, 300), pricing: Object.keys(pr).length ? pr : null, zones: zs };
      }
      return json({ text: text || (proposal ? proposal.summary : "—"), proposal });
    }

    if (route === "phone-request" && method === "POST") {
      const pb = await parseBody(request);
      const again = await onceReq(env, pb.reqKey);
      if (again) return again.error ? json({ error: again.error }, again.status) : json(again);
      const out = await createOnce(env, pb, "phone");
      return out.error ? json({ error: out.error }, out.status) : json(out);
    }

    if (route === "consents" && method === "GET") {
      const { consents } = await readDocs(env, ["consents"]);
      consents.sort((a, b) => (b.serverAt || 0) - (a.serverAt || 0));
      return json({ consents });
    }

    if (route === "state" && method === "GET") {
      const all = await readDocs(env, KINDS);
      const now = Date.now();
      await purgeArchive(env);
      try { await expireStale(env, all.requests || []); } catch (e) {}
      /* مابنبعتش للبورتال تذاكر الدخول ولا توكن الراكب */
      all.drivers = all.drivers.map(({ sess, ...d }) => ({
        ...d, isOnline: d.online !== false && now - (d.lastSeen || 0) < ONLINE_MS,
      }));
      all.requests = (all.requests || []).map(({ token, reqKey, ...r }) => r);
      return json(all);
    }

    if (route === "doc") {
      const kind = sub, id = third;
      if (!KINDS.includes(kind) || !id) return json({ error: "مسار غير صحيح" }, 400);
      if (method === "PUT") {
        const b = await parseBody(request);
        if (!b || typeof b !== "object" || Array.isArray(b)) return json({ error: "بيانات غير صحيحة" }, 400);
        b.id = id;
        /* المشاوير: الإدارة تقدر تكتب ملاحظة بس — الأجرة والحالة والسائق والعدّاد مابيتغيّروش غير بأوامر السيرفر */
        if (kind === "requests") {
          const old = await getDoc(env, "requests", id);
          if (!old) return json({ error: "الطلب مش موجود" }, 404);
          await env.DB.prepare("UPDATE docs SET data=json_set(data,'$.adminNote',?,'$.adminNoteAt',?), updated=? WHERE kind='requests' AND id=?").bind(str(b.adminNote, 300), Date.now(), Date.now(), id).run();
          return json({ ok: true });
        }
        if (kind === "drivers") {
          /* رقم موبايل واحد ورقم قومي واحد لكل سائق */
          const { drivers: others } = await readDocs(env, ["drivers"]);
          const ph = l10(b.phone), nid = digits(b.nid);
          if (b.nid && nid.length !== 14) return json({ error: "الرقم القومي لازم يكون ١٤ رقم" }, 400);
          if (b.nid) b.nid = nid;
          const dupP = ph.length >= 10 && others.find((d) => d.id !== id && l10(d.phone) === ph);
          if (dupP) return json({ error: "رقم الموبايل ده متسجّل لسائق تاني: " + (dupP.name || "") }, 409);
          const dupN = nid && others.find((d) => d.id !== id && digits(d.nid) === nid);
          if (dupN) return json({ error: "الرقم القومي ده متسجّل لسائق تاني: " + (dupN.name || "") }, 409);
          const old = (await getDoc(env, "drivers", id)) || {};
          for (const k of DRIVER_SERVER_KEYS) {
            if (b[k] === null) delete b[k];
            else if (b[k] === undefined && old[k] !== undefined) b[k] = old[k];
          }
        }
        await putDoc(env, kind, id, b);
        return json({ ok: true });
      }
      if (method === "DELETE") {
        if (kind === "requests") return json({ error: "المشاوير مابتتمسحش — الغيها بس" }, 409);
        if (kind === "drivers") return json({ error: "حذف السائق بيتعمل من زرار «حذف» في كارته (بيروح للأرشيف)" }, 409);
        await env.DB.prepare("DELETE FROM docs WHERE kind=? AND id=?").bind(kind, id).run();
        return json({ ok: true });
      }
    }

    return json({ error: "غير موجود" }, 404);
  } catch (err) {
    const big = err && err.message === "too_large";
    return json({ error: big ? "حجم البيانات كبير" : "خطأ في الخادم" }, big ? 413 : 500);
  }
}
