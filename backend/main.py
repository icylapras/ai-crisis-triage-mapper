"""AI Crisis Triage Mapper - FastAPI backend.

Reporters submit free-form crisis reports (text or transcribed voice). This
service asks Gemini to turn each report into a structured JSON record, stores it
in a local SQLite database, and serves the records to the responder dashboard.

If GEMINI_API_KEY is not set, a deterministic mock extractor is used instead so
the app is fully runnable without a key.
"""

import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from live_support import LiveSupportBridge

load_dotenv()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash")
GEMINI_LIVE_MODEL = os.getenv(
    "GEMINI_LIVE_MODEL",
    "gemini-3.1-flash-live-preview",
)
GEMINI_LIVE_VOICE = os.getenv("GEMINI_LIVE_VOICE", "Sulafat")
DB_PATH = Path(__file__).parent / "crisis.db"

app = FastAPI(title="AI Crisis Triage Mapper")

# Allow the Vite dev server (and other localhost ports) to call the API.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------- #
# Models
# --------------------------------------------------------------------------- #
class TriageRequest(BaseModel):
    raw_text: str


class SupportTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class SupportRequest(TriageRequest):
    history: list[SupportTurn] = Field(default_factory=list)


class SupportResponse(BaseModel):
    message: str
    immediate_actions: list[str]


class Report(BaseModel):
    id: int
    created_at: str
    name: str
    age: str
    urgency: int
    title: str
    summary: str
    notes: str
    other_data: str
    location: str
    lat: float | None = None
    lng: float | None = None


# The structured shape we ask Gemini to extract (no id/created_at — those are
# assigned server-side).
class ExtractedReport(BaseModel):
    name: str
    age: str
    urgency: int
    title: str
    summary: str
    notes: str
    other_data: str
    location: str
    lat: float | None = None
    lng: float | None = None


# --------------------------------------------------------------------------- #
# Database
# --------------------------------------------------------------------------- #
@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS reports (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT    NOT NULL,
                name       TEXT    NOT NULL,
                age        TEXT    NOT NULL,
                urgency    INTEGER NOT NULL,
                title      TEXT    NOT NULL,
                summary    TEXT    NOT NULL,
                notes      TEXT    NOT NULL,
                other_data TEXT    NOT NULL,
                location   TEXT    NOT NULL,
                lat        REAL,
                lng        REAL
            )
            """
        )


init_db()


def insert_report(data: ExtractedReport) -> Report:
    created_at = datetime.now(timezone.utc).isoformat()
    with get_db() as conn:
        cur = conn.execute(
            """
            INSERT INTO reports
                (created_at, name, age, urgency, title, summary, notes,
                 other_data, location, lat, lng)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                created_at,
                data.name,
                data.age,
                _clamp_urgency(data.urgency),
                data.title,
                data.summary,
                data.notes,
                data.other_data,
                data.location,
                data.lat,
                data.lng,
            ),
        )
        new_id = cur.lastrowid
    return Report(id=new_id, created_at=created_at, **_extracted_dict(data))


def list_reports() -> list[Report]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM reports ORDER BY id DESC"
        ).fetchall()
    return [Report(**dict(row)) for row in rows]


def delete_report(report_id: int) -> bool:
    """Permanently remove a resolved report. Returns False if it didn't exist."""
    with get_db() as conn:
        cur = conn.execute("DELETE FROM reports WHERE id = ?", (report_id,))
    return cur.rowcount > 0


def _extracted_dict(data: ExtractedReport) -> dict:
    d = data.model_dump()
    d["urgency"] = _clamp_urgency(d["urgency"])
    return d


def _clamp_urgency(value: int) -> int:
    try:
        return max(1, min(10, int(value)))
    except (TypeError, ValueError):
        return 1


def _live_report_text(payload: dict, field: str) -> str:
    value = payload.get(field)
    if value is None:
        return "n/a"
    text = str(value).strip()
    return text or "n/a"


def _live_report_coordinate(payload: dict, field: str) -> float | None:
    value = payload.get(field)
    if value in (None, "", "n/a"):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def save_live_report(payload: dict) -> dict:
    """Validate and persist a Gemini Live tool call through the report store."""
    extracted = ExtractedReport(
        name=_live_report_text(payload, "name"),
        age=_live_report_text(payload, "age"),
        urgency=_clamp_urgency(payload.get("urgency", 1)),
        title=_live_report_text(payload, "title"),
        summary=_live_report_text(payload, "summary"),
        notes=_live_report_text(payload, "notes"),
        other_data=_live_report_text(payload, "other_data"),
        location=_live_report_text(payload, "location"),
        lat=_live_report_coordinate(payload, "lat"),
        lng=_live_report_coordinate(payload, "lng"),
    )
    return insert_report(extracted).model_dump()


