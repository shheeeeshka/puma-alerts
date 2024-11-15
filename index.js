import puppeteer from "puppeteer";
import { config } from "dotenv";
import { getFormattedDate, sleep } from "./utils.js";
import mailService from "./mailService.js";

config();

async function main() {
    const executablePath = process.env.OS === "macos" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "";
    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: false,
        timeout: 0,
        protocolTimeout: 0,
        userDataDir: "./tmp",
        executablePath,
    });
    const page = await browser.newPage();

    await page.goto(process.env.TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.setViewport({ width: 1780, height: 1080 });

    if (process.env.AUTH === "1") {
        console.log("Самое время войти в аккаунт, у Вас ровно 4 минуты!!");
        await sleep(240);
        console.log("Время на вход вышло...");
    }

    const screenshotOptions = {
        path: "screenshot.png",
        clip: {
            x: 250,
            y: 40,
            width: 1100, // must depend on task list width
            height: 620, // must depend on task list height
        },
        fullPage: false,
    };

    let prevTaskCount = "";

    while (true) {
        await page.reload({ waitUntil: "domcontentloaded" });
        await sleep(.6);

        const isTaskCountUpdated = await page.evaluate((prevCount) => {
            const taskCountElement = document.querySelector("#root>div>div:nth-child(3)>div.dashboard>div>div>div:nth-child(1)>div>div>div.widget>div>div:nth-child(1)>button>div>span:nth-child(2)");
            const taskCount = taskCountElement ? taskCountElement.textContent : "";
            const updated = taskCount && taskCount !== prevCount;
            return { updated, taskCount };
        }, prevTaskCount);

        if (isTaskCountUpdated.updated && isTaskCountUpdated.taskCount !== "0" && +isTaskCountUpdated.taskCount > +prevTaskCount) {
            prevTaskCount = isTaskCountUpdated.taskCount;
            const formattedDate = getFormattedDate();
            const screenshotName = `screenshot-${formattedDate}.png`;
            await page.screenshot({ ...screenshotOptions, path: `./screenshots/${screenshotName}` });
            await sleep(.6);
            try {
                await mailService.sendAlertMail(screenshotName, process.env.TARGET_URL);
                console.log("Письмо успешно отправлено");
            } catch (err) {
                console.error("Произошла ошибка при отправке письма", err);
            }
        }

        await sleep(2);
    }

    // await browser.close(); // unnecessary
}

main();

// document.querySelector("#root>div>div:nth-child(3)>div.dashboard>div>div>div:nth-child(1)>div>div>div.widget>div")
// document.querySelector("#root>div>div:nth-child(3)>div.dashboard>div>div>div:nth-child(1)>div>div>div.widget>div>div:last-child>div>table>tbody")