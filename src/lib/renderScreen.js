const SCREEN_WIDTH = 142;
const SCREEN_HEIGHT = 428;
const SCALE = 2;
/** 顶部由设备系统固定绘制 Wi‑Fi、电池等状态信息，业务内容不可进入。
 *  实机照片测得该区域约占屏幕高度的 15%，按 142×428 输出统一保留 64px。 */
export const SCREEN_SAFE_TOP = 64;
/** 左右各留 18px 边距后的可用宽度，进度条和所有受限文本都按它对齐。 */
const CONTENT_WIDTH = 106;
const PRESET_PADDING = 8;
const PRESET_COLUMN_GAP = 4;
const PRESET_ROW_GAP = 3;
const PRESET_COLUMN_WIDTH = 61;
// 顶部安全区从 28px 增至 64px 后压缩纵向网格，16 行仍可完整落在 428px 画布内。
const PRESET_ROW_HEIGHT = 19;
const PRESET_ROW_STEP = PRESET_ROW_HEIGHT + PRESET_ROW_GAP;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function getCropSourceRect(image, crop = {}) {
  if (!image?.width || !image?.height) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const targetRatio = SCREEN_WIDTH / SCREEN_HEIGHT;
  const imageRatio = image.width / image.height;
  const zoom = clamp(Number(crop.zoom) || 1, 1, 4);
  const focusX = clamp(Number(crop.x) || 0.5, 0, 1);
  const focusY = clamp(Number(crop.y) || 0.5, 0, 1);

  let baseWidth;
  let baseHeight;
  if (imageRatio > targetRatio) {
    baseHeight = image.height;
    baseWidth = baseHeight * targetRatio;
  } else {
    baseWidth = image.width;
    baseHeight = baseWidth / targetRatio;
  }

  const width = baseWidth / zoom;
  const height = baseHeight / zoom;
  const x = clamp(focusX * image.width - width / 2, 0, image.width - width);
  const y = clamp(focusY * image.height - height / 2, 0, image.height - height);

  return { x, y, width, height };
}

function roundedRect(ctx, x, y, width, height, radius) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, safeRadius);
}

const FONT_STACK = '"PingFang SC", "Microsoft YaHei", sans-serif';

function setFont(ctx, size, weight) {
  ctx.font = `${weight} ${size}px ${FONT_STACK}`;
}

/** 把文本收进 maxWidth，超出部分用省略号收尾。
 *  画布只有 142px 宽，而 fillText 既不换行也不裁剪——超长文案会直接画到画布外被切掉。
 *  目前的文案是写死的所以看不出来，但接入真实额度接口后任何一条长文案都会这样烂掉，
 *  所以凡是宽度受限的位置都要带上 maxWidth。调用前字体必须已设置好，measureText 依赖它。 */
function fitText(ctx, text, maxWidth) {
  if (!Number.isFinite(maxWidth) || ctx.measureText(text).width <= maxWidth) {
    return text;
  }
  let clipped = text;
  while (clipped.length > 1 && ctx.measureText(`${clipped}…`).width > maxWidth) {
    clipped = clipped.slice(0, -1);
  }
  return `${clipped}…`;
}

function drawText(ctx, text, x, y, size, color, weight = 500, align = "left", maxWidth) {
  ctx.fillStyle = color;
  setFont(ctx, size, weight);
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  // 最终防线：即使后续新增布局忘记使用 SCREEN_SAFE_TOP，
  // 任何业务文字的实际字形顶部也不能进入系统状态区。
  const textMetrics = ctx.measureText(String(text));
  const ascent = Math.ceil(textMetrics.actualBoundingBoxAscent || size);
  const safeBaselineY = Math.max(y, SCREEN_SAFE_TOP + ascent + 2);
  ctx.fillText(fitText(ctx, String(text), maxWidth), x, safeBaselineY);
}

