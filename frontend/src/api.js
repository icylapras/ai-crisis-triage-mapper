const API_BASE = (
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000"
).replace(/\/$/, "");

/** Resolve the browser-to-backend WebSocket without exposing the Gemini key. */
export function getLiveSupportWebSocketUrl() {
  const url = new URL(API_BASE, window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/ws/live-support`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** Send a raw crisis report to the backend for Gemini triage + storage. */
export async function triageReport(rawText) {
  const res = await fetch(`${API_BASE}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw_text: rawText }),
  });
  if (!res.ok) {
    let detail = `Server responded ${res.status}`;
    try {
      const body = await res.json();
      if (body.detail) detail = body.detail;
    } catch {
      /* ignore non-JSON error bodies */
    }
    throw new Error(detail);
  }
  return res.json();
}

/** Ask the independent support agent for an immediate, calming response. */
export async function getCrisisSupport(rawText, history = []) {
  const res = await fetch(`${API_BASE}/api/support`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw_text: rawText, history }),
  });
  if (!res.ok) {
    let detail = `Server responded ${res.status}`;
    try {
      const body = await res.json();
      if (body.detail) detail = body.detail;
    } catch {
      /* ignore non-JSON error bodies */
    }
    throw new Error(detail);
  }
  return res.json();
}

/** Fetch all stored crisis reports, newest first. */
export async function getReports() {
  const res = await fetch(`${API_BASE}/api/reports`);
  if (!res.ok) throw new Error(`Server responded ${res.status}`);
  return res.json();
}

/** Mark a report resolved: permanently deletes it from the database. */
export async function resolveReport(id) {
  const res = await fetch(`${API_BASE}/api/reports/${id}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Server responded ${res.status}`);
  }
}
