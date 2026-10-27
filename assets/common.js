/* أدوات مشتركة بين صفحة الراكب وصفحة الإدارة */
(function (global) {
  "use strict";

  var ZC = ["#0E7566", "#BC4E1E", "#3F6DA8", "#8A5A9E", "#6E8B2E", "#B08A17", "#A9382B", "#4E7D74", "#2F7F8C", "#96602A"];

  /* مركز افتراضي للخريطة — بتروح لمكان الراكب أو الأماكن المسجّلة تلقائياً */
  var CENTER = [30.7964, 31.6261];
  /* الموبايلات الضعيفة أو «توفير البيانات»: الحركة بتخف لوحدها */
  try {
    var nv = navigator, cn = nv.connection || {};
    if ((nv.deviceMemory && nv.deviceMemory <= 2) || (nv.hardwareConcurrency && nv.hardwareConcurrency <= 2) || cn.saveData) document.documentElement.classList.add("lite");
  } catch (e) {}

  var T = {
    $: function (id) { return document.getElementById(id); },

    esc: function (s) {
      return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
      });
    },

    uid: function () { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); },

    today: function () { return new Date().toISOString().slice(0, 10); },

    daysTo: function (d) {
      if (!d) return null;
      return Math.round((new Date(d + "T00:00:00") - new Date(T.today() + "T00:00:00")) / 864e5);
    },

    timeAgo: function (ts) {
      if (!ts) return "";
      var m = Math.max(0, Math.round((Date.now() - ts) / 6e4));
      if (m < 1) return "الآن";
      if (m < 60) return "من " + m + " د";
      return "من " + Math.round(m / 60) + " س";
    },

    /* رقم مصري إلى صيغة واتساب الدولية */
    waNum: function (p) {
      var d = String(p || "").replace(/\D/g, "");
      if (d.indexOf("0") === 0) d = "20" + d.slice(1);
      else if (d.indexOf("20") !== 0 && d.length === 10) d = "20" + d;
      return d;
    },

    byId: function (arr, id) {
      for (var i = 0; i < (arr || []).length; i++) if (arr[i].id === id) return arr[i];
      return null;
    },

    zoneColor: function (zones, zid) {
      for (var i = 0; i < (zones || []).length; i++) if (zones[i].id === zid) return ZC[i % ZC.length];
      return "#798782";
    },

    zoneName: function (zones, zid) {
      var z = T.byId(zones, zid);
      return z ? z.name : "بدون منطقة";
    },

    /* السعر يُعرض هنا للمستخدم؛ الخادم يعيد حسابه عند التأكيد ولا يثق بالعميل */
    fareFor: function (state, fromId, toId) {
      var a = T.byId(state.places, fromId), b = T.byId(state.places, toId);
      var cfg = state.cfg || { same: 10, cross: 15 };
      if (!a || !b) return { amount: cfg.cross, same: false, known: false };
      if (a.lat != null && b.lat != null && isFinite(+a.lat) && isFinite(+b.lat)) {
        var sh = T.dist({ lat: +a.lat, lng: +a.lng }, { lat: +b.lat, lng: +b.lng }) * 1.3 <= (+cfg.cutKm > 0 ? +cfg.cutKm : 2);
        return { amount: sh ? cfg.same : cfg.cross, same: sh, known: true };
      }
      var same = Boolean(a.zoneId && b.zoneId && a.zoneId === b.zoneId);
      return { amount: same ? cfg.same : cfg.cross, same: same, known: Boolean(a.zoneId && b.zoneId) };
    },

    mapsUrl: function (from, to) {
      var sfx = "، مصر";
      var o = from ? (from.lat != null ? from.lat + "," + from.lng : from.name + sfx) : "";
      var d = to ? (to.lat != null ? to.lat + "," + to.lng : to.name + sfx) : "";
      return "https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=" +
        encodeURIComponent(o) + "&destination=" + encodeURIComponent(d);
    },

    toast: function (msg) {
      var el = document.createElement("div");
      el.className = "toast";
      el.setAttribute("role", "status");
      el.textContent = msg;
      document.body.appendChild(el);
      setTimeout(function () { el.remove(); }, 2600);
    },

    /* ---------- الاتصال بالخادم ---------- */
    api: function (path, opts) {
      opts = opts || {};
      var headers = { "content-type": "application/json" };
      if (opts.pin) headers["x-pin"] = opts.pin;
      if (opts.user) headers["x-user"] = encodeURIComponent(opts.user);
      if (opts.verify && T.verify) {
        var v = opts.verify; delete opts.verify;
        return T.verify(v.phone, v.role).then(function (tok) { opts.session = tok; return T.api(path, opts); });
      }
      if (opts.session) headers["x-session"] = opts.session;
      /* النت الضعيف: لو الطلب ماوصلش خالص بنحاول تاني مرتين لوحدنا */
      var tries = opts.retry === false ? 0 : 2, method = opts.method || "GET";
      function send(n) {
        return fetch("/api/" + path, { method: method, headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
          .catch(function (e) {
            if (n >= tries) throw Object.assign(new Error("النت ضعيف أو مقطوع — اتأكد من الاتصال وجرّب تاني"), { network: true });
            if (method !== "GET" && T.toast) T.toast("النت ضعيف… بنحاول تاني");
            return new Promise(function (ok) { setTimeout(ok, 1500 * (n + 1)); }).then(function () { return send(n + 1); });
          });
      }
      return send(0).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) {
            if (j.reverify && T.clearSession) T.clearSession(j.reverify);
            throw Object.assign(new Error(j.error || "خطأ"), { status: r.status });
          }
          return j;
        });
      });
    },

    /* يحوّل رد الخادم إلى شكل الحالة المستخدم في الصفحات */
    shape: function (raw) {
      var cfgDoc = (raw.config || []).filter(function (c) { return c.id === "pricing"; })[0];
      return {
        zones: raw.zones || [],
        places: raw.places || [],
        drivers: raw.drivers || [],
        requests: raw.requests || [],
        cfg: {
          same: cfgDoc && cfgDoc.same != null ? cfgDoc.same : 10,
          cross: cfgDoc && cfgDoc.cross != null ? cfgDoc.cross : 15,
          cutKm: cfgDoc && +cfgDoc.cutKm > 0 ? +cfgDoc.cutKm : 2,
          outKm: cfgDoc && +cfgDoc.outKm > 0 ? +cfgDoc.outKm : 1.5,
          outPerKm: cfgDoc && +cfgDoc.outPerKm > 0 ? +cfgDoc.outPerKm : 7.5,
          sub: cfgDoc && cfgDoc.sub != null ? cfgDoc.sub : 200,
          freeUntil: (cfgDoc && cfgDoc.freeUntil) || "",
          paidFrom: (cfgDoc && cfgDoc.paidFrom) || "",
          week: cfgDoc && cfgDoc.week != null ? cfgDoc.week : 30,
          month: cfgDoc && cfgDoc.month != null ? cfgDoc.month : 100,
          grace: cfgDoc && cfgDoc.grace != null ? cfgDoc.grace : 3,
          creditPaused: !(cfgDoc && cfgDoc.creditOn === true),
          creditOn: Boolean(cfgDoc && cfgDoc.creditOn === true),
          creditOnAt: cfgDoc && +cfgDoc.creditOnAt || 0,
          tripFee: cfgDoc && +cfgDoc.tripFee > 0 ? +cfgDoc.tripFee : 1,
          adminPhone: (cfgDoc && cfgDoc.adminPhone) || "",
        },
      };
    },

    /* ---------- الخريطة ---------- */
    CENTER: CENTER,

    initMap: function (elId) {
      var map = L.map(elId, { scrollWheelZoom: false }).setView(CENTER, 15);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);
      map.on("focus", function () { map.scrollWheelZoom.enable(); });
      map.on("blur", function () { map.scrollWheelZoom.disable(); });
      return map;
    },

    markerIcon: function (color, big) {
      var s = big ? 20 : 13;
      return L.divIcon({
        className: "", iconSize: [s, s], iconAnchor: [s / 2, s / 2],
        html: '<div class="mk" style="width:' + s + 'px;height:' + s + 'px;background:' + color + '"></div>',
      });
    },

    /**
     * يرسم النقاط والمسار على الخريطة.
     * ترجع عدد النقاط التي لها إحداثيات.
     */
    drawTrip: function (ctx) {
      var map = ctx.map, state = ctx.state;
      var from = T.byId(state.places, ctx.fromId), to = T.byId(state.places, ctx.toId);

      (ctx.layers || []).forEach(function (l) { map.removeLayer(l); });
      ctx.layers = [];

      var placed = state.places.filter(function (p) { return p.lat != null && p.lng != null; });
      placed.forEach(function (p) {
        var on = (from && p.id === from.id) || (to && p.id === to.id);
        var m = L.marker([p.lat, p.lng], {
          icon: T.markerIcon(T.zoneColor(state.zones, p.zoneId), on),
          title: p.name,
          opacity: on ? 1 : 0.8,
          keyboard: false,
        }).addTo(map);
        m.bindTooltip(p.name, { direction: "top", offset: [0, -9] });
        if (ctx.onPick) m.on("click", function () { ctx.onPick(p.id); });
        ctx.layers.push(m);
      });

      var a = from && from.lat != null ? from : null;
      var b = to && to.lat != null ? to : null;
      if (a && b && a !== b) {
        var f = T.fareFor(state, ctx.fromId, ctx.toId);
        var line = L.polyline([[a.lat, a.lng], [b.lat, b.lng]], {
          color: f.same ? "#0E7566" : "#BC4E1E", weight: 4, opacity: 0.9,
        }).addTo(map);
        ctx.layers.push(line);
        var mid = L.marker([(a.lat + b.lat) / 2, (a.lng + b.lng) / 2], {
          interactive: false,
          icon: L.divIcon({
            className: "", iconSize: [54, 22], iconAnchor: [27, 11],
            html: '<div style="background:#fff;color:' + (f.same ? "#0E7566" : "#BC4E1E") +
              ';border:1.5px solid currentColor;border-radius:11px;text-align:center;font:700 12px/20px system-ui">' +
              f.amount + ' ج</div>',
          }),
        }).addTo(map);
        ctx.layers.push(mid);
        map.fitBounds(line.getBounds(), { padding: [42, 42], maxZoom: 17 });
      } else if (placed.length) {
        map.fitBounds(L.latLngBounds(placed.map(function (p) { return [p.lat, p.lng]; })), { padding: [34, 34], maxZoom: 16 });
      }
      return placed.length;
    },
  };

  /* ---------- المسار على الطرق (OSRM — مجاني) + المسافة ---------- */
  T.dist = function (a, b) {
    var R = 6371, toR = Math.PI / 180, dLa = (b.lat - a.lat) * toR, dLo = (b.lng - a.lng) * toR;
    var x = Math.sin(dLa / 2) * Math.sin(dLa / 2) + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 2 * R * Math.asin(Math.sqrt(x));
  };
  var RC = {};
  /* بيرجّع { coords:[[lat,lng]…], km, min, road } — لو الخدمة وقعت بيرجّع خط مستقيم */
  T.route = function (a, b) {
    var k = [a.lat, a.lng, b.lat, b.lng].map(function (x) { return (+x).toFixed(4); }).join(",");
    if (RC[k]) return RC[k];
    var km = T.dist(a, b) * 1.3;
    var straight = { coords: [[a.lat, a.lng], [b.lat, b.lng]], km: km, min: Math.max(2, Math.round(km / 15 * 60) + 1), road: false };
    RC[k] = fetch("https://router.project-osrm.org/route/v1/driving/" + a.lng + "," + a.lat + ";" + b.lng + "," + b.lat + "?overview=full&geometries=geojson")
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var rt = j && j.routes && j.routes[0]; if (!rt) throw new Error("no route");
        /* التوكتوك أبطأ من العربية — ×١.٤ على الوقت */
        var out = { coords: rt.geometry.coordinates.map(function (p) { return [p[1], p[0]]; }), km: rt.distance / 1000, min: Math.max(2, Math.round(Math.max(rt.duration / 60 * 1.4, rt.distance / 1000 / 15 * 60)) + 1), road: true };
        /* لفّة مش منطقية (أطول من ٣ أضعاف الخط المستقيم) = غالباً نقطة متحددة غلط أو كوبري مشاه — نرجع للتقدير */
        if (out.km > Math.max(8, km * 3)) { straight.odd = true; return straight; }
        return out;
      })
      .catch(function () { delete RC[k]; return straight; });
    return RC[k];
  };
  /* اسم الشارع من الخريطة (مجاني — OpenStreetMap). بيرجّع "" لو مفيش */
  var GC = {};
  T.reverse = function (lat, lng) {
    var k = (+lat).toFixed(4) + "," + (+lng).toFixed(4);
    if (GC[k]) return GC[k];
    GC[k] = fetch("https://nominatim.openstreetmap.org/reverse?format=jsonv2&accept-language=ar&zoom=18&lat=" + lat + "&lon=" + lng)
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var a = (j && j.address) || {};
        var near = j && j.name && j.name !== a.road ? j.name : "";
        var road = a.road || a.pedestrian || a.footway || "";
        var area = a.neighbourhood || a.suburb || a.village || a.town || a.city || "";
        return [near, road, area].filter(Boolean).filter(function (v, i, s) { return s.indexOf(v) === i; }).slice(0, 2).join("، ");
      })
      .catch(function () { delete GC[k]; return ""; });
    return GC[k];
  };
  /* بيدوّر على اسم مكان جوه حدود المدينة بس (~٦ كم) — بيرجّع {lat,lng,label} أو null */
  T.geocode = function (name, center) {
    center = center || CENTER;
    var d = 0.06, vb = [center[1] - d, center[0] + d, center[1] + d, center[0] - d].join(",");
    var base = "https://nominatim.openstreetmap.org/search?format=jsonv2&accept-language=ar&limit=1&bounded=1&viewbox=" + vb + "&q=";
    var short = String(name).replace(/\s*(كفر صقر|\(.*?\))\s*/g, " ").trim();
    function q(s) { return fetch(base + encodeURIComponent(s)).then(function (r) { return r.json(); }).then(function (j) { return j && j[0] ? { lat: +(+j[0].lat).toFixed(6), lng: +(+j[0].lon).toFixed(6), label: j[0].display_name } : null; }); }
    return q(name).then(function (r) { return r || (short && short !== name ? new Promise(function (ok) { setTimeout(ok, 1100); }).then(function () { return q(short); }) : null); }).catch(function () { return null; });
  };
  /* أماكن حقيقية ليها اسم في حدود ~٤ كم من المركز (للإدارة — مرة واحدة) */
  T.nearbyPOIs = function (center) {
    var q = '[out:json][timeout:25];(nwr["name"]["amenity"](around:4000,' + center[0] + ',' + center[1] + ');nwr["name"]["railway"="station"](around:4000,' + center[0] + ',' + center[1] + ');nwr["name"]["healthcare"](around:4000,' + center[0] + ',' + center[1] + ');nwr["name"]["office"="government"](around:4000,' + center[0] + ',' + center[1] + '););out center 200;';
    return fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: "data=" + encodeURIComponent(q) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var seen = {};
        return (j.elements || []).map(function (e) {
          var t = e.tags || {};
          return { name: t["name:ar"] || t.name, kind: t.amenity || t.healthcare || t.office || t.railway || "", lat: e.lat != null ? e.lat : e.center && e.center.lat, lng: e.lon != null ? e.lon : e.center && e.center.lon };
        }).filter(function (p) { if (!p.name || p.lat == null || seen[p.name]) return false; seen[p.name] = 1; return true; });
      });
  };
  try { if (localStorage.getItem("tt-big") === "1") document.documentElement.style.fontSize = "118%"; } catch (e) {}
  /* ---------- أصوات التطبيق: نغمات قصيرة متولّدة (من غير ملفات) — تتقفل من «حسابي» ---------- */
  var SND = {
    tap:      [[880, 0, .06, "sine", .12]],
    confirm:  [[523, 0, .12], [659, .1, .12], [784, .2, .22]],
    accepted: [[587, 0, .14], [740, .12, .14], [880, .24, .14], [1175, .36, .34]],
    offer:    [[740, 0, .12, "triangle"], [988, .13, .24, "triangle"]],
    picked:   [[523, 0, .16], [659, .16, .16], [784, .32, .16], [1047, .48, .55], [1319, .9, .7, "triangle"]],
    /* السواق وصل: «تي-تي-تيي» + تيك-توك زي فلاشر العربية + بيب «أنا هنا» */
    arrived:  [[660, 0, .18], [880, .22, .18], [1100, .44, .3], [2400, 0.9, .025, "square", .14], [1800, 0.912, .03, "triangle", .1], [1900, 1.3, .025, "square", .12], [1300, 1.312, .035, "triangle", .09], [2400, 1.7, .025, "square", .14], [1800, 1.712, .03, "triangle", .1], [1900, 2.1, .025, "square", .12], [1300, 2.112, .035, "triangle", .09], [1175, 2.45, .12, "sine", .14], [1175, 2.65, .18, "sine", .14]],
    /* الوصول «ورد وجرس»: جرسين ناعمين + لمعة */
    done:     [[1047, 0, .6, "sine", .16], [2093, 0, .25, "sine", .03], [1319, .2, .6, "sine", .15], [1568, .4, .9, "sine", .15], [3136, .55, .5, "triangle", .03]],
    msg:      [[988, 0, .08], [1319, .09, .12]],
    error:    [[330, 0, .16, "square", .12], [247, .16, .26, "square", .12]],
    cancel:   [[659, 0, .16, "sine", .16], [523, .15, .16, "sine", .16], [415, .3, .5, "sine", .18]],
    /* نغمة الدخول «نطّة الدبوس»: الضربة التقيلة على ٠٫٥ ثانية = لحظة نزول اللوجو على الأرض */
    intro:    [[900, .05, .42, "sine", .05, 300], [110, .5, .3, "sine", .35, 70], [220, .5, .22, "triangle", .14], [523, .62, .55, "sine", .12], [659, .69, .55, "sine", .12], [784, .76, .55, "sine", .12], [1047, .83, .55, "sine", .12]],
    /* بداية البحث: «بينج» رادار مرتين + لمعة صغيرة = الطلب طلع ولسه بندوّر */
    search:   [[1175, 0, .5, "sine", .16], [2349, 0, .18, "sine", .03], [1175, .42, .5, "sine", .11], [2349, .42, .18, "sine", .02], [1568, .84, .35, "triangle", .07]],
    /* تنبيه المشوار اليومي (قبل الطلب بـ ١٠ دقايق): «دينج-دونج» مرتين */
    dailySoon:[[784, 0, .22, "sine", .16], [1047, .2, .3, "sine", .16], [784, .62, .22, "sine", .14], [1047, .82, .45, "sine", .16], [2093, .82, .2, "sine", .03]],
    newReq:   [[880, 0, .16, "square"], [660, .2, .16, "square"], [880, .4, .26, "square"]],
  };
  var sctx = null;
  T.soundOn = function () { try { return localStorage.getItem("tt-sound") !== "off"; } catch (e) { return true; } };
  T.sound = function (name) {
    if (!T.soundOn() || !SND[name]) return;
    try {
      var A = global.AudioContext || global.webkitAudioContext; sctx = sctx || new A();
      if (sctx.state === "suspended") sctx.resume();
      var t = sctx.currentTime + .02;
      SND[name].forEach(function (n) {
        var o = sctx.createOscillator(), g = sctx.createGain(), vol = n[4] || .22;
        o.type = n[3] || "sine"; o.frequency.setValueAtTime(n[0], t + n[1]); if (n[5]) o.frequency.exponentialRampToValueAtTime(n[5], t + n[1] + n[2]);
        g.gain.setValueAtTime(.0001, t + n[1]); g.gain.exponentialRampToValueAtTime(vol, t + n[1] + .015); g.gain.exponentialRampToValueAtTime(.0001, t + n[1] + n[2]);
        o.connect(g); g.connect(sctx.destination); o.start(t + n[1]); o.stop(t + n[1] + n[2] + .02);
      });
    } catch (e) {}
  };
  /* الكلام المنطوق متشال دلوقتي — الجمل بتظهر مكتوبة بس. الدالة فاضية علشان أي مكان بيناديها مايعملش غلط */
  T.say = function () {};
  /* أول دوسة في الصفحة بتفتح الصوت (أندرويد بيمنع الصوت قبل أي دوسة) */
  document.addEventListener("pointerdown", function un() { try { var A = global.AudioContext || global.webkitAudioContext; sctx = sctx || new A(); sctx.resume(); } catch (e) {} document.removeEventListener("pointerdown", un, true); }, true);

  /* شارة ترتيب السائق: ذهبي / فضي / برونزي / جديد */
  var TIERS = { normal: ["سائق عادي", "#0A5A4E", "#D6EBE6", "#12897A"], gold: ["ذهبي", "#8A6508", "#FFF3C4", "#F5C842"], silver: ["فضي", "#4A565D", "#EEF1F3", "#C0C8CE"], bronze: ["برونزي", "#7A4019", "#F6E3D3", "#CD7F32"], "new": ["سائق جديد", "#0A5A4E", "#D6EBE6", "#0E7566"] };
  T.tierBadge = function (d) {
    if (!d) return "";
    var t = (d.tier === "gold" || d.tier === "silver") ? TIERS[d.tier] : TIERS.normal || null, stars = d.rating ? '<span class="num" style="font-weight:800;color:#8A6508">★ ' + d.rating + '</span><span style="opacity:.75">(' + d.ratingCount + ')</span>' : "";
    var medal = t ? '<span class="tier tier-' + ((d.tier === "gold" || d.tier === "silver") ? d.tier : "normal") + '" style="display:inline-flex;align-items:center;gap:5px;background:' + t[2] + ';color:' + t[1] + ';border-radius:999px;padding:2px 10px 2px 4px;font-weight:700;font-size:12.5px">'
      + '<span style="width:16px;height:16px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff 0%,' + t[3] + ' 45%,' + t[1] + ' 100%);box-shadow:0 0 0 1.5px ' + t[3] + '"></span>' + t[0] + '</span>' : "";
    return '<span style="display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:13px">' + medal + stars + '</span>';
  };

  /* سؤال تأكيد جوه التطبيق (بدل confirm بتاع المتصفح) — بيرجّع Promise<true/false> */
  T.ask = function (msg, o) {
    o = o || {};
    return new Promise(function (res) {
      var ov = document.createElement("div");
      ov.setAttribute("role", "dialog"); ov.setAttribute("aria-modal", "true");
      ov.style.cssText = "position:fixed;inset:0;z-index:7000;background:rgba(19,30,28,.5);display:flex;align-items:center;justify-content:center;padding:24px;animation:mh-fade .2s both";
      ov.innerHTML = '<div style="width:100%;max-width:340px;background:var(--surface);color:var(--ink);border-radius:18px;padding:20px;box-shadow:0 24px 60px -20px rgba(0,0,0,.5);animation:mh-pop .35s var(--ease-spring) both;display:flex;flex-direction:column;gap:14px">'
        + '<div style="font:700 18px/1.5 var(--display);text-align:center">' + T.esc(msg) + '</div>'
        + (o.sub ? '<div class="hint" style="text-align:center;margin-top:-6px">' + T.esc(o.sub) + '</div>' : '')
        + '<div style="display:flex;gap:10px"><button type="button" data-a="0" class="btn btn-ghost" style="flex:1;min-height:48px">' + T.esc(o.no || "لأ") + '</button>'
        + '<button type="button" data-a="1" class="btn" style="flex:1;min-height:48px;font-weight:700;color:#fff;background:' + (o.danger === false ? "var(--accent)" : "#A9382B") + '">' + T.esc(o.yes || "أيوه") + '</button></div></div>';
      var done = function (v) { ov.remove(); res(v); };
      ov.addEventListener("click", function (e) { var b = e.target.closest("[data-a]"); if (b) done(b.getAttribute("data-a") === "1"); else if (e.target === ov) done(false); });
      document.body.appendChild(ov);
      setTimeout(function () { var n = ov.querySelector('[data-a="0"]'); n && n.focus(); }, 30);
    });
  };
  /* المسار المتحرك: حدّ أبيض + خط بيترسم + نقط ماشية فوقه في اتجاه المشوار */
  /* التوكتوك بيمشي بين كل نقطتين على الشارع نفسه — مابيقطعش البيوت أبداً:
     ١) لو النقطتين على مسار الرحلة ← بيمشي على المسار، والنقطة بتتلزق على الشارع (لو الـ GPS طالع جوه بيت)
     ٢) غير كده ← بيجيب طريق الشارع بين النقطتين ويمشي عليه
     ٣) لو مفيش طريق شارع (الخدمة وقعت) ← بيقف مكانه ويستنى التحديث الجاي بدل ما يقطع */
  T.glidePath = function (mk, to, coords, dur, onHead) {
    var from = mk.getLatLng(), A = [from.lat, from.lng], B = [+to[0], +to[1]];
    if (mk._mhAnim) cancelAnimationFrame(mk._mhAnim);
    var tk = (mk._mhTok = (mk._mhTok || 0) + 1);
    var kx = Math.cos(A[0] * Math.PI / 180), d2 = function (p, q) { var x = (p[1] - q[1]) * kx, y = p[0] - q[0]; return Math.sqrt(x * x + y * y) * 111320; };
    if (d2(A, B) > 2500) { mk.setLatLng(B); return; }
    if (d2(A, B) < 1) return;
    function proj(p, cs) {
      var best = { m: Infinity, i: 0, t: 0, pt: p };
      for (var i = 0; cs && i < cs.length - 1; i++) {
        var a = cs[i], b = cs[i + 1], ax = a[1] * kx, ay = a[0], bx = b[1] * kx, by = b[0], px = p[1] * kx, py = p[0];
        var dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
        var q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], m = d2(p, q);
        if (m < best.m) best = { m: m, i: i, t: t, pt: q };
      }
      return best;
    }
    function onPath(cs) {
      if (!cs || cs.length < 2) return null;
      var pa = proj(A, cs), pb = proj(B, cs);
      if (pa.m > 60 || pb.m > 60 || pb.i < pa.i || (pb.i === pa.i && pb.t < pa.t)) return null;
      var pts = [pa.pt]; for (var i = pa.i + 1; i <= pb.i; i++) pts.push(cs[i]); pts.push(pb.pt);
      if (d2(A, pa.pt) > 1) pts.unshift(A);
      return pts;
    }
    function run(pts) {
      if (tk !== mk._mhTok) return;
      var seg = [], tot = 0;
      for (var j = 0; j < pts.length - 1; j++) { var l = d2(pts[j], pts[j + 1]); seg.push(l); tot += l; }
      if (tot < 0.5) return;
      var t0 = performance.now(), lastH = null;
      (function step(now) {
        if (tk !== mk._mhTok) return;
        var k = Math.min(1, (now - t0) / dur), goal = tot * k, acc = 0, s = 0;
        while (s < seg.length - 1 && acc + seg[s] < goal) { acc += seg[s]; s++; }
        var f = seg[s] ? (goal - acc) / seg[s] : 1, p = pts[s], q = pts[s + 1];
        mk.setLatLng([p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f]);
        if (onHead && seg[s] > 3) { var h = Math.round((Math.atan2((q[1] - p[1]) * kx, q[0] - p[0]) * 180 / Math.PI + 360) % 360); if (h !== lastH) { lastH = h; onHead(h); } }
        if (k < 1) mk._mhAnim = requestAnimationFrame(step);
      })(t0);
    }
    var pts = onPath(coords);
    if (pts) return run(pts);
    if (!T.route) return;
    T.route({ lat: A[0], lng: A[1] }, { lat: B[0], lng: B[1] }).then(function (rt) {
      if (!rt || !rt.road || !rt.coords || rt.coords.length < 2) return; /* مفيش شارع معروف ← يفضل مكانه */
      var cs = rt.coords.slice();
      if (d2(A, cs[0]) > 1) cs.unshift(A);
      run(cs);
    }).catch(function () {});
  };
  T.animRoute = function (map, coords, color) {
    var g = L.layerGroup().addTo(map);
    var casing = L.polyline(coords, { color: "#fff", weight: 9, opacity: .95, className: "mh-route-casing", interactive: false }).addTo(g);
    var main = L.polyline(coords, { color: color, weight: 5, opacity: 1, className: "mh-route", interactive: false }).addTo(g);
    var flow = L.polyline(coords, { color: "#fff", weight: 4, opacity: 1, lineCap: "round", className: "mh-route-flow", interactive: false }).addTo(g);
    function norm() { [casing, main].forEach(function (l) { var e = l.getElement && l.getElement(); if (e) e.setAttribute("pathLength", "1000"); }); }
    norm();
    g.setLatLngs = function (c2) { casing.setLatLngs(c2); main.setLatLngs(c2); flow.setLatLngs(c2); norm(); return g; };
    g.redraw = function () { var e = main.getElement(); if (!e) return; e.style.animation = "none"; void e.getBBox; e.getBoundingClientRect(); e.style.animation = ""; };
    g.getBounds = function () { return main.getBounds(); };
    g.setStyle = function (o) { main.setStyle(o); return g; };
    return g;
  };
  /* احتفال صغير: لما السائق يقبل (عند الراكب)، أو لما السائق ياخد المشوار */
  T.celebrate = function (o) {
    o = o || {};
    if (document.hidden) { var w = function () { if (!document.hidden) { document.removeEventListener("visibilitychange", w); T.celebrate(o); } }; document.addEventListener("visibilitychange", w); return; }
    try { navigator.vibrate && navigator.vibrate([40, 60, 90]); } catch (e) {}
    if (!o.silent) T.sound(o.sound || "accepted");
    var el = document.createElement("div");
    el.className = "mh-cele" + (o.dark ? " drv" : "");
    var cols = ["#fff", "#F9E6DA", "#BC4E1E", "#D6EBE6", "#E8874F"], dots = "";
    for (var i = 0; i < 18; i++) {
      var a = (i / 18) * Math.PI * 2, d = 120 + Math.random() * 90;
      dots += '<i style="background:' + cols[i % cols.length] + ';--x:' + Math.round(Math.cos(a) * d) + 'px;--y:' + Math.round(Math.sin(a) * d) + 'px;--r:' + Math.round(Math.random() * 360) + 'deg"></i>';
    }
    var inner = o.photo ? "" : '<svg viewBox="0 0 48 48" width="58" height="58" fill="none"><path d="M12 25l8 8 16-17" stroke="' + (o.dark ? "#131E1C" : "#0E7566") + '" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    el.innerHTML = '<div class="dots">' + dots + '</div><div class="ring"><div class="disc"' + (o.photo ? ' style="background-image:url(' + o.photo + ')"' : '') + '>' + inner + '</div></div>'
      + '<h2>' + T.esc(o.title || "تمام ✓") + '</h2>' + (o.sub ? '<p>' + T.esc(o.sub) + '</p>' : '');
    document.body.appendChild(el);
    var close = function () { el.classList.add("out"); setTimeout(function () { el.remove(); }, 480); };
    el.addEventListener("click", close);
    setTimeout(close, o.ms || 2200);
  };
  /* Auto-fit: الخريطة بتتظبط على قد المسار بالظبط، مع مسافة صغيرة في الأطراف.
     بتحسب الجزء الظاهر من الخريطة (فوق الشيت اللي تحت، وتحت الشريط اللي فوق) */
  T.fitRoute = function (map, bounds, o) {
    o = o || {};
    if (!map || !bounds) return;
    if (!bounds.isValid && bounds.length) bounds = L.latLngBounds(bounds);
    if (!bounds.isValid || !bounds.isValid()) return;
    var el = map.getContainer(), H = el.clientHeight, W = el.clientWidth, top = 0, bot = 0;
    var sheet = o.sheet && document.querySelector(o.sheet), bar = o.bar && document.querySelector(o.bar);
    if (sheet && !sheet.hidden) bot = Math.max(0, Math.min(H * 0.75, H - sheet.getBoundingClientRect().top + el.getBoundingClientRect().top));
    if (bar) top = Math.max(0, bar.getBoundingClientRect().bottom - el.getBoundingClientRect().top);
    var side = Math.round(Math.max(20, Math.min(48, W * 0.08)));
    var gap = Math.round(Math.max(18, Math.min(40, (H - top - bot) * 0.1)));
    /* مشوار قصير جداً: مانقرّبش لدرجة الخريطة تبقى شوارع من غير معالم */
    var ne = bounds.getNorthEast(), sw = bounds.getSouthWest();
    if (map.distance(ne, sw) < 120) bounds = bounds.pad(1.2);
    map.fitBounds(bounds, { paddingTopLeft: [side, top + gap], paddingBottomRight: [side, bot + gap], maxZoom: o.maxZoom || 17, animate: o.animate !== false, duration: .6 });
  };
  /* بيعيد الـ fit لما الشاشة تتغيّر أو الشيت يكبر/يصغر */
  T.autoFit = function (map, getBounds, o) {
    var t = null, run = function () { clearTimeout(t); t = setTimeout(function () { var b = getBounds(); if (b) { map.invalidateSize(); T.fitRoute(map, b, o); } }, 180); };
    window.addEventListener("resize", run);
    window.addEventListener("orientationchange", run);
    var s = o && o.sheet && document.querySelector(o.sheet);
    if (s && window.ResizeObserver) new ResizeObserver(run).observe(s);
    return run;
  };
  /* توكتوك صغير على الخريطة (للتكاتك القريبة) */
  T.tukIcon = function (busy, h) {
    var rot = h != null && !isNaN(+h) ? +h : 0;
    return L.divIcon({ className: "mh-tuk", iconSize: [26, 34], iconAnchor: [13, 17],
      html: '<div data-rot="' + rot + '" style="transition:transform .6s cubic-bezier(.22,1,.36,1);transform:rotate(' + rot + 'deg);filter:drop-shadow(0 3px 3px rgba(19,30,28,.35))' + (busy ? ';opacity:.95' : '') + '">' + T.tukSvg(busy ? "busy" : "normal", 22) + '</div>' });
  };
  /* خريطة صغيرة ثابتة (من غير تحميل خريطة كاملة): بلاطة OSM واحدة والدبوس في النص */
  T.miniMap = function (lat, lng, z) {
    z = z || 16; var n = Math.pow(2, z), x = (lng + 180) / 360 * n, r = lat * Math.PI / 180, y = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n;
    var tx = Math.floor(x), ty = Math.floor(y), px = Math.round((x - tx) * 256), py = Math.round((y - ty) * 256), tiles = "";
    for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++)
      tiles += '<img alt="" loading="lazy" src="https://tile.openstreetmap.org/' + z + '/' + (tx + dx) + '/' + (ty + dy) + '.png" style="position:absolute;width:256px;height:256px;left:calc(50% - ' + px + 'px + ' + (dx * 256) + 'px);top:calc(50% - ' + py + 'px + ' + (dy * 256) + 'px)">';
    return '<div class="mini-map" aria-label="مكان الراكب على الخريطة">' + tiles
      + '<span class="mm-pulse"></span><span class="mm-pin"></span></div>';
  };
  /* بيحرّك ماركرات حسب مفتاح: اللي اختفى بيتشال، والجديد بيظهر، والموجود بيتزحلق */
  T.syncMarkers = function (map, store, list, iconFn, tipFn) {
    var seen = {};
    list.forEach(function (p) {
      seen[p.k] = 1;
      if (store[p.k]) { store[p.k].setLatLng([p.lat, p.lng]); var el = store[p.k].getElement && store[p.k].getElement(); T.rotTo(el && el.querySelector("[data-rot]"), p.h); }
      else { store[p.k] = L.marker([p.lat, p.lng], { icon: iconFn(p), interactive: !!tipFn, keyboard: false, zIndexOffset: 500 }).addTo(map); if (tipFn) store[p.k].bindTooltip(tipFn(p)); }
    });
    Object.keys(store).forEach(function (k) { if (!seen[k]) { map.removeLayer(store[k]); delete store[k]; } });
  };
  /* أيقونة السائق: توكتوك من فوق (2a) بلون ترتيبه، ومقدّمته بتلف مع اتجاهه، وحواليه نبض بنفس اللون */
  var TUK = {
    gold:   { b: "#D29A1E", r: "#9C6B0A", a: "#FFE7A8", p: "#E8B23A", mark: "star" },
    silver: { b: "#6F8590", r: "#4E616B", a: "#E3EBEF", p: "#8FA3AD", mark: "bar" },
    normal: { b: "#0E7566", r: "#0A5A4E", a: "#D6EBE6", p: "#12897A", mark: "" },
    busy:   { b: "#BC4E1E", r: "#8E3A15", a: "#F9E6DA", p: "#E0784A", mark: "" }
  };
  T.tukSvg = function (tier, w) {
    var k = TUK[tier] || TUK.normal, mark = k.mark === "star"
      ? '<path d="M20 28.6l1.9 3.9 4.3.6-3.1 3 .7 4.3-3.8-2-3.8 2 .7-4.3-3.1-3 4.3-.6z" fill="#FFF6D8" stroke="#7A5205" stroke-width=".8" stroke-linejoin="round"/>'
      : k.mark === "bar" ? '<rect x="14" y="32" width="12" height="3.2" rx="1.6" fill="#fff"/><rect x="14" y="37" width="12" height="3.2" rx="1.6" fill="#fff" opacity=".8"/>' : "";
    w = w || 30;
    return '<svg width="' + w + '" height="' + Math.round(w * 1.4) + '" viewBox="0 0 40 56" aria-hidden="true">'
      + '<defs><linearGradient id="mhsh" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".7"/><stop offset=".45" stop-color="#fff" stop-opacity=".12"/><stop offset=".6" stop-color="#fff" stop-opacity="0"/><stop offset=".8" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>'
      + '<rect x="17.5" y=".5" width="5" height="8" rx="2" fill="#1B2422"/><rect x="3" y="36" width="5" height="12" rx="2" fill="#1B2422"/><rect x="32" y="36" width="5" height="12" rx="2" fill="#1B2422"/>'
      + '<path d="M20 4C25.5 4 28.5 8 29.5 13L33 43C33.5 49 30.5 53 25 53H15C9.5 53 6.5 49 7 43L10.5 13C11.5 8 14.5 4 20 4Z" fill="' + k.b + '" stroke="#fff" stroke-width="2"/>'
      + '<path d="M13 15.5C15 13 25 13 27 15.5L27.6 20H12.4Z" fill="' + k.a + '"/>'
      + '<rect x="10.5" y="21" width="19" height="28" rx="5" fill="' + k.r + '"/><rect x="10.5" y="21" width="19" height="28" rx="5" fill="url(#mhsh)"/>'
      + '<rect x="13" y="24" width="14" height="3" rx="1.5" fill="' + k.a + '" opacity=".6"/><circle cx="20" cy="7.5" r="1.7" fill="#FFF6D8"/>' + mark + '</svg>';
  };
  T.driverIcon = function (h, tier) {
    tier = (tier === "gold" || tier === "silver") ? tier : "normal";
    var k = TUK[tier], rot = h != null && !isNaN(+h) ? +h : 0;
    return L.divIcon({ className: "", iconSize: [56, 56], iconAnchor: [28, 28],
      html: '<div class="mh-drv mh-drv-' + tier + '" style="--pc:' + k.p + '"><span class="p"></span><span class="p p2"></span>'
        + '<div class="tk" data-rot="' + rot + '" style="transform:rotate(' + rot + 'deg)">' + T.tukSvg(tier, 26) + '</div></div>' });
  };
  /* اتجاه السير: من الـ GPS لو متاح، وإلا بنحسبه من آخر نقطتين (أغلب موبايلات أندرويد مابتبعتش heading)، ولو واقف بنثبّت آخر اتجاه */
  T.bearing = function (a, b) {
    var r = Math.PI / 180, y = Math.sin((b.lng - a.lng) * r) * Math.cos(b.lat * r),
      x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lng - a.lng) * r);
    return (Math.atan2(y, x) / r + 360) % 360;
  };
  T.headingTracker = function () {
    var last = null, h = null;
    return function (p) {
      var c = p.coords, pt = { lat: c.latitude, lng: c.longitude }, g = c.heading;
      if (g != null && !isNaN(g) && (c.speed == null || c.speed > 0.8)) { h = g; last = pt; return h; }
      if (!last) { last = pt; return h; }
      var m = T.dist(last, pt) * 1000;
      if (m > Math.max(8, Math.min(25, (c.accuracy || 10) * 0.8))) { h = T.bearing(last, pt); last = pt; }
      return h;
    };
  };
  /* بيلف العنصر لأقصر لفة (مايلفّش ٣٥٠ درجة عشان يروح من ٣٥٥ لـ ٥) */
  T.rotTo = function (el, h) {
    if (!el || h == null || isNaN(+h)) return;
    var cur = +el.getAttribute("data-rot"); if (isNaN(cur)) cur = 0;
    var d = ((+h - cur) % 360 + 540) % 360 - 180, n = cur + d;
    /* اللفة الكبيرة (أكتر من ٦٠°) بتتعمل أسرع علشان التوكتوك مايتأخرش عند الملفّات الحادة */
    el.style.transition = "transform " + (Math.abs(d) > 60 ? ".22s ease-out" : ".6s cubic-bezier(.22,1,.36,1)");
    el.setAttribute("data-rot", n); el.style.transform = "rotate(" + n + "deg)";
  };
  T.etaText = function (rt) { return rt.min + " دقيقة · " + rt.km.toFixed(1) + " كم"; };

  /* رقم ثابت للموبايل ده (نفس اللي بيستخدمه سجل الموافقة) — حساب السائق بيتربط بيه */
  T.devId = function () {
    var d = ""; try { d = localStorage.getItem("mh-dev") || ""; } catch (e) {}
    if (!d) { d = Date.now().toString(36) + Math.random().toString(36).slice(2, 10); try { localStorage.setItem("mh-dev", d); } catch (e) {} }
    return d;
  };

  global.TT = T;

  /* شاشة البداية (1d): بتظهر بس جوه التطبيق المتثبّت، مرة واحدة في أول الفتح */
  try {
    var standalone = (global.matchMedia && matchMedia("(display-mode: standalone)").matches) || /android-app:/.test(document.referrer);
    var p = location.pathname;
    if ((standalone || /[?&]splash=1/.test(location.search)) && !sessionStorage.getItem("mh-splash") && (p === "/" || p === "/index.html" || p === "/driver.html")) {
      sessionStorage.setItem("mh-splash", "1");
      var drv = p === "/driver.html";
      var sp = document.createElement("div");
      sp.setAttribute("aria-hidden", "true");
      sp.className = "mh-splash" + (drv ? " drv" : "");
      sp.innerHTML = '<div class="stage"><span class="rg"></span><span class="rg b"></span><span class="sh"></span><img src="/assets/logo.png" alt=""></div>'
        + '<div class="t">المحطة' + (drv ? ' · سائق' : '') + '</div>'
        + '<div class="s">مشوارك بقى أسهل</div><div class="bar"><i></i></div>';
      (document.body || document.documentElement).appendChild(sp);
      /* نغمة الدخول مع الحركة. لو أندرويد منع الصوت (مفيش لمسة لسه)، بتشتغل مع أول لمسة على شاشة الدخول */
      var t0 = Date.now(), introDone = false;
      var playIntro = function () { if (introDone) return; introDone = true; T.sound("intro"); };
      try {
        var A0 = global.AudioContext || global.webkitAudioContext; sctx = sctx || new A0();
        if (sctx.state === "running") playIntro();
        else sctx.resume().then(function () { if (sctx.state === "running" && Date.now() - t0 < 400) playIntro(); }).catch(function () {});
      } catch (e) {}
      var onTouch = function () { document.removeEventListener("pointerdown", onTouch, true); if (Date.now() - t0 < 15000) playIntro(); };
      document.addEventListener("pointerdown", onTouch, true);
      setTimeout(function () { sp.classList.add("out"); setTimeout(function () { sp.remove(); }, 560); }, 1900);
    }
  } catch (e) {}
})(window);
