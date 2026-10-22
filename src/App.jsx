import './App.css';
import {Navigate, Route, Routes} from "react-router-dom";
import {LoginPage} from "./pages/LoginPage";
import {MessagesPage} from "./pages/MessagesPage";
import {NotFoundPage} from "./pages/NotFoundPage";
import {ProtectedRoute} from "./routes/ProtectedRoute";
import {RegisterPage} from "./pages/RegisterPage";

function App() {

  return (
      <Routes>
          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route element={<ProtectedRoute />}>
              <Route path="/messages" element={<MessagesPage />} />
          </Route>
          <Route path="*" element={<NotFoundPage />} />
      </Routes>
  );
}

export default App;