function drawFittedText(
  ctx,
  text,
  x,
  y,
  size,
  minSize,
  color,
  weight,
  align,
  maxWidth,
) {
  let fittedSize = size;
  setFont(ctx, fittedSize, weight);
  while (
    fittedSize > minSize &&
    ctx.measureText(String(text)).width > maxWidth
  ) {
    fittedSize = Math.max(minSize, fittedSize - 0.5);
    setFont(ctx, fittedSize, weight);
  }
  drawText(ctx, text, x, y, fittedSize, color, weight, align, maxWidth);
}

/** 数字和 % 作为一个整体居中。
 *  原来数字居中画在 x=68、% 固定画在 x=98，于是 "5%" 会裂开一大道空隙，
 *  "100%" 又会挤在一起——% 的位置必须跟着数字实际宽度走。 */
function drawPercentValue(ctx, value, centerX, baselineY, color) {
  if (!Number.isFinite(value)) {
    drawText(ctx, "—", centerX, baselineY, 32, "#8a9b9e", 700, "center");
    return;
  }
  const text = String(Math.round(value));
  setFont(ctx, 32, 750);
  const valueWidth = ctx.measureText(text).width;
  setFont(ctx, 11, 600);
  const unitWidth = ctx.measureText("%").width;
  const gap = 3;
  const left = centerX - (valueWidth + gap + unitWidth) / 2;
  drawText(ctx, text, left, baselineY, 32, color, 750, "left");
  drawText(ctx, "%", left + valueWidth + gap, baselineY - 2, 11, color, 600, "left");
}

function drawProgress(ctx, x, y, width, value, color) {
  ctx.fillStyle = "#223139";
  roundedRect(ctx, x, y, width, 6, 3);
  ctx.fill();
  // 传感器不可用时只画底槽：空槽比一个 0% 的小圆点更能说明「没有数据」。
  if (!Number.isFinite(value)) return;
  ctx.fillStyle = color;
  roundedRect(ctx, x, y, Math.max(6, width * (clamp(value, 0, 100) / 100)), 6, 3);
  ctx.fill();
}

