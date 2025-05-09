import fs from 'fs';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';

class TelegramNotifier {
    constructor({ botToken, chatId }) {
        if (!botToken) {
            throw new Error('Требуется botToken для инициализации TelegramNotifier');
        }
        this.botToken = botToken;
        this.chatId = chatId; // Может быть undefined вначале
        this.apiUrl = `https://api.telegram.org/bot${this.botToken}`;
    }

    async sendText(message) {
        if (!this.chatId) {
            console.warn('chatId не задан. Сообщение не отправлено:', message);
            return;
        }
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
        if (!this.chatId) {
            console.warn('chatId не задан. Уведомление не отправлено.');
            return;
        }
        try {
            // Отправляем сообщение с количеством задач
            await this.sendText(`🚀 <b>Новая задача!</b>\nВсего задач: ${taskCount}`);

            // Отправка скриншота
            const __filename = fileURLToPath(import.meta.url);
            const __dirname = path.dirname(__filename);
            const fullImagePath = path.join(__dirname, imagePath);

            if (!fs.existsSync(fullImagePath)) {
                throw new Error(`Файл скриншота не найден: ${fullImagePath}`);
            }

            const FormData = (await import('form-data')).default;
            const formData = new FormData();
            formData.append('chat_id', this.chatId);
            formData.append('photo', fs.createReadStream(fullImagePath));
            formData.append('caption', `🔗 ${link}`);

            await axios.post(`${this.apiUrl}/sendPhoto`, formData, {
                headers: formData.getHeaders()
            });

            // Отправляем кнопку для быстрого перехода
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

    // Новый метод: слушать сообщения и выводить chatId
    async listenForChatId() {
        console.log('Ожидание сообщения для получения chatId...');
        const offset = 0;
        while (true) {
            try {
                const response = await axios.get(`${this.apiUrl}/getUpdates`, {
                    params: { offset, timeout: 30 }
                });
                const updates = response.data.result;
                for (const update of updates) {
                    if (update.message && update.message.chat && update.message.chat.id) {
                        const chatId = update.message.chat.id;
                        console.log(`Получен chatId: ${chatId}`);
                        // Можно вывести в консоль или отправить сообщение
                        await this.sendText(`Ваш chatId: ${chatId}. Теперь вставьте его в переменную окружения.`);
                        return chatId;
                    }
                }
                // Обновляем offset, чтобы не получать повторные обновления
                if (updates.length > 0) {
                    offset = updates[updates.length - 1].update_id + 1;
                }
            } catch (err) {
                console.error('Ошибка при получении обновлений:', err.message);
            }
            await new Promise(res => setTimeout(res, 3000));
        }
    }
}

export default TelegramNotifier;