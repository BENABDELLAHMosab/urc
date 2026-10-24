import React, {Fragment, useEffect, useLayoutEffect, useRef, useState} from 'react';
import type {FormEvent} from 'react';
import {useParams} from 'react-router-dom';
import {useDispatch, useSelector} from 'react-redux';
import type {AppDispatch, RootState} from '../app/store';
import type {AuthUser} from '../features/auth/authSlice';
import type {Room} from '../features/rooms/roomsApi';
import {useRooms} from '../features/rooms/useRooms';
import {clearRoomMessages, openRoom, sendRoomMessage} from '../features/rooms/roomMessagesSlice';
import {useMessagePolling} from '../features/messages/useMessagePolling';
import {isUserId, isMessageContent} from '../../lib/privateMessages.js';
import {AppShell} from '../components/AppShell';
import {Directory} from '../components/Directory';
import {ConversationHeader, MessageBubble, MessageComposer} from '../components/ConversationUI';
import './ConversationPage.css';

function RoomConversation({room, user}: {room: Room; user: AuthUser}) {
    const dispatch = useDispatch<AppDispatch>();
    const messages = useSelector((state: RootState) => state.roomMessages);
    const [draft, setDraft] = useState('');
    const active = useRef(false);
    const pendingSend = useRef<{abort: () => void} | null>(null);
    const list = useRef<HTMLOListElement | null>(null);
    const nearBottom = useRef(true);
    useEffect(() => {
        active.current = true; dispatch(openRoom(room.room_id));
        return () => {active.current = false; pendingSend.current?.abort(); dispatch(clearRoomMessages());};
    }, [dispatch, room.room_id, user]);
    useMessagePolling(room.room_id, 'room');
    useLayoutEffect(() => {
        if (list.current && nearBottom.current) list.current.scrollTop = list.current.scrollHeight;
    }, [messages.items]);
    const submit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!isMessageContent(draft) || messages.sendStatus === 'loading') return;
        const request = dispatch(sendRoomMessage({roomId: room.room_id, content: draft})); pendingSend.current = request;
        const result = await request;
        if (active.current && sendRoomMessage.fulfilled.match(result)) setDraft('');
    };
    const current = messages.roomId === room.room_id;
    const sending = current && messages.sendStatus === 'loading';
    return <section className="private-conversation" aria-label="Messages du salon">
        <ConversationHeader title={`Salon : ${room.name}`} subtitle="Tous les utilisateurs connectés peuvent lire et écrire ici."
            backTo="/rooms" backLabel="Retour aux salons" />
        {(!current || (!messages.hasLoaded && messages.readStatus === 'loading')) && <p role="status">Chargement des messages…</p>}
        {current && messages.readError && <p role={messages.hasLoaded ? 'status' : 'alert'} className="polling-error">{messages.readError}</p>}
        {current && messages.hasLoaded && messages.items.length === 0 && <p>Aucun message dans ce salon.</p>}
        <ol className="private-messages" aria-label="Messages" tabIndex={0} ref={list} onScroll={() => {
            if (list.current) nearBottom.current = list.current.scrollHeight - list.current.scrollTop - list.current.clientHeight < 80;
        }}>
            {current && messages.items.map(message => <MessageBubble key={message.id} mine={message.senderId === user.id}
                sender={`${message.senderName}${message.senderId === user.id ? ' (vous)' : ''}`} content={message.content} createdAt={message.createdAt} />)}
        </ol>
        <MessageComposer id="room-message" label="Votre message au salon" draft={draft} onChange={setDraft} onSubmit={submit}
            sending={sending} disabled={!current || sending || !isMessageContent(draft)} />
        {current && messages.sendError && <p role="alert">{messages.sendError}</p>}
    </section>;
}

export function RoomPage() {
    const {roomId} = useParams<{roomId: string}>();
    const id = Number(roomId);
    const valid = !!roomId && /^[1-9]\d*$/.test(roomId) && isUserId(id);
    const user = useSelector((state: RootState) => state.auth.user);
    const rooms = useRooms(valid ? id : undefined);
    const room = rooms.items.find(item => item.room_id === id);
    let content: React.ReactNode;
    if (!valid) content = <p role="alert">Identifiant de salon invalide.</p>;
    else if (!room && rooms.status === 'failed') content = <div role="alert"><p>{rooms.error}</p><button onClick={rooms.retry}>Réessayer</button></div>;
    else if (!room && rooms.status !== 'succeeded') content = <p role="status">Chargement du salon…</p>;
    else if (!room) content = <p role="alert">Salon introuvable.</p>;
    else if (user) content = <Fragment key={`${user.id}:${id}`}><RoomConversation room={room} user={user} /></Fragment>;
    return <AppShell conversation kind="room" sidebar={<Directory title="Salons" kind="room" status={rooms.status} error={rooms.error} retry={rooms.retry} activeId={id}
        items={rooms.items.map(item => ({id: item.room_id, label: item.name, to: `/rooms/${item.room_id}`}))} />}>
        {!(valid && room && user) && <ConversationHeader title="Salon de discussion" subtitle=""
            backTo="/rooms" backLabel="Retour aux salons" action={null} />}
        {content}
    </AppShell>;
}