function finiteNumber(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function percentOf(used, total) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return clamp((used / total) * 100, 0, 100);
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${Math.round(value)}%` : "—";
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const days = Math.floor(seconds / 86400);
  if (days > 0) return `${days}天 ${Math.floor((seconds % 86400) / 3600)}时`;
  const hours = Math.floor(seconds / 3600);
  return `${hours}时 ${Math.floor((seconds % 3600) / 60)}分`;
}

function presetRect(column, row, columnSpan, rowSpan) {
  return {
    x: PRESET_PADDING + column * (PRESET_COLUMN_WIDTH + PRESET_COLUMN_GAP),
    y: SCREEN_SAFE_TOP + row * PRESET_ROW_STEP,
    width:
      PRESET_COLUMN_WIDTH * columnSpan +
      PRESET_COLUMN_GAP * Math.max(0, columnSpan - 1),
    height:
      PRESET_ROW_HEIGHT * rowSpan +
      PRESET_ROW_GAP * Math.max(0, rowSpan - 1),
  };
}

function drawSafeAreaBackground(ctx) {
  const safeArea = ctx.createLinearGradient(0, 0, 0, SCREEN_SAFE_TOP);
  safeArea.addColorStop(0, "#0d2428");
  safeArea.addColorStop(1, "#081417");
  ctx.fillStyle = safeArea;
  ctx.fillRect(0, 0, SCREEN_WIDTH, SCREEN_SAFE_TOP);
  ctx.strokeStyle = "#2b5558";
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  ctx.moveTo(8, SCREEN_SAFE_TOP - 0.5);
  ctx.lineTo(SCREEN_WIDTH - 8, SCREEN_SAFE_TOP - 0.5);
  ctx.stroke();
}

function fillPresetCard(ctx, rect, accent = "#43dbc4") {
  const gradient = ctx.createLinearGradient(rect.x, rect.y, rect.x, rect.y + rect.height);
  gradient.addColorStop(0, "#152225");
  gradient.addColorStop(1, "#0c1417");
  ctx.fillStyle = gradient;
  roundedRect(ctx, rect.x, rect.y, rect.width, rect.height, 6);
  ctx.fill();
  ctx.strokeStyle = `${accent}38`;
  ctx.lineWidth = 0.7;
  ctx.stroke();
}

function drawPresetMetric(
  ctx,
  rect,
  label,
  value,
  {
    accent = "#43dbc4",
    detail = "",
    percent = null,
    progress = true,
    valueSize,
  } = {},
) {
  fillPresetCard(ctx, rect, accent);
  const compact = rect.height <= 45;
  const padding = rect.width <= PRESET_COLUMN_WIDTH ? 7 : 9;
  drawText(
    ctx,
    label,
    rect.x + padding,
    rect.y + (compact ? 13 : 17),
    compact ? 6 : rect.height <= 48 ? 7 : 8,
    "#8ea4a8",
    650,
    "left",
    rect.width - padding * 2,
  );
  drawText(
    ctx,
    value,
    rect.x + padding,
    rect.y + (compact ? 27 : Math.min(rect.height - 12, rect.height <= 48 ? 37 : 48)),
    valueSize ?? (compact ? 11 : rect.width <= PRESET_COLUMN_WIDTH ? 15 : 19),
    "#f0faf8",
    750,
    "left",
    rect.width - padding * 2,
  );
  if (detail && rect.height >= 74) {
    drawText(
      ctx,
      detail,
      rect.x + padding,
      rect.y + rect.height - (progress ? 17 : 8),
      7,
      "#809296",
      550,
      "left",
      rect.width - padding * 2,
    );
  }
  if (progress) {
    drawProgress(
      ctx,
      rect.x + padding,
      rect.y + rect.height - (compact ? 8 : 10),
      rect.width - padding * 2,
      percent,
      accent,
    );
  }
}

function drawSparkline(ctx, rect, values, accent) {
  const finiteValues = values.filter(Number.isFinite);
  if (finiteValues.length < 2) {
    drawText(
      ctx,
      "等待真实采样",
      rect.x + rect.width / 2,
      rect.y + rect.height / 2 + 4,
      7,
      "#718589",
      550,
      "center",
      rect.width - 16,
    );
    return;
  }
  const min = Math.min(...finiteValues);
  const max = Math.max(...finiteValues);
  const range = Math.max(1, max - min);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  finiteValues.forEach((value, index) => {
    const x = rect.x + (index / Math.max(1, finiteValues.length - 1)) * rect.width;
    const y = rect.y + rect.height - ((value - min) / range) * rect.height;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function drawPresetTrend(ctx, rect, label, value, historyValues, accent = "#43dbc4") {
  fillPresetCard(ctx, rect, accent);
  drawText(ctx, label, rect.x + 9, rect.y + 17, 8, "#91a6aa", 650, "left", rect.width - 18);
  drawText(
    ctx,
    formatPercent(value),
    rect.x + rect.width - 9,
    rect.y + 21,
    15,
    "#f0faf8",
    750,
    "right",
    rect.width - 18,
  );
  drawSparkline(
    ctx,
    {
      x: rect.x + 9,
      y: rect.y + 32,
      width: rect.width - 18,
      height: rect.height - 42,
    },
    historyValues,
    accent,
  );
}

function drawPresetNetwork(ctx, rect, metrics, history, title = "实时网络") {
  fillPresetCard(ctx, rect, "#45d9bd");
  drawText(ctx, title, rect.x + 9, rect.y + 17, 8, "#91a6aa", 650, "left", rect.width - 18);
  drawText(
    ctx,
    `↓ ${formatRate(metrics.networkDown)}`,
    rect.x + 9,
    rect.y + 38,
    10,
    "#52dfc4",
    700,
    "left",
    rect.width - 18,
  );
  drawText(
    ctx,
    `↑ ${formatRate(metrics.networkUp)}`,
    rect.x + rect.width - 9,
    rect.y + 38,
    10,
    "#73aefd",
    700,
    "right",
    rect.width - 18,
  );
  if (rect.height >= 74) {
    drawSparkline(
      ctx,
      {
        x: rect.x + 9,
        y: rect.y + 49,
        width: rect.width - 18,
        height: rect.height - 59,
      },
      history.map((sample) => sample.networkDown),
      "#45d9bd",
    );
  }
}

function drawPresetClock(ctx, rect, compact = false) {
  fillPresetCard(ctx, rect, "#43dbc4");
  const now = new Date();
  const time = now.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  drawText(
    ctx,
    time,
    rect.x + rect.width / 2,
    rect.y + (compact ? 35 : Math.min(58, rect.height / 2 + 15)),
    compact ? 19 : 30,
    "#f0faf8",
    760,
    "center",
    rect.width - 16,
  );
  if (!compact || rect.height >= 74) {
    drawText(
      ctx,
      `${now.getMonth() + 1}月${now.getDate()}日 周${"日一二三四五六"[now.getDay()]}`,
      rect.x + rect.width / 2,
      rect.y + rect.height - 13,
      8,
      "#62dfca",
      650,
      "center",
      rect.width - 16,
    );
  }
}

function drawPresetScreen(ctx, model) {
  const metrics = model.metrics ?? {};
  const history = Array.isArray(model.history) ? model.history : [];
  const cpu = finiteNumber(metrics.cpuUsage);
  const memory = percentOf(metrics.memoryUsed, metrics.memoryTotal);
  const gpu = finiteNumber(metrics.gpuUsage);
  const disk = percentOf(metrics.diskUsed, metrics.diskTotal);
  const temperature = finiteNumber(metrics.temperature);
  const uptime = finiteNumber(metrics.uptime);
  const latency = finiteNumber(model.deviceStatus?.latencyMs);
  const metric = (col, row, cols, rows, label, value, percent, options = {}) =>
    drawPresetMetric(ctx, presetRect(col, row, cols, rows), label, value, {
      percent,
      ...options,
    });

  const background = ctx.createLinearGradient(0, 0, 142, 428);
  background.addColorStop(0, "#081417");
  background.addColorStop(1, "#030809");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
  drawSafeAreaBackground(ctx);

  switch (model.presetId) {
    case "performance-trends":
      drawPresetTrend(
        ctx,
        presetRect(0, 0, 2, 4),
        "CPU 趋势",
        cpu,
        history.map((sample) => sample.cpuUsage),
      );
      metric(0, 4, 1, 3, "内存", formatPercent(memory), memory);
      metric(1, 4, 1, 3, "GPU", formatPercent(gpu), gpu, { accent: "#73aefd" });
      metric(0, 7, 2, 2, "系统盘", formatPercent(disk), disk, { accent: "#efb95f" });
      drawPresetNetwork(ctx, presetRect(0, 9, 2, 4), metrics, history, "网络趋势");
      metric(0, 13, 1, 3, "温度", temperature === null ? "—" : `${Math.round(temperature)}°C`, null, {
        accent: "#ef8a68",
        progress: false,
      });
      metric(1, 13, 1, 3, "运行时间", formatDuration(uptime), null, { progress: false, valueSize: 11 });
      break;
    case "network-traffic":
      drawPresetNetwork(ctx, presetRect(0, 0, 2, 5), metrics, history, "网络吞吐");
      metric(0, 5, 1, 3, "下载", formatRate(metrics.networkDown), null, {
        progress: false,
        valueSize: 11,
      });
      metric(1, 5, 1, 3, "上传", formatRate(metrics.networkUp), null, {
        accent: "#73aefd",
        progress: false,
        valueSize: 11,
      });
      metric(0, 8, 2, 3, "设备延迟", latency === null ? "—" : `${Math.round(latency)} ms`, null, {
        progress: false,
        valueSize: 18,
      });
      metric(0, 11, 2, 2, "主机运行", formatDuration(uptime), null, {
        progress: false,
        valueSize: 12,
      });
      drawPresetClock(ctx, presetRect(0, 13, 2, 3), true);
      break;
    case "hardware-health":
      metric(0, 0, 1, 4, "CPU", formatPercent(cpu), cpu);
      metric(1, 0, 1, 4, "GPU", formatPercent(gpu), gpu, { accent: "#73aefd" });
      metric(0, 4, 2, 3, "最高温度", temperature === null ? "不可用" : `${Math.round(temperature)}°C`, null, {
        accent: "#ef8a68",
        progress: false,
      });
      metric(0, 7, 1, 4, "内存", formatPercent(memory), memory);
      metric(1, 7, 1, 4, "磁盘", formatPercent(disk), disk, { accent: "#efb95f" });
      metric(0, 11, 2, 3, "稳定运行", formatDuration(uptime), null, { progress: false });
      drawPresetClock(ctx, presetRect(0, 14, 2, 2), true);
      break;
    case "storage-memory":
      metric(
        0,
        0,
        2,
        5,
        "内存",
        formatPercent(memory),
        memory,
        {
          detail:
            Number.isFinite(metrics.memoryUsed) && Number.isFinite(metrics.memoryTotal)
              ? `${(metrics.memoryUsed / 1024 ** 3).toFixed(1)} / ${(metrics.memoryTotal / 1024 ** 3).toFixed(1)} GB`
              : "数据不可用",
          valueSize: 28,
        },
      );
      metric(
        0,
        5,
        2,
        5,
        "系统盘",
        formatPercent(disk),
        disk,
        {
          accent: "#efb95f",
          detail:
            Number.isFinite(metrics.diskUsed) && Number.isFinite(metrics.diskTotal)
              ? `${((metrics.diskTotal - metrics.diskUsed) / 1024 ** 3).toFixed(0)} GB 可用`
              : "数据不可用",
          valueSize: 28,
        },
      );
      metric(0, 10, 1, 3, "CPU", formatPercent(cpu), cpu);
      metric(1, 10, 1, 3, "GPU", formatPercent(gpu), gpu, { accent: "#73aefd" });
      drawPresetNetwork(ctx, presetRect(0, 13, 2, 3), metrics, history);
      break;
    case "minimal-status":
      drawPresetClock(ctx, presetRect(0, 0, 2, 5));
      metric(0, 5, 1, 4, "CPU", formatPercent(cpu), cpu);
      metric(1, 5, 1, 4, "内存", formatPercent(memory), memory);
      drawPresetNetwork(ctx, presetRect(0, 9, 2, 7), metrics, history);
      break;
    case "device-operations":
      metric(0, 0, 2, 4, "设备延迟", latency === null ? "—" : `${Math.round(latency)} ms`, null, {
        progress: false,
        valueSize: 28,
        detail: latency === null ? "等待设备响应" : "局域网往返耗时",
      });
      metric(0, 4, 1, 3, "运行时间", formatDuration(uptime), null, {
        progress: false,
        valueSize: 11,
      });
      metric(1, 4, 1, 3, "温度", temperature === null ? "—" : `${Math.round(temperature)}°C`, null, {
        accent: "#ef8a68",
        progress: false,
        valueSize: 13,
      });
      drawPresetNetwork(ctx, presetRect(0, 7, 2, 4), metrics, history);
      metric(0, 11, 1, 3, "CPU", formatPercent(cpu), cpu);
      metric(1, 11, 1, 3, "内存", formatPercent(memory), memory);
      metric(0, 14, 1, 2, "GPU", formatPercent(gpu), gpu, {
        accent: "#73aefd",
      });
      metric(1, 14, 1, 2, "磁盘", formatPercent(disk), disk, {
        accent: "#efb95f",
      });
      break;
    case "all-in-one":
      drawPresetClock(ctx, presetRect(0, 0, 2, 3), true);
      metric(0, 3, 1, 3, "CPU", formatPercent(cpu), cpu);
      metric(1, 3, 1, 3, "内存", formatPercent(memory), memory);
      metric(0, 6, 1, 3, "GPU", formatPercent(gpu), gpu, { accent: "#73aefd" });
      metric(1, 6, 1, 3, "磁盘", formatPercent(disk), disk, { accent: "#efb95f" });
      drawPresetNetwork(ctx, presetRect(0, 9, 2, 3), metrics, history);
      metric(0, 12, 1, 4, "温度", temperature === null ? "—" : `${Math.round(temperature)}°C`, null, {
        accent: "#ef8a68",
        progress: false,
        valueSize: 16,
      });
      metric(1, 12, 1, 4, "运行", formatDuration(uptime), null, {
        progress: false,
        valueSize: 12,
      });
      break;
    case "system-overview":
    default:
      metric(0, 0, 1, 3, "CPU", formatPercent(cpu), cpu);
      metric(1, 0, 1, 3, "内存", formatPercent(memory), memory);
      metric(0, 3, 1, 3, "GPU", formatPercent(gpu), gpu, { accent: "#73aefd" });
      metric(1, 3, 1, 3, "磁盘", formatPercent(disk), disk, { accent: "#efb95f" });
      drawPresetNetwork(ctx, presetRect(0, 6, 2, 4), metrics, history);
      metric(0, 10, 1, 2, "温度", temperature === null ? "—" : `${Math.round(temperature)}°C`, null, {
        accent: "#ef8a68",
        progress: false,
        valueSize: 11,
      });
      metric(1, 10, 1, 2, "运行", formatDuration(uptime), null, {
        progress: false,
        valueSize: 10,
      });
      drawPresetClock(ctx, presetRect(0, 12, 2, 4));
      break;
  }
}

function formatAiTokens(value) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

function formatAiCost(value) {
  if (!Number.isFinite(value)) return "—";
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}`;
}

