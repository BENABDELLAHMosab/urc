import React from "react";
import {Link} from 'react-router-dom';
import {useUsers} from '../features/users/useUsers';

export function MessagesPage() {
    const {user, items, status, error, retry} = useUsers();
    const others = items.filter(item => item.user_id !== user?.id);

    return (
        <main>
            <h1>UBO Relay Chat</h1>
            {user && <p>Connecté : {user.username}</p>}
            <Link to="/rooms">Salons de discussion</Link>
            <h2>Utilisateurs</h2>
            {(status === 'idle' || status === 'loading') && <p role="status">Chargement des utilisateurs…</p>}
            {status === 'failed' && <div role="alert"><p>{error}</p><button onClick={retry}>Réessayer</button></div>}
            {status === 'succeeded' && (others.length === 0
                ? <p>Aucun autre utilisateur disponible.</p>
                : <ul>{others.map(item => <li key={item.user_id}>
                    <Link to={`/messages/user/${item.user_id}`}>{item.username}</Link>
                </li>)}</ul>)}
        </main>
    );
}
