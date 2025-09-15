import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer";
import { config } from "dotenv";
import {
  getFormattedDate,
  sleep,
  getChromePath,
  isRunningOnHosting,
} from "./utils.js";
import TelegramNotifier from "./telegramNotifier.js";
import MailService from "./mailService.js";

config();

const notifier = new TelegramNotifier({
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
});

if (!process.env.TELEGRAM_CHAT_ID) {
  console.log("ChatId не задан. Для получения отправьте сообщение боту.");
  const chatId = await notifier.listenForChatId();
  console.log(`Запишите полученный chatId в .env: TELEGRAM_CHAT_ID=${chatId}`);
  process.exit(0);
}

export const CONFIG = {
  autoAssign: process.env.AUTO_ASSIGN !== "0",
  sprintWhitelist: process.env.SPRINT_WHITELIST
    ? process.env.SPRINT_WHITELIST.split(",").map((s) => s.trim())
    : [],
  maxTasks: parseInt(process.env.MAX_TASKS) || 15,
  targetUrl: process.env.TARGET_URL,
  targetBoardUrl: process.env.TARGET_BOARD_URL,
  authRequired: process.env.AUTH === "1",
};

const browserConfig = {
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--single-process",
  ],
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH || (await chromium.executablePath()),
  headless: chromium.headless,
  defaultViewport: chromium.defaultViewport,
  ignoreHTTPSErrors: true,
  userDataDir: process.env.USER_DATA_DIR || "/tmp/puppeteer_user_data",
};

if (!isRunningOnHosting()) {
  browserConfig.executablePath = await getChromePath();
}

async function cleanupScreenshot(path) {
  try {
    const fs = await import("fs");
    if (fs.existsSync(path)) {
      fs.unlinkSync(path);
    }
  } catch (error) {
    console.error("Ошибка удаления скриншота:", error);
  }
}

async function checkSprintWhitelist(taskTitle) {
  if (CONFIG.sprintWhitelist.length === 0) return true;

  const sprintNumbers = taskTitle.match(/\[(\d+)\]/g);
  if (!sprintNumbers) return false;

  return sprintNumbers.some((sprint) => {
    const sprintNumber = sprint.replace(/[\[\]]/g, "");
    return CONFIG.sprintWhitelist.includes(sprintNumber);
  });
}

async function getTasksInWork(page) {
  return await page.evaluate(() => {
    const workColumn = Array.from(
      document.querySelectorAll(".agile-column-header")
    ).find((header) => header.textContent.includes("В работе"));

    if (workColumn) {
      const columnId = workColumn.getAttribute("data-rbd-draggable-id");
      const tasks = document.querySelectorAll(
        `.agile-column[data-column-id="${columnId}"] .agile-issue[data-issue-key]`
      );
      return Array.from(tasks).map((task) =>
        task.getAttribute("data-issue-key")
      );
    }
    return [];
  });
}

async function getTaskTitle(page, taskKey) {
  try {
    await page.goto(`${CONFIG.targetUrl}/${taskKey}`, {
      waitUntil: "networkidle2",
      timeout: 10000,
    });

    const title = await page.evaluate(() => {
      const titleElement = document.querySelector(".issue-summary");
      return titleElement ? titleElement.textContent.trim() : null;
    });

    await page.goBack({ waitUntil: "networkidle2" });
    return title || taskKey;
  } catch (error) {
    console.error("Ошибка получения названия задачи:", error);
    return taskKey;
  }
}

async function clickTakeWorkButton(page) {
  try {
    const buttonFound = await page.evaluate(() => {
      const buttonSelectors = [
        "button.review-header__button-take",
        'button[class*="take"]',
        'button[class*="work"]',
        ".prisma-button2",
        "button:contains('Взять')",
        "button:contains('Take')",
      ];

      for (const selector of buttonSelectors) {
        const buttons = Array.from(document.querySelectorAll(selector));
        for (const button of buttons) {
          if (button && button.offsetParent !== null) {
            const text = button.textContent.toLowerCase();
            if (
              text.includes("взять") ||
              text.includes("take") ||
              text.includes("work")
            ) {
              button.click();
              return true;
            }
          }
        }
      }
      return false;
    });

    if (buttonFound) {
      await sleep(2);
      return true;
    }
    return false;
  } catch (error) {
    console.error("Ошибка при нажатии кнопки 'Взять в работу':", error);
    return false;
  }
}

