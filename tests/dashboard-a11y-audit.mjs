#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.argv.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:5173/status";
const cdpPort = Number(process.env.PROJECT_STATUS_CHROME_PORT ?? 9231);
const evidenceDir = path.resolve(".project-status/evidence");

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
      else pending.resolve(message.result ?? {});
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function connect() {
  const target = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent("about:blank")}`, {
    method: "PUT",
  }).then((response) => {
    if (!response.ok) throw new Error(`Chrome target creation failed: ${response.status}`);
    return response.json();
  });
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const client = new CdpClient(socket);
  await Promise.all([
    client.send("Page.enable"),
    client.send("Runtime.enable"),
    client.send("Accessibility.enable"),
  ]);
  return { client, socket, target };
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "Browser evaluation failed");
  return result.result.value;
}

async function waitFor(client, expression, timeout = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(client, expression)) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

async function loadVariant(client, { width, height, theme, reducedMotion = false }) {
  await client.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width <= 640,
    screenWidth: width,
    screenHeight: height,
  });
  await client.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-reduced-motion", value: reducedMotion ? "reduce" : "no-preference" },
      { name: "prefers-color-scheme", value: theme },
    ],
  });
  const url = new URL(baseUrl);
  url.searchParams.set("theme", theme);
  await client.send("Page.navigate", { url: url.href });
  await waitFor(client, `document.readyState === "complete" && Boolean(document.querySelector(".overall-status"))`);
  await waitFor(client, `!document.querySelector(".load-state") || !document.querySelector(".load-state").textContent.includes("loading")`);
  await sleep(150);
}

async function capture(client, filename) {
  const result = await client.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
    fromSurface: true,
  });
  await writeFile(path.join(evidenceDir, filename), Buffer.from(result.data, "base64"));
}

const browserAuditExpression = String.raw`(() => {
  const auditRoot = document.querySelector("dialog[open]") ?? document.body;
  const isVisible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return !element.classList.contains("sr-only") && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
  };
  const descriptor = (element) => {
    const label = element.getAttribute("aria-label") || element.innerText || element.getAttribute("title") || "";
    return {
      tag: element.tagName.toLowerCase(),
      className: element.className || "",
      label: label.trim().replace(/\s+/g, " ").slice(0, 100),
    };
  };
  const colorCanvas = new OffscreenCanvas(1, 1);
  const colorContext = colorCanvas.getContext("2d", { willReadFrequently: true });
  const parseRgb = (value) => {
    colorContext.clearRect(0, 0, 1, 1);
    colorContext.fillStyle = value;
    colorContext.fillRect(0, 0, 1, 1);
    const [red, green, blue, alpha] = colorContext.getImageData(0, 0, 1, 1).data;
    return [red, green, blue, alpha / 255];
  };
  const composite = (foreground, background) => {
    const alpha = foreground[3] + background[3] * (1 - foreground[3]);
    if (alpha === 0) return [0, 0, 0, 0];
    return [
      (foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) / alpha,
      (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) / alpha,
      (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) / alpha,
      alpha,
    ];
  };
  const luminance = (color) => {
    const channels = color.slice(0, 3).map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const contrast = (one, two) => {
    const first = luminance(one);
    const second = luminance(two);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  };
  const effectiveBackground = (element) => {
    const layers = [];
    let current = element;
    while (current) {
      const background = parseRgb(getComputedStyle(current).backgroundColor);
      if (background[3] > 0) layers.push(background);
      current = current.parentElement;
    }
    layers.push(parseRgb(getComputedStyle(document.documentElement).backgroundColor));
    return layers.reverse().reduce((result, layer) => composite(layer, result), [255, 255, 255, 1]);
  };

  const interactive = [...auditRoot.querySelectorAll("button, a[href], input, select, textarea, [role='button'], [tabindex]:not([tabindex='-1'])")]
    .filter(isVisible);
  const undersizedTargets = interactive
    .map((element) => ({ ...descriptor(element), rect: (() => {
      const rect = element.getBoundingClientRect();
      return { width: Math.round(rect.width * 10) / 10, height: Math.round(rect.height * 10) / 10 };
    })() }))
    .filter((item) => item.rect.width < 44 || item.rect.height < 44);
  const unnamedControls = interactive.filter((element) => {
    if (element.matches("input") && (element.labels?.length || element.getAttribute("aria-label"))) return false;
    return !(element.getAttribute("aria-label") || element.getAttribute("aria-labelledby") || element.innerText.trim() || element.getAttribute("title"));
  }).map(descriptor);

  const directTextElements = [...new Set([...auditRoot.querySelectorAll("*")].filter((element) =>
    isVisible(element) && [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()),
  ))];
  const contrastFailures = directTextElements.flatMap((element) => {
    const style = getComputedStyle(element);
    const foreground = parseRgb(style.color);
    const background = effectiveBackground(element);
    const ratio = contrast(foreground, background);
    const size = Number.parseFloat(style.fontSize);
    const weight = Number.parseInt(style.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const required = large ? 3 : 4.5;
    if (ratio + 0.01 >= required) return [];
    return [{
      ...descriptor(element),
      text: [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent.trim()).join(" ").slice(0, 100),
      ratio: Math.round(ratio * 100) / 100,
      required,
      fontSize: size,
      fontWeight: weight,
      color: style.color,
      background: getComputedStyle(element).backgroundColor,
    }];
  });

  const rootStyle = getComputedStyle(document.documentElement);
  const tokenContrast = (foregroundToken, backgroundToken) => contrast(
    parseRgb(rootStyle.getPropertyValue(foregroundToken)),
    parseRgb(rootStyle.getPropertyValue(backgroundToken)),
  );
  const documentElement = document.documentElement;
  return {
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    reflow: {
      documentClientWidth: documentElement.clientWidth,
      documentScrollWidth: documentElement.scrollWidth,
      bodyClientWidth: document.body.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      horizontalOverflow: documentElement.scrollWidth > documentElement.clientWidth + 1 || document.body.scrollWidth > document.body.clientWidth + 1,
    },
    landmarks: {
      main: document.querySelectorAll("main").length,
      navigation: document.querySelectorAll("nav, [role='navigation']").length,
      header: document.querySelectorAll("header").length,
      footer: document.querySelectorAll("body > * footer, .status-footer").length,
    },
    headingOrder: [...auditRoot.querySelectorAll("h1, h2, h3, h4, h5, h6")].filter(isVisible).map((heading) => ({
      level: Number(heading.tagName.slice(1)),
      text: heading.textContent.trim().replace(/\s+/g, " ").slice(0, 100),
    })),
    visibleDialogs: [...document.querySelectorAll("dialog[open]")].map((dialog) => ({
      label: dialog.getAttribute("aria-label") || dialog.getAttribute("aria-labelledby") || "",
    })),
    unnamedControls,
    undersizedTargets,
    contrastFailures,
    tokens: {
      accentOnSurface: Math.round(tokenContrast("--accent-strong", "--surface") * 100) / 100,
      warningOnSurface: Math.round(tokenContrast("--warning", "--surface") * 100) / 100,
      dangerOnSurface: Math.round(tokenContrast("--danger", "--surface") * 100) / 100,
      mutedOnSurface: Math.round(tokenContrast("--ink-muted", "--surface") * 100) / 100,
      focusOnSurface: Math.round(tokenContrast("--focus", "--surface") * 100) / 100,
      unstartedOnBar: Math.round(tokenContrast("--work-unstarted", "--surface-subtle") * 100) / 100,
    },
  };
})()`;

async function activeElement(client) {
  return evaluate(client, `(() => {
    const element = document.activeElement;
    return {
      tag: element?.tagName?.toLowerCase() ?? "",
      className: element?.className ?? "",
      label: (element?.getAttribute?.("aria-label") || element?.innerText || element?.getAttribute?.("placeholder") || "").trim().replace(/\\s+/g, " ").slice(0, 100),
      inCommandDialog: Boolean(element?.closest?.(".command-dialog")),
      inSectionDialog: Boolean(element?.closest?.(".section-dialog")),
    };
  })()`);
}

async function accessibilityTreeAudit(client) {
  const tree = await client.send("Accessibility.getFullAXTree");
  const namedRoles = new Set(["button", "link", "textbox", "searchbox", "dialog", "progressbar", "img"]);
  const relevant = tree.nodes.filter((node) => !node.ignored && namedRoles.has(node.role?.value));
  return {
    relevantNodeCount: relevant.length,
    dialogs: relevant.filter((node) => node.role?.value === "dialog").map((node) => node.name?.value ?? ""),
    missingNames: relevant
      .filter((node) => !String(node.name?.value ?? "").trim())
      .map((node) => ({ role: node.role?.value ?? "", backendDOMNodeId: node.backendDOMNodeId ?? null })),
  };
}

async function key(client, keyValue, code, modifiers = 0) {
  const virtualKeyCodes = { Enter: 13, Escape: 27, Tab: 9 };
  const virtualKeyCode = virtualKeyCodes[keyValue] ?? 0;
  const event = {
    key: keyValue,
    code,
    modifiers,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
  };
  await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...event });
  if (keyValue === "Enter") {
    await client.send("Input.dispatchKeyEvent", { type: "char", ...event, text: "\r", unmodifiedText: "\r" });
  }
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
  await sleep(30);
}

async function tab(client, reverse = false) {
  await key(client, "Tab", "Tab", reverse ? 8 : 0);
}

async function auditKeyboard(client) {
  const result = {
    command: { trapped: true, cycle: [] },
    section: { trapped: true, cycle: [] },
    install: { trapped: true, cycle: [] },
  };

  await evaluate(client, `document.querySelector(".search-button").focus()`);
  result.command.trigger = await activeElement(client);
  await key(client, "Enter", "Enter");
  await waitFor(client, `Boolean(document.querySelector(".command-dialog[open]"))`);
  result.command.initial = await activeElement(client);
  await tab(client, true);
  result.command.reverse = await activeElement(client);
  if (!result.command.reverse.inCommandDialog) result.command.trapped = false;
  await tab(client);
  for (let index = 0; index < 12; index += 1) {
    await tab(client);
    const active = await activeElement(client);
    result.command.cycle.push(active);
    if (!active.inCommandDialog) result.command.trapped = false;
  }
  await key(client, "Escape", "Escape");
  await waitFor(client, `!document.querySelector(".command-dialog[open]")`);
  await sleep(60);
  result.command.returned = await activeElement(client);

  await evaluate(client, `document.querySelector(".summary-tile").focus()`);
  await key(client, "k", "KeyK", 4);
  await waitFor(client, `Boolean(document.querySelector(".command-dialog[open]"))`);
  result.command.shortcutOpened = (await activeElement(client)).inCommandDialog;
  await key(client, "Escape", "Escape");
  await waitFor(client, `!document.querySelector(".command-dialog[open]")`);

  await evaluate(client, `document.querySelector(".summary-tile").focus()`);
  result.section.trigger = await activeElement(client);
  await key(client, "Enter", "Enter");
  await waitFor(client, `Boolean(document.querySelector(".section-dialog[open]"))`);
  result.section.initial = await activeElement(client);
  await tab(client, true);
  result.section.reverse = await activeElement(client);
  if (!result.section.reverse.inSectionDialog) result.section.trapped = false;
  for (let index = 0; index < 6; index += 1) {
    await tab(client);
    const active = await activeElement(client);
    result.section.cycle.push(active);
    if (!active.inSectionDialog) result.section.trapped = false;
  }
  await key(client, "Escape", "Escape");
  await waitFor(client, `!document.querySelector(".section-dialog[open]")`);
  await sleep(60);
  result.section.returned = await activeElement(client);

  await evaluate(client, `document.querySelector(".attach-button").focus()`);
  result.install.trigger = await activeElement(client);
  await key(client, "Enter", "Enter");
  await waitFor(client, `Boolean(document.querySelector(".section-dialog[open]"))`);
  await tab(client, true);
  result.install.reverse = await activeElement(client);
  if (!result.install.reverse.inSectionDialog) result.install.trapped = false;
  for (let index = 0; index < 12; index += 1) {
    await tab(client);
    const active = await activeElement(client);
    result.install.cycle.push(active);
    if (!active.inSectionDialog) result.install.trapped = false;
  }
  result.install.targets = await evaluate(client, `${browserAuditExpression}.undersizedTargets`);
  await key(client, "Escape", "Escape");
  await waitFor(client, `!document.querySelector(".section-dialog[open]")`);
  await sleep(60);
  result.install.returned = await activeElement(client);

  await evaluate(client, `document.querySelector(".search-button").focus()`);
  await key(client, "Enter", "Enter");
  await waitFor(client, `Boolean(document.querySelector(".command-dialog[open]"))`);
  await client.send("Input.insertText", { text: "no-such-section" });
  await sleep(50);
  result.command.emptyState = await evaluate(client, `document.querySelector(".command-empty")?.textContent ?? ""`);
  await key(client, "Escape", "Escape");

  return result;
}

function acceptance(report) {
  const variants = Object.values(report.variants);
  const variantFailures = variants.flatMap((variant) => [
    ...(variant.audit.reflow.horizontalOverflow ? [`${variant.name}: horizontal overflow`] : []),
    ...variant.audit.unnamedControls.map((control) => `${variant.name}: unnamed ${control.tag}`),
    ...variant.audit.undersizedTargets.map((control) => `${variant.name}: target ${control.label} is ${control.rect.width}x${control.rect.height}`),
    ...variant.audit.contrastFailures.map((failure) => `${variant.name}: contrast ${failure.ratio}:1 for ${failure.text}`),
    ...variant.ax.missingNames.map((item) => `${variant.name}: unnamed ${item.role} in accessibility tree`),
    ...(variant.dialogAudit?.reflow.horizontalOverflow ? [`${variant.name}: drawer horizontal overflow`] : []),
    ...(variant.dialogAudit?.unnamedControls ?? []).map((control) => `${variant.name}: unnamed drawer ${control.tag}`),
    ...(variant.dialogAudit?.undersizedTargets ?? []).map((control) => `${variant.name}: drawer target ${control.label} is ${control.rect.width}x${control.rect.height}`),
    ...(variant.dialogAudit?.contrastFailures ?? []).map((failure) => `${variant.name}: drawer contrast ${failure.ratio}:1 for ${failure.text}`),
    ...(variant.dialogAx?.missingNames ?? []).map((item) => `${variant.name}: unnamed drawer ${item.role} in accessibility tree`),
  ]);
  const keyboard = report.keyboard;
  const keyboardFailures = [
    ...(!keyboard.command.trapped ? ["command palette focus escaped"] : []),
    ...(!keyboard.command.shortcutOpened ? ["command shortcut did not open palette"] : []),
    ...(keyboard.command.returned.className !== "search-button" ? ["command palette did not return focus"] : []),
    ...(!keyboard.section.trapped ? ["section drawer focus escaped"] : []),
    ...(!String(keyboard.section.returned.className).includes("summary-tile") ? ["section drawer did not return focus"] : []),
    ...(!keyboard.install.trapped ? ["install drawer focus escaped"] : []),
    ...(!String(keyboard.install.returned.className).includes("attach-button") ? ["install drawer did not return focus"] : []),
    ...keyboard.install.targets.map((control) => `install target ${control.label} is ${control.rect.width}x${control.rect.height}`),
  ];
  return [...variantFailures, ...keyboardFailures];
}

await mkdir(evidenceDir, { recursive: true });
const { client, socket, target } = await connect();
const report = {
  standard: "WCAG 2.2 AA local engineering audit",
  generatedAt: new Date().toISOString(),
  baseUrl,
  browser: await evaluate(client, `navigator.userAgent`),
  scope: {
    automated: ["semantic names and landmarks", "text contrast", "44x44 design target policy", "keyboard focus trap and return", "responsive reflow", "reduced motion"],
    manualStillRequired: ["VoiceOver/NVDA announcement quality", "high-contrast OS modes on physical devices", "cognitive usability with representative users"],
  },
  variants: {},
};

const variants = [
  { name: "light-desktop", width: 1440, height: 1024, theme: "light" },
  { name: "dark-desktop", width: 1440, height: 1024, theme: "dark" },
  { name: "light-mobile", width: 390, height: 844, theme: "light" },
  { name: "dark-mobile", width: 390, height: 844, theme: "dark" },
  { name: "light-200-percent-reflow", width: 720, height: 512, theme: "light" },
  { name: "dark-200-percent-reflow", width: 720, height: 512, theme: "dark" },
];

for (const variant of variants) {
  await loadVariant(client, variant);
  report.variants[variant.name] = {
    name: variant.name,
    audit: await evaluate(client, browserAuditExpression),
    ax: await accessibilityTreeAudit(client),
  };
  if (!variant.name.includes("200-percent")) await capture(client, `a11y-${variant.name}.png`);
  if (variant.width <= 720) {
    await evaluate(client, `document.querySelector(".attach-button").click()`);
    await waitFor(client, `Boolean(document.querySelector(".section-dialog[open]"))`);
    report.variants[variant.name].dialogAudit = await evaluate(client, browserAuditExpression);
    report.variants[variant.name].dialogAx = await accessibilityTreeAudit(client);
    if (variant.name === "dark-mobile") await capture(client, "a11y-dark-mobile-drawer.png");
    await key(client, "Escape", "Escape");
    await waitFor(client, `!document.querySelector(".section-dialog[open]")`);
  }
}

await loadVariant(client, { width: 1440, height: 1024, theme: "light" });
report.keyboard = await auditKeyboard(client);

await loadVariant(client, { width: 1440, height: 1024, theme: "light", reducedMotion: true });
const reducedMotionTileDuration = await evaluate(client, `getComputedStyle(document.querySelector(".summary-tile")).transitionDuration`);
await evaluate(client, `document.querySelector(".summary-tile").click()`);
await waitFor(client, `Boolean(document.querySelector(".section-drawer"))`);
report.reducedMotion = {
  tileTransitionDuration: reducedMotionTileDuration,
  drawerAnimationDuration: await evaluate(client, `getComputedStyle(document.querySelector(".section-drawer")).animationDuration`),
};
await key(client, "Escape", "Escape");

report.acceptanceFailures = acceptance(report);
report.localAutomatedAcceptance = report.acceptanceFailures.length === 0;

await writeFile(path.join(evidenceDir, "a11y-audit.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  localAutomatedAcceptance: report.localAutomatedAcceptance,
  failures: report.acceptanceFailures,
  report: path.join(evidenceDir, "a11y-audit.json"),
}, null, 2));

socket.close();
await fetch(`http://127.0.0.1:${cdpPort}/json/close/${target.id}`);
process.exitCode = report.localAutomatedAcceptance ? 0 : 1;
