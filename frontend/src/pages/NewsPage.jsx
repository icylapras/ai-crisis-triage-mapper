import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowLeft } from "@fortawesome/free-solid-svg-icons";
import { Link } from "react-router-dom";
import CrisisRail from "../components/CrisisRail.jsx";
import { LONDON_NEWS } from "../data/news.js";
import "./NewsPage.css";

export default function NewsPage() {
  return (
    <section className="news-page">
      <CrisisRail active="news" />
      <div className="news-location">London, UK</div>

      <main className="news-page-content">
        <Link className="news-back-link" to="/user">
          <FontAwesomeIcon icon={faArrowLeft} aria-hidden="true" />
          <span>Back to crisis assistant</span>
        </Link>

        <header className="news-page-header">
          <span className="news-page-eyebrow">Local briefing</span>
          <h1>London news</h1>
          <p>
            Prototype crisis briefings for London, collected in one calm,
            scannable view.
          </p>
        </header>

        <div className="news-page-grid">
          {LONDON_NEWS.map((item) => (
            <article className="news-page-card" key={item.title}>
              <span>{item.category}</span>
              <h2>{item.title}</h2>
              <p>{item.description}</p>
            </article>
          ))}
        </div>
      </main>
    </section>
  );
}