function aiScreenEntry(model, prefix, name, accent) {
  return {
    name,
    accent,
    value: model[prefix],
    reset: model[`${prefix}Reset`],
    window: model[`${prefix}Window`],
    todayTokens: model[`${prefix}TodayTokens`],
    todayCostUsd: model[`${prefix}TodayCostUsd`],
    last30DaysTokens: model[`${prefix}Last30DaysTokens`],
    last30DaysCostUsd: model[`${prefix}Last30DaysCostUsd`],
  };
}

function drawAiUsageCard(ctx, top, label, tokens, cost, accent, expanded = false) {
  const height = expanded ? 72 : 40;
  const gradient = ctx.createLinearGradient(14, top, 128, top + 40);
  gradient.addColorStop(0, `${accent}18`);
  gradient.addColorStop(1, `${accent}08`);
  ctx.fillStyle = gradient;
  roundedRect(ctx, 14, top, 114, height, expanded ? 8 : 6);
  ctx.fill();
  ctx.strokeStyle = `${accent}38`;
  ctx.lineWidth = 0.7;
  ctx.stroke();

  if (expanded) {
    drawText(ctx, label, 20, top + 15, 9, accent, 700, "left", 102);
    drawText(ctx, tokens, 71, top + 40, 22, accent, 750, "center", 102);
    drawText(ctx, cost, 71, top + 66, 15, "#c2cdca", 700, "center", 102);
  } else {
    drawText(ctx, label, 20, top + 12, 7, accent, 700, "left", 102);
    drawFittedText(ctx, tokens, 20, top + 31, 13, 11.5, accent, 750, "left", 44);
    drawText(ctx, "/", 67, top + 30, 8, "#687779", 600, "center", 8);
    drawFittedText(ctx, cost, 122, top + 31, 12, 9.5, accent, 700, "right", 53);
  }
}

