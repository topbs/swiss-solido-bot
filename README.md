Swiss Solido Telegram bot for local development and later VPS deployment.

Setup:

```bash
cp .env.example .env
npm install
npm run dev
```

Required env values:

```env
PORT=3210
API_SECRET=some-random-secret
TELEGRAM_BOT_TOKEN=123456789:botfather-token
TELEGRAM_BOT_USERNAME=YourBotName
BIND_SECRET=another-random-secret
```

What it does:

- polls Telegram with `getUpdates`
- binds a Telegram chat to a specific employee via deep link `https://t.me/<bot>?start=<token>`
- stores bindings in `data/telegram-bindings.json`
- sends notifications through HTTP `POST /send`

API:

`GET /status`

Returns bot health and binding count.

`GET /bind-link?employee_id=123`

Returns a personal Telegram link for employee `123`.

`POST /send`

```json
{
	"employee_id": 123,
	"message": "Swiss Solido: вам назначено новое задание"
}
```

Headers:

```text
x-api-secret: <API_SECRET>
```

Binding flow:

1. WordPress requests `/bind-link?employee_id=<user_id>`.
2. Employee opens the returned Telegram link.
3. Employee presses Start in Telegram.
4. Bot saves `chat_id` for that employee.
5. WordPress can then send notifications via `/send`.

Important limitation:

Telegram bots cannot initiate a conversation. The employee must open the bot at least once through the personal link.