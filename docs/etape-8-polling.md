**UBO Relay Chat — Étape 8 : actualisation automatique par polling**

Les conversations récupèrent maintenant les nouveaux messages automatiquement. Une nouvelle vérification démarre environ 8 secondes après la fin de la précédente, avec suspension lorsque l’onglet est masqué ou le navigateur hors ligne. Actualiser et Envoyer restent disponibles selon leurs états de chargement existants.

**Fichiers de cette intervention**

```text
urc/
├── src/features/messages/
│   ├── useMessagePolling.ts                 créé
│   └── messagesSlice.ts                     modifié
├── src/pages/
│   ├── ConversationPage.tsx                 modifié
│   └── ConversationPage.css                 modifié
├── scripts/auth.test.cjs                    modifié
└── docs/etape-8-polling.md                   créé : ce compte rendu
```

Le backend, les services API, les règles Redis, le store, les routes, les variables d’environnement et les dépendances sont conservés. `api/message.js`, `lib/messageStorage.js`, `lib/privateMessages.js`, `authSlice`, `useUsers`, le store et le compte rendu de l’étape 7 ont été examinés avant modification. Les protections existantes par identité, destinataire, requestId, token courant et déduplication sont conservées.

**Vérification réelle préalable : résultats et limites**

Des sondes ont été exécutées depuis l’environnement local avec la configuration existante, sans afficher ses valeurs :

| Sonde réelle | Résultat |
|---|---|
| Neon : `SELECT 1 AS ok` | Réussi |
| Upstash Redis : `PING` | Réussi |
| Upstash Redis : `EVAL "return 1"` sans clé ni écriture | Réussi |

Le client Redis existant utilise ici les alias de configuration `KV_REST_API_URL` / `KV_REST_API_TOKEN`, acceptés par `Redis.fromEnv()`. Aucune variable n’a été modifiée dans les fichiers du projet. Les sondes n’ont créé ni compte, ni clé de conversation, ni message. Les valeurs de configuration n’ont pas été imprimées.

Ces résultats confirment la connectivité réelle et la possibilité d’exécuter un script Lua sans écriture. Ils ne confirment pas l’exécution réelle des scripts complets de messagerie. Aucun POST réel n’a été envoyé. Aucun GET réel de conversation n’a été exécuté non plus : le script de lecture peut supprimer les messages expirés et modifier Redis. Les résultats réels de POST/GET, l’ordre réel, le TTL et le plafond de 100 restent à vérifier avec deux comptes de développement selon la procédure manuelle plus bas. Les règles de 24 heures et de 100 messages restent inchangées.

**Pourquoi une boucle setTimeout**

`setInterval` déclencherait régulièrement une fonction sans attendre sa réponse HTTP : une lecture lente pourrait chevaucher la suivante. La boucle utilise `setTimeout` seulement après la résolution du thunk. Par exemple, avec une lecture de 3 secondes, les débuts de deux lectures sont espacés d’environ 11 secondes : 3 secondes de lecture puis 8 secondes d’attente. Le navigateur peut retarder davantage l’exécution d’un timer.

Le délai de production est `MESSAGE_POLL_DELAY_MS = 8000`. Une erreur serveur ou réseau attend aussi ce délai avant la tentative suivante. Il n’y a pas de boucle immédiate sur échec. La reprise après visibilité/connexion est immédiate lorsqu’aucune lecture équivalente n’est déjà en cours.