function drawAiScreen(ctx, model) {
  drawSafeAreaBackground(ctx);
  const codex = aiScreenEntry(model, "codex", "CODEX", "#3edcc5");
  const claude = aiScreenEntry(model, "claude", "CLAUDE", "#ff9866");
  const providerEntries = { codex, claude };
  const entries =
    model.provider === "both"
      ? [codex, claude]
      : [providerEntries[model.provider] ?? codex];

  entries.forEach((entry, index) => {
    const expanded = entries.length === 1;
    const top = expanded ? SCREEN_SAFE_TOP + 28 : SCREEN_SAFE_TOP + 7 + index * 141;
    const resetLabel = entry.reset ?? "等待同步";
    drawText(ctx, entry.name, 18, top + 13, 10, entry.accent, 750, "left", 52);
    drawText(
      ctx,
      Number.isFinite(entry.value) ? `${Math.round(entry.value)}% 剩余` : "— 剩余",
      124,
      top + 13,
      10,
      "#edf7f5",
      700,
      "right",
      52,
    );
    drawProgress(ctx, 18, top + 20, CONTENT_WIDTH, entry.value, entry.accent);
    drawText(
      ctx,
      resetLabel,
      71,
      top + (expanded ? 39 : 37),
      expanded ? 9 : 8,
      expanded ? "#b8c6c7" : "#8fa0a2",
      expanded ? 600 : 500,
      "center",
      CONTENT_WIDTH,
    );
    drawAiUsageCard(
      ctx,
      top + (expanded ? 49 : 44),
      "今日",
      formatAiTokens(entry.todayTokens),
      formatAiCost(entry.todayCostUsd),
      "#4de6d0",
      expanded,
    );
    drawAiUsageCard(
      ctx,
      top + (expanded ? 129 : 88),
      "近 30 天",
      formatAiTokens(entry.last30DaysTokens),
      formatAiCost(entry.last30DaysCostUsd),
      "#ffc66b",
      expanded,
    );
  });

  const now = new Date();
  drawText(
    ctx,
    `${now.getMonth() + 1}月${now.getDate()}日  周${"日一二三四五六"[now.getDay()]}`,
    71,
    379,
    9,
    "#dce9eb",
    600,
    "center",
  );
  drawText(
    ctx,
    now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }),
    71,
    410,
    20,
    "#4de1cc",
    750,
    "center",
  );
}

