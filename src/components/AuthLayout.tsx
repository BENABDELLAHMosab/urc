import React from 'react';
import type {ReactNode} from 'react';
import {Link} from 'react-router-dom';

export function AuthLayout({title, description, children}: {title: string; description: string; children: ReactNode;}) {
    return <main className="auth-page">
        <div className="auth-panel">
            <Link className="brand auth-brand" to="/login">UBO Relay Chat</Link>
            <header className="auth-heading"><h1>{title}</h1><p>{description}</p></header>
            {children}
        </div>
    </main>;
}
