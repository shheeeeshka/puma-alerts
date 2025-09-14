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
    ? process.env.SPRINT_WHITELIST.split(",")
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

async function checkSprintWhitelist(page, taskKey) {
  if (CONFIG.sprintWhitelist.length === 0) return true;

  try {
    await page.goto(`${CONFIG.targetUrl}/${taskKey}`, {
      waitUntil: "networkidle2",
      timeout: 10000,
    });

    const hasWhitelistedSprint = await page.evaluate((whitelist) => {
      const selectors = [
        '[class*="sprint"]',
        '[data-id*="sprint"]',
        ".agile-issue",
        ".issue-summary",
        ".FieldView-Value",
        ".Bubble-Text",
        ".g-label__content",
        ".sidebar-category__list",
        ".page-issue__content",
      ];

      const textContent = document.body.textContent.toLowerCase();
      const visibleElements = Array.from(document.querySelectorAll("*"))
        .filter((el) => {
          const style = window.getComputedStyle(el);
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.opacity !== "0" &&
            el.offsetParent !== null
          );
        })
        .map((el) => el.textContent?.toLowerCase().trim())
        .filter(Boolean);

      const allVisibleText = visibleElements.join(" ");

      return whitelist.some((sprint) => {
        const sprintLower = sprint.toLowerCase().trim();
        const exactMatch = new RegExp(`\\b${sprintLower}\\b`, "i");
        return (
          exactMatch.test(allVisibleText) || textContent.includes(sprintLower)
        );
      });
    }, CONFIG.sprintWhitelist);

    await page.goBack({ waitUntil: "networkidle2" });
    return hasWhitelistedSprint;
  } catch (error) {
    console.error("Ошибка проверки спринта:", error);
    return false;
  }
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
      const takeButton = document.querySelector(
        "button.review-header__button-take"
      );
      if (takeButton) {
        takeButton.click();
        return true;
      }
      return false;
    });

    if (buttonFound) {
      await sleep(2);
      return true;
    } else {
      console.log("Кнопка 'Взять в работу' не найдена");
      return false;
    }
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

    await page.waitForSelector('.FieldView[data-id="assignee"]', {
      timeout: 5000,
    });

    const isAssigned = await page.evaluate(() => {
      const assigneeField = document.querySelector(
        '.FieldView[data-id="assignee"]'
      );
      const assignButton = assigneeField?.querySelector(".FieldView-Me");
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
      await page.waitForSelector('.FieldView[data-id="status"] button', {
        timeout: 5000,
      });

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

      await page.waitForSelector(".IssueStatus-popup-wrapper", {
        timeout: 5000,
      });

      const statusChanged = await page.evaluate(() => {
        const popup = document.querySelector(".IssueStatus-popup-wrapper");
        const workOption = Array.from(
          popup?.querySelectorAll(".g-list__item") || []
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
    await sleep(2);

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

    try {
      await notifier.sendText(
        `❌ Ошибка взятия задачи "${taskTitle}": ${error.message}`
      );
    } catch (tgError) {
      await MailService.sendAlertMail(
        "",
        `${CONFIG.targetUrl}/${taskKey}`,
        `Ошибка взятия задачи "${taskTitle}": ${error.message}`
      );
    }

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

    const columnHeaders = document.querySelectorAll(".agile-column-header");
    let totalTasks = 0;

    columnHeaders.forEach((header) => {
      const countElement = header.querySelector(
        ".agile-column-header__issues-count"
      );
      if (countElement) {
        const count = parseInt(countElement.textContent) || 0;
        totalTasks += count;
      }
    });

    return {
      taskCount: totalTasks.toString(),
      openTaskKeys: openTasks,
      taskTitles: taskTitles,
      selectorExists: columnHeaders.length > 0,
    };
  });

  if (!result.selectorExists) {
    return { openTasks: [], taskTitles: {}, taskCount: result.taskCount };
  }

  return {
    openTasks: result.openTaskKeys,
    taskTitles: result.taskTitles,
    taskCount: result.taskCount,
  };
}

async function processInitialTasks(page) {
  try {
    const { openTasks, taskTitles, taskCount } = await getAllOpenTasks(page);
    const tasksInWork = await getTasksInWork(page);
    const tasksInWorkCount = tasksInWork.length;

    if (openTasks.length > 0) {
      const validTasks = [];
      for (const taskKey of openTasks) {
        const shouldProcess = await checkSprintWhitelist(page, taskKey);
        if (shouldProcess) {
          validTasks.push({ key: taskKey, title: taskTitles[taskKey] });
        }
      }

      if (validTasks.length > 0) {
        const formattedDate = getFormattedDate();
        const screenshotName = `initial-tasks-${formattedDate}.png`;
        const screenshotPath = `./screenshots/${screenshotName}`;

        await page.screenshot({
          path: screenshotPath,
          fullPage: true,
        });

        try {
          const tasksList = validTasks
            .map((task) => `• ${task.title}`)
            .join("\n");
          await notifier.sendAlert({
            imagePath: screenshotPath,
            link: CONFIG.targetBoardUrl,
            caption: `🚀 <b>Обнаружены задачи при запуске!</b>\n\n${tasksList}\n\nВсего задач: ${taskCount}\nВ работе: ${tasksInWorkCount}/${CONFIG.maxTasks}`,
            showBoardButton: true,
          });

          let assignedCount = 0;
          const assignedTasks = [];

          for (const task of validTasks) {
            if (
              tasksInWorkCount + assignedCount < CONFIG.maxTasks &&
              CONFIG.autoAssign
            ) {
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

          await cleanupScreenshot(screenshotPath);
        } catch (error) {
          console.error("Ошибка отправки уведомления:", error);
        }

        await page.goto(CONFIG.targetBoardUrl, {
          waitUntil: "networkidle2",
          timeout: 60000,
        });
        await sleep(2);
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

    const columnHeaders = document.querySelectorAll(".agile-column-header");
    let totalTasks = 0;

    columnHeaders.forEach((header) => {
      const countElement = header.querySelector(
        ".agile-column-header__issues-count"
      );
      if (countElement) {
        const count = parseInt(countElement.textContent) || 0;
        totalTasks += count;
      }
    });

    return {
      taskCount: totalTasks.toString(),
      openTaskKeys: openTasks,
      taskTitles: taskTitles,
      selectorExists: columnHeaders.length > 0,
    };
  });

  if (!result.selectorExists) {
    return { newOpenTasks: [], taskTitles: {}, taskCount: result.taskCount };
  }

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
    taskCount: result.taskCount,
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
    await notifier.sendConfigMenu();

    while (true) {
      try {
        await page.reload({ waitUntil: "networkidle2" });
        await sleep(2);

        const { newOpenTasks, taskTitles, taskCount } = await getNewOpenTasks(
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

          if (tasksInWorkCount >= CONFIG.maxTasks) {
            await notifier.sendText(
              `⚠️ Достигнут лимит задач в работе: ${tasksInWorkCount}/${CONFIG.maxTasks}\nНовые задачи не будут взяты автоматически.`
            );
          }

          const validTasks = [];
          for (const taskKey of newOpenTasks) {
            const shouldProcess = await checkSprintWhitelist(page, taskKey);
            if (shouldProcess) {
              validTasks.push({ key: taskKey, title: taskTitles[taskKey] });
            }
          }

          if (validTasks.length > 0) {
            const formattedDate = getFormattedDate();
            const screenshotName = `new-tasks-${formattedDate}.png`;
            const screenshotPath = `./screenshots/${screenshotName}`;

            await page.screenshot({
              path: screenshotPath,
              fullPage: true,
            });

            try {
              const tasksList = validTasks
                .map((task) => `• ${task.title}`)
                .join("\n");
              await notifier.sendAlert({
                imagePath: screenshotPath,
                link: CONFIG.targetBoardUrl,
                caption: `🚀 <b>Обнаружены новые задачи!</b>\n\n${tasksList}\n\nВсего задач: ${taskCount}\nВ работе: ${tasksInWorkCount}/${CONFIG.maxTasks}`,
                showBoardButton: true,
              });

              let assignedCount = 0;
              const assignedTasks = [];

              for (const task of validTasks) {
                if (
                  tasksInWorkCount + assignedCount < CONFIG.maxTasks &&
                  CONFIG.autoAssign
                ) {
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

              await cleanupScreenshot(screenshotPath);
            } catch (error) {
              console.error("Ошибка отправки уведомления:", error);
              try {
                const tasksList = validTasks
                  .map((task) => task.title)
                  .join(", ");
                await MailService.sendAlertMail(
                  screenshotName,
                  CONFIG.targetBoardUrl,
                  `Обнаружены новые задачи: ${tasksList}`
                );
              } catch (mailError) {
                console.error("Ошибка отправки email:", mailError);
              }
            }

            await page.goto(CONFIG.targetBoardUrl, {
              waitUntil: "networkidle2",
              timeout: 60000,
            });
            await sleep(2);
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
