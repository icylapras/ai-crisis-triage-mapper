import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faMicrophone,
  faNewspaper,
} from "@fortawesome/free-solid-svg-icons";
import { faGoogle } from "@fortawesome/free-brands-svg-icons";
import { Link } from "react-router-dom";
import "./CrisisRail.css";

export default function CrisisRail({
  active = "incidents",
  onAssistant,
  disabled = false,
}) {
  const assistantContent = (
    <FontAwesomeIcon icon={faGoogle} aria-hidden="true" />
  );

  return (
    <nav className="gemini-rail" aria-label="Crisis navigation">
      <Link
        className={`rail-item${active === "incidents" ? " is-active" : ""}`}
        to="/user"
        aria-label="Incidents"
        aria-current={active === "incidents" ? "page" : undefined}
        title="Incidents"
      >
        <FontAwesomeIcon icon={faMicrophone} aria-hidden="true" />
      </Link>

      <Link
        className={`rail-item${active === "news" ? " is-active" : ""}`}
        to="/news"
        aria-label="Crisis news"
        aria-current={active === "news" ? "page" : undefined}
        title="Crisis news"
      >
        <FontAwesomeIcon icon={faNewspaper} aria-hidden="true" />
      </Link>

      {onAssistant ? (
        <button
          className="rail-item rail-gemini"
          type="button"
          onClick={onAssistant}
          disabled={disabled}
          aria-label="Focus crisis assistant"
          title="Crisis assistant"
        >
          {assistantContent}
        </button>
      ) : (
        <Link
          className="rail-item rail-gemini"
          to="/user"
          aria-label="Open crisis assistant"
          title="Crisis assistant"
        >
          {assistantContent}
        </Link>
      )}
    </nav>
  );
}
