import React, {useId, useState} from 'react';
import type {ReactNode} from 'react';
import {Link} from 'react-router-dom';

interface Item {id: number; label: string; to: string;}
export function Directory({title, items, status, error, retry, kind = 'private', activeId, action}: {
    title: string; items: Item[]; status: string; error: string | null; retry: () => unknown;
    kind?: 'private' | 'room'; activeId?: number; action?: ReactNode;
}) {
    const [query, setQuery] = useState('');
    const searchId = useId();
    const filtered = items.filter(item => item.label.toLocaleLowerCase('fr').includes(query.trim().toLocaleLowerCase('fr')));
    return <section className="directory" aria-label={title}>
        <div className="directory-heading"><h2 className="directory-title">{title}</h2>{action}</div>
        <div className="directory-search">
            <label className="sr-only" htmlFor={searchId}>{kind === 'room' ? 'Rechercher un salon' : 'Rechercher un utilisateur'}</label>
            <input id={searchId} type="search" placeholder={kind === 'room' ? 'Rechercher un salon' : 'Rechercher un utilisateur'}
                value={query} onChange={event => setQuery(event.target.value)} />
        </div>
        {(status === 'idle' || status === 'loading') && <p className="directory-notice" role="status">{kind === 'room' ? 'Chargement des salons…' : 'Chargement des utilisateurs…'}</p>}
        {status === 'failed' && <div className="directory-notice" role="alert"><p>{error}</p><button onClick={retry}>Réessayer</button></div>}
        {status === 'succeeded' && !items.length && <p className="directory-notice">{kind === 'room' ? 'Aucun salon disponible.' : 'Aucun autre utilisateur disponible.'}</p>}
        {items.length > 0 && !filtered.length && <p className="directory-notice">Aucun résultat pour cette recherche.</p>}
        <ul className="directory-list">{filtered.map(item => <li key={item.id}>
            <Link to={item.to} aria-current={item.id === activeId ? 'page' : undefined}>
                <span className={`initial${kind === 'room' ? ' initial-room' : ''}`} aria-hidden="true">{kind === 'room' ? '#' : item.label.charAt(0).toUpperCase()}</span>
                <span className="directory-name">{item.label}</span>
            </Link>
        </li>)}</ul>
    </section>;
}
