/* ============================================================================
   My Memory — service worker
   ============================================================================
   This file exists for one reason: a service worker is the ONLY way a web app
   can raise a notification while its tab is closed. The page cannot do it —
   once you close the tab, its JavaScript is gone.

   It does two jobs:

     1. Keeps a copy of your saved items so it can check reminders without the app
        being open. The page can't share localStorage across that boundary, so
        it posts the list here and we park it in the Cache API.

     2. Fires a real OS notification when a reminder comes due, via either:
          - 'periodicsync' — Chromium wakes us on its own schedule (see notes)
          - 'sync'         — one-off background sync
        and reacts to the notification being tapped.

   NOTE ON TIMING: the browser decides when (and whether) to wake a service
   worker. Chrome treats periodic sync as best-effort — typically no more than
   once every 12 hours, and only for an INSTALLED PWA that you actually use.
   So treat these as "you'll get reminded sometime that day", not "at 18:00
   sharp". Exact-time delivery while the app is closed needs a push server,
   which this app deliberately doesn't have. While the tab IS open the page
   handles timing itself and is exact.
   ============================================================================ */

const SHELL_CACHE = 'sm-shell-v1';   // the app itself, so it opens offline
const STATE_CACHE = 'sm-state-v1';   // the task list, for background checks
const STATE_KEY   = 'sm-state';      // resolves relative to this script's folder

const ICON = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2032%2032'%3E%3Crect%20width='32'%20height='32'%20rx='7'%20fill='%23FF6B4A'/%3E%3Cpath%20d='M28%2013%2016%207%204%2013l12%206%2012-6z'%20fill='%23fff'/%3E%3Cpath%20d='M9%2016.5V21c0%202%203.1%203.5%207%203.5s7-1.5%207-3.5v-4.5'%20fill='none'%20stroke='%23fff'%20stroke-width='2.4'%20stroke-linecap='round'%20stroke-linejoin='round'/%3E%3C/svg%3E";

/* ── lifecycle ───────────────────────────────────────────────────────────── */

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter(n => n.startsWith('sm-shell-') && n !== SHELL_CACHE)
           .map(n => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

/* ── the task list ───────────────────────────────────────────────────────── */

async function writeState(tasks) {
  const cache = await caches.open(STATE_CACHE);
  await cache.put(STATE_KEY, new Response(JSON.stringify(tasks || []), {
    headers: { 'Content-Type': 'application/json' }
  }));
}

async function readState() {
  try {
    const cache = await caches.open(STATE_CACHE);
    const res = await cache.match(STATE_KEY);
    return res ? await res.json() : [];
  } catch (_) { return []; }
}

/* ── messages from the page ──────────────────────────────────────────────── */

self.addEventListener('message', event => {
  const data = event.data || {};
  const port = event.ports && event.ports[0];

  if (data.type === 'SYNC') {
    event.waitUntil(writeState(data.tasks));
  }

  /* "Which reminders have you already fired while I was closed?" — the page
     merges these back so opening the app doesn't replay old notifications. */
  if (data.type === 'PULL' && port) {
    event.waitUntil((async () => {
      const tasks = await readState();
      port.postMessage({ notifiedIds: tasks.filter(t => t.notified).map(t => t.id) });
    })());
  }

  if (data.type === 'CHECK_NOW') {
    event.waitUntil(check(false));
  }
});

/* ── the actual reminder check ───────────────────────────────────────────── */

/* Don't fire a system notification for something the user is looking at. */
async function hasVisibleClient() {
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return list.some(c => c.visibilityState === 'visible');
}

async function check(allowWhileVisible) {
  if (!allowWhileVisible && await hasVisibleClient()) return;

  const tasks = await readState();
  if (!tasks.length) return;

  const now = Date.now();
  let changed = false;

  for (const t of tasks) {
    if (t.notified || !t.dueAt || t.dueAt > now) continue;

    try {
      const late = !!t.late;
      const level = t.priority === 'urgent' ? 'Urgent' : t.priority === 'high' ? 'Important' : late ? 'Late' : 'Reminder';
      await self.registration.showNotification(t.title || 'Memory reminder', {
        body: level + ' · Due ' + (t.dueLabel || 'soon') + (t.subject && t.subject !== 'General' ? ' · ' + t.subject : ''),
        tag: 'sm-' + t.id,
        icon: ICON,
        badge: ICON,
        vibrate: [90, 50, 90],
        data: { id: t.id }
      });
    } catch (_) {
      /* No permission, or the platform refused. Stop trying — but leave
         notified=false so we get another shot if it's granted later. */
      return;
    }

    t.notified = true;
    changed = true;
  }

  if (changed) await writeState(tasks);
}

self.addEventListener('periodicsync', event => {
  if (event.tag === 'sm-check') event.waitUntil(check(false));
});

self.addEventListener('sync', event => {
  if (event.tag === 'sm-check') event.waitUntil(check(false));
});

/* ── tapping the notification ────────────────────────────────────────────── */

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const id = (event.notification.data && event.notification.data.id) || '';

  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

    for (const client of list) {
      if (client.url.includes('index.html') || client.url.endsWith('/')) {
        await client.focus();
        client.postMessage({ type: 'OPEN_TASK', id });
        return;
      }
    }
    await self.clients.openWindow('./index.html#task=' + encodeURIComponent(id));
  })());
});

/* ── keep the app openable offline ───────────────────────────────────────── */

/* Network-first: you always get the newest index.html when you're online, so
   editing the file never leaves you staring at a stale cached copy. The cache
   is only a fallback for when you're actually offline. */
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return;

  event.respondWith((async () => {
    try {
      const fresh = await fetch(event.request);
      if (fresh && fresh.ok) {
        caches.open(SHELL_CACHE)
          .then(c => c.put('./index.html', fresh.clone()))
          .catch(() => {});
      }
      return fresh;
    } catch (_) {
      const cache = await caches.open(SHELL_CACHE);
      const hit = await cache.match('./index.html');
      if (hit) return hit;
      return new Response('Offline — reopen My Memory when you have signal.', {
        status: 503, headers: { 'Content-Type': 'text/plain' }
      });
    }
  })());
});
