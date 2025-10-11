import fs from "fs";
import path from "path";
import { sleep, checkSprintWhitelist } from "./utils.js";
import CONFIG from "./config.js";
import logger from "./logger.js";

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

  async extractTaskUrlFromModal(page) {
    try {
      const url = await page.evaluate(() => {
        const greenBorderElement = document.querySelector(
          '.yfm__wacko[style*="border:2px solid green"]'
        );
        if (!greenBorderElement) return null;

        const linkElement = greenBorderElement.querySelector(
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

          await this.notifier.sendText(
            `✅ Задача взята в работу\n"${taskTitle}"\n📊 Взято задач: ${this.tasksTaken}/${CONFIG.maxTasks}`
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

  async processTasks(tasks, taskTitles, isInitial = false) {
    const newTasks = tasks.filter(
      (taskKey) => !this.processedTasks.has(taskKey)
    );

    if (newTasks.length === 0) {
      return;
    }

    logger.info(
      { newTasksCount: newTasks.length, newTasks },
      "Начало обработки новых задач"
    );

    try {
      const mainPage = this.browserManager.getPage();
      if (!mainPage) {
        throw new Error("Основная страница не инициализирована");
      }

      const tasksWithUrls = [];

      for (const taskKey of newTasks) {
        const taskTitle = taskTitles[taskKey];
        let taskUrl = null;
        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts && !taskUrl) {
          attempts++;
          try {
            logger.debug(
              { taskKey, attempt: attempts },
              "Попытка получить URL задачи"
            );

            const screenshotDir = path.join(process.cwd(), "debug_screenshots");
            if (!fs.existsSync(screenshotDir)) {
              fs.mkdirSync(screenshotDir, { recursive: true });
            }

            const taskClicked = await mainPage.evaluate((taskKey) => {
              const selectors = [
                `tr[data-key="${taskKey}"]`,
                `[data-key="${taskKey}"] .edit-cell__text`,
                `a[href*="${taskKey}"]`,
                `[data-key="${taskKey}"] td:first-child`,
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

            if (!taskClicked) {
              logger.warn({ taskKey }, "Не удалось кликнуть на задачу");

              await mainPage.screenshot({
                path: path.join(
                  screenshotDir,
                  `click_failed_${taskKey}_attempt_${attempts}.png`
                ),
                fullPage: true,
              });
              continue;
            }

            await sleep(2 + attempts);

            taskUrl = await this.extractTaskUrlFromModal(mainPage);

            if (!taskUrl) {
              logger.warn(
                { taskKey, attempt: attempts },
                "URL не найден, повторная попытка"
              );

              await mainPage.screenshot({
                path: path.join(
                  screenshotDir,
                  `modal_not_found_${taskKey}_attempt_${attempts}.png`
                ),
                fullPage: true,
              });

              const modalContent = await mainPage.evaluate(() => {
                const modal = document.querySelector(
                  '.modal-content, [class*="modal"], .g-modal'
                );
                return modal ? modal.innerHTML : "Модальное окно не найдено";
              });

              logger.debug(
                { taskKey, modalContent: modalContent.substring(0, 500) },
                "Содержимое модального окна"
              );

              await this.closeModal(mainPage);
              await sleep(1);
            }
          } catch (error) {
            logger.error(
              { taskKey, error: error.message },
              "Ошибка при обработке задачи"
            );

            const screenshotDir = path.join(process.cwd(), "debug_screenshots");
            await mainPage.screenshot({
              path: path.join(
                screenshotDir,
                `error_${taskKey}_attempt_${attempts}.png`
              ),
              fullPage: true,
            });

            await this.closeModal(mainPage);
          }
        }

        if (taskUrl) {
          tasksWithUrls.push({
            key: taskKey,
            title: taskTitle,
            url: taskUrl,
          });
          logger.info({ taskKey, taskUrl }, "URL задачи успешно получен");

          await mainPage.screenshot({
            path: path.join(
              process.cwd(),
              "debug_screenshots",
              `success_${taskKey}.png`
            ),
            fullPage: true,
          });
        } else {
          logger.error(
            { taskKey },
            "Не удалось получить URL задачи после всех попыток"
          );

          await mainPage.screenshot({
            path: path.join(
              process.cwd(),
              "debug_screenshots",
              `failed_${taskKey}.png`
            ),
            fullPage: true,
          });
        }

        await this.closeModal(mainPage);
        await sleep(1.5);
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
            await this.filterTasksBySprint(newTasks, taskTitles);
          const assignedTasks = [];

          for (const task of tasksWithUrls) {
            if (
              this.tasksTaken < CONFIG.maxTasks &&
              filteredTasks.includes(task.key)
            ) {
              const assigned = await this.handleTaskAssignment(
                task.key,
                task.title,
                task.url
              );
              if (assigned) {
                assignedTasks.push(task.title);
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
      }

      newTasks.forEach((taskKey) => this.processedTasks.add(taskKey));
    } catch (error) {
      logger.error(
        { error: error.message },
        "Критическая ошибка обработки задач"
      );

      const mainPage = this.browserManager.getPage();
      if (mainPage) {
        const screenshotDir = path.join(process.cwd(), "debug_screenshots");
        await mainPage.screenshot({
          path: path.join(screenshotDir, `critical_error_${Date.now()}.png`),
          fullPage: true,
        });
      }
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

          await sleep(3);

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
