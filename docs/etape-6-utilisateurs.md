**UBO Relay Chat — Étape 6 : utilisateurs et sélection d’une conversation**

La page `/messages` affiche les autres utilisateurs authentifiés via l’API existante. Un clic ouvre `/messages/user/:userId`, protégée par le même `ProtectedRoute`. La page affiche uniquement le destinataire et l’indication de développement futur.

**Fichiers de cette intervention**

```text
urc/
├── api/users.js                              modifié
├── src/App.jsx                              modifié
├── src/app/store.ts                         modifié
├── src/features/users/
│   ├── usersApi.ts                          créé
│   ├── usersSlice.ts                        créé
│   └── useUsers.ts                          créé
├── src/pages/
│   ├── MessagesPage.tsx                     modifié
│   └── ConversationPage.tsx                 créé
├── scripts/auth.test.cjs                     modifié
└── docs/etape-6-utilisateurs.md              créé : ce compte rendu
```

**Contrat de l’API examiné**

GET `/api/users` attend `Authorization: Bearer …`, vérifié par `checkSession` dans Redis avant la requête SQL. La réponse HTTP 200 est un tableau d’objets `{user_id: number, username: string, last_login: string | null}`. La date est formatée par PostgreSQL avec `DD/MM/YYYY HH24:MI`. Une liste vide reste HTTP 200 avec `[]`.

Les champs et la requête SQL existants sont conservés. Les corrections indispensables sont `Cache-Control: no-store` sur toutes les réponses, l’extraction explicite des seuls champs publics, une erreur HTTP 500 générique sans sérialiser l’exception du fournisseur, et HTTP 405 pour les méthodes autres que GET. L’import du module de session précise maintenant son extension `.js`. Les anciens logs de l’endpoint ont été supprimés.

**Parcours et notions Redux / React Router**

1. Après authentification ou restauration par `/api/me`, `ProtectedRoute` autorise la page. Le token local seul n’autorise pas le chargement Redux.
2. `MessagesPage` appelle `useUsers`. Son `useEffect` déclenche `dispatch(fetchUsers())` si la liste n’a pas encore été chargée pour cette session. Le nettoyage de cet effet appelle `abort()` sur sa requête. La fonction partagée évite de dupliquer cette logique dans `ConversationPage`.
3. `createAsyncThunk` exécute le service asynchrone et produit les actions de son cycle. Un reducer classique reste synchrone et ne réalise pas d’appel réseau. `pending` met le statut à `loading` et vide les anciens résultats ; `fulfilled` enregistre les utilisateurs ; `rejected` présente une erreur sûre ou revient à `idle` en cas d’annulation.
4. `extraReducers` permet au slice de traiter les actions du thunk et les actions d’authentification définies ailleurs. Le store conserve `auth` et ajoute `users`, avec les types `RootState` et `AppDispatch` conservés.
5. `useSelector` abonne le composant aux valeurs Redux sélectionnées. Quand leur référence change, React Redux déclenche un rendu avec la liste ou le nouveau statut. Le compte courant est exclu par comparaison des identifiants, pas des noms.
6. Un `Link` vers `/messages/user/2`, par exemple, réalise une navigation React Router sans rechargement. `useParams` récupère la chaîne `userId` définie par `:userId`.
7. L’identifiant doit être un entier positif écrit en décimal, sans zéro initial et représentable exactement en JavaScript. Il est ensuite recherché dans la liste publique récupérée du serveur. Une chaîne valide dans l’URL ne prouve donc pas qu’un compte existe. Les identifiants invalides, inconnus ou appartenant au compte courant affichent un refus clair.
8. Après un rechargement de la page, `AuthInitializer` vérifie d’abord `/api/me`. La conversation charge ensuite les utilisateurs si nécessaire. Elle réutilise la liste existante lors d’une navigation interne.

