import { Navigate, Route, Routes } from "react-router-dom";
import NewsPage from "./pages/NewsPage.jsx";
import ResponderPage from "./pages/ResponderPage.jsx";
import UserPage from "./pages/UserPage.jsx";
import "./App.css";

export default function App() {
  return (
    <div className="shell">
      <div className="content">
        <Routes>
          <Route path="/" element={<Navigate to="/user" replace />} />
          <Route path="/user" element={<UserPage />} />
          <Route path="/responder" element={<ResponderPage />} />
          <Route path="/news" element={<NewsPage />} />
          <Route path="*" element={<Navigate to="/user" replace />} />
        </Routes>
      </div>
    </div>
  );
}
