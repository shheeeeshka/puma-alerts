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

    const debugFile = await this.saveDebugData(
      `storage_${Date.now()}.json`,
      storageData
    );
    logger.debug("Storage data saved", { file: debugFile });

    if (!storageData.authToken || !storageData.authToken.startsWith("eyJ")) {
      throw new Error("Valid AuthToken not found in sessionStorage");
    }

    return storageData;
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

  async takeTask(taskUrl) {
    let debugData = {
      taskUrl,
      timestamp: new Date().toISOString(),
      steps: [],
    };

    try {
      debugData.steps.push({
        step: "start",
        timestamp: new Date().toISOString(),
      });

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