function drawMetricRow(ctx, label, value, top, percent, accent = "#50d7ad") {
  // 标签和数值共用一行 106px，各留一半，避免 "不可用" 这类较长数值压到标签上。
  drawText(ctx, label, 18, top, 9, "#b6c7ca", 550, "left", 52);
  drawText(ctx, value, 124, top, 10, "#f2fbfa", 650, "right", 52);
  drawProgress(ctx, 18, top + 10, CONTENT_WIDTH, percent, accent);
}

function drawSystemScreen(ctx, model) {
  const memoryPercent = percentOf(model.memoryUsed, model.memoryTotal);
  const diskPercent = percentOf(model.diskUsed, model.diskTotal);
  drawSafeAreaBackground(ctx);
  drawText(ctx, "SYSTEM", 18, 78, 10, "#45d9bd", 700, "left", CONTENT_WIDTH);
  drawText(ctx, "本机状态", 18, 99, 16, "#f2fbfa", 700, "left", CONTENT_WIDTH);
  ctx.fillStyle = "#132b2c";
  roundedRect(ctx, 14, 111, 114, 202, 10);
  ctx.fill();

  drawMetricRow(ctx, "CPU", formatPercent(model.cpuUsage), 135, model.cpuUsage);
  drawMetricRow(ctx, "内存", formatPercent(memoryPercent), 176, memoryPercent);
  const gpuUsage = Number.isFinite(model.gpuUsage) ? model.gpuUsage : null;
  drawMetricRow(
    ctx,
    "GPU",
    gpuUsage === null ? "不可用" : `${Math.round(gpuUsage)}%`,
    217,
    gpuUsage,
    "#67a9ff",
  );
  drawMetricRow(ctx, "磁盘", formatPercent(diskPercent), 258, diskPercent, "#f4b860");

  drawText(ctx, "实时网络", 18, 337, 9, "#8da4a9", 600, "left", CONTENT_WIDTH);
  drawText(ctx, "↓", 18, 366, 13, "#4ddab6", 700);
  drawText(ctx, formatRate(model.networkDown), 35, 366, 11, "#f0fbf9", 650, "left", 89);
  drawText(ctx, "↑", 18, 396, 13, "#67a9ff", 700);
  drawText(ctx, formatRate(model.networkUp), 35, 396, 11, "#f0fbf9", 650, "left", 89);
}

