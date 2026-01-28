#!/usr/bin/env bun
import { chromium } from "playwright";

const url = process.env.CENTER_CHECK_URL ?? "http://127.0.0.1:8080/";
const viewportWidth = Number(process.env.CENTER_CHECK_WIDTH ?? "1440");
const viewportHeight = Number(process.env.CENTER_CHECK_HEIGHT ?? "900");
const threshold = Number(process.env.CENTER_CHECK_THRESHOLD ?? "2");

const targets = [
  { name: "banner-title", selector: "#chat .chat-banner-wrapper .chat-chrome-centered h1", required: true },
  { name: "chat-nav", selector: "#chat #chat-nav-sticky .chat-chrome-centered > div", required: true },
  // These can be hidden when no conversation is selected; treat as optional.
  { name: "chat-messages", selector: "#chat-messages-desktop", required: false },
  { name: "chat-input-wrapper", selector: "#chat .chat-input-wrapper", required: false },
  { name: "chat-input-textarea", selector: "#chat .chat-desktop-container textarea#chat-input-desktop", required: false },
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
  required?: boolean;
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
  await page.waitForSelector("#conversation-select", { timeout: 10000 });
  await page.waitForSelector("#conversation-new-btn", { timeout: 10000 });

  const results = await page.evaluate(({ selectors, styles }) => {
    const viewportWidth = window.innerWidth;
    const contentCenter = viewportWidth / 2;

    const items = selectors.map((item: MeasuredItem) => {
      const el = document.querySelector(item.selector);
      if (!el) {
        return { ...item, found: false };
      }
      const rect = el.getBoundingClientRect();
      // Treat display:none (or fully collapsed) as not found for layout checks.
      if (rect.width === 0 && rect.height === 0) {
        return { ...item, found: false };
      }
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

    const sidebarAbsent = !document.querySelector("#conversation-sidebar");

    const buttonChecks = (() => {
      const selectors = ["#conversation-new-btn", "#conversation-clear-btn"];
      return selectors.map((selector) => {
        const el = document.querySelector(selector) as HTMLElement | null;
        if (!el) return { selector, found: false as const };
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const topEl = document.elementFromPoint(cx, cy);
        const clickable = topEl ? el.contains(topEl) : false;
        const inViewport =
          rect.width > 0 &&
          rect.height > 0 &&
          rect.top >= 0 &&
          rect.left >= 0 &&
          rect.bottom <= window.innerHeight &&
          rect.right <= window.innerWidth;
        return {
          selector,
          found: true as const,
          inViewport,
          clickable,
          rect: {
            top: rect.top,
            left: rect.left,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
          },
        };
      });
    })();

    return {
      viewport: { width: viewportWidth, height: window.innerHeight },
      contentCenter,
      items,
      bgChecks,
      sidebarAbsent,
      buttonChecks,
    };
  }, { selectors: targets, styles: styleChecks });

  console.log(`URL: ${url}`);
  console.log(`Viewport: ${results.viewport.width}x${results.viewport.height}`);
  console.log(`Content center X: ${results.contentCenter.toFixed(2)}px`);
  console.log(`Threshold: ${threshold}px`);
  console.log("");

  let failed = false;

  // Sidebar should be fully removed.
  console.log(`[${results.sidebarAbsent ? "OK" : "OFF"}] conversation sidebar removed`);
  if (!results.sidebarAbsent) failed = true;

  // Sidebar header buttons should be visible and clickable (not covered by other layers)
  console.log("");
  for (const btn of results.buttonChecks ?? []) {
    if (!btn.found) {
      failed = true;
      console.log(`[MISSING] button (${btn.selector})`);
      continue;
    }
    const ok = Boolean(btn.inViewport && btn.clickable);
    const rect = (btn as any).rect;
    console.log(
      `[${ok ? "OK" : "OFF"}] button ${btn.selector} inViewport=${btn.inViewport} clickable=${btn.clickable}` +
        (rect ? ` rect=${JSON.stringify(rect)}` : "")
    );
    if (!ok) failed = true;
  }

  console.log("");
  for (const item of results.items) {
    if (!item.found || item.centerX === undefined) {
      if (item.required === false) {
        console.log(`[SKIP] ${item.name} (${item.selector})`);
        continue;
      }
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
