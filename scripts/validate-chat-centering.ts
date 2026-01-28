#!/usr/bin/env bun
import { chromium } from "playwright";

const url = process.env.CENTER_CHECK_URL ?? "http://127.0.0.1:8080/";
const viewportWidth = Number(process.env.CENTER_CHECK_WIDTH ?? "1440");
const viewportHeight = Number(process.env.CENTER_CHECK_HEIGHT ?? "900");
const threshold = Number(process.env.CENTER_CHECK_THRESHOLD ?? "2");

const targets = [
  { name: "banner-title", selector: "#chat .chat-banner-wrapper .chat-chrome-centered h1" },
  { name: "chat-nav", selector: "#chat #chat-nav-sticky .chat-chrome-centered [role='tablist']" },
  { name: "chat-messages", selector: "#chat-messages-desktop" },
  { name: "chat-input-wrapper", selector: "#chat .chat-input-wrapper" },
  { name: "chat-input-textarea", selector: "#chat .chat-desktop-container textarea#chat-input-desktop" },
];

const maxAlpha = Number(process.env.CENTER_CHECK_MAX_ALPHA ?? "0.45");
const styleChecks = [
  { name: "nav-shared-bg", selector: "#desktop-nav-shared" },
  { name: "chat-nav-bg", selector: "#chat-nav-sticky" },
  { name: "chat-input-bg", selector: ".chat-input-wrapper" },
];

type MeasuredItem = {
  name: string;
  selector: string;
  top?: number;
  left?: number;
  width?: number;
  height?: number;
  centerX?: number;
  found: boolean;
};

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: viewportWidth, height: viewportHeight },
});

try {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector("#chat-messages-desktop", { timeout: 10000 });

  const results = await page.evaluate(({ selectors, styles }) => {
    const sidebar = document.querySelector("#conversation-sidebar");
    const sidebarRect = sidebar?.getBoundingClientRect();
    const sidebarWidth = sidebarRect?.width ?? 0;
    const viewportWidth = window.innerWidth;
    const contentLeft = sidebarWidth;
    const contentWidth = Math.max(0, viewportWidth - sidebarWidth);
    const contentCenter = contentLeft + contentWidth / 2;

    const items = selectors.map((item: MeasuredItem) => {
      const el = document.querySelector(item.selector);
      if (!el) {
        return { ...item, found: false };
      }
      const rect = el.getBoundingClientRect();
      return {
        ...item,
        found: true,
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        centerX: rect.left + rect.width / 2,
      };
    });

    const bgChecks = styles.map((item) => {
      const el = document.querySelector(item.selector);
      if (!el) {
        return { ...item, found: false };
      }
      const style = window.getComputedStyle(el);
      return {
        ...item,
        found: true,
        backgroundColor: style.backgroundColor,
      };
    });

    return {
      viewport: { width: viewportWidth, height: window.innerHeight },
      sidebarWidth,
      contentCenter,
      items,
      bgChecks,
    };
  }, { selectors: targets, styles: styleChecks });

  console.log(`URL: ${url}`);
  console.log(`Viewport: ${results.viewport.width}x${results.viewport.height}`);
  console.log(`Sidebar width: ${results.sidebarWidth}px`);
  console.log(`Content center X: ${results.contentCenter.toFixed(2)}px`);
  console.log(`Threshold: ${threshold}px`);
  console.log("");

  let failed = false;
  for (const item of results.items) {
    if (!item.found || item.centerX === undefined) {
      failed = true;
      console.log(`[MISSING] ${item.name} (${item.selector})`);
      continue;
    }
    const delta = Math.abs(item.centerX - results.contentCenter);
    const status = delta <= threshold ? "OK" : "OFF";
    if (status === "OFF") failed = true;
    console.log(
      `[${status}] ${item.name} centerX=${item.centerX.toFixed(2)}px ` +
        `delta=${delta.toFixed(2)}px left=${item.left?.toFixed(2)}px width=${item.width?.toFixed(2)}px`
    );
  }

  const rgbaRegex = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/;
  console.log("");
  console.log(`Max allowed alpha: ${maxAlpha}`);
  for (const item of results.bgChecks) {
    if (!item.found) {
      failed = true;
      console.log(`[MISSING] ${item.name} (${item.selector})`);
      continue;
    }
    const match = item.backgroundColor.match(rgbaRegex);
    const alpha = match && match[4] !== undefined ? Number(match[4]) : 1;
    const status = alpha <= maxAlpha ? "OK" : "OFF";
    if (status === "OFF") failed = true;
    console.log(`[${status}] ${item.name} background=${item.backgroundColor} alpha=${alpha}`);
  }

  if (failed) {
    console.log("\nResult: NOT centered within threshold.");
    process.exitCode = 1;
  } else {
    console.log("\nResult: Centered within threshold.");
  }
} finally {
  await browser.close();
}
