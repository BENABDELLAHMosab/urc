**UBO Relay Chat — Étape 7 : messages privés temporaires**

L’interface permet maintenant d’envoyer un texte au destinataire validé, de lire l’historique commun aux deux participants et de l’actualiser manuellement. Les messages reçus sont à gauche, les messages envoyés à droite. Le texte saisi est conservé après un échec d’envoi. Aucun temps réel n’est ajouté.

**Fichiers créés et modifiés**

```text
urc/
├── api/message.js                              modifié
├── lib/
│   ├── session.js                              modifié : export du client Redis existant
│   ├── privateMessages.js                      créé : règles et modèle public partagé
│   ├── privateMessages.d.ts                    créé : types TypeScript
│   └── messageStorage.js                       créé : stockage Redis et scripts Lua
├── src/features/messages/
│   ├── messagesApi.ts                          créé
│   └── messagesSlice.ts                        créé
├── src/pages/
│   ├── ConversationPage.tsx                    modifié
│   └── ConversationPage.css                    créé
├── src/app/store.ts                            modifié
├── scripts/
│   ├── auth.test.cjs                           modifié
│   └── vercel-packaging.test.cjs                modifié
├── vercel.json                                 modifié
└── docs/etape-7-messages-prives.md               créé : ce compte rendu
```

`api/users.js`, `api/login.js`, les slices utilisateurs/authentification, les routes et la restauration de session ont été examinés et sont conservés. Les deux anciennes vérifications de refus dans `api/message.js` restent couvertes par les tests précédents. La signature Node `(request, response)` du squelette est conservée. La configuration Vercel inclut désormais explicitement le SDK PostgreSQL dans cette troisième fonction Node, comme pour login/register, pour couvrir le défaut d’empaquetage précédemment rencontré.

**Modèle et validation**

`PrivateMessage` contient `id`, `senderId`, `recipientId`, `content` et `createdAt`. Le serveur produit l’UUID v4 et l’horodatage ISO UTC. Le modèle ne contient ni token, ni email, ni mot de passe. Le contenu est une chaîne de 1 à 2 000 unités UTF-16, non vide après suppression des espaces périphériques ; le texte original est conservé. Les identifiants sont des entiers positifs compatibles avec les colonnes PostgreSQL INTEGER, jusqu’à 2 147 483 647.

Les validations et la sélection explicite des cinq champs sont partagées dans `lib/privateMessages.js`, avec une déclaration `.d.ts` pour React. Le frontend vérifie le JSON, les identifiants, le contenu, les dates, le nombre maximal de messages et la cohérence des participants. Le thunk vérifie en plus que la paire correspond au compte Redux courant et au destinataire demandé. Une réponse contenant des champs supplémentaires ne les transmet pas au store.

**Contrat HTTP et contrôle d’accès**

- POST `/api/message` reçoit `{recipientId, content}` et retourne HTTP 201 avec le message créé.
- GET `/api/message?userId=…` retourne HTTP 200 et un tableau chronologique de messages, éventuellement vide.
- HTTP 400 : JSON, contenu, identifiant ou conversation avec soi-même invalide.
- HTTP 401 : session absente, invalide ou expirée.
- HTTP 404 : le destinataire n’existe pas dans PostgreSQL.
- HTTP 405 : méthode autre que GET/POST, avec `Allow: GET, POST` après authentification.
- HTTP 500 : erreur de session Redis, de stockage ou PostgreSQL, avec un message générique.

Toutes les réponses applicatives ont `Cache-Control: no-store`. Les exceptions fournisseurs et le contenu des messages ne sont pas journalisés.

Le serveur retrouve l’expéditeur avec `getConnecterUser`, qui valide le Bearer dans Redis. Un `senderId` envoyé par le client est ignoré. Il vérifie ensuite le destinataire avec une requête SQL paramétrée avant tout accès aux messages. Pour une lecture, un seul autre identifiant est accepté : le premier participant est toujours celui de la session. Ainsi, un compte tiers ne peut pas lire A–B en ajoutant arbitrairement `senderId=A` à sa requête.

