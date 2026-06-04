require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');

// ----------------------------------------------------------------
// Config
// ----------------------------------------------------------------
const PORT = Number(process.env.PORT || 3210);
const API_SECRET = process.env.API_SECRET || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_BOT_USERNAME = (process.env.TELEGRAM_BOT_USERNAME || '').replace('@', '').trim();
const BIND_SECRET = process.env.BIND_SECRET || API_SECRET;
const BIND_TTL_SECONDS = Number(process.env.BIND_TTL_SECONDS || 60 * 60 * 24 * 30);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'telegram-bindings.json');

if (!API_SECRET) {
    console.warn('[WARN] API_SECRET not set. Requests to API will be accepted without auth.');
}

if (!TELEGRAM_BOT_TOKEN) {
    console.warn('[WARN] TELEGRAM_BOT_TOKEN is not set. Bot will not receive/send Telegram messages.');
}

if (!BIND_SECRET) {
    console.warn('[WARN] BIND_SECRET is not set. Binding links cannot be signed securely.');
}

let isReady = false;
let updateOffset = 0;

function ensureDataDir() {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
}

function loadState() {
    ensureDataDir();
    if (!fs.existsSync(DATA_FILE)) {
        return { bindings: {}, chatToEmployee: {} };
    }

    try {
        const raw = fs.readFileSync(DATA_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return {
            bindings: parsed.bindings || {},
            chatToEmployee: parsed.chatToEmployee || {},
        };
    } catch (err) {
        console.error('[State] Failed to load bindings file:', err.message);
        return { bindings: {}, chatToEmployee: {} };
    }
}

function saveState() {
    ensureDataDir();
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, DATA_FILE);
}

const state = loadState();

function makeBindToken(employeeId) {
    if (!BIND_SECRET) {
        return null;
    }

    const exp = Math.floor(Date.now() / 1000) + BIND_TTL_SECONDS;
    const base = `${employeeId}.${exp}`;
    const sig = crypto
        .createHmac('sha256', BIND_SECRET)
        .update(base)
        .digest('base64url')
        .slice(0, 16);

    return `${employeeId}.${exp}.${sig}`;
}

function verifyBindToken(token) {
    if (!BIND_SECRET || !token) {
        return { ok: false, error: 'invalid_or_missing_token' };
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
        return { ok: false, error: 'bad_token_format' };
    }

    const [employeeIdRaw, expRaw, sigRaw] = parts;
    if (!/^\d+$/.test(employeeIdRaw) || !/^\d+$/.test(expRaw) || !/^[A-Za-z0-9_-]{8,32}$/.test(sigRaw)) {
        return { ok: false, error: 'bad_token_parts' };
    }

    const employeeId = String(Number(employeeIdRaw));
    const exp = Number(expRaw);
    if (!employeeId || Number.isNaN(exp)) {
        return { ok: false, error: 'bad_token_values' };
    }

    if (Math.floor(Date.now() / 1000) > exp) {
        return { ok: false, error: 'token_expired' };
    }

    const expected = crypto
        .createHmac('sha256', BIND_SECRET)
        .update(`${employeeId}.${exp}`)
        .digest('base64url')
        .slice(0, 16);

    if (expected !== sigRaw) {
        return { ok: false, error: 'bad_signature' };
    }

    return { ok: true, employeeId };
}

function buildBindLink(employeeId) {
    if (!TELEGRAM_BOT_USERNAME) {
        return null;
    }

    const token = makeBindToken(employeeId);
    if (!token) {
        return null;
    }

    return {
        token,
        link: `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${encodeURIComponent(token)}`,
    };
}

function bindEmployeeToChat(employeeId, from) {
    const chatId = String(from.id);

    const existingEmployeeForChat = state.chatToEmployee[chatId];
    if (existingEmployeeForChat && existingEmployeeForChat !== employeeId) {
        delete state.bindings[existingEmployeeForChat];
    }

    const existingBindingForEmployee = state.bindings[employeeId];
    if (existingBindingForEmployee && existingBindingForEmployee.chat_id) {
        delete state.chatToEmployee[String(existingBindingForEmployee.chat_id)];
    }

    state.bindings[employeeId] = {
        chat_id: chatId,
        username: from.username || null,
        first_name: from.first_name || null,
        last_name: from.last_name || null,
        bound_at: new Date().toISOString(),
    };
    state.chatToEmployee[chatId] = employeeId;
    saveState();
}

async function tgRequest(method, params) {
    if (!TELEGRAM_BOT_TOKEN) {
        throw new Error('TELEGRAM_BOT_TOKEN is not configured');
    }

    const body = new URLSearchParams();
    Object.entries(params || {}).forEach(([k, v]) => {
        if (v !== undefined && v !== null) {
            body.append(k, String(v));
        }
    });

    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });

    let payload;
    try {
        payload = await response.json();
    } catch (_err) {
        throw new Error(`Telegram ${method} returned invalid JSON`);
    }

    if (!response.ok || !payload.ok) {
        throw new Error(`Telegram ${method} failed: ${payload.description || `HTTP ${response.status}`}`);
    }

    return payload;
}

