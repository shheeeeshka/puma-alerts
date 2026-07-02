import logger from "./logger.js";

class Notifier {
  constructor(channels = []) {
    this.channels = channels.filter(Boolean);
  }

  hasChannel(name) {
    return this.channels.some((channel) => channel.name === name);
  }

  async sendText(message, keyboard = null) {
    if (this.channels.length === 0) {
      logger.warn("Каналы уведомлений не настроены, сообщение пропущено");
      return;
    }

    const results = await Promise.allSettled(
      this.channels.map((channel) => channel.sendText(message, keyboard))
    );

    const failedChannels = results
      .map((result, index) => ({ result, channel: this.channels[index] }))
      .filter(({ result }) => result.status === "rejected");

    if (failedChannels.length === 0) {
      return;
    }

    failedChannels.forEach(({ result, channel }) => {
      logger.error("Ошибка отправки уведомления", {
        channel: channel.name,
        error: result.reason?.message || String(result.reason),
      });
    });

    if (failedChannels.length === this.channels.length) {
      throw failedChannels[0].result.reason;
    }
  }
}

export default Notifier;
