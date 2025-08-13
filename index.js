import express from 'express';
import qrcode from 'qrcode-terminal';
import fetch from 'node-fetch';
import { Client, LocalAuth } from 'whatsapp-web.js';

const app = express();
app.use(express.json());

// ====== ENV (set di Railway) ======
// AUTH_DIR: path untuk simpan session (contoh: /data/wa-auth)
// WEBHOOK_URL: (opsional) endpoint kamu untuk menerima pesan masuk
const AUTH_DIR = process.env.AUTH_DIR || '.wwebjs_auth';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';

/**
 * Client WhatsApp
 * LocalAuth akan menyimpan session ke AUTH_DIR.
 * Di Railway, pastikan tambah Persistent Volume dan arahkan AUTH_DIR ke volume itu,
 * supaya tidak perlu scan QR tiap deploy.
 */
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: AUTH_DIR }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--disable-features=IsolateOrigins',
      '--disable-site-isolation-trials'
    ]
  }
});

// ====== Event handlers ======
client.on('qr', (qr) => {
  console.log('QR muncul. Scan di terminal:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('✅ WhatsApp Bot siap!');
});

client.on('authenticated', () => {
  console.log('🔐 Authenticated.');
});

client.on('auth_failure', (m) => {
  console.error('❌ Auth failure:', m);
});

client.on('disconnected', (r) => {
  console.warn('⚠️ Disconnected:', r);
  client.initialize();
});

// Terima pesan masuk -> forward ke WEBHOOK_URL (kalau ada)
client.on('message', async (msg) => {
  console.log(`📩 From ${msg.from}: ${msg.body}`);
  if (!WEBHOOK_URL) return;

  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: msg.from,
        to: msg.to,
        body: msg.body,
        timestamp: msg.timestamp,
        type: msg.type,
        id: msg.id?._serialized
      })
    });
  } catch (err) {
    console.error('Webhook forward error:', err.message);
  }
});

// ====== Helpers ======
const normalizeTo = (to) => {
  // Jika sudah @c.us (kontak) atau @g.us (grup), pakai apa adanya
  if (/@[cg]\.us$/.test(to)) return to;

  // Jika berupa nomor (hanya digit), anggap nomor internasional (62xxxx) -> kontak
  if (/^\d+$/.test(to)) return `${to}@c.us`;

  // Kalau bukan keduanya, lempar error
  throw new Error('Parameter "to" harus nomor internasional (mis: 62812xxxx) atau id chat lengkap *@c.us/@g.us*');
};

// ====== API ======
app.get('/', (_req, res) => res.send('Bot WA OK. Endpoints: POST /send, /sendGroupByName, GET /health'));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Kirim pesan ke nomor / chatId
// body: { "to": "62812xxxx" | "xxxx@g.us" | "62812xxxx@c.us", "message": "text" }
app.post('/send', async (req, res) => {
  try {
    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ status: 'error', message: 'to & message wajib diisi' });

    const chatId = normalizeTo(to);
    await client.sendMessage(chatId, String(message));
    return res.json({ status: 'ok', to: chatId });
  } catch (err) {
    console.error('Send error:', err);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

// Kirim ke grup berdasarkan NAMA grup (ambil subject)
// body: { "groupName": "Nama Grup", "message": "text" }
app.post('/sendGroupByName', async (req, res) => {
  try {
    const { groupName, message } = req.body;
    if (!groupName || !message) return res.status(400).json({ status: 'error', message: 'groupName & message wajib diisi' });

    const chats = await client.getChats();
    const group = chats.find(c => c.isGroup && c.name.toLowerCase() === groupName.toLowerCase());
    if (!group) return res.status(404).json({ status: 'error', message: 'Grup tidak ditemukan' });

    await client.sendMessage(group.id._serialized, String(message));
    return res.json({ status: 'ok', groupId: group.id._serialized, groupName: group.name });
  } catch (err) {
    console.error('SendGroupByName error:', err);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

// Broadcast ke banyak nomor
// body: { "numbers": ["62812xxx","62813xxx"], "message": "text" }
app.post('/broadcast', async (req, res) => {
  try {
    const { numbers, message } = req.body;
    if (!Array.isArray(numbers) || !message) return res.status(400).json({ status: 'error', message: 'numbers[] & message wajib' });

    const results = [];
    for (const n of numbers) {
      const chatId = normalizeTo(n);
      await client.sendMessage(chatId, String(message));
      results.push({ to: chatId, status: 'sent' });
    }
    return res.json({ status: 'ok', results });
  } catch (err) {
    console.error('Broadcast error:', err);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on :${PORT}`));

client.initialize();