Références : [createAsyncThunk](https://redux-toolkit.js.org/api/createAsyncThunk), [useEffect](https://react.dev/reference/react/useEffect), [useParams](https://reactrouter.com/api/hooks/useParams).

**Concurrence, StrictMode et perte de session**

Chaque `pending` enregistre son `requestId`. Les reducers ignorent les actions finales ne correspondant plus à cette requête. Le thunk vérifie également la référence de l’état d’authentification avant de publier le résultat ou de réagir à un HTTP 401. Le service compare le token courant à celui utilisé au départ après la réponse et après le décodage JSON.

Ainsi, une réponse ancienne ne peut ni remplacer une liste récente, ni effacer une nouvelle session avec un ancien HTTP 401. Le cycle montage/nettoyage/remontage de StrictMode peut annuler une première requête et en démarrer une autre ; le rejet de la première n’écrase pas la seconde.

Les actions `resetAuth`, `setUser`, `startChecking` et `sessionUnavailable` réinitialisent aussi le slice utilisateurs, y compris son identifiant de requête. Une réponse encore en vol est alors ignorée. Ce mécanisme prépare le nettoyage lors d’une déconnexion sans ajouter un nouveau bouton ou un endpoint de déconnexion.

Pour un HTTP 401 de la requête courante, le thunk efface les clés de session via `clearStoredSession`, puis déclenche `resetAuth`. `ProtectedRoute` redirige alors vers `/login`. Une erreur réseau ou HTTP 500 conserve la session et propose Réessayer. Les erreurs brutes du serveur ne sont jamais affichées.

Le token est lu dans le service, reste dans sa fermeture locale et dans l’en-tête HTTP. Il ne figure ni dans les arguments du thunk, ni dans son résultat, ni dans le state Redux. Le service extrait explicitement les champs publics pour empêcher l’ajout accidentel d’un champ sensible de la réponse dans Redux.

**Vérifications réellement exécutées**

| Vérification | Résultat |
|---|---|
| `node scripts/auth.test.cjs` | 121 tests exécutés, 121 réussis, 0 échec, 0 ignoré : les 79 précédents et 42 nouveaux |
| `node node_modules/typescript/bin/tsc --project tsconfig.app.json --noEmit --incremental false --pretty false` | Réussi, aucune erreur |
| `node node_modules/typescript/bin/tsc --project tsconfig.node.json --noEmit --incremental false --pretty false` | Réussi, aucune erreur |
| Build de production par l’API Vite avec `build.write: false` et `envFile: false` | Réussi, 59 modules transformés ; aucun déploiement ni artefact de production écrit |
| `git diff --check` | Réussi |
| Firefox headless avec le vrai frontend React en StrictMode | Parcours réussis, détails ci-dessous |

Les 42 nouveaux tests automatisés couvrent : API avec session valide, absente, invalide ou expirée ; données publiques et absence de cache ; liste vide ; méthodes interdites ; erreurs PostgreSQL ; en-tête Bearer ; réponse JSON invalide ou contrat invalide ; cycle pending/fulfilled/rejected ; HTTP 401 et 500 ; erreur réseau ; nouvelle tentative ; affichage du compte connecté ; exclusion de son propre compte ; liens de sélection ; route dynamique et paramètres invalides/inconnus ; annulation ; réponses concurrentes et ancien HTTP 401 ; remplacement du token ; changement d’identité ; invalidation de session ; cycle des effets de StrictMode ; absence de champs sensibles dans les actions, Redux, le DOM et les logs.

Firefox a utilisé un serveur Vite isolé, un profil temporaire et des API simulées. Scénario exécuté : `/tmp/urc-users-browser.mjs`.

- Accès HTTP direct local, y compris `/messages/user/2` : document SPA servi.
- Accès anonyme direct à une conversation : redirection vers `/login`.
- Connexion avec le vrai formulaire ; chargement contrôlé de la liste en StrictMode.
- Affichage du compte connecté et exclusion de celui-ci des destinataires.
- Clic sur un destinataire : URL dynamique, absence de rechargement, aucune nouvelle requête de liste lorsque Redux possède les données.
- Rechargement complet de la conversation : nouvelle vérification `/api/me`, puis chargement du destinataire.
- Identifiants invalide, inconnu et correspondant au compte courant : refus explicite.
- Liste vide : message dédié.
- HTTP 500 et panne réseau : session conservée, message sûr, bouton Réessayer fonctionnel.
- HTTP 401 : stockage nettoyé, destinataire masqué et retour à `/login`.
- Aucune fuite du token dans le DOM, ni du mot de passe ou des détails confidentiels de test dans les logs ; aucune erreur d’exécution React détectée.

Le premier essai du nouveau script Firefox s’est arrêté sur une expression JavaScript mal échappée dans le script de test. Après correction du script, le parcours complet a réussi. Il ne s’agissait pas d’une erreur d’exécution de l’application.

**Limites et intégration**

PostgreSQL et Redis sont simulés dans les tests Node ; les bibliothèques React, Redux Toolkit et React Router sont réelles, ainsi que le hachage Argon2 dans les tests d’inscription existants. Dans Firefox, le navigateur et le frontend sont réels, les endpoints HTTP sont simulés. Aucune requête réelle vers Neon ou Upstash n’a été exécutée pour cette étape ; le runtime Edge de production n’a pas été déployé ni testé sur Vercel.

La réécriture SPA existante de Vercel couvre déjà la nouvelle route sans capturer `/api/*` : aucune modification de configuration n’a été nécessaire. Les tests précédents de cette réécriture restent réussis. L’accès direct a été vérifié localement ; l’hébergement Vercel réel reste non testé.

La liste est conservée en mémoire pour la session, sans pagination ni actualisation en temps réel. Un utilisateur supprimé après son chargement peut donc rester visible jusqu’au prochain chargement. La future API de messagerie devra vérifier à nouveau l’authentification, l’existence du destinataire et les autorisations côté serveur : la protection React et la liste Redux ne constituent pas une autorisation backend.

Aucun problème d’intégration n’a été observé dans les vérifications exécutées. Aucun changement de dépendances, variables d’environnement, schéma SQL, Redis, authSlice ou mécanisme de hachage. Aucun envoi/récupération de messages, groupe, ajout Pusher, RTK Query ou déploiement. L’intervention s’arrête à cette étape.

**Code complet livré**

Le thunk `fetchUsers` figure intégralement dans `usersSlice.ts` ci-dessous. Les autres blocs donnent le service, le hook partagé, le store, les deux pages, les routes et l’endpoint corrigé.

**`src/features/users/usersSlice.ts`**

```typescript
import {createAsyncThunk, createSlice} from '@reduxjs/toolkit';
import type {RootState} from '../../app/store';
import {resetAuth, sessionUnavailable, setUser, startChecking} from '../auth/authSlice';
import {clearStoredSession} from '../../user/loginApi';
import {getUsers, UsersApiError} from './usersApi';
import type {PublicUser, UsersFailure} from './usersApi';

export interface UsersState {
    items: PublicUser[];
    status: 'idle' | 'loading' | 'succeeded' | 'failed';
    error: string | null;
    requestId: string | null;
}

const initialState: UsersState = {items: [], status: 'idle', error: null, requestId: null};

export const fetchUsers = createAsyncThunk<PublicUser[], void,
    {state: RootState; rejectValue: UsersFailure}>(
    'users/fetchUsers',
    async (_, {getState, dispatch, signal, requestId, rejectWithValue}) => {
        const auth = getState().auth;
        const isCurrent = () => !signal.aborted && getState().auth === auth
            && getState().users.requestId === requestId;
        try {
            const users = await getUsers(signal);
            if (!isCurrent()) return rejectWithValue({kind: 'superseded', message: 'Requête remplacée.'});
            return users;
        } catch (error) {
            if (!isCurrent()) return rejectWithValue({kind: 'superseded', message: 'Requête remplacée.'});
            if (error instanceof UsersApiError) {
                if (error.kind === 'unauthorized') {
                    clearStoredSession();
                    dispatch(resetAuth());
                }
                return rejectWithValue({kind: error.kind, message: error.message});
            }
            if (error instanceof DOMException && error.name === 'AbortError') throw error;
            return rejectWithValue({kind: 'invalid', message: 'Chargement impossible. Veuillez réessayer.'});
        }
    },
    {condition: (_, {getState}) => getState().auth.status === 'authenticated'},
);

const usersSlice = createSlice({
    name: 'users',
    initialState,
    reducers: {},
    extraReducers: builder => {
        builder
            .addCase(fetchUsers.pending, (state, action) => {
                state.items = [];
                state.status = 'loading';
                state.error = null;
                state.requestId = action.meta.requestId;
            })
            .addCase(fetchUsers.fulfilled, (state, action) => {
                if (state.requestId !== action.meta.requestId) return;
                state.items = action.payload;
                state.status = 'succeeded';
                state.requestId = null;
            })
            .addCase(fetchUsers.rejected, (state, action) => {
                if (state.requestId !== action.meta.requestId) return;
                state.items = [];
                state.requestId = null;
                if (action.meta.aborted || action.payload?.kind === 'superseded') {
                    state.status = 'idle';
                    state.error = null;
                } else {
                    state.status = 'failed';
                    state.error = action.payload?.message ?? 'Chargement impossible. Veuillez réessayer.';
                }
            })
            // Ces actions invalident aussi toute réponse encore en vol.
            .addCase(resetAuth, () => initialState)
            .addCase(setUser, () => initialState)
            .addCase(startChecking, () => initialState)
            .addCase(sessionUnavailable, () => initialState);
    },
});

export default usersSlice.reducer;
```

**`src/features/users/usersApi.ts`**

```typescript
// Contrat GET /api/users : noms SQL conservés, aucune donnée d'authentification.
export interface PublicUser {
    user_id: number;
    username: string;
    last_login: string | null;
}

export type UsersErrorKind = 'unauthorized' | 'network' | 'server' | 'invalid' | 'superseded';
export interface UsersFailure {
    kind: UsersErrorKind;
    message: string;
}

export class UsersApiError extends Error {
    readonly kind: UsersErrorKind;

    constructor(kind: UsersErrorKind, message: string) {
        super(message);
        this.name = 'UsersApiError';
        this.kind = kind;
    }
}

export async function getUsers(signal: AbortSignal): Promise<PublicUser[]> {
    signal.throwIfAborted();
    let token: string | null;
    try {
        token = sessionStorage.getItem('token');
    } catch {
        throw new UsersApiError('invalid', 'Accès au stockage de session impossible.');
    }
    if (!token) throw new UsersApiError('unauthorized', 'Votre session a expiré. Reconnectez-vous.');
    const assertCurrent = () => {
        signal.throwIfAborted();
        if (sessionStorage.getItem('token') !== token) {
            throw new DOMException('Session superseded', 'AbortError');
        }
    };
    let response: Response;
    try {
        response = await fetch('/api/users', {
            method: 'GET', headers: {Authorization: `Bearer ${token}`},
            cache: 'no-store', signal,
        });
    } catch {
        assertCurrent();
        throw new UsersApiError('network', 'Connexion réseau impossible. Veuillez réessayer.');
    }
    assertCurrent();
    if (response.status === 401) {
        throw new UsersApiError('unauthorized', 'Votre session a expiré. Reconnectez-vous.');
    }
    if (!response.ok) {
        throw new UsersApiError('server', 'Liste des utilisateurs indisponible. Veuillez réessayer.');
    }
    let data: unknown;
    try {
        data = await response.json();
    } catch {
        assertCurrent();
        throw new UsersApiError('invalid', 'Réponse des utilisateurs invalide.');
    }
    assertCurrent();
    if (!Array.isArray(data) || data.some(user => !user || typeof user !== 'object'
        || !Number.isSafeInteger(user.user_id) || user.user_id <= 0
        || typeof user.username !== 'string' || !user.username.trim()
        || !(user.last_login === null || (typeof user.last_login === 'string'
            && /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/.test(user.last_login))))
        || new Set(data.map(user => user.user_id)).size !== data.length) {
        throw new UsersApiError('invalid', 'Réponse des utilisateurs invalide.');
    }
    // Sélection explicite : même une réponse contenant un champ supplémentaire ne fuit pas dans Redux.
    return data.map(({user_id, username, last_login}) => ({user_id, username, last_login}));
}
```

**`src/features/users/useUsers.ts`**

```typescript
import {useEffect} from 'react';
import {useDispatch, useSelector, useStore} from 'react-redux';
import type {AppDispatch, RootState} from '../../app/store';
import {fetchUsers} from './usersSlice';

export function useUsers(enabled = true) {
    const dispatch = useDispatch<AppDispatch>();
    const store = useStore<RootState>();
    const user = useSelector((state: RootState) => state.auth.user);
    const users = useSelector((state: RootState) => state.users);

    useEffect(() => {
        if (!enabled || !user || store.getState().users.status === 'succeeded') return;
        const request = dispatch(fetchUsers());
        return () => request.abort();
    }, [enabled, user, dispatch, store]);

    return {...users, user, retry: () => dispatch(fetchUsers())};
}
```

**`src/app/store.ts`**

```typescript
import {configureStore} from "@reduxjs/toolkit";
import authReducer from "../features/auth/authSlice";
import usersReducer from "../features/users/usersSlice";

export const store = configureStore({
    //Ici, authReducer est le reducer global du slice, généré automatiquement par createSlice. Il sait traiter toutes les actions de ce slice.
    // c est pour cette raison que il est en singulier et dans le slice en pleural
    reducer: {
        auth: authReducer,
        users: usersReducer,
    },
});

// pour exporter le type ( pour le typescript)

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
```

**`src/pages/MessagesPage.tsx`**

```tsx
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
```

**`src/pages/ConversationPage.tsx`**

```tsx
import React from 'react';
import {Link, useParams} from 'react-router-dom';
import {useSelector} from 'react-redux';
import type {RootState} from '../app/store';
import {useUsers} from '../features/users/useUsers';

export function ConversationPage() {
    const {userId} = useParams<{userId: string}>();
    const currentUser = useSelector((state: RootState) => state.auth.user);
    const id = Number(userId);
    const valid = !!userId && /^[1-9]\d*$/.test(userId) && Number.isSafeInteger(id);
    const self = valid && id === currentUser?.id;
    const {items, status, error, retry} = useUsers(valid && !self);
    const recipient = items.find(user => user.user_id === id);

    let content: React.ReactNode;
    if (!valid) content = <p role="alert">Identifiant utilisateur invalide.</p>;
    else if (self) content = <p role="alert">Vous ne pouvez pas sélectionner votre propre compte.</p>;
    else if (status === 'failed') content = <div role="alert"><p>{error}</p><button onClick={retry}>Réessayer</button></div>;
    else if (status !== 'succeeded') content = <p role="status">Chargement du destinataire…</p>;
    else if (!recipient) content = <p role="alert">Utilisateur introuvable.</p>;
    else content = <><h2>Conversation avec {recipient.username}</h2>
        <p>La conversation sera développée prochainement</p></>;

    return <main><h1>UBO Relay Chat</h1>{content}<Link to="/messages">Retour aux utilisateurs</Link></main>;
}
```

**`src/App.jsx`**

```jsx
import './App.css';
import {Navigate, Route, Routes} from "react-router-dom";
import {LoginPage} from "./pages/LoginPage";
import {MessagesPage} from "./pages/MessagesPage";
import {NotFoundPage} from "./pages/NotFoundPage";
import {ProtectedRoute} from "./routes/ProtectedRoute";
import {RegisterPage} from "./pages/RegisterPage";
import {ConversationPage} from "./pages/ConversationPage";

function App() {

  return (
      <Routes>
          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route element={<ProtectedRoute />}>
              <Route path="/messages" element={<MessagesPage />} />
              <Route path="/messages/user/:userId" element={<ConversationPage />} />
          </Route>
          <Route path="*" element={<NotFoundPage />} />
      </Routes>
  );
}

export default App;
```

**`api/users.js`**

```javascript
import { sql } from "@vercel/postgres";
import {checkSession} from "../lib/session.js";

export const config = {
    runtime: 'edge',
};

export default async function handler(request) {
    const headers = {'content-type': 'application/json', 'cache-control': 'no-store'};
    const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers});
    if ((request.method ?? 'GET') !== 'GET') {
        return new Response(JSON.stringify({code: 'METHOD_NOT_ALLOWED', message: 'GET required'}), {
            status: 405, headers: {...headers, Allow: 'GET'},
        });
    }
    try {
        const connected = await checkSession(request);
        if (!connected) {
            return json({code: 'UNAUTHORIZED', message: 'Session expired'}, 401);
        }
        const {rows} = await sql`select user_id, username, TO_CHAR(last_login, 'DD/MM/YYYY HH24:MI') as last_login from users order by last_login desc`;
        return json(rows.map(({user_id, username, last_login}) => ({user_id, username, last_login})));
    } catch {
        return json({code: 'USERS_UNAVAILABLE', message: 'Liste des utilisateurs indisponible.'}, 500);
    }
};
```

