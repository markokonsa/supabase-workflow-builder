// Talking to KOMA Home (the Tauri app) when the builder runs inside it as an iframe.
//
// KOMA Home → builder:  { type: "koma-flow:load", source, name? }   open this exported flow
//                       { type: "koma-flow:request-save" }          send the current flow back
// builder → KOMA Home:  { type: "koma-flow:ready" }                 listening; send a flow to load
//                       { type: "koma-flow:save", name, fileName, source }   the export script
//
// Messages are only exchanged with the parent window, and only when it is one of KOMA Home's origins.

const HOST_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:1420"];

export type HostMessage = { type: "koma-flow:load"; source: string; name?: string } | { type: "koma-flow:request-save" };

export type BuilderMessage =
  | { type: "koma-flow:ready" }
  | { type: "koma-flow:save"; name: string; fileName: string; source: string };

let hostOrigin: string | null = null;

/** The origin of KOMA Home when the builder is embedded in it, else null. */
function detectHost(): string | null {
  if (typeof window === "undefined" || window.parent === window) return null;
  // ancestorOrigins is WebKit/Chromium; the referrer covers the rest.
  const fromAncestors = window.location.ancestorOrigins?.[0];
  let fromReferrer: string | undefined;
  try {
    fromReferrer = document.referrer ? new URL(document.referrer).origin : undefined;
  } catch {
    fromReferrer = undefined;
  }
  const origin = fromAncestors ?? fromReferrer;
  if (origin && HOST_ORIGINS.includes(origin)) return origin;
  // Embedded with ?embed=koma but the origin couldn't be read: trust only known origins on messages.
  return new URLSearchParams(window.location.search).get("embed") === "koma" ? "*" : null;
}

export function isEmbeddedInKomaHome(): boolean {
  hostOrigin ??= detectHost();
  return hostOrigin !== null;
}

export function postToHost(message: BuilderMessage) {
  if (!isEmbeddedInKomaHome()) return;
  // Exports never contain keys, so "*" (origin unknown) is acceptable; prefer the exact origin.
  window.parent.postMessage(message, hostOrigin ?? "*");
}

/** Listen for messages from KOMA Home. Returns an unsubscribe function. */
export function onHostMessage(handler: (message: HostMessage) => void): () => void {
  const listener = (e: MessageEvent) => {
    if (e.source !== window.parent || !HOST_ORIGINS.includes(e.origin)) return;
    const data = e.data as Partial<HostMessage> | null;
    if (data?.type === "koma-flow:load" && typeof (data as { source?: unknown }).source === "string") handler(data as HostMessage);
    else if (data?.type === "koma-flow:request-save") handler(data as HostMessage);
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}
