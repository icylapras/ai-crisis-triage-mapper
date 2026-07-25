"""Gemini Live voice bridge for crisis support.

The browser connects only to this FastAPI WebSocket. The long-lived Gemini API
key stays on the backend while raw PCM audio and lightweight UI events stream
between the browser and Gemini Live.
"""

import asyncio
import json
import logging
from collections.abc import Callable
from typing import Any

from fastapi import WebSocket
from google import genai
from google.genai import types

logger = logging.getLogger(__name__)

INPUT_SAMPLE_RATE = 16_000
OUTPUT_SAMPLE_RATE = 24_000
SUBMIT_REPORT_TOOL = "submit_responder_report"
SHOW_REQUEST_UPDATE_TOOL = "show_request_information_updated"
_AUDIO_STREAM_END = object()

CRISIS_SUPPORT_INSTRUCTION = """
You are CalmLine, a live voice crisis-support and responder-intake assistant.
You provide psychological first aid and practical safety guidance. You are not
an emergency service, clinician, or substitute for local emergency responders.

How to speak:
- Sound warm, steady, clear, and human. Speak at a natural conversational pace.
- Lead with the single most important action the person should take now.
- Keep a normal reply to no more than three short sentences and roughly 35
  spoken words. Use "First...", "Then...", and "Next..." when there are
  multiple actions. Give no more than three actions at once.
- Use one brief acknowledgement only when it helps. Do not repeat the person's
  story, add a long preamble, or explain the reasoning unless they ask.
- Ask only one clear question at a time and allow silence.
- Do not pressure the person to tell their full story or ask unnecessary
  personal questions.
- Do not diagnose, promise an outcome, claim responders are coming, or say that
  information was sent until the tool result confirms success.

Priorities:
1. LOOK FOR SAFETY. First determine whether there is immediate danger such as
   fire, violence, flooding, structural collapse, severe bleeding,
   unconsciousness, breathing difficulty, or risk of self-harm or harm to
   others. If there is, tell the person to move to a safer place if they can do
   so without increasing danger and to contact local emergency services now.
   Be explicit that this app cannot place that emergency call for them.
   Do not improvise tactical rescue, firefighting, medical, or law-enforcement
   instructions. Encourage following directions from local authorities.
2. LISTEN AND HELP THEM STEADY. Reflect what you heard. Give one small,
   situation-appropriate next step. Keep any reflection to a few words. You may
   offer a brief grounding cue, but do not instruct deep breathing when there
   may be smoke, toxic exposure, chest pain, or breathing difficulty.
3. LINK TO HELP. Gently gather only what responders need: exact location,
   what is happening now, current hazards, injuries and medical needs, number
   of people affected, and any useful name, age, contact, accessibility, or
   medical information the person volunteers.
4. CALL submit_responder_report as soon as responders have enough information
   to act. In imminent danger, call it early with unknown fields marked "n/a"
   and coordinates omitted; do not wait for a perfect intake. Do not invent
   names, ages, coordinates, hazards, or medical facts. Call the tool only once
   per session unless its result reports a failure.
5. After a successful tool result, briefly tell the person their information
   was shared with the responder dashboard. Continue helping them stay safe and
   focused until they end the conversation.
6. AFTER SUBMISSION, if the person gives a distinct piece of materially useful
   new information about this situation, call show_request_information_updated.
   Examples include a more precise location, a changed hazard, a new injury,
   another affected person, or a new access or medical need. Do not call it for
   repeated facts, small talk, or general emotion. This tool only displays a UI
   acknowledgement; it does not save data or notify responders. Never tell the
   person responders received the new information.

Safety-critical instructions may exceed the normal word limit only when
necessary. Match the user's language when practical.
"""

