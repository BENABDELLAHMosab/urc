import React, {useRef} from 'react';
import type {FormEvent, ReactNode} from 'react';
import {Link} from 'react-router-dom';
import {isMessageContent, MESSAGE_MAX_LENGTH} from '../../lib/privateMessages.js';

export function ConversationHeader({title, subtitle, backTo, backLabel, action}: {
    title: string; subtitle: string; backTo: string; backLabel: string; action?: ReactNode;
}) {
    return <header className="conversation-header">
        <Link className="conversation-back" to={backTo} aria-label={backLabel}>← <span>{backLabel}</span></Link>
        <div className="conversation-heading"><h1>{title}</h1><p>{subtitle}</p></div>
        {action}
    </header>;
}

export function MessageBubble({mine, sender, content, createdAt}: {mine: boolean; sender: string; content: string; createdAt: string;}) {
    return <li className={mine ? 'message-sent' : 'message-received'}>
        <strong>{sender}</strong><p>{content}</p>
        <time dateTime={createdAt} title={new Date(createdAt).toLocaleString('fr-FR')}>{new Date(createdAt).toLocaleTimeString('fr-FR', {hour: '2-digit', minute: '2-digit'})}</time>
    </li>;
}

export function MessageComposer({id, label, draft, onChange, onSubmit, sending, disabled}: {
    id: string; label: string; draft: string; onChange: (value: string) => void;
    onSubmit: (event: FormEvent<HTMLFormElement>) => unknown; sending: boolean; disabled: boolean;
}) {
    const pending = useRef(false);
    const submit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (pending.current || disabled || sending || !isMessageContent(draft)) return;
        pending.current = true;
        try {
            await onSubmit(event);
        } finally {
            pending.current = false;
        }
    };
    return <form className="message-composer" onSubmit={submit} aria-busy={sending}>
        <label htmlFor={id}>{label}</label>
        <div className="composer-row">
            <textarea id={id} name="content" value={draft} maxLength={MESSAGE_MAX_LENGTH} disabled={sending}
                onChange={event => onChange(event.target.value)}
                onKeyDown={event => {
                    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
                    event.preventDefault();
                    if (!event.repeat) event.currentTarget.form?.requestSubmit();
                }} aria-describedby={`${id}-help`} placeholder="Écrivez votre message…" />
            <button className="button-primary" type="submit" disabled={disabled}>{sending ? 'Envoi en cours…' : 'Envoyer'}</button>
        </div>
        <p className="field-help" id={`${id}-help`}>1 à {MESSAGE_MAX_LENGTH} caractères, sans être vide.</p>
    </form>;
}