async function sendTelegramText(chatId, message) {
    return tgRequest('sendMessage', {
        chat_id: chatId,
        text: message,
        disable_web_page_preview: true,
    });
}

async function handleIncomingMessage(message) {
    if (!message || !message.from || !message.text) {
        return;
    }

    const text = String(message.text).trim();

    if (text.startsWith('/start')) {
        const parts = text.split(/\s+/);
        const token = parts[1] || '';
        const check = verifyBindToken(token);

        if (!token) {
            await sendTelegramText(
                message.chat.id,
                'Привет! Чтобы привязать аккаунт, откройте бота по персональной ссылке от менеджера.'
            );
            return;
        }

        if (!check.ok) {
            await sendTelegramText(
                message.chat.id,
                'Ссылка привязки недействительна или устарела. Попросите новую ссылку у менеджера.'
            );
            return;
        }

        bindEmployeeToChat(check.employeeId, message.from);
        await sendTelegramText(
            message.chat.id,
            `Готово! Telegram привязан к сотруднику #${check.employeeId}. Теперь вы будете получать уведомления здесь.`
        );
        console.log(`[Bind] employee_id=${check.employeeId} chat_id=${message.chat.id}`);
        return;
    }

    const employeeId = state.chatToEmployee[String(message.from.id)];
    if (employeeId) {
        await sendTelegramText(message.chat.id, `Вы привязаны как сотрудник #${employeeId}.`);
    } else {
        await sendTelegramText(
            message.chat.id,
            'Этот чат еще не привязан. Откройте персональную ссылку привязки от менеджера.'
        );
    }
}

async function pollTelegram() {
    while (true) {
        try {
            const updates = await tgRequest('getUpdates', {
                timeout: 30,
                offset: updateOffset,
                allowed_updates: JSON.stringify(['message']),
            });

            isReady = true;
            for (const update of updates.result || []) {
                updateOffset = update.update_id + 1;
                await handleIncomingMessage(update.message);
            }
        } catch (err) {
            isReady = false;
            console.error('[Telegram] Polling error:', err.message);
            await new Promise((resolve) => setTimeout(resolve, 3000));
        }
    }
}

if (TELEGRAM_BOT_TOKEN) {
    pollTelegram().catch((err) => {
        console.error('[Telegram] Fatal polling error:', err.message);
    });
}

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
 * Body: { "employee_id": 123, "message": "Text" }
 */
app.post('/send', async (req, res) => {
    const employeeId = String(req.body?.employee_id || req.body?.employeeId || req.body?.user_id || '').trim();
    const message = req.body?.message;

    if (!employeeId || !message) {
        return res.status(400).json({ ok: false, error: 'employee_id and message are required' });
    }

    const binding = state.bindings[employeeId];
    if (!binding || !binding.chat_id) {
        const bind = buildBindLink(employeeId);
        return res.status(404).json({
            ok: false,
            error: 'Employee telegram is not bound yet',
            employee_id: employeeId,
            bind_link: bind ? bind.link : null,
            bind_token: bind ? bind.token : null,
        });
    }

    try {
        await sendTelegramText(binding.chat_id, String(message));
        console.log(`[Send] -> employee_id=${employeeId} chat_id=${binding.chat_id}: ${String(message).substring(0, 80)}`);
        res.json({ ok: true, employee_id: employeeId, chat_id: binding.chat_id });
    } catch (err) {
        console.error('[Send] Error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

/**
 * GET/POST /bind-link
 * Params/body: { employee_id: 123 }
 */
app.post('/bind-link', (req, res) => {
    const employeeId = String(req.body?.employee_id || req.body?.employeeId || req.body?.user_id || '').trim();
    if (!employeeId) {
        return res.status(400).json({ ok: false, error: 'employee_id is required' });
    }

    const bind = buildBindLink(employeeId);
    if (!bind) {
        return res.status(500).json({
            ok: false,
            error: 'Failed to generate bind link. Check TELEGRAM_BOT_USERNAME and BIND_SECRET.',
        });
    }

    return res.json({ ok: true, employee_id: employeeId, bind_link: bind.link, bind_token: bind.token });
});

app.get('/bind-link', (req, res) => {
    const employeeId = String(req.query?.employee_id || req.query?.employeeId || req.query?.user_id || '').trim();
    if (!employeeId) {
        return res.status(400).json({ ok: false, error: 'employee_id is required' });
    }

    const bind = buildBindLink(employeeId);
    if (!bind) {
        return res.status(500).json({
            ok: false,
            error: 'Failed to generate bind link. Check TELEGRAM_BOT_USERNAME and BIND_SECRET.',
        });
    }

    return res.json({ ok: true, employee_id: employeeId, bind_link: bind.link, bind_token: bind.token });
});

app.get('/bindings', (req, res) => {
    res.json({ ok: true, bindings: state.bindings });
});

// Health check
app.get('/status', (req, res) => {
    res.json({
        ok: true,
        telegram_ready: isReady,
        bot_username: TELEGRAM_BOT_USERNAME || null,
        bindings_total: Object.keys(state.bindings).length,
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Listening on http://0.0.0.0:${PORT}`);
});
