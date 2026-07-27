function getTauriInvoke() {
  return window.__TAURI__?.core?.invoke ?? null;
}

function bytesFromBlob(blob) {
  return blob.arrayBuffer().then((buffer) => Array.from(new Uint8Array(buffer)));
}

export async function checkDevice(ip) {
  const invoke = getTauriInvoke();
  if (invoke) {
    return invoke("check_device", { ip });
  }

  const response = await fetch(`/__device/check?ip=${encodeURIComponent(ip)}`);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error ?? "设备连接失败");
  }
  return payload;
}

export async function pushImage(ip, blob) {
  if (blob.size > 512 * 1024) {
    throw new Error("图片超过设备 512KB 限制");
  }

  const invoke = getTauriInvoke();
  if (invoke) {
    return invoke("push_image", {
      args: {
        ip,
        imageBytes: await bytesFromBlob(blob),
      },
    });
  }

  const response = await fetch(`/__device/push?ip=${encodeURIComponent(ip)}`, {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: blob,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error ?? "推送失败");
  }
  return payload;
}

export async function getSystemMetrics() {
  const invoke = getTauriInvoke();
  if (invoke) {
    return invoke("get_system_metrics");
  }

  throw new Error("真实系统指标仅可在灵犀小屏屏桌面应用中采集");
}

export async function getAiUsage() {
  const invoke = getTauriInvoke();
  if (invoke) {
    return invoke("get_ai_usage");
  }

  throw new Error("真实 AI 额度与本地用量仅可在灵犀小屏屏桌面应用中读取");
}

export function isRunningInTauri() {
  return Boolean(getTauriInvoke());
}