SUBMIT_REPORT_DECLARATION = types.FunctionDeclaration(
    name=SUBMIT_REPORT_TOOL,
    description=(
        "Send the crisis information gathered in this voice session to the "
        "responder dashboard. Call once there is enough information to act, or "
        "immediately for imminent danger. Never fabricate missing values."
    ),
    parameters_json_schema={
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": 'Person name, or literal "n/a" if unknown.',
            },
            "age": {
                "type": "string",
                "description": 'Person age, or literal "n/a" if unknown.',
            },
            "urgency": {
                "type": "integer",
                "minimum": 1,
                "maximum": 10,
                "description": "Assessed urgency from 1 to 10.",
            },
            "title": {
                "type": "string",
                "description": "Operational incident headline, at most 8 words.",
            },
            "summary": {
                "type": "string",
                "description": "Concise description of what is happening now.",
            },
            "notes": {
                "type": "string",
                "description": (
                    "Hazards, injuries, people affected, and immediate needs, "
                    'or literal "n/a".'
                ),
            },
            "other_data": {
                "type": "string",
                "description": (
                    "Other responder-relevant details volunteered by the user, "
                    'such as contact, medical, or accessibility needs; "n/a" '
                    "if unknown."
                ),
            },
            "location": {
                "type": "string",
                "description": 'Most specific known location, or literal "n/a".',
            },
            "lat": {
                "type": "number",
                "description": "Approximate latitude only when reliably known.",
            },
            "lng": {
                "type": "number",
                "description": "Approximate longitude only when reliably known.",
            },
        },
        "required": [
            "name",
            "age",
            "urgency",
            "title",
            "summary",
            "notes",
            "other_data",
            "location",
        ],
    },
)

SHOW_REQUEST_UPDATE_DECLARATION = types.FunctionDeclaration(
    name=SHOW_REQUEST_UPDATE_TOOL,
    description=(
        "Show a UI-only acknowledgement after a responder request was "
        "submitted and the person provides distinct, materially useful new "
        "information about the same situation. This tool does not save or "
        "send the information anywhere."
    ),
    parameters_json_schema={
        "type": "object",
        "properties": {},
        "additionalProperties": False,
    },
)