GET lit un historique ; POST crée un message. Le service frontend envoie le Bearer depuis `sessionStorage`, sans le placer dans les arguments ou résultats des thunks. Il différencie 400, 401, 404, erreur serveur, erreur réseau et réponse JSON invalide. Un ancien résultat dont le token a été remplacé est annulé logiquement.

**Stockage Redis, durée et concurrence**

Le [README du TP](../README.md) indique à la rubrique « Enregistrement des messages » une conservation de 24 heures et propose LPUSH pour la démo. La durée retenue suit cette indication : `MESSAGE_TTL_SECONDS = 86400`. Le plafond de 100 messages (`MESSAGE_LIMIT`) et la limite de contenu (`MESSAGE_MAX_LENGTH = 2000`) sont des choix de cette étape, pas des exigences attribuées au professeur. Ces constantes peuvent être adaptées dans le code sans changer les variables d’environnement.

La clé déterministe est :

```text
urc:private:v1:<plus petit identifiant>:<plus grand identifiant>
```

Par exemple, les comptes 2 et 7 utilisent tous les deux `urc:private:v1:2:7`. Le préfixe sépare ces clés des sessions et du hash utilisateurs existants. A–B et A–C utilisent des clés différentes.

Un sorted set est utilisé plutôt qu’une liste pour pouvoir supprimer les messages trop anciens par score, borner le volume et conserver un ordre chronologique même lors d’envois concurrents. Chaque membre est le JSON complet du message, avec un UUID unique ; le score est son horodatage serveur en millisecondes. Deux messages distincts ne s’écrasent donc pas.

L’écriture utilise un unique `redis.eval` : ZADD, EXPIRE, suppression des scores âgés d’au moins 24 heures, puis réduction aux 100 derniers messages. Le TTL est fixé immédiatement après ZADD, avant les suppressions et la borne. Les paramètres numériques viennent de constantes et de dates serveur validées, et aucun code Lua n’est construit à partir du contenu.

Le TTL de la clé est renouvelé à chaque envoi. Il expire la conversation après 24 heures sans nouvel envoi. Cela ne rend pas les anciens messages permanents dans une conversation active : le script supprime aussi les membres âgés de 24 heures lors des écritures et des lectures. GET ne renouvelle pas le TTL. Une clé devenue vide est supprimée par Redis. La lecture est bornée à 100 membres ; la réponse finale est triée par `createdAt` croissant, puis par UUID en cas d’égalité.

Les scripts sont atomiques vis-à-vis des autres commandes Redis : aucun autre envoi ne peut s’intercaler entre ces opérations. Lua n’est pas une transaction avec rollback automatique sur une erreur ; les opérations et arguments sont ici fixes, et le TTL est posé avant les opérations de nettoyage. Les erreurs sont remontées sous forme de HTTP 500 sûr.

