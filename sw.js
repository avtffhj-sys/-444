/* ============================================================
   Service Worker — منصة القرآن والسنة
   يوفر تجربة عمل بلا إنترنت (Offline Mode) عبر تخزين "الهيكل
   الأساسي" للتطبيق (App Shell: الصفحة + الخطوط + الأيقونات) محليًا،
   بحيث تُفتح الصفحة وتعمل بشكل طبيعي حتى بدون اتصال بالإنترنت.

   استراتيجية التخزين المؤقت المستخدمة:
   1) App Shell (الصفحة نفسها + manifest + الخطوط + Font Awesome):
      Cache-First مع تحديث في الخلفية (Stale-While-Revalidate) —
      تُعرض النسخة المخزّنة فورًا لسرعة أعلى، وتُحدَّث في الخلفية
      كلما توفر اتصال.
   2) طلبات API الديناميكية (تفسير/فتاوى/أوقات صلاة...):
      Network-First مع الرجوع للنسخة المخزّنة عند انقطاع الإنترنت،
      حتى تظل آخر بيانات تم جلبها متاحة دون اتصال.
   3) ملفات الصوت (mp3 / بث مباشر): لا تُعترض ولا تُخزَّن إطلاقًا —
      لأن Cache API لا يتعامل بشكل صحيح مع طلبات Range المستخدمة في
      تقديم/تأخير الصوت، ولأن حجمها كبير جدًا وغير مناسب للتخزين
      المحلي. تُترك لتذهب مباشرة للشبكة أو ذاكرة تخزين المتصفح المؤقتة
      الخاصة بالوسائط.
============================================================ */

const CACHE_VERSION = 'v15';
const APP_SHELL_CACHE = `quran-sunnah-shell-${CACHE_VERSION}`;
const API_CACHE = `quran-sunnah-api-${CACHE_VERSION}`;
const MAX_API_CACHE_ENTRIES = 60;

// الملفات الأساسية التي تُشكّل هيكل التطبيق (يجب أن تعمل بدون إنترنت)
const APP_SHELL_URLS = [
    './',
    './index.html',
    './manifest.json',
    './icon.svg',
    './apple-touch-icon.png',
    './icon-192.png',
    './icon-512.png',
    'https://fonts.googleapis.com/css2?family=Cairo:wght@300;400;600;700;900&family=Amiri:wght@400;700&family=Scheherazade+New:wght@400;700&display=swap',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css'
];

// امتدادات/أنماط الطلبات التي يجب استثناؤها دومًا من التخزين المؤقت
function isAudioOrStreamRequest(request) {
    const url = request.url;
    return (
        request.destination === 'audio' ||
        /\.mp3(\?|$)/i.test(url) ||
        url.includes('mp3quran.net') ||
        url.includes('radiojar.com') ||
        url.includes('qurango.net') ||
        request.headers.has('range')
    );
}

// الأصول التي تُعامل كنطاقات "app shell" ثابتة (Cache-First مع تحديث خلفي).
// ملاحظة: طلبات التنقّل (فتح الصفحة نفسها) لم تعد ضمن هذه المجموعة — انظر
// دالة networkFirstShell أدناه ومعالج fetch لسبب فصلها.
function isStaticShellRequest(request) {
    const url = request.url;
    return (
        url.includes('fonts.googleapis.com') ||
        url.includes('fonts.gstatic.com') ||
        url.includes('cdnjs.cloudflare.com') ||
        url.endsWith('/manifest.json') ||
        url.endsWith('/icon.svg')
    );
}

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(APP_SHELL_CACHE)
            .then((cache) => cache.addAll(APP_SHELL_URLS))
            .catch((err) => console.warn('sw: تعذر تخزين بعض ملفات الهيكل الأساسي مسبقًا', err))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys
                    .filter((key) => key !== APP_SHELL_CACHE && key !== API_CACHE)
                    .map((key) => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

// يحد من عدد العناصر المخزّنة في كاش الـ API حتى لا ينتفخ التخزين المحلي
async function trimCache(cacheName, maxEntries) {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length > maxEntries) {
        await cache.delete(keys[0]);
        await trimCache(cacheName, maxEntries);
    }
}

async function staleWhileRevalidate(request) {
    const cache = await caches.open(APP_SHELL_CACHE);
    const cachedResponse = await cache.match(request);
    const networkFetch = fetch(request)
        .then((networkResponse) => {
            if (networkResponse && networkResponse.ok) {
                cache.put(request, networkResponse.clone());
            }
            return networkResponse;
        })
        .catch(() => cachedResponse); // بدون إنترنت: نكتفي بالنسخة المخزّنة
    return cachedResponse || networkFetch;
}

// تحديث فوري للصفحة نفسها (index.html): على عكس بقية ملفات الهيكل الأساسي،
// نستخدم هنا Network-First بدل Stale-While-Revalidate — أي نحاول الشبكة أولًا
// دائمًا عند توفر إنترنت، حتى تصل أي تعديلات جديدة تُنشر على الموقع فورًا
// دون أن يعلق الزائر على نسخة قديمة مخزّنة من الصفحة. تبقى النسخة المخزّنة
// (المحدَّثة تلقائيًا من آخر زيارة ناجحة) هي الخيار الاحتياطي فقط عند انقطاع
// الإنترنت، فلا تتأثر تجربة العمل بلا اتصال إطلاقًا.
async function networkFirstShell(request) {
    const cache = await caches.open(APP_SHELL_CACHE);
    try {
        const networkResponse = await fetch(request);
        if (networkResponse && networkResponse.ok) {
            cache.put(request, networkResponse.clone());
        }
        return networkResponse;
    } catch (err) {
        const cached = (await cache.match(request)) || (await cache.match('./index.html'));
        if (cached) return cached;
        throw err;
    }
}

