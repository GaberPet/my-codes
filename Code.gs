/**
 * My Codes — Gmail code finder.
 *
 * Runs on Google's servers in YOUR Gmail account. Every minute it looks at new mail,
 * finds verification / sign-in codes, and sends only the company + code to:
 *   - your Telegram (push notification with a Copy code button), and
 *   - your My Codes app (encrypted, signed, and kept inside Google).
 * Your emails themselves never leave Gmail.
 *
 * Your MAIN Gmail account's script is also the app's mailbox ("hub"): it is published as a
 * web app that hands out only encrypted codes. Other accounts send their codes to it.
 *
 * Setup (once per Gmail account, on a computer). The My Codes app (Accounts tab) walks you through it:
 *   1. Open https://script.new while signed in to that Gmail account.
 *   2. Delete what's there, paste this whole file, press Save.
 *   3. Main account only: Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone),
 *      then paste the Web app URL into My Codes.
 *   4. Pick "setup" in the function menu at the top and press Run. Press Allow.
 * Telegram and the app say "My Codes connected" when it works.
 *
 * To stop: pick "stop" and press Run.
 */

// ===== Settings =====
const MY_CODES_KEY = '';          // Your key from the My Codes app (Settings → Your key)
const ACCOUNT_NAME = '';          // A short nickname for this Gmail account, e.g. "personal"
const TELEGRAM_BOT_TOKEN = '';    // From @BotFather in Telegram, looks like 123456789:AAH...  (leave empty for no Telegram)
const TELEGRAM_DELETE_AFTER_MINUTES = 60;  // Delete code messages from Telegram after this long (0 = keep them)
const HUB_URL = '';               // Leave EMPTY in your main account. Other accounts: your main account's Web app URL.
// ====================

const BOX_HOURS = 48;                             // the hub keeps encrypted codes this long
const BOX_LIMIT = 100;                            // and at most this many
const BOX_MAX_CHARS = 8500;                       // and only what fits in one stored value
const LOOKBACK_MINUTES_FIRST_RUN = 30;            // on first run, also look at mail from the last 30 min
const MAX_CODE_AGE_MINUTES = 30;                  // ignore code emails older than this (codes expire)
const SEEN_LIMIT = 300;                           // how many processed message ids to remember

// ---------- setup / stop ----------

function setup() {
  checkConfig_();
  selfTest_();
  if (TELEGRAM_BOT_TOKEN) findTelegramChat_();
  stop();
  ScriptApp.newTrigger('checkMail').timeBased().everyMinutes(1).create();
  const props = PropertiesService.getUserProperties();
  props.setProperty('lastCheck', String(Date.now() - LOOKBACK_MINUTES_FIRST_RUN * 60000));
  sendToApp_({ k: 'hello', a: accountLabel_(), t: Date.now() });   // throws with a clear message if the hub can't be reached
  if (TELEGRAM_BOT_TOKEN) telegramSend_('✅ <b>My Codes connected</b>\nCodes from <b>' + html_(accountLabel_()) + '</b> will show up here.', null, false);
  checkMail();
  Logger.log('Done. My Codes now checks ' + Session.getActiveUser().getEmail() + ' every minute.');
}

function stop() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'checkMail')
    .forEach(t => ScriptApp.deleteTrigger(t));
}

/** Sends a fake code so you can see how it looks. */
function sendTestCode() {
  checkConfig_();
  if (TELEGRAM_BOT_TOKEN) findTelegramChat_();
  deliver_({ company: 'Test', code: '123456', when: Date.now(), threadId: '' });
}

// ---------- the minute-by-minute check ----------

