import { chromium } from "playwright";
import assert from "node:assert/strict";

const baseUrl = process.env.CONSOLE_URL;
const username = process.env.CONSOLE_USERNAME;
const password = process.env.CONSOLE_PASSWORD;
assert.ok(
  baseUrl && username && password,
  "Console acceptance credentials required",
);

const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_EXECUTABLE_PATH
    ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH }
    : {}),
});
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await Promise.race([
    page.getByRole("heading", { name: "运行概览" }).waitFor(),
    page
      .locator(".login .error")
      .waitFor()
      .then(async () => {
        throw new Error(
          `Console login failed: ${await page.locator(".login .error").innerText()}`,
        );
      }),
  ]);
  const pages = [
    "系统助手",
    "机器人",
    "通道",
    "消息",
    "上下文",
    "模型",
    "能力",
    "执行",
    "调度",
    "资源",
    "浏览器",
    "治理",
    "账号",
    "系统设置",
  ];
  for (const name of pages) {
    await page.getByRole("button", { name }).click();
    await page.waitForTimeout(150);
    if (name === "账号")
      await page.getByText(username, { exact: true }).first().waitFor();
    if (name === "系统助手") {
      await page.getByText("零工具权限", { exact: false }).waitFor();
      await page
        .getByLabel("向系统助手提问")
        .fill("当前平台有哪些已配置的中心能力？");
      await page.getByRole("button", { name: "发送" }).click();
      await page
        .locator(".assistant-message.assistant")
        .nth(1)
        .waitFor({ timeout: 90000 });
      await page.screenshot({
        path: "/tmp/qft-console-system-assistant.png",
        fullPage: true,
      });
    }
    if (name === "机器人") {
      await page.getByRole("heading", { name: "机器人运行配置" }).waitFor();
      assert.equal(
        await page.locator('option[value="openai-agents"]').count(),
        1,
      );
    }
    if (name === "通道") {
      await page.getByRole("heading", { name: "通道类型" }).waitFor();
      await page.getByRole("heading", { name: "通道账号" }).waitFor();
      await page.getByLabel("App ID").waitFor();
      assert.equal(
        await page.getByLabel("App Secret").getAttribute("type"),
        "password",
      );
    }
    if (name === "模型") {
      assert.equal(
        await page.getByPlaceholder("API Key（加密保存）").getAttribute("type"),
        "password",
      );
    }
    if (name === "能力") {
      await page.getByRole("heading", { name: "Capability Builder" }).waitFor();
      await page.getByRole("button", { name: "预检" }).click();
      await page.getByText("预检通过", { exact: false }).waitFor();
      await page.screenshot({
        path: "/tmp/qft-console-capability-builder.png",
        fullPage: true,
      });
    }
    if (name === "调度" && (await page.getByTitle("运行日志").count())) {
      await page.getByTitle("运行日志").first().click();
      await page.getByRole("dialog").waitFor();
      await page.getByTitle("关闭").click();
    }
    if (name === "资源") {
      await page.getByRole("heading", { name: "空间与完整性" }).waitFor();
      await page.getByRole("button", { name: "检查完整性" }).waitFor();
      await page.getByRole("heading", { name: "Bot 访问授权" }).waitFor();
    }
    if (name === "系统设置") {
      await page.getByRole("heading", { name: "配置迁移" }).waitFor();
      await page.getByRole("button", { name: "导出配置" }).waitFor();
      const configurationCheck = await page.evaluate(async () => {
        const exported = await fetch("/api/config/export?tenantId=default"),
          bundle = await exported.json(),
          preview = await fetch("/api/config/import/preview", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ bundle }),
          }),
          result = await preview.json();
        return {
          exportStatus: exported.status,
          previewStatus: preview.status,
          schemaVersion: bundle.schemaVersion,
          secretsIncluded: bundle.secrets?.included,
          valid: result.data?.valid,
        };
      });
      assert.deepEqual(configurationCheck, {
        exportStatus: 200,
        previewStatus: 200,
        schemaVersion: "quarkfantools.config.v1",
        secretsIncluded: false,
        valid: true,
      });
      await page.screenshot({
        path: "/tmp/qft-console-settings.png",
        fullPage: true,
      });
    }
    assert.equal(
      await page
        .locator("body")
        .evaluate((body) => body.scrollWidth <= innerWidth),
      true,
      `${name} desktop overflow`,
    );
  }
  const sensitiveBoundary = await page.evaluate(async () => {
    const response = await fetch(
      "/api/center/governance/v1/credentials/not-a-real-id/resolve",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    return { status: response.status, body: await response.json() };
  });
  assert.equal(sensitiveBoundary.status, 403);
  assert.equal(sensitiveBoundary.body.error.code, "SENSITIVE_PATH_REJECTED");
  await page.getByRole("button", { name: "通道" }).click();
  await page.getByRole("heading", { name: "新增飞书通道" }).waitFor();
  await page.screenshot({
    path: "/tmp/qft-console-desktop.png",
    fullPage: true,
  });

  await page.getByRole("button", { name: "资源" }).click();
  await page.getByRole("heading", { name: "空间与完整性" }).waitFor();
  await page.screenshot({
    path: "/tmp/qft-console-resource-desktop.png",
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(
    await page
      .locator("body")
      .evaluate((body) => body.scrollWidth <= innerWidth),
    true,
    "mobile overflow",
  );
  await page.screenshot({
    path: "/tmp/qft-console-mobile.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, pages: pages.length + 1 }));
} finally {
  await browser.close();
}
