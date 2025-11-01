import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import logger from "./logger.js";
import { restartMonitoring } from "./index.js";
import CONFIG from "./config.js";
import mailService from "./mailService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class TelegramNotifier {
  constructor({ botToken, chatId }) {
    if (!botToken) {
      throw new Error("Требуется botToken");
    }
    this.botToken = botToken;
    this.chatId = chatId;
    this.apiUrl = `https://api.telegram.org/bot${this.botToken}`;
    this.pollingInterval = null;
    this.lastMessageId = null;
    this.waitingForInput = null;
    this.configMenuMessageId = null;
  }

  async startPolling() {
    logger.info("Запуск long polling для обработки callback-ов");
    let offset = 0;

    this.pollingInterval = setInterval(async () => {
      try {
        const response = await axios.get(`${this.apiUrl}/getUpdates`, {
          params: {
            offset,
            timeout: 10,
            allowed_updates: ["message", "callback_query"],
          },
        });

        const updates = response.data.result;

        for (const update of updates) {
          if (update.message) {
            await this.handleMessage(update.message);
          }

          if (update.callback_query) {
            await this.handleCallback(update.callback_query);
          }

          offset = update.update_id + 1;
        }
      } catch (error) {
        if (error.response?.status !== 409) {
          logger.error("Ошибка long polling", { error: error.message });
        }
      }
    }, 1000);
  }

  stopPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  async deleteMessage(messageId) {
    try {
      await axios.post(`${this.apiUrl}/deleteMessage`, {
        chat_id: this.chatId,
        message_id: messageId,
      });
    } catch (error) {
      logger.debug("Не удалось удалить сообщение", { error: error.message });
    }
  }

  async editMessage(messageId, text, keyboard = null) {
    try {
      const data = {
        chat_id: this.chatId,
        message_id: messageId,
        text: text,
        parse_mode: "HTML",
      };

      if (keyboard) {
        data.reply_markup = keyboard;
      }

      await axios.post(`${this.apiUrl}/editMessageText`, data);
    } catch (error) {
      logger.error("Ошибка редактирования сообщения", { error: error.message });
    }
  }

  async sendText(message, keyboard = null, isConfigMenu = false) {
    if (!this.chatId) {
      logger.warn("chatId не задан, пропускаем отправку сообщения");
      return;
    }

    try {
      if (this.lastMessageId && this.waitingForInput) {
        await this.deleteMessage(this.lastMessageId);
        this.waitingForInput = null;
      }

      const data = {
        chat_id: this.chatId,
        text: message,
        parse_mode: "HTML",
      };

      if (keyboard) {
        data.reply_markup = keyboard;
      }

      const response = await axios.post(`${this.apiUrl}/sendMessage`, data);
      this.lastMessageId = response.data.result.message_id;

      if (isConfigMenu) {
        this.configMenuMessageId = this.lastMessageId;
      }

      logger.debug("Сообщение отправлено в Telegram");
      return response.data;
    } catch (error) {
      logger.error("Ошибка отправки сообщения в Telegram", {
        error: error.message,
      });

      try {
        await mailService.sendAlertMail(
          "",
          "",
          `Telegram Error: ${message.substring(0, 100)}`
        );
        logger.info("Отправлено уведомление по почте из-за ошибки Telegram");
      } catch (mailError) {
        logger.error("Не удалось отправить уведомление по почте", {
          error: mailError.message,
        });
      }

      throw error;
    }
  }

  async sendAlert({ imagePath, link, caption = "", showBoardButton = false }) {
    if (!this.chatId) return;

    try {
      const fullImagePath = path.join(__dirname, "..", "screenshots", imagePath);

      if (!fs.existsSync(fullImagePath)) {
        logger.warn("Файл для уведомления не найден", { path: fullImagePath });
        await this.sendText(`⚠️ Не удалось найти скриншот\n\n${caption}`);
        return;
      }

      const FormData = (await import("form-data")).default;
      const formData = new FormData();
      formData.append("chat_id", this.chatId);
      formData.append("photo", fs.createReadStream(fullImagePath));
      formData.append("caption", caption);
      formData.append("parse_mode", "HTML");

      if (showBoardButton) {
        formData.append(
          "reply_markup",
          JSON.stringify({
            inline_keyboard: [[{ text: "📋 Открыть доску", url: link }]],
          })
        );
      }

      await axios.post(`${this.apiUrl}/sendPhoto`, formData, {
        headers: formData.getHeaders(),
      });

      logger.debug("Уведомление с изображением отправлено");
    } catch (error) {
      logger.error("Ошибка отправки уведомления с изображением", {
        error: error.message,
      });

      try {
        await mailService.sendAlertMail("", link, `Alert Error: ${caption}`);
        logger.info(
          "Отправлено уведомление по почте из-за ошибки Telegram с изображением"
        );
      } catch (mailError) {
        logger.error("Не удалось отправить уведомление по почте", {
          error: mailError.message,
        });
      }

      throw error;
    }
  }

  async sendDoubleAlert({
    taskImagePath,
    boardImagePath,
    link,
    tasksTaken,
    maxTasks,
    message = "",
  }) {
    if (!this.chatId) return;

    try {
      const FormData = (await import("form-data")).default;
      const formData = new FormData();

      const media = [
        {
          type: "photo",
          media: `attach://task_photo`,
          caption: message,
          parse_mode: "HTML",
        },
        {
          type: "photo",
          media: `attach://board_photo`,
        },
      ];

      formData.append("chat_id", this.chatId);
      formData.append("media", JSON.stringify(media));
      formData.append(
        "reply_markup",
        JSON.stringify({
          inline_keyboard: [[{ text: "📋 Открыть задачу", url: link }]],
        })
      );

      formData.append(
        "task_photo",
        fs.createReadStream(path.join(__dirname, taskImagePath))
      );
      formData.append(
        "board_photo",
        fs.createReadStream(path.join(__dirname, boardImagePath))
      );

      await axios.post(`${this.apiUrl}/sendMediaGroup`, formData, {
        headers: formData.getHeaders(),
      });

      logger.debug("Двойное уведомление отправлено");
    } catch (error) {
      logger.error("Ошибка отправки двойного уведомления", {
        error: error.message,
      });
      throw error;
    }
  }

  async sendConfigMenu() {
    const keyboard = {
      inline_keyboard: [
        [{ text: "📊 Текущая конфигурация", callback_data: "show_config" }],
        [
          {
            text: CONFIG.autoAssign
              ? "🔴 Выключить автозабор"
              : "🟢 Включить автозабор",
            callback_data: "toggle_autoassign",
          },
        ],
        [
          {
            text: CONFIG.authRequired
              ? "🔴 Выключить авторизацию"
              : "🟢 Включить авторизацию",
            callback_data: "toggle_auth",
          },
        ],
        [
          {
            text: "🎯 Лимит задач: " + CONFIG.maxTasks,
            callback_data: "change_max_tasks",
          },
        ],
        [{ text: "📋 Вайтлист спринтов", callback_data: "change_whitelist" }],
        [{ text: "🌐 URL доски", callback_data: "change_target_url" }],
        [
          {
            text: "🔄 Перезапустить мониторинг",
            callback_data: "restart_monitoring",
          },
        ],
      ],
    };

    await this.sendText(
      "⚙️ <b>Панель управления мониторингом</b>\n\nВыберите действие:",
      keyboard,
      true
    );
  }

  async handleCallback(query) {
    try {
      const { data, id, message } = query;

      switch (data) {
        case "show_config":
          const configText =
            `📋 <b>Текущая конфигурация:</b>\n\n` +
            `🔄 Автозабор задач: ${
              CONFIG.autoAssign ? "✅ Включен" : "❌ Выключен"
            }\n` +
            `🔐 Авторизация: ${
              CONFIG.authRequired ? "✅ Включена" : "❌ Выключена"
            }\n` +
            `🎯 Лимит задач: ${CONFIG.maxTasks}\n` +
            `📋 Вайтлист спринтов: ${
              CONFIG.sprintWhitelist.join(", ") || "не задан"
            }\n` +
            `🌐 URL доски: ${CONFIG.targetBoardUrl}`;

          await this.editMessage(message.message_id, configText);
          break;

        case "toggle_autoassign":
          CONFIG.autoAssign = !CONFIG.autoAssign;
          process.env.AUTO_ASSIGN = CONFIG.autoAssign ? "1" : "0";
          await this.editMessage(
            message.message_id,
            `Автозабор задач ${
              CONFIG.autoAssign ? "✅ включен" : "❌ выключен"
            }\n\nДля применения изменений требуется перезапуск мониторинга.`
          );
          await this.sendConfigMenu();
          break;

        case "toggle_auth":
          CONFIG.authRequired = !CONFIG.authRequired;
          process.env.AUTH = CONFIG.authRequired ? "1" : "0";
          await this.editMessage(
            message.message_id,
            `Авторизация ${
              CONFIG.authRequired ? "✅ включена" : "❌ выключена"
            }\n\nДля применения изменений требуется перезапуск мониторинга.`
          );
          await this.sendConfigMenu();
          break;

        case "change_max_tasks":
          this.waitingForInput = "max_tasks";
          await this.sendText("Введите новое значение лимита задач (число):");
          break;

        case "change_whitelist":
          this.waitingForInput = "whitelist";
          await this.sendText(
            "Введите номера спринтов через запятую (например: 19,10):"
          );
          break;

        case "change_target_url":
          this.waitingForInput = "target_url";
          await this.sendText("Введите новый URL доски:");
          break;

        case "restart_monitoring":
          await this.editMessage(
            message.message_id,
            "🔄 Перезапуск мониторинга..."
          );
          await restartMonitoring();
          break;

        default:
          await this.sendText("❌ Неизвестная команда");
      }

      await axios.post(`${this.apiUrl}/answerCallbackQuery`, {
        callback_query_id: id,
        text: "Команда выполнена",
      });
    } catch (error) {
      logger.error("Ошибка обработки callback", { error: error.message });
    }
  }

  async handleMessage(message) {
    if (!message.text) return;

    const text = message.text.trim();

    if (this.waitingForInput) {
      switch (this.waitingForInput) {
        case "max_tasks":
          if (text.match(/^\d+$/)) {
            CONFIG.maxTasks = parseInt(text);
            process.env.MAX_TASKS = text;
            await this.sendText(
              `✅ Лимит задач изменен на: ${text}\n\nДля применения изменений требуется перезапуск мониторинга.`
            );
            await this.sendConfigMenu();
          } else {
            await this.sendText("❌ Введите корректное число");
          }
          this.waitingForInput = null;
          return;

        case "whitelist":
          CONFIG.sprintWhitelist = text
            ? text.split(",").map((s) => s.trim())
            : [];
          process.env.SPRINT_WHITELIST = CONFIG.sprintWhitelist.join(",");
          await this.sendText(
            `✅ Вайтлист спринтов изменен: ${
              CONFIG.sprintWhitelist.join(", ") || "очищен"
            }\n\nДля применения изменений требуется перезапуск мониторинга.`
          );
          await this.sendConfigMenu();
          this.waitingForInput = null;
          return;

        case "target_url":
          if (text.startsWith("http")) {
            CONFIG.targetBoardUrl = text;
            process.env.TARGET_BOARD_URL = text;
            await this.sendText(
              `✅ URL доски изменен на: ${text}\n\nДля применения изменений требуется перезапуск мониторинга.`
            );
            await this.sendConfigMenu();
          } else {
            await this.sendText("❌ Введите корректный URL");
          }
          this.waitingForInput = null;
          return;
      }
    }

    if (text === "/config") {
      await this.sendConfigMenu();
      return;
    }

    if (text === "/start") {
      const keyboard = {
        keyboard: [[{ text: "⚙️ Панель управления" }]],
        resize_keyboard: true,
        one_time_keyboard: false,
      };

      await this.sendText(
        "👋 <b>Добро пожаловать!</b>\n\nНажмите кнопку ниже для управления настройками мониторинга.",
        keyboard
      );
      return;
    }

    if (text === "⚙️ Панель управления") {
      await this.sendConfigMenu();
      return;
    }

    if (text === "/restart") {
      await this.sendText("🔄 Перезапуск мониторинга...");
      await restartMonitoring();
      return;
    }
  }

  async listenForChatId() {
    logger.info("Ожидание сообщения для получения chatId");
    let offset = 0;

    while (true) {
      try {
        const response = await axios.get(`${this.apiUrl}/getUpdates`, {
          params: { offset, timeout: 30 },
        });
        const updates = response.data.result;

        for (const update of updates) {
          if (update.message && update.message.chat && update.message.chat.id) {
            const chatId = update.message.chat.id;
            this.chatId = chatId;

            const keyboard = {
              keyboard: [[{ text: "⚙️ Панель управления" }]],
              resize_keyboard: true,
              one_time_keyboard: false,
            };

            await this.sendText(
              `👋 <b>Добро пожаловать!</b>\n\nВаш chatId: <code>${chatId}</code>\n\nЗапишите его в переменную окружения TELEGRAM_CHAT_ID`,
              keyboard
            );
            return chatId;
          }

          if (update.callback_query) {
            await this.handleCallback(update.callback_query);
          }
        }

        if (updates.length > 0) {
          offset = updates[updates.length - 1].update_id + 1;
        }
      } catch (err) {
        logger.error("Ошибка получения chatId", { error: err.message });
      }
      await new Promise((res) => setTimeout(res, 1000));
    }
  }
}

export default TelegramNotifier;