Références : [setTimeout](https://developer.mozilla.org/en-US/docs/Web/API/Window/setTimeout), [useEffect et nettoyage](https://react.dev/reference/react/useEffect).

**Rôle de useEffect et fonctionnement du hook**

L’effet relie la conversation active aux ressources externes : requête HTTP, timer et événements du navigateur. Il dépend du destinataire, de l’identité d’authentification, de dispatch et du store. Quand ces dépendances changent, React nettoie l’ancien effet avant d’en installer un nouveau. Quand le composant disparaît, React exécute également le nettoyage.

Le hook ne dépend pas de `readStatus` dans son effet : sinon chaque pending pourrait redémarrer l’effet et annuler sa propre lecture. Il consulte `store.getState()` au moment d’agir et observe les lectures externes avec `store.subscribe`.

Le cycle est le suivant :

1. La page ouvre l’état de la conversation avec `openConversation`.
2. Si la session est authentifiée, la conversation toujours active, l’onglet visible et le navigateur en ligne, le hook démarre une lecture immédiate.
3. Si une lecture équivalente existe déjà, il l’attend sans lancer un second HTTP. Une lecture externe commencée pendant l’attente annule également le timer prévu.
4. `dispatch(fetchMessages(recipientId))` renvoie une promesse qui se résout avec une action fulfilled ou rejected. La boucle attend cette résolution sans utiliser `.unwrap()`.
5. Si l’effet est encore courant et disponible, elle programme le prochain passage dans 8 secondes. Elle ne s’empile pas sur une lecture lente.
6. Le bouton Actualiser utilise la même fonction de récupération. Il annule l’attente prévue, effectue une lecture immédiate si possible et repart ensuite sur un délai complet après la réponse.

`running` protège la requête appartenant au hook ; `waitingForRead` permet de rejoindre une lecture déclenchée ailleurs. Les indicateurs d’interruption gèrent le retour visible/online alors qu’une annulation est encore en train de se terminer. Les callbacks différés vérifient toujours si l’effet est encore courant.

Le hook écoute `visibilitychange`, `offline` et `online`. Lors d’une suspension, il enlève le timer et annule sa lecture en cours. Au retour, il récupère immédiatement ou attend la lecture équivalente déjà active. `navigator.onLine` est un indicateur du navigateur, pas une garantie de disponibilité de l’API ; les erreurs réseau restent traitées par le service existant.

La fonction retournée par l’effet invalide sa fermeture, enlève le timer, désabonne le store, annule sa lecture et retire les trois écouteurs navigateur. La fonction Actualiser devient inerte. Ce nettoyage empêche les effets de continuer après démontage et permet le cycle montage/nettoyage/remontage de StrictMode sans le désactiver. Si le nouveau montage rejoint une ancienne lecture annulée, il repart sans attendre inutilement 8 secondes.

**Redux et sécurité des résultats**

`fetchMessages` reste le thunk existant : appel GET, validation de la réponse, contrôle de l’identité, de la conversation et du requestId, puis traitement des erreurs. `extraReducers` garde ses responsabilités : pending indique la lecture en cours ; fulfilled remplace l’historique validé en conservant les envois confirmés pendant cette lecture ; rejected présente une erreur sûre ou revient à idle pour une annulation. La fusion par identifiant serveur évite les doublons.

La seule nouvelle donnée Redux est `hasLoaded`. Elle passe à true après une lecture réussie et revient à false lors du nettoyage existant. Elle distingue le premier chargement d’une actualisation : un historique vide déjà chargé reste un état valide pendant le polling. Les tableaux de messages ne sont pas vidés lors de pending.

`useSelector` abonne l’interface à l’état messages. Quand fulfilled produit un nouveau tableau, React Redux provoque le rendu des nouvelles valeurs. Les éléments gardent leur clé UUID : le DOM des messages déjà présents est réutilisé.

Le hook vérifie l’identité et le destinataire avant chaque départ, après chaque réponse et pendant les notifications du store. Une conversation A démontée ne peut pas relancer son timer ni remplir B. Une session A remplacée ne peut pas agir sur B. Les vérifications existantes du service et du thunk continuent de filtrer les réponses obsolètes.

Un HTTP 401 courant déclenche le nettoyage existant de session et d’authentification. Cela vide les messages et arrête la boucle ; ProtectedRoute affiche ensuite `/login`. Une erreur réseau ou HTTP 500 conserve le token. Aucun token n’est passé dans les arguments du thunk ou les actions Redux ; aucun contenu de message n’est ajouté aux logs.

**ConversationPage et scroll**

La page conserve son effet d’ouverture/nettoyage et l’annulation d’un envoi lors du démontage. La lecture initiale est maintenant effectuée par `useMessagePolling`, qui fournit aussi le callback Actualiser. L’envoi et la conservation du brouillon en cas d’échec sont inchangés.

Le grand indicateur est réservé au premier chargement, avant `hasLoaded`. Une erreur d’actualisation après chargement est un petit message de statut, et non une alerte qui remplace l’historique. Une liste vide déjà chargée garde son texte pendant le polling. Le bouton Actualiser reste désactivé pendant une lecture.

La liste a une hauteur maximale de 28rem et un scroll indépendant. `onScroll` mémorise si l’utilisateur est à moins de 80 pixels du bas. `useLayoutEffect` accompagne les nouveaux messages vers le bas seulement dans ce cas, avant l’affichage du nouveau rendu. Si l’utilisateur lit plus haut, aucun scroll impératif n’est demandé. Aucun `scrollIntoView` global ne déplace la page entière.

**Résultats des tests réellement exécutés**

| Vérification | Résultat |
|---|---|
| `node scripts/auth.test.cjs` | 211 tests réussis : 190 précédents + 21 nouveaux ; 0 échec, 0 ignoré |
| `node scripts/vercel-packaging.test.cjs` | 4 tests réussis, 0 échec |
| TypeScript application : `tsc --project tsconfig.app.json --noEmit --incremental false --pretty false` | Réussi |
| TypeScript configuration : `tsc --project tsconfig.node.json --noEmit --incremental false --pretty false` | Réussi |
| Build Vite en mémoire, sans charger les fichiers .env et sans écriture de dist | Réussi, 64 modules transformés |
| `git diff --check` | Réussi |
| Firefox avec API simulées et React StrictMode réel | Parcours complet réussi |

Les nouveaux tests Node exécutent le vrai hook et les vrais reducers/thunks Redux avec des timers et événements de navigateur simulés. Ils vérifient l’attente exacte de 8 secondes après résolution sans attendre réellement 8 secondes dans les tests. Ils couvrent : chargement initial, nouveau message/déduplication, lecture lente sans chevauchement, démontage et nettoyage des écouteurs, visibilité, offline/online, reprise pendant une annulation, Actualiser partagé avec le polling, lectures externes, erreurs réseau/500, arrêt sur 401 de lecture ou d’envoi, StrictMode, changement de conversation ou de compte, absence d’autorisation fondée sur le token seul, rendu silencieux y compris liste vide, et envoi pendant lecture.

Le scénario Firefox temporaire exécuté est `/tmp/urc-polling-browser.mjs`. Le frontend et le navigateur sont réels, les API HTTP sont simulées. Le délai de production 8000ms est intercepté dans le profil de test et accéléré à 250ms ; les tests Node vérifient séparément les 8000ms. Visibilité et disponibilité réseau sont pilotées par des propriétés et événements simulés dans le navigateur.

Firefox a confirmé :

- arrivée automatique d’un message et absence de doublons ;
- pause pendant l’onglet masqué ou hors ligne, puis reprise ;
- requête lente sans nouvelle lecture concurrente, sans grand indicateur et sans perte de l’historique ;
- envoi confirmé pendant une ancienne lecture, préservé lorsque cet ancien instantané arrive ;
- coexistence du bouton Actualiser avec la boucle ;
- erreurs discrètes réseau/500, session conservée et nouvelles tentatives espacées ;
- absence de réapparition du grand indicateur après le premier chargement ;
- changement rapide de destinataire, absence de contenu de l’ancienne conversation et arrêt après démontage ;
- rechargement complet : restauration `/api/me`, puis récupération de l’historique ;
- scroll conservé en haut pendant la lecture des anciens messages, et suivi des nouveaux seulement lorsque l’utilisateur est proche du bas ;
- HTTP 401 automatique : nettoyage, retour à `/login` et arrêt des requêtes ;
- absence de token dans le DOM, absence de token/mot de passe/contenu privé dans les logs capturés, aucune erreur d’exécution React détectée.

Un premier passage Firefox a interrompu le scénario sur une assertion du test réseau qui comptait les tentatives HTTP internes du navigateur. L’assertion a été corrigée pour mesurer les programmations du timer de l’application ; le scénario complet a ensuite réussi. Le code de l’application n’a pas été modifié pour contourner ce contrôle.

Les 190 tests de l’étape précédente et les tests d’empaquetage gardent leurs assertions. Le harnais Node reçoit seulement les globals du navigateur et timers simulés nécessaires au nouveau hook. Les tests applicatifs HTTP restent isolés de Neon et Upstash ; les trois sondes réelles sans écriture sont distinctes.

**Procédure manuelle pour confirmer les échanges réels**

À effectuer uniquement après validation de ces écritures, dans une conversation de développement isolée avec deux comptes existants. Aucune étape ci-dessous n’a été exécutée automatiquement.

1. Lancer l’application locale avec ses API, par exemple avec le mode `vercel dev` habituel. Ouvrir deux profils de navigateur séparés, ou une fenêtre normale et une fenêtre privée. Se connecter avec le compte A et le compte B existants.
2. Dans chaque fenêtre, choisir l’autre compte depuis la liste. Vérifier dans l’onglet Réseau un GET `/api/message?userId=...` HTTP 200. Ne pas copier les en-têtes d’authentification dans le rapport.
3. A envoie un texte de développement identifiable, puis B répond. Vérifier pour chaque POST : HTTP 201, senderId correspondant au compte de la fenêtre, recipientId correspondant à l’autre compte, UUID et date serveur. Vérifier que chaque message apparaît automatiquement dans l’autre fenêtre après le délai de polling et la latence réseau.
4. Recharger les deux pages et vérifier qu’elles retrouvent le même échange, trié par createdAt puis UUID, avec les rôles gauche/droite inversés selon le compte.
5. Dans la console Redis du projet de développement, utiliser la clé `urc:private:v1:minId:maxId` pour lire `TYPE`, `TTL` et `ZCARD` sans afficher le contenu privé. Après un envoi, TYPE doit être zset, TTL proche de 86400 secondes et ZCARD au plus 100. Un TTL de -1 indiquerait une anomalie. Une clé déjà vide/expirée peut retourner -2.
6. Observer le TTL avant et après plusieurs GET sans nouveau POST : la lecture ne doit pas le renouveler. Attendre l’expiration réelle, ou s’appuyer provisoirement sur les tests à horloge simulée ; ne pas réduire le TTL du projet pour accélérer cet essai.
7. Pour valider réellement la borne, après accord explicite, envoyer manuellement plus de 100 messages de test dans cette seule conversation isolée. Vérifier ZCARD <= 100 et que GET renvoie les 100 derniers, en ordre chronologique. Ne pas utiliser une conversation contenant des échanges à conserver : les plus anciens seront retirés.
8. Masquer l’onglet, observer l’arrêt des requêtes puis revenir ; répéter avec le mode hors ligne des outils réseau. Vérifier qu’une panne temporaire garde la session et qu’un refus réel 401 renvoie vers la connexion.

Consigner uniquement les statuts, comptes de développement concernés et mesures TTL/ZCARD nécessaires ; ne jamais publier les tokens, secrets de connexion ou contenus privés.

**Limites restantes**

Les scripts complets de stockage et de lecture restent non vérifiés sur le Redis réel, malgré PING et EVAL neutre réussis. Les échanges authentifiés POST/GET, l’ordre réel, la borne et la durée réelles restent à confirmer par la procédure manuelle. Aucun déploiement ni test en production Vercel n’a été réalisé.

Le polling n’est pas du temps réel : le destinataire attend généralement le délai restant et la latence HTTP. Il génère des lectures régulières sur Redis et des vérifications PostgreSQL, ce qui consomme les quotas des services. Une requête lente retarde la suivante ; aucun timeout HTTP supplémentaire n’est introduit dans cette étape. La suspension peut annuler une requête côté navigateur sans annuler une opération déjà exécutée côté serveur.

Le scroll automatique est conditionnel et local à la liste ; il ne conserve pas un ancrage métier explicite si les plus anciens messages sont retirés du plafond de 100. Les ancrages natifs du navigateur restent utilisés. Les limites de l’étape 7 (stockage temporaire, absence de pagination ancienne, absence d’E2EE et d’idempotence métier après réponse d’envoi perdue) restent applicables.

Aucune bibliothèque, modification backend, politique Redis, variable d’environnement, fonctionnalité de groupe, notification ou déploiement ajouté. Le travail s’arrête ici en attente de validation.

**Code complet livré**

**`src/features/messages/useMessagePolling.ts`**

```typescript
import {useCallback, useEffect, useRef} from 'react';
import {useDispatch, useSelector, useStore} from 'react-redux';
import type {AppDispatch, RootState} from '../../app/store';
import {fetchMessages} from './messagesSlice';

export const MESSAGE_POLL_DELAY_MS = 8000;

export function useMessagePolling(recipientId: number) {
    const dispatch = useDispatch<AppDispatch>();
    const store = useStore<RootState>();
    const auth = useSelector((state: RootState) => state.auth);
    const refresh = useRef<() => void>(() => {});

    useEffect(() => {
        if (auth.status !== 'authenticated' || !auth.user) return;
        let disposed = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let running = false;
        let waitingForRead = false;
        let interrupted = false;
        let resumeAfterFlight = false;
        let request: ReturnType<ReturnType<typeof fetchMessages>> | undefined;

        const current = () => !disposed && store.getState().auth === auth
            && store.getState().messages.userId === recipientId;
        const available = () => current() && document.visibilityState !== 'hidden' && navigator.onLine !== false;
        const clearTimer = () => { clearTimeout(timer); timer = undefined; };
        const schedule = () => {
            clearTimer();
            if (available()) timer = setTimeout(() => { void run(); }, MESSAGE_POLL_DELAY_MS);
        };
        const run = async () => {
            clearTimer();
            if (!available() || running) return;
            if (store.getState().messages.readStatus === 'loading') {
                // Une lecture équivalente existe déjà : attendre sa fin via l'abonnement.
                waitingForRead = true;
                return;
            }
            waitingForRead = false;
            running = true;
            interrupted = false;
            resumeAfterFlight = false;
            request = dispatch(fetchMessages(recipientId));
            await request; // Un thunk RTK retourne une action, même en cas d'échec.
            request = undefined;
            running = false;
            if (!available()) return;
            if (resumeAfterFlight) {
                resumeAfterFlight = false;
                void run();
            } else if (store.getState().messages.readStatus === 'loading') waitingForRead = true;
            else schedule();
        };
        const unsubscribe = store.subscribe(() => {
            if (!current()) {
                clearTimer();
                request?.abort();
                return;
            }
            if (running) return;
            if (store.getState().messages.readStatus === 'loading') {
                clearTimer();
                waitingForRead = true;
            } else if (waitingForRead) {
                waitingForRead = false;
                // Une lecture annulée pendant le nettoyage StrictMode ne retarde pas le remontage.
                if (store.getState().messages.readStatus === 'idle') void Promise.resolve().then(run);
                else schedule();
            }
        });
        const onAvailability = () => {
            if (!available()) {
                clearTimer();
                if (request) { interrupted = true; request.abort(); }
            } else if (running) {
                if (interrupted) resumeAfterFlight = true;
            } else void run();
        };

        refresh.current = () => { void run(); };
        document.addEventListener('visibilitychange', onAvailability);
        window.addEventListener('offline', onAvailability);
        window.addEventListener('online', onAvailability);
        void run();
        return () => {
            disposed = true;
            refresh.current = () => {};
            clearTimer();
            unsubscribe();
            request?.abort();
            document.removeEventListener('visibilitychange', onAvailability);
            window.removeEventListener('offline', onAvailability);
            window.removeEventListener('online', onAvailability);
        };
    }, [recipientId, auth, dispatch, store]);

    return useCallback(() => refresh.current(), []);
}
```

**`src/pages/ConversationPage.tsx`**

```tsx
import React, {Fragment, useEffect, useLayoutEffect, useRef, useState} from 'react';
import type {FormEvent} from 'react';
import {Link, useParams} from 'react-router-dom';
import {useDispatch, useSelector} from 'react-redux';
import type {AppDispatch, RootState} from '../app/store';
import {useUsers} from '../features/users/useUsers';
import {clearMessages, openConversation, sendMessage} from '../features/messages/messagesSlice';
import {useMessagePolling} from '../features/messages/useMessagePolling';
import {isMessageContent, isUserId, MESSAGE_MAX_LENGTH} from '../../lib/privateMessages.js';
import type {PublicUser} from '../features/users/usersApi';
import type {AuthUser} from '../features/auth/authSlice';
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
        <h2>Conversation avec {recipient.username}</h2>
        {(!current || (!messages.hasLoaded && messages.readStatus === 'loading')) && <p role="status">Chargement des messages…</p>}
        {current && messages.readError && <p className={messages.hasLoaded ? 'polling-error' : undefined}
            role={messages.hasLoaded ? 'status' : 'alert'}>{messages.readError}</p>}
        {current && messages.hasLoaded && messages.items.length === 0 && <p>Aucun message pour le moment.</p>}
        <ol className="private-messages" aria-label="Messages" ref={list} tabIndex={0} onScroll={() => {
            if (list.current) nearBottom.current = list.current.scrollHeight - list.current.scrollTop - list.current.clientHeight < 80;
        }}>
            {current && messages.items.map(message => <li key={message.id}
                className={message.senderId === user.id ? 'message-sent' : 'message-received'}>
                <strong>{message.senderId === user.id ? 'Vous' : recipient.username}</strong>
                <p>{message.content}</p>
                <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString('fr-FR')}</time>
            </li>)}
        </ol>
        <button type="button" disabled={!current || messages.readStatus === 'loading'}
            onClick={refresh}>Actualiser</button>
        <form onSubmit={submit}>
            <label htmlFor="private-message">Votre message</label>
            <textarea id="private-message" name="content" value={draft} maxLength={MESSAGE_MAX_LENGTH}
                disabled={sending} onChange={event => setDraft(event.target.value)} aria-describedby="message-help" />
            <p id="message-help">1 à {MESSAGE_MAX_LENGTH} caractères, sans être vide.</p>
            <button type="submit" disabled={!current || sending || !isMessageContent(draft)}>
                {sending ? 'Envoi en cours…' : 'Envoyer'}</button>
        </form>
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

    return <main><h1>UBO Relay Chat</h1>{content}<Link to="/messages">Retour aux utilisateurs</Link></main>;
}
```

**`src/features/messages/messagesSlice.ts`**

```typescript
import {createAsyncThunk, createSlice} from '@reduxjs/toolkit';
import type {PayloadAction} from '@reduxjs/toolkit';
import type {RootState} from '../../app/store';
import {resetAuth, sessionUnavailable, setUser, startChecking} from '../auth/authSlice';
import {clearStoredSession} from '../../user/loginApi';
import * as api from './messagesApi';
import type {MessagesFailure, PrivateMessage} from './messagesApi';
import {chronologicalMessages, isUserId, publicMessage} from '../../../lib/privateMessages.js';

type Status = 'idle' | 'loading' | 'succeeded' | 'failed';
export interface MessagesState {
    userId: number | null;
    items: PrivateMessage[];
    hasLoaded: boolean;
    readStatus: Status;
    sendStatus: Status;
    readError: string | null;
    sendError: string | null;
    readRequestId: string | null;
    sendRequestId: string | null;
    confirmedDuringFetch: PrivateMessage[];
}
const initialState: MessagesState = {userId: null, items: [], hasLoaded: false, readStatus: 'idle', sendStatus: 'idle',
    readError: null, sendError: null, readRequestId: null, sendRequestId: null, confirmedDuringFetch: []};
type ThunkConfig = {state: RootState; rejectValue: MessagesFailure};

// Aucun token dans les arguments des thunks ou dans leurs actions.
export const fetchMessages = createAsyncThunk<PrivateMessage[], number, ThunkConfig>(
    'messages/fetch', async (userId, {getState, dispatch, signal, requestId, rejectWithValue}) => {
        const auth = getState().auth;
        const current = () => !signal.aborted && getState().auth === auth
            && getState().messages.userId === userId && getState().messages.readRequestId === requestId;
        try {
            const messages = await api.fetchMessages(userId, signal);
            if (!current()) return rejectWithValue({kind: 'superseded', message: 'Requête remplacée.'});
            return messages.map(message => publicMessage(message, auth.user!.id, userId));
        } catch (error) {
            if (!current()) return rejectWithValue({kind: 'superseded', message: 'Requête remplacée.'});
            if (error instanceof DOMException && error.name === 'AbortError') throw error;
            if (error instanceof api.MessagesApiError) {
                if (error.kind === 'unauthorized') { clearStoredSession(); dispatch(resetAuth()); }
                return rejectWithValue({kind: error.kind, message: error.message});
            }
            return rejectWithValue({kind: 'invalid', message: 'Historique invalide. Veuillez réessayer.'});
        }
    }, {condition: (userId, {getState}) => getState().auth.status === 'authenticated'
        && isUserId(userId) && userId !== getState().auth.user?.id && getState().messages.userId === userId},
);

export const sendMessage = createAsyncThunk<PrivateMessage, {recipientId: number; content: string}, ThunkConfig>(
    'messages/send', async ({recipientId, content}, {getState, dispatch, signal, requestId, rejectWithValue}) => {
        const auth = getState().auth;
        const current = () => !signal.aborted && getState().auth === auth
            && getState().messages.userId === recipientId && getState().messages.sendRequestId === requestId;
        try {
            const message = await api.sendMessage(recipientId, content, signal);
            if (!current()) return rejectWithValue({kind: 'superseded', message: 'Requête remplacée.'});
            return publicMessage(message, auth.user!.id, recipientId);
        } catch (error) {
            if (!current()) return rejectWithValue({kind: 'superseded', message: 'Requête remplacée.'});
            if (error instanceof DOMException && error.name === 'AbortError') throw error;
            if (error instanceof api.MessagesApiError) {
                if (error.kind === 'unauthorized') { clearStoredSession(); dispatch(resetAuth()); }
                return rejectWithValue({kind: error.kind, message: error.message});
            }
            return rejectWithValue({kind: 'invalid', message: 'Envoi impossible. Veuillez réessayer.'});
        }
    }, {condition: ({recipientId}, {getState}) => getState().auth.status === 'authenticated'
        && isUserId(recipientId) && recipientId !== getState().auth.user?.id
        && getState().messages.userId === recipientId && getState().messages.sendStatus !== 'loading'},
);

const messagesSlice = createSlice({
    name: 'messages', initialState,
    reducers: {
        openConversation: (_, action: PayloadAction<number>) => ({...initialState, userId: action.payload}),
        clearMessages: () => initialState,
    },
    extraReducers: builder => { builder
        .addCase(fetchMessages.pending, (state, action) => {
            state.readStatus = 'loading'; state.readError = null;
            state.readRequestId = action.meta.requestId; state.confirmedDuringFetch = [];
        })
        .addCase(fetchMessages.fulfilled, (state, action) => {
            if (state.readRequestId !== action.meta.requestId) return;
            state.items = chronologicalMessages([...action.payload, ...state.confirmedDuringFetch]);
            state.hasLoaded = true;
            state.confirmedDuringFetch = []; state.readRequestId = null; state.readStatus = 'succeeded';
        })
        .addCase(fetchMessages.rejected, (state, action) => {
            if (state.readRequestId !== action.meta.requestId) return;
            state.readRequestId = null; state.confirmedDuringFetch = [];
            const cancelled = action.meta.aborted || action.payload?.kind === 'superseded';
            state.readStatus = cancelled ? 'idle' : 'failed';
            state.readError = cancelled ? null : action.payload?.message ?? 'Chargement impossible.';
        })
        .addCase(sendMessage.pending, (state, action) => {
            state.sendStatus = 'loading'; state.sendError = null; state.sendRequestId = action.meta.requestId;
        })
        .addCase(sendMessage.fulfilled, (state, action) => {
            if (state.sendRequestId !== action.meta.requestId) return;
            state.items = chronologicalMessages([...state.items, action.payload]);
            if (state.readStatus === 'loading') state.confirmedDuringFetch = chronologicalMessages([...state.confirmedDuringFetch, action.payload]);
            state.sendRequestId = null; state.sendStatus = 'succeeded';
        })
        .addCase(sendMessage.rejected, (state, action) => {
            if (state.sendRequestId !== action.meta.requestId) return;
            state.sendRequestId = null;
            const cancelled = action.meta.aborted || action.payload?.kind === 'superseded';
            state.sendStatus = cancelled ? 'idle' : 'failed';
            state.sendError = cancelled ? null : action.payload?.message ?? 'Envoi impossible.';
        })
        .addCase(resetAuth, () => initialState).addCase(setUser, () => initialState)
        .addCase(startChecking, () => initialState).addCase(sessionUnavailable, () => initialState);
    },
});
export const {openConversation, clearMessages} = messagesSlice.actions;
export default messagesSlice.reducer;
```

**`src/pages/ConversationPage.css`**

```css
.private-conversation { max-width: 48rem; margin: 1rem auto; padding: 1rem; }
.private-messages { display: flex; flex-direction: column; gap: .75rem; padding: 0; list-style: none; max-height: 28rem; overflow-y: auto; }
.private-messages li { flex-shrink: 0; }
.polling-error { font-size: .875rem; color: #6a3e00; }
.private-messages li { max-width: 80%; padding: .75rem; border-radius: .5rem; background: #eee; overflow-wrap: anywhere; }
.private-messages .message-sent { align-self: flex-end; background: #dceeff; }
.private-messages .message-received { align-self: flex-start; }
.private-messages p { white-space: pre-wrap; margin: .5rem 0; }
.private-messages time { font-size: .8rem; }
.private-conversation form { display: flex; flex-direction: column; gap: .5rem; margin-top: 1rem; }
.private-conversation textarea { min-height: 5rem; font: inherit; }
.private-conversation button { align-self: flex-start; }
```

