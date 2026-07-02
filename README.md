# Puma Alerts

Node.js + Puppeteer сервис для мониторинга доски задач в Tracker, уведомлений о новых задачах и опционального автозабора по настроенным правилам.

## Что умеет

- Мониторит выбранный виджет на дашборде Tracker
- Присылает уведомления о новых задачах
- Может автоматически брать задачи в работу
- Фильтрует задачи по `SPRINT_WHITELIST`
- Восстанавливает браузер после части сбоев
- Поддерживает каналы уведомлений: Telegram, email или оба сразу

## Требования

- Node.js 18+
- Google Chrome или Chromium
- Доступ к Yandex Tracker / ST
- Для Telegram-уведомлений: бот и `TELEGRAM_BOT_TOKEN`
- Для email-уведомлений: SMTP-настройки

## Установка

1. Клонируйте репозиторий:

```bash
git clone <your-repo-url>
cd puma-alerts
```

2. Установите зависимости:

```bash
npm install
```

3. Создайте и заполните `.env`.

## Быстрый старт

Минимальный пример `.env`:

```env
PUPPETEER_EXECUTABLE_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome

TARGET_BOARD_URL=https://st.yandex-team.ru/dashboard/66958
TASK_WIDGET_TITLE=Обычные задачи

NOTIFICATION_CHANNELS=telegram

TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

AUTO_ASSIGN=1
SPRINT_WHITELIST=1,2,3
MAX_TASKS=2
USER_DATA_DIR=./tmp/puppeteer_user_data
LOG_LEVEL=info
PORT=5023
```

Запуск:

```bash
npm start
```

Если Telegram включён, но `TELEGRAM_CHAT_ID` не задан, приложение ждёт входящее сообщение боту и выводит нужный `chatId` в консоль.

## Каналы уведомлений

Основная переменная:

```env
NOTIFICATION_CHANNELS=telegram
```

Поддерживаемые значения:

- `telegram` - уведомления только в Telegram
- `email` - уведомления только на почту
- `telegram,email` - отправка в оба канала

Замечания:

- Если включён `telegram`, должны быть заданы `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID`.
- Если включён `email`, должны быть заданы SMTP-переменные.
- Если включены оба канала, сбой одного канала не блокирует второй.

## Переменные окружения

### Основные

| Variable | Description | Default |
| --- | --- | --- |
| `TARGET_BOARD_URL` | URL дашборда, который мониторим | - |
| `TASK_WIDGET_TITLE` | Заголовок виджета с задачами | `Обычные задачи` |
| `AUTO_ASSIGN` | Включить автозабор задач | `1` |
| `MAX_TASKS` | Лимит задач, которые можно взять | `4` |
| `SPRINT_WHITELIST` | Список спринтов через запятую | пусто |
| `NOTIFICATION_CHANNELS` | Каналы уведомлений: `telegram`, `email`, `telegram,email` | `telegram` |
| `LOG_LEVEL` | Уровень логирования Pino | `info` |
| `PORT` | Порт HTTP-сервера | `3000` |

### Браузер и навигация

| Variable | Description | Default |
| --- | --- | --- |
| `PUPPETEER_EXECUTABLE_PATH` | Путь до Chrome/Chromium | автоопределение |
| `USER_DATA_DIR` | Папка профиля браузера | системный temp-путь |
| `USER_AGENT` | User-Agent для страниц | встроенное значение |
| `NAVIGATION_WAIT_UNTIL` | Режим ожидания навигации: `load`, `domcontentloaded`, `networkidle0`, `networkidle2` | `domcontentloaded` |
| `NAVIGATION_TIMEOUT_MS` | Таймаут навигации в миллисекундах | `30000` |

Примечание: `HEADLESS` сейчас не используется напрямую. Режим headless выбирается кодом автоматически в hosting-окружении.

### Telegram

| Variable | Description | Default |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Токен Telegram-бота | - |
| `TELEGRAM_CHAT_ID` | Chat ID для уведомлений и команд | - |

Доступные команды в Telegram:

- `/start`
- `/config`
- `/restart`

### Email / SMTP

| Variable | Description | Default |
| --- | --- | --- |
| `SMTP_USER` | Логин отправителя | - |
| `SMTP_PASSWORD` | Пароль / app password | - |
| `SMTP_RECIPIENT` | Получатель уведомлений | - |
| `SMTP_HOST` | SMTP-хост | `smtp.yandex.ru` |
| `SMTP_PORT` | SMTP-порт | `465` |

## Как это работает

1. Приложение поднимает браузер и открывает `TARGET_BOARD_URL`.
2. Ищет виджет по `TASK_WIDGET_TITLE`.
3. Извлекает задачи и сравнивает их с уже замеченными.
4. Отправляет уведомления в выбранные каналы.
5. Если `AUTO_ASSIGN=1`, дополнительно пытается взять подходящие задачи в работу.
6. При сбоях пытается восстановить браузер и продолжить мониторинг.

## HTTP endpoints

- `GET /health` - проверка, что процесс жив
- `POST /webhook` - обработка Telegram webhook, если вы используете webhook-схему вместо polling

Если Telegram-канал выключен, `POST /webhook` фактически не используется.

## Структура

```text
src/
├── index.js
├── browserManager.js
├── config.js
├── emailNotifier.js
├── logger.js
├── mailService.js
├── notifier.js
├── taskManager.js
├── telegramNotifier.js
└── utils.js
```

## Запуск и диагностика

```bash
npm start
```

Что проверить, если что-то не работает:

- Корректен ли `TARGET_BOARD_URL`
- Совпадает ли `TASK_WIDGET_TITLE` с реальным названием виджета
- Есть ли действующая авторизация в браузерном профиле `USER_DATA_DIR`
- Доступен ли Chrome по `PUPPETEER_EXECUTABLE_PATH`
- Заполнены ли переменные для выбранного канала уведомлений

## Что важно знать

- `TARGET_URL` сейчас в runtime не используется, ориентируйтесь на `TARGET_BOARD_URL`.
- `AUTH` сейчас не используется и не нужен в `.env`.
- Скрипт в `package.json` только один: `npm start`.