function formatRate(value) {
  if (!Number.isFinite(value)) {
    return "—";
  }
  if (value >= 1024 ** 2) {
    return `${(value / 1024 ** 2).toFixed(1)} MB/s`;
  }
  return `${Math.max(0, value / 1024).toFixed(0)} KB/s`;
}

function drawImageScreen(ctx, image, crop) {
  if (!image) {
    const gradient = ctx.createLinearGradient(0, 0, 142, 428);
    gradient.addColorStop(0, "#143949");
    gradient.addColorStop(1, "#10231f");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 142, 428);
    drawText(ctx, "IMAGE", 71, 184, 12, "#53dfca", 700, "center", CONTENT_WIDTH);
    drawText(ctx, "选择一张图片", 71, 215, 11, "#f2fbfa", 650, "center", CONTENT_WIDTH);
    drawText(ctx, "142 × 428", 71, 239, 9, "#8ba1a7", 500, "center", CONTENT_WIDTH);
    return;
  }

  const source = getCropSourceRect(image, crop);
  ctx.drawImage(
    image,
    source.x,
    source.y,
    source.width,
    source.height,
    0,
    0,
    SCREEN_WIDTH,
    SCREEN_HEIGHT,
  );
}

export async function renderScreenBlob({
  mode,
  ai,
  metrics,
  history = [],
  deviceStatus,
  presetId,
  sourceState = "ready",
  image,
  crop,
  quality = 0.86,
}) {
  const source = document.createElement("canvas");
  source.width = SCREEN_WIDTH * SCALE;
  source.height = SCREEN_HEIGHT * SCALE;
  const sourceContext = source.getContext("2d");
  sourceContext.scale(SCALE, SCALE);
  sourceContext.fillStyle = "#061116";
  sourceContext.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);

  if (mode === "presets") {
    drawPresetScreen(sourceContext, {
      deviceStatus,
      history,
      metrics,
      presetId,
      sourceState,
    });
  } else if (mode === "ai") {
    drawAiScreen(sourceContext, ai);
  } else if (mode === "system") {
    drawSystemScreen(sourceContext, metrics);
  } else {
    drawImageScreen(sourceContext, image, crop);
  }

  const output = document.createElement("canvas");
  output.width = SCREEN_WIDTH;
  output.height = SCREEN_HEIGHT;
  const outputContext = output.getContext("2d");
  outputContext.imageSmoothingEnabled = true;
  outputContext.imageSmoothingQuality = "high";
  outputContext.drawImage(source, 0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);

  return new Promise((resolve, reject) => {
    output.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("JPEG 渲染失败"));
        }
      },
      "image/jpeg",
      quality,
    );
  });
}

export function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve({ image, url });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法读取图片"));
    };
    image.src = url;
  });
}

export { SCREEN_HEIGHT, SCREEN_WIDTH, formatRate };
