import logger from "./logger.js";
import fs from "fs";
import path from "path";

class HttpTaskService {
  constructor(browserManager) {
    this.browserManager = browserManager;
    this.debugDir = path.join(process.cwd(), "debug_logs");
  }

  async ensureDebugDir() {
    if (!fs.existsSync(this.debugDir)) {
      fs.mkdirSync(this.debugDir, { recursive: true });
    }
  }

  async saveDebugData(filename, data) {
    await this.ensureDebugDir();
    const filePath = path.join(this.debugDir, filename);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return filePath;
  }

  extractTaskParams(taskUrl) {
    const url = new URL(taskUrl);
    const pathParts = url.pathname.split("/");
    const homeworkId = pathParts[pathParts.length - 2];
    const secret = pathParts[pathParts.length - 1];
    return { homeworkId, secret };
  }

  async getAuthData() {
    const page = this.browserManager.getPage();
    if (!page) throw new Error("Page unavailable");

    const currentUrl = await page.url();

    await page.goto("https://praktikum-admin.yandex-team.ru", {
      waitUntil: "domcontentloaded",
      timeout: 10000,
    });

    await sleep(2);

    const storageData = await page.evaluate(() => {
      const getStorageData = (storage) => {
        const data = {};
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          data[key] = storage.getItem(key);
        }
        return data;
      };

      return {
        localStorage: getStorageData(localStorage),
        sessionStorage: getStorageData(sessionStorage),
        cookies: document.cookie,
        url: window.location.href,
        userAgent: navigator.userAgent,
      };
    });

    await page.goto(currentUrl, {
      waitUntil: "domcontentloaded",
      timeout: 10000,
    });

    const debugFile = await this.saveDebugData(
      `storage_${Date.now()}.json`,
      storageData
    );
    logger.debug("Storage data saved", { file: debugFile });

    let authToken = storageData.localStorage["AUTH_TOKEN"];

    if (!authToken) {
      for (const [key, value] of Object.entries(storageData.localStorage)) {
        if (value && typeof value === "string" && value.startsWith("eyJ")) {
          authToken = value;
          logger.debug("Found authToken in localStorage", { key });
          break;
        }
      }
    }

    if (!authToken) {
      for (const [key, value] of Object.entries(storageData.sessionStorage)) {
        if (value && typeof value === "string" && value.startsWith("eyJ")) {
          authToken = value;
          logger.debug("Found authToken in sessionStorage", { key });
          break;
        }
      }
    }

    if (!authToken) {
      throw new Error("Valid AuthToken not found in storage");
    }

    return {
      authToken,
      cookies: storageData.cookies,
      url: storageData.url,
    };
  }

  async createRequestContext(taskUrl) {
    const { authToken, cookies } = await this.getAuthData();

    const headers = {
      "x-authtoken": authToken,
      accept: "application/json",
      "content-type": "application/json",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      referer: taskUrl,
      cookie: cookies,
    };

    await this.saveDebugData(`headers_${Date.now()}.json`, {
      headers,
      taskUrl,
      timestamp: new Date().toISOString(),
    });

    return { headers };
  }

  async checkNetworkAvailability() {
    const testUrls = [
      "https://admin.praktikum.yandex-team.ru",
      "https://praktikum-admin.yandex-team.ru",
      "https://ya.ru",
    ];

    for (const testUrl of testUrls) {
      try {
        logger.debug("Testing network connectivity", { url: testUrl });
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const response = await fetch(testUrl, {
          method: "HEAD",
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.status < 400) {
          logger.debug("Network connectivity confirmed", { url: testUrl });
          return true;
        }
      } catch (error) {
        logger.warn("Network test failed", {
          url: testUrl,
          error: error.message,
        });
      }
    }

    logger.error("All network connectivity tests failed");
    return false;
  }

  async takeTask(taskUrl) {
    let debugData = {
      taskUrl,
      timestamp: new Date().toISOString(),
      steps: [],
      networkAvailable: null,
    };

    try {
      debugData.steps.push({
        step: "start",
        timestamp: new Date().toISOString(),
      });

      debugData.steps.push({
        step: "network_check",
        timestamp: new Date().toISOString(),
      });

      const networkAvailable = await this.checkNetworkAvailability();
      if (!networkAvailable) {
        throw new Error("Network unavailable - cannot make HTTP requests");
      }

      debugData.networkAvailable = true;

      const { homeworkId, secret } = this.extractTaskParams(taskUrl);
      debugData.taskParams = { homeworkId, secret };

      const { headers } = await this.createRequestContext(taskUrl);
      debugData.headers = headers;

      const startReviewUrl = `https://admin.praktikum.yandex-team.ru/api/revisor/${homeworkId}/start_review/?secret=${secret}`;
      debugData.requestUrl = startReviewUrl;

      debugData.steps.push({
        step: "sending_request",
        timestamp: new Date().toISOString(),
      });

      const response = await fetch(startReviewUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });

      debugData.response = {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
      };

      debugData.steps.push({
        step: "response_received",
        timestamp: new Date().toISOString(),
        success: response.status === 201,
      });

      if (response.status === 201) {
        logger.info("Task taken via HTTP", { homeworkId });
        return true;
      }

      try {
        const responseBody = await response.text();
        debugData.response.body = responseBody;
      } catch (e) {
        debugData.response.bodyError = e.message;
      }

      logger.warn(
        `HTTP task taking failed with status ${response.status} ${response.statusText}`,
        {
          status: response.status,
          statusText: response.statusText,
        }
      );
      return false;
    } catch (error) {
      debugData.steps.push({
        step: "error",
        timestamp: new Date().toISOString(),
        error: error.message,
      });
      debugData.error = error.message;

      logger.error("HTTP task taking failed", { error: error.message });
      return false;
    } finally {
      await this.saveDebugData(`http_request_${Date.now()}.json`, debugData);
    }
  }
}

export default HttpTaskService;
