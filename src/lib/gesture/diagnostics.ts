"use client";

/**
 * Camera / gesture environment checks shown in the diagnostics panel. Each check reports what
 * the browser actually says. Nothing here starts the camera: enumerateDevices and the
 * permissions API are read-only.
 */

export type CheckState = "ok" | "warn" | "fail" | "unknown";

export interface EnvCheck {
  id: "secure" | "api" | "permission" | "devices" | "webgl";
  state: CheckState;
  /** short value for display, e.g. "granted", "2 cameras", "SwiftShader" */
  value: string;
}

export interface EnvReport {
  checks: EnvCheck[];
  secureContext: boolean;
  protocol: string;
  host: string;
  renderer: string | null;
  softwareRenderer: boolean;
}

const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i;

/** WebGL renderer string (unmasked when the browser allows it). */
export function webglRenderer(): string | null {
  if (typeof document === "undefined") return null;
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl2") || canvas.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return null;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const value = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

export function isSoftwareRenderer(renderer: string | null): boolean {
  return renderer === null || SOFTWARE_RENDERER.test(renderer);
}

export async function cameraPermission(): Promise<PermissionState | "unsupported"> {
  try {
    if (!navigator.permissions?.query) return "unsupported";
    const s = await navigator.permissions.query({ name: "camera" as PermissionName });
    return s.state;
  } catch {
    return "unsupported"; // e.g. browsers that do not expose "camera" to the permissions API
  }
}

export async function collectEnvReport(): Promise<EnvReport> {
  const secureContext = typeof window !== "undefined" && window.isSecureContext;
  const hasApi = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  const checks: EnvCheck[] = [
    { id: "secure", state: secureContext ? "ok" : "fail", value: secureContext ? "HTTPS" : `${location.protocol}//${location.host}` },
    { id: "api", state: hasApi ? "ok" : "fail", value: hasApi ? "getUserMedia" : "—" },
  ];
  const perm = hasApi ? await cameraPermission() : "unsupported";
  checks.push({
    id: "permission",
    state: perm === "granted" ? "ok" : perm === "denied" ? "fail" : perm === "prompt" ? "warn" : "unknown",
    value: perm,
  });
  if (hasApi && navigator.mediaDevices.enumerateDevices) {
    try {
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
      checks.push({ id: "devices", state: cams.length > 0 ? "ok" : "fail", value: String(cams.length) });
    } catch {
      checks.push({ id: "devices", state: "unknown", value: "?" });
    }
  } else {
    checks.push({ id: "devices", state: "unknown", value: "?" });
  }
  const renderer = webglRenderer();
  const software = isSoftwareRenderer(renderer);
  checks.push({ id: "webgl", state: renderer === null ? "warn" : software ? "warn" : "ok", value: renderer ?? "—" });
  return {
    checks,
    secureContext,
    protocol: typeof location !== "undefined" ? location.protocol : "",
    host: typeof location !== "undefined" ? location.host : "",
    renderer,
    softwareRenderer: software,
  };
}
