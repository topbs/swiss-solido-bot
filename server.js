require('dotenv').config();

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom }    = require('@hapi/boom');
const qrcode      = require('qrcode-terminal');
const pino        = require('pino');
const express     = require('express');

// ----------------------------------------------------------------
// Config
// ----------------------------------------------------------------
const PORT       = process.env.PORT || 3210;
const API_SECRET = process.env.API_SECRET || '';

if (!API_SECRET) {
    console.warn('[WARN] API_SECRET not set — all requests will be accepted. Set it in .env!');
}

// ----------------------------------------------------------------
// WhatsApp (Baileys — без Chrome, чистый WebSocket)
// ----------------------------------------------------------------
let sock    = null;
let isReady = false;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

    sock = makeWASocket({
        auth:   state,
        logger: pino({ level: 'silent' }),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n[WhatsApp] Сканируйте QR-код своим телефоном:\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            isReady = false;
            const reason = lastDisconnect?.error instanceof Boom
                ? lastDisconnect.error.output.statusCode
                : 0;
            const shouldReconnect = reason !== DisconnectReason.loggedOut;
            console.log(`[WhatsApp] Соединение закрыто (reason: ${reason}). Переподключение: ${shouldReconnect}`);
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 3000);
            } else {
                console.log('[WhatsApp] Вышли из аккаунта. Удалите папку auth_info и перезапустите.');
            }
        }

        if (connection === 'open') {
            isReady = true;
            console.log('[WhatsApp] Клиент готов к отправке сообщений.');
        }
    });
}

connectToWhatsApp();

// ----------------------------------------------------------------
// Express API
// ----------------------------------------------------------------
const app = express();
app.use(express.json());

// Auth
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
 * Body: { "phone": "41791234567", "message": "Текст" }
 */
app.post('/send', async (req, res) => {
    const { phone, message } = req.body;

    if (!phone || !message) {
        return res.status(400).json({ ok: false, error: 'phone and message are required' });
    }

    if (!isReady) {
        return res.status(503).json({ ok: false, error: 'WhatsApp client not ready yet' });
    }

    // Baileys: PHONE@s.whatsapp.net
    const chatId = phone.replace(/\D/g, '') + '@s.whatsapp.net';

    try {
        await sock.sendMessage(chatId, { text: message });
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
