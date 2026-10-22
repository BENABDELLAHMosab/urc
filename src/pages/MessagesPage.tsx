import React from 'react';
import {useUsers} from '../features/users/useUsers';
import {AppShell} from '../components/AppShell';
import {Directory} from '../components/Directory';

export function MessagesPage() {
    const {user, items, status, error, retry} = useUsers();
    const others = items.filter(item => item.user_id !== user?.id);
    return <AppShell sidebar={<Directory title="Utilisateurs" status={status} error={error} retry={retry}
        items={others.map(item => ({id: item.user_id, label: item.username, to: `/messages/user/${item.user_id}`}))} />}>
        <header className="page-header"><h1>Discussions privées</h1><p>Un espace pour échanger directement.</p></header>
        <div className="empty-conversation"><span className="empty-rule" aria-hidden="true" />
            <h2>Commencez une conversation</h2><p>Sélectionnez un utilisateur pour lire vos échanges ou lui écrire.</p>
        </div>
    </AppShell>;
}
