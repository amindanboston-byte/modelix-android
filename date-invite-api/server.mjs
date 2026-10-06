import http from 'node:http';

const PORT = Number(process.env.PORT || 3000);
const TRUSTED_ORIGIN = 'https://amin-date-invite.onrender.com';
const API_KEY = process.env.KAVENEGAR_API_KEY || '';
const SENDER = process.env.KAVENEGAR_SENDER || '';
const RECIPIENT = process.env.SMS_RECIPIENT || '';
const hitsByIp = new Map();
const dayCounts = new Map();
const MS_DAY = 86400000;

function sendJson(res, code, payload, origin = '') {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Vary': 'Origin',
  };
  if (origin === TRUSTED_ORIGIN) {
    headers['Access-Control-Allow-Origin'] = TRUSTED_ORIGIN;
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
  }
  res.writeHead(code, headers);
  res.end(JSON.stringify(payload));
}

function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (date.getTime() < todayUtc || date.getTime() > todayUtc + 365 * MS_DAY) return null;
  return date;
}

async function sendToProvider(date) {
  const persianDate = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  }).format(date);
  const message = '💖 جواب قرار: آره! تاریخ انتخاب‌شده: ' + persianDate;
  const params = new URLSearchParams({
    receptor: RECIPIENT, sender: SENDER, message,
  });
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 12000);
  try {
    const endpoint = 'https://api.kavenegar.com/v1/' + encodeURIComponent(API_KEY) + '/sms/send.json';
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: abort.signal,
    });
    const result = await response.json().catch(() => ({}));
    return response.ok && Number(result?.return?.status) === 200;
  } finally {
    clearTimeout(timeout);
  }
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { ok: true, smsConfigured: Boolean(API_KEY && RECIPIENT) });
  }
  if (req.method === 'OPTIONS' && req.url === '/api/date') {
    return sendJson(res, origin === TRUSTED_ORIGIN ? 200 : 403, {}, origin);
  }
  if (req.url !== '/api/date' || req.method !== 'POST') {
    return sendJson(res, 404, { ok: false, error: 'یافت نشد' }, origin);
  }
  if (origin !== TRUSTED_ORIGIN) {
    return sendJson(res, 403, { ok: false, error: 'مبدأ نامعتبر است.' }, origin);
  }
  if (!API_KEY || !RECIPIENT) {
    return sendJson(res, 503, { ok: false, error: 'ارسال خودکار هنوز توسط مدیر سایت فعال نشده است.' }, origin);
  }
  let raw = '';
  for await (const part of req) {
    raw += part;
    if (raw.length > 2048) {
      return sendJson(res, 413, { ok: false, error: 'درخواست بیش از حد بزرگ است.' }, origin);
    }
  }
  let data;
  try { data = JSON.parse(raw); } catch {
    return sendJson(res, 400, { ok: false, error: 'درخواست نامعتبر است.' }, origin);
  }
  const date = parseDate(data.date);
  if (!date) {
    return sendJson(res, 400, { ok: false, error: 'لطفاً یک تاریخ معتبر در یک سال آینده انتخاب کن.' }, origin);
  }
  const now = Date.now();
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].slice(0, 64);
  for (const [k, ts] of hitsByIp) if (now - ts > MS_DAY) hitsByIp.delete(k);
  for (const [k, ts] of dayCounts) if (now - Number(k) > MS_DAY) dayCounts.delete(k);
  const todaysBucket = Math.floor(now / MS_DAY) * MS_DAY;
  const count = dayCounts.get(todaysBucket) || 0;
  if (count >= 8 || (hitsByIp.has(ip) && now - hitsByIp.get(ip) < 600000)) {
    return sendJson(res, 429, { ok: false, error: 'ارسال بیش از حد تکرار شده است. کمی بعد دوباره تلاش کن.' }, origin);
  }
  hitsByIp.set(ip, now);
  dayCounts.set(todaysBucket, count + 1);
  try {
    const success = await sendToProvider(date);
    if (!success) {
      return sendJson(res, 502, { ok: false, error: 'پنل پیامکی ارسال را نپذیرفت. مدیر سایت باید تنظیمات یا اعتبار پنل را بررسی کند.' }, origin);
    }
    return sendJson(res, 200, { ok: true, status: 'queued' }, origin);
  } catch {
    return sendJson(res, 502, { ok: false, error: 'اتصال به پنل پیامکی برقرار نشد. لطفاً بعداً تلاش کن.' }, origin);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Date invite SMS API listening on port ' + PORT);
});
