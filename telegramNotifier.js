import fs from "fs";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";
import { CONFIG } from "./index.js";

class TelegramNotifier {
  constructor({ botToken, chatId }) {
    if (!botToken) {
      throw new Error("Требуется botToken");
    }
    this.botToken = botToken;
    this.chatId = chatId;
    this.apiUrl = `https://api.telegram.org/bot${this.botToken}`;
  }

  async sendText(message, keyboard = null) {
    if (!this.chatId) {
      console.warn("chatId не задан");
      return;
    }
    try {
      const data = {
        chat_id: this.chatId,
        text: message,
        parse_mode: "HTML",
      };

      if (keyboard) {
        data.reply_markup = keyboard;
      }

      const response = await axios.post(`${this.apiUrl}/sendMessage`, data);
      return response.data;
    } catch (error) {
      console.error(
        "Ошибка отправки текста:",
        error.response?.data || error.message
      );
      throw error;
    }
  }

  async sendAlert({ imagePath, link, caption = "", showBoardButton = false }) {
    if (!this.chatId) return;

    try {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const fullImagePath = path.join(__dirname, imagePath);

      if (!fs.existsSync(fullImagePath)) {
        throw new Error(`Файл не найден: ${fullImagePath}`);
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
    } catch (error) {
      console.error(
        "Ошибка отправки уведомления:",
        error.response?.data || error.message
      );
      throw error;
    }
  }

  async sendDoubleAlert({
    taskImagePath,
    boardImagePath,
    link,
    tasksInWork,
    maxTasks,
    message = "",
  }) {
    if (!this.chatId) return;

    try {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);

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
    } catch (error) {
      console.error(
        "Ошибка отправки двойного уведомления:",
        error.response?.data || error.message
      );
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
            text: "🎯 Лимит задач: " + CONFIG.maxTasks,
            callback_data: "change_max_tasks",
          },
        ],
        [{ text: "📋 Вайтлист спринтов", callback_data: "change_whitelist" }],
        [{ text: "🌐 URL доски", callback_data: "change_target_url" }],
        [{ text: "🔄 Обновить конфиг", callback_data: "refresh_config" }],
      ],
    };

    await this.sendText(
      "⚙️ <b>Панель управления мониторингом</b>\n\nВыберите действие:",
      keyboard
    );
  }

  async handleCallback(query) {
    try {
      const { data, message } = query;

      switch (data) {
        case "show_config":
          const configText =
            `📋 <b>Текущая конфигурация:</b>\n\n` +
            `🔄 Автозабор задач: ${
              CONFIG.autoAssign ? "✅ Включен" : "❌ Выключен"
            }\n` +
            `🎯 Лимит задач: ${CONFIG.maxTasks}\n` +
            `📋 Вайтлист спринтов: ${
              CONFIG.sprintWhitelist.join(", ") || "не задан"
            }\n` +
            `🌐 URL доски: ${CONFIG.targetUrl}\n` +
            `🔐 Аутентификация: ${
              CONFIG.authRequired ? "✅ Требуется" : "❌ Не требуется"
            }`;

          await this.sendText(configText);
          await this.sendConfigMenu();
          break;

        case "toggle_autoassign":
          CONFIG.autoAssign = !CONFIG.autoAssign;
          process.env.AUTO_ASSIGN = CONFIG.autoAssign ? "1" : "0";
          await this.sendText(
            `Автозабор задач ${
              CONFIG.autoAssign ? "✅ включен" : "❌ выключен"
            }`
          );
          await this.sendConfigMenu();
          break;

        case "refresh_config":
          await this.sendText("🔄 Конфигурация обновлена");
          await this.sendConfigMenu();
          break;

        default:
          await this.sendText("❌ Неизвестная команда");
          await this.sendConfigMenu();
      }

      await axios.post(`${this.apiUrl}/answerCallbackQuery`, {
        callback_query_id: query.id,
        text: "Команда выполнена",
      });
    } catch (error) {
      console.error("Ошибка обработки callback:", error);
      await axios.post(`${this.apiUrl}/answerCallbackQuery`, {
        callback_query_id: query.id,
        text: "Ошибка выполнения команды",
      });
    }
  }

  async listenForChatId() {
    console.log("Ожидание сообщения для получения chatId...");
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
            await this.sendText(
              `👋 <b>Добро пожаловать!</b>\n\nВаш chatId: <code>${chatId}</code>\n\nЗапишите его в переменную окружения TELEGRAM_CHAT_ID`,
              {
                inline_keyboard: [
                  [
                    {
                      text: "⚙️ Панель управления",
                      callback_data: "show_config",
                    },
                  ],
                ],
              }
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
        console.error("Ошибка при получении обновлений:", err.message);
      }
      await new Promise((res) => setTimeout(res, 1000));
    }
  }
}

export default TelegramNotifier;
