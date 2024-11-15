import puppeteer from "puppeteer";
import { config } from "dotenv";
import { getFormattedDate, sleep } from "./utils.js";
import mailService from "./mailService.js";

config();

async function main() {
    // const executablePath = process.env.OS === "macos" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "";
    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: false,
        timeout: 0,
        protocolTimeout: 0,
        userDataDir: "./tmp",
        executablePath: `C:\Users\elena\AppData\Local\Yandex\YandexBrowser\Application\browser.exe`,
    });
    const page = await browser.newPage();

    await page.goto(process.env.TARGET_URL, { waitUntil: "networkidle0" });
    await page.setViewport({ width: 1780, height: 1080 });

    if (process.env.AUTH === "1") {
        console.log("Самое время войти в аккаунт, у Вас ровно 4 минуты!!");
        await sleep(240);
    }

    const screenshotOptions = {
        path: "screenshot.png",
        clip: {
            x: 250,
            y: 50,
            width: 1300,
            height: 600,
        },
        fullPage: false,
    };

    let prevTaskCount = "";

    while (true) {
        await page.reload({ waitUntil: "networkidle0" });
        await sleep(10);

        const isTaskCountUpdated = await page.evaluate((prevCount) => {
            // const dashBoardTBody = document.querySelectorAll("#root>div>div:nth-child(3)>div.dashboard>div>div>div:nth-child(1)>div>div>div.widget>div>div:last-child>div>table>tbody>tr")
            // if (dashBoardTBody) {
            //     // dashBoardBtn.click();
            //     console.log({ dashBoardTBody });
            // }
            const taskCountElement = document.querySelector("#root>div>div:nth-child(3)>div.dashboard>div>div>div:nth-child(1)>div>div>div.widget>div>div:nth-child(1)>button>div>span:nth-child(2)");
            const taskCount = taskCountElement ? taskCountElement.textContent : "";
            const updated = taskCount && taskCount !== prevCount;
            return { updated, taskCount };
        }, prevTaskCount);

        if (isTaskCountUpdated.updated && isTaskCountUpdated.taskCount !== "0") {
            prevTaskCount = isTaskCountUpdated.taskCount;
            const formattedDate = getFormattedDate();
            const screenshotName = `screenshot${formattedDate}.png`;
            await page.screenshot({ ...screenshotOptions, path: `./screenshots/${screenshotName}` });
            await sleep(2);
            try {
                await mailService.sendAlertMail(screenshotName, process.env.TARGET_URL);
                console.log("Письмо успешно отправлено");
            } catch (err) {
                console.error("Произошла ошибка при отправке письма", err);
            }
        }
        await sleep(4);
    }

    // await browser.close();
}

main();

// document.querySelector("#root>div>div:nth-child(3)>div.dashboard>div>div>div:nth-child(1)>div>div>div.widget>div")
// document.querySelector("#root>div>div:nth-child(3)>div.dashboard>div>div>div:nth-child(1)>div>div>div.widget>div>div:last-child>div>table>tbody")
