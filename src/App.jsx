import {
  Activity,
  Bot,
  Check,
  ChevronDown,
  CircleGauge,
  Clock3,
  Cpu,
  Database,
  HardDrive,
  Image as ImageIcon,
  Keyboard,
  LayoutGrid,
  MemoryStick,
  MonitorCog,
  Move,
  Network,
  RotateCcw,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Square,
  Upload,
  Wifi,
  X,
  Zap,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  checkDevice,
  getAiUsage,
  getSystemMetrics,
  isRunningInTauri,
  pushImage,
} from "./lib/deviceClient";
import {
  formatRate,
  getCropSourceRect,
  loadImageFile,
  renderScreenBlob,
} from "./lib/renderScreen";
import {
  findPreset,
  PRESET_CATEGORIES,
  PRESETS,
} from "./lib/presets";

// 原来这里还有一项「控制台」(id: "dashboard")，但 mode 永远不会等于 "dashboard"
// ——点它只是跳到 AI 额度，高亮态也永远不亮。删掉之后每一项都名副其实。
// group 用来在切换页面和打开弹窗之间画一条分隔线。
const NAV_ITEMS = [
  { id: "presets", label: "预设库", icon: LayoutGrid, group: "mode" },
  { id: "image", label: "图片推送", icon: ImageIcon, group: "mode" },
  { id: "ai", label: "AI 额度", icon: Bot, group: "mode" },
  { id: "system", label: "系统监控", icon: Activity, group: "mode" },
  { id: "fn-shortcuts", label: "FN 组合键", icon: Keyboard, group: "tool" },
  { id: "connection", label: "连接键盘", icon: Wifi, group: "tool" },
];

const FN_SHORTCUT_GROUPS = [
  {
    id: "connection",
    label: "连接与模式",
    hint: "无线通道及有线连接",
    shortcuts: [
      { key: "E", action: "切换蓝牙 1", hold: "长按：蓝牙 2 配对" },
      { key: "R", action: "切换蓝牙 2", hold: "长按：蓝牙 2 配对" },
      { key: "T", action: "切换蓝牙 3", hold: "长按：蓝牙 3 配对" },
      { key: "Y", action: "切换 2.4G", hold: "长按：2.4G 配对" },
      { key: "U", action: "有线模式", detail: "需要连接 USB 线" },
    ],
  },
  {
    id: "system",
    label: "系统与按键",
    hint: "键位布局及系统切换",
    shortcuts: [
      { key: "O", action: "切换 Win / Mac 系统", hold: "长按 3 秒；再次长按切回" },
      { key: "W", action: "WASD / 方向键切换" },
      {
        key: "Backspace",
        action: "恢复出厂设置",
        hold: "长按 5 秒",
        detail: "不会切换当前系统",
        warning: true,
      },
    ],
  },
  {
    id: "media",
    label: "常用功能",
    hint: "声音、工具与截屏",
    shortcuts: [
      { key: "C", action: "打开计算器" },
      { key: "M", action: "静音" },
      { key: "<", action: "音量减小" },
      { key: ">", action: "音量增大" },
      { key: "P", action: "截屏（PrtSc）" },
    ],
  },
  {
    id: "lighting",
    label: "灯光",
    hint: "RGB 彩光快捷调节",
    shortcuts: [
      {
        key: "\\",
        action: "切换灯光颜色",
        detail: "RGB 彩光模式下循环切换 7 种单色与 RGB",
      },
    ],
  },
];

const MODES = [
  {
    id: "image",
    label: "图片推送",
    description: "静态图片与封面",
    icon: ImageIcon,
  },
  {
    id: "ai",
    label: "AI 额度",
    description: "Codex 与 Claude",
    icon: Sparkles,
  },
  {
    id: "system",
    label: "系统监控",
    description: "性能与网络状态",
    icon: MonitorCog,
  },
];

const INITIAL_METRICS = {
  cpuUsage: null,
  memoryUsed: null,
  memoryTotal: null,
  diskUsed: null,
  diskTotal: null,
  networkDown: null,
  networkUp: null,
  uptime: null,
  temperature: null,
  gpuUsage: null,
};

const AI_PROVIDER_DEFINITIONS = [
  {
    id: "codex",
    backendId: "codex",
    prefix: "codex",
    name: "Codex",
    screenName: "CODEX",
    symbol: "◎",
    accent: "#4de6d0",
  },
  {
    id: "claude",
    backendId: "claude",
    prefix: "claude",
    name: "Claude",
    screenName: "CLAUDE",
    symbol: "✳",
    accent: "#ff9866",
  },
];

function emptyAiProvider(prefix) {
  return {
    [prefix]: null,
    [`${prefix}Reset`]: "等待读取真实额度",
    [`${prefix}Window`]: "额度",
    [`${prefix}QuotaSource`]: null,
    [`${prefix}QuotaError`]: null,
    [`${prefix}TodayTokens`]: null,
    [`${prefix}TodayCostUsd`]: null,
    [`${prefix}Last30DaysTokens`]: null,
    [`${prefix}Last30DaysCostUsd`]: null,
    [`${prefix}CostSource`]: null,
    [`${prefix}CostError`]: null,
  };
}

const DEFAULT_AI = {
  provider: "both",
  engine: null,
  fetchedAt: null,
  ...emptyAiProvider("codex"),
  ...emptyAiProvider("claude"),
};

const DEFAULT_CROP = {
  x: 0.5,
  y: 0.5,
  zoom: 1,
};

function usePersistentState(key, initialValue) {
  const [value, setValue] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved ? JSON.parse(saved) : initialValue;
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue];
}

function useAiState() {
  const [ai, setAi] = useState(() => {
    try {
      const previous = JSON.parse(localStorage.getItem("lingxi-ai") ?? "{}");
      const provider = ["codex", "claude", "both"].includes(previous.provider)
        ? previous.provider
        : DEFAULT_AI.provider;
      // 旧版本在这里保存过 51% / 73% 的手动演示值。只迁移用户的显示选择，
      // 绝不把旧百分比继续伪装成真实额度。
      return { ...DEFAULT_AI, provider };
    } catch {
      return DEFAULT_AI;
    }
  });

  useEffect(() => {
    localStorage.setItem(
      "lingxi-ai",
      JSON.stringify({ dataVersion: 2, provider: ai.provider }),
    );
  }, [ai.provider]);

  return [ai, setAi];
}

const DEFAULT_DEVICE = {
  id: "linx68-default",
  name: "Linx68",
  ip: "192.168.6.120",
};

function createDeviceId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeDeviceProfiles(saved) {
  if (saved && Array.isArray(saved.devices)) {
    const devices = saved.devices
      .filter((device) => device && typeof device.ip === "string")
      .map((device) => ({
        id: typeof device.id === "string" && device.id ? device.id : createDeviceId(),
        name: typeof device.name === "string" && device.name.trim() ? device.name.trim() : "Linx68",
        ip: device.ip.trim(),
      }));
    if (devices.length > 0) {
      const activeId = devices.some((device) => device.id === saved.activeId)
        ? saved.activeId
        : devices[0].id;
      return { activeId, devices };
    }
  }

  // 兼容旧版本的 { name, ip } 单设备配置。
  if (saved && typeof saved.ip === "string") {
    const legacyDevice = {
      id: "linx68-default",
      name: typeof saved.name === "string" && saved.name.trim() ? saved.name.trim() : "Linx68",
      ip: saved.ip.trim(),
    };
    return { activeId: legacyDevice.id, devices: [legacyDevice] };
  }

  return { activeId: DEFAULT_DEVICE.id, devices: [DEFAULT_DEVICE] };
}

function readDeviceProfiles() {
  try {
    const savedProfiles = localStorage.getItem("lingxi-devices");
    if (savedProfiles) return normalizeDeviceProfiles(JSON.parse(savedProfiles));

    const legacyDevice = localStorage.getItem("lingxi-device");
    return normalizeDeviceProfiles(legacyDevice ? JSON.parse(legacyDevice) : null);
  } catch {
    return normalizeDeviceProfiles(null);
  }
}

function useDeviceProfiles() {
  const [profiles, setProfiles] = useState(readDeviceProfiles);

  useEffect(() => {
    localStorage.setItem("lingxi-devices", JSON.stringify(profiles));
  }, [profiles]);

  const activeDevice =
    profiles.devices.find((device) => device.id === profiles.activeId) ?? profiles.devices[0];

  const updateActiveDevice = useCallback((patch) => {
    setProfiles((current) => ({
      ...current,
      devices: current.devices.map((device) =>
        device.id === current.activeId ? { ...device, ...patch } : device,
      ),
    }));
  }, []);

  const selectDevice = useCallback((id) => {
    setProfiles((current) => {
      if (!current.devices.some((device) => device.id === id)) return current;
      return { ...current, activeId: id };
    });
  }, []);

  const addDevice = useCallback(() => {
    const device = {
      ...DEFAULT_DEVICE,
      id: createDeviceId(),
      name: `Linx68 ${profiles.devices.length + 1}`,
      ip: "",
    };
    setProfiles((current) => ({
      activeId: device.id,
      devices: [...current.devices, device],
    }));
    return device;
  }, [profiles.devices.length]);

  return {
    activeDevice,
    addDevice,
    devices: profiles.devices,
    selectDevice,
    updateActiveDevice,
  };
}

function formatBytes(bytes, digits = 1) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** unitIndex).toFixed(unitIndex === 0 ? 0 : digits)} ${units[unitIndex]}`;
}

function formatUsageTokens(value) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return Math.round(value).toLocaleString("zh-CN");
}

function formatUsd(value) {
  if (!Number.isFinite(value)) return "—";
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}`;
}