Références : [EVAL avec le client Upstash](https://upstash.com/docs/redis/sdks/ts/commands/scripts/eval), [atomicité et fonctionnement des scripts Redis](https://redis.io/docs/latest/develop/programmability/eval-intro/).

**Redux, requêtes obsolètes et données privées**

Le store ajoute `messages` à `auth` et `users`, en conservant `RootState` et `AppDispatch`.

Deux thunks ont des cycles distincts :

- `fetchMessages(userId)` : `readStatus`, `readError`, `readRequestId`.
- `sendMessage({recipientId, content})` : `sendStatus`, `sendError`, `sendRequestId`.

`createAsyncThunk` exécute l’opération HTTP et produit pending/fulfilled/rejected. `extraReducers` transforme ces actions en changements d’état. pending indique un chargement ; fulfilled applique la réponse validée du serveur ; rejected présente une erreur sûre, ou revient à idle après une annulation. Il n’y a pas d’ajout optimiste : l’envoi n’apparaît qu’après HTTP 201.

Chaque résultat vérifie l’identité Redux de départ, l’identifiant de conversation actif et le requestId de son opération. Une réponse pour A ne peut pas remplir B, ni remplir une nouvelle session. Le changement de conversation repart d’un état vide ; le nettoyage de l’effet annule sa lecture et l’éventuel envoi en cours. StrictMode peut effectuer montage/nettoyage/remontage : la seconde requête devient la requête courante, les résultats de la première sont ignorés.

Les messages sont fusionnés et dédupliqués par identifiant serveur. `confirmedDuringFetch` conserve les seuls envois confirmés pendant une lecture encore en cours : un ancien instantané ne peut pas les effacer. La lecture suivante remplace l’ancien historique et permet de retirer les messages expirés ; on ne fusionne pas aveuglément toute l’ancienne liste avec les nouvelles réponses.

Sur un HTTP 401 courant, le thunk appelle `clearStoredSession` et `resetAuth`. Les actions `resetAuth`, `setUser`, `startChecking`, `sessionUnavailable` vident également les messages et leurs requestIds. `ProtectedRoute` redirige ensuite vers `/login`. Une erreur réseau ou HTTP 500 ne supprime pas la session. Un ancien 401 ne peut pas effacer une session plus récente.

Le texte saisi est local au composant, pas dans le slice. Le composant est remonté pour une nouvelle paire compte/destinataire et le brouillon précédent disparaît. En revanche, un simple échec d’envoi conserve le brouillon pour réessayer. Les messages privés sont nécessairement présents dans Redux et les arguments d’envoi durant la session ; ils peuvent être visibles dans les outils de développement du navigateur. Réinitialiser le state ne promet pas d’effacer un historique DevTools déjà enregistré. Aucun token n’y est ajouté et aucun contenu privé n’est écrit dans les logs applicatifs.

**Parcours d’envoi**

1. La route protégée restaure/vérifie la session et valide le destinataire via les données utilisateurs.
2. Le formulaire refuse un contenu vide ou trop long et désactive Envoyer pendant l’opération.
3. `dispatch(sendMessage(...))` déclenche pending et le service POST avec le Bearer courant.
4. Le backend vérifie session, contenu, destinataire et existence PostgreSQL, puis construit le message et le stocke atomiquement dans Redis.
5. HTTP 201 déclenche fulfilled : le message est fusionné par UUID et affiché à droite ; le brouillon est vidé. Une erreur garde le texte saisi et propose de réessayer avec Envoyer.

**Parcours de lecture**

1. L’effet de la conversation ouvre l’état correspondant et déclenche `dispatch(fetchMessages(id))`.
2. GET `/api/message?userId=id` vérifie de nouveau la session et le destinataire, construit la clé à partir de la session et de cet identifiant, purge les messages trop anciens et lit au plus 100 messages.
3. fulfilled remplace l’instantané, en conservant les confirmations intervenues pendant cette lecture. Les messages reçus sont affichés à gauche, les messages envoyés à droite, avec émetteur et date.
4. Actualiser rejoue ce parcours manuellement. Après F5, `/api/me` intervient d’abord ; ensuite la liste utilisateurs et les messages sont chargés. Aucun polling ou abonnement n’est ajouté.

Les deux participants voient le même échange car la clé trie leurs identifiants. Les champs senderId/recipientId du message restent inchangés, ce qui permet à chacun de déterminer quel côté afficher.

**Résultats des vérifications exécutées**

| Vérification | Résultat |
|---|---|
| `node scripts/auth.test.cjs` | 190 tests réussis : les 121 précédents et 69 nouveaux ; 0 échec, 0 ignoré |
| `node scripts/vercel-packaging.test.cjs` | 4 tests réussis : un test parent et trois sous-tests ; login/register/message construits avec le vrai constructeur Vercel et chargés en isolation |
| TypeScript application : `tsc --project tsconfig.app.json --noEmit --incremental false --pretty false` | Réussi |
| TypeScript configuration : `tsc --project tsconfig.node.json --noEmit --incremental false --pretty false` | Réussi |
| Build de production Vite en mémoire, `envFile: false`, `build.write: false` | Réussi ; aucun déploiement ni fichier de production écrit |
| `git diff --check` | Réussi |
| Firefox headless, vrai React en StrictMode et API simulées | Parcours réussis ci-dessous |

Les tests Node couvrent les statuts 200/201/400/401/404/405/500, l’expéditeur provenant de la session, les contenus vides/trop longs/à la limite de 2 000 caractères, les identifiants invalides, l’envoi à soi-même et les destinataires absents. Ils vérifient aussi l’échange depuis les deux comptes, l’isolation d’un tiers, l’ordre, le plafond de 100 messages, le TTL et la suppression des anciens messages pendant une conversation active, avec un Redis simulé et une horloge contrôlée.

Ils couvrent les deux thunks, les erreurs HTTP/réseau/JSON/participants, l’absence d’ajout optimiste, le blocage d’un second envoi simultané, les doublons, le croisement lecture/envoi, les requêtes concurrentes, les annulations, le remplacement du token, les changements de compte et la perte de session. Le rendu serveur vérifie l’échappement HTML, les classes gauche/droite, les boutons, les dates et l’absence de token dans Redux/DOM/logs. Les 121 tests précédents gardent leurs assertions ; leur harnais simule maintenant également les commandes de messages et le passage Request vers la signature Node.

Dans les paquets Vercel, login/register répondent à GET par 405 et à POST incomplet par 400 ; leur Argon2 natif fonctionne. Le paquet message démarre et refuse une requête sans token avec 401, sans accès aux bases. Le fichier CommonJS PostgreSQL requis est présent pour les trois fonctions.

Le script Firefox temporaire exécuté est `/tmp/urc-messages-browser.mjs`. Les API HTTP sont simulées, sans données distantes :

- accès anonyme protégé ; connexion avec le vrai formulaire ; ouverture du destinataire sans rechargement ; chargement des messages en StrictMode ;
- texte contenant du HTML affiché littéralement, sans création de balise ; reçu à gauche, envoyé à droite ;
- contenu vide/espaces et envoi en cours désactivés ; absence de message optimiste avant HTTP 201 ; brouillon vidé après confirmation ;
- actualisation sans doublons ;
- brouillon et session conservés pour erreurs 400/404/500/réseau, puis envoi réussi lors de la nouvelle tentative ;
- changement rapide de conversation avec lecture ancienne encore en vol : aucun contenu de l’ancien destinataire dans la nouvelle conversation ;
- rechargement complet : nouvelle vérification `/api/me` et récupération de l’historique ;
- erreur de lecture : historique déjà présent conservé, actualisation possible ;
- HTTP 401 : stockage nettoyé et interface privée remplacée par `/login` ;
- aucun token dans le DOM, aucun token/mot de passe/contenu de message dans les logs capturés, aucune erreur d’exécution React détectée.

**Limites et éléments non testés**

Neon et Upstash n’ont pas été contactés. Les commandes et le temps Redis sont simulés dans les tests Node ; les scripts Lua n’ont pas été exécutés sur un serveur Redis réel. Le navigateur, React, Redux Toolkit, React Router et le constructeur Vercel sont réels. Le démarrage des artefacts est testé localement ; aucun déploiement ni test HTTP sur Vercel en production n’a été effectué.

Redis est un stockage temporaire ici : les messages peuvent expirer ou être évincés du plafond de 100, et aucune archive durable n’existe dans PostgreSQL. Sans actualisation manuelle, le navigateur peut conserver son dernier instantané après expiration côté Redis. Il n’y a pas de pagination d’anciens messages, de temps réel, de pièces jointes, de groupes ou de notifications.

Annuler une requête HTTP ne garantit pas l’annulation d’une écriture déjà exécutée côté serveur. Après une coupure ayant perdu la réponse, Actualiser permet de vérifier l’historique. Un renvoi manuel peut créer un nouveau message avec un nouvel UUID ; aucune clé d’idempotence métier n’est ajoutée dans cette étape. La déduplication Redux porte sur les identifiants confirmés, pas sur des textes identiques.

Cette messagerie n’est pas chiffrée de bout en bout. Le backend et les administrateurs du stockage peuvent accéder aux contenus. Aucune nouvelle protection anti-spam/rate limiting n’a été développée dans cette étape.

Aucune modification du schéma PostgreSQL, de l’inscription, du hachage ou des variables d’environnement. Aucune dépendance ajoutée, aucun déploiement. L’étape s’arrête ici, en attente de validation avant toute suite.

**Code complet livré**

Les blocs suivants correspondent aux fichiers livrés, y compris le modèle, l’endpoint complet, les scripts Redis, le service, le slice avec ses deux thunks, la page, son CSS, le store et la configuration Vercel.

**`lib/privateMessages.d.ts`**

```typescript
export interface PrivateMessage {
    id: string;
    senderId: number;
    recipientId: number;
    content: string;
    createdAt: string;
}
export const MESSAGE_MAX_LENGTH: number;
export const MESSAGE_LIMIT: number;
export const MESSAGE_TTL_SECONDS: number;
export function isUserId(value: unknown): value is number;
export function conversationKey(first: number, second: number): string;
export function isMessageContent(value: unknown): value is string;
export function publicMessage(value: unknown, first: number, second: number): PrivateMessage;
export function chronologicalMessages(messages: PrivateMessage[]): PrivateMessage[];
```

**`lib/privateMessages.js`**

```javascript
export const MESSAGE_MAX_LENGTH = 2000;
export const MESSAGE_LIMIT = 100;
// README du TP : messages temporaires pendant 24 heures.
export const MESSAGE_TTL_SECONDS = 24 * 60 * 60;

export function isUserId(value) {
    return Number.isInteger(value) && value > 0 && value <= 2147483647;
}

export function conversationKey(first, second) {
    if (!isUserId(first) || !isUserId(second) || first === second) throw new Error('Invalid participants');
    return `urc:private:v1:${Math.min(first, second)}:${Math.max(first, second)}`;
}

export function isMessageContent(value) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= MESSAGE_MAX_LENGTH;
}

export function publicMessage(value, first, second) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || typeof value.id !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id)
        || !isUserId(value.senderId) || !isUserId(value.recipientId)
        || !((value.senderId === first && value.recipientId === second)
            || (value.senderId === second && value.recipientId === first))
        || !isMessageContent(value.content) || typeof value.createdAt !== 'string'
        || !Number.isFinite(Date.parse(value.createdAt))
        || new Date(value.createdAt).toISOString() !== value.createdAt) {
        throw new Error('Invalid private message');
    }
    return {id: value.id, senderId: value.senderId, recipientId: value.recipientId,
        content: value.content, createdAt: value.createdAt};
}

export function chronologicalMessages(messages) {
    return [...new Map(messages.map(message => [message.id, message])).values()]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        .slice(-MESSAGE_LIMIT);
}
```

**`api/message.js`**

```javascript
import {sql} from '@vercel/postgres';
import {getConnecterUser} from '../lib/session.js';
import {isUserId, isMessageContent} from '../lib/privateMessages.js';
import {storeMessage, readMessages} from '../lib/messageStorage.js';

// Conserve la signature Node Serverless du squelette du TP.
export default async function handler(request, response) {
    response.setHeader?.('Cache-Control', 'no-store');
    const json = (body, status) => response.status(status).json(body);
    const invalid = message => json({code: 'INVALID_INPUT', message}, 400);
    try {
        const user = await getConnecterUser(request);
        if (!user || !isUserId(user.id)) return json({code: 'UNAUTHORIZED', message: 'Session expirée.'}, 401);
        const method = request.method ?? 'GET';
        if (method !== 'GET' && method !== 'POST') {
            response.setHeader?.('Allow', 'GET, POST');
            return json({code: 'METHOD_NOT_ALLOWED', message: 'GET ou POST requis.'}, 405);
        }

        let recipientId, content;
        if (method === 'POST') {
            let body;
            try {
                body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
            } catch {
                return invalid('JSON invalide.');
            }
            if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid('Message invalide.');
            recipientId = body.recipientId;
            content = body.content;
            if (!isMessageContent(content)) return invalid('Le message doit contenir entre 1 et 2 000 caractères, sans être vide.');
        } else {
            const value = request.query?.userId;
            if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return invalid('Destinataire invalide.');
            recipientId = Number(value);
        }
        if (!isUserId(recipientId)) return invalid('Destinataire invalide.');
        if (recipientId === user.id) return invalid('Une conversation avec soi-même est impossible.');
        const {rows} = await sql`SELECT user_id FROM users WHERE user_id = ${recipientId}`;
        if (rows.length !== 1) return json({code: 'NOT_FOUND', message: 'Destinataire introuvable.'}, 404);

        if (method === 'GET') return json(await readMessages(user.id, recipientId), 200);
        const message = {id: crypto.randomUUID(), senderId: user.id, recipientId,
            content, createdAt: new Date().toISOString()};
        await storeMessage(message);
        return json(message, 201);
    } catch {
        // Aucune exception fournisseur ni contenu privé dans les réponses ou les logs.
        return json({code: 'MESSAGES_UNAVAILABLE', message: 'Messagerie indisponible. Veuillez réessayer.'}, 500);
    }
}
```

**`lib/messageStorage.js`**

```javascript
import {redis} from './session.js';
import {conversationKey, publicMessage, chronologicalMessages, MESSAGE_LIMIT, MESSAGE_TTL_SECONDS} from './privateMessages.js';

// Un seul EVAL : aucune autre requête ne peut s'intercaler entre écriture, TTL et borne.
export const STORE_MESSAGE = `
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[4])
local count = redis.call('ZCARD', KEYS[1])
local maximum = tonumber(ARGV[5])
if count > maximum then redis.call('ZREMRANGEBYRANK', KEYS[1], 0, count - maximum - 1) end
return 1
`;

export const READ_MESSAGES = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
return redis.call('ZRANGE', KEYS[1], -tonumber(ARGV[2]), -1)
`;

