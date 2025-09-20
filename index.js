import { config } from "dotenv";
import express from "express";
import BrowserManager from "./browserManager.js";
import TaskManager from "./taskManager.js";
import TelegramNotifier from "./telegramNotifier.js";
import logger from "./logger.js";

config();

const app = express();
let browserManager = null;
let taskManager = null;
let notifier = null;
let isInitializing = false;

export async function restartMonitoring() {
  logger.info("Перезапуск мониторинга...");

  try {
    if (taskManager) {
      await taskManager.stopMonitoring();
    }

    if (browserManager) {
      await browserManager.close();
    }

    browserManager = new BrowserManager();
    await browserManager.init();

    taskManager = new TaskManager(browserManager, notifier);
    await taskManager.startMonitoring();

    logger.info("Мониторинг успешно перезапущен");
  } catch (error) {
    logger.error({ error: error.message }, "Ошибка перезапуска мониторинга");
    throw error;
  }
}

async function initialize() {
  if (isInitializing) return;
  isInitializing = true;

  try {
    notifier = new TelegramNotifier({
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      chatId: process.env.TELEGRAM_CHAT_ID,
    });

    if (!process.env.TELEGRAM_CHAT_ID) {
      logger.info("ChatId не задан. Для получения отправьте сообщение боту.");
      const chatId = await notifier.listenForChatId();
      logger.info(
        `Запишите полученный chatId в .env: TELEGRAM_CHAT_ID=${chatId}`
      );
      process.exit(0);
    }

    browserManager = new BrowserManager();
    await browserManager.init();

    taskManager = new TaskManager(browserManager, notifier);
    await taskManager.startMonitoring();

    notifier.startPolling();

    app.get("/health", (req, res) => res.status(200).send("OK"));

    app.use(express.json());
    app.post("/webhook", async (req, res) => {
      try {
        const update = req.body;

        if (update.message) {
          await notifier.handleMessage(update.message);
        }

        if (update.callback_query) {
          await notifier.handleCallback(update.callback_query);
        }

        res.status(200).send("OK");
      } catch (error) {
        logger.error({ error: error.message }, "Ошибка обработки webhook");
        res.status(500).send("Error");
      }
    });

    const port = process.env.PORT || 3000;
    app.listen(port, () => {
      logger.info(`HTTP сервер запущен на порту ${port}`);
    });

    process.on("SIGINT", async () => {
      logger.info("Завершение работы...");
      if (taskManager) {
        await taskManager.stopMonitoring();
      }
      if (browserManager) {
        await browserManager.close();
      }
      if (notifier) {
        notifier.stopPolling();
      }
      process.exit(0);
    });

    process.on("uncaughtException", (error) => {
      logger.error({ error: error.message }, "Необработанное исключение");
    });

    process.on("unhandledRejection", (reason, promise) => {
      logger.error(
        { reason: reason.message, promise },
        "Необработанный промис"
      );
    });
  } catch (error) {
    logger.error({ error: error.message }, "Ошибка инициализации приложения");
    process.exit(1);
  } finally {
    isInitializing = false;
  }
}

initialize();
