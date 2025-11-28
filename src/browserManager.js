import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer";
import { isRunningOnHosting, getChromePath } from "./utils.js";
import CONFIG from "./config.js";
import logger from "./logger.js";
import os from "os";
import path from "path";

class BrowserManager {
  constructor() {
    this.browser = null;
    this.page = null;
    this.retryCount = 0;
    this.maxRetries = 5;
  }

  async getBrowserConfig() {
    const userDataDir = process.env.USER_DATA_DIR
      ? path.resolve(process.env.USER_DATA_DIR)
      : path.join(os.tmpdir(), "puppeteer_user_data");

    const baseConfig = {
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
        "--window-size=1920,1080",
        "--disable-extensions",
        "--disable-default-apps",
        "--disable-translate",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-breakpad",
        "--disable-client-side-phishing-detection",
        "--disable-cast",
        "--disable-cast-streaming-hw-encoding",
        "--disable-ipc-flooding-protection",
        "--disable-prompt-on-repost",
        "--disable-sync",
        "--disable-hang-monitor",
        "--metrics-recording-only",
        "--no-default-browser-check",
        "--mute-audio",
        "--ignore-certificate-errors",
        "--ignore-ssl-errors",
        "--timeout=300000",
      ],
      headless: isRunningOnHosting() ? chromium.headless : false,
      ignoreHTTPSErrors: true,
      defaultViewport: {
        width: 1920,
        height: 1080,
      },
      userDataDir: userDataDir,
    };

    if (process.platform === "win32") {
      baseConfig.args.push(
        "--disable-features=WinRetrieveSuggestionsOnlyOnDemand",
        "--disable-background-networking"
      );
    }

    if (isRunningOnHosting()) {
      return {
        ...baseConfig,
        executablePath: await chromium.executablePath(),
      };
    } else {
      return {
        ...baseConfig,
        executablePath: await getChromePath(),
      };
    }
  }

  async init() {
    try {
      logger.info("Инициализация браузера...");

      const config = await this.getBrowserConfig();

      this.browser = await puppeteer.launch(config);

      this.page = await this.browser.newPage();

      await this.page.setUserAgent(CONFIG.userAgent);
      await this.page.setExtraHTTPHeaders({
        "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
      });

      await this.page.setViewport({ width: 1920, height: 1080 });

      this.retryCount = 0;
      logger.info("Браузер успешно инициализирован");
      return true;
    } catch (error) {
      this.retryCount++;

      if (this.retryCount <= this.maxRetries) {
        logger.warn(
          { attempt: this.retryCount, error: error.message },
          "Повторная попытка инициализации браузера"
        );
        await new Promise((resolve) =>
          setTimeout(resolve, 2000 * this.retryCount)
        );
        return this.init();
      }

      logger.error(
        { error: error.message, stack: error.stack },
        "Ошибка инициализации браузера после всех попыток"
      );
      throw error;
    }
  }

  async close() {
    if (this.browser) {
      try {
        await this.browser.close();
        logger.info("Браузер закрыт");
      } catch (error) {
        logger.error({ error: error.message }, "Ошибка закрытия браузера");
      }
      this.browser = null;
      this.page = null;
    }
  }

  async openNewTab() {
    if (!this.browser) {
      throw new Error("Браузер не инициализирован");
    }

    try {
      const newPage = await this.browser.newPage();
      await newPage.setUserAgent(CONFIG.userAgent);
      await newPage.setViewport({ width: 1920, height: 1080 });
      return newPage;
    } catch (error) {
      logger.error({ error: error.message }, "Ошибка открытия новой вкладки");
      return null;
    }
  }

  async reloadPage() {
    if (!this.page) {
      throw new Error("Страница не инициализирована");
    }

    try {
      logger.debug("Перезагрузка страницы");
      await this.page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return true;
    } catch (error) {
      logger.error({ error: error.message }, "Ошибка перезагрузки страницы");
      throw error;
    }
  }

  async navigateTo(url, options = {}) {
    if (!this.page) {
      throw new Error("Страница не инициализирована");
    }

    try {
      const navigationOptions = {
        waitUntil: "networkidle0",
        timeout: 30000,
        ...options,
      };

      logger.debug({ url }, "Переход по URL");
      await this.page.goto(url, navigationOptions);

      const delay = 1000 + Math.random() * 2000;
      await new Promise((resolve) => setTimeout(resolve, delay));

      return true;
    } catch (error) {
      logger.error(
        { error: error.message, url, stack: error.stack },
        "Ошибка навигации"
      );
      throw error;
    }
  }

  getPage() {
    if (!this.page || this.page.isClosed()) return null;
    return this.page;
  }

  getBrowser() {
    return this.browser;
  }

  isInitialized() {
    return this.browser !== null && this.page !== null;
  }
}

export default BrowserManager;