export async function storeMessage(message) {
    const time = Date.parse(message.createdAt);
    const result = await redis.eval(STORE_MESSAGE, [conversationKey(message.senderId, message.recipientId)],
        [JSON.stringify(message), time, MESSAGE_TTL_SECONDS, time - MESSAGE_TTL_SECONDS * 1000, MESSAGE_LIMIT]);
    if (result !== 1) throw new Error('Message storage not confirmed');
}

export async function readMessages(first, second) {
    const rows = await redis.eval(READ_MESSAGES, [conversationKey(first, second)],
        [Date.now() - MESSAGE_TTL_SECONDS * 1000, MESSAGE_LIMIT]);
    if (!Array.isArray(rows) || rows.length > MESSAGE_LIMIT) throw new Error('Invalid message history');
    return chronologicalMessages(rows.map(row => publicMessage(
        typeof row === 'string' ? JSON.parse(row) : row, first, second)));
}
```

**`src/features/messages/messagesApi.ts`**

```typescript
import {chronologicalMessages, isMessageContent, isUserId, MESSAGE_LIMIT, publicMessage} from '../../../lib/privateMessages.js';
import type {PrivateMessage} from '../../../lib/privateMessages.js';
export type {PrivateMessage} from '../../../lib/privateMessages.js';

export interface MessagesFailure {
    kind: 'unauthorized' | 'input' | 'notFound' | 'server' | 'network' | 'invalid' | 'superseded';
    message: string;
}

