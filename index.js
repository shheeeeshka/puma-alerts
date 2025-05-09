import puppeteer, { executablePath } from 'puppeteer';
import { config } from 'dotenv';
import { getFormattedDate, sleep, getChromePath, isRunningOnHosting } from './utils.js';
import TelegramNotifier from './telegramNotifier.js';

config();

const notifier = new TelegramNotifier({
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID
});

if (!process.env.TELEGRAM_CHAT_ID) {
    console.log('ChatId не задан. Для получения отправьте сообщение боту, и скрипт его выведет.');
    const chatId = await notifier.listenForChatId();
    console.log(`Запишите полученный chatId в .env: TELEGRAM_CHAT_ID=${chatId}`);
    process.exit(0);
}

const browserConfig = {
    headless: false,
    // headless: isRunningOnHosting() ? 'new' : false,
    defaultViewport: null,
    timeout: 0,
    protocolTimeout: 0,
    userDataDir: './tmp',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
};

if (!isRunningOnHosting()) {
    browserConfig.executablePath = await getChromePath();
}

async function trackTasks() {
    let browser;
    try {
        console.log('Запуск браузера...');
        browser = await puppeteer.launch(browserConfig);
        const page = await browser.newPage();

        console.log('Открытие целевой страницы...');
        await page.goto(process.env.TARGET_URL, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        if (process.env.AUTH === '1') {
            console.log('Требуется аутентификация. У вас есть 4 минуты...');
            await sleep(240);
            console.log('Аутентификационное время истекло');
        }

        const screenshotOptions = {
            path: 'screenshot.png',
            clip: {
                x: 250,
                y: 40,
                width: 1100,
                height: 620,
            },
            fullPage: false,
        };

        let prevTaskCount = '';
        let errorCount = 0;
        const maxErrors = 5;

        console.log('Начало мониторинга задач...');
        await notifier.sendText('Мониторинг задач начат');

        while (true) {
            try {
                await page.reload({ waitUntil: 'domcontentloaded' });
                await sleep(0.6);

                const result = await page.evaluate((prevCount) => {
                    const selector = '#root>div>div:nth-child(3)>div.dashboard>div>div>div:nth-child(1)>div>div>div.widget>div>div:nth-child(1)>button>div>span:nth-child(2)';
                    const taskCountElement = document.querySelector(selector);
                    const taskCount = taskCountElement?.textContent?.trim() || '0';
                    return {
                        updated: taskCount && taskCount !== prevCount,
                        taskCount,
                        selectorExists: !!taskCountElement
                    };
                }, prevTaskCount);

                if (!result.selectorExists) {
                    console.warn('Селектор задач не найден на странице');
                    await sleep(10);
                    continue;
                }

                if (result.updated && result.taskCount !== '0' && +result.taskCount > +prevTaskCount) {
                    prevTaskCount = result.taskCount;
                    const formattedDate = getFormattedDate();
                    const screenshotName = `screenshot-${formattedDate}.png`;

                    console.log(`Обнаружена новая задача! Всего задач: ${result.taskCount}`);
                    await page.screenshot({ ...screenshotOptions, path: `./screenshots/${screenshotName}` });

                    try {
                        await notifier.sendAlert({
                            imagePath: `./screenshots/${screenshotName}`,
                            link: process.env.TARGET_URL,
                            taskCount: result.taskCount
                        });
                        console.log('Уведомление отправлено в Telegram');
                    } catch (error) {
                        console.error('Ошибка отправки уведомления:', error);
                    }
                }

                errorCount = 0; // Сброс счетчика ошибок после успешной итерации
                await sleep(2);

            } catch (error) {
                console.error('Ошибка в основном цикле:', error);
                errorCount++;

                if (errorCount >= maxErrors) {
                    await notifier.sendText(`Мониторинг остановлен из-за ${maxErrors} ошибок подряд`);
                    throw new Error(`Превышено максимальное количество ошибок (${maxErrors})`);
                }

                await sleep(10); // Увеличиваем задержку после ошибки
            }
        }

    } catch (error) {
        console.error('Критическая ошибка:', error);
        await notifier.sendText(`Мониторинг остановлен: ${error.message}`);
        process.exit(1);
    } finally {
        if (browser) {
            await browser.close().catch(console.error);
        }
    }
}

trackTasks();