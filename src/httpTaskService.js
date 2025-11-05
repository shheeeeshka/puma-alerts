import logger from "./logger.js";

class HttpTaskService {
  constructor(browserManager) {
    this.browserManager = browserManager;
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

    const storageData = await page.evaluate(() => ({
      authToken: sessionStorage.getItem("AuthToken"),
      cookies: document.cookie,
    }));

    if (!storageData.authToken || !storageData.authToken.startsWith("eyJ")) {
      throw new Error("Valid AuthToken not found in sessionStorage");
    }

    return storageData;
  }

  async createRequestContext(taskUrl) {
    const { authToken, cookies } = await this.getAuthData();

    return {
      headers: {
        "x-authtoken": authToken,
        accept: "application/json",
        "content-type": "application/json",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        referer: taskUrl,
        cookie: cookies,
      },
    };
  }

  async takeTask(taskUrl) {
    try {
      const { homeworkId, secret } = this.extractTaskParams(taskUrl);
      const { headers } = await this.createRequestContext(taskUrl);

      const startReviewUrl = `https://admin.praktikum.yandex-team.ru/api/revisor/${homeworkId}/start_review/?secret=${secret}`;

      const response = await fetch(startReviewUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });

      if (response.status === 201) {
        logger.info("Task taken via HTTP", { homeworkId });
        return true;
      }

      logger.warn("HTTP task taking failed", { status: response.status });
      return false;
    } catch (error) {
      logger.error("HTTP task taking failed", { error: error.message });
      return false;
    }
  }
}

export default HttpTaskService;
