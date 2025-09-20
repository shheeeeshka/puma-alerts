import { sleep, checkSprintWhitelist, getFormattedDate } from "./utils.js";
import CONFIG from "./config.js";
import logger from "./logger.js";
import mailService from "./mailService.js";

class TaskManager {
  constructor(browserManager, notifier) {
    this.browserManager = browserManager;
    this.notifier = notifier;
    this.processedTasks = new Set();
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

  async clickTakeWorkButton(page) {
    try {
      const buttonFound = await page.evaluate(() => {
        const buttonSelectors = [
          "button.review-header__button-take",
          ".prisma-button2",
          'button[class*="take"]',
          'button[class*="work"]',
        ];

        for (const selector of buttonSelectors) {
          const buttons = Array.from(document.querySelectorAll(selector));
          for (const button of buttons) {
            if (button && button.offsetParent !== null) {
              const text = button.textContent.toLowerCase();
              if (
                text.includes("взять") ||
                text.includes("take") ||
                text.includes("work") ||
                text.includes("₽") ||
                text.includes("руб")
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
      logger.error(
        { error: error.message },
        'Ошибка при нажатии кнопки "Взять в работу"'
      );
      return false;
    }
  }

  async assignTask(taskKey, taskTitle) {
    if (!CONFIG.autoAssign || this.tasksTaken >= CONFIG.maxTasks) {
      return false;
    }

    const page = this.browserManager.getPage();
    if (!page) {
      logger.error("Страница не доступна для взятия задачи");
      return false;
    }

    try {
      logger.info({ taskKey, taskTitle }, "Попытка взять задачу в работу");

      await this.browserManager.navigateTo(`${CONFIG.targetUrl}/${taskKey}`, {
        timeout: 15000,
      });

      await sleep(3);

      const takeButtonClicked = await this.clickTakeWorkButton(page);
      if (!takeButtonClicked) {
        logger.warn({ taskKey }, 'Не удалось найти кнопку "Взять в работу"');
        return false;
      }

      await sleep(5);
      await this.browserManager.reloadPage();

      this.tasksTaken++;
      logger.info(
        { taskKey, tasksTaken: this.tasksTaken },
        "Задача взята в работу"
      );

      try {
        await this.notifier.sendText(
          `✅ Задача взята в работу\n"${taskTitle}"\n📊 Взято задач: ${this.tasksTaken}/${CONFIG.maxTasks}`
        );
      } catch (error) {
        logger.error(
          { error: error.message },
          "Ошибка отправки уведомления в Telegram"
        );
        await mailService.sendAlertMail(
          "",
          `${CONFIG.targetUrl}/${taskKey}`,
          `Задача "${taskTitle}" взята в работу\nВзято задач: ${this.tasksTaken}/${CONFIG.maxTasks}`
        );
      }

      if (this.tasksTaken >= CONFIG.maxTasks) {
        await this.notifier.sendText(
          `🎯 Достигнут лимит задач (${CONFIG.maxTasks}). Автозабор отключен.`
        );
      }

      return true;
    } catch (error) {
      logger.error({ error: error.message, taskKey }, "Ошибка взятия задачи");
      await this.notifier.sendText(
        `❌ Ошибка взятия задачи "${taskTitle}": ${error.message}`
      );
      return false;
    }
  }

  async getNormalTasks() {
    const page = this.browserManager.getPage();
    if (!page) {
      throw new Error("Страница не доступна");
    }

    try {
      await this.browserManager.reloadPage();
      await sleep(3);

      const result = await page.evaluate(() => {
        const sections = Array.from(document.querySelectorAll(".g-disclosure"));

        let normalTasksSection = null;
        let normalTasks = [];
        let taskTitles = {};

        for (const section of sections) {
          const header = section.querySelector(
            ".collapse-widget-header__title-item_primary"
          );
          if (header && header.textContent.includes("Обычные задачи")) {
            normalTasksSection = section;
            break;
          }
        }

        if (normalTasksSection) {
          const table = normalTasksSection.querySelector("table");
          if (table) {
            const rows = table.querySelectorAll("tbody tr[data-key]");

            rows.forEach((row) => {
              const key = row.getAttribute("data-key");
              if (key) {
                const titleElement =
                  row.querySelector(".edit-cell__text") ||
                  row.querySelector('a[href*="/browse/"]') ||
                  row.querySelector("td:first-child");
                const title = titleElement
                  ? titleElement.textContent.trim()
                  : key;
                normalTasks.push(key);
                taskTitles[key] = title;
              }
            });
          }
        }

        return {
          normalTaskKeys: normalTasks,
          taskTitles: taskTitles,
          taskCount: normalTasks.length,
        };
      });

      logger.debug(
        {
          taskCount: result.normalTaskKeys.length,
          tasks: result.normalTaskKeys,
        },
        "Найдены задачи в секции 'Обычные задачи'"
      );

      return {
        normalTasks: result.normalTaskKeys,
        taskTitles: result.taskTitles,
        taskCount: result.taskCount,
      };
    } catch (error) {
      logger.error({ error: error.message }, "Ошибка получения задач");
      return { normalTasks: [], taskTitles: {}, taskCount: 0 };
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

  async processTasks(tasks, taskTitles, isInitial = false) {
    const newTasks = tasks.filter(
      (taskKey) => !this.processedTasks.has(taskKey)
    );

    if (newTasks.length === 0) {
      return;
    }

    newTasks.forEach((taskKey) => this.processedTasks.add(taskKey));

    try {
      const tasksList = newTasks
        .map((taskKey) => `• ${taskTitles[taskKey]}`)
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
          await this.filterTasksBySprint(newTasks, taskTitles);

        const assignedTasks = [];

        for (const taskKey of filteredTasks) {
          if (this.tasksTaken < CONFIG.maxTasks) {
            const assigned = await this.assignTask(
              taskKey,
              filteredTitles[taskKey]
            );
            if (assigned) {
              assignedTasks.push(filteredTitles[taskKey]);
            }
            await sleep(1);
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
    } catch (error) {
      logger.error({ error: error.message }, "Ошибка обработки задач");
    }
  }

  async checkAuth() {
    const page = this.browserManager.getPage();
    try {
      const isAuthRequired = await page.evaluate(() => {
        const authSelectors = [
          'input[type="password"]',
          'input[name="password"]',
          ".passport-Domik",
          ".passport-AccountList",
          'a[href*="passport.yandex-team.ru"]',
        ];

        return authSelectors.some(
          (selector) => document.querySelector(selector) !== null
        );
      });

      if (isAuthRequired) {
        logger.warn("Обнаружена форма авторизации");
        await this.notifier.sendText(
          "⚠️ Требуется повторная авторизация в системе"
        );
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

      if (CONFIG.authRequired) {
        logger.info("Ожидание аутентификации...");
        await sleep(240);
      }

      const { normalTasks, taskTitles, taskCount } =
        await this.getNormalTasks();
      this.lastTaskCount = taskCount;

      await this.processTasks(normalTasks, taskTitles, true);

      let prevNormalTaskKeys = normalTasks;

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

          await sleep(5);

          const {
            normalTasks: currentTasks,
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
            (task) => !prevNormalTaskKeys.includes(task)
          );

          if (newTasks.length > 0) {
            logger.info({ newTasks }, "Обнаружены новые задачи");
            await this.processTasks(newTasks, currentTitles, false);
          }

          prevNormalTaskKeys = currentTasks;
          errorCount = 0;

          await sleep(10);
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
      logger.error(
        { error: error.message, stack: error.stack },
        "Критическая ошибка мониторинга"
      );
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
