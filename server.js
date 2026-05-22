require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode  = require('qrcode-terminal');
const express = require('express');

// ----------------------------------------------------------------
// Config
// ----------------------------------------------------------------
const PORT       = process.env.PORT || 3210;
const API_SECRET = process.env.API_SECRET || '';

if (!API_SECRET) {
    console.warn('[WARN] API_SECRET not set — all requests will be accepted. Set it in .env!');
}

// ----------------------------------------------------------------
// WhatsApp client
// ----------------------------------------------------------------
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    webVersion: '2.3000.1023141244-alpha',
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1023141244-alpha.html',
    },
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--disable-extensions',
            '--no-first-run',
            '--no-zygote',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
        ],
    },
});

let isReady = false;

client.on('qr', (qr) => {
    console.log('\n[WhatsApp] Сканируйте QR-код своим телефоном:\n');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
    console.log('[WhatsApp] Аутентификация успешна. Сессия сохранена.');
});

client.on('auth_failure', (msg) => {
    console.error('[WhatsApp] Ошибка аутентификации:', msg);
});

client.on('loading_screen', (percent, message) => {
    console.log(`[WhatsApp] Загрузка... ${percent}% — ${message}`);
});

client.on('ready', () => {
    isReady = true;
    console.log('[WhatsApp] Клиент готов к отправке сообщений.');
});

client.on('disconnected', (reason) => {
    isReady = false;
    console.log('[WhatsApp] Отключён:', reason);
    // Пробуем переподключиться
    client.initialize();
});

client.initialize();

// ----------------------------------------------------------------
// Express API
// ----------------------------------------------------------------
const app = express();
app.use(express.json());

// Middleware: проверка API_SECRET
app.use((req, res, next) => {
    if (!API_SECRET) return next();
    const token = req.headers['x-api-secret'] || req.body?.secret;
    if (token !== API_SECRET) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    next();
});

/**
 * POST /send
 * Body: { "phone": "41791234567", "message": "Текст сообщения" }
 *
 * phone — номер в международном формате без «+»
 */
app.post('/send', async (req, res) => {
    const { phone, message } = req.body;

    if (!phone || !message) {
        return res.status(400).json({ ok: false, error: 'phone and message are required' });
    }

    if (!isReady) {
        return res.status(503).json({ ok: false, error: 'WhatsApp client not ready yet' });
    }

    // whatsapp-web.js принимает chatId вида "41791234567@c.us"
    const chatId = phone.replace(/\D/g, '') + '@c.us';

    try {
        await client.sendMessage(chatId, message);
        console.log(`[Send] → ${phone}: ${message.substring(0, 60)}…`);
        res.json({ ok: true });
    } catch (err) {
        console.error('[Send] Ошибка:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// Health check
app.get('/status', (req, res) => {
    res.json({ ok: true, whatsapp_ready: isReady });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Слушаю на http://0.0.0.0:${PORT}`);
});