function formatQuotaReset(resetsAt, fallback) {
  const resetTime = resetsAt ? new Date(resetsAt).getTime() : Number.NaN;
  if (!Number.isFinite(resetTime)) return fallback || "重置时间不可用";

  const minutes = Math.max(0, Math.ceil((resetTime - Date.now()) / 60_000));
  if (minutes === 0) return "即将重置";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainingMinutes = minutes % 60;
  if (days > 0) return `${days} 天 ${hours} 小时后`;
  if (hours > 0) return `${hours} 小时 ${remainingMinutes} 分钟后`;
  return `${remainingMinutes} 分钟后`;
}

function formatQuotaMeta(reset) {
  return reset || "等待同步";
}

function formatAiSource(source) {
  const labels = {
    "codex-cli": "Codex CLI",
    api: "API",
    oauth: "OAuth",
    web: "Web",
    local: "本地日志",
  };
  return labels[source] ?? source ?? null;
}

function formatAiError(message) {
  if (!message) return null;
  if (message.includes("No Claude session key")) {
    return "未检测到 Claude 登录会话；Token 与金额仍从本地日志读取";
  }
  if (message.includes("Network error")) {
    return "额度服务暂时无法连接，请稍后刷新";
  }
  if (message.includes("No available fetch strategy")) {
    return "未检测到可用凭据，请先配置该服务的登录令牌或 API Key";
  }
  return message;
}

function providerAiPatch(prefix, provider) {
  const reset = formatQuotaReset(provider?.resetsAt, provider?.resetDescription);
  return {
    [prefix]: provider?.quotaRemainingPercent ?? null,
    [`${prefix}Reset`]: reset,
    [`${prefix}Window`]: provider?.quotaWindow ?? "额度",
    [`${prefix}QuotaSource`]: formatAiSource(provider?.quotaSource),
    [`${prefix}QuotaError`]: formatAiError(provider?.quotaError),
    [`${prefix}TodayTokens`]: provider?.todayTokens ?? null,
    [`${prefix}TodayCostUsd`]: provider?.todayCostUsd ?? null,
    [`${prefix}Last30DaysTokens`]: provider?.last30DaysTokens ?? null,
    [`${prefix}Last30DaysCostUsd`]: provider?.last30DaysCostUsd ?? null,
    [`${prefix}CostSource`]: formatAiSource(provider?.costSource),
    [`${prefix}CostError`]: formatAiError(provider?.costError),
  };
}

function mergeAiSnapshot(current, snapshot) {
  const providers = new Map(
    (snapshot?.providers ?? []).map((provider) => [provider.provider, provider]),
  );
  const providerPatches = AI_PROVIDER_DEFINITIONS.reduce(
    (patches, definition) => ({
      ...patches,
      ...providerAiPatch(
        definition.prefix,
        providers.get(definition.backendId),
      ),
    }),
    {},
  );
  return {
    ...current,
    engine: snapshot?.engine ?? null,
    fetchedAt: snapshot?.fetchedAtEpochMs ?? Date.now(),
    ...providerPatches,
  };
}

function aiProviderView(ai, definition) {
  const { prefix } = definition;
  return {
    ...definition,
    value: ai[prefix],
    reset: ai[`${prefix}Reset`],
    window: ai[`${prefix}Window`],
    quotaSource: ai[`${prefix}QuotaSource`],
    quotaError: ai[`${prefix}QuotaError`],
    todayTokens: ai[`${prefix}TodayTokens`],
    todayCostUsd: ai[`${prefix}TodayCostUsd`],
    last30DaysTokens: ai[`${prefix}Last30DaysTokens`],
    last30DaysCostUsd: ai[`${prefix}Last30DaysCostUsd`],
    costSource: ai[`${prefix}CostSource`],
    costError: ai[`${prefix}CostError`],
  };
}