function checkMail() {
  const lock = LockService.getUserLock();
  if (!lock.tryLock(5000)) return;
  try {
    const props = PropertiesService.getUserProperties();
    const now = Date.now();
    const lastCheck = Number(props.getProperty('lastCheck')) || now - LOOKBACK_MINUTES_FIRST_RUN * 60000;
    // Overlap by 2 minutes: Gmail's search index can lag a little behind delivery.
    const sinceSec = Math.floor((lastCheck - 2 * 60000) / 1000);
    const seen = JSON.parse(props.getProperty('seen') || '[]');
    const seenSet = new Set(seen);

    const threads = GmailApp.search('in:anywhere -in:sent -in:drafts -in:trash after:' + sinceSec, 0, 30);
    const found = [];
    threads.forEach(thread => {
      thread.getMessages().forEach(msg => {
        const id = msg.getId();
        if (seenSet.has(id)) return;
        const when = msg.getDate().getTime();
        if (when < sinceSec * 1000) return;            // older message in the same thread
        seenSet.add(id); seen.push(id);
        if (now - when > MAX_CODE_AGE_MINUTES * 60000) return;
        if (msg.isInChats()) return;
        const from = msg.getFrom();
        if (isFromMe_(from)) return;
        const subject = msg.getSubject() || '';
        let body = '';
        try { body = msg.getPlainBody() || ''; } catch (e) { body = ''; }
        const result = findCode(subject, body);
        if (result) found.push({ company: companyName(from, subject), code: result.code, when, threadId: thread.getId() });
      });
    });

    found.sort((a, b) => a.when - b.when).forEach(deliver_);
    props.setProperty('seen', JSON.stringify(seen.slice(-SEEN_LIMIT)));
    props.setProperty('lastCheck', String(now));
    if (TELEGRAM_BOT_TOKEN) cleanUpTelegram_();
  } finally {
    lock.releaseLock();
  }
}

function deliver_(f) {
  const plain = f.code.replace(/[\s-]/g, '');
  const mailUrl = f.threadId
    ? 'https://mail.google.com/mail/u/' + encodeURIComponent(Session.getActiveUser().getEmail()) + '/#all/' + f.threadId
    : '';
  try {
    sendToApp_({ k: 'code', c: f.company, v: f.code, a: accountLabel_(), t: f.when, u: mailUrl });
  } catch (e) { Logger.log('App mailbox failed: ' + e); }
  if (TELEGRAM_BOT_TOKEN) {
    // The notification preview shows the first line: just the code.
    const text = '<code>' + html_(plain) + '</code>\n' + html_(f.company) + ' · ' + html_(accountLabel_());
    const sent = telegramSend_(text, [[{ text: 'Copy code', copy_text: { text: plain } }]], true);
    if (sent && TELEGRAM_DELETE_AFTER_MINUTES > 0) {
      const props = PropertiesService.getUserProperties();
      const list = JSON.parse(props.getProperty('tgSent') || '[]');
      list.push([sent, Date.now()]);
      props.setProperty('tgSent', JSON.stringify(list.slice(-100)));
    }
  }
}

// ---------- Telegram ----------

function telegram_(method, body) {
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/' + method, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(body || {}), muteHttpExceptions: true,
  });
  let data = {};
  try { data = JSON.parse(res.getContentText()); } catch (e) {}
  if (!data.ok) Logger.log('Telegram ' + method + ' error ' + res.getResponseCode() + ': ' + (data.description || res.getContentText()));
  return data;
}

/** Finds your private chat with the bot (you must have pressed Start in it once). */
function findTelegramChat_() {
  const props = PropertiesService.getUserProperties();
  const me = telegram_('getMe');
  if (!me.ok) throw new Error('The Telegram bot token is wrong. Copy it again from @BotFather (it looks like 123456789:AAH...).');
  if (props.getProperty('tgChat:' + me.result.id)) return;
  const updates = telegram_('getUpdates', { limit: 100, allowed_updates: ['message'] });
  const chats = (updates.result || [])
    .map(u => u.message && u.message.chat)
    .filter(c => c && c.type === 'private');
  if (!chats.length) {
    throw new Error('Open your bot @' + me.result.username + ' in Telegram, press Start (or send it any message), then run setup again.');
  }
  props.setProperty('tgChat:' + me.result.id, String(chats[chats.length - 1].id));
}

function telegramChat_() {
  const botId = TELEGRAM_BOT_TOKEN.split(':')[0];
  return PropertiesService.getUserProperties().getProperty('tgChat:' + botId);
}

/** Returns the sent message id, or 0. */
function telegramSend_(text, buttons, loud) {
  const chat = telegramChat_();
  if (!chat) return 0;
  const body = { chat_id: chat, text: text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, disable_notification: !loud };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  const data = telegram_('sendMessage', body);
  return data.ok ? data.result.message_id : 0;
}

