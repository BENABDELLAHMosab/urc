import './App.css';
import {Navigate, Route, Routes} from "react-router-dom";
import {LoginPage} from "./pages/LoginPage";
import {MessagesPage} from "./pages/MessagesPage";
import {NotFoundPage} from "./pages/NotFoundPage";

function App() {

  return (
      <Routes>
          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/messages" element={<MessagesPage />} />
          <Route path="*" element={<NotFoundPage />} />
      </Routes>
  );
}

export default App;
