import './App.css';
import {Navigate, Route, Routes} from "react-router-dom";
import {LoginPage} from "./pages/LoginPage";
import {MessagesPage} from "./pages/MessagesPage";
import {NotFoundPage} from "./pages/NotFoundPage";
import {ProtectedRoute} from "./routes/ProtectedRoute";
import {RegisterPage} from "./pages/RegisterPage";
import {ConversationPage} from "./pages/ConversationPage";
import {RoomsPage} from './pages/RoomsPage';
import {RoomPage} from './pages/RoomPage';

function App() {

  return (
      <Routes>
          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route element={<ProtectedRoute />}>
              <Route path="/messages" element={<MessagesPage />} />
              <Route path="/messages/user/:userId" element={<ConversationPage />} />
              <Route path="/rooms" element={<RoomsPage />} />
              <Route path="/rooms/:roomId" element={<RoomPage />} />
          </Route>
          <Route path="*" element={<NotFoundPage />} />
      </Routes>
  );
}

export default App;