function cleanUpTelegram_() {
  if (!(TELEGRAM_DELETE_AFTER_MINUTES > 0)) return;
  const props = PropertiesService.getUserProperties();
  const list = JSON.parse(props.getProperty('tgSent') || '[]');
  if (!list.length) return;
  const cutoff = Date.now() - TELEGRAM_DELETE_AFTER_MINUTES * 60000;
  const keep = [];
  list.forEach(([id, at]) => {
    if (at > cutoff) keep.push([id, at]);
    else if (Date.now() - at < 47 * 3600000) telegram_('deleteMessage', { chat_id: telegramChat_(), message_id: id });
  });
  props.setProperty('tgSent', JSON.stringify(keep));
}

function html_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- encrypted mailbox for the app ----------
// The app and this script both derive, from your key: a channel id, an encryption key and a
// signing key. Messages are encrypted (HMAC-SHA256 counter-mode stream) and signed (HMAC-SHA256).
// The hub (main account's web app) only accepts correctly signed messages and only hands out
// encrypted ones, to requests that know the channel id.

function sendToApp_(obj) {
  const keys = keys_();
  const body = encrypt_(JSON.stringify(obj), keys);
  if (!HUB_URL) { boxAdd_(body); return; }
  let lastError = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = UrlFetchApp.fetch(HUB_URL + '?c=' + keys.topic, {
        method: 'post', contentType: 'text/plain', payload: body, muteHttpExceptions: true, followRedirects: true,
      });
      let data = {};
      try { data = JSON.parse(res.getContentText()); } catch (e) {}
      if (data.ok) return;
      lastError = data.error || ('HTTP ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
    } catch (e) { lastError = String(e); }
    Utilities.sleep(1500 * (attempt + 1));
  }
  throw new Error('Could not reach your main account (HUB_URL): ' + lastError +
    '. Check HUB_URL is the Web app URL of your main account (ends in /exec) and that it is deployed with access "Anyone".');
}

/** The app reads codes here. Only encrypted messages ever leave. */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.c !== keys_().topic) return json_({ ok: false, error: 'wrong channel' });
  const since = Number(p.since) || 0;
  const items = boxRead_().filter(x => x.r > since);
  return json_({ ok: true, now: Date.now(), items: items });
}

/** Your other Gmail accounts send their codes here. */
function doPost(e) {
  const p = (e && e.parameter) || {};
  if (p.c !== keys_().topic) return json_({ ok: false, error: 'wrong channel' });
  const body = e && e.postData ? String(e.postData.contents || '') : '';
  if (body.length > 4000 || !verify_(body, keys_())) return json_({ ok: false, error: 'bad signature (different key?)' });
  boxAdd_(body);
  return json_({ ok: true });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function boxRead_() {
  return JSON.parse(PropertiesService.getScriptProperties().getProperty('box') || '[]');
}

function boxAdd_(m) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const cutoff = Date.now() - BOX_HOURS * 3600000;
    const list = boxRead_().filter(x => x.r > cutoff && x.m !== m);
    let r = Date.now();
    if (list.length && list[list.length - 1].r >= r) r = list[list.length - 1].r + 1;   // strictly increasing
    list.push({ id: Utilities.getUuid().slice(0, 13), r: r, m: m });
    let kept = list.slice(-BOX_LIMIT), json = JSON.stringify(kept);
    while (json.length > BOX_MAX_CHARS && kept.length > 1) { kept = kept.slice(1); json = JSON.stringify(kept); }  // Google allows ~9 KB per value
    PropertiesService.getScriptProperties().setProperty('box', json);
  } finally {
    lock.releaseLock();
  }
}

let keysCache_ = null;
function keys_() {
  if (keysCache_) return keysCache_;
  const k = bytes_(MY_CODES_KEY);
  const topicBytes = hmac_(k, bytes_('my-codes topic'));
  keysCache_ = {
    topic: 'mc' + topicBytes.slice(0, 12).map(b => (b < 16 ? '0' : '') + b.toString(16)).join(''),
    enc: hmac_(k, bytes_('my-codes enc')),
    mac: hmac_(k, bytes_('my-codes mac')),
  };
  return keysCache_;
}

function encrypt_(text, keys, fixedNonce) {
  const plain = bytes_(text);
  const nonce = fixedNonce || randomBytes_(12);
  const out = [];
  for (let block = 0; out.length < plain.length; block++) {
    const stream = hmac_(keys.enc, nonce.concat([0, 0, (block >> 8) & 255, block & 255]));
    for (let j = 0; j < 32 && out.length < plain.length; j++) out.push(plain[out.length] ^ stream[j]);
  }
  const tag = hmac_(keys.mac, nonce.concat(out)).slice(0, 16);
  return '1.' + b64_(nonce) + '.' + b64_(out) + '.' + b64_(tag);
}

