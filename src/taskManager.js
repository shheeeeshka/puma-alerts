import { sleep, checkSprintWhitelist } from "./utils.js";
import CONFIG from "./config.js";
import logger from "./logger.js";
import fs from "fs";
import path from "path";

class TaskManager {
  constructor(browserManager, notifier) {
    this.browserManager = browserManager;
    this.notifier = notifier;
    this.tasksTaken = 0;
    this.monitoringActive = false;
    this.lastTaskCount = 0;
    this.authNotificationSent = false;
    this.notifiedTasks = new Set();
    this.processingTasks = new Set();
    this.monitoringPromise = null;
    this.projectRoot = process.cwd();
    console.log("process path : ", process.cwd());
    this.screenshotsDir = path.join(this.projectRoot, "screenshots");
    this.logsDir = path.join(this.projectRoot, "logs");
    this.diagnosticHtmlPrefixes = ["task-detected_", "task-landing_"];
  }

  async ensureScreenshotsDir() {
    if (!fs.existsSync(this.screenshotsDir)) {
      fs.mkdirSync(this.screenshotsDir, { recursive: true });
    }
  }

  async ensureLogsDir() {
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }
  }

  sanitizeFilenameSegment(value) {
    return String(value || "unknown")
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80);
  }

  normalizeWidgetTitle(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  buildDiagnosticBasename(taskKey, taskTitle) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeKey = this.sanitizeFilenameSegment(taskKey);
    const safeTitle = this.sanitizeFilenameSegment(taskTitle);
    return `${timestamp}_${safeKey}_${safeTitle}`;
  }

  clearDiagnosticArtifacts() {
    for (const prefix of this.diagnosticHtmlPrefixes) {
      const files = fs
        .readdirSync(this.projectRoot, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name.startsWith(prefix) &&
            entry.name.endsWith(".html")
        );

      for (const file of files) {
        fs.rmSync(path.join(this.projectRoot, file.name), { force: true });
      }
    }

    if (fs.existsSync(this.logsDir)) {
      const logEntries = fs.readdirSync(this.logsDir, { withFileTypes: true });
      for (const entry of logEntries) {
        fs.rmSync(path.join(this.logsDir, entry.name), {
          recursive: true,
          force: true,
        });
      }
    }
  }

  async prepareDiagnosticArtifacts() {
    await this.ensureLogsDir();
    this.clearDiagnosticArtifacts();
  }

  async saveHtmlSnapshot(page, filename) {
    try {
      const html = await page.content();
      const filepath = path.join(this.projectRoot, filename);
      fs.writeFileSync(filepath, html, "utf-8");
      logger.info("HTML-снимок сохранен", { path: filepath });
      return filepath;
    } catch (error) {
      logger.error("Не удалось сохранить HTML-снимок", {
        filename,
        error: error.message,
      });
      return null;
    }
  }

  async saveLogScreenshot(page, filename) {
    try {
      await this.ensureLogsDir();
      const screenshotPath = path.join(this.logsDir, filename);
      await page.screenshot({ path: screenshotPath, type: "png", fullPage: true });
      logger.info("Диагностический скриншот сохранен", { path: screenshotPath });
      return screenshotPath;
    } catch (error) {
      logger.error("Не удалось сохранить диагностический скриншот", {
        filename,
        error: error.message,
      });
      return null;
    }
  }

  async captureTaskDetectedDiagnostics(page, basename) {
    await this.saveHtmlSnapshot(page, `task-detected_${basename}.html`);
    await this.saveLogScreenshot(page, `task-detected_${basename}.png`);
  }

  async captureTaskLandingDiagnostics(taskUrl, basename) {
    let taskPage = null;

    try {
      taskPage = await this.browserManager.openNewTab();
      if (!taskPage) {
        return;
      }

      await taskPage.goto(taskUrl, {
        waitUntil: CONFIG.navigationWaitUntil,
        timeout: CONFIG.navigationTimeoutMs,
      });
      await sleep(1.5);

      await this.saveHtmlSnapshot(taskPage, `task-landing_${basename}.html`);
      await this.saveLogScreenshot(taskPage, `task-landing_${basename}.png`);
    } catch (error) {
      logger.error("Не удалось сохранить диагностику страницы задачи", {
        taskUrl,
        error: error.message,
      });
    } finally {
      if (taskPage && !taskPage.isClosed()) {
        await taskPage.close();
      }
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
    if (this.monitoringActive) {
      logger.info("Мониторинг уже запущен");
      return;
    }

    this.monitoringActive = true;
    this.tasksTaken = 0;
    this.authNotificationSent = false;
    this.notifiedTasks.clear();
    this.processingTasks.clear();
    await this.prepareDiagnosticArtifacts();
    logger.info("Запуск мониторинга задач");
    this.monitoringPromise = this.trackTasks().finally(() => {
      this.monitoringPromise = null;
    });
  }

  async stopMonitoring() {
    this.monitoringActive = false;
    logger.info("Остановка мониторинга");
  }

  async extractTaskUrlFromModal(page, taskKey) {
    try {
      await page
        .waitForFunction(
          (taskKey) => {
            return (
              document.querySelector(".side-card") ||
              document.querySelector(".side-card-drawer__item") ||
              document.querySelector(`a[href*="/${taskKey}"]`) ||
              document.querySelector('a[href*="praktikum-admin.yandex-team.ru"]')
            );
          },
          { timeout: 8000 },
          taskKey
        )
        .catch(() => null);

      const linkInfo = await page.evaluate((taskKey) => {
        const drawer =
          document.querySelector(".side-card") ||
          document.querySelector(".side-card-drawer__item") ||
          document;

        const anchors = Array.from(drawer.querySelectorAll("a[href]")).map(
          (anchor) => ({
            href: anchor.href,
            text: anchor.textContent?.trim() || "",
          })
        );

        const assignableLink = anchors.find(
          (anchor) =>
            anchor.href.includes("praktikum-admin.yandex-team.ru") &&
            anchor.href.includes("/revisor-review/")
        );
        const trackerLink =
          anchors.find((anchor) => anchor.href.includes(`/${taskKey}`)) ||
          anchors.find((anchor) => /\/[A-Z]+-\d+$/.test(anchor.href));
        const titleElement = drawer.querySelector(
          ".issue-summary__title h1, .yc-editable-text__view_variant_header-2"
        );
        const datesElement = drawer.querySelector(".issue-dates-header");
        const timeElements = Array.from(
          drawer.querySelectorAll(".issue-dates-header time")
        );
        const statusButtons = Array.from(
          drawer.querySelectorAll(".issue-transition-pane__button")
        )
          .map((button) => button.textContent?.trim())
          .filter(Boolean);

        return {
          url: assignableLink?.href || trackerLink?.href || null,
          assignable: Boolean(assignableLink?.href),
          trackerUrl: trackerLink?.href || null,
          titleFromDrawer: titleElement?.textContent?.trim() || null,
          datesText: datesElement?.textContent?.replace(/\s+/g, " ").trim() || null,
          createdAt: timeElements[0]?.getAttribute("datetime") || null,
          updatedAt: timeElements[1]?.getAttribute("datetime") || null,
          statuses: statusButtons,
          candidates: anchors
            .filter(
              (anchor) =>
                anchor.href.includes("praktikum-admin.yandex-team.ru") ||
                anchor.href.includes(`/${taskKey}`) ||
                /\/[A-Z]+-\d+$/.test(anchor.href)
            )
            .slice(0, 10),
        };
      }, taskKey);

      if (linkInfo.url) {
        logger.info(
          {
            taskKey,
            url: linkInfo.url,
            assignable: linkInfo.assignable,
            trackerUrl: linkInfo.trackerUrl,
            createdAt: linkInfo.createdAt,
            updatedAt: linkInfo.updatedAt,
            statuses: linkInfo.statuses,
          },
          "Найдена ссылка на задачу в модальном окне"
        );
        return linkInfo;
      }

      logger.info(
        {
          taskKey,
          candidates: linkInfo.candidates,
        },
        "Не найдена подходящая ссылка в модальном окне"
      );
      return { url: null, assignable: false, candidates: linkInfo.candidates };
    } catch (error) {
      logger.error("Ошибка извлечения URL из модального окна", {
        taskKey,
        error: error.message,
      });
      console.log(error);
      console.log(error.message);
      return { url: null, assignable: false, candidates: [] };
    }
  }

  async openTaskDetails(page, taskKey) {
    const taskClicked = await page.evaluate((taskKey) => {
      const row = document.querySelector(`tr[data-key="${taskKey}"]`);
      if (!row) {
        return false;
      }

      const clickableElement =
        row.querySelector(`a[href*="/browse/${taskKey}"]`) ||
        row.querySelector('a[href*="/browse/"]') ||
        row.querySelector(".edit-cell__text") ||
        row;

      clickableElement.click();
      return true;
    }, taskKey);

    if (!taskClicked) {
      return false;
    }

    await page
      .waitForFunction(
        (taskKey) => {
          return (
            document.querySelector(".side-card") ||
            document.querySelector(".side-card-drawer__item") ||
            document.querySelector(`a[href*="/${taskKey}"]`) ||
            document.querySelector('a[href*="praktikum-admin.yandex-team.ru"]')
          );
        },
        { timeout: 5000 },
        taskKey
      )
      .catch(() => null);

    return true;
  }

  async clickTakeButton(taskPage) {
    await taskPage
      .waitForFunction(
        () => {
          const buttons = Array.from(document.querySelectorAll("button"));
          return buttons.some((button) => {
            const text = button.textContent?.replace(/\s+/g, " ").trim() || "";
            return (
              button.offsetParent !== null &&
              !button.disabled &&
              (text.includes("Взять в работу") ||
                text.includes("Взять") ||
                button.matches(
                  '.review-header__button-take, .prisma-button2_view_primary, [data-testid="take-button"]'
                ))
            );
          });
        },
        { timeout: 2500 }
      )
      .catch(() => null);

    const selectorCandidates = [
      "button.review-header__button-take",
      ".review-header__actions button",
      "button.prisma-button2_view_primary",
      '[data-testid="take-button"]',
    ];

    for (const selector of selectorCandidates) {
      const handle = await taskPage.$(selector);
      if (!handle) {
        continue;
      }

      const buttonMeta = await handle.evaluate((button) => {
        const text = button.textContent?.replace(/\s+/g, " ").trim() || "";
        return {
          text,
          visible: button.offsetParent !== null,
          disabled: button.disabled,
        };
      });

      if (
        buttonMeta.visible &&
        !buttonMeta.disabled &&
        (buttonMeta.text.includes("Взять в работу") ||
          buttonMeta.text.includes("Взять"))
      ) {
        try {
          await handle.click({ delay: 40 });
          logger.info(
            { selector, buttonText: buttonMeta.text },
            "Кнопка взятия нажата через Puppeteer click"
          );
          await handle.dispose();
          return true;
        } catch (error) {
          logger.warn(
            { selector, error: error.message, buttonText: buttonMeta.text },
            "Puppeteer click не удался, пробуем fallback"
          );
        }
      }

      await handle.dispose();
    }

    const clickResult = await taskPage.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const targetButton = buttons.find((button) => {
        const text = button.textContent?.replace(/\s+/g, " ").trim() || "";
        return (
          button.offsetParent !== null &&
          !button.disabled &&
          (text.includes("Взять в работу") ||
            text.includes("Взять") ||
            button.matches(
              '.review-header__button-take, .prisma-button2_view_primary, [data-testid="take-button"]'
            ))
        );
      });

      if (!targetButton) {
        return { clicked: false, buttonText: null };
      }

      targetButton.click();
      return {
        clicked: true,
        buttonText: targetButton.textContent?.replace(/\s+/g, " ").trim() || "",
      };
    });

    logger.info(clickResult, "Результат fallback-клика по кнопке взятия");
    return clickResult.clicked;
  }

  async waitForTaskPageReady(taskPage) {
    await taskPage
      .waitForFunction(
        () => {
          return (
            document.querySelector(".review-header") ||
            document.querySelector(".review") ||
            document.querySelector(".review-header__button-take") ||
            document.querySelector(".page_name_issue") ||
            document.querySelector(".issue-summary__title") ||
            document.querySelector(".page-issue__wrapper")
          );
        },
        { timeout: 5000 }
      )
      .catch(() => null);
  }

  async readTaskPageState(taskPage) {
    try {
      await this.waitForTaskPageReady(taskPage);

      return await taskPage.evaluate(() => {
        const normalize = (value) =>
          String(value || "")
            .replace(/\s+/g, " ")
            .trim();

        const isPraktikumPage = Boolean(
          document.querySelector(".review-header") ||
            document.querySelector(".review")
        );

        const getFieldValue = (title) => {
          const fields = Array.from(document.querySelectorAll(".FieldView"));
          const field = fields.find((item) => {
            const fieldTitle = normalize(
              item.querySelector(".FieldView-Title")?.textContent
            );
            return fieldTitle === title;
          });

          return normalize(
            field?.querySelector(".FieldView-Value")?.textContent || ""
          );
        };

        const buttons = Array.from(document.querySelectorAll("button"));
        const visibleButtons = buttons.filter((button) => button.offsetParent !== null);

        const hasTakeButton = visibleButtons.some((button) => {
          const text = normalize(button.textContent);
          return text.includes("Взять в работу") || text.includes("Взять");
        });

        const hasGradeButton = visibleButtons.some((button) => {
          const text = normalize(button.textContent);
          return text.includes("Оценить проект");
        });

        const reviewStatusElement = document.querySelector(
          ".review-header__review-status"
        );
        const reviewStatusClass = normalize(reviewStatusElement?.className);
        const reviewStatusText = normalize(reviewStatusElement?.textContent);
        const reviewTabs = Array.from(
          document.querySelectorAll(".review__tab-item .tab__text")
        ).map((tab) => normalize(tab.textContent));
        const actionsButtons = Array.from(
          document.querySelectorAll(".review-header__actions button")
        ).filter((button) => button.offsetParent !== null);
        const hasHistoryTab = reviewTabs.includes("История");
        const isReviewingStatus =
          reviewStatusClass.includes("status_reviewing") ||
          reviewStatusText.includes("Проект на проверке");
        const isUploadedStatus =
          reviewStatusClass.includes("status_new") ||
          reviewStatusText.includes("Загрузил работу");

        return {
          pageLoaded: Boolean(
            document.querySelector(".review-header") ||
              document.querySelector(".review") ||
            document.querySelector(".page_name_issue") ||
              document.querySelector(".issue-summary__title") ||
              document.querySelector(".page-issue__wrapper")
          ),
          pageType: isPraktikumPage ? "praktikum" : "tracker",
          issueKey: normalize(
            document.querySelector(
              ".page-issue__issue-key a, .g-breadcrumbs__link_is-current"
            )?.textContent
          ),
          title: normalize(
            document.querySelector(
              ".issue-summary__title h1, .yc-editable-text__view_variant_header-2, .review-task-section h1"
            )?.textContent
          ),
          datesText: normalize(
            document.querySelector(
              ".issue-dates-header, .review-header__review-status"
            )?.textContent
          ),
          createdAt:
            document
              .querySelectorAll(".issue-dates-header time")?.[0]
              ?.getAttribute("datetime") || null,
          updatedAt:
            document
              .querySelectorAll(".issue-dates-header time")?.[1]
              ?.getAttribute("datetime") || null,
          status: isPraktikumPage
            ? normalize(
                document.querySelector(".review-header__review-status")
                  ?.textContent
              )
            : getFieldValue("Статус"),
          assignee: isPraktikumPage
            ? normalize(document.querySelector(".review-header__author-name strong")?.textContent)
            : getFieldValue("Исполнитель"),
          hasTakeButton,
          hasGradeButton,
          reviewStatusClass,
          reviewTabs,
          hasHistoryTab,
          actionsButtonsCount: actionsButtons.length,
          actionsEmpty: isPraktikumPage && actionsButtons.length === 0,
          isReviewingStatus,
          isUploadedStatus,
        };
      });
    } catch (error) {
      logger.error("Не удалось прочитать состояние страницы задачи", {
        error: error.message,
      });
      return {
        pageLoaded: false,
        pageType: "",
        issueKey: "",
        title: "",
        datesText: "",
        createdAt: null,
        updatedAt: null,
        status: "",
        assignee: "",
        hasTakeButton: false,
        hasGradeButton: false,
        reviewStatusClass: "",
        reviewTabs: [],
        hasHistoryTab: false,
        actionsButtonsCount: 0,
        actionsEmpty: false,
        isReviewingStatus: false,
        isUploadedStatus: false,
      };
    }
  }

  async verifyTaskAssignment(taskPage) {
    try {
      if (taskPage.isClosed()) {
        logger.error("Страница задачи была закрыта");
        return false;
      }

      const state = await this.readTaskPageState(taskPage);
      logger.info("Проверено состояние страницы после взятия", {
        pageType: state.pageType,
        issueKey: state.issueKey,
        status: state.status,
        assignee: state.assignee,
        hasTakeButton: state.hasTakeButton,
        hasGradeButton: state.hasGradeButton,
        reviewStatusClass: state.reviewStatusClass,
        hasHistoryTab: state.hasHistoryTab,
        actionsButtonsCount: state.actionsButtonsCount,
        actionsEmpty: state.actionsEmpty,
        isReviewingStatus: state.isReviewingStatus,
        isUploadedStatus: state.isUploadedStatus,
      });

      if (state.pageType === "praktikum") {
        const assignedSignals = {
          hasGradeButton: state.hasGradeButton,
          noTakeButton: !state.hasTakeButton,
          reviewingStatus: state.isReviewingStatus,
          historyTab: state.hasHistoryTab,
          actionsEmpty: state.actionsEmpty,
        };

        logger.info(assignedSignals, "Сигналы успешного взятия задачи");

        return (
          state.hasGradeButton ||
          (!state.hasTakeButton &&
            (state.isReviewingStatus ||
              state.hasHistoryTab ||
              state.actionsEmpty))
        );
      }

      return state.hasGradeButton || !state.hasTakeButton;
    } catch (error) {
      logger.error("Ошибка проверки назначения задачи");
      console.error(error);
      return false;
    }
  }

  async takeTaskOnPraktikumPage(taskUrl) {
    try {
      logger.info("Попытка взять задачу через UI");
      const taskPage = await this.browserManager.openNewTab();
      try {
        await taskPage.goto(taskUrl, {
          waitUntil: "domcontentloaded",
          timeout: 9000,
        });

        await this.waitForTaskPageReady(taskPage);
        await sleep(0.5);

        const initialState = await this.readTaskPageState(taskPage);
        logger.info("Состояние страницы задачи до попытки взятия", {
          pageType: initialState.pageType,
          issueKey: initialState.issueKey,
          status: initialState.status,
          assignee: initialState.assignee,
          hasTakeButton: initialState.hasTakeButton,
          hasGradeButton: initialState.hasGradeButton,
          reviewStatusClass: initialState.reviewStatusClass,
          hasHistoryTab: initialState.hasHistoryTab,
          actionsButtonsCount: initialState.actionsButtonsCount,
          actionsEmpty: initialState.actionsEmpty,
        });

        if (!initialState.hasTakeButton) {
          logger.info("Кнопка 'Взять' недоступна на странице задачи", {
            issueKey: initialState.issueKey,
            status: initialState.status,
            assignee: initialState.assignee,
          });
          return { success: initialState.hasGradeButton };
        }

        let isAssigned = false;

        for (let attempt = 1; attempt <= 3; attempt++) {
          logger.info(
            { attempt, issueKey: initialState.issueKey, taskUrl },
            "Попытка нажать кнопку взятия"
          );

          const buttonClicked = await this.clickTakeButton(taskPage);
          if (!buttonClicked) {
            logger.warn(
              { attempt, issueKey: initialState.issueKey },
              "Кнопка взятия не была нажата"
            );
            continue;
          }

          await taskPage
            .waitForFunction(
              () => {
                const normalize = (value) =>
                  String(value || "")
                    .replace(/\s+/g, " ")
                    .trim();
                const buttons = Array.from(document.querySelectorAll("button"));
                const visibleButtons = buttons.filter(
                  (button) => button.offsetParent !== null
                );
                const hasTakeButton = visibleButtons.some((button) => {
                  const text =
                    button.textContent?.replace(/\s+/g, " ").trim() || "";
                  return (
                    !button.disabled &&
                    text.includes("Взять")
                  );
                });
                const hasGradeButton = visibleButtons.some((button) =>
                  normalize(button.textContent).includes("Оценить проект")
                );
                const reviewStatusElement = document.querySelector(
                  ".review-header__review-status"
                );
                const reviewStatusClass = normalize(
                  reviewStatusElement?.className
                );
                const reviewStatusText = normalize(
                  reviewStatusElement?.textContent
                );
                const hasHistoryTab = Array.from(
                  document.querySelectorAll(".review__tab-item .tab__text")
                ).some((tab) => normalize(tab.textContent) === "История");
                const visibleActionButtons = Array.from(
                  document.querySelectorAll(".review-header__actions button")
                ).filter((button) => button.offsetParent !== null);
                const isReviewingStatus =
                  reviewStatusClass.includes("status_reviewing") ||
                  reviewStatusText.includes("Проект на проверке");

                return (
                  hasGradeButton ||
                  (!hasTakeButton &&
                    (isReviewingStatus ||
                      hasHistoryTab ||
                      visibleActionButtons.length === 0))
                );
              },
              { timeout: 5000 }
            )
            .catch(() => null);

          await sleep(0.5);

          const currentState = await this.readTaskPageState(taskPage);
          logger.info(
            {
              attempt,
              issueKey: currentState.issueKey,
              status: currentState.status,
              assignee: currentState.assignee,
              hasTakeButton: currentState.hasTakeButton,
              hasGradeButton: currentState.hasGradeButton,
              reviewStatusClass: currentState.reviewStatusClass,
              hasHistoryTab: currentState.hasHistoryTab,
              actionsButtonsCount: currentState.actionsButtonsCount,
              actionsEmpty: currentState.actionsEmpty,
              isReviewingStatus: currentState.isReviewingStatus,
              isUploadedStatus: currentState.isUploadedStatus,
            },
            "Состояние страницы после попытки клика"
          );

          isAssigned = await this.verifyTaskAssignment(taskPage);
          if (isAssigned) {
            break;
          }
        }

        if (!isAssigned) {
          const finalState = await this.readTaskPageState(taskPage);
          logger.warn(
            {
              issueKey: finalState.issueKey,
              status: finalState.status,
              hasTakeButton: finalState.hasTakeButton,
              hasGradeButton: finalState.hasGradeButton,
              reviewStatusClass: finalState.reviewStatusClass,
              hasHistoryTab: finalState.hasHistoryTab,
              actionsButtonsCount: finalState.actionsButtonsCount,
              actionsEmpty: finalState.actionsEmpty,
            },
            "Не удалось подтвердить взятие задачи после всех попыток"
          );
        }

        await this.takeScreenshot(taskPage, "assign_attempt");
        return { success: isAssigned };
      } finally {
        await taskPage.close();
      }
    } catch (error) {
      logger.error("Task taking failed", { error: error.message });
      return { success: false };
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
      const { success } = await this.takeTaskOnPraktikumPage(taskUrl);
      if (success) {
        this.tasksTaken++;
        await this.notifier.sendText(
          `✅ Задача взята\n${taskTitle}\nВзято: ${this.tasksTaken}/${CONFIG.maxTasks}`
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

  async getTasksFromConfiguredWidget() {
    const page = this.browserManager.getPage();
    if (!page) throw new Error("Страница не доступна");

    try {
      await this.browserManager.reloadPage();
      await sleep(1.5);

      const normalizedTargetTitle = this.normalizeWidgetTitle(
        CONFIG.taskWidgetTitle
      );

      const result = await page.evaluate((normalizedTargetTitle) => {
        const normalizeTitle = (value) =>
          String(value || "")
            .normalize("NFKC")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();

        const widgets = Array.from(document.querySelectorAll(".filter-widget"));
        const widget = widgets.find((candidate) => {
          const titleElement = candidate.querySelector(
            ".collapse-widget-header__title-item_primary"
          );
          const titleText = titleElement?.textContent || "";
          return normalizeTitle(titleText).includes(normalizedTargetTitle);
        });

        if (!widget) {
          return {
            taskKeys: [],
            taskTitles: {},
            taskCount: 0,
            widgetFound: false,
          };
        }

        const taskTable = widget.querySelector("table.gt-table");
        if (!taskTable) {
          return {
            taskKeys: [],
            taskTitles: {},
            taskCount: 0,
            widgetFound: true,
          };
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
          taskKeys: tasks,
          taskTitles,
          taskCount: tasks.length,
          widgetFound: true,
        };
      }, normalizedTargetTitle);

      if (!result.widgetFound) {
        logger.warn("Целевая карточка не найдена", {
          widgetTitle: CONFIG.taskWidgetTitle,
        });
      }

      if (result.taskKeys.length > 0) {
        logger.info("Найдены задачи", {
          widgetTitle: CONFIG.taskWidgetTitle,
          taskCount: result.taskKeys.length,
          tasks: result.taskKeys,
        });
      }

      return {
        normalTaskKeys: result.taskKeys,
        taskTitles: result.taskTitles,
        taskCount: result.taskCount,
      };
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
        const diagnosticBasename = this.buildDiagnosticBasename(
          taskKey,
          taskTitle
        );
        logger.info("Клик по задаче для открытия модального окна", { taskKey });

        const taskClicked = await this.openTaskDetails(mainPage, taskKey);

        if (taskClicked) {
          await sleep(1.4);
          await this.captureTaskDetectedDiagnostics(
            mainPage,
            diagnosticBasename
          );

          const linkInfo = await this.extractTaskUrlFromModal(mainPage, taskKey);
          if (linkInfo.url) {
            tasksWithUrls.push({
              key: taskKey,
              title: linkInfo.titleFromDrawer || taskTitle,
              url: linkInfo.url,
              trackerUrl: linkInfo.trackerUrl,
              assignable: linkInfo.assignable,
              createdAt: linkInfo.createdAt,
              updatedAt: linkInfo.updatedAt,
              datesText: linkInfo.datesText,
              statuses: linkInfo.statuses,
            });
            await this.captureTaskLandingDiagnostics(
              linkInfo.url,
              diagnosticBasename
            );
          } else {
            logger.info("Не удалось получить URL для задачи", { taskKey });
            tasksWithUrls.push({
              key: taskKey,
              title: taskTitle,
              url: null,
              trackerUrl: null,
              assignable: false,
              createdAt: null,
              updatedAt: null,
              datesText: null,
              statuses: [],
            });
          }

          this.notifiedTasks.add(taskKey);
        } else {
          logger.info("Не удалось кликнуть по задаче", { taskKey });
        }
      }

      if (tasksWithUrls.length > 0) {
        const tasksList = tasksWithUrls
          .map((task) =>
            task.url
              ? `<a href="${task.url}">${task.title}</a>`
              : `${task.title} (ссылка не извлечена, сохранена диагностика)`
          )
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
          const assignmentTitles = Object.fromEntries(
            tasksWithUrls.map((task) => [
              task.key,
              task.title || taskTitles[task.key] || task.key,
            ])
          );
          const { filteredTasks } = await this.filterTasksBySprint(
            tasksWithUrls.map((task) => task.key),
            assignmentTitles
          );
          const tasksToAssign = tasksWithUrls.filter((task) =>
            filteredTasks.includes(task.key) && task.assignable
          );

          logger.info(
            {
              count: tasksToAssign.length,
              tasks: tasksToAssign.map((t) => ({
                key: t.key,
                title: t.title,
                assignable: t.assignable,
              })),
            },
            "Задачи для автозабора"
          );
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
      try {
        await this.browserManager.navigateTo(CONFIG.targetBoardUrl);
      } catch (error) {
        logger.warn(
          { error: error.message },
          "Не удалось открыть доску с первой попытки, пробуем восстановить браузер"
        );

        const recovered = await this.recoverBrowser();
        if (!recovered) {
          throw error;
        }
      }

      const isAuthenticated = await this.checkAuth();
      if (!isAuthenticated) {
        await sleep(60);
        await this.recoverBrowser();
      }

      const { normalTaskKeys, taskTitles, taskCount } =
        await this.getTasksFromConfiguredWidget();
      this.lastTaskCount = taskCount;
      await this.processTasks(normalTaskKeys, taskTitles, true);

      let prevTasks = normalTaskKeys;
      await this.notifier.sendText(
        `🚀 Мониторинг начат\nАвтозабор: ${
          CONFIG.autoAssign ? "вкл" : "выкл"
        }\nЛимит задач: ${CONFIG.maxTasks}\nЗадач в секции: ${taskCount}`
      );

      while (this.monitoringActive) {
        try {
          const {
            normalTaskKeys: currentTasks,
            taskTitles: currentTitles,
            taskCount: currentCount,
          } = await this.getTasksFromConfiguredWidget();

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
      this.monitoringActive = false;
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
