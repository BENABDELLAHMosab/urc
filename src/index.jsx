import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from 'react-redux'
import { BrowserRouter } from 'react-router-dom'
import { store } from './app/store'
import { AuthInitializer } from './features/auth/AuthInitializer'
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';

createRoot(document.getElementById('root')).render(
    <StrictMode>
        <Provider store={store}>
            <AuthInitializer>
                <BrowserRouter>
                    <App />
                </BrowserRouter>
            </AuthInitializer>
        </Provider>
    </StrictMode>
)

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals(console.log);
