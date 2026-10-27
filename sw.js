/* إدارة المحطة: مابيحفظش أي بيانات — موجود بس علشان البرنامج يتثبّت على الماك */
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function () {});