async function networkFirst(request) {
    try {
        const networkResponse = await fetch(request);
        if (networkResponse && networkResponse.ok) {
            const cache = await caches.open(API_CACHE);
            cache.put(request, networkResponse.clone());
            trimCache(API_CACHE, MAX_API_CACHE_ENTRIES);
        }
        return networkResponse;
    } catch (err) {
        const cached = await caches.match(request, { cacheName: API_CACHE });
        if (cached) return cached;
        // لا يوجد اتصال ولا نسخة مخزّنة سابقًا لهذا الطلب
        return new Response(
            JSON.stringify({ error: 'offline', message: 'لا يوجد اتصال بالإنترنت ولا توجد بيانات محفوظة لهذا الطلب مسبقًا.' }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
    }
}

self.addEventListener('fetch', (event) => {
    const { request } = event;

    // نتجاهل تمامًا أي طلب غير GET (مثل POST إلى خدمة مرشد/الفتاوى المحلية)
    if (request.method !== 'GET') return;

    // نستثني الصوتيات والبث المباشر تمامًا من التعامل — تذهب للشبكة مباشرة
    if (isAudioOrStreamRequest(request)) return;

    // نستثني أيضًا نداءات خادم الفتاوى/مرشد الخلفي من التخزين المؤقت
    // (سواء كان محليًا على localhost:5000 أو مرفوعًا على خادم فعلي مثل
    // Render)، لأنها إجابات AI مولّدة لحظيًا ولا معنى لتخزينها أو تقديمها
    // دون اتصال. نتعرّف عليها عبر مسار الـ API المميز بدل الاعتماد على
    // نطاق ثابت، حتى تعمل تلقائيًا بعد النشر بدون تعديل هذا الملف.
    if (request.url.includes('localhost:5000') || request.url.includes('/api/fatwa') || request.url.includes('/api/murshid')) return;

    // طلب فتح/تنقّل الصفحة نفسها (بما فيه إعادة تحميلها): نتحقق من الشبكة
    // أولًا دائمًا، وليس من الكاش، حتى تظهر أي تحديثات جديدة فور نشرها.
    if (request.mode === 'navigate' || request.url.endsWith('/index.html')) {
        event.respondWith(networkFirstShell(request));
        return;
    }

    if (isStaticShellRequest(request)) {
        event.respondWith(staleWhileRevalidate(request));
        return;
    }

    // بقية طلبات GET (واجهات القرآن/التفسير/الحديث/أوقات الصلاة وغيرها)
    if (request.url.startsWith('http')) {
        event.respondWith(networkFirst(request));
    }
});

/* ============================================================
   استقبال إشعارات الدفع (Web Push) — تصل حتى لو كان المتصفح/التطبيق
   مغلقًا تمامًا، لأن الـ Service Worker يبقى يعمل في الخلفية. يُرسل
   الخادم الخلفي هذه الرسائل عند نشر تحديث أو إضافة محتوى جديد،
   عبر خدمة Push الخاصة بمتصفح كل مستخدم مشترك.
============================================================ */
self.addEventListener('push', (event) => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch (err) {
        data = { title: 'منصة القرآن والسنة', body: event.data ? event.data.text() : '' };
    }

    const title = data.title || 'منصة القرآن والسنة';
    const options = {
        body: data.body || '',
        icon: data.icon || './icon-192.png',
        badge: './icon-192.png',
        dir: 'rtl',
        lang: 'ar',
        vibrate: [100, 50, 100],
        data: { url: data.url || './' }
    };

    event.waitUntil(self.registration.showNotification(title, options));
});

// عند الضغط على الإشعار: التركيز على تبويب مفتوح للموقع إن وُجد، وإلا فتح تبويب جديد.
// حالة خاصة: إشعار تقدّم التنزيل (tag: quran-sunnah-download-progress) يحمل زر
// إجراء "إلغاء التنزيل" (action: cancel-download)؛ عند الضغط عليه تحديدًا لا نفتح
// أو نُركّز على أي تبويب، بل نُغلق الإشعار فقط ونُرسل رسالة لكل تبويبات الموقع
// المفتوحة حتى تُلغي الصفحة عملية التحميل الجارية عبر AbortController الخاص بها.
self.addEventListener('notificationclick', (event) => {
    if (event.notification.tag === 'quran-sunnah-download-progress' && event.action === 'cancel-download') {
        event.notification.close();
        event.waitUntil(
            self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
                clientList.forEach((client) => client.postMessage({ type: 'cancel-download' }));
            })
        );
        return;
    }

    event.notification.close();
    const targetUrl = (event.notification.data && event.notification.data.url) || './';

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if (client.url.includes(self.registration.scope) && 'focus' in client) {
                    return client.focus();
                }
            }
            if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
        })
    );
});