function selectedAiProviders(ai) {
  const definitions =
    ai.provider === "both"
      ? AI_PROVIDER_DEFINITIONS.slice(0, 2)
      : AI_PROVIDER_DEFINITIONS.filter((provider) => provider.id === ai.provider);
  return definitions.map((definition) => aiProviderView(ai, definition));
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function ratioPercent(used, total) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return clampPercent((used / total) * 100);
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${Math.round(value)}%` : "不可用";
}

// GPU 采集依赖平台传感器：拿不到时返回 null，让 UI 显示「不可用」而不是伪装成 0%。
function gpuPercent(metrics) {
  return Number.isFinite(metrics.gpuUsage) ? clampPercent(metrics.gpuUsage) : null;
}

function AppLogo() {
  return (
    <div className="brand">
      <div className="brand-mark" aria-hidden="true">
        <span />
        <span />
      </div>
      <div>
        <strong>灵犀小屏屏</strong>
        <small>Display Studio</small>
      </div>
    </div>
  );
}

function Sidebar({
  activeDialog,
  mode,
  device,
  deviceStatus,
  statusSummary,
  onNavigate,
  onOpenSettings,
  onRequestConnection,
}) {
  return (
    <aside className="sidebar">
      <AppLogo />
      <nav className="side-nav" aria-label="主导航">
        {NAV_ITEMS.map((item, index) => {
          const Icon = item.icon;
          const active = item.id === mode || item.id === activeDialog;
          const startsToolGroup =
            item.group === "tool" && NAV_ITEMS[index - 1]?.group !== "tool";
          return (
            <button
              // 窄窗口下文字会被隐藏成纯图标，title 同时兼顾悬停提示和可访问名称
              aria-expanded={item.group === "tool" ? active : undefined}
              aria-haspopup={item.group === "tool" ? "dialog" : undefined}
              aria-label={item.label}
              aria-pressed={active}
              className={`nav-item ${active ? "active" : ""} ${
                startsToolGroup ? "group-start" : ""
              }`}
              key={item.id}
              onClick={() => onNavigate(item.id)}
              title={item.label}
              type="button"
            >
              <Icon size={19} strokeWidth={1.8} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        {statusSummary}
        <div className="device-card">
          <div className="device-card-top">
            <div className="device-name">
              <span className={`status-dot ${deviceStatus.online ? "online" : ""}`} />
              <strong>{device.name}</strong>
            </div>
            <div className="device-card-actions">
              <button
                aria-haspopup="dialog"
                aria-label="设备设置"
                className="icon-button"
                onClick={onOpenSettings}
                title="设备设置"
                type="button"
              >
                <Settings size={15} />
              </button>
              <button
                aria-haspopup="dialog"
                aria-label={deviceStatus.online ? "重新检测键盘" : "连接键盘"}
                className={`icon-button ${deviceStatus.checking ? "spinning" : ""}`}
                onClick={() => onRequestConnection()}
                title={deviceStatus.online ? "重新检测键盘" : "连接键盘"}
                type="button"
              >
                <RefreshCw size={15} />
              </button>
            </div>
          </div>
          <span className="device-ip">{device.ip}</span>
          <div className="device-card-bottom">
            <span className={deviceStatus.online ? "online-text" : "offline-text"}>
              {deviceStatus.checking ? "检测中" : deviceStatus.online ? "在线" : "离线"}
            </span>
            <Wifi size={18} />
          </div>
        </div>
      </div>
    </aside>
  );
}

function PreviewSummary({
  activeMode,
  activePreset,
  autoPush,
  deviceStatus,
  metricsStatus,
  mode,
  previewModeInfo,
}) {
  return (
    <div
      className={`preview-summary sidebar-summary ${
        mode === "presets" ? "three-state" : ""
      }`}
    >
      <div>
        <span>{mode === "presets" ? "电脑预览" : "当前内容"}</span>
        <strong>
          {autoPush
            ? `${previewModeInfo.label} · 刷新中`
            : mode === "presets"
              ? activePreset.name
              : activeMode.label}
        </strong>
      </div>
      <div>
        <span>{mode === "presets" ? "电脑数据" : "设备延迟"}</span>
        <strong>
          {mode === "presets"
            ? metricsStatus === "ready"
              ? "实时采集"
              : metricsStatus === "loading"
                ? "采集中"
                : "仅布局"
            : Number.isFinite(deviceStatus.latencyMs)
              ? `${deviceStatus.latencyMs} ms`
              : "—"}
        </strong>
      </div>
      {mode === "presets" && (
        <div>
          <span>键盘屏幕</span>
          <strong className={deviceStatus.online ? "state-online" : "state-offline"}>
            {deviceStatus.online ? "可发送" : "未连接"}
          </strong>
        </div>
      )}
    </div>
  );
}

function QuotaCard({ provider, status }) {
  const {
    accent,
    costError,
    costSource,
    id,
    last30DaysCostUsd,
    last30DaysTokens,
    name,
    quotaError,
    quotaSource,
    reset,
    symbol,
    todayCostUsd,
    todayTokens,
    value,
    window,
  } = provider;
  const hasQuota = Number.isFinite(value);
  const displayValue = hasQuota ? clampPercent(value) : 0;
  const source = quotaSource || costSource;
  const chipLabel =
    status === "loading" && !source
      ? "读取中"
      : source
        ? `真实 · ${source}`
        : "未连接";

  return (
    <article
      className={`quota-card provider-${id} ${hasQuota ? "" : "quota-unavailable"}`}
      style={{ "--provider-card-accent": accent }}
    >
      <div className="quota-card-head">
        <div className="service-name">
          <span className="service-logo">{symbol}</span>
          <strong>{name}</strong>
        </div>
        <span className={`sync-chip ${source ? "live" : ""}`}>{chipLabel}</span>
      </div>
      <span className="eyebrow">{window} · 剩余</span>
      <div className="quota-value">
        <strong>{hasQuota ? Math.round(value) : "—"}</strong>
        {hasQuota && <span>%</span>}
      </div>
      <div
        aria-label={`${name} 剩余额度`}
        aria-valuemax={hasQuota ? 100 : undefined}
        aria-valuemin={hasQuota ? 0 : undefined}
        aria-valuenow={hasQuota ? Math.round(displayValue) : undefined}
        className="quota-progress-track"
        role={hasQuota ? "progressbar" : undefined}
      >
        <span style={{ width: `${displayValue}%` }} />
      </div>
      <div className="quota-meta">
        <span>重置时间</span>
        <strong>{hasQuota ? reset : "额度来源未连接"}</strong>
      </div>
      <div className="usage-summary">
        <div className="usage-period">
          <span>今日</span>
          <div>
            <small>Token</small>
            <strong>{formatUsageTokens(todayTokens)}</strong>
          </div>
          <div>
            <small>金额</small>
            <strong>{formatUsd(todayCostUsd)}</strong>
          </div>
        </div>
        <div className="usage-period">
          <span>近 30 天</span>
          <div>
            <small>Token</small>
            <strong>{formatUsageTokens(last30DaysTokens)}</strong>
          </div>
          <div>
            <small>金额</small>
            <strong>{formatUsd(last30DaysCostUsd)}</strong>
          </div>
        </div>
      </div>
      {(quotaError || costError) && (
        <p className="quota-source-warning">
          {quotaError && Number.isFinite(todayTokens)
            ? `额度未连接：${quotaError}`
            : quotaError || costError}
        </p>
      )}
    </article>
  );
}

function AiConfiguration({ ai, error, onRefresh, setAi, status }) {
  const providers = selectedAiProviders(ai);
  const updatedLabel = ai.fetchedAt
    ? new Date(ai.fetchedAt).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <section className="config-panel">
      <div className="panel-heading">
        <div>
          <span className="section-kicker">CONTENT SOURCE</span>
          <h2>AI 额度</h2>
        </div>
        <div className="ai-data-actions">
          <span className={`ai-data-state ${status}`}>
            {status === "loading"
              ? "正在读取本机数据"
              : updatedLabel
                ? `${ai.engine ?? "本地引擎"} · ${updatedLabel}`
                : "等待首次读取"}
          </span>
          <button
            aria-label="刷新 AI 额度与用量"
            className="ai-refresh-button"
            disabled={status === "loading"}
            onClick={onRefresh}
            type="button"
          >
            <RefreshCw className={status === "loading" ? "spin" : ""} size={14} />
            刷新
          </button>
        </div>
      </div>

      <div className="segmented ai-provider-tabs" role="tablist" aria-label="AI 服务选择">
        {[
          ["both", "Codex + Claude"],
          ...AI_PROVIDER_DEFINITIONS.map((provider) => [provider.id, provider.name]),
        ].map(([value, label]) => (
          <button
            className={ai.provider === value ? "active" : ""}
            key={value}
            onClick={() => setAi((current) => ({ ...current, provider: value }))}
            role="tab"
            type="button"
          >
            {label}
          </button>
        ))}
      </div>

      {error && <div className="ai-data-error">{error}</div>}

      <div className={`quota-grid ${providers.length === 1 ? "single" : ""}`}>
        {providers.map((provider) => (
          <QuotaCard key={provider.name} provider={provider} status={status} />
        ))}
      </div>
      <p className="ai-cost-note">
        Token 来自本机 Codex / Claude JSONL 日志；金额按对应模型 API 单价估算，不等同于订阅账单。
      </p>
    </section>
  );
}

function RefreshIntervalControl({ refreshInterval, setRefreshInterval }) {
  return (
    <div className="setting-row preview-refresh-setting">
      <div className="setting-copy">
        <span className="setting-icon">
          <Clock3 size={17} />
        </span>
        <div>
          <strong>刷新间隔</strong>
          <small>仅在内容变化时写入设备</small>
        </div>
      </div>
      <label className="select-control">
        <select
          aria-label="刷新间隔"
          onChange={(event) => setRefreshInterval(Number(event.target.value))}
          value={refreshInterval}
        >
          <option value={15}>15 秒</option>
          <option value={30}>30 秒</option>
          <option value={60}>60 秒</option>
          <option value={300}>5 分钟</option>
        </select>
        <ChevronDown size={14} />
      </label>
    </div>
  );
}

function clampCropValue(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function ImageCropper({ selectedImage, crop, onCropChange, onChooseImage, onDropFile }) {
  const inputRef = useRef(null);
  const dragRef = useRef(null);
  const editorRef = useRef(null);
  const dropDepthRef = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [editorSize, setEditorSize] = useState({ width: 0, height: 0 });
  const image = selectedImage?.image;
  const sourceRect = useMemo(
    () => (image ? getCropSourceRect(image, crop) : null),
    [crop, image],
  );

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return undefined;

    const updateSize = () => {
      const { width, height } = editor.getBoundingClientRect();
      setEditorSize({ width, height });
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(editor);
    return () => observer.disconnect();
  }, []);

  const cropFrame = useMemo(() => {
    if (!editorSize.width || !editorSize.height) return null;
    const height = Math.max(0, editorSize.height - 32);
    const width = height * (142 / 428);
    return {
      height,
      width,
      left: (editorSize.width - width) / 2,
      top: 16,
    };
  }, [editorSize]);

  const updateZoom = (nextZoom) => {
    onCropChange((current) => ({
      ...current,
      zoom: clampCropValue(nextZoom, 1, 4),
    }));
  };

  const handlePointerDown = (event) => {
    if (!image || !sourceRect) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      sourceRect,
      viewportWidth: event.currentTarget.getBoundingClientRect().width,
    };
    setDragging(true);
  };

  const handlePointerMove = (event) => {
    if (!dragRef.current || !image) return;
    const start = dragRef.current;
    const displayScale = start.viewportWidth / start.sourceRect.width;
    const nextSourceX = start.sourceRect.x - (event.clientX - start.pointerX) / displayScale;
    const nextSourceY = start.sourceRect.y - (event.clientY - start.pointerY) / displayScale;
    onCropChange((current) => ({
      ...current,
      x: clampCropValue(
        (nextSourceX + start.sourceRect.width / 2) / image.width,
        0,
        1,
      ),
      y: clampCropValue(
        (nextSourceY + start.sourceRect.height / 2) / image.height,
        0,
        1,
      ),
    }));
  };

  const finishDragging = (event) => {
    if (dragRef.current && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setDragging(false);
  };

  const moveImageWithKeyboard = (event) => {
    if (!image || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const step = event.shiftKey ? 0.05 : 0.012;
    const directions = {
      ArrowLeft: { x: step, y: 0 },
      ArrowRight: { x: -step, y: 0 },
      ArrowUp: { x: 0, y: step },
      ArrowDown: { x: 0, y: -step },
    };
    const direction = directions[event.key];
    onCropChange((current) => ({
      ...current,
      x: clampCropValue(current.x + direction.x, 0, 1),
      y: clampCropValue(current.y + direction.y, 0, 1),
    }));
  };

  // dragenter/dragleave 会在每个子元素边界上成对触发，光靠布尔量会在
  // 越过遮罩、裁切框时闪断。用进出计数配平，只有真正离开编辑区才熄灭高亮。
  const handleDragEnter = (event) => {
    event.preventDefault();
    dropDepthRef.current += 1;
    setDropping(true);
  };

  const handleDragLeave = (event) => {
    event.preventDefault();
    dropDepthRef.current = Math.max(0, dropDepthRef.current - 1);
    if (dropDepthRef.current === 0) setDropping(false);
  };

  const handleDrop = (event) => {
    event.preventDefault();
    dropDepthRef.current = 0;
    setDropping(false);
    onDropFile(event.dataTransfer.files?.[0]);
  };

  const cropImageStyle =
    image && sourceRect && cropFrame
      ? {
          width: `${(image.width / sourceRect.width) * cropFrame.width}px`,
          height: `${(image.height / sourceRect.height) * cropFrame.height}px`,
          left: `${cropFrame.left - (sourceRect.x / sourceRect.width) * cropFrame.width}px`,
          top: `${cropFrame.top - (sourceRect.y / sourceRect.height) * cropFrame.height}px`,
        }
      : undefined;

  const cropFrameStyle = cropFrame
    ? {
        width: `${cropFrame.width}px`,
        height: `${cropFrame.height}px`,
        left: `${cropFrame.left}px`,
        top: `${cropFrame.top}px`,
      }
    : undefined;

  const cropMaskStyles = cropFrame
    ? {
        top: { height: `${cropFrame.top}px` },
        bottom: { top: `${cropFrame.top + cropFrame.height}px` },
        left: {
          width: `${cropFrame.left}px`,
          top: `${cropFrame.top}px`,
          height: `${cropFrame.height}px`,
        },
        right: {
          left: `${cropFrame.left + cropFrame.width}px`,
          top: `${cropFrame.top}px`,
          height: `${cropFrame.height}px`,
        },
      }
    : {};

  return (
    <>
      <div
        className={`crop-editor ${selectedImage ? "has-image" : ""} ${
          dropping ? "dropping" : ""
        }`}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
        ref={editorRef}
      >
        {selectedImage ? (
          <img
            alt="正在裁切的图片"
            className="crop-editor-image"
            draggable="false"
            src={selectedImage.url}
            style={cropImageStyle}
          />
        ) : null}
        {selectedImage ? (
          <>
            <span aria-hidden="true" className="crop-mask top" style={cropMaskStyles.top} />
            <span aria-hidden="true" className="crop-mask bottom" style={cropMaskStyles.bottom} />
            <span aria-hidden="true" className="crop-mask left" style={cropMaskStyles.left} />
            <span aria-hidden="true" className="crop-mask right" style={cropMaskStyles.right} />
            <div
              aria-label="图片裁切区域。拖动图片调整位置，使用滚轮或下方滑块缩放。"
              className={`crop-viewport ${dragging ? "dragging" : ""}`}
              onKeyDown={moveImageWithKeyboard}
              onPointerCancel={finishDragging}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={finishDragging}
              onWheel={(event) => {
                event.preventDefault();
                updateZoom(crop.zoom + (event.deltaY > 0 ? -0.12 : 0.12));
              }}
              role="application"
              style={cropFrameStyle}
              tabIndex={0}
            />
            <button
              className="crop-replace-button"
              onClick={() => inputRef.current?.click()}
              type="button"
            >
              <Upload size={14} />
              更换图片
            </button>
          </>
        ) : (
          <button
            className="crop-empty"
            onClick={() => inputRef.current?.click()}
            type="button"
          >
            <span className="upload-orb">
              <Upload size={25} />
            </span>
            <strong>选择或拖入一张图片</strong>
            <small>支持 JPG、PNG 与 WebP，载入后可自由调整裁切</small>
          </button>
        )}
        {dropping ? (
          <div className="crop-drop-overlay">
            <Upload size={20} />
            <strong>松开即可载入</strong>
          </div>
        ) : null}
      </div>

      {selectedImage ? (
        <div className="crop-toolbar">
          <div className="crop-hint">
            <Move size={15} />
            <span>拖动图片调整展示区域</span>
          </div>
          <div className="crop-zoom">
            <ZoomOut size={14} aria-hidden="true" />
            <input
              aria-label="图片缩放"
              max="4"
              min="1"
              onChange={(event) => updateZoom(Number(event.target.value))}
              step="0.01"
              type="range"
              value={crop.zoom}
            />
            <ZoomIn size={14} aria-hidden="true" />
            <span>{crop.zoom.toFixed(1)}×</span>
            <button
              aria-label="重置裁切"
              onClick={() => onCropChange(DEFAULT_CROP)}
              title="重置裁切"
              type="button"
            >
              <RotateCcw size={14} />
            </button>
          </div>
        </div>
      ) : null}

      <input
        accept="image/jpeg,image/png,image/webp"
        hidden
        onChange={onChooseImage}
        ref={inputRef}
        type="file"
      />
    </>
  );
}

function ImageConfiguration({
  selectedImage,
  imageName,
  crop,
  onCropChange,
  quality,
  setQuality,
  onChooseImage,
  onDropFile,
}) {
  return (
    <section className="config-panel image-config-panel">
      <div className="panel-heading">
        <div>
          <span className="section-kicker">IMAGE SOURCE</span>
          <h2>图片推送</h2>
        </div>
        <span className="format-chip">JPEG</span>
      </div>

      <ImageCropper
        crop={crop}
        onChooseImage={onChooseImage}
        onCropChange={onCropChange}
        onDropFile={onDropFile}
        selectedImage={selectedImage}
      />

      <div className="image-options">
        <div className="image-info">
          <span>当前文件</span>
          <strong>{imageName || "尚未选择"}</strong>
        </div>
        <div className="image-info">
          <span>适配方式</span>
          <strong>{selectedImage ? `自由裁切 · ${crop.zoom.toFixed(1)}×` : "自由裁切"}</strong>
        </div>
      </div>

      <div className="quality-row">
        <div>
          <strong>JPEG 质量</strong>
          <small>兼顾文字清晰度和推送速度</small>
        </div>
        <div className="quality-control">
          <input
            max="95"
            min="55"
            onChange={(event) => setQuality(Number(event.target.value))}
            type="range"
            value={quality}
          />
          <span>{quality}%</span>
        </div>
      </div>
    </section>
  );
}

function MetricCard({ icon: Icon, label, value, detail, percent }) {
  const progress = Number.isFinite(percent) ? Math.min(100, Math.max(3, percent)) : 0;
  return (
    <article className="metric-card">
      <div className="metric-card-head">
        <span className="metric-icon">
          <Icon size={18} />
        </span>
        <span>{label}</span>
      </div>
      <strong className="metric-value">{value}</strong>
      <span className="metric-detail">{detail}</span>
      <div className="mini-progress">
        <span style={{ width: `${progress}%` }} />
      </div>
    </article>
  );
}

function SystemConfiguration({ metrics, refreshInterval, setRefreshInterval }) {
  const memoryPercent = ratioPercent(metrics.memoryUsed, metrics.memoryTotal);
  const diskPercent = ratioPercent(metrics.diskUsed, metrics.diskTotal);
  const gpuValue = gpuPercent(metrics);

  return (
    <section className="config-panel">
      <div className="panel-heading">
        <div>
          <span className="section-kicker">LIVE METRICS</span>
          <h2>系统监控</h2>
        </div>
        <span className="live-chip">
          <span /> 实时
        </span>
      </div>

      <div className="metrics-grid">
        <MetricCard
          detail={`${navigator.hardwareConcurrency || 8} 线程`}
          icon={Cpu}
          label="CPU"
          percent={metrics.cpuUsage}
          value={formatPercent(metrics.cpuUsage)}
        />
        <MetricCard
          detail={
            Number.isFinite(metrics.memoryUsed) && Number.isFinite(metrics.memoryTotal)
              ? `${formatBytes(metrics.memoryUsed)} / ${formatBytes(metrics.memoryTotal)}`
              : "等待真实数据"
          }
          icon={MemoryStick}
          label="内存"
          percent={memoryPercent}
          value={formatPercent(memoryPercent)}
        />
        <MetricCard
          detail={
            Number.isFinite(metrics.diskUsed) && Number.isFinite(metrics.diskTotal)
              ? `${formatBytes(metrics.diskTotal - metrics.diskUsed)} 可用`
              : "等待真实数据"
          }
          icon={HardDrive}
          label="磁盘"
          percent={diskPercent}
          value={formatPercent(diskPercent)}
        />
        <MetricCard
          detail={`上传 ${formatRate(metrics.networkUp)}`}
          icon={Network}
          label="下载速度"
          percent={
            Number.isFinite(metrics.networkDown)
              ? Math.min(100, (metrics.networkDown / 1024 ** 2) * 6)
              : null
          }
          value={formatRate(metrics.networkDown)}
        />
      </div>

      <div className="network-strip">
        <div>
          <span className="network-arrow down">↓</span>
          <span>下载</span>
          <strong>{formatRate(metrics.networkDown)}</strong>
        </div>
        <div>
          <span className="network-arrow up">↑</span>
          <span>上传</span>
          <strong>{formatRate(metrics.networkUp)}</strong>
        </div>
        <div>
          <Zap size={16} />
          <span>GPU</span>
          <strong>{gpuValue === null ? "不可用" : `${Math.round(gpuValue)}%`}</strong>
        </div>
      </div>

      <div className="setting-row compact">
        <div className="setting-copy">
          <span className="setting-icon">
            <RefreshCw size={17} />
          </span>
          <div>
            <strong>采样频率</strong>
            <small>推荐每秒采集，内容变化后再推送</small>
          </div>
        </div>
        <label className="select-control">
          <select
            onChange={(event) => setRefreshInterval(Number(event.target.value))}
            value={refreshInterval}
          >
            <option value={1}>1 秒</option>
            <option value={2}>2 秒</option>
            <option value={5}>5 秒</option>
          </select>
          <ChevronDown size={14} />
        </label>
      </div>
    </section>
  );
}

function PresetThumbnail({
  deviceStatus,
  history,
  metrics,
  preset,
  sourceState,
}) {
  const [thumbnailUrl, setThumbnailUrl] = useState("");

  useEffect(() => {
    let cancelled = false;
    let nextUrl = "";

    renderScreenBlob({
      deviceStatus,
      history,
      metrics,
      mode: "presets",
      presetId: preset.id,
      quality: 0.78,
      sourceState,
    })
      .then((blob) => {
        if (cancelled) return;
        nextUrl = URL.createObjectURL(blob);
        setThumbnailUrl(nextUrl);
      })
      .catch(() => {
        if (!cancelled) setThumbnailUrl("");
      });

    return () => {
      cancelled = true;
      if (nextUrl) URL.revokeObjectURL(nextUrl);
    };
  }, [deviceStatus, history, metrics, preset.id, sourceState]);

  return (
    <div className="preset-thumbnail">
      {thumbnailUrl ? (
        <img alt={`${preset.name}预设`} src={thumbnailUrl} />
      ) : (
        <div className="preset-thumbnail-loading">
          <RefreshCw className="button-spinner" size={16} />
        </div>
      )}
    </div>
  );
}

function PresetLibrary({
  deviceStatus,
  history,
  lastMetricsAt,
  metrics,
  metricsError,
  metricsStatus,
  onSelect,
  selectedPresetId,
}) {
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visiblePresets = PRESETS.filter((preset) => {
    const matchesCategory = category === "all" || preset.category === category;
    const matchesQuery =
      !normalizedQuery ||
      `${preset.name}${preset.description}${preset.sources.join("")}`
        .toLocaleLowerCase("zh-CN")
        .includes(normalizedQuery);
    return matchesCategory && matchesQuery;
  });
  const sourceReady = metricsStatus === "ready";
  const sourceLoading = metricsStatus === "loading";
  const sourceTitle = sourceReady
    ? "电脑数据实时更新"
    : sourceLoading
      ? "正在采集电脑数据"
      : "布局预览仍然可用";
  const sourceDetail =
    sourceReady && lastMetricsAt
      ? `采样于 ${lastMetricsAt.toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })}`
      : sourceLoading
        ? "桌面应用正在读取本机系统指标"
        : "启动桌面应用后自动填入真实数据";

  return (
    <section className="preset-library">
      <div className="preset-library-head">
        <div>
          <span className="section-kicker">READY-MADE SCREENS</span>
          <h2>成品预设库</h2>
          <p>先在电脑上直接预览，确认无误后再连接键盘并发送。</p>
        </div>
        <div
          className={`real-source-status ${
            sourceReady ? "ready" : sourceLoading ? "loading" : "previewing"
          }`}
        >
          <Database size={15} />
          <span>
            <strong>{sourceTitle}</strong>
            <small title={metricsError || sourceDetail}>{sourceDetail}</small>
          </span>
        </div>
      </div>

      <div className="preset-toolbar">
        <label className="preset-search">
          <Search size={15} />
          <input
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索预设"
            type="search"
            value={query}
          />
        </label>
        <div className="preset-filters" role="tablist" aria-label="预设分类">
          {PRESET_CATEGORIES.map((item) => (
            <button
              aria-selected={category === item.id}
              className={category === item.id ? "active" : ""}
              key={item.id}
              onClick={() => setCategory(item.id)}
              role="tab"
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="preset-grid">
        {visiblePresets.map((preset) => {
          const selected = preset.id === selectedPresetId;
          return (
            <article
              aria-label={`选择${preset.name}`}
              aria-pressed={selected}
              className={`preset-card ${selected ? "selected" : ""}`}
              key={preset.id}
              onClick={() => onSelect(preset.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") onSelect(preset.id);
              }}
              role="button"
              tabIndex={0}
            >
              <div className="preset-card-preview">
                <PresetThumbnail
                  deviceStatus={deviceStatus}
                  history={history}
                  metrics={metrics}
                  preset={preset}
                  sourceState={metricsStatus}
                />
                <span
                  className={`preset-live-badge ${
                    sourceReady ? "ready" : "previewing"
                  }`}
                >
                  <i />
                  {sourceReady ? "电脑实时" : "布局预览"}
                </span>
                {selected && <span className="preset-selected-badge">已选择</span>}
              </div>
              <div className="preset-card-copy">
                <strong>{preset.name}</strong>
                <p>{preset.description}</p>
                <div className="preset-source-chips">
                  {preset.sources.map((source) => (
                    <span key={source}>{source}</span>
                  ))}
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {!visiblePresets.length && (
        <div className="preset-empty">
          <Search size={20} />
          <strong>没有匹配的预设</strong>
          <span>请尝试其他关键词或分类</span>
        </div>
      )}
    </section>
  );
}

function AiScreen({ ai }) {
  const entries = useMemo(
    () =>
      selectedAiProviders(ai).map((provider) => ({
        ...provider,
        name: provider.screenName,
      })),
    [ai],
  );

  return (
    <div className={`screen-ai entries-${entries.length}`}>
      <ScreenStatusBar />
      <div className="screen-ai-body">
        {entries.map((entry) => (
          <div className="screen-quota" data-provider={entry.id} key={entry.name}>
            <div className="screen-quota-head">
              <strong className="screen-service">{entry.name}</strong>
              <span className="screen-quota-compact">
                <strong>
                  {Number.isFinite(entry.value) ? `${Math.round(entry.value)}%` : "—"}
                </strong>
                剩余
              </span>
            </div>
            <div className="screen-progress">
              <span
                style={{
                  width: `${Number.isFinite(entry.value) ? clampPercent(entry.value) : 0}%`,
                }}
              />
            </div>
            <small className="screen-quota-meta">
              {formatQuotaMeta(entry.reset)}
            </small>
            <div className="screen-usage-rows">
              <span className="is-today">
                <small>今日</small>
                <strong>
                  <b>{formatUsageTokens(entry.todayTokens)}</b>
                  <i>/</i>
                  <b>{formatUsd(entry.todayCostUsd)}</b>
                </strong>
              </span>
              <span className="is-month">
                <small>近 30 天</small>
                <strong>
                  <b>{formatUsageTokens(entry.last30DaysTokens)}</b>
                  <i>/</i>
                  <b>{formatUsd(entry.last30DaysCostUsd)}</b>
                </strong>
              </span>
            </div>
          </div>
        ))}
      </div>
      <ScreenClock />
    </div>
  );
}

function ScreenStatusBar() {
  return (
    <div className="screen-status">
      <Wifi size={13} strokeWidth={2.4} />
      <div className="screen-battery">
        <span />
      </div>
    </div>
  );
}

function ScreenClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="screen-clock">
      <span>
        {now.getMonth() + 1}月{now.getDate()}日 周{"日一二三四五六"[now.getDay()]}
      </span>
      <strong>
        {now.toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })}
      </strong>
    </div>
  );
}

function SystemScreen({ metrics }) {
  const rows = [
    ["CPU", metrics.cpuUsage],
    ["内存", ratioPercent(metrics.memoryUsed, metrics.memoryTotal)],
    ["GPU", gpuPercent(metrics)],
    ["磁盘", ratioPercent(metrics.diskUsed, metrics.diskTotal)],
  ];
  return (
    <div className="screen-system">
      <ScreenStatusBar />
      <span className="screen-label">SYSTEM</span>
      <strong className="screen-title">本机状态</strong>
      <div className="screen-metrics">
        {rows.map(([label, value]) => (
          <div className="screen-metric-row" key={label}>
            <div>
              <span>{label}</span>
              <strong>{formatPercent(value)}</strong>
            </div>
            <div className="screen-progress">
              <span style={{ width: `${value === null ? 0 : clampPercent(value)}%` }} />
            </div>
          </div>
        ))}
      </div>
      <div className="screen-network">
        <span>实时网络</span>
        <strong>↓ {formatRate(metrics.networkDown)}</strong>
        <strong>↑ {formatRate(metrics.networkUp)}</strong>
      </div>
    </div>
  );
}

function ImageScreen({ selectedImage, crop }) {
  const image = selectedImage?.image;
  const sourceRect = image ? getCropSourceRect(image, crop) : null;
  const previewStyle =
    image && sourceRect
      ? {
          width: `${(image.width / sourceRect.width) * 100}%`,
          height: `${(image.height / sourceRect.height) * 100}%`,
          left: `${(-sourceRect.x / sourceRect.width) * 100}%`,
          top: `${(-sourceRect.y / sourceRect.height) * 100}%`,
        }
      : undefined;

  return (
    <div className="screen-image">
      {selectedImage ? (
        <img
          alt="小屏图片预览"
          className="screen-cropped-image"
          src={selectedImage.url}
          style={previewStyle}
        />
      ) : (
        <div className="screen-empty">
          <ImageIcon size={24} />
          <strong>IMAGE</strong>
          <span>选择一张图片</span>
          <small>142 × 428</small>
        </div>
      )}
    </div>
  );
}

function ScreenPreview({
  mode,
  ai,
  metrics,
  selectedImage,
  crop,
  blobSize,
  renderedUrl,
  deviceStatus,
}) {
  return (
    <div className="preview-stage">
      <div className="keyboard-photo-preview">
        <img
          alt="Linx68 键盘产品渲染"
          className="keyboard-product-image"
          src="/assets/linx68-product-render.png"
        />
        <div className="photo-screen-slot">
          <div className="photo-screen-glass">
            {mode === "presets" && renderedUrl && (
              <img
                alt="成品预设真实渲染预览"
                className="preset-screen-render"
                src={renderedUrl}
              />
            )}
            {mode === "ai" && <AiScreen ai={ai} />}
            {mode === "system" && <SystemScreen metrics={metrics} />}
            {mode === "image" && <ImageScreen crop={crop} selectedImage={selectedImage} />}
          </div>
        </div>
      </div>
      <div className="preview-meta">
        <span>142 × 428</span>
        <span>JPEG {formatBytes(blobSize || 0)}</span>
        <span className={deviceStatus.online ? "connected" : "disconnected"}>
          <i /> {deviceStatus.online ? "已连接" : "未连接"}
        </span>
      </div>
    </div>
  );
}

const TOAST_DISMISS_MS = 3200;

function Toast({ toast, onClose }) {
  const isError = toast?.type === "error";

  useEffect(() => {
    // 失败提示不自动消失。设备离线、IP 写错这类问题需要用户真正处理，
    // 3.2 秒一闪而过很容易漏掉；成功推送本来就有「上次推送 HH:MM:SS」留痕，飘过即可。
    if (!toast || isError) return undefined;
    const timer = window.setTimeout(onClose, TOAST_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [isError, onClose, toast]);

  if (!toast) return null;
  return (
    <div className={`toast ${toast.type}`} role={isError ? "alert" : "status"}>
      <span className="toast-icon">
        {isError ? <X size={16} /> : <Check size={16} />}
      </span>
      <div>
        <strong>{toast.title}</strong>
        <small>{toast.message}</small>
      </div>
      <button aria-label="关闭提示" onClick={onClose} type="button">
        <X size={15} />
      </button>
    </div>
  );
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function Modal({ children, className = "", labelId, onClose }) {
  const modalRef = useRef(null);

  useEffect(() => {
    const node = modalRef.current;
    const previouslyFocused = document.activeElement;
    node?.querySelector(FOCUSABLE_SELECTOR)?.focus();

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !node) return;
      // 弹窗打开时背后仍有十几个可聚焦控件，不拦截的话 Tab 会直接走出去。
      const focusable = [...node.querySelectorAll(FOCUSABLE_SELECTOR)].filter(
        (element) => element.offsetParent !== null,
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      // 关闭后把焦点还给触发弹窗的那个按钮，否则焦点会掉回 body
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        aria-labelledby={labelId}
        aria-modal="true"
        className={`modal ${className}`}
        onMouseDown={(event) => event.stopPropagation()}
        ref={modalRef}
        role="dialog"
      >
        {children}
      </section>
    </div>
  );
}

function FnShortcutsDialog({ onClose }) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visibleGroups = FN_SHORTCUT_GROUPS.map((group) => ({
    ...group,
    shortcuts: group.shortcuts.filter((shortcut) =>
      [shortcut.key, shortcut.action, shortcut.hold, shortcut.detail]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase("zh-CN")
        .includes(normalizedQuery),
    ),
  })).filter((group) => group.shortcuts.length > 0);
  const shortcutCount = FN_SHORTCUT_GROUPS.reduce(
    (total, group) => total + group.shortcuts.length,
    0,
  );

  return (
    <Modal className="fn-shortcuts-modal" labelId="fn-shortcuts-title" onClose={onClose}>
      <div className="modal-head fn-shortcuts-head">
        <div className="fn-shortcuts-title">
          <span className="fn-title-icon" aria-hidden="true">
            Fn
          </span>
          <div>
            <span className="section-kicker">QUICK REFERENCE · {shortcutCount} 项</span>
            <h2 id="fn-shortcuts-title">FN 组合键</h2>
          </div>
        </div>
        <button aria-label="关闭" className="icon-button" onClick={onClose} type="button">
          <X size={18} />
        </button>
      </div>

      <div className="fn-shortcuts-toolbar">
        <label className="fn-shortcuts-search">
          <Search size={16} aria-hidden="true" />
          <input
            aria-label="搜索 FN 组合键"
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索按键或功能…"
            value={query}
          />
          {query && (
            <button aria-label="清空搜索" onClick={() => setQuery("")} type="button">
              <X size={14} />
            </button>
          )}
        </label>
        <div className="fn-press-legend" aria-label="操作方式说明">
          <span><i /> 短按切换</span>
          <span><i /> 长按操作</span>
        </div>
      </div>

      <div className="fn-shortcuts-content">
        {visibleGroups.map((group) => (
          <section className="fn-shortcut-group" key={group.id}>
            <div className="fn-group-heading">
              <div>
                <strong>{group.label}</strong>
                <small>{group.hint}</small>
              </div>
              <span>{group.shortcuts.length.toString().padStart(2, "0")}</span>
            </div>
            <div className="fn-shortcut-list">
              {group.shortcuts.map((shortcut) => (
                <article
                  className={`fn-shortcut-row ${shortcut.warning ? "warning" : ""}`}
                  key={shortcut.key}
                >
                  <div className="fn-key-combo" aria-label={`Fn 加 ${shortcut.key}`}>
                    <kbd>Fn</kbd>
                    <span>+</span>
                    <kbd className={shortcut.key.length > 2 ? "wide" : ""}>{shortcut.key}</kbd>
                  </div>
                  <div className="fn-shortcut-copy">
                    <strong>{shortcut.action}</strong>
                    {(shortcut.hold || shortcut.detail) && (
                      <small>
                        {shortcut.hold && <span className="fn-hold">{shortcut.hold}</span>}
                        {shortcut.detail && <span>{shortcut.detail}</span>}
                      </small>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>
        ))}
        {visibleGroups.length === 0 && (
          <div className="fn-shortcuts-empty">
            <Search size={22} />
            <strong>没有找到相关组合键</strong>
            <span>试试搜索“蓝牙”“音量”或具体按键</span>
          </div>
        )}
      </div>

      <p className="fn-shortcuts-footnote">
        <Keyboard size={15} aria-hidden="true" />
        长按操作需保持按键直到键盘指示灯响应。
      </p>
    </Modal>
  );
}

const IPV4_PATTERN =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function SettingsDialog({
  device,
  devices,
  onAddDevice,
  onClose,
  onRequestConnection,
  onSelectDevice,
  onUpdateDevice,
}) {
  const [selectedId, setSelectedId] = useState(device.id);
  const selectedDevice = devices.find((item) => item.id === selectedId) ?? device;
  const [draftIp, setDraftIp] = useState(selectedDevice.ip);
  const [draftName, setDraftName] = useState(selectedDevice.name);
  const trimmedIp = draftIp.trim();
  // 就地校验。原来任何字符串都能存进 localStorage，只有一条转瞬即逝的
  // toast 提示出错，脏值却留了下来。
  const ipValid = IPV4_PATTERN.test(trimmedIp);
  const ipError = trimmedIp && !ipValid ? "请输入形如 192.168.6.120 的 IPv4 地址" : "";

  useEffect(() => {
    setSelectedId(device.id);
    setDraftIp(device.ip);
    setDraftName(device.name);
  }, [device.id, device.ip, device.name]);

  const switchDevice = (id) => {
    const nextDevice = devices.find((item) => item.id === id);
    if (!nextDevice) return;
    if (!ipValid && trimmedIp) return;
    onSelectDevice(id);
    setSelectedId(id);
    setDraftIp(nextDevice.ip);
    setDraftName(nextDevice.name);
  };

  const addDevice = () => {
    if (!ipValid && trimmedIp) return;
    const nextDevice = onAddDevice();
    setSelectedId(nextDevice.id);
    setDraftIp(nextDevice.ip);
    setDraftName(nextDevice.name);
  };

  const save = () => {
    if (!ipValid) return;
    onUpdateDevice({ name: draftName.trim() || "Linx68", ip: trimmedIp });
    onClose();
    window.setTimeout(() => onRequestConnection(trimmedIp), 0);
  };

  return (
    <Modal labelId="settings-dialog-title" onClose={onClose}>
      <div className="modal-head">
        <div>
          <span className="section-kicker">DEVICE SETTINGS</span>
          <h2 id="settings-dialog-title">设备设置</h2>
        </div>
        <button aria-label="关闭" className="icon-button" onClick={onClose} type="button">
          <X size={18} />
        </button>
      </div>
      <div className="device-profile-row">
        <label className="field">
          <span>当前设备</span>
          <select onChange={(event) => switchDevice(event.target.value)} value={selectedId}>
            {devices.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.ip || "未设置 IP"}
              </option>
            ))}
          </select>
        </label>
        <button className="secondary-button compact" onClick={addDevice} type="button">
          添加设备
        </button>
      </div>
      <label className="field">
        <span>设备名称</span>
        <input onChange={(event) => setDraftName(event.target.value)} value={draftName} />
      </label>
      <label className="field">
        <span>IPv4 地址</span>
        <input
          aria-describedby={ipError ? "device-ip-error" : undefined}
          aria-invalid={Boolean(ipError)}
          className={ipError ? "invalid" : ""}
          inputMode="decimal"
          onChange={(event) => setDraftIp(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") save();
          }}
          placeholder="192.168.6.120"
          value={draftIp}
        />
        {ipError ? (
          <small className="field-error" id="device-ip-error">
            {ipError}
          </small>
        ) : null}
      </label>
      <div className="modal-note">
        <Wifi size={17} />
        电脑和小屏需要连接到同一局域网。
      </div>
      <div className="modal-actions">
        <button className="secondary-button" onClick={onClose} type="button">
          取消
        </button>
        <button
          aria-haspopup="dialog"
          className="primary-button compact"
          disabled={!ipValid}
          onClick={save}
          type="button"
        >
          保存并连接
        </button>
      </div>
    </Modal>
  );
}

function DeviceConnectionDialog({ device, onClose, onConfirm }) {
  return (
    <Modal
      className="connection-modal"
      labelId="connection-dialog-title"
      onClose={onClose}
    >
      <div className="modal-head">
        <div>
          <span className="section-kicker">BEFORE CONNECTING</span>
          <h2 id="connection-dialog-title">连接键盘前</h2>
        </div>
        <button aria-label="关闭" className="icon-button" onClick={onClose} type="button">
          <X size={18} />
        </button>
      </div>

      <div className="connection-guide">
        <span className="connection-guide-icon" aria-hidden="true">
          <ImageIcon size={22} />
        </span>
        <div>
          <strong>请先在键盘中选择「图像 API」</strong>
          <p>只有进入图像 API 后，电脑才能检测并连接键盘屏幕。</p>
        </div>
      </div>

      <ol className="connection-steps">
        <li>
          <span>1</span>
          <div>
            <strong>打开键盘功能菜单</strong>
            <small>在键盘屏幕上找到并选择「图像 API」。</small>
          </div>
        </li>
        <li>
          <span>2</span>
          <div>
            <strong>确认网络一致</strong>
            <small>让键盘和这台电脑保持在同一局域网。</small>
          </div>
        </li>
        <li>
          <span>3</span>
          <div>
            <strong>返回这里开始连接</strong>
            <small>准备完成后，点击下方按钮检测键盘。</small>
          </div>
        </li>
      </ol>

      <div className="connection-target">
        <span>即将连接</span>
        <strong>{device.name}</strong>
        <small>{device.ip}</small>
      </div>

      <div className="modal-actions">
        <button className="secondary-button" onClick={onClose} type="button">
          暂不连接
        </button>
        <button className="primary-button compact" onClick={onConfirm} type="button">
          <Wifi size={16} />
          已选择，开始连接
        </button>
      </div>
    </Modal>
  );
}

function TemplatesDialog({ templates, onClose, onApply, onDelete }) {
  return (
    <Modal className="templates-modal" labelId="templates-dialog-title" onClose={onClose}>
      <div className="modal-head">
        <div>
          <span className="section-kicker">LOCAL TEMPLATES</span>
          <h2 id="templates-dialog-title">已保存模板</h2>
        </div>
        <button aria-label="关闭" className="icon-button" onClick={onClose} type="button">
          <X size={18} />
        </button>
      </div>
      {templates.length === 0 ? (
        <div className="empty-templates">
          <Save size={25} />
          <strong>还没有保存模板</strong>
          <span>关闭这个弹窗，点击右下角“保存模板”创建第一个方案。</span>
        </div>
      ) : (
        <div className="template-list">
          {templates.map((template) => (
            <article className="template-item" key={template.id}>
              <span className="template-icon">
                {template.mode === "ai" ? (
                  <Bot size={18} />
                ) : template.mode === "system" ? (
                  <Activity size={18} />
                ) : (
                  <ImageIcon size={18} />
                )}
              </span>
              <div>
                <strong>{template.name}</strong>
                <small>{new Date(template.createdAt).toLocaleString("zh-CN")}</small>
              </div>
              <button onClick={() => onApply(template)} type="button">
                应用
              </button>
              <button
                aria-label={`删除模板 ${template.name}`}
                className="delete-template"
                onClick={() => onDelete(template.id)}
                type="button"
              >
                <X size={14} />
              </button>
            </article>
          ))}
        </div>
      )}
    </Modal>
  );
}

export default function App() {
  const [mode, setMode] = useState("presets");
  const [ai, setAi] = useAiState();
  const [aiDataStatus, setAiDataStatus] = useState("loading");
  const [aiDataError, setAiDataError] = useState("");
  const {
    activeDevice: device,
    addDevice,
    devices,
    selectDevice,
    updateActiveDevice,
  } = useDeviceProfiles();
  const [selectedPresetId, setSelectedPresetId] = useState(PRESETS[0].id);
  const [metrics, setMetrics] = useState(INITIAL_METRICS);
  const [metricsHistory, setMetricsHistory] = useState([]);
  const [metricsStatus, setMetricsStatus] = useState("loading");
  const [metricsError, setMetricsError] = useState("");
  const [lastMetricsAt, setLastMetricsAt] = useState(null);
  const [refreshInterval, setRefreshInterval] = useState(60);
  const [systemInterval, setSystemInterval] = useState(1);
  const [quality, setQuality] = useState(86);
  const [selectedImage, setSelectedImage] = useState(null);
  const [imageName, setImageName] = useState("");
  const [crop, setCrop] = useState(DEFAULT_CROP);
  const [renderedBlob, setRenderedBlob] = useState(null);
  const [renderedUrl, setRenderedUrl] = useState("");
  const [deviceStatus, setDeviceStatus] = useState({
    online: false,
    checking: false,
    latencyMs: null,
  });
  const [lastPush, setLastPush] = useState(null);
  const [pushing, setPushing] = useState(false);
  const [autoSending, setAutoSending] = useState(false);
  const [autoPush, setAutoPush] = useState(null);
  const [toast, setToast] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [pendingDeviceIp, setPendingDeviceIp] = useState(null);
  const runtimeStateRef = useRef({
    ai,
    crop,
    deviceIp: device.ip,
    deviceStatus,
    metricsHistory,
    metricsStatus,
    metrics,
    quality,
    selectedImage,
    selectedPresetId,
  });
  const autoPushInFlightRef = useRef(false);
  const initialDeviceCheckDoneRef = useRef(false);

  useEffect(() => {
    setDeviceStatus({
      online: false,
      checking: false,
      latencyMs: null,
    });
  }, [device.id, device.ip]);

  const showToast = useCallback((type, title, message) => {
    setToast({ type, title, message });
  }, []);

  // 必须是稳定引用。系统指标每秒刷新一次会让 App 整体重渲染，
  // 如果这里传的是内联箭头函数，Toast 的自动关闭 effect 每秒都会重建计时器，
  // 3.2 秒的倒计时永远走不完，提示就再也不会自己消失。
  const dismissToast = useCallback(() => setToast(null), []);

  const refreshAiUsage = useCallback(async () => {
    if (!isRunningInTauri()) {
      setAiDataStatus("error");
      setAiDataError("请在灵犀小屏屏桌面应用中读取本机 AI 额度与用量");
      return;
    }

    setAiDataStatus("loading");
    setAiDataError("");
    try {
      const snapshot = await getAiUsage();
      setAi((current) => mergeAiSnapshot(current, snapshot));
      setAiDataStatus("ready");
    } catch (error) {
      setAiDataStatus("error");
      setAiDataError(error instanceof Error ? error.message : String(error));
    }
  }, [setAi]);

  useEffect(() => {
    refreshAiUsage();
    const timer = window.setInterval(refreshAiUsage, 5 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [refreshAiUsage]);

  useEffect(() => {
    runtimeStateRef.current = {
      ai,
      crop,
      deviceIp: device.ip,
      deviceStatus,
      metricsHistory,
      metricsStatus,
      metrics,
      quality,
      selectedImage,
      selectedPresetId,
    };
  }, [
    ai,
    crop,
    device.ip,
    deviceStatus,
    metrics,
    metricsHistory,
    metricsStatus,
    quality,
    selectedImage,
    selectedPresetId,
  ]);

  const buildScreenBlob = useCallback(async (targetMode, targetPresetId) => {
    const current = runtimeStateRef.current;
    return renderScreenBlob({
      mode: targetMode,
      ai: current.ai,
      deviceStatus: current.deviceStatus,
      history: current.metricsHistory,
      metrics: current.metrics,
      image: current.selectedImage?.image ?? null,
      presetId: targetPresetId ?? current.selectedPresetId,
      sourceState: current.metricsStatus,
      crop: current.crop,
      quality: current.quality / 100,
    });
  }, []);

  const sendScreenBlob = useCallback(
    async (blob, { silent = false } = {}) => {
      try {
        const result = await pushImage(runtimeStateRef.current.deviceIp, blob);
        setLastPush(new Date());
        setDeviceStatus({
          online: true,
          checking: false,
          latencyMs: result.latencyMs ?? null,
        });
        if (!silent) {
          showToast(
            "success",
            "推送成功",
            `${formatBytes(blob.size)} · ${result.latencyMs ?? "—"} ms`,
          );
        }
        return true;
      } catch (error) {
        setDeviceStatus((current) => ({ ...current, online: false, checking: false }));
        if (!silent) {
          showToast("error", "推送失败", error instanceof Error ? error.message : String(error));
        }
        return false;
      }
    },
    [showToast],
  );

  const handleCheckDevice = useCallback(
    async (overrideIp, options = {}) => {
      const ip = typeof overrideIp === "string" ? overrideIp : device.ip;
      if (!IPV4_PATTERN.test(ip.trim())) {
        setDeviceStatus({ online: false, checking: false, latencyMs: null });
        if (!options.silent) {
          showToast("error", "设备地址无效", "请先在设备设置中填写有效的 IPv4 地址");
        }
        return;
      }
      setDeviceStatus((current) => ({ ...current, checking: true }));
      try {
        const result = await checkDevice(ip);
        setDeviceStatus({
          online: Boolean(result.online),
          checking: false,
          latencyMs: result.latencyMs ?? null,
        });
      } catch (error) {
        setDeviceStatus({ online: false, checking: false, latencyMs: null });
        if (!options.silent) {
          showToast("error", "设备离线", error instanceof Error ? error.message : String(error));
        }
      }
    },
    [device.ip, showToast],
  );

  // 首次启动沿用静默探测；之后切换设备或修改 IP 时，不再绕过
  // “图像 API”连接前确认弹窗直接发起检测。
  useEffect(() => {
    if (initialDeviceCheckDoneRef.current) return;
    initialDeviceCheckDoneRef.current = true;
    handleCheckDevice(undefined, { silent: true });
  }, [handleCheckDevice]);

  const handleRequestDeviceConnection = useCallback(
    (overrideIp) => {
      const ip = (typeof overrideIp === "string" ? overrideIp : device.ip).trim();
      if (!IPV4_PATTERN.test(ip)) {
        setDeviceStatus({ online: false, checking: false, latencyMs: null });
        showToast("error", "设备地址无效", "请先在设备设置中填写有效的 IPv4 地址");
        return;
      }
      setPendingDeviceIp(ip);
      setDialog("connection");
    },
    [device.ip, showToast],
  );

  const closeConnectionDialog = useCallback(() => {
    setDialog(null);
    setPendingDeviceIp(null);
  }, []);

  const confirmDeviceConnection = useCallback(() => {
    const ip = pendingDeviceIp ?? device.ip;
    setDialog(null);
    setPendingDeviceIp(null);
    handleCheckDevice(ip);
  }, [device.ip, handleCheckDevice, pendingDeviceIp]);

  const refreshSystemMetrics = useCallback(async () => {
    try {
      const nextMetrics = await getSystemMetrics();
      setMetrics(nextMetrics);
      setMetricsHistory((current) => [...current, nextMetrics].slice(-30));
      setMetricsStatus("ready");
      setMetricsError("");
      setLastMetricsAt(new Date());
      return true;
    } catch (error) {
      setMetricsStatus("unavailable");
      setMetricsError(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, []);

  useEffect(() => {
    let active = true;
    const refreshMetrics = async () => {
      if (!active) return;
      await refreshSystemMetrics();
    };

    refreshMetrics();
    const timer = window.setInterval(refreshMetrics, systemInterval * 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refreshSystemMetrics, systemInterval]);

  useEffect(() => {
    if (!renderedBlob) {
      setRenderedUrl("");
      return undefined;
    }
    const url = URL.createObjectURL(renderedBlob);
    setRenderedUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [renderedBlob]);

  useEffect(() => {
    if (
      autoPush &&
      (autoPush.mode !== mode ||
        (mode === "presets" && autoPush.presetId !== selectedPresetId))
    ) {
      return undefined;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const blob = await buildScreenBlob(mode, selectedPresetId);
        if (!cancelled) setRenderedBlob(blob);
      } catch (error) {
        if (!cancelled) {
          showToast("error", "预览渲染失败", error instanceof Error ? error.message : String(error));
        }
      }
    }, 90);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    ai,
    autoPush?.mode,
    buildScreenBlob,
    crop,
    deviceStatus,
    metrics,
    metricsHistory,
    metricsStatus,
    mode,
    quality,
    selectedImage,
    selectedPresetId,
    showToast,
  ]);

  useEffect(() => {
    if (!autoPush) return undefined;

    const refreshMs =
      ["system", "presets"].includes(autoPush.mode)
        ? systemInterval * 1000
        : refreshInterval * 1000;
    let cancelled = false;
    let timer;

    const scheduleNextPush = () => {
      timer = window.setTimeout(async () => {
        if (cancelled || autoPushInFlightRef.current) {
          if (!cancelled) scheduleNextPush();
          return;
        }

        autoPushInFlightRef.current = true;
        setAutoSending(true);
        try {
          const blob = await buildScreenBlob(autoPush.mode, autoPush.presetId);
          if (!cancelled) setRenderedBlob(blob);
          const pushed = await sendScreenBlob(blob, { silent: true });
          setAutoPush((current) => {
            if (!current || current.mode !== autoPush.mode) return current;
            return { ...current, failures: pushed ? 0 : current.failures + 1 };
          });
        } finally {
          autoPushInFlightRef.current = false;
          if (!cancelled) {
            setAutoSending(false);
            scheduleNextPush();
          }
        }
      }, refreshMs);
    };

    scheduleNextPush();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      setAutoSending(false);
    };
  }, [
    autoPush?.mode,
    autoPush?.presetId,
    buildScreenBlob,
    refreshInterval,
    sendScreenBlob,
    systemInterval,
  ]);

  useEffect(
    () => () => {
      if (selectedImage?.url) URL.revokeObjectURL(selectedImage.url);
    },
    [selectedImage],
  );

  const handleNavigate = (id) => {
    if (["presets", "image", "ai", "system"].includes(id)) {
      setMode(id);
      return;
    }
    if (id === "connection") {
      handleRequestDeviceConnection();
      return;
    }
    setDialog(id);
  };

  // 选择和拖拽两条入口共用同一段载入逻辑
  const handleImageFile = async (file) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showToast("error", "格式不支持", "请选择 JPG、PNG 或 WebP 图片");
      return;
    }
    try {
      const loaded = await loadImageFile(file);
      if (selectedImage?.url) URL.revokeObjectURL(selectedImage.url);
      setSelectedImage(loaded);
      setImageName(file.name);
      setCrop(DEFAULT_CROP);
      showToast("success", "图片已载入", "拖动图片并缩放，调整小屏展示区域");
    } catch (error) {
      showToast("error", "图片载入失败", error instanceof Error ? error.message : String(error));
    }
  };

  const handleChooseImage = async (event) => {
    const file = event.target.files?.[0];
    // 先清空 input，否则连续选同一个文件不会再触发 change
    event.target.value = "";
    await handleImageFile(file);
  };

  const handlePush = async () => {
    if (autoPush?.mode === mode) {
      setAutoPush(null);
      setAutoSending(false);
      showToast("success", "已停止持续推送", "屏幕会保留最后一次成功推送的内容");
      return;
    }

    if (mode === "presets" && metricsStatus !== "ready") {
      showToast(
        "error",
        "电脑数据尚未就绪",
        metricsError || "请等待桌面应用完成第一次系统指标采样",
      );
      return;
    }

    if (mode === "presets" && !deviceStatus.online) {
      showToast(
        "error",
        "键盘屏幕尚未连接",
        "本地预览不受影响；连接键盘后再发送当前 JPEG 画面",
      );
      return;
    }

    setPushing(true);
    try {
      const blob = await buildScreenBlob(mode, selectedPresetId);
      const pushed = await sendScreenBlob(blob);
      if (!pushed) return;

      if (mode === "image") {
        setAutoPush(null);
        return;
      }

      const intervalSeconds = ["system", "presets"].includes(mode)
        ? systemInterval
        : refreshInterval;
      setAutoPush({
        mode,
        failures: 0,
        intervalSeconds,
        presetId: mode === "presets" ? selectedPresetId : undefined,
      });
      showToast(
        "success",
        "持续刷新已启动",
        `${
          mode === "presets"
            ? findPreset(selectedPresetId).name
            : mode === "system"
              ? "系统监控"
              : "AI 额度"
        }会每 ${intervalSeconds} 秒自动推送一次`,
      );
    } finally {
      setPushing(false);
    }
  };

  const activePreset = findPreset(selectedPresetId);
  const activeMode =
    mode === "presets"
      ? {
          id: "presets",
          label: "预设库",
          description: activePreset.description,
          icon: LayoutGrid,
        }
      : MODES.find((item) => item.id === mode) ?? MODES[1];
  const previewMode = autoPush?.mode ?? mode;
  const previewPreset = findPreset(autoPush?.presetId ?? selectedPresetId);
  const previewModeInfo =
    previewMode === "presets"
      ? { label: previewPreset.name }
      : MODES.find((item) => item.id === previewMode) ?? activeMode;
  const autoPushInterval = ["system", "presets"].includes(autoPush?.mode)
    ? systemInterval
    : refreshInterval;
  const isCurrentModeAutoPushing =
    autoPush?.mode === mode &&
    (mode !== "presets" || autoPush?.presetId === selectedPresetId);
  const presetCanSend =
    mode !== "presets" ||
    isCurrentModeAutoPushing ||
    (metricsStatus === "ready" && deviceStatus.online);
  const presetSendLabel =
    metricsStatus !== "ready"
      ? "等待电脑数据"
      : deviceStatus.online
        ? "发送并持续刷新"
        : "连接键盘后发送";

  return (
    <div className="app-canvas">
      <main className="app-shell">
        <Sidebar
          activeDialog={dialog}
          device={device}
          deviceStatus={deviceStatus}
          mode={mode}
          onNavigate={handleNavigate}
          onOpenSettings={() => setDialog("settings")}
          onRequestConnection={handleRequestDeviceConnection}
          statusSummary={
            <PreviewSummary
              activeMode={activeMode}
              activePreset={activePreset}
              autoPush={autoPush}
              deviceStatus={deviceStatus}
              metricsStatus={metricsStatus}
              mode={mode}
              previewModeInfo={previewModeInfo}
            />
          }
        />

        <section className="workspace">
          {mode !== "presets" && (
            <header className="workspace-header">
              <div>
                <span className="workspace-kicker">
                  WORKSPACE / {activeMode.label.toUpperCase()}
                </span>
                <h1>灵犀小屏屏控制台</h1>
              </div>
              <div className="push-status">
                <span className="pulse-dot" />
                {lastPush
                  ? `上次推送 ${lastPush.toLocaleTimeString("zh-CN", {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}`
                  : "等待首次推送"}
              </div>
            </header>
          )}

          {mode === "presets" && (
            <PresetLibrary
              deviceStatus={deviceStatus}
              history={metricsHistory}
              lastMetricsAt={lastMetricsAt}
              metrics={metrics}
              metricsError={metricsError}
              metricsStatus={metricsStatus}
              onSelect={setSelectedPresetId}
              selectedPresetId={selectedPresetId}
            />
          )}
          {mode === "ai" && (
            <AiConfiguration
              ai={ai}
              error={aiDataError}
              onRefresh={refreshAiUsage}
              setAi={setAi}
              status={aiDataStatus}
            />
          )}
          {mode === "image" && (
            <ImageConfiguration
              crop={crop}
              imageName={imageName}
              onCropChange={setCrop}
              onChooseImage={handleChooseImage}
              onDropFile={handleImageFile}
              quality={quality}
              selectedImage={selectedImage}
              setQuality={setQuality}
            />
          )}
          {mode === "system" && (
            <SystemConfiguration
              metrics={metrics}
              refreshInterval={systemInterval}
              setRefreshInterval={setSystemInterval}
            />
          )}
        </section>

        <aside className="preview-panel">
          <header className="preview-header">
            <div>
              <span className="section-kicker">DEVICE OUTPUT</span>
              <h2>实时预览</h2>
            </div>
            <span className="runtime-chip">{isRunningInTauri() ? "TAURI" : "WEB DEV"}</span>
          </header>

          <ScreenPreview
            ai={ai}
            blobSize={renderedBlob?.size}
            crop={crop}
            deviceStatus={deviceStatus}
            metrics={metrics}
            mode={previewMode}
            renderedUrl={renderedUrl}
            selectedImage={selectedImage}
          />

          <div className="preview-actions">
            {mode === "ai" && (
              <RefreshIntervalControl
                refreshInterval={refreshInterval}
                setRefreshInterval={setRefreshInterval}
              />
            )}
            {mode === "presets" && !autoPush && (
              <div className="preview-separation-note">
                <MonitorCog size={16} />
                <span>
                  <strong>本地预览已独立运行</strong>
                  键盘只在发送 JPEG 时需要连接
                </span>
              </div>
            )}
            <div className={`refresh-note ${autoPush ? "running" : ""}`}>
              {autoPush ? <RefreshCw className={autoSending ? "button-spinner" : ""} size={16} /> : <CircleGauge size={16} />}
              {autoPush ? "持续推送：" : mode === "presets" ? "电脑预览：" : "推荐刷新："}
              <strong>
                {autoPush
                  ? `每 ${autoPushInterval} 秒${autoPush.failures ? " · 重试中" : ""}`
                  : ["system", "presets"].includes(mode)
                    ? "1 秒"
                    : mode === "ai"
                      ? `${refreshInterval} 秒`
                      : "手动"}
              </strong>
            </div>
            <div className="button-row">
              <button
                aria-haspopup={mode === "system" ? undefined : "dialog"}
                className="secondary-button"
                onClick={() => {
                  if (mode === "system") {
                    refreshSystemMetrics();
                  } else {
                    handleRequestDeviceConnection();
                  }
                }}
                disabled={deviceStatus.checking && mode === "presets"}
                type="button"
              >
                <RefreshCw size={17} />
                {mode === "presets"
                  ? deviceStatus.checking
                    ? "检测中"
                    : "检测键盘"
                  : mode === "system"
                    ? "重新采集"
                    : "检查设备"}
              </button>
              <button
                className="primary-button"
                disabled={
                  pushing || !presetCanSend
                }
                onClick={handlePush}
                type="button"
              >
                {pushing ? (
                  <RefreshCw className="button-spinner" size={18} />
                ) : isCurrentModeAutoPushing ? (
                  <Square size={17} fill="currentColor" />
                ) : (
                  <Send size={18} />
                )}
                {pushing
                  ? "推送中"
                  : isCurrentModeAutoPushing
                    ? "停止持续推送"
                    : mode === "presets"
                      ? presetSendLabel
                    : mode === "image"
                      ? "推送到屏幕"
                      : autoPush
                        ? "切换并持续刷新"
                        : "推送并持续刷新"}
              </button>
            </div>
          </div>
        </aside>
      </main>

      <Toast onClose={dismissToast} toast={toast} />
      {dialog === "fn-shortcuts" && (
        <FnShortcutsDialog onClose={() => setDialog(null)} />
      )}
      {dialog === "settings" && (
        <SettingsDialog
          device={device}
          devices={devices}
          onAddDevice={addDevice}
          onClose={() => setDialog(null)}
          onRequestConnection={handleRequestDeviceConnection}
          onSelectDevice={selectDevice}
          onUpdateDevice={updateActiveDevice}
        />
      )}
      {dialog === "connection" && (
        <DeviceConnectionDialog
          device={{ ...device, ip: pendingDeviceIp ?? device.ip }}
          onClose={closeConnectionDialog}
          onConfirm={confirmDeviceConnection}
        />
      )}
    </div>
  );
}
