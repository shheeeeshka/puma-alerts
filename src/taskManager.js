import { sleep, checkSprintWhitelist } from "./utils.js";
import CONFIG from "./config.js";
import logger from "./logger.js";

class TaskManager {
  constructor(browserManager, notifier) {
    this.browserManager = browserManager;
    this.notifier = notifier;
    this.tasksTaken = 0;
    this.monitoringActive = false;
    this.lastTaskCount = 0;
  }

  async startMonitoring() {
    this.monitoringActive = true;
    this.tasksTaken = 0;
    logger.info("Запуск мониторинга задач");
    await this.trackTasks();
  }

  async stopMonitoring() {
    this.monitoringActive = false;
    logger.info("Остановка мониторинга");
  }

  async extractTaskUrlFromModal(page) {
    try {
      const url = await page.evaluate(() => {
        // const greenBorderElement = document.querySelector(
        //   '.yfm__wacko[style*="border:2px solid green"]'
        // );
        // if (!greenBorderElement) return null;

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
    try {
      await taskPage.bringToFront();

      const buttonClicked = await taskPage.evaluate(() => {
        const buttons = [
          ".prisma-button2",
          'button[class*="take"]',
          'button[class*="work"]',
          'button[class*="assign"]',
          'button[type="button"]',
        ];

        for (const selector of buttons) {
          const elements = document.querySelectorAll(selector);
          for (const element of elements) {
            const text = element.textContent.toLowerCase();
            if (
              text.includes("взять") ||
              text.includes("take") ||
              text.includes("work") ||
              text.includes("assign")
            ) {
              element.click();
              return true;
            }
          }
        }
        return false;
      });

      if (buttonClicked) {
        try {
          await taskPage.screenshot({
            path: `debug_screenshots/task_clicked_${Date.now()}.png`,
            fullPage: false,
          });
          logger.debug("Скриншот после клика сохранен");
        } catch (screenshotError) {
          logger.debug("Не удалось сделать скриншот");
        }

        return true;
        await sleep(2);

        const success = await taskPage.evaluate(() => {
          const successIndicators = [
            'button[class*="taken"]',
            'button[class*="assigned"]',
            ".status-success",
            ".alert-success",
          ];

          return successIndicators.some((selector) =>
            document.querySelector(selector)
          );
        });

        if (success) {
          logger.info("Задача успешно взята в работу");
          return true;
        }
      }

      return false;
    } catch (error) {
      logger.error(
        { error: error.message },
        "Ошибка взятия задачи на странице практикума"
      );
      return false;
    }
  }

  async handleTaskAssignment(taskKey, taskTitle, taskUrl) {
    if (!CONFIG.autoAssign || this.tasksTaken >= CONFIG.maxTasks) {
      return false;
    }

    const mainPage = this.browserManager.getPage();
    if (!mainPage) {
      logger.error("Основная страница не доступна");
      return false;
    }

    try {
      logger.info({ taskKey, taskTitle }, "Обработка задачи");

      const taskPage = await this.browserManager.openNewTab();
      if (!taskPage) {
        logger.error("Не удалось открыть новую вкладку");
        return false;
      }

      try {
        await taskPage.goto(taskUrl, {
          waitUntil: "domcontentloaded",
          timeout: 8000,
        });

        const assigned = await this.takeTaskOnPraktikumPage(taskPage);

        if (assigned) {
          this.tasksTaken++;
          logger.info(
            { taskKey, tasksTaken: this.tasksTaken },
            "Задача взята в работу"
          );
        }

        return assigned;
      } finally {
        await taskPage.close();
        await mainPage.bringToFront();
        await sleep(1);
      }
    } catch (error) {
      logger.error(
        { error: error.message, taskKey },
        "Ошибка обработки задачи"
      );
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
      await sleep(1);
    } catch (error) {
      logger.debug("Ошибка закрытия модального окна");
    }
  }

  async getNormalTasks() {
    const page = this.browserManager.getPage();
    if (!page) {
      throw new Error("Страница не доступна");
    }

    try {
      await this.browserManager.reloadPage();
      await sleep(2);

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

      logger.debug(
        {
          taskCount: result.normalTaskKeys.length,
          tasks: result.normalTaskKeys,
        },
        "Найдены задачи"
      );

      return result;
    } catch (error) {
      logger.error({ error: error.message }, "Ошибка получения задач");
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

    return { filteredTasks, filteredTitles };
  }

  async processTasks(newTasks, taskTitles, isInitial = false) {
    if (newTasks.length === 0) {
      return;
    }

    try {
      const mainPage = this.browserManager.getPage();
      if (!mainPage) {
        throw new Error("Основная страница не доступна");
      }

      const tasksWithUrls = [];

      for (const taskKey of newTasks) {
        const taskTitle = taskTitles[taskKey];

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
          await sleep(1.8);
          const taskUrl = await this.extractTaskUrlFromModal(mainPage);

          if (taskUrl) {
            tasksWithUrls.push({
              key: taskKey,
              title: taskTitle,
              url: taskUrl,
            });
          }

          await this.closeModal(mainPage);
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
          const assignedTasks = [];

          for (const task of tasksWithUrls) {
            if (this.tasksTaken >= CONFIG.maxTasks) break;

            const shouldProcess = checkSprintWhitelist(
              task.title,
              CONFIG.sprintWhitelist
            );

            if (shouldProcess) {
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
      logger.error({ error: error.message }, "Ошибка обработки задач");
    }
  }

  async checkAuth() {
    const page = this.browserManager.getPage();
    try {
      const currentUrl = await page.url();
      if (
        currentUrl.includes("passport.yandex-team.ru") ||
        currentUrl.includes("passport?mode=auth")
      ) {
        logger.warn("Обнаружена страница авторизации по URL");
        await this.notifier.sendText("⚠️ Требуется авторизация в системе");
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
        logger.warn("Обнаружена форма авторизации");
        await this.notifier.sendText("⚠️ Требуется авторизация в системе");
        return false;
      }

      return true;
    } catch (error) {
      logger.error({ error: error.message }, "Ошибка проверки авторизации");
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
        logger.info("Ожидание аутентификации...");
        await this.notifier.sendText("⚠️ Требуется авторизация в системе");
        await sleep(240);

        const stillNotAuthenticated = await this.checkAuth();
        if (stillNotAuthenticated) {
          await this.notifier.sendText(
            "❌ Мониторинг остановлен: требуется авторизация"
          );
          return;
        }
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
          const isAuthenticated = await this.checkAuth();
          if (!isAuthenticated) {
            await this.notifier.sendText(
              "❌ Мониторинг остановлен: требуется авторизация"
            );
            break;
          }

          await sleep(1);

          const {
            normalTaskKeys: currentTasks,
            taskTitles: currentTitles,
            taskCount: currentCount,
          } = await this.getNormalTasks();

          if (currentCount !== this.lastTaskCount) {
            logger.info(
              {
                previousCount: this.lastTaskCount,
                currentCount: currentCount,
              },
              "Изменение количества задач"
            );
            this.lastTaskCount = currentCount;
          }

          const newTasks = currentTasks.filter(
            (task) => !prevTasks.includes(task)
          );

          if (newTasks.length > 0) {
            logger.info({ newTasks }, "Обнаружены новые задачи");
            await this.processTasks(newTasks, currentTitles, false);
          }

          prevTasks = currentTasks;
          errorCount = 0;

          await sleep(1.8);
        } catch (error) {
          logger.error({ error: error.message }, "Ошибка в цикле мониторинга");
          errorCount++;

          if (errorCount >= maxErrors) {
            await this.notifier.sendText(
              `❌ Мониторинг остановлен из-за ${maxErrors} ошибок подряд`
            );
            throw new Error(
              `Превышено максимальное количество ошибок (${maxErrors})`
            );
          }

          await sleep(15);
        }
      }
    } catch (error) {
      logger.error({ error: error.message }, "Критическая ошибка мониторинга");
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
