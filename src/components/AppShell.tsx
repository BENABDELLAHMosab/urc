import React, {useLayoutEffect, useRef, useState} from 'react';
import type {ReactNode} from 'react';
import {Link, useLocation, useNavigate} from 'react-router-dom';
import {useDispatch, useSelector} from 'react-redux';
import type {AppDispatch, RootState} from '../app/store';
import {NotificationControls} from '../features/notifications/NotificationControls';
import {logoutSession} from '../features/auth/sessionApi';
import {resetAuth} from '../features/auth/authSlice';
import {clearStoredSession} from '../user/loginApi';

export function AppShell({children, sidebar, kind = 'private', conversation = false}: {
    children: ReactNode; sidebar: ReactNode; kind?: 'private' | 'room'; conversation?: boolean;
}) {
    const content = useRef<HTMLElement | null>(null);
    const {pathname} = useLocation();
    const dispatch = useDispatch<AppDispatch>();
    const navigate = useNavigate();
    const [loggingOut, setLoggingOut] = useState(false);
    const [logoutError, setLogoutError] = useState('');
    const logoutPending = useRef(false);
    const handleLogout = async () => {
        if (logoutPending.current) return;
        logoutPending.current = true;
        setLoggingOut(true);
        setLogoutError('');
        try {
            await logoutSession();
        } catch {
            logoutPending.current = false;
            setLoggingOut(false);
            setLogoutError('Déconnexion impossible. Veuillez réessayer.');
            return;
        }
        clearStoredSession();
        // Le reset vide les slices et déclenche la désassociation Beams via usePushSession.
        dispatch(resetAuth());
        navigate('/login', {replace: true});
    };
    useLayoutEffect(() => {
        // Revenir au début de la page, sans toucher au scroll interne des messages.
        if (content.current) content.current.scrollTop = 0;
    }, [pathname]);
    const user = useSelector((state: RootState) => state.auth.user);
    return <div className={`chat-shell${conversation ? ' is-conversation' : ' is-directory'}${kind === 'room' ? ' is-room' : ''}`}>
        <a className="skip-link" href="#chat-content">Aller au contenu</a>
        <aside className="sidebar" aria-label="Navigation de la messagerie">
            <header className="sidebar-header">
                <Link to="/messages" className="brand">UBO Relay Chat</Link>
                {user && <div className="account"><span className="initial" aria-hidden="true">{user.username.charAt(0).toUpperCase()}</span>
                    <div><span className="account-label">Connecté :</span><strong>{user.username}</strong></div>
                </div>}
                <button type="button" className="button-quiet logout-button" onClick={() => void handleLogout()} disabled={loggingOut}>
                    {loggingOut ? 'Déconnexion…' : 'Se déconnecter'}
                </button>
                {logoutError && <p className="logout-error" role="alert">{logoutError}</p>}
                <details className="notification-preferences">
                    <summary>Notifications</summary>
                    <NotificationControls />
                </details>
            </header>
            <nav className="primary-nav" aria-label="Espaces de discussion">
                <Link to="/messages" aria-current={kind === 'private' ? 'page' : undefined}>Messagerie privée</Link>
                <Link to="/rooms" aria-current={kind === 'room' ? 'page' : undefined}>Salons de discussion</Link>
            </nav>
            {sidebar}
        </aside>
        <main ref={content} id="chat-content" className="chat-content" tabIndex={-1}>{children}</main>
    </div>;
}
