import { isIP } from "node:net";
import { defineConfig } from "vite";

function readRequestBody(request, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("图片超过 512KB"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function getDeviceIp(request) {
  const url = new URL(request.url, "http://127.0.0.1");
  const ip = url.searchParams.get("ip") ?? "";
  if (isIP(ip) !== 4) {
    throw new Error("仅支持 IPv4 设备地址");
  }
  return ip;
}

function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

// 与 src-tauri/src/lib.rs 的 describe_request_error 保持一致的措辞。
// 不翻的话浏览器原生的 "The operation was aborted due to timeout"
// 会直接出现在中文界面的失败提示里。
function describeRequestError(error, action) {
  const name = error?.name ?? "";
  const code = error?.cause?.code ?? "";
  if (name === "TimeoutError" || name === "AbortError") {
    return `${action}超时，请确认小屏已开机并与电脑处于同一局域网`;
  }
  if (code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return `${action}被拒绝，请确认设备 IP 正确且小屏 API 服务已启动`;
  }
  return `${action}失败：${error instanceof Error ? error.message : String(error)}`;
}

function deviceBridge() {
  return {
    name: "lingxi-device-bridge",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (!request.url?.startsWith("/__device/")) {
          next();
          return;
        }

        const startedAt = performance.now();
        let action = "请求";
        try {
          const ip = getDeviceIp(request);

          if (request.url.startsWith("/__device/check")) {
            action = "连接设备";
            const deviceResponse = await fetch(`http://${ip}/api`, {
              signal: AbortSignal.timeout(3000),
            });
            sendJson(response, deviceResponse.ok ? 200 : 502, {
              online: deviceResponse.ok,
              latencyMs: Math.round(performance.now() - startedAt),
              status: deviceResponse.status,
            });
            return;
          }

          if (request.url.startsWith("/__device/push") && request.method === "POST") {
            action = "推送请求";
            const body = await readRequestBody(request);
            const deviceResponse = await fetch(`http://${ip}/image/upload`, {
              method: "POST",
              headers: { "Content-Type": "image/jpeg" },
              body,
              signal: AbortSignal.timeout(5000),
            });
            const responseText = await deviceResponse.text();
            sendJson(response, deviceResponse.ok ? 200 : 502, {
              ok: deviceResponse.ok,
              status: deviceResponse.status,
              latencyMs: Math.round(performance.now() - startedAt),
              bytes: body.byteLength,
              response: responseText,
            });
            return;
          }

          sendJson(response, 404, { error: "未找到设备桥接接口" });
        } catch (error) {
          // IP 校验这类本地错误已经是中文，不要再套一层「…失败：」
          const isLocalValidation = error instanceof Error && error.message.startsWith("仅支持");
          sendJson(response, 502, {
            error: isLocalValidation ? error.message : describeRequestError(error, action),
          });
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [deviceBridge()],
  esbuild: {
    jsx: "automatic",
  },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
  clearScreen: false,
});
