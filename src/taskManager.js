import { sleep, checkSprintWhitelist } from "./utils.js";
import CONFIG from "./config.js";
import logger from "./logger.js";
import fs from "fs";
import path from "path";
import HttpTaskService from "./httpTaskService.js";

class TaskManager {
  constructor(browserManager, notifier) {
    this.browserManager = browserManager;
    this.notifier = notifier;
    this.httpTaskService = new HttpTaskService(browserManager);
    this.tasksTaken = 0;
    this.monitoringActive = false;
    this.lastTaskCount = 0;
    this.authNotificationSent = false;
    this.screenshotsDir = path.join(process.cwd(), "screenshots");
    this.notifiedTasks = new Set();
    this.processingTasks = new Set();
    console.log("process path : ", process.cwd());
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
      await page.screenshot({ path: screenshotPath, type: "png" });
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
    this.processingTasks.clear();
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
        timeout: 8000,
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
      logger.error("Ошибка извлечения URL из модального окна", {
        error: error.message,
      });
      console.log(error);
      console.log(error.message);
      return null;
    }
  }

  async verifyTaskAssignment(taskPage) {
    try {
      if (taskPage.isClosed()) {
        logger.error("Страница задачи была закрыта");
        return false;
      }

      if (!taskPage.isClosed()) {
        await taskPage.reload({
          waitUntil: "domcontentloaded",
          timeout: 10000,
        });
        await sleep(2);
      }

      await taskPage
        .evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
        })
        .catch((e) => {
          logger.error("Ошибка скролла страницы при проверке задачи", {
            error: e.message,
          });
        });

      console.log("=========");

      const success = await taskPage.evaluate(() => {
        const allButtons = Array.from(document.querySelectorAll("button"));
        // const hasFailButton = allButtons.some((btn) =>
        // btn.textContent?.includes("Незачет")
        // );
        const hasGradeButton = allButtons.some((btn) =>
          btn.textContent?.includes("Оценить проект")
        );

        return hasGradeButton;
      });

      console.log("isSuccess :", success);

      return success;
    } catch (error) {
      logger.error("Ошибка проверки назначения задачи");
      console.error(error);
      return false;
    }
  }

  async takeTaskOnPraktikumPage(taskUrl) {
    try {
      // const httpSuccess = await this.httpTaskService.takeTask(taskUrl);
      // if (httpSuccess) {
      //   logger.info("Task taken successfully via HTTP");
      //   return { success: true, method: "http" };
      // }

      logger.info("Falling back to UI method");
      const taskPage = await this.browserManager.openNewTab();
      try {
        await taskPage.goto(taskUrl, {
          waitUntil: "domcontentloaded",
          timeout: 9000,
        });

        await sleep(1.5);

        await taskPage
          .waitForSelector(
            '.prisma-button2_view_primary, [data-testid="take-button"]',
            {
              timeout: 3400,
              visible: true,
            }
          )
          .catch(() => {
            logger.debug("Кнопка 'Взять' не появилась сразу, продолжаем");
          });

        const buttonClicked = await taskPage.evaluate(() => {
          const selectors = [
            ".prisma-button2_view_primary",
            'button:contains("Взять")',
            // ".review-header__button-take",
          ];

          for (const selector of selectors) {
            const element = document.querySelector(selector);
            if (element?.offsetParent && !element.disabled) {
              element.click();
              return true;
            }
          }
          return false;
        });

        if (buttonClicked) {
          await sleep(2);

          const isAssigned = await this.verifyTaskAssignment(taskPage);

          await this.takeScreenshot(taskPage, "assign_attempt");
          return { success: isAssigned, method: "ui" };
        }

        return { success: false, method: "ui" };
      } finally {
        await taskPage.close();
      }
    } catch (error) {
      logger.error("Task taking failed", { error: error.message });
      return { success: false, method: "error" };
    }
  }

  async handleTaskAssignment(taskKey, taskTitle, taskUrl) {
    if (!CONFIG.autoAssign || this.tasksTaken >= CONFIG.maxTasks) {
      return false;
    }

    if (this.processingTasks.has(taskKey)) {
      logger.info("Задача уже в обработке", { taskKey });
      return false;
    }

    this.processingTasks.add(taskKey);

    try {
      const { success, method } = await this.takeTaskOnPraktikumPage(taskUrl);
      if (success) {
        this.tasksTaken++;
        await this.notifier.sendText(
          `✅ Задача взята (${method.toUpperCase()})\n${taskTitle}\nВзято: ${
            this.tasksTaken
          }/${CONFIG.maxTasks}`
        );
      }
      return success;
    } catch (error) {
      logger.error("Task assignment failed", { taskKey, error: error.message });
      console.log(error);
      console.log(error.message);
      return false;
    } finally {
      this.processingTasks.delete(taskKey);
    }
  }

  extractSprintNumber(taskTitle) {
    const match = taskTitle.match(/\[(\d+)\]/);
    return match ? match[1] : null;
  }

  async getNormalTasks() {
    const page = this.browserManager.getPage();
    if (!page) throw new Error("Страница не доступна");

    try {
      await this.browserManager.reloadPage();
      await sleep(1.5);

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

        if (!normalTasksSection)
          return { normalTaskKeys: [], taskTitles: {}, taskCount: 0 };

        const widget = normalTasksSection.closest(".filter-widget");
        if (!widget)
          return { normalTaskKeys: [], taskTitles: {}, taskCount: 0 };

        const taskTable = widget.querySelector("table.gt-table");
        if (!taskTable)
          return { normalTaskKeys: [], taskTitles: {}, taskCount: 0 };

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

        return { normalTaskKeys: tasks, taskTitles, taskCount: tasks.length };
      });

      if (result.normalTaskKeys.length > 0) {
        logger.info("Найдены задачи", {
          taskCount: result.normalTaskKeys.length,
          tasks: result.normalTaskKeys,
        });
      }
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
      } else if (CONFIG.sprintWhitelist.length === 0) {
        filteredTasks.push(taskKey);
        filteredTitles[taskKey] = title;
      }
    }

    logger.info("Задачи отфильтрованы по спринтам", {
      original: tasks.length,
      filtered: filteredTasks.length,
    });
    return { filteredTasks, filteredTitles };
  }

  async processTasks(newTasks, taskTitles, isInitial = false) {
    if (!newTasks?.length) return;

    try {
      const mainPage = this.browserManager.getPage();
      if (!mainPage) throw new Error("Основная страница не доступна");

      const tasksToProcess = newTasks.filter(
        (taskKey) =>
          !this.notifiedTasks.has(taskKey) && !this.processingTasks.has(taskKey)
      );

      if (!tasksToProcess.length) {
        logger.info("Нет новых задач для обработки");
        return;
      }

      logger.info("Обработка новых задач", {
        count: tasksToProcess.length,
        tasks: tasksToProcess,
      });
      const tasksWithUrls = [];

      for (const taskKey of tasksToProcess) {
        const taskTitle = taskTitles[taskKey];
        logger.info("Клик по задаче для открытия модального окна", { taskKey });

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
          await sleep(1.4);
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
          const { filteredTasks } = await this.filterTasksBySprint(
            tasksToProcess,
            taskTitles
          );
          const tasksToAssign = tasksWithUrls.filter((task) =>
            filteredTasks.includes(task.key)
          );

          logger.info("Задачи для автозабора", {
            count: tasksToAssign.length,
            tasks: tasksToAssign.map((t) => t.key),
          });
          const assignedTasks = [];

          for (const task of tasksToAssign) {
            if (this.tasksTaken >= CONFIG.maxTasks) break;

            const assigned = await this.handleTaskAssignment(
              task.key,
              task.title,
              task.url
            );
            if (assigned) {
              assignedTasks.push(task.title);
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

      if (this.browserManager) await this.browserManager.close();
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
              currentCount,
            });
            this.lastTaskCount = currentCount;
          }

          const newTasks = currentTasks.filter(
            (task) => !this.notifiedTasks.has(task)
          );
          if (newTasks.length > 0) {
            logger.info("Обнаружены новые задачи", { newTasks });
            await this.processTasks(newTasks, currentTitles, false);
          }

          prevTasks = currentTasks;
          errorCount = 0;
          await sleep(4);
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