export class MessagesApiError extends Error {
    readonly kind: MessagesFailure['kind'];
    constructor(kind: MessagesFailure['kind'], message: string) {
        super(message);
        this.name = 'MessagesApiError';
        this.kind = kind;
    }
}

function parseMessage(value: unknown, userId: number): PrivateMessage {
    const candidate = value as Partial<PrivateMessage> | null;
    if (!candidate || !isUserId(candidate.senderId) || !isUserId(candidate.recipientId)
        || candidate.senderId === candidate.recipientId
        || (candidate.senderId !== userId && candidate.recipientId !== userId)) throw new Error('Invalid participants');
    return publicMessage(value, candidate.senderId, candidate.recipientId);
}

async function request(userId: number, content: string | undefined, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!isUserId(userId) || (content !== undefined && !isMessageContent(content))) {
        throw new MessagesApiError('input', 'Destinataire ou contenu invalide (1 à 2 000 caractères).');
    }
    let token: string | null;
    try { token = sessionStorage.getItem('token'); }
    catch { throw new MessagesApiError('invalid', 'Accès au stockage de session impossible.'); }
    if (!token) throw new MessagesApiError('unauthorized', 'Session expirée. Reconnectez-vous.');
    const assertCurrent = () => {
        signal.throwIfAborted();
        if (sessionStorage.getItem('token') !== token) throw new DOMException('Session superseded', 'AbortError');
    };
    const sending = content !== undefined;
    let response: Response;
    try {
        response = await fetch(sending ? '/api/message' : `/api/message?userId=${userId}`, {
            method: sending ? 'POST' : 'GET', cache: 'no-store', signal,
            headers: {Authorization: `Bearer ${token}`, ...(sending ? {'Content-Type': 'application/json'} : {})},
            ...(sending ? {body: JSON.stringify({recipientId: userId, content})} : {}),
        });
    } catch {
        assertCurrent();
        throw new MessagesApiError('network', 'Connexion réseau impossible. Veuillez réessayer.');
    }
    assertCurrent();
    if (response.status === 401) throw new MessagesApiError('unauthorized', 'Session expirée. Reconnectez-vous.');
    if (response.status === 400) throw new MessagesApiError('input', 'Message ou destinataire invalide.');
    if (response.status === 404) throw new MessagesApiError('notFound', 'Ce destinataire n’existe plus.');
    if (!response.ok) throw new MessagesApiError('server', 'Messagerie indisponible. Veuillez réessayer.');
    if (response.status !== (sending ? 201 : 200)) throw new MessagesApiError('invalid', 'Réponse de messagerie invalide.');
    let result: PrivateMessage | PrivateMessage[];
    try {
        const data: unknown = await response.json();
        assertCurrent();
        if (sending) {
            const message = parseMessage(data, userId);
            if (message.recipientId !== userId || message.content !== content) throw new Error('Invalid sent message');
            result = message;
        } else {
            if (!Array.isArray(data) || data.length > MESSAGE_LIMIT) throw new Error('Invalid history');
            const messages = data.map(value => parseMessage(value, userId));
            const other = (message: PrivateMessage) => message.senderId === userId ? message.recipientId : message.senderId;
            if (messages.some(message => other(message) !== other(messages[0]))) throw new Error('Mixed conversations');
            result = chronologicalMessages(messages);
        }
    } catch {
        assertCurrent();
        throw new MessagesApiError('invalid', 'Réponse de messagerie invalide.');
    }
    assertCurrent();
    return result;
}