function verify_(str, keys) {
  const p = String(str).split('.');
  if (p.length !== 4 || p[0] !== '1') return false;
  let nonce, ct, tag;
  try { nonce = unb64_(p[1]); ct = unb64_(p[2]); tag = unb64_(p[3]); } catch (e) { return false; }
  if (nonce.length !== 12 || tag.length !== 16) return false;
  const check = hmac_(keys.mac, nonce.concat(ct)).slice(0, 16);
  let diff = 0;
  for (let i = 0; i < 16; i++) diff |= check[i] ^ tag[i];
  return diff === 0;
}

// Byte helpers. Google's Utilities use signed bytes (-128..127); everything here uses 0..255.
function bytes_(s) { return Utilities.newBlob(String(s)).getBytes().map(b => b & 255); }
function signed_(arr) { return arr.map(b => (b > 127 ? b - 256 : b)); }
function hmac_(key, data) { return Utilities.computeHmacSha256Signature(signed_(data), signed_(key)).map(b => b & 255); }
function b64_(arr) { return Utilities.base64EncodeWebSafe(signed_(arr)).replace(/=+$/, ''); }
function unb64_(s) { s = String(s); while (s.length % 4) s += '='; return Utilities.base64DecodeWebSafe(s).map(b => b & 255); }
function randomBytes_(n) {
  const seed = bytes_(Utilities.getUuid() + Date.now() + Math.random());
  return hmac_(seed, bytes_(String(Math.random()))).slice(0, n);
}

