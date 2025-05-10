import puppeteer, { executablePath } from "puppeteer";
import { config } from "dotenv";
import {
    getFormattedDate,
    sleep,
    getChromePath,
    isRunningOnHosting,
} from "./utils.js";
import TelegramNotifier from "./telegramNotifier.js";

config();

const notifier = new TelegramNotifier({
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
});

if (!process.env.TELEGRAM_CHAT_ID) {
    console.log(
        "ChatId не задан. Для получения отправьте сообщение боту, и скрипт его выведет."
    );
    const chatId = await notifier.listenForChatId();
    console.log(`Запишите полученный chatId в .env: TELEGRAM_CHAT_ID=${chatId}`);
    process.exit(0);
}

const browserConfig = {
    headless: true,
    defaultViewport: null,
    timeout: 0,
    protocolTimeout: 0,
    userDataDir: "./tmp",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    executablePath: await getChromePath(),
};

if (!isRunningOnHosting()) {
    console.log(".(-=0)");
    browserConfig.executablePath = await getChromePath();
}

async function trackTasks() {
    let browser;
    try {
        console.log("Запуск браузера...");
        browser = await puppeteer.launch(browserConfig);
        const page = await browser.newPage();

        console.log("Открытие целевой страницы...");
        await page.goto(process.env.TARGET_URL, {
            waitUntil: "networkidle2",
            timeout: 60000,
        });

        if (process.env.AUTH === "1") {
            console.log("Требуется аутентификация. У вас есть 4 минуты...");
            await sleep(240);
            console.log("Аутентификационное время истекло");
        }

        const screenshotOptions = {
            path: "screenshot.png",
            fullPage: true,
        };

        let prevTaskCount = "";
        let errorCount = 0;
        const maxErrors = 5;

        console.log("Начало мониторинга задач...");
        await notifier.sendText("Мониторинг задач начат");

        while (true) {
            try {
                await page.reload({ waitUntil: "networkidle2" });
                await sleep(0.6);

                const result = await page.evaluate((prevCount) => {
                    const selector =
                        "#root>div>div:nth-child(3)>div.dashboard>div>div>div:nth-child(1)>div>div>div.widget>div>div:nth-child(1)>button>div>span:nth-child(2)";
                    const taskCountElement = document.querySelector(selector);
                    const taskCount = taskCountElement?.textContent?.trim() || "0";
                    return {
                        updated: taskCount && taskCount !== prevCount,
                        taskCount,
                        selectorExists: !!taskCountElement,
                    };
                }, prevTaskCount);

                if (!result.selectorExists) {
                    console.warn("Селектор задач не найден на странице");
                    await sleep(10);
                    continue;
                }

                if (result.updated && +result.taskCount !== +prevTaskCount) {
                    const formattedDate = getFormattedDate();
                    const screenshotName = `screenshot-${formattedDate}.png`;

                    const newTaskKey = await page.evaluate(() => {
                        const rows = document.querySelectorAll(
                            "#root>div>div:nth-child(3)>div.dashboard>div>div>div:nth-child(1)>div>div>div>div>div:nth-child(2)>div>table>tbody tr"
                        );
                        if (rows.length > 0) {
                            return rows[0].getAttribute("data-key");
                        }
                        return null;
                    });

                    const countIncreased = +result.taskCount > +prevTaskCount;
                    prevTaskCount = result.taskCount;

                    console.log(
                        `Обнаружена новая задача! Всего задач: ${result.taskCount}`
                    );

                    if (countIncreased && newTaskKey) {
                        await page.screenshot({
                            ...screenshotOptions,
                            path: `./screenshots/${screenshotName}`,
                        });

                        try {
                            await notifier.sendAlert({
                                imagePath: `./screenshots/${screenshotName}`,
                                link: `https://tracker.yandex.ru/${newTaskKey}`,
                                taskCount: result.taskCount,
                            });
                            console.log("Уведомление отправлено в Telegram");
                        } catch (error) {
                            console.error("Ошибка отправки уведомления:", error);
                        }
                    }
                }

                errorCount = 0;
                await sleep(2);
            } catch (error) {
                console.error("Ошибка в основном цикле:", error);
                errorCount++;

                if (errorCount >= maxErrors) {
                    await notifier.sendText(
                        `Мониторинг остановлен из-за ${maxErrors} ошибок подряд`
                    );
                    throw new Error(
                        `Превышено максимальное количество ошибок (${maxErrors})`
                    );
                }

                await sleep(10);
            }
        }
    } catch (error) {
        console.error("Критическая ошибка:", error);
        await notifier.sendText(`Мониторинг остановлен: ${error.message}`);
        process.exit(1);
    } finally {
        if (browser) {
            await browser.close().catch(console.error);
        }
    }
}

trackTasks();
