import React, {useEffect, useRef, useState} from 'react';
import type {FormEvent} from 'react';
import {useNavigate} from 'react-router-dom';
import {useDispatch} from 'react-redux';
import type {AppDispatch} from '../app/store';
import {useRooms} from '../features/rooms/useRooms';
import {createRoom} from '../features/rooms/roomsSlice';
import {AppShell} from '../components/AppShell';
import {Directory} from '../components/Directory';
import {isRoomName, normalizeRoomName} from '../../lib/rooms.js';

export function RoomsPage() {
    const rooms = useRooms();
    const dispatch = useDispatch<AppDispatch>();
    const navigate = useNavigate();
    const [name, setName] = useState('');
    const [validationError, setValidationError] = useState('');
    const active = useRef(false);
    const pending = useRef<{abort: () => void} | null>(null);
    useEffect(() => {
        active.current = true;
        return () => {active.current = false; pending.current?.abort();};
    }, []);
    const submit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault(); setValidationError('');
        if (rooms.createStatus === 'loading') return;
        if (!isRoomName(normalizeRoomName(name))) {
            setValidationError('Le nom doit contenir 1 à 50 caractères, sans caractères de contrôle.'); return;
        }
        const request = dispatch(createRoom(name)); pending.current = request;
        const result = await request;
        if (active.current && createRoom.fulfilled.match(result)) {
            setName(''); navigate(`/rooms/${result.payload.room_id}`);
        }
    };
    return <AppShell kind="room" sidebar={<Directory title="Salons" kind="room" action={<a className="directory-action" href="#create-room">Nouveau salon</a>} status={rooms.status} error={rooms.error} retry={rooms.retry}
        items={rooms.items.map(room => ({id: room.room_id, label: room.name, to: `/rooms/${room.room_id}`}))} />}>
        <header className="page-header"><h1>Salons de discussion</h1><p>Accessibles à tous les utilisateurs connectés.</p></header>
        <section id="create-room" className="room-create"><h2>Créer un salon</h2><p>Un espace commun pour échanger à plusieurs.</p>
        <form onSubmit={submit} noValidate>
            <label htmlFor="room-name">Nom du nouveau salon</label>
            <input id="room-name" name="name" value={name} maxLength={50} required
                onChange={event => setName(event.target.value)} disabled={rooms.createStatus === 'loading'}
                aria-describedby="room-name-error" aria-invalid={!!(validationError || rooms.createError)} />
            <button className="button-primary" type="submit" disabled={rooms.createStatus === 'loading'}>
                {rooms.createStatus === 'loading' ? 'Création en cours…' : 'Créer un salon'}</button>
            {(validationError || rooms.createError) && <p id="room-name-error" role="alert">{validationError || rooms.createError}</p>}
        </form>
        </section>
    </AppShell>;
}