# --------------------------------------------------------------------------- #
# Extraction: Gemini (if key present) or deterministic mock
# --------------------------------------------------------------------------- #
EXTRACTION_INSTRUCTIONS = """
You are a crisis-triage assistant. Extract a single structured crisis report
from the message below. Rules:
- Fill EVERY field. If a field is not mentioned or cannot be inferred, use the
  literal string "n/a" (for lat/lng, use null instead).
- `urgency` is an integer 1-10 that YOU assess from severity and risk to life
  (10 = imminent loss of life / mass-casualty; 1 = minor / informational).
- `title` is a short (<= 8 words) headline of the incident.
- `summary` is a concise 1-2 sentence AI summary of the situation.
- `notes` captures additional details specific to the issue (injuries, hazards,
  numbers affected), or "n/a".
- `other_data` captures any other extracted personal/contextual details worth
  showing a responder (e.g. medical conditions, contact info), or "n/a".
- `location` is the most specific place name available, or "n/a".
- `lat` and `lng` are approximate decimal coordinates for that location, or null
  if unknown.

Message:
"""

SUPPORT_INSTRUCTIONS = """
You are a calm crisis-support assistant providing brief psychological first aid,
not an emergency service or clinician. Respond to the user's latest message in
the context of the conversation.

Rules:
- First prioritize immediate physical safety. If there is imminent danger,
  advise moving to safety only when that does not increase risk and contacting
  local emergency services now. State that this app cannot place that call.
- Do not improvise tactical rescue, firefighting, medical, or law-enforcement
  instructions. Encourage following directions from local authorities.
- Be warm, steady, non-judgmental, and concise. Acknowledge what the person
  said. Do not pressure them to tell their story.
- Offer at most three concrete next actions, one step at a time. Do not suggest
  deep breathing for smoke/toxic exposure, chest pain, or breathing trouble.
- Do not diagnose, invent facts, make promises, or claim responders have been
  dispatched.
- Ask no more than one essential follow-up question in `message`.
- `message` should be two to four short sentences.
- `immediate_actions` should contain zero to three short strings.
"""


def extract_with_gemini(raw_text: str) -> ExtractedReport:
    # Imported lazily so the app still boots without the package installed.
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=GEMINI_API_KEY)
    response = client.models.generate_content(
        model=GEMINI_MODEL,
        contents=EXTRACTION_INSTRUCTIONS + raw_text,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=ExtractedReport,
            temperature=0.2,
        ),
    )
    parsed = response.parsed
    if isinstance(parsed, ExtractedReport):
        return parsed
    # Fallback: parse the raw JSON text ourselves.
    return ExtractedReport(**json.loads(response.text))


# A handful of sample coordinates so mock-mode reports still spread across the
# globe and light up the heatmap.
_MOCK_CITIES = [
    ("Los Angeles, USA", 34.0522, -118.2437),
    ("Karachi, Pakistan", 24.8607, 67.0011),
    ("Nairobi, Kenya", -1.2921, 36.8219),
    ("Tokyo, Japan", 35.6895, 139.6917),
    ("Madrid, Spain", 40.4168, -3.7038),
    ("São Paulo, Brazil", -23.5505, -46.6333),
    ("Jakarta, Indonesia", -6.2088, 106.8456),
    ("Istanbul, Turkey", 41.0082, 28.9784),
]

_HIGH_URGENCY_WORDS = (
    "trapped", "fire", "flood", "collapse", "gas leak", "explosion",
    "shooting", "earthquake", "drowning", "bleeding", "unconscious", "dying",
)
_MED_URGENCY_WORDS = ("injured", "evacuate", "storm", "outage", "shortage")