/** Makes sure this script and the app speak the same encryption (fixed test values). */
function selfTest_() {
  const saved = keysCache_;
  keysCache_ = null;
  const k = bytes_('mcselftestkey1234');
  const keys = {
    topic: '',
    enc: hmac_(k, bytes_('my-codes enc')),
    mac: hmac_(k, bytes_('my-codes mac')),
  };
  const got = encrypt_('{"k":"code","v":"482 917","c":"Google ✓"}', keys, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  keysCache_ = saved;
  if (got !== SELF_TEST_EXPECTED) throw new Error('Encryption self-test failed. Please tell Claude: ' + got);
}
const SELF_TEST_EXPECTED = '1.AQIDBAUGBwgJCgsM.7ijMLeXHHLVS__eiswWYNz9mwo1MRO3O4uQVNKw3UZaMqgpnt3cMS3mCIw.x6dWqwbTAW_86g6KIzAnMg';

function checkConfig_() {
  if (!/^[A-Za-z0-9_-]{12,64}$/.test(MY_CODES_KEY)) throw new Error('Paste your key from the My Codes app into MY_CODES_KEY (top of this file), then Save.');
  if (!ACCOUNT_NAME.trim()) throw new Error('Type a short nickname for this account into ACCOUNT_NAME (top of this file), then Save.');
  if (TELEGRAM_BOT_TOKEN && !/^\d+:[A-Za-z0-9_-]{30,}$/.test(TELEGRAM_BOT_TOKEN.trim())) throw new Error('TELEGRAM_BOT_TOKEN doesn\'t look right. Copy it again from @BotFather.');
  if (HUB_URL && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(HUB_URL)) throw new Error('HUB_URL must be your main account\'s Web app URL (https://script.google.com/macros/s/.../exec), or empty in the main account.');
}

function accountLabel_() {
  return ACCOUNT_NAME.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'gmail';
}

function isFromMe_(from) {
  const me = (Session.getActiveUser().getEmail() || '').toLowerCase();
  return !!me && from.toLowerCase().indexOf('<' + me + '>') !== -1 && !/no-?reply/i.test(from);
}

// ---------- code finding (plain JavaScript, no Google calls) ----------

// Words that appear near codes, in many languages (English, Slovenian, Croatian/Serbian/Bosnian,
// German, Italian, Spanish, French, Portuguese, Dutch, Polish, Czech/Slovak, Hungarian).
const CODE_WORDS = new RegExp([
  'code', 'codes', 'passcode', 'pass code', 'password', 'otp', 'one[- ]time', 'verification', 'verify', 'verif',
  'confirm', 'confirmation', 'security', 'authentication', 'authenticat', '2fa', 'two[- ]factor', 'mfa', 'pin',
  'sign[- ]?in', 'log[- ]?in', 'token', 'access',
  'koda', 'kodo', 'kode', 'kod', 'kodu', 'geslo', 'potrdit', 'preverjan', 'enkratn', 'varnostn', 'prijav',
  'lozink', 'lozinka', 'potvrd', 'verifikac', 'jednokratn', 'sigurnosn', 'prijava',
  'bestätigung', 'bestaetigung', 'sicherheitscode', 'anmelde', 'einmal',
  'codice', 'verifica', 'conferma', 'código', 'codigo', 'verificación', 'verificacion', 'contraseña',
  'vérification', 'connexion', 'mot de passe',
  'verificatiecode', 'inlogcode', 'weryfikac', 'jednorazow', 'ověřovací', 'overovací', 'ellenőrző', 'kód'
].join('|'), 'i');

// Things that make a number NOT a code.
const NOT_CODE_BEFORE = /(order|invoice|account|acct|ref|reference|ticket|case|tracking|customer|member|phone|tel|fax|call|naročil|narocil|račun|racun|št\.|nr\.?|no\.?|#|€|\$|£|eur|usd|chf|kn|rsd)\s*[:.#]?\s*$/i;
const NOT_CODE_AFTER = /^\s*(€|eur|usd|\$|%|kb|mb|gb|px|km|kg|min|minutes|minut|sec|hours|ur|h\b|ura|dni|days|tage)/i;

/**
 * Finds the most likely verification code in an email.
 * Returns {code, score} or null when the email doesn't look like it contains one.
 */
function findCode(subject, body) {
  subject = String(subject || '');
  body = String(body || '')
    .replace(/https?:\/\/\S+/g, ' ')          // links contain lots of numbers
    .replace(/\S+@\S+\.\S+/g, ' ')            // email addresses
    .replace(/ /g, ' ')
    .slice(0, 8000);

  const subjectHasWord = CODE_WORDS.test(subject);
  const text = subject + '\n' + body;
  if (!subjectHasWord && !CODE_WORDS.test(body)) return null;

  const candidates = [];
  const add = (raw, index, kind) => {
    const before = text.slice(Math.max(0, index - 120), index);
    const after = text.slice(index + raw.length, index + raw.length + 60);
    candidates.push({ raw, index, kind, before, after, inSubject: index < subject.length });
  };

  const patterns = [
    { re: /(?<![\w.,:/-])([A-Z]{1,3}-\d{4,8})(?![\w-])/g, kind: 'prefixed' },          // G-123456
    { re: /(?<![\w.,:/+-])(\d{3}[ -]\d{3}|\d{4}[ -]\d{4}|\d{2}[ -]\d{2}[ -]\d{2}|\d{3}[ -]\d{4})(?![\w.,:/-]?\d)/g, kind: 'grouped' },
    { re: /(?<![\w.,:/+-])(\d{4,8})(?![\w]|[.,:/]\d)/g, kind: 'digits' },
    { re: /(?<![\w-])((?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{5,8})(?![\w-])/g, kind: 'mixed' }, // AB12CD
  ];
  patterns.forEach(p => {
    let m;
    p.re.lastIndex = 0;
    while ((m = p.re.exec(text))) add(m[1], m.index, p.kind);
  });

  let best = null;
  const seenIdx = {};
  candidates.forEach(c => {
    if (seenIdx[c.index] && seenIdx[c.index] >= c.raw.length) return; // keep the longest match at a position
    seenIdx[c.index] = c.raw.length;
    const s = score_(c, subjectHasWord);
    if (s > 0 && (!best || s > best.score)) best = { code: c.raw, score: s };
  });
  return best && best.score >= 5 ? best : null;
}

function score_(c, subjectHasWord) {
  const digits = c.raw.replace(/\D/g, '');
  let s = 0;

  // Base by kind / length.
  if (c.kind === 'digits') s += digits.length === 6 ? 4 : digits.length >= 4 && digits.length <= 8 ? 3 : 0;
  if (c.kind === 'grouped') s += 4;
  if (c.kind === 'prefixed') s += 5;
  if (c.kind === 'mixed') {
    if (/^[A-Z]+\d+$|^\d+[A-Z]+$/.test(c.raw) && /^(SMS|OTP|PIN|2FA|ID|USD|EUR|COVID)/.test(c.raw)) return 0;
    if (!/\d.*[A-Z]|[A-Z].*\d/.test(c.raw)) return 0;
    s += 1;
  }

  // Near a "code" word: strongest signal. Closer = better; before the code is better than after.
  const beforeNear = c.before.slice(-60);
  if (CODE_WORDS.test(beforeNear)) s += 5;
  else if (CODE_WORDS.test(c.before)) s += 3;
  if (CODE_WORDS.test(c.after.slice(0, 40))) s += 2;
  if (/[:：]\s*$/.test(c.before)) s += 2;                        // "Your code: 123456"
  if (/(^|\n)\s*$/.test(c.before) && /^\s*(\n|$)/.test(c.after)) s += 3; // code alone on its own line
  if (c.inSubject && subjectHasWord) s += 2;

  // Things that are not codes.
  if (c.kind === 'digits' && digits.length === 4 && /^(19|20)\d\d$/.test(digits)) s -= 6;          // a year
  if (NOT_CODE_BEFORE.test(c.before)) s -= 8;
  if (NOT_CODE_AFTER.test(c.after)) s -= 8;
  if (/[+(]\s*$/.test(c.before) || /^\s*[)]/.test(c.after)) s -= 6;                               // phone-ish
  if (/\d[\s-]*$/.test(c.before) || /^[\s-]*\d/.test(c.after)) s -= 4;                             // part of a longer number
  if (/(©|copyright|\bpošt|\bpost(al)?\s*code|zip|address|naslov|street|ulica|cesta)/i.test(c.before.slice(-40))) s -= 6;
  if (/^\d+$/.test(digits) && /^(\d)\1+$/.test(digits) && digits.length > 4) s -= 2;              // 000000 placeholder
  return s;
}

/**
 * Turns `"Google" <no-reply@accounts.google.com>` into "Google".
 */
function companyName(from, subject) {
  from = String(from || '');
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  let name = m ? m[1].trim() : '';
  const email = (m ? m[2] : from).trim().toLowerCase();
  const domain = (email.split('@')[1] || '').replace(/[>\s]/g, '');

  if (name && !/@/.test(name)) {
    const cleaned = name
      .replace(/\b(no[- ]?reply|do[- ]?not[- ]?reply|donotreply|notifications?|notify|accounts?|account team|team|security|support|service|services|info|mailer|verification|verify|alerts?|auth|id|login|ekipa|podpora)\b/gi, ' ')
      .replace(/[|·•\-–—_:,.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.length >= 2) return cleaned.slice(0, 40);
    if (name.length >= 2 && !/no[- ]?reply/i.test(name)) return name.slice(0, 40);
  }
  return nameFromDomain_(domain) || (subject || 'Code').slice(0, 40);
}

function nameFromDomain_(domain) {
  if (!domain) return '';
  const parts = domain.split('.').filter(Boolean);
  if (parts.length < 2) return '';
  const secondLevel = /^(co|com|net|org|gov|ac|edu)$/.test(parts[parts.length - 2]) && parts.length >= 3;
  const base = secondLevel ? parts[parts.length - 3] : parts[parts.length - 2];
  const known = { google: 'Google', microsoft: 'Microsoft', live: 'Microsoft', outlook: 'Microsoft', apple: 'Apple', icloud: 'Apple',
    amazon: 'Amazon', facebookmail: 'Facebook', facebook: 'Facebook', instagram: 'Instagram', paypal: 'PayPal', github: 'GitHub',
    steampowered: 'Steam', epicgames: 'Epic Games', discord: 'Discord', roblox: 'Roblox', x: 'X', twitter: 'X', tiktok: 'TikTok',
    linkedin: 'LinkedIn', netflix: 'Netflix', spotify: 'Spotify', revolut: 'Revolut', ebay: 'eBay', anthropic: 'Anthropic',
    openai: 'OpenAI', whatsapp: 'WhatsApp', telegram: 'Telegram', snapchat: 'Snapchat', twitch: 'Twitch', ubisoft: 'Ubisoft',
    ea: 'EA', playstation: 'PlayStation', sony: 'Sony', xbox: 'Xbox', nintendo: 'Nintendo', dropbox: 'Dropbox', samsung: 'Samsung' };
  if (known[base]) return known[base];
  return base.charAt(0).toUpperCase() + base.slice(1);
}