export async function fetchMessages(userId: number, signal = new AbortController().signal): Promise<PrivateMessage[]> {
    return await request(userId, undefined, signal) as PrivateMessage[];
}

export async function sendMessage(recipientId: number, content: string, signal = new AbortController().signal): Promise<PrivateMessage> {
    if (!isMessageContent(content)) throw new MessagesApiError('input', 'Le message doit contenir entre 1 et 2 000 caractères, sans être vide.');
    return await request(recipientId, content, signal) as PrivateMessage;
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
    readStatus: Status;
    sendStatus: Status;
    readError: string | null;
    sendError: string | null;
    readRequestId: string | null;
    sendRequestId: string | null;
    confirmedDuringFetch: PrivateMessage[];
}
const initialState: MessagesState = {userId: null, items: [], readStatus: 'idle', sendStatus: 'idle',
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

**`src/pages/ConversationPage.tsx`**

```tsx
import React, {Fragment, useEffect, useRef, useState} from 'react';
import type {FormEvent} from 'react';
import {Link, useParams} from 'react-router-dom';
import {useDispatch, useSelector} from 'react-redux';
import type {AppDispatch, RootState} from '../app/store';
import {useUsers} from '../features/users/useUsers';
import {clearMessages, fetchMessages, openConversation, sendMessage} from '../features/messages/messagesSlice';
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
    useEffect(() => {
        active.current = true;
        dispatch(openConversation(recipient.user_id));
        const request = dispatch(fetchMessages(recipient.user_id));
        return () => {
            active.current = false;
            request.abort(); pendingSend.current?.abort();
            dispatch(clearMessages());
        };
    }, [dispatch, recipient.user_id, user]);

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
        {(!current || messages.readStatus === 'loading') && <p role="status">Chargement des messages…</p>}
        {current && messages.readError && <p role="alert">{messages.readError}</p>}
        {current && messages.readStatus === 'succeeded' && messages.items.length === 0 && <p>Aucun message pour le moment.</p>}
        <ol className="private-messages" aria-label="Messages">
            {current && messages.items.map(message => <li key={message.id}
                className={message.senderId === user.id ? 'message-sent' : 'message-received'}>
                <strong>{message.senderId === user.id ? 'Vous' : recipient.username}</strong>
                <p>{message.content}</p>
                <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString('fr-FR')}</time>
            </li>)}
        </ol>
        <button type="button" disabled={!current || messages.readStatus === 'loading'}
            onClick={() => dispatch(fetchMessages(recipient.user_id))}>Actualiser</button>
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

**`src/pages/ConversationPage.css`**

```css
.private-conversation { max-width: 48rem; margin: 1rem auto; padding: 1rem; }
.private-messages { display: flex; flex-direction: column; gap: .75rem; padding: 0; list-style: none; }
.private-messages li { max-width: 80%; padding: .75rem; border-radius: .5rem; background: #eee; overflow-wrap: anywhere; }
.private-messages .message-sent { align-self: flex-end; background: #dceeff; }
.private-messages .message-received { align-self: flex-start; }
.private-messages p { white-space: pre-wrap; margin: .5rem 0; }
.private-messages time { font-size: .8rem; }
.private-conversation form { display: flex; flex-direction: column; gap: .5rem; margin-top: 1rem; }
.private-conversation textarea { min-height: 5rem; font: inherit; }
.private-conversation button { align-self: flex-start; }
```

**`src/app/store.ts`**

```typescript
import {configureStore} from "@reduxjs/toolkit";
import authReducer from "../features/auth/authSlice";
import usersReducer from "../features/users/usersSlice";
import messagesReducer from "../features/messages/messagesSlice";

export const store = configureStore({
    //Ici, authReducer est le reducer global du slice, généré automatiquement par createSlice. Il sait traiter toutes les actions de ce slice.
    // c est pour cette raison que il est en singulier et dans le slice en pleural
    reducer: {
        auth: authReducer,
        users: usersReducer,
        messages: messagesReducer,
    },
});

// pour exporter le type ( pour le typescript)

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
```

**`vercel.json`**

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "functions": {
    "api/message.js": {
      "includeFiles": "node_modules/@vercel/postgres/dist/**"
    },
    "api/login.js": {
      "includeFiles": "node_modules/@vercel/postgres/dist/**"
    },
    "api/register.js": {
      "includeFiles": "node_modules/@vercel/postgres/dist/**"
    }
  },
  "rewrites": [
    {
      "source": "/((?!api(?:/|$)|src(?:/|$)|assets(?:/|$)|node_modules(?:/|$)|@|.*\\.[^/]+$).*)",
      "destination": "/index.html"
    }
  ]
}
```