def extract_mock(raw_text: str) -> ExtractedReport:
    """Deterministic, key-free extractor for demos without a Gemini key."""
    text = raw_text.strip()
    lower = text.lower()

    if any(w in lower for w in _HIGH_URGENCY_WORDS):
        urgency = 9
    elif any(w in lower for w in _MED_URGENCY_WORDS):
        urgency = 6
    else:
        urgency = 3

    first_line = text.splitlines()[0] if text else "Unspecified report"
    title = (first_line[:60] + "…") if len(first_line) > 60 else first_line

    # Rotate through sample cities based on the current row count so points
    # spread out instead of stacking.
    with get_db() as conn:
        count = conn.execute("SELECT COUNT(*) FROM reports").fetchone()[0]
    location, lat, lng = _MOCK_CITIES[count % len(_MOCK_CITIES)]

    return ExtractedReport(
        name="n/a",
        age="n/a",
        urgency=urgency,
        title=title or "Unspecified report",
        summary=(text[:200] + "…") if len(text) > 200 else (text or "n/a"),
        notes="n/a",
        other_data="Generated in mock mode (no GEMINI_API_KEY set).",
        location=location,
        lat=lat,
        lng=lng,
    )


def extract(raw_text: str) -> ExtractedReport:
    if GEMINI_API_KEY:
        try:
            return extract_with_gemini(raw_text)
        except Exception as exc:  # noqa: BLE001 - never let extraction crash the API
            print(f"[triage] Gemini extraction failed, using mock: {exc}")
    return extract_mock(raw_text)


def support_with_gemini(request: SupportRequest) -> SupportResponse:
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=GEMINI_API_KEY)
    conversation = [
        {"role": turn.role, "content": turn.content}
        for turn in request.history[-12:]
    ]
    prompt = (
        f"{SUPPORT_INSTRUCTIONS}\n\n"
        f"Recent conversation:\n{json.dumps(conversation, ensure_ascii=False)}"
        f"\n\nLatest user message:\n{request.raw_text}"
    )
    response = client.models.generate_content(
        model=GEMINI_MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=SupportResponse,
            temperature=0.25,
        ),
    )
    if isinstance(response.parsed, SupportResponse):
        return response.parsed
    return SupportResponse(**json.loads(response.text))


def get_support(request: SupportRequest) -> SupportResponse:
    if GEMINI_API_KEY:
        try:
            return support_with_gemini(request)
        except Exception as exc:  # noqa: BLE001 - retain key-free safe fallback
            print(f"[support] Gemini response failed, using fallback: {exc}")

    lower = request.raw_text.lower()
    immediate_danger = any(word in lower for word in _HIGH_URGENCY_WORDS)
    if immediate_danger:
        return SupportResponse(
            message=(
                "I’m here with you. If you can move away from the danger "
                "without putting yourself at more risk, do that now and contact "
                "local emergency services—this app cannot place that call. "
                "What is your exact location?"
            ),
            immediate_actions=[
                "Move to a safer place only if it is safe to move.",
                "Contact local emergency services now.",
                "Keep your phone with you.",
            ],
        )
    return SupportResponse(
        message=(
            "I’m here with you. Stay where you feel safest and take this one "
            "step at a time. What is the most urgent thing you need right now?"
        ),
        immediate_actions=["Stay somewhere safe.", "Keep your phone nearby."],
    )


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@app.get("/")
def health():
    return {
        "status": "ok",
        "service": "AI Crisis Triage Mapper",
        "mode": "gemini" if GEMINI_API_KEY else "mock",
        "live_voice": bool(GEMINI_API_KEY),
        "live_model": GEMINI_LIVE_MODEL if GEMINI_API_KEY else None,
    }


@app.post("/api/triage", response_model=Report)
def triage(request: TriageRequest):
    if not request.raw_text.strip():
        raise HTTPException(status_code=400, detail="raw_text must not be empty")
    extracted = extract(request.raw_text)
    return insert_report(extracted)


@app.post("/api/support", response_model=SupportResponse)
def crisis_support(request: SupportRequest):
    if not request.raw_text.strip():
        raise HTTPException(status_code=400, detail="raw_text must not be empty")
    return get_support(request)


@app.get("/api/reports", response_model=list[Report])
def get_reports():
    return list_reports()


@app.delete("/api/reports/{report_id}", status_code=204)
def resolve_report(report_id: int):
    if not delete_report(report_id):
        raise HTTPException(status_code=404, detail="Report not found")


@app.websocket("/ws/live-support")
async def live_support(websocket: WebSocket):
    if not GEMINI_API_KEY:
        await websocket.accept()
        await websocket.send_json(
            {
                "type": "error",
                "message": (
                    "Live voice requires GEMINI_API_KEY. You can still type "
                    "your report below."
                ),
            }
        )
        await websocket.close(code=1011)
        return

    bridge = LiveSupportBridge(
        api_key=GEMINI_API_KEY,
        model=GEMINI_LIVE_MODEL,
        voice=GEMINI_LIVE_VOICE,
        save_report=save_live_report,
    )
    await bridge.run(websocket)
