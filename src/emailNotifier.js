import mailService from "./mailService.js";

class EmailNotifier {
  constructor() {
    this.name = "email";
  }

  async sendText(message) {
    await mailService.sendTextNotification(message);
  }
}

export default EmailNotifier;
