# Task Monitor 🤖

A sophisticated automated task monitoring and management system built with Node.js and Puppeteer. Continuously monitors task boards, automatically assigns tasks based on configurable rules, and provides real-time notifications via Telegram.

## ✨ Features

- **Real-time Monitoring**: Continuously scans the configured task widget on the dashboard
- **Smart Auto-Assignment**: Automatically claims tasks based on sprint whitelist rules
- **Cross-Platform**: Works on Windows, macOS, and Linux
- **Telegram Integration**: Instant notifications with task details and status updates
- **Configurable Limits**: Set maximum task limits and customize sprint filters
- **Persistent Sessions**: Maintains browser state and authentication
- **Error Resilience**: Automatic retries and recovery mechanisms

## 🚀 Quick Start

### Prerequisites

- Node.js 16+
- Google Chrome or Chromium
- Telegram Bot Token ([Create one here](https://t.me/BotFather))

### Installation

1. **Clone the repository**

```bash
git clone <your-repo-url>
cd task-monitor
```

2. **Install dependencies**

```bash
npm install
```

3. **Configure environment**

```bash
cp .env.example .env
```

4. **Edit `.env` file**

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_CHAT_ID=your_chat_id_here

AUTO_ASSIGN=1
AUTH=1
MAX_TASKS=15
SPRINT_WHITELIST=19,10,14
TARGET_URL=https://your-target-url.com
TARGET_BOARD_URL=https://your-board-url.com
TASK_WIDGET_TITLE=Обычные задачи

USER_DATA_DIR=./tmp/puppeteer_user_data
```

5. **Get your Chat ID**

```bash
npm start
```

Send any message to your bot and the console will display your Chat ID.

6. **Start monitoring**

```bash
npm start
```

## ⚙️ Configuration

### Environment Variables

| Variable             | Description                      | Default                     |
| -------------------- | -------------------------------- | --------------------------- |
| `TELEGRAM_BOT_TOKEN` | Your Telegram Bot token          | -                           |
| `TELEGRAM_CHAT_ID`   | Your Telegram Chat ID            | -                           |
| `AUTO_ASSIGN`        | Enable automatic task assignment | `1` (true)                  |
| `MAX_TASKS`          | Maximum tasks to auto-assign     | `15`                        |
| `SPRINT_WHITELIST`   | Comma-separated sprint numbers   | -                           |
| `TARGET_URL`         | Base URL for task links          | -                           |
| `TARGET_BOARD_URL`   | Dashboard URL to monitor         | -                           |
| `TASK_WIDGET_TITLE`  | Widget title to scan on dashboard| `Обычные задачи`            |
| `AUTH`               | Enable authentication handling   | `1` (true)                  |
| `USER_DATA_DIR`      | Browser profile directory        | `./tmp/puppeteer_user_data` |

### Telegram Commands

- `/start` - Initialize the bot
- `/config` - Open configuration panel
- `/restart` - Restart monitoring

## 🏗️ Architecture

```
src/
├── index.js          # Main application entry point
├── browserManager.js # Browser instance management
├── taskManager.js    # Task monitoring logic
├── telegramNotifier.js # Telegram bot integration
├── mailService.js    # Email fallback notifications
├── logger.js         # Structured logging
├── config.js         # Configuration management
└── utils.js          # Utility functions
```

## 🔧 How It Works

1. **Initialization**: Launches headless browser and navigates to task board
2. **Authentication**: Handles login if required (4-minute grace period)
3. **Monitoring**: Continuously checks the configured dashboard widget
4. **Filtering**: Applies sprint whitelist rules to tasks
5. **Assignment**: Automatically claims qualifying tasks
6. **Notification**: Sends Telegram alerts for new tasks and assignments
7. **Recovery**: Automatic retry on errors with exponential backoff

## 🎯 Task Filtering

Tasks are filtered based on:

- Sprint numbers in brackets (e.g., `[10] Task title`)
- Configurable whitelist (`SPRINT_WHITELIST=19,10,14`)
- Maximum task limit (`MAX_TASKS=15`)

## 📊 Notifications

### Telegram Messages

- ✅ Task assigned successfully
- 🚀 New tasks detected
- ⚠️ Authentication required
- ❌ Error notifications
- 📋 Configuration updates

### Email Fallback

If Telegram fails, notifications are sent via email as backup.

## 🛠️ Development

### Scripts

```bash
npm start      # Start production monitoring
npm run dev    # Start development mode
```

### Logging

Uses Pino for structured JSON logging with pretty-print in development.

## 🌐 Deployment

### Local Deployment

```bash
npm start
```

### Production Deployment

1. Set `NODE_ENV=production`
2. Configure reverse proxy for webhook endpoints
3. Set up process manager (PM2 recommended)

### Docker (Example)

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
CMD ["npm", "start"]
```

## 📈 Monitoring Endpoints

- `GET /health` - Health check endpoint
- `POST /webhook` - Telegram webhook handler

## 🔒 Security

- Environment-based configuration
- Secure credential storage
- No hardcoded secrets
- Input validation and sanitization

## 🐛 Troubleshooting

### Common Issues

1. **Chrome not found**

   - Install Google Chrome
   - Set `PUPPETEER_EXECUTABLE_PATH` in environment

2. **Authentication failures**

   - Check network connectivity
   - Verify credentials in browser session

3. **Telegram notifications not working**
   - Verify bot token and chat ID
   - Check internet connectivity

### Logs

Check application logs for detailed error information and debugging.

## 📄 License

MIT License - see LICENSE file for details.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 🆘 Support

For issues and questions:

1. Check the troubleshooting section
2. Review application logs
3. Create a GitHub issue with detailed information