class LiveSupportBridge:
    """Bridge one browser WebSocket to one Gemini Live session."""

    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        voice: str,
        save_report: Callable[[dict[str, Any]], dict[str, Any]],
    ):
        self._client = genai.Client(api_key=api_key)
        self._model = model
        self._voice = voice
        self._save_report = save_report
        self._audio_queue: asyncio.Queue[bytes | object] = asyncio.Queue(
            maxsize=64
        )
        self._browser_send_lock = asyncio.Lock()
        self._submitted_report: dict[str, Any] | None = None
        self._cancelled_tool_calls: set[str] = set()
        self._resume_handle: str | None = None
        self._resume_requested = False
        self._tool_activity_sequence = 0

    async def run(self, websocket: WebSocket) -> None:
        await websocket.accept()

        try:
            resumed = False
            while True:
                self._resume_requested = False
                config = self._live_config(self._resume_handle)
                async with self._client.aio.live.connect(
                    model=self._model,
                    config=config,
                ) as session:
                    await self._send_json(
                        websocket,
                        {
                            "type": "ready",
                            "model": self._model,
                            "input_sample_rate": INPUT_SAMPLE_RATE,
                            "output_sample_rate": OUTPUT_SAMPLE_RATE,
                            "resumed": resumed,
                        },
                    )

                    tasks = {
                        asyncio.create_task(
                            self._receive_from_browser(websocket),
                            name="live-browser-receive",
                        ),
                        asyncio.create_task(
                            self._send_audio_to_gemini(session),
                            name="live-gemini-send",
                        ),
                        asyncio.create_task(
                            self._receive_from_gemini(websocket, session),
                            name="live-gemini-receive",
                        ),
                    }
                    done, pending = await asyncio.wait(
                        tasks,
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    for task in pending:
                        task.cancel()
                    await asyncio.gather(*pending, return_exceptions=True)
                    for task in done:
                        error = task.exception()
                        if error:
                            raise error

                if not self._resume_requested:
                    return
                resumed = bool(self._resume_handle)
        except Exception as exc:  # noqa: BLE001 - translate SDK failures for UI
            if not _is_normal_disconnect(exc):
                logger.exception("Gemini Live voice session failed")
                await self._safe_send_json(
                    websocket,
                    {
                        "type": "error",
                        "message": (
                            "Live voice support disconnected. You can still "
                            "type your report below."
                        ),
                    },
                )
        finally:
            try:
                await websocket.close()
            except Exception:  # noqa: BLE001 - socket may already be closed
                pass

    def _live_config(
        self,
        resume_handle: str | None = None,
    ) -> types.LiveConnectConfig:
        return types.LiveConnectConfig(
            response_modalities=[types.Modality.AUDIO],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(
                        voice_name=self._voice
                    )
                )
            ),
            system_instruction=types.Content(
                parts=[types.Part(text=CRISIS_SUPPORT_INSTRUCTION)]
            ),
            input_audio_transcription=types.AudioTranscriptionConfig(),
            output_audio_transcription=types.AudioTranscriptionConfig(),
            realtime_input_config=types.RealtimeInputConfig(
                automatic_activity_detection=types.AutomaticActivityDetection(
                    disabled=False,
                    start_of_speech_sensitivity=(
                        types.StartSensitivity.START_SENSITIVITY_HIGH
                    ),
                    end_of_speech_sensitivity=(
                        types.EndSensitivity.END_SENSITIVITY_HIGH
                    ),
                    prefix_padding_ms=200,
                    silence_duration_ms=700,
                ),
                activity_handling=(
                    types.ActivityHandling.START_OF_ACTIVITY_INTERRUPTS
                ),
                turn_coverage=types.TurnCoverage.TURN_INCLUDES_ONLY_ACTIVITY,
            ),
            # Developer API sessions support resume handles, but transparent
            # replay indexing is exclusive to the enterprise Vertex endpoint.
            session_resumption=types.SessionResumptionConfig(
                handle=resume_handle
            ),
            tools=[
                types.Tool(
                    function_declarations=[
                        SUBMIT_REPORT_DECLARATION,
                        SHOW_REQUEST_UPDATE_DECLARATION,
                    ]
                )
            ],
        )

    async def _receive_from_browser(self, websocket: WebSocket) -> None:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                return

            audio = message.get("bytes")
            if audio:
                await self._audio_queue.put(audio)
                continue

            text = message.get("text")
            if not text:
                continue
            try:
                payload = json.loads(text)
            except json.JSONDecodeError:
                continue

            message_type = payload.get("type")
            if message_type == "audio_stream_end":
                await self._audio_queue.put(_AUDIO_STREAM_END)
            elif message_type == "close":
                return

    async def _send_audio_to_gemini(self, session: Any) -> None:
        while True:
            item = await self._audio_queue.get()
            if item is _AUDIO_STREAM_END:
                await session.send_realtime_input(audio_stream_end=True)
                continue
            await session.send_realtime_input(
                audio=types.Blob(
                    data=item,
                    mime_type=f"audio/pcm;rate={INPUT_SAMPLE_RATE}",
                )
            )

    async def _receive_from_gemini(
        self,
        websocket: WebSocket,
        session: Any,
    ) -> None:
        while True:
            received_message = False
            async for response in session.receive():
                received_message = True
                await self._handle_gemini_message(websocket, session, response)
                if self._resume_requested:
                    return
            if not received_message:
                return

    async def _handle_gemini_message(
        self,
        websocket: WebSocket,
        session: Any,
        response: types.LiveServerMessage,
    ) -> None:
        cancellation = response.tool_call_cancellation
        if cancellation and cancellation.ids:
            self._cancelled_tool_calls.update(cancellation.ids)

        resumption = response.session_resumption_update
        if resumption and resumption.resumable and resumption.new_handle:
            self._resume_handle = resumption.new_handle

        content = response.server_content
        if content:
            if content.interrupted:
                await self._send_json(websocket, {"type": "interrupted"})

            if content.input_transcription:
                await self._send_transcript(
                    websocket,
                    role="user",
                    transcription=content.input_transcription,
                )

            if content.output_transcription:
                await self._send_transcript(
                    websocket,
                    role="assistant",
                    transcription=content.output_transcription,
                )

            if content.model_turn and not content.interrupted:
                for part in content.model_turn.parts or []:
                    inline_data = part.inline_data
                    if inline_data and inline_data.data:
                        await self._send_bytes(websocket, inline_data.data)

            if content.turn_complete:
                await self._send_json(websocket, {"type": "turn_complete"})

        if response.tool_call and response.tool_call.function_calls:
            await self._handle_tool_calls(
                websocket,
                session,
                response.tool_call.function_calls,
            )

        if response.go_away:
            self._resume_requested = True
            await self._send_json(
                websocket,
                {
                    "type": "session_ending",
                    "message": "Refreshing the live voice session…",
                },
            )

    async def _handle_tool_calls(
        self,
        websocket: WebSocket,
        session: Any,
        function_calls: list[types.FunctionCall],
    ) -> None:
        responses: list[types.FunctionResponse] = []

        for function_call in function_calls:
            if (
                function_call.id
                and function_call.id in self._cancelled_tool_calls
            ):
                continue

            self._tool_activity_sequence += 1
            activity_id = function_call.id or (
                f"{function_call.name}-{self._tool_activity_sequence}"
            )

            if function_call.name == SHOW_REQUEST_UPDATE_TOOL:
                if self._submitted_report is None:
                    result = {
                        "ok": False,
                        "error": (
                            "No responder request has been submitted in this "
                            "session yet."
                        ),
                    }
                else:
                    result = {
                        "ok": True,
                        "displayed": True,
                        "persisted": False,
                    }
                    await self._send_json(
                        websocket,
                        {
                            "type": "tool_activity",
                            "id": activity_id,
                            "tool": SHOW_REQUEST_UPDATE_TOOL,
                            "status": "success",
                        },
                    )

                responses.append(
                    types.FunctionResponse(
                        id=function_call.id,
                        name=SHOW_REQUEST_UPDATE_TOOL,
                        response=result,
                    )
                )
                continue

            if function_call.name != SUBMIT_REPORT_TOOL:
                responses.append(
                    types.FunctionResponse(
                        id=function_call.id,
                        name=function_call.name,
                        response={"ok": False, "error": "Unknown tool."},
                    )
                )
                continue

            await self._send_json(
                websocket,
                {
                    "type": "tool_activity",
                    "id": activity_id,
                    "tool": SUBMIT_REPORT_TOOL,
                    "status": "running",
                },
            )
            try:
                if self._submitted_report is None:
                    self._submitted_report = await asyncio.to_thread(
                        self._save_report,
                        dict(function_call.args or {}),
                    )
                result = {
                    "ok": True,
                    "report": self._submitted_report,
                }
                await self._send_json(
                    websocket,
                    {
                        "type": "tool_activity",
                        "id": activity_id,
                        "tool": SUBMIT_REPORT_TOOL,
                        "status": "success",
                        "report": self._submitted_report,
                    },
                )
            except Exception as exc:  # noqa: BLE001 - return tool failure to model
                logger.exception("Live responder handoff failed")
                result = {
                    "ok": False,
                    "error": "The responder report could not be saved.",
                }
                await self._send_json(
                    websocket,
                    {
                        "type": "tool_activity",
                        "id": activity_id,
                        "tool": SUBMIT_REPORT_TOOL,
                        "status": "error",
                        "message": str(exc),
                    },
                )

            responses.append(
                types.FunctionResponse(
                    id=function_call.id,
                    name=SUBMIT_REPORT_TOOL,
                    response=result,
                )
            )

        if responses:
            await session.send_tool_response(function_responses=responses)

    async def _send_transcript(
        self,
        websocket: WebSocket,
        *,
        role: str,
        transcription: types.Transcription,
    ) -> None:
        if not transcription.text and not transcription.finished:
            return
        await self._send_json(
            websocket,
            {
                "type": "transcript",
                "role": role,
                "text": transcription.text or "",
                "finished": bool(transcription.finished),
            },
        )

    async def _send_json(
        self,
        websocket: WebSocket,
        payload: dict[str, Any],
    ) -> None:
        async with self._browser_send_lock:
            await websocket.send_json(payload)

    async def _send_bytes(self, websocket: WebSocket, data: bytes) -> None:
        async with self._browser_send_lock:
            await websocket.send_bytes(data)

    async def _safe_send_json(
        self,
        websocket: WebSocket,
        payload: dict[str, Any],
    ) -> None:
        try:
            await self._send_json(websocket, payload)
        except Exception:  # noqa: BLE001 - best-effort error delivery
            pass


def _is_normal_disconnect(exc: Exception) -> bool:
    name = type(exc).__name__.lower()
    return "disconnect" in name or "connectionclosed" in name
