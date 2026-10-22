import './App.css';
import {Navigate, Route, Routes} from "react-router-dom";
import {LoginPage} from "./pages/LoginPage";
import {MessagesPage} from "./pages/MessagesPage";
import {NotFoundPage} from "./pages/NotFoundPage";
import {ProtectedRoute} from "./routes/ProtectedRoute";

function App() {

  return (
      <Routes>
          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="/login" element={<LoginPage />} />
          <Route element={<ProtectedRoute />}>
              <Route path="/messages" element={<MessagesPage />} />
          </Route>
          <Route path="*" element={<NotFoundPage />} />
      </Routes>
  );
}

export default App;