async function assignTask(page, taskKey, taskTitle, tasksInWorkCount) {
  if (!CONFIG.autoAssign) return false;

  try {
    await page.goto(`${CONFIG.targetUrl}/${taskKey}`, {
      waitUntil: "networkidle2",
      timeout: 15000,
    });

    const isAssigned = await page.evaluate(() => {
      const assigneeField = document.querySelector(
        '.FieldView[data-id="assignee"]'
      );
      if (!assigneeField) return true;
      const assignButton = assigneeField.querySelector(".FieldView-Me");
      return !assignButton;
    });

    if (isAssigned) {
      await notifier.sendText(
        `⚠️ Задача "${taskTitle}" уже назначена на другого исполнителя`
      );
      return false;
    }

    await page.evaluate(() => {
      const assigneeField = document.querySelector(
        '.FieldView[data-id="assignee"]'
      );
      const assignButton = assigneeField?.querySelector(".FieldView-Me");
      if (assignButton) {
        assignButton.click();
      }
    });

    await sleep(2);

    const takeButtonClicked = await clickTakeWorkButton(page);

    if (!takeButtonClicked) {
      await page.evaluate(() => {
        const statusField = document.querySelector(
          '.FieldView[data-id="status"]'
        );
        const statusButton = statusField?.querySelector("button");
        if (statusButton) {
          statusButton.click();
        }
      });

      await sleep(1);

      const statusChanged = await page.evaluate(() => {
        const popup = document.querySelector(".IssueStatus-popup-wrapper");
        if (!popup) return false;
        const workOption = Array.from(
          popup.querySelectorAll(".g-list__item") || []
        ).find((item) => item.textContent.includes("В работу"));
        if (workOption) {
          workOption.click();
          return true;
        }
        return false;
      });

      if (!statusChanged) {
        return false;
      }
    }

    await sleep(3);

    const formattedDate = getFormattedDate();
    const taskScreenshotPath = `./screenshots/task-${taskKey}-${formattedDate}.png`;

    await page.screenshot({
      path: taskScreenshotPath,
      fullPage: true,
    });

    await page.goto(CONFIG.targetBoardUrl, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    const boardScreenshotPath = `./screenshots/board-${taskKey}-${formattedDate}.png`;
    await page.screenshot({
      path: boardScreenshotPath,
      fullPage: true,
    });

    try {
      await notifier.sendDoubleAlert({
        taskImagePath: taskScreenshotPath,
        boardImagePath: boardScreenshotPath,
        link: `${CONFIG.targetUrl}/${taskKey}`,
        tasksInWork: tasksInWorkCount + 1,
        maxTasks: CONFIG.maxTasks,
        message: `✅ Задача взята в работу\n"${taskTitle}"\n📊 В работе: ${
          tasksInWorkCount + 1
        }/${CONFIG.maxTasks}`,
      });
      await cleanupScreenshot(taskScreenshotPath);
      await cleanupScreenshot(boardScreenshotPath);
    } catch (error) {
      console.error("Ошибка отправки уведомления:", error);
      await MailService.sendAlertMail(
        taskScreenshotPath,
        `${CONFIG.targetUrl}/${taskKey}`,
        `Задача "${taskTitle}" взята в работу\nВ работе: ${
          tasksInWorkCount + 1
        }/${CONFIG.maxTasks}`
      );
      await cleanupScreenshot(taskScreenshotPath);
      await cleanupScreenshot(boardScreenshotPath);
    }

    return true;
  } catch (error) {
    console.error("Ошибка взятия задачи:", error);
    await notifier.sendText(
      `❌ Ошибка взятия задачи "${taskTitle}": ${error.message}`
    );
    return false;
  }
}

async function getAllOpenTasks(page) {
  const result = await page.evaluate(() => {
    const openColumn = Array.from(
      document.querySelectorAll(".agile-column-header")
    ).find((header) => header.textContent.includes("Открыт"));

    let openTasks = [];
    let taskTitles = {};

    if (openColumn) {
      const columnId = openColumn.getAttribute("data-rbd-draggable-id");
      const taskElements = document.querySelectorAll(
        `.agile-column[data-column-id="${columnId}"] .agile-issue[data-issue-key]`
      );

      openTasks = Array.from(taskElements).map((task) => {
        const key = task.getAttribute("data-issue-key");
        const titleElement = task.querySelector(".agile-issue__summary");
        const title = titleElement ? titleElement.textContent.trim() : key;
        taskTitles[key] = title;
        return key;
      });
    }

    return {
      openTaskKeys: openTasks,
      taskTitles: taskTitles,
    };
  });

  return {
    openTasks: result.openTaskKeys,
    taskTitles: result.taskTitles,
  };
}

async function processInitialTasks(page) {
  try {
    const { openTasks, taskTitles } = await getAllOpenTasks(page);
    const tasksInWork = await getTasksInWork(page);
    const tasksInWorkCount = tasksInWork.length;

    if (openTasks.length > 0) {
      const formattedDate = getFormattedDate();
      const screenshotPath = `./screenshots/initial-tasks-${formattedDate}.png`;

      await page.screenshot({
        path: screenshotPath,
        fullPage: true,
      });

      try {
        const tasksList = openTasks
          .map((taskKey) => `• ${taskTitles[taskKey]}`)
          .join("\n");
        await notifier.sendAlert({
          imagePath: screenshotPath,
          link: CONFIG.targetBoardUrl,
          caption: `🚀 <b>Обнаружены задачи при запуске!</b>\n\n${tasksList}\n\nВ работе: ${tasksInWorkCount}/${CONFIG.maxTasks}`,
          showBoardButton: true,
        });

        if (CONFIG.autoAssign) {
          const validTasks = [];
          for (const taskKey of openTasks) {
            const shouldProcess = await checkSprintWhitelist(
              taskTitles[taskKey]
            );
            if (shouldProcess) {
              validTasks.push({ key: taskKey, title: taskTitles[taskKey] });
            }
          }

          let assignedCount = 0;
          const assignedTasks = [];

          for (const task of validTasks) {
            if (tasksInWorkCount + assignedCount < CONFIG.maxTasks) {
              const assigned = await assignTask(
                page,
                task.key,
                task.title,
                tasksInWorkCount + assignedCount
              );
              if (assigned) {
                assignedCount++;
                assignedTasks.push(task.title);
              }
            }
          }

          if (assignedCount > 0) {
            await notifier.sendText(
              `✅ Удалось взять в работу ${assignedCount} задач:\n${assignedTasks
                .map((task) => `• ${task}`)
                .join("\n")}\n📊 В работе: ${
                tasksInWorkCount + assignedCount
              }/${CONFIG.maxTasks}`
            );
          }
        }

        await cleanupScreenshot(screenshotPath);
      } catch (error) {
        console.error("Ошибка отправки уведомления:", error);
      }
    }

    return openTasks;
  } catch (error) {
    console.error("Ошибка обработки начальных задач:", error);
    return [];
  }
}

async function getNewOpenTasks(page, prevOpenTaskKeys) {
  const result = await page.evaluate(() => {
    const openColumn = Array.from(
      document.querySelectorAll(".agile-column-header")
    ).find((header) => header.textContent.includes("Открыт"));

    let openTasks = [];
    let taskTitles = {};

    if (openColumn) {
      const columnId = openColumn.getAttribute("data-rbd-draggable-id");
      const taskElements = document.querySelectorAll(
        `.agile-column[data-column-id="${columnId}"] .agile-issue[data-issue-key]`
      );

      openTasks = Array.from(taskElements).map((task) => {
        const key = task.getAttribute("data-issue-key");
        const titleElement = task.querySelector(".agile-issue__summary");
        const title = titleElement ? titleElement.textContent.trim() : key;
        taskTitles[key] = title;
        return key;
      });
    }

    return {
      openTaskKeys: openTasks,
      taskTitles: taskTitles,
    };
  });

  const newOpenTasks = result.openTaskKeys.filter(
    (key) => !prevOpenTaskKeys.includes(key)
  );
  const newTaskTitles = {};
  newOpenTasks.forEach((key) => {
    newTaskTitles[key] = result.taskTitles[key] || key;
  });

  return {
    newOpenTasks,
    taskTitles: newTaskTitles,
  };
}

async function trackTasks() {
  let browser;
  try {
    browser = await puppeteer.launch(browserConfig);
    const page = await browser.newPage();

    await page.goto(CONFIG.targetBoardUrl, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    if (CONFIG.authRequired) {
      console.log("Требуется аутентификация. У вас есть 4 минуты...");
      await sleep(240);
    }

    let prevOpenTaskKeys = await processInitialTasks(page);
    let errorCount = 0;
    const maxErrors = 5;

    await notifier.sendText(
      `🚀 Мониторинг начат\nАвтозабор: ${
        CONFIG.autoAssign ? "✅" : "❌"
      }\nЛимит задач: ${CONFIG.maxTasks}`
    );

    while (true) {
      try {
        await page.reload({ waitUntil: "networkidle2" });
        await sleep(2);

        const { newOpenTasks, taskTitles } = await getNewOpenTasks(
          page,
          prevOpenTaskKeys
        );
        prevOpenTaskKeys = await page.evaluate(() => {
          const openColumn = Array.from(
            document.querySelectorAll(".agile-column-header")
          ).find((header) => header.textContent.includes("Открыт"));

          if (openColumn) {
            const columnId = openColumn.getAttribute("data-rbd-draggable-id");
            const taskElements = document.querySelectorAll(
              `.agile-column[data-column-id="${columnId}"] .agile-issue[data-issue-key]`
            );
            return Array.from(taskElements).map((task) =>
              task.getAttribute("data-issue-key")
            );
          }
          return [];
        });

        if (newOpenTasks.length > 0) {
          const tasksInWork = await getTasksInWork(page);
          const tasksInWorkCount = tasksInWork.length;

          const formattedDate = getFormattedDate();
          const screenshotPath = `./screenshots/new-tasks-${formattedDate}.png`;

          await page.screenshot({
            path: screenshotPath,
            fullPage: true,
          });

          try {
            const tasksList = newOpenTasks
              .map((taskKey) => `• ${taskTitles[taskKey]}`)
              .join("\n");
            await notifier.sendAlert({
              imagePath: screenshotPath,
              link: CONFIG.targetBoardUrl,
              caption: `🚀 <b>Обнаружены новые задачи!</b>\n\n${tasksList}\n\nВ работе: ${tasksInWorkCount}/${CONFIG.maxTasks}`,
              showBoardButton: true,
            });

            if (CONFIG.autoAssign && tasksInWorkCount < CONFIG.maxTasks) {
              const validTasks = [];
              for (const taskKey of newOpenTasks) {
                const shouldProcess = await checkSprintWhitelist(
                  taskTitles[taskKey]
                );
                if (shouldProcess) {
                  validTasks.push({ key: taskKey, title: taskTitles[taskKey] });
                }
              }

              let assignedCount = 0;
              const assignedTasks = [];

              for (const task of validTasks) {
                if (tasksInWorkCount + assignedCount < CONFIG.maxTasks) {
                  const assigned = await assignTask(
                    page,
                    task.key,
                    task.title,
                    tasksInWorkCount + assignedCount
                  );
                  if (assigned) {
                    assignedCount++;
                    assignedTasks.push(task.title);
                  }
                }
              }

              if (assignedCount > 0) {
                await notifier.sendText(
                  `✅ Удалось взять в работу ${assignedCount} задач:\n${assignedTasks
                    .map((task) => `• ${task}`)
                    .join("\n")}\n📊 В работе: ${
                    tasksInWorkCount + assignedCount
                  }/${CONFIG.maxTasks}`
                );
              }
            }

            await cleanupScreenshot(screenshotPath);
          } catch (error) {
            console.error("Ошибка отправки уведомления:", error);
          }
        }

        errorCount = 0;
        await sleep(2);
      } catch (error) {
        console.error("Ошибка в цикле:", error);
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

import express from "express";
const app = express();
app.get("/health", (req, res) => res.status(200).send("OK"));
app.listen(process.env.PORT || 3000);

app.use(express.json());
app.post("/webhook", async (req, res) => {
  try {
    const update = req.body;

    if (update.message) {
      await notifier.handleMessage(update.message);
    }

    if (update.callback_query) {
      await notifier.handleCallback(update.callback_query);
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("Ошибка обработки webhook:", error);
    res.status(500).send("Error");
  }
});

notifier.startPolling();
