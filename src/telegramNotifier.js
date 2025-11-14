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
  }

  async sendText(message, keyboard = null) {
    if (!this.chatId) {
      logger.warn("chatId не задан, пропускаем отправку сообщения");
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

      await axios.post(`${this.apiUrl}/sendMessage`, data);

      logger.debug("Сообщение отправлено в Telegram");
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
      const fullImagePath = path.join(process.cwd(), "screenshots", imagePath);

      if (!fs.existsSync(fullImagePath)) {
        logger.warn("Файл для уведомления не найден", { path: fullImagePath });
        await this.sendText(`⚠️ ${caption}`);
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

      await this.sendText(`⚠️ ${caption}`);
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
        fs.createReadStream(
          path.join(process.cwd(), "screenshots", taskImagePath)
        )
      );
      formData.append(
        "board_photo",
        fs.createReadStream(
          path.join(process.cwd(), "screenshots", boardImagePath)
        )
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
}

export default TelegramNotifier;
