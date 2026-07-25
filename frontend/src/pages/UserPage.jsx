import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faArrowRight,
  faArrowUp,
  faHeartPulse,
  faMicrophone,
  faNotesMedical,
} from "@fortawesome/free-solid-svg-icons";
import { Link } from "react-router-dom";
import {
  getCrisisSupport,
  getLiveSupportWebSocketUrl,
  triageReport,
} from "../api.js";
import CrisisRail from "../components/CrisisRail.jsx";
import { GlowEffect } from "../components/GlowEffect.jsx";
import SiriWave from "../components/SiriWave.jsx";
import { LONDON_NEWS } from "../data/news.js";
import { LiveVoiceClient } from "../live/LiveVoiceClient.js";
import "./UserPage.css";

const SUBMIT_RESPONDER_TOOL = "submit_responder_report";
const SHOW_REQUEST_UPDATE_TOOL = "show_request_information_updated";

export default function UserPage() {
  const [report, setReport] = useState("");
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState("idle");
  const [voiceError, setVoiceError] = useState("");
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState([]);
  const [handoffState, setHandoffState] = useState("idle");
  const [agentThinking, setAgentThinking] = useState(false);
  const [sceneActive, setSceneActive] = useState(false);
  const liveClientRef = useRef(null);
  const liveTranscriptIdsRef = useRef({ user: null, assistant: null });
  const toolActivityMessageIdsRef = useRef(new Map());
  const latestHandoffActivityRef = useRef(null);
  const inputRef = useRef(null);
  const voiceWaveRef = useRef(null);
  const morphZoneRef = useRef(null);
  const conversationRef = useRef(null);
  const sceneActiveRef = useRef(false);
  const morphStartRectRef = useRef(null);
  const conversationStartedRef = useRef(false);
  const initialReportRef = useRef("");
  const messageIdRef = useRef(0);
  const submissionRef = useRef(0);

  useEffect(
    () => () => {
      liveClientRef.current?.stop();
      liveClientRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const conversation = conversationRef.current;
    if (!conversation || !sceneActive) return;

    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)")
      .matches
      ? "auto"
      : "smooth";
    conversation.scrollTo({
      top: conversation.scrollHeight,
      behavior,
    });
  }, [agentThinking, handoffState, messages, sceneActive]);

  useLayoutEffect(() => {
    const morphZone = morphZoneRef.current;
    const startRect = morphStartRectRef.current;
    morphStartRectRef.current = null;

    if (!sceneActive || !morphZone || !startRect) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const endRect = morphZone.getBoundingClientRect();
    const translateX =
      startRect.left +
      startRect.width / 2 -
      (endRect.left + endRect.width / 2);
    const translateY =
      startRect.top +
      startRect.height / 2 -
      (endRect.top + endRect.height / 2);

    morphZone.getAnimations().forEach((animation) => animation.cancel());
    morphZone.animate(
      [
        { transform: `translate3d(${translateX}px, ${translateY}px, 0)` },
        { transform: "translate3d(0, 0, 0)" },
      ],
      {
        duration: 240,
        easing: "cubic-bezier(0.77, 0, 0.175, 1)",
      },
    );
  }, [sceneActive]);

  const activateScene = () => {
    if (sceneActiveRef.current) return;
    sceneActiveRef.current = true;
    morphStartRectRef.current = morphZoneRef.current?.getBoundingClientRect();
    setSceneActive(true);
  };

  const closeVoice = () => {
    liveClientRef.current?.stop();
    liveClientRef.current = null;
    liveTranscriptIdsRef.current = { user: null, assistant: null };
    setVoiceOpen(false);
    setVoiceStatus("idle");
    setVoiceError("");
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const nextMessageId = () => {
    messageIdRef.current += 1;
    return messageIdRef.current;
  };

  const recordToolActivity = ({
    id: activityId,
    tool,
    status,
    report: activityReport,
  }) => {
    if (!activityId || !tool) return;

    let messageId = toolActivityMessageIdsRef.current.get(activityId);
    if (!messageId) {
      messageId = nextMessageId();
      toolActivityMessageIdsRef.current.set(activityId, messageId);
      setMessages((current) => [
        ...current,
        {
          id: messageId,
          role: "tool",
          tool,
          status,
          report: activityReport ?? null,
        },
      ]);
    } else {
      setMessages((current) =>
        current.map((message) =>
          message.id === messageId
            ? {
                ...message,
                status,
                report: activityReport ?? message.report,
              }
            : message,
        ),
      );
    }

    if (tool === SUBMIT_RESPONDER_TOOL) {
      latestHandoffActivityRef.current = activityId;
      setHandoffState(
        status === "running"
          ? "sending"
          : status === "success"
            ? "sent"
            : "failed",
      );
    }
  };

  const appendLiveTranscript = ({ role, text, finished }) => {
    const messageRole = role === "assistant" ? "assistant" : "user";
    let messageId = liveTranscriptIdsRef.current[messageRole];

    if (!messageId && text) {
      messageId = nextMessageId();
      liveTranscriptIdsRef.current[messageRole] = messageId;
      setMessages((current) => [
        ...current,
        {
          id: messageId,
          role: messageRole,
          content: text,
        },
      ]);
    } else if (messageId && text) {
      setMessages((current) =>
        current.map((message) =>
          message.id === messageId
            ? { ...message, content: `${message.content}${text}` }
            : message,
        ),
      );
    }

    if (messageRole === "user" && text) {
      conversationStartedRef.current = true;
      initialReportRef.current += text;
      activateScene();
    }
    if (finished) {
      liveTranscriptIdsRef.current[messageRole] = null;
    }
  };

  const toggleVoice = async () => {
    if (voiceOpen) {
      closeVoice();
      return;
    }

    setVoiceError("");
    setVoiceStatus("connecting");
    setVoiceOpen(true);
    requestAnimationFrame(() => voiceWaveRef.current?.focus());

    const client = new LiveVoiceClient({
      url: getLiveSupportWebSocketUrl(),
      onStatus: (status) => {
        if (status === "speaking") {
          liveTranscriptIdsRef.current.user = null;
        }
        setVoiceStatus(status);
      },
      onTranscript: appendLiveTranscript,
      onToolActivity: recordToolActivity,
      onInterrupted: () => {
        liveTranscriptIdsRef.current.assistant = null;
      },
      onTurnComplete: () => {
        liveTranscriptIdsRef.current = { user: null, assistant: null };
      },
      onError: (message) => {
        setVoiceError(message);
        setVoiceStatus("error");
      },
      onClose: ({ intentional }) => {
        if (liveClientRef.current !== client) return;
        if (!intentional) {
          setVoiceError(
            (current) =>
              current ||
              "Live voice disconnected. You can close it and type below.",
          );
          setVoiceStatus("error");
        }
      },
    });
    liveClientRef.current = client;

    try {
      await client.start();
    } catch (error) {
      if (liveClientRef.current !== client) return;
      setVoiceError(
        (current) =>
          current || error.message || "Live voice support could not start.",
      );
      setVoiceStatus("error");
    }
  };

  const submitReport = async (event) => {
    event.preventDefault();
    const trimmedReport = report.trim();
    if (!trimmedReport || loading) return;

    setVoiceOpen(false);
    setLoading(true);
    setAgentThinking(true);
    activateScene();
    const submissionId = ++submissionRef.current;
    const handoffActivityId = `typed-handoff-${submissionId}`;
    const history = messages
      .filter(({ role }) => role === "user" || role === "assistant")
      .map(({ role, content }) => ({ role, content }));
    const userMessage = {
      id: nextMessageId(),
      role: "user",
      content: trimmedReport,
    };

    setMessages((current) => [...current, userMessage]);
    setReport("");

    if (!conversationStartedRef.current) {
      conversationStartedRef.current = true;
      initialReportRef.current = trimmedReport;
      recordToolActivity({
        id: handoffActivityId,
        tool: SUBMIT_RESPONDER_TOOL,
        status: "running",
      });

      const [triageResult, supportResult] = await Promise.allSettled([
        triageReport(trimmedReport),
        getCrisisSupport(trimmedReport),
      ]);

      if (submissionRef.current !== submissionId) return;

      if (triageResult.status === "fulfilled") {
        recordToolActivity({
          id: handoffActivityId,
          tool: SUBMIT_RESPONDER_TOOL,
          status: "success",
          report: triageResult.value,
        });
      } else {
        recordToolActivity({
          id: handoffActivityId,
          tool: SUBMIT_RESPONDER_TOOL,
          status: "error",
        });
      }

      const support =
        supportResult.status === "fulfilled"
          ? supportResult.value
          : {
              message:
                "I’m here with you. Stay somewhere safe and keep your phone nearby.",
              immediate_actions: [],
            };

      setMessages((current) => [
        ...current,
        {
          id: nextMessageId(),
          role: "assistant",
          content: support.message,
          actions: support.immediate_actions,
        },
      ]);
      setAgentThinking(false);
      setLoading(false);
      return;
    }

    try {
      const support = await getCrisisSupport(trimmedReport, history);
      if (submissionRef.current !== submissionId) return;
      setMessages((current) => [
        ...current,
        {
          id: nextMessageId(),
          role: "assistant",
          content: support.message,
          actions: support.immediate_actions,
        },
      ]);
    } catch {
      if (submissionRef.current === submissionId) {
        setMessages((current) => [
          ...current,
          {
            id: nextMessageId(),
            role: "assistant",
            content:
              "I’m still here. Stay somewhere safe and try your message again.",
            actions: [],
          },
        ]);
      }
    } finally {
      if (submissionRef.current === submissionId) {
        setAgentThinking(false);
        setLoading(false);
      }
    }
  };

  const retryHandoff = async () => {
    const activityId = latestHandoffActivityRef.current;
    if (
      !initialReportRef.current ||
      !activityId ||
      handoffState === "sending"
    ) {
      return;
    }
    recordToolActivity({
      id: activityId,
      tool: SUBMIT_RESPONDER_TOOL,
      status: "running",
    });
    try {
      const createdReport = await triageReport(initialReportRef.current);
      recordToolActivity({
        id: activityId,
        tool: SUBMIT_RESPONDER_TOOL,
        status: "success",
        report: createdReport,
      });
    } catch {
      recordToolActivity({
        id: activityId,
        tool: SUBMIT_RESPONDER_TOOL,
        status: "error",
      });
    }
  };

  return (
    <section className="neural-view" data-engaged={sceneActive}>
      <CrisisRail
        active="incidents"
        disabled={loading}
        onAssistant={() =>
          voiceOpen ? toggleVoice() : inputRef.current?.focus()
        }
      />

      <div className="location-indicator">London, UK</div>

      <main className="neural-stage">
        <h1 className="neural-title">
          {voiceOpen
            ? voiceStatus === "connecting"
              ? "Connecting you now."
              : voiceStatus === "speaking"
                ? "I’m here with you."
                : voiceStatus === "error"
                  ? "Voice support paused."
                  : "I’m listening, Danyil."
            : loading
              ? "I’m assessing the situation."
              : "What’s happening, Danyil?"}
        </h1>

        {sceneActive && (
          <section
            ref={conversationRef}
            className="conversation-thread"
            aria-label="Conversation with crisis support"
            aria-live="polite"
          >
            {messages.map((message) => (
              <div className="conversation-turn" key={message.id}>
                {message.role === "tool" ? (
                  <div
                    className="tool-activity"
                    data-status={message.status}
                    data-tool={message.tool}
                  >
                    <FontAwesomeIcon
                      className="tool-activity-icon"
                      icon={
                        message.tool === SUBMIT_RESPONDER_TOOL
                          ? faHeartPulse
                          : faNotesMedical
                      }
                      aria-hidden="true"
                    />
                    <span>
                      {message.tool === SHOW_REQUEST_UPDATE_TOOL
                        ? "Request has been updated with new information."
                        : message.status === "running"
                          ? "Sending request to responders…"
                          : message.status === "success"
                            ? "Request sent to responders."
                            : "Request could not be sent."}
                    </span>
                    {message.tool === SUBMIT_RESPONDER_TOOL &&
                      message.status === "success" &&
                      message.report && (
                        <Link to="/responder">View map</Link>
                      )}
                    {message.tool === SUBMIT_RESPONDER_TOOL &&
                      message.status === "error" && (
                        <button type="button" onClick={retryHandoff}>
                          Try again
                        </button>
                      )}
                  </div>
                ) : (
                  <article className={`chat-bubble is-${message.role}`}>
                    <p>{message.content}</p>
                    {message.actions?.length > 0 && (
                      <ul>
                        {message.actions.map((action) => (
                          <li key={action}>{action}</li>
                        ))}
                      </ul>
                    )}
                  </article>
                )}
              </div>
            ))}

            {agentThinking && (
              <div
                className="chat-bubble is-assistant is-thinking"
                aria-label="Support agent is responding"
              >
                <span />
                <span />
                <span />
              </div>
            )}
          </section>
        )}

        <div
          ref={morphZoneRef}
          className="morph-zone"
          data-voice={voiceOpen}
        >
          <div className="input-glow" data-visible={!voiceOpen}>
            <GlowEffect
              colors={["#0894ff", "#c959dd", "#ff2e54", "#ff9004"]}
              mode="rotate"
              blur="medium"
              scale={1.04}
              duration={6}
            />
          </div>

          <form
            className={`prompt-pill${loading ? " is-loading" : ""}`}
            onSubmit={submitReport}
            aria-hidden={voiceOpen}
          >
            <input
              ref={inputRef}
              type="text"
              value={report}
              onChange={(event) => setReport(event.target.value)}
              placeholder={
                messages.length > 0
                  ? "Message the support agent…"
                  : "Describe the crisis…"
              }
              aria-label="Crisis report"
              disabled={loading || voiceOpen}
              autoComplete="off"
              tabIndex={voiceOpen ? -1 : 0}
            />

            <button
              className="voice-button"
              type="button"
              onClick={toggleVoice}
              disabled={loading || voiceOpen}
              aria-label="Start voice input"
              tabIndex={voiceOpen ? -1 : 0}
            >
              <FontAwesomeIcon icon={faMicrophone} aria-hidden="true" />
            </button>

            {report.trim() && (
              <button
                className="send-button"
                type="submit"
                disabled={loading || voiceOpen}
                aria-label={
                  messages.length > 0
                    ? "Send message"
                    : "Send crisis report"
                }
                tabIndex={voiceOpen ? -1 : 0}
              >
                {loading ? (
                  <span className="send-loader" />
                ) : (
                  <FontAwesomeIcon icon={faArrowUp} aria-hidden="true" />
                )}
              </button>
            )}
          </form>

          <button
            ref={voiceWaveRef}
            className="listening-wave"
            type="button"
            onClick={toggleVoice}
            aria-label="Stop voice input"
            aria-hidden={!voiceOpen}
            tabIndex={voiceOpen ? 0 : -1}
          >
            <span className="wave-content">
              {voiceOpen && (
                <SiriWave
                  width={700}
                  height={190}
                  renderScale={0.68}
                  active={voiceStatus !== "error"}
                  className="voice-siri-wave"
                />
              )}
              <span className="wave-status" data-status={voiceStatus}>
                <span className="listening-dot" aria-hidden="true" />
                <span>
                  {voiceError ||
                    (voiceStatus === "connecting"
                      ? "Connecting securely…"
                      : voiceStatus === "speaking"
                        ? "Speaking — you can interrupt"
                        : "Listening — touch to stop")}
                </span>
              </span>
            </span>
          </button>
        </div>

        <section className="news-preview" aria-labelledby="news-preview-title">
          <header className="news-preview-header">
            <h2 id="news-preview-title">News</h2>
            <p>What’s happening in London, UK</p>
          </header>

          <div className="news-preview-grid">
            {LONDON_NEWS.slice(0, 3).map((item) => (
              <article className="news-preview-card" key={item.title}>
                <h3>{item.title}</h3>
                <p>{item.description}</p>
              </article>
            ))}
          </div>

          <Link className="news-more-link" to="/news">
            <span>Show more</span>
            <FontAwesomeIcon icon={faArrowRight} aria-hidden="true" />
          </Link>
        </section>
      </main>
    </section>
  );
}
