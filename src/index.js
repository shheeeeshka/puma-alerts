import { config } from "dotenv";
import express from "express";
import BrowserManager from "./browserManager.js";
import TaskManager from "./taskManager.js";
import TelegramNotifier from "./telegramNotifier.js";
import logger from "./logger.js";
import CONFIG from "./config.js";

config();

const app = express();
let browserManager = null;
let taskManager = null;
let notifier = null;
let isInitializing = false;
let isRestarting = false;

export async function restartMonitoring() {
  if (isRestarting) {
    logger.info("Перезапуск уже выполняется");
    return;
  }

  isRestarting = true;
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
  } finally {
    isRestarting = false;
  }
}

function getMonitoringConfigMessage() {
  const sprintWhitelist = formatSprintWhitelist(CONFIG.sprintWhitelist);
  const monitoringActive = taskManager?.isMonitoringActive() ? "yes" : "no";
  const serverPort = process.env.PORT || 3000;

  return [
    "⚙️ Текущий конфиг:",
    "",
    `Автозабор: ${CONFIG.autoAssign ? "1" : "0"}`,
    `Лимит задач: ${CONFIG.maxTasks}`,
    `Взято задач: ${taskManager?.getTasksTaken() ?? 0} ✅`,
    `Спринты: ${sprintWhitelist} 🏃`,
    `Доска: ${CONFIG.targetBoardUrl || "не задана"} 🔗`,
    `Карточка: ${CONFIG.taskWidgetTitle}`,
    `Мониторинг: ${monitoringActive} 🖥`,
    `Порт сервера: ${serverPort}`,
    `SMTP пользователь: ${process.env.SMTP_USER || "не задан"}`,
    `SMTP получатель: ${process.env.SMTP_RECIPIENT || "не задан"}`,
    `SMTP хост: ${process.env.SMTP_HOST || "не задан"}`,
    `SMTP порт: ${process.env.SMTP_PORT || "не задан"}`,
    `Ожидание навигации: ${CONFIG.navigationWaitUntil}`,
    `Таймаут навигации: ${CONFIG.navigationTimeoutMs}`,
  ].join("\n");
}

function formatSprintWhitelist(sprintWhitelist) {
  if (!sprintWhitelist.length) {
    return "not set";
  }

  const numericValues = sprintWhitelist
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value))
    .sort((a, b) => a - b);

  if (numericValues.length === sprintWhitelist.length) {
    const isContinuous = numericValues.every((value, index) => {
      if (index === 0) {
        return true;
      }

      return value === numericValues[index - 1] + 1;
    });

    if (isContinuous) {
      return `${numericValues[0]}-${numericValues[numericValues.length - 1]}`;
    }
  }

  return sprintWhitelist.join(", ");
}

async function initialize() {
  if (isInitializing) return;
  isInitializing = true;

  try {
    notifier = new TelegramNotifier({
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      chatId: process.env.TELEGRAM_CHAT_ID,
      onRestart: restartMonitoring,
      getConfig: getMonitoringConfigMessage,
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
