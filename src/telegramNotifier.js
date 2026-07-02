import axios from "axios";
import fs from "fs";
import path from "path";
import logger from "./logger.js";
import mailService from "./mailService.js";

const CUSTOM_EMOJI_MAP = new Map([
  ["❌", "5420323339723881652"],
  ["⚠️", "5447644880824181073"],
  ["🚀", "5445284980978621387"],
  ["✅", "5325559344513691205"],
  ["⚙️", "5341715473882955310"],
  ["🏃", "5463250403976031619"],
  ["🔗", "5271604874419647061"],
  ["🖥", "5282843764451195532"],
]);

class TelegramNotifier {
  constructor({ botToken, chatId, onRestart = null, getConfig = null }) {
    if (!botToken) {
      throw new Error("Требуется botToken");
    }
    this.botToken = botToken;
    this.chatId = chatId;
    this.apiUrl = `https://api.telegram.org/bot${this.botToken}`;
    this.onRestart = onRestart;
    this.getConfig = getConfig;
    this.isPolling = false;
    this.pollingOffset = 0;
  }

  async sendText(message, keyboard = null, chatId = this.chatId) {
    if (!chatId) {
      logger.warn("chatId не задан, пропускаем отправку сообщения");
      return;
    }

    try {
      const data = {
        chat_id: chatId,
      };

      const payload = this.buildMessagePayload(message);
      Object.assign(data, payload);

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

  buildMessagePayload(message) {
    const { text, entities } = this.parseHtmlMessage(message);
    const allEntities = [...entities, ...this.buildCustomEmojiEntities(text)].sort(
      (a, b) => a.offset - b.offset
    );

    if (allEntities.length > 0) {
      return {
        text,
        entities: allEntities,
      };
    }

    return {
      text,
    };
  }

  parseHtmlMessage(message) {
    const entities = [];
    const boldStack = [];
    const linkStack = [];
    let text = "";
    let i = 0;

    while (i < message.length) {
      if (message.startsWith("<b>", i)) {
        boldStack.push(text.length);
        i += 3;
        continue;
      }

      if (message.startsWith("</b>", i)) {
        const offset = boldStack.pop();
        if (offset !== undefined) {
          entities.push({
            type: "bold",
            offset,
            length: text.length - offset,
          });
        }
        i += 4;
        continue;
      }

      if (message.startsWith('<a href="', i)) {
        const hrefStart = i + 9;
        const hrefEnd = message.indexOf('">', hrefStart);
        if (hrefEnd !== -1) {
          const url = message.slice(hrefStart, hrefEnd);
          linkStack.push({ offset: text.length, url });
          i = hrefEnd + 2;
          continue;
        }
      }

      if (message.startsWith("</a>", i)) {
        const link = linkStack.pop();
        if (link) {
          entities.push({
            type: "text_link",
            offset: link.offset,
            length: text.length - link.offset,
            url: link.url,
          });
        }
        i += 4;
        continue;
      }

      text += message[i];
      i += 1;
    }

    return { text, entities };
  }

  buildCustomEmojiEntities(text) {
    const entities = [];

    for (const [emoji, customEmojiId] of CUSTOM_EMOJI_MAP.entries()) {
      let searchFrom = 0;

      while (searchFrom < text.length) {
        const offset = text.indexOf(emoji, searchFrom);
        if (offset === -1) {
          break;
        }

        entities.push({
          type: "custom_emoji",
          offset,
          length: emoji.length,
          custom_emoji_id: customEmojiId,
        });

        searchFrom = offset + emoji.length;
      }
    }

    return entities;
  }

  async getUpdates(offset = this.pollingOffset, timeout = 30) {
    const { data } = await axios.get(`${this.apiUrl}/getUpdates`, {
      params: {
        offset,
        timeout,
        allowed_updates: JSON.stringify(["message", "callback_query"]),
      },
    });

    if (!data.ok) {
      throw new Error("Telegram getUpdates returned not ok");
    }

    return data.result || [];
  }

  async listenForChatId() {
    logger.info("Ожидание входящего сообщения для получения chatId");

    while (true) {
      const updates = await this.getUpdates(this.pollingOffset, 30);

      for (const update of updates) {
        this.pollingOffset = update.update_id + 1;
        if (update.message?.chat?.id) {
          return update.message.chat.id;
        }
      }
    }
  }

  async startPolling() {
    if (this.isPolling) {
      logger.info("Telegram polling уже запущен");
      return;
    }

    this.isPolling = true;
    logger.info("Запуск Telegram polling");

    while (this.isPolling) {
      try {
        const updates = await this.getUpdates(this.pollingOffset, 30);

        for (const update of updates) {
          this.pollingOffset = update.update_id + 1;

          if (update.message) {
            await this.handleMessage(update.message);
          }

          if (update.callback_query) {
            await this.handleCallback(update.callback_query);
          }
        }
      } catch (error) {
        logger.error("Ошибка Telegram polling", { error: error.message });
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  stopPolling() {
    this.isPolling = false;
    logger.info("Telegram polling остановлен");
  }

  isAuthorizedChat(chatId) {
    return !this.chatId || String(this.chatId) === String(chatId);
  }

  formatConfigMessage() {
    if (typeof this.getConfig === "function") {
      return this.getConfig();
    }

    return "Конфиг недоступен";
  }

  logIncomingMessageMetadata(message) {
    const text = message?.text;
    if (!text) {
      return;
    }

    const symbols = Array.from(text).map((char, index) => ({
      index,
      char,
      codePoint: `U+${char.codePointAt(0).toString(16).toUpperCase()}`,
    }));

    const entities =
      message.entities?.map((entity) => ({
        type: entity.type,
        offset: entity.offset,
        length: entity.length,
        custom_emoji_id: entity.custom_emoji_id || null,
      })) || [];

    logger.info(
      {
        text,
        symbols,
        entities,
      },
      "Входящее сообщение Telegram"
    );
  }

  async handleMessage(message) {
    const chatId = message?.chat?.id;
    const text = message?.text?.trim();

    if (!chatId || !text) {
      return;
    }

    this.logIncomingMessageMetadata(message);

    if (!this.isAuthorizedChat(chatId)) {
      await this.sendText("Команды доступны только для настроенного chatId.", null, chatId);
      return;
    }

    const command = text.split(/\s+/)[0].toLowerCase();

    if (command === "/start") {
      await this.sendText(
        "Бот на связи.\nДоступные команды:\n/restart - перезапустить мониторинг\n/config - показать текущий конфиг",
        null,
        chatId
      );
      return;
    }

    if (command === "/config") {
      await this.sendText(this.formatConfigMessage(), null, chatId);
      return;
    }

    if (command === "/restart") {
      if (typeof this.onRestart !== "function") {
        await this.sendText("Перезапуск сейчас недоступен.", null, chatId);
        return;
      }

      await this.sendText("Перезапускаю мониторинг и браузер...", null, chatId);

      try {
        await this.onRestart();
        await this.sendText("Мониторинг перезапущен.", null, chatId);
      } catch (error) {
        await this.sendText(`Не удалось перезапустить мониторинг: ${error.message}`, null, chatId);
      }
      return;
    }

    await this.sendText(
      "Неизвестная команда.\nДоступные команды:\n/restart\n/config",
      null,
      chatId
    );
  }

  async handleCallback(callbackQuery) {
    if (!callbackQuery?.id) {
      return;
    }

    try {
      await axios.post(`${this.apiUrl}/answerCallbackQuery`, {
        callback_query_id: callbackQuery.id,
      });
    } catch (error) {
      logger.error("Ошибка ответа на callback_query", { error: error.message });
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
