import fs from 'fs';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';

class TelegramNotifier {
    constructor({ botToken, chatId }) {
        if (!botToken || !chatId) {
            throw new Error('Требуется botToken и chatId для инициализации TelegramNotifier');
        }

        this.botToken = botToken;
        this.chatId = chatId;
        this.apiUrl = `https://api.telegram.org/bot${this.botToken}`;
    }

    async sendText(message) {
        try {
            await axios.post(`${this.apiUrl}/sendMessage`, {
                chat_id: this.chatId,
                text: message,
                parse_mode: 'HTML'
            });
        } catch (error) {
            console.error('Ошибка отправки текста в Telegram:', error.response?.data || error.message);
            throw error;
        }
    }

    async sendAlert({ imagePath, link, taskCount }) {
        try {
            // Сначала отправляем текст с количеством задач
            await this.sendText(`🚀 <b>Новая задача!</b>\nВсего задач: ${taskCount}`);

            // Затем отправляем скриншот
            const __filename = fileURLToPath(import.meta.url);
            const __dirname = path.dirname(__filename);
            const fullImagePath = path.join(__dirname, imagePath);

            if (!fs.existsSync(fullImagePath)) {
                throw new Error(`Файл скриншота не найден: ${fullImagePath}`);
            }

            const formData = new FormData();
            formData.append('chat_id', this.chatId);
            formData.append('photo', fs.createReadStream(fullImagePath));
            formData.append('caption', `🔗 ${link}`);

            await axios.post(`${this.apiUrl}/sendPhoto`, formData, {
                headers: {
                    ...formData.getHeaders()
                }
            });

            // И кнопку для быстрого перехода
            await axios.post(`${this.apiUrl}/sendMessage`, {
                chat_id: this.chatId,
                text: 'Быстрый доступ:',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Открыть задачи', url: link }]
                    ]
                }
            });

        } catch (error) {
            console.error('Ошибка отправки уведомления:', error.response?.data || error.message);
            throw error;
        }
    }
}

export default TelegramNotifier;