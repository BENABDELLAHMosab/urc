import React, {Fragment, useEffect, useLayoutEffect, useRef, useState} from 'react';
import type {FormEvent} from 'react';
import {useParams} from 'react-router-dom';
import {useDispatch, useSelector} from 'react-redux';
import type {AppDispatch, RootState} from '../app/store';
import {useUsers} from '../features/users/useUsers';
import {clearMessages, openConversation, sendMessage} from '../features/messages/messagesSlice';
import {useMessagePolling} from '../features/messages/useMessagePolling';
import {isMessageContent, isUserId} from '../../lib/privateMessages.js';
import type {PublicUser} from '../features/users/usersApi';
import type {AuthUser} from '../features/auth/authSlice';
import {AppShell} from '../components/AppShell';
import {Directory} from '../components/Directory';
import {ConversationHeader, MessageBubble, MessageComposer} from '../components/ConversationUI';
import './ConversationPage.css';

function PrivateConversation({recipient, user}: {recipient: PublicUser; user: AuthUser}) {
    const dispatch = useDispatch<AppDispatch>();
    const messages = useSelector((state: RootState) => state.messages);
    const [draft, setDraft] = useState('');
    const active = useRef(false);
    const pendingSend = useRef<{abort: () => void} | null>(null);
    const list = useRef<HTMLOListElement | null>(null);
    const nearBottom = useRef(true);
    useEffect(() => {
        active.current = true;
        dispatch(openConversation(recipient.user_id));
        return () => {
            active.current = false;
            pendingSend.current?.abort();
            dispatch(clearMessages());
        };
    }, [dispatch, recipient.user_id, user]);
    const refresh = useMessagePolling(recipient.user_id);
    useLayoutEffect(() => {
        if (list.current && nearBottom.current) list.current.scrollTop = list.current.scrollHeight;
    }, [messages.items]);

    const submit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!isMessageContent(draft) || messages.sendStatus === 'loading') return;
        const request = dispatch(sendMessage({recipientId: recipient.user_id, content: draft}));
        pendingSend.current = request;
        const result = await request;
        if (active.current && sendMessage.fulfilled.match(result)) setDraft('');
    };
    // Ne jamais afficher le state de la conversation précédente avant l'effet.
    const current = messages.userId === recipient.user_id;
    const sending = current && messages.sendStatus === 'loading';
    return <section className="private-conversation" aria-label="Conversation privée">
        <ConversationHeader title={`Conversation avec ${recipient.username}`} subtitle="Discussion privée"
            backTo="/messages" backLabel="Retour aux utilisateurs"
            action={<button className="button-quiet" type="button" disabled={!current || messages.readStatus === 'loading'} onClick={refresh}>Actualiser</button>} />
        {(!current || (!messages.hasLoaded && messages.readStatus === 'loading')) && <p role="status">Chargement des messages…</p>}
        {current && messages.readError && <p className={messages.hasLoaded ? 'polling-error' : undefined}
            role={messages.hasLoaded ? 'status' : 'alert'}>{messages.readError}</p>}
        {current && messages.hasLoaded && messages.items.length === 0 && <p>Aucun message pour le moment.</p>}
        <ol className="private-messages" aria-label="Messages" ref={list} tabIndex={0} onScroll={() => {
            if (list.current) nearBottom.current = list.current.scrollHeight - list.current.scrollTop - list.current.clientHeight < 80;
        }}>
            {current && messages.items.map(message => <MessageBubble key={message.id} mine={message.senderId === user.id}
                sender={message.senderId === user.id ? 'Vous' : recipient.username} content={message.content} createdAt={message.createdAt} />)}
        </ol>
        <MessageComposer id="private-message" label="Votre message" draft={draft} onChange={setDraft} onSubmit={submit}
            sending={sending} disabled={!current || sending || !isMessageContent(draft)} />
        {current && messages.sendError && <p role="alert">{messages.sendError}</p>}
    </section>;
}

export function ConversationPage() {
    const {userId} = useParams<{userId: string}>();
    const currentUser = useSelector((state: RootState) => state.auth.user);
    const id = Number(userId);
    const valid = !!userId && /^[1-9]\d*$/.test(userId) && isUserId(id);
    const self = valid && id === currentUser?.id;
    const {items, status, error, retry} = useUsers(valid && !self);
    const recipient = items.find(user => user.user_id === id);

    let content: React.ReactNode;
    if (!valid) content = <p role="alert">Identifiant utilisateur invalide.</p>;
    else if (self) content = <p role="alert">Vous ne pouvez pas sélectionner votre propre compte.</p>;
    else if (status === 'failed') content = <div role="alert"><p>{error}</p><button onClick={retry}>Réessayer</button></div>;
    else if (status !== 'succeeded') content = <p role="status">Chargement du destinataire…</p>;
    else if (!recipient) content = <p role="alert">Utilisateur introuvable.</p>;
    else if (currentUser) content = <Fragment key={`${currentUser.id}:${id}`}>
        <PrivateConversation recipient={recipient} user={currentUser} /></Fragment>;

    return <AppShell conversation sidebar={<Directory title="Utilisateurs" status={status} error={error} retry={retry} activeId={id}
        items={items.filter(item => item.user_id !== currentUser?.id).map(item => ({id: item.user_id, label: item.username, to: `/messages/user/${item.user_id}`}))} />}>
        {!(valid && !self && status === 'succeeded' && recipient && currentUser) && <ConversationHeader
            title="Discussion privée" subtitle="" backTo="/messages" backLabel="Retour aux utilisateurs" action={null} />}
        {content}
    </AppShell>;
}
