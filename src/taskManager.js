import { sleep, checkSprintWhitelist } from "./utils.js";
import CONFIG from "./config.js";
import logger from "./logger.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class TaskManager {
  constructor(browserManager, notifier) {
    this.browserManager = browserManager;
    this.notifier = notifier;
    this.tasksTaken = 0;
    this.monitoringActive = false;
    this.lastTaskCount = 0;
    this.authNotificationSent = false;
    this.screenshotsDir = path.join(__dirname, "screenshots");

    this.notifiedTasks = new Set();
    this.failedAssignmentTasks = new Set();
  }

  async ensureScreenshotsDir() {
    if (!fs.existsSync(this.screenshotsDir)) {
      fs.mkdirSync(this.screenshotsDir, { recursive: true });
    }
  }

  async takeScreenshot(page, name) {
    try {
      await this.ensureScreenshotsDir();
      const filename = `${name}_${Date.now()}.png`;
      const screenshotPath = path.join(this.screenshotsDir, filename);
      
      await page.screenshot({
        path: screenshotPath,
        type: "png",
      });
      
      logger.info("Скриншот сделан", { path: screenshotPath });
      return filename;
    } catch (error) {
      logger.error("Не удалось сделать скриншот", { error: error.message });
      return null;
    }
  }

  async startMonitoring() {
    this.monitoringActive = true;
    this.tasksTaken = 0;
    this.authNotificationSent = false;
    this.notifiedTasks.clear();
    this.failedAssignmentTasks.clear();
    logger.info("Запуск мониторинга задач");
    await this.trackTasks();
  }

  async stopMonitoring() {
    this.monitoringActive = false;
    logger.info("Остановка мониторинга");
  }

  async extractTaskUrlFromModal(page) {
    try {
      await page.waitForSelector('a[href*="praktikum-admin.yandex-team.ru"]', {
        timeout: 5000,
      });

      const url = await page.evaluate(() => {
        const linkElement = document.querySelector(
          'a[href*="praktikum-admin.yandex-team.ru"]'
        );
        return linkElement ? linkElement.href : null;
      });

      if (url) {
        logger.info({ url }, "Найдена ссылка на задачу в модальном окне");
        return url;
      }
      return null;
    } catch (error) {
      logger.error(
        { error: error.message },
        "Ошибка извлечения URL из модального окна"
      );
      return null;
    }
  }

  async takeTaskOnPraktikumPage(taskPage) {
    let screenshotPath = null;

    try {
      logger.info("Попытка взять задачу на странице практикума");
      
      const beforeScreenshot = await this.takeScreenshot(taskPage, "before_any_actions");
      logger.info("Скриншот до действий", { path: beforeScreenshot });

      await taskPage.bringToFront();

      const buttonInfo = await taskPage.evaluate(() => {
        const buttons = ['button[data-qa*="take"]', 'button[data-qa*="assign"]', 'button[title*="Взять"]', ".prisma-button2--action"];
        const results = [];
        
        for (const selector of buttons) {
          const element = document.querySelector(selector);
          if (element) {
            results.push({
              selector,
              visible: element.offsetParent !== null,
              text: element.textContent,
              disabled: element.disabled,
              clickable: element.offsetParent !== null && !element.disabled
            });
          }
        }
        return results;
      });

      logger.info("Диагностика кнопок", { buttons: buttonInfo });

      await sleep(1.2);

      const buttonClicked = await taskPage.evaluate(() => {
        const buttons = [
          'button[data-qa*="take"]',
          'button[data-qa*="assign"]',
          'button[title*="Взять"]',
          ".prisma-button2--action",
          'button:contains("Взять")',
          'button:contains("Take")',
          'button:contains("Assign")',
        ];

        for (const selector of buttons) {
          const elements = document.querySelectorAll(selector);
          for (const element of elements) {
            const text = element.textContent.toLowerCase();
            if (element.offsetParent !== null) {
              element.click();
              return true;
            }
          }
        }
        return false;
      });

      logger.info("Клик по кнопке выполнен", { clicked: buttonClicked });

      await sleep(1.2);
      screenshotPath = await this.takeScreenshot(taskPage, "task_clicked");

      if (buttonClicked) {
        await sleep(1.2);

        const success = await taskPage.evaluate(() => {
          const slaTimerRegex =
            /Таймер\s*SLA:?\s*.*?(?:\d+ч\s*\d+м|\d+[\sччасов]*\d+[\sмминут])/i;

          const pageText = document.body.textContent || document.body.innerText;

          const match = pageText.match(slaTimerRegex);

          if (match) {
            const timerText = match[0];
            return !timerText.includes("0ч 0м") && /\d+[ччh]/.test(timerText);
          }

          return false;
        });

        logger.info("Проверка успешности взятия задачи", { success });
        return { success: success, screenshotPath };
      }

      return { success: false, screenshotPath };
    } catch (error) {
      logger.error("Ошибка взятия задачи на странице практикума", {
        error: error.message,
      });
      return { success: false, screenshotPath };
    }
  }

  async handleTaskAssignment(taskKey, taskTitle, taskUrl) {
    if (!CONFIG.autoAssign || this.tasksTaken >= CONFIG.maxTasks) {
      logger.info("Автозабор отключен или достигнут лимит", {
        autoAssign: CONFIG.autoAssign,
        tasksTaken: this.tasksTaken,
        maxTasks: CONFIG.maxTasks,
      });
      return false;
    }

    const mainPage = this.browserManager.getPage();
    if (!mainPage) {
      logger.error("Основная страница не доступна");
      return false;
    }

    try {
      logger.info("Обработка задачи", { taskKey, taskTitle });

      const taskPage = await this.browserManager.openNewTab();
      if (!taskPage) {
        logger.error("Не удалось открыть новую вкладку");
        return false;
      }

      try {
        logger.info("Переход на страницу задачи", { url: taskUrl });
        await taskPage.goto(taskUrl, {
          waitUntil: "networkidle0",
          timeout: 15000,
        });

        const debugScreenshotPath = await this.takeScreenshot(
          taskPage,
          "debug_before_click"
        );
        logger.info("Скриншот перед кликом сделан", {
          path: debugScreenshotPath,
        });

        const { success, screenshotPath } = await this.takeTaskOnPraktikumPage(
          taskPage
        );

        if (success) {
          this.tasksTaken++;
          logger.info("Задача взята в работу", {
            taskKey,
            tasksTaken: this.tasksTaken,
          });

          if (screenshotPath) {
            await this.notifier.sendAlert({
              imagePath: screenshotPath,
              link: taskUrl,
              caption: `✅ Задача взята в работу\n\n${taskTitle}\n\nВзято задач: ${this.tasksTaken}/${CONFIG.maxTasks}`,
              showBoardButton: true,
            });
          }

          this.failedAssignmentTasks.delete(taskKey);
        } else {
          logger.info("Не удалось взять задачу", { taskKey });
          this.failedAssignmentTasks.add(taskKey);
        }

        return success;
      } finally {
        await taskPage.close();
        await mainPage.bringToFront();
        await sleep(1);
      }
    } catch (error) {
      logger.error("Ошибка обработки задачи", {
        error: error.message,
        taskKey,
      });
      this.failedAssignmentTasks.add(taskKey);
      return false;
    }
  }

  extractSprintNumber(taskTitle) {
    const match = taskTitle.match(/\[(\d+)\]/);
    return match ? match[1] : null;
  }

  async closeModal(page) {
    try {
      await page.evaluate(() => {
        const closeSelectors = [
          'button[aria-label="Close"]',
          ".modal-close",
          ".close-button",
          '[class*="close"]',
          ".g-modal-close",
        ];

        for (const selector of closeSelectors) {
          const element = document.querySelector(selector);
          if (element) {
            element.click();
            return true;
          }
        }
        return false;
      });
      await sleep(0.5);
    } catch (error) {
      logger.info("Ошибка закрытия модального окна");
    }
  }

  async getNormalTasks() {
    const page = this.browserManager.getPage();
    if (!page) {
      throw new Error("Страница не доступна");
    }

    try {
      await this.browserManager.reloadPage();
      await sleep(1.5);

      logger.info("Поиск секции обычных задач");

      const result = await page.evaluate(() => {
        const normalTasksSection = Array.from(
          document.querySelectorAll(
            ".collapse-widget-header__title-item_primary"
          )
        ).find(
          (el) =>
            el.textContent.includes("💨") &&
            el.textContent.includes("Обычные задачи")
        );

        if (!normalTasksSection) {
          return { normalTaskKeys: [], taskTitles: {}, taskCount: 0 };
        }

        const widget = normalTasksSection.closest(".filter-widget");
        if (!widget) {
          return { normalTaskKeys: [], taskTitles: {}, taskCount: 0 };
        }

        const taskTable = widget.querySelector("table.gt-table");
        if (!taskTable) {
          return { normalTaskKeys: [], taskTitles: {}, taskCount: 0 };
        }

        const taskRows = taskTable.querySelectorAll("tr[data-key]");
        const tasks = [];
        const taskTitles = {};

        taskRows.forEach((row) => {
          const key = row.getAttribute("data-key");
          if (key && key.startsWith("PCR-")) {
            const titleElement =
              row.querySelector('.edit-cell__text, a[href*="/browse/"]') ||
              row.querySelector("td:nth-child(2)");
            const title = titleElement ? titleElement.textContent.trim() : key;

            tasks.push(key);
            taskTitles[key] = title;
          }
        });

        return {
          normalTaskKeys: tasks,
          taskTitles: taskTitles,
          taskCount: tasks.length,
        };
      });

      logger.info("Найдены задачи", {
        taskCount: result.normalTaskKeys.length,
        tasks: result.normalTaskKeys,
      });

      return result;
    } catch (error) {
      logger.error("Ошибка получения задач", { error: error.message });
      return { normalTaskKeys: [], taskTitles: {}, taskCount: 0 };
    }
  }

  async filterTasksBySprint(tasks, taskTitles) {
    const filteredTasks = [];
    const filteredTitles = {};

    for (const taskKey of tasks) {
      const title = taskTitles[taskKey];
      const hasSprintBrackets = /\[\d+\]/.test(title);

      if (hasSprintBrackets) {
        const shouldProcess = checkSprintWhitelist(
          title,
          CONFIG.sprintWhitelist
        );
        if (shouldProcess) {
          filteredTasks.push(taskKey);
          filteredTitles[taskKey] = title;
        }
      } else {
        if (CONFIG.sprintWhitelist.length === 0) {
          filteredTasks.push(taskKey);
          filteredTitles[taskKey] = title;
        }
      }
    }

    logger.info("Задачи отфильтрованы по спринтам", {
      original: tasks.length,
      filtered: filteredTasks.length,
    });

    return { filteredTasks, filteredTitles };
  }

  async processTasks(newTasks, taskTitles, isInitial = false) {
    if (newTasks?.length === 0) {
      return;
    }

    try {
      const mainPage = this.browserManager.getPage();
      if (!mainPage) {
        throw new Error("Основная страница не доступна");
      }

      const tasksToProcess = [];
      const tasksWithUrls = [];

      for (const taskKey of newTasks) {
        tasksToProcess.push(taskKey);
      }

      if (tasksToProcess.length === 0) {
        logger.info("Нет новых задач для обработки");
        return;
      }

      logger.info("Обработка новых задач", {
        count: tasksToProcess.length,
        tasks: tasksToProcess,
      });

      for (const taskKey of tasksToProcess) {
        if (
          this.notifiedTasks.has(taskKey) &&
          !this.failedAssignmentTasks.has(taskKey)
        ) {
          logger.info("Задача уже уведомлена, пропускаем", { taskKey });
          continue;
        }

        const taskTitle = taskTitles[taskKey];

        logger.info("Клик по задаче для открытия модального окна", {
          taskKey,
        });

        const taskClicked = await mainPage.evaluate((taskKey) => {
          const selectors = [
            `tr[data-key="${taskKey}"]`,
            `[data-key="${taskKey}"]`,
            `a[href*="${taskKey}"]`,
          ];

          for (const selector of selectors) {
            const element = document.querySelector(selector);
            if (element) {
              element.click();
              return true;
            }
          }
          return false;
        }, taskKey);

        if (taskClicked) {
          await sleep(0.4);

          const taskUrl = await this.extractTaskUrlFromModal(mainPage);

          if (taskUrl) {
            tasksWithUrls.push({
              key: taskKey,
              title: taskTitle,
              url: taskUrl,
            });
            this.notifiedTasks.add(taskKey);
          } else {
            logger.info("Не удалось получить URL для задачи", { taskKey });
          }

          await this.closeModal(mainPage);
        } else {
          logger.info("Не удалось кликнуть по задаче", { taskKey });
        }
      }

      if (tasksWithUrls.length > 0) {
        const tasksList = tasksWithUrls
          .map((task) => `• <a href="${task.url}">${task.title}</a>`)
          .join("\n");

        await this.notifier.sendText(
          `🚀 <b>${
            isInitial
              ? "Обнаружены задачи при запуске!"
              : "Обнаружены новые задачи!"
          }</b>\n\n${tasksList}\n\nВзято задач: ${this.tasksTaken}/${
            CONFIG.maxTasks
          }`
        );

        if (CONFIG.autoAssign && this.tasksTaken < CONFIG.maxTasks) {
          const { filteredTasks, filteredTitles } =
            await this.filterTasksBySprint(tasksToProcess, taskTitles);

          const tasksToAssign = tasksWithUrls.filter(
            (task) =>
              filteredTasks.includes(task.key) ||
              this.failedAssignmentTasks.has(task.key)
          );

          logger.info("Задачи для автозабора", {
            count: tasksToAssign.length,
            tasks: tasksToAssign.map((t) => t.key),
          });

          const assignedTasks = [];

          for (const task of tasksToAssign) {
            if (this.tasksTaken < CONFIG.maxTasks) {
              const assigned = await this.handleTaskAssignment(
                task.key,
                task.title,
                task.url
              );
              if (assigned) {
                assignedTasks.push(task.title);
              }
            }
          }

          if (assignedTasks.length > 0) {
            await this.notifier.sendText(
              `✅ Удалось взять в работу ${
                assignedTasks.length
              } задач:\n${assignedTasks
                .map((task) => `• ${task}`)
                .join("\n")}\n📊 Взято задач: ${this.tasksTaken}/${
                CONFIG.maxTasks
              }`
            );
          }
        }
      }
    } catch (error) {
      logger.error("Ошибка обработки задач", { error: error.message });
    }
  }

  async recoverBrowser() {
    try {
      logger.info("Запуск восстановления браузера");

      const wasMonitoring = this.monitoringActive;
      this.monitoringActive = false;

      if (this.browserManager) {
        await this.browserManager.close();
      }

      await sleep(4);

      await this.browserManager.init();

      await this.browserManager.navigateTo(CONFIG.targetBoardUrl);

      this.authNotificationSent = false;

      const isAuthenticated = await this.checkAuth();

      if (isAuthenticated) {
        logger.info("Браузер успешно восстановлен, авторизация подтверждена");

        if (wasMonitoring) {
          this.monitoringActive = true;
          setTimeout(() => this.trackTasks(), 1000);
        }

        return true;
      } else {
        logger.info("Браузер восстановлен, но требуется авторизация");

        if (wasMonitoring) {
          await this.notifier.sendText(
            "❌ Мониторинг остановлен: требуется авторизация после восстановления браузера"
          );
        }

        return false;
      }
    } catch (error) {
      logger.error("Критическая ошибка восстановления браузера", {
        error: error.message,
      });

      try {
        await this.notifier.sendText(
          "❌ Критическая ошибка восстановления браузера: " + error.message
        );
      } catch (notifyError) {
        logger.error("Не удалось отправить уведомление об ошибке", {
          error: notifyError.message,
        });
      }

      return false;
    }
  }

  async checkAuth() {
    const page = this.browserManager.getPage();
    try {
      if (!page) {
        logger.info(
          "Страница недоступна или закрыта, требуется восстановление браузера"
        );
        await this.recoverBrowser();
        return false;
      }
      const currentUrl = await page.url();
      if (
        currentUrl.includes("passport.yandex-team.ru") ||
        currentUrl.includes("passport?mode=auth")
      ) {
        logger.info("Обнаружена страница авторизации по URL");

        if (!this.authNotificationSent) {
          await this.notifier.sendText("⚠️ Требуется авторизация в системе");
          this.authNotificationSent = true;
        }

        return false;
      }

      const isAuthRequired = await page.evaluate(() => {
        const authSelectors = [
          'input[type="password"]',
          'input[name="password"]',
          ".passport-Domik",
          ".passport-AccountList",
          'a[href*="passport.yandex-team.ru"]',
        ];

        const hasAuthElements = authSelectors.some(
          (selector) => document.querySelector(selector) !== null
        );

        const hasAuthText =
          document.body.textContent.includes("Выберите аккаунт для входа") ||
          document.body.textContent.includes("Войдите в аккаунт");

        return hasAuthElements || hasAuthText;
      });

      if (isAuthRequired) {
        logger.info("Обнаружена форма авторизации");

        if (!this.authNotificationSent) {
          await this.notifier.sendText("⚠️ Требуется авторизация в системе");
          this.authNotificationSent = true;
        }

        return false;
      }

      this.authNotificationSent = false;
      return true;
    } catch (error) {
      logger.error("Ошибка проверки авторизации", { error: error.message });
      return false;
    }
  }

  async trackTasks() {
    let errorCount = 0;
    const maxErrors = 10;

    try {
      await this.browserManager.navigateTo(CONFIG.targetBoardUrl);

      const isAuthenticated = await this.checkAuth();
      if (!isAuthenticated) {
        logger.info("Ожидание аутентификации");
        await sleep(60);
        await this.recoverBrowser();
      }

      const { normalTaskKeys, taskTitles, taskCount } =
        await this.getNormalTasks();
      this.lastTaskCount = taskCount;

      await this.processTasks(normalTaskKeys, taskTitles, true);

      let prevTasks = normalTaskKeys;

      await this.notifier.sendText(
        `🚀 Мониторинг начат\nАвтозабор: ${
          CONFIG.autoAssign ? "✅" : "❌"
        }\nЛимит задач: ${CONFIG.maxTasks}\nЗадач в секции: ${taskCount}`
      );

      while (this.monitoringActive) {
        try {
          const {
            normalTaskKeys: currentTasks,
            taskTitles: currentTitles,
            taskCount: currentCount,
          } = await this.getNormalTasks();

          if (currentCount !== this.lastTaskCount) {
            logger.info("Изменение количества задач", {
              previousCount: this.lastTaskCount,
              currentCount: currentCount,
            });
            this.lastTaskCount = currentCount;
          }

          const newTasks = currentTasks.filter(
            (task) => !prevTasks.includes(task)
          );

          const retryTasks = Array.from(this.failedAssignmentTasks).filter(
            (task) => currentTasks.includes(task)
          );

          const allTasksToProcess = [...newTasks, ...retryTasks];

          if (newTasks.length > 0) {
            logger.info(
              "Обнаружены новые задачи или задачи для повторной попытки",
              {
                newTasks,
                retryTasks,
                allTasks: allTasksToProcess,
              }
            );
            await this.processTasks(allTasksToProcess, currentTitles, false);
          }

          prevTasks = currentTasks;
          errorCount = 0;

          await sleep(2);
        } catch (error) {
          logger.error("Ошибка в цикле мониторинга", { error: error.message });
          errorCount++;

          if (errorCount >= maxErrors) {
            await this.notifier.sendText(
              `❌ Мониторинг остановлен из-за ${maxErrors} ошибок подряд`
            );
            throw new Error(
              `Превышено максимальное количество ошибок (${maxErrors})`
            );
          }

          if (
            error.message.includes("detached") ||
            error.message.includes("PAGE_DETACHED")
          ) {
            logger.info(
              "Обнаружена отсоединенная страница, пытаемся восстановить"
            );

            try {
              await this.browserManager.close();
              await sleep(5);
              await this.browserManager.init();
              await this.browserManager.navigateTo(CONFIG.targetBoardUrl);

              errorCount = 0;
              this.lastTaskCount = 0;
              continue;
            } catch (recoveryError) {
              logger.error("Ошибка восстановления браузера", {
                error: recoveryError.message,
              });
            }
          }

          await sleep(5);
        }
      }
    } catch (error) {
      logger.error("Критическая ошибка мониторинга", { error: error.message });
      await this.notifier.sendText(
        `❌ Мониторинг остановлен: ${error.message}`
      );
    }
  }

  getTasksTaken() {
    return this.tasksTaken;
  }

  isMonitoringActive() {
    return this.monitoringActive;
  }
}

export default TaskManager;