**UBO Relay Chat — Étape 9 : salons de discussion et messages de groupe**

Les utilisateurs authentifiés peuvent consulter les salons, en créer un, ouvrir `/rooms/:roomId`, écrire et lire un historique commun actualisé automatiquement. Tous les utilisateurs connectés ont accès à tous les salons. Aucun système de membres, invitation ou salon privé n’est introduit.

**Architecture retenue et fichiers**

```text
urc/
├── api/
│   ├── rooms.js                                 créé
│   └── room-messages.js                         créé
├── lib/
│   ├── rooms.js                                 créé : validation et modèles publics
│   ├── rooms.d.ts                               créé : types TypeScript
│   ├── messageStorage.js                        modifié : stockage mutualisé
│   └── privateMessages.d.ts                     modifié : typage générique du tri existant
├── src/
│   ├── features/rooms/
│   │   ├── roomsApi.ts                          créé
│   │   ├── roomsSlice.ts                        créé
│   │   ├── roomMessagesApi.ts                   créé
│   │   ├── roomMessagesSlice.ts                 créé
│   │   └── useRooms.ts                          créé
│   ├── features/messages/useMessagePolling.ts   modifié : adaptateur private/room
│   ├── pages/
│   │   ├── RoomsPage.tsx                        créé
│   │   ├── RoomPage.tsx                         créé
│   │   └── MessagesPage.tsx                     modifié : lien vers les salons
│   ├── app/store.ts                             modifié
│   └── App.jsx                                  modifié : routes protégées
├── scripts/
│   ├── auth.test.cjs                            modifié
│   └── vercel-packaging.test.cjs                 modifié
├── vercel.json                                  modifié
└── docs/etape-9-salons.md                         créé : ce compte rendu
```

Un slice `rooms` gère la liste et la création ; un slice `roomMessages` gère uniquement les messages du salon actif. Le slice privé `messages` et ses thunks restent inchangés. Cette séparation rend explicite la différence entre une conversation à deux destinataires et un espace accessible à tous les comptes connectés, sans transformer le modèle privé en union de nombreuses variantes.

Les mécanismes sensibles sont partagés : `getConnecterUser` et le client Redis existant, le transport HTTP des deux nouvelles API frontend, les deux scripts Lua existants, le tri/déduplication et une seule boucle de polling. Les cycles Redux lecture/envoi restent explicites dans le nouveau slice pour garder une lecture pédagogique et un état strictement distinct. Les styles de conversation existants sont réutilisés ; leur ancien nom de classe CSS ne définit pas les permissions. Le texte visible indique clairement l’accès à tous les utilisateurs connectés.

**Schéma réellement présent dans scripts/db.sql**

| Colonne | Définition dans le fichier |
|---|---|
| room_id | serial PRIMARY KEY |
| name | VARCHAR(50) UNIQUE NOT NULL |
| created_on | TIMESTAMP NOT NULL, sans valeur DEFAULT |
| created_by | INTEGER NOT NULL, sans clé étrangère |

Il n’y a pas de table de membres. Les lignes de démonstration General, News et Random portent toutes `created_by = 4`, alors que le script ne garantit pas la présence d’un utilisateur 4. Elles sont donc listées directement depuis `rooms`, sans jointure obligatoire sur `users` qui les ferait disparaître. Le créateur n’a aucun privilège particulier dans cette étape.

Le schéma ne contrôle pas que le nom est non vide et ne normalise ni les espaces ni la casse. L’application supprime les espaces périphériques avant insertion et impose un nom non vide de 1 à 50 unités UTF-16, sans caractères de contrôle. Cette limite est conservatrice par rapport aux 50 caractères PostgreSQL, notamment pour certains caractères Unicode.

La contrainte UNIQUE(name) constitue l’autorité contre deux créations concurrentes. Le backend traduit l’erreur PostgreSQL 23505 en HTTP 409, sans se contenter d’un SELECT préalable vulnérable à une course. L’application n’impose pas d’unicité par `lower(name)` : aucune garantie supplémentaire sur la casse ou les accents n’est revendiquée. Leur comparaison dépend de la collation réellement installée ; le fichier ne définit pas de collation spéciale. La normalisation des espaces n’est pas imposée aux écritures extérieures à cette API par le schéma.

Référence : [contraintes PostgreSQL](https://www.postgresql.org/docs/current/ddl-constraints.html).

**Modèles exposés**

Le modèle public de salon est volontairement limité à `{room_id, name}`. Les métadonnées created_on et created_by sont écrites en base mais ne sont pas nécessaires à la liste ou au titre. Le créateur vient de la session et la date de création est fournie par PostgreSQL avec NOW().

Un `RoomMessage` expose `id`, `roomId`, `senderId`, `senderName`, `content`, `createdAt`. senderId et senderName viennent de la session validée ; senderName est un instantané du nom au moment de l’envoi. L’UUID et la date ISO UTC sont générés côté serveur. Aucun token, email ou mot de passe n’est stocké dans le message. Les textes sont limités à 2 000 unités UTF-16, non vides après trim, en conservant le contenu original.

Les fonctions partagées valident et extraient explicitement les champs publics. Les services frontend vérifient les listes, les identifiants, les messages, le salon demandé, les dates, le plafond et les statuts HTTP. Des champs imprévus dans une réponse ne passent pas dans Redux.

**API salons : GET et POST /api/rooms**

Les deux opérations utilisent la signature Node Vercel `(request, response)`, vérifient le Bearer avec `getConnecterUser` et ajoutent `Cache-Control: no-store`.

- GET sélectionne room_id et name, triés par room_id, et retourne HTTP 200 avec un tableau, vide si nécessaire.
- POST reçoit `{name}`, normalise et valide le nom, puis insère avec une requête SQL paramétrée `name`, NOW() et l’identifiant de session comme created_by. Un created_by fourni par le client est ignoré. La réponse HTTP 201 contient seulement le salon public.
- 400 : JSON ou nom invalide ; 401 : session refusée ; 409 : doublon SQL ; 405 : méthode non autorisée avec Allow ; 500 : erreur interne générique.

Aucune nouvelle table ni modification du script SQL n’est nécessaire.

**API messages : GET et POST /api/room-messages**

GET reçoit `roomId` dans la query ; POST reçoit `{roomId, content}`. Le serveur valide la session, l’identifiant INTEGER positif et l’existence du salon avec une requête SQL paramétrée avant de lire ou écrire Redis. Aucun filtrage par membre n’est appliqué : tous les comptes authentifiés peuvent participer.

POST ignore les identités fournies par le client, construit le message depuis la session et retourne HTTP 201 après confirmation Redis. GET retourne HTTP 200 avec les 100 derniers messages au maximum, triés par createdAt puis UUID. Le rôle de l’expéditeur reste inchangé pour tous les lecteurs ; chacun détermine le côté d’affichage par comparaison de senderId avec son propre compte.

400 signale une entrée invalide, 401 une session refusée, 404 un salon absent, 405 une méthode incorrecte et 500 une erreur sûre. Toutes les réponses ont no-store. Ni les exceptions fournisseurs ni le contenu des messages ne sont journalisés.

Les deux nouvelles fonctions Node ont une règle `includeFiles` pour le SDK PostgreSQL dans vercel.json, comme les fonctions existantes, afin de couvrir le problème CommonJS déjà rencontré sur Vercel. Leur démarrage en paquet isolé est testé.

**PostgreSQL et Redis n’ont pas le même rôle**

PostgreSQL conserve les utilisateurs et les métadonnées durables des salons, avec leurs contraintes SQL. Redis conserve les sessions et l’historique temporaire. Redux est uniquement l’état en mémoire du navigateur ; il ne remplace aucun de ces stockages serveur.

Les salons utilisent `urc:room:v1:<roomId>`. Les conversations privées gardent `urc:private:v1:<minUserId>:<maxUserId>`. Deux salons ne partagent pas de clé, et un identifiant de salon égal à un identifiant utilisateur n’a aucune signification particulière. Il est donc autorisé d’envoyer au salon 1 depuis le compte 1.

`messageStorage.js` extrait seulement deux helpers internes, storeAtKey et readAtKey. Les fonctions privées conservent leur signature et leur validation de paire. Les nouvelles fonctions room utilisent roomKey et publicRoomMessage. Les chaînes des scripts STORE_MESSAGE et READ_MESSAGES restent inchangées.

Un même EVAL effectue l’écriture en sorted set, pose le TTL de 86 400 secondes, supprime les scores de plus de 24 heures et réduit le volume à 100. La lecture retire également les membres expirés sans renouveler le TTL, puis renvoie au maximum 100 messages. Le TTL de la clé est renouvelé à l’envoi ; après 24 heures sans écriture elle disparaît. Dans un salon actif, les messages trop anciens sont exclus lors des lectures et écritures. Les opérations du script s’exécutent sans intercalage d’un autre envoi.

Le helper de tri JavaScript est déjà indépendant des destinataires ; seule sa déclaration TypeScript devient générique sur id et createdAt. Cela permet de le réutiliser pour les RoomMessage sans changer sa logique ni la politique Redis.

**Redux : création, lecture et envoi**

Le store ajoute rooms et roomMessages à auth, users et messages.

`fetchRooms` et `createRoom` ont des statuts et requestIds séparés. Lors d’une création, pending active l’état de création, fulfilled ajoute le salon public à la liste et rejected présente un message sûr. Les salons créés pendant une lecture sont mémorisés jusqu’à son résultat pour éviter qu’un ancien instantané ne les efface. La liste est dédupliquée par room_id.

Dans React, le nom est local au formulaire. La validation est partagée, le bouton est désactivé pendant la création et le texte reste présent en cas d’erreur ou de conflit. Après HTTP 201, le composant encore actif vide le champ et utilise React Router pour ouvrir `/rooms/<nouvelId>` sans rechargement.

`fetchRoomMessages` et `sendRoomMessage` emploient des états de lecture/envoi séparés, comme la conversation privée. La confirmation d’un envoi est ajoutée seulement après HTTP 201. Une lecture commencée avant un envoi confirmé ne peut pas effacer ce message récent. Les confirmations et les lectures sont dédupliquées par UUID ; un simple texte identique ne sert pas de clé.

Les thunks réalisent l’opération asynchrone ; `extraReducers` traite pending, fulfilled et rejected pour actualiser le store. `useSelector` abonne les pages aux portions sélectionnées. Quand ces valeurs changent, React Redux déclenche le rendu correspondant. Référence : [createAsyncThunk](https://redux-toolkit.js.org/api/createAsyncThunk).

Chaque thunk compare l’identité de départ et son requestId au moment de publier son résultat ou de traiter un refus 401. Les messages comparent aussi roomId au salon actif. Les annulations ou réponses obsolètes ne changent pas le salon suivant ou le compte suivant. Les actions setUser, resetAuth, startChecking et sessionUnavailable vident les deux nouveaux slices.

Un HTTP 401 courant nettoie le stockage de session et déclenche resetAuth, puis ProtectedRoute renvoie vers /login. Un 500 ou une panne réseau ne supprime pas le token. Les arguments et payloads Redux ne contiennent aucun token. Les contenus présents dans Redux et visibles dans l’interface sont ceux du salon autorisé ; ils ne sont pas affichés dans les logs applicatifs.

**Pages, routes et polling**

`/rooms` et `/rooms/:roomId` sont placées sous le ProtectedRoute existant. La page de liste indique explicitement que les salons sont ouverts à tous les comptes connectés. Elle présente la liste, son chargement, l’état vide, la nouvelle tentative, le formulaire de création et le lien vers la messagerie privée. L’accueil privé possède un lien vers les salons.

`useParams` fournit une chaîne roomId. La page vérifie un entier positif compatible PostgreSQL, sans zéro initial, puis recherche le salon dans les métadonnées chargées. Une URL valide ne garantit pas que le salon existe. Un identifiant invalide ou inconnu a un message explicite. Après F5, AuthInitializer restaure d’abord la session avec /api/me, puis les salons et l’historique sont récupérés. Les API de messages vérifient l’existence du salon à chaque opération, même si son nom est déjà en cache côté client.

Le polling existant reçoit un second argument `kind`, private par défaut pour préserver les appels précédents. Le mode room sélectionne roomMessages.roomId et fetchRoomMessages ; le mode private conserve messages.userId et fetchMessages. Il n’y a qu’une seule implémentation du timer, des événements, des abonnements et des annulations.

Le délai reste de 8 secondes après la réponse précédente. Une requête lente n’en empile pas d’autres ; Actualiser rejoint le mécanisme courant. La boucle s’arrête au démontage ou à la perte de session, se suspend quand l’onglet est masqué ou le navigateur hors ligne et reprend au retour. StrictMode est conservé. kind fait partie des dépendances de l’effet : un changement de type nettoie l’ancienne boucle.

Le composant de salon est remonté pour chaque couple compte/roomId. Il nettoie le state et annule l’envoi en cours lors du départ. Il conserve le brouillon lors d’un simple échec d’envoi. Les textes, noms de salon et d’expéditeur sont rendus par React sans HTML injecté. Les styles et le scroll conditionnel de l’étape 8 sont réutilisés : grand chargement uniquement au début, erreur de lecture discrète ensuite, suivi du bas seulement si l’utilisateur y était proche.

**Résultats réellement exécutés**

| Vérification | Résultat |
|---|---|
| `node scripts/auth.test.cjs` | 292 tests réussis : les 211 précédents + 81 nouveaux ; 0 échec, 0 ignoré |
| `node scripts/vercel-packaging.test.cjs` | 6 tests réussis : un parent et cinq sous-tests ; login, register, message, rooms et room-messages |
| TypeScript application : `tsc --project tsconfig.app.json --noEmit --incremental false --pretty false` | Réussi |
| TypeScript configuration : `tsc --project tsconfig.node.json --noEmit --incremental false --pretty false` | Réussi |
| Build de production Vite en mémoire sans fichiers .env ni écriture de dist | Réussi, 72 modules transformés |
| `git diff --check` | Réussi |
| Firefox headless avec React StrictMode et API simulées | Scénario complet réussi |

Les nouveaux tests Node couvrent le schéma, les créateurs de démo sans FK, liste vide, création, longueur du nom, normalisation, doublons et concurrence d’insertion. Ils couvrent les sessions absentes/invalides/expirées, JSON, méthodes, identifiants, salons inexistants, textes vides ou trop longs, identité d’expéditeur, lecture depuis trois comptes, isolation entre salons et avec la conversation privée, ordre, TTL, plafond de 100 et écritures concurrentes Redis simulées.

Ils vérifient également la récupération des métadonnées à l’entrée d’une page malgré une ancienne liste en cache. Ils couvrent aussi pending/fulfilled/rejected des quatre thunks, erreurs HTTP/réseau, réponses invalides, champs sensibles supplémentaires, création pendant une lecture, déduplication, réponses obsolètes, annulations, changements de compte, nettoyage 401, maintien du token sur 500, liens et échappement HTML, routes directes, polling partagé, StrictMode, visibilité/offline et arrêt au changement de salon. Les assertions des 211 tests précédents sont conservées ; le harnais ajoute les routes Node et les données SQL simulées de rooms. Son horloge et son Redis simulés continuent d’éviter toute écriture distante.

Les paquets Vercel sont construits avec le véritable constructeur Node et chargés dans des répertoires isolés. Les deux nouveaux handlers démarrent et refusent les requêtes sans session avec HTTP 401 sans appeler les bases ; le SDK PostgreSQL CommonJS est présent dans chacun.

Le scénario Firefox temporaire exécuté est `/tmp/urc-rooms-browser.mjs`. Il utilise le vrai frontend et de fausses API locales ; les 8 secondes sont accélérées à 250ms uniquement dans le profil de test, et les tests Node vérifient le délai réel de 8000ms. Il a confirmé :

- protection de l’accès anonyme et navigation depuis la messagerie privée sans rechargement ;
- validation du formulaire, conservation du nom lors d’un conflit 409, création HTTP 201 puis navigation vers le nouveau salon ;
- envoi avec affichage de l’auteur, brouillon/session conservés sur 500 et nouvelle tentative réussie ;
- messages de trois auteurs affichés et polling sans doublons en StrictMode ;
- suspension/reprise visibilité et offline, requête lente sans chevauchement ni clignotement, changement rapide de salon sans ancien contenu ;
- rechargement direct avec restauration de session, métadonnées et historique ;
- échappement HTML, arrêt du polling de salon en revenant aux messages privés, conservation de l’isolation ;
- erreur de liste avec bouton Réessayer fonctionnel ;
- URL invalide ou salon inconnu, nettoyage et arrêt sur 401 ;
- absence de token dans le DOM, absence de token/mot de passe/contenu de message dans les logs capturés, aucune erreur d’exécution React détectée.

**Ce qui est simulé et ce qui reste non vérifié**

Aucun appel Neon/Upstash réel n’a été effectué pendant cette étape. Aucune création de salon ou de message distante, aucun déploiement. Les accès PostgreSQL et Redis des tests Node, et les API HTTP Firefox, sont simulés. Les scripts Lua partagés ne sont toujours pas confirmés par un échange réel de messages, conformément aux limites signalées aux étapes 7 et 8. Le constructeur Vercel, le navigateur, React, Redux Toolkit et React Router sont réels ; cela ne remplace pas un test du runtime déployé et des bases réelles.

La suite complète de messagerie privée et son polling restent réussis après la factorisation du stockage et l’adaptateur de polling. Le script SQL, les API privées, le hachage, les variables d’environnement et les dépendances ne sont pas modifiés.

**Limites restantes**

Les salons sont ouverts à tous les comptes connectés ; aucune confidentialité entre membres, gestion de membres, invitation ou modération n’est ajoutée. Il n’y a pas d’E2EE, de notification, de WebSocket ni de pièce jointe. Le contenu est accessible au backend et au stockage.

La liste reste en mémoire dans Redux, mais elle est récupérée de nouveau à chaque ouverture de page et changement de roomId. Un salon créé depuis un autre navigateur apparaît donc au prochain passage sur la liste ; une page de liste laissée ouverte ne reçoit pas automatiquement les créations externes et peut demander un F5. Le contrôle d’existence serveur sur GET/POST reste l’autorité ; un salon supprimé hors application peut rester nommé dans le cache jusqu’à son prochain chargement, mais ses nouvelles opérations seront refusées.

Le nom d’expéditeur stocké est celui de l’envoi, pas une jointure actualisée sur users. L’existence de created_by n’est pas garantie par une FK du schéma ; la création via l’application utilise néanmoins une session vérifiée. La comparaison exacte des noms et la collation doivent être confirmées dans l’instance PostgreSQL réelle si une règle insensible à la casse devient souhaitée.

Les messages restent temporaires et bornés, sans pagination ancienne. La disparition physique des membres trop anciens intervient lors des lectures/écritures ou de l’expiration de la clé. Le polling conserve une latence et consomme des requêtes sur les services. Après une réponse d’envoi perdue, un nouvel envoi manuel peut créer un autre UUID ; aucune idempotence métier n’est ajoutée. L’annulation HTTP ne revient pas sur une écriture déjà exécutée.

**Procédure manuelle avec trois comptes réels**

À réaliser seulement après validation des écritures, dans un environnement de développement isolé. Préparer trois comptes existants A, B et C dans trois profils de navigateur indépendants ; ne pas créer automatiquement de comptes pour ce test.

1. Ouvrir l’application locale avec ses API. Se connecter dans les trois profils. Dans A, aller sur /rooms et créer un nom de salon de test unique. Vérifier POST /api/rooms HTTP 201. Une lecture SQL de contrôle peut confirmer created_by = user_id de A et created_on non nul, sans publier les secrets ou tokens.
2. Dans B et C, recharger la liste des salons pour retrouver ce nouveau salon. L’ouvrir sans invitation : tous les comptes authentifiés doivent y avoir accès. Recharger directement /rooms/id pour confirmer la restauration /api/me puis les métadonnées et l’historique.
3. A, B et C envoient chacun un texte de développement identifiable. Vérifier chaque POST HTTP 201, senderId/senderName correspondant au compte et roomId correct. Les trois fenêtres doivent afficher le même historique, trié par createdAt puis UUID, avec auteurs et dates et sans doublons.
4. Attendre une actualisation automatique après 8 secondes plus latence, puis utiliser Actualiser. Masquer une fenêtre et tester offline/online : les requêtes doivent se suspendre et reprendre. Une panne 500 ne doit pas supprimer la session ; un refus 401 réel doit nettoyer l’interface et renvoyer vers /login.
5. Dans un deuxième salon de test, envoyer un texte différent. Vérifier qu’il n’apparaît pas dans le premier. Envoyer également un message privé A–B et confirmer qu’il n’apparaît dans aucun salon ; le profil C n’a accès qu’à sa propre conversation privée, mais à tous les salons.
6. Dans la console Redis de développement, lire TYPE, TTL et ZCARD pour `urc:room:v1:id` : zset, TTL positif proche de 86400 après un envoi, au plus 100 membres. Vérifier le préfixe distinct de `urc:private:v1:...`. GET ne doit pas renouveler le TTL. Ne pas imprimer les contenus dans un rapport.
7. Pour confirmer réellement la borne, seulement après accord, produire plus de 100 messages dans le salon de test isolé : ZCARD et GET doivent rester à 100, avec les plus anciens retirés. Ne pas utiliser un salon contenant des échanges à conserver. Pour le vieillissement de 24 heures, observer l’expiration réelle ou garder provisoirement la validation par horloge simulée ; ne pas modifier la politique du projet pour accélérer le test.
8. Tenter une seconde création du même nom : HTTP 409 et aucun second salon. Vérifier une URL de salon absente (404 API) et les méthodes/entrées invalides. Ne pas copier les Authorization, mots de passe ou chaînes de connexion dans le compte rendu.

Aucune de ces écritures manuelles n’a été exécutée par l’agent. Le travail s’arrête après cette étape en attente de validation.

**Code complet livré**

Les blocs ci-dessous présentent les nouveaux modèles, endpoints, services, slices/thunks et pages, ainsi que les modifications ciblées du stockage, du polling, du store et des routes.

**`lib/rooms.d.ts`**

```typescript
export interface Room { room_id: number; name: string; }
export interface RoomMessage {
    id: string;
    roomId: number;
    senderId: number;
    senderName: string;
    content: string;
    createdAt: string;
}
export function normalizeRoomName(value: unknown): string;
export function isRoomName(value: unknown): value is string;
export function publicRoom(value: unknown): Room;
export function roomKey(roomId: number): string;
export function publicRoomMessage(value: unknown, roomId: number): RoomMessage;
```

**`lib/rooms.js`**

```javascript
import {isUserId, isMessageContent} from './privateMessages.js';

export function normalizeRoomName(value) {
    return typeof value === 'string' ? value.trim() : '';
}

export function isRoomName(value) {
    return typeof value === 'string' && value === value.trim() && value.length >= 1
        && value.length <= 50 && !/[\u0000-\u001f\u007f]/.test(value);
}

export function publicRoom(value) {
    if (!value || typeof value !== 'object' || !isUserId(value.room_id) || !isRoomName(value.name)) {
        throw new Error('Invalid room');
    }
    return {room_id: value.room_id, name: value.name};
}

export function roomKey(roomId) {
    if (!isUserId(roomId)) throw new Error('Invalid room ID');
    return `urc:room:v1:${roomId}`;
}

export function publicRoomMessage(value, roomId) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || typeof value.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id)
        || !isUserId(value.roomId) || value.roomId !== roomId || !isUserId(value.senderId)
        || typeof value.senderName !== 'string' || !value.senderName.trim() || value.senderName.length > 50
        || !isMessageContent(value.content) || typeof value.createdAt !== 'string'
        || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt) {
        throw new Error('Invalid room message');
    }
    return {id: value.id, roomId: value.roomId, senderId: value.senderId, senderName: value.senderName,
        content: value.content, createdAt: value.createdAt};
}
```

**`api/rooms.js`**

```javascript
import {sql} from '@vercel/postgres';
import {getConnecterUser} from '../lib/session.js';
import {isUserId} from '../lib/privateMessages.js';
import {normalizeRoomName, isRoomName, publicRoom} from '../lib/rooms.js';

export default async function handler(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    const json = (body, status) => response.status(status).json(body);
    try {
        const user = await getConnecterUser(request);
        if (!user || !isUserId(user.id)) return json({code: 'UNAUTHORIZED', message: 'Session expirée.'}, 401);
        if (request.method === 'GET') {
            // Pas de jointure : les salons de démonstration ont un created_by sans FK.
            const {rows} = await sql`SELECT room_id, name FROM rooms ORDER BY room_id`;
            return json(rows.map(publicRoom), 200);
        }
        if (request.method !== 'POST') {
            response.setHeader('Allow', 'GET, POST');
            return json({code: 'METHOD_NOT_ALLOWED', message: 'GET ou POST requis.'}, 405);
        }
        let body;
        try { body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body; }
        catch { return json({code: 'INVALID_INPUT', message: 'JSON invalide.'}, 400); }
        const name = normalizeRoomName(body?.name);
        if (!body || Array.isArray(body) || !isRoomName(name)) {
            return json({code: 'INVALID_INPUT', message: 'Le nom doit contenir 1 à 50 caractères, sans caractères de contrôle.'}, 400);
        }
        const {rows} = await sql`INSERT INTO rooms (name, created_on, created_by)
            VALUES (${name}, NOW(), ${user.id}) RETURNING room_id, name`;
        return json(publicRoom(rows[0]), 201);
    } catch (error) {
        if (error?.code === '23505') return json({code: 'CONFLICT', message: 'Ce nom de salon est déjà utilisé.'}, 409);
        return json({code: 'ROOMS_UNAVAILABLE', message: 'Salons indisponibles. Veuillez réessayer.'}, 500);
    }
}
```

**`api/room-messages.js`**

```javascript
import {sql} from '@vercel/postgres';
import {getConnecterUser} from '../lib/session.js';
import {isUserId, isMessageContent} from '../lib/privateMessages.js';
import {readRoomMessages, storeRoomMessage} from '../lib/messageStorage.js';

export default async function handler(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    const json = (body, status) => response.status(status).json(body);
    const invalid = message => json({code: 'INVALID_INPUT', message}, 400);
    try {
        const user = await getConnecterUser(request);
        if (!user || !isUserId(user.id) || !user.username.trim() || user.username.length > 50) {
            return json({code: 'UNAUTHORIZED', message: 'Session expirée.'}, 401);
        }
        if (!['GET', 'POST'].includes(request.method)) {
            response.setHeader('Allow', 'GET, POST');
            return json({code: 'METHOD_NOT_ALLOWED', message: 'GET ou POST requis.'}, 405);
        }
        let roomId, content;
        if (request.method === 'POST') {
            let body;
            try { body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body; }
            catch { return invalid('JSON invalide.'); }
            if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid('Message invalide.');
            roomId = body.roomId; content = body.content;
            if (!isMessageContent(content)) return invalid('Le message doit contenir 1 à 2 000 caractères, sans être vide.');
        } else {
            const value = request.query?.roomId;
            if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return invalid('Identifiant de salon invalide.');
            roomId = Number(value);
        }
        if (!isUserId(roomId)) return invalid('Identifiant de salon invalide.');
        const {rows} = await sql`SELECT room_id FROM rooms WHERE room_id = ${roomId}`;
        if (rows.length !== 1) return json({code: 'NOT_FOUND', message: 'Salon introuvable.'}, 404);
        if (request.method === 'GET') return json(await readRoomMessages(roomId), 200);
        const message = {id: crypto.randomUUID(), roomId, senderId: user.id, senderName: user.username,
            content, createdAt: new Date().toISOString()};
        await storeRoomMessage(message);
        return json(message, 201);
    } catch {
        return json({code: 'MESSAGES_UNAVAILABLE', message: 'Messages du salon indisponibles. Veuillez réessayer.'}, 500);
    }
}
```

**`lib/messageStorage.js`**

```javascript
import {redis} from './session.js';
import {conversationKey, publicMessage, chronologicalMessages, MESSAGE_LIMIT, MESSAGE_TTL_SECONDS} from './privateMessages.js';
import {roomKey, publicRoomMessage} from './rooms.js';

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

async function storeAtKey(key, message) {
    const time = Date.parse(message.createdAt);
    const result = await redis.eval(STORE_MESSAGE, [key],
        [JSON.stringify(message), time, MESSAGE_TTL_SECONDS, time - MESSAGE_TTL_SECONDS * 1000, MESSAGE_LIMIT]);
    if (result !== 1) throw new Error('Message storage not confirmed');
}

async function readAtKey(key, validate) {
    const rows = await redis.eval(READ_MESSAGES, [key],
        [Date.now() - MESSAGE_TTL_SECONDS * 1000, MESSAGE_LIMIT]);
    if (!Array.isArray(rows) || rows.length > MESSAGE_LIMIT) throw new Error('Invalid message history');
    return chronologicalMessages(rows.map(row => validate(typeof row === 'string' ? JSON.parse(row) : row)));
}

export function storeMessage(message) {
    return storeAtKey(conversationKey(message.senderId, message.recipientId), message);
}
export function readMessages(first, second) {
    return readAtKey(conversationKey(first, second), value => publicMessage(value, first, second));
}
export function storeRoomMessage(message) {
    return storeAtKey(roomKey(message.roomId), publicRoomMessage(message, message.roomId));
}
export function readRoomMessages(roomId) {
    return readAtKey(roomKey(roomId), value => publicRoomMessage(value, roomId));
}
```

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
export function chronologicalMessages<T extends {id: string; createdAt: string}>(messages: T[]): T[];
```

**`src/features/rooms/roomsApi.ts`**

```typescript
import {isRoomName, normalizeRoomName, publicRoom} from '../../../lib/rooms.js';
import type {Room} from '../../../lib/rooms.js';
export type {Room} from '../../../lib/rooms.js';

export interface RoomFailure {
    kind: 'unauthorized' | 'input' | 'notFound' | 'conflict' | 'server' | 'network' | 'invalid' | 'superseded';
    message: string;
}
export class RoomApiError extends Error {
    readonly kind: RoomFailure['kind'];
    constructor(kind: RoomFailure['kind'], message: string) {
        super(message); this.name = 'RoomApiError'; this.kind = kind;
    }
}

// Transport commun aux salons et à leurs messages, sans importer le store.
export async function requestRoomApi(url: string, body: unknown | undefined, expected: number, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    let token: string | null;
    try { token = sessionStorage.getItem('token'); }
    catch { throw new RoomApiError('invalid', 'Accès au stockage de session impossible.'); }
    if (!token) throw new RoomApiError('unauthorized', 'Session expirée. Reconnectez-vous.');
    const current = () => {
        signal.throwIfAborted();
        if (sessionStorage.getItem('token') !== token) throw new DOMException('Session superseded', 'AbortError');
    };
    let response: Response;
    try {
        response = await fetch(url, {method: body === undefined ? 'GET' : 'POST', signal, cache: 'no-store',
            headers: {Authorization: `Bearer ${token}`, ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
            ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    } catch {
        current(); throw new RoomApiError('network', 'Connexion réseau impossible. Veuillez réessayer.');
    }
    current();
    if (response.status === 401) throw new RoomApiError('unauthorized', 'Session expirée. Reconnectez-vous.');
    if (response.status === 400) throw new RoomApiError('input', 'Nom de salon ou message invalide.');
    if (response.status === 404) throw new RoomApiError('notFound', 'Salon introuvable.');
    if (response.status === 409) throw new RoomApiError('conflict', 'Ce nom de salon est déjà utilisé.');
    if (!response.ok) throw new RoomApiError('server', 'Service des salons indisponible. Veuillez réessayer.');
    if (response.status !== expected) throw new RoomApiError('invalid', 'Réponse des salons invalide.');
    try {
        const data: unknown = await response.json(); current(); return data;
    } catch {
        current(); throw new RoomApiError('invalid', 'Réponse des salons invalide.');
    }
}

export async function getRooms(signal = new AbortController().signal): Promise<Room[]> {
    const data = await requestRoomApi('/api/rooms', undefined, 200, signal);
    try {
        if (!Array.isArray(data)) throw new Error();
        const rooms = data.map(publicRoom);
        if (new Set(rooms.map(room => room.room_id)).size !== rooms.length) throw new Error();
        return rooms;
    } catch { throw new RoomApiError('invalid', 'Liste des salons invalide.'); }
}
export async function postRoom(value: string, signal = new AbortController().signal): Promise<Room> {
    const name = normalizeRoomName(value);
    if (!isRoomName(name)) throw new RoomApiError('input', 'Le nom doit contenir 1 à 50 caractères, sans caractères de contrôle.');
    const data = await requestRoomApi('/api/rooms', {name}, 201, signal);
    try { return publicRoom(data); }
    catch { throw new RoomApiError('invalid', 'Réponse de création invalide.'); }
}
```

**`src/features/rooms/roomMessagesApi.ts`**

```typescript
import {chronologicalMessages, isMessageContent, isUserId, MESSAGE_LIMIT} from '../../../lib/privateMessages.js';
import {publicRoomMessage} from '../../../lib/rooms.js';
import type {RoomMessage} from '../../../lib/rooms.js';
import {requestRoomApi, RoomApiError} from './roomsApi';
export type {RoomMessage} from '../../../lib/rooms.js';

export async function fetchRoomMessages(roomId: number, signal = new AbortController().signal): Promise<RoomMessage[]> {
    if (!isUserId(roomId)) throw new RoomApiError('input', 'Identifiant de salon invalide.');
    const data = await requestRoomApi(`/api/room-messages?roomId=${roomId}`, undefined, 200, signal);
    try {
        if (!Array.isArray(data) || data.length > MESSAGE_LIMIT) throw new Error();
        return chronologicalMessages(data.map(value => publicRoomMessage(value, roomId)));
    } catch { throw new RoomApiError('invalid', 'Historique du salon invalide.'); }
}
export async function sendRoomMessage(roomId: number, content: string, signal = new AbortController().signal): Promise<RoomMessage> {
    if (!isUserId(roomId) || !isMessageContent(content)) throw new RoomApiError('input', 'Salon ou message invalide (1 à 2 000 caractères).');
    const data = await requestRoomApi('/api/room-messages', {roomId, content}, 201, signal);
    try {
        const message = publicRoomMessage(data, roomId);
        if (message.content !== content) throw new Error();
        return message;
    } catch { throw new RoomApiError('invalid', 'Réponse d’envoi invalide.'); }
}
```

**`src/features/rooms/roomsSlice.ts`**

```typescript
import {createAsyncThunk, createSlice} from '@reduxjs/toolkit';
import type {RootState} from '../../app/store';
import {resetAuth, setUser, startChecking, sessionUnavailable} from '../auth/authSlice';
import {clearStoredSession} from '../../user/loginApi';
import {getRooms, postRoom, RoomApiError} from './roomsApi';
import type {Room, RoomFailure} from './roomsApi';

type Status = 'idle' | 'loading' | 'succeeded' | 'failed';
interface RoomsState {
    items: Room[]; status: Status; error: string | null; requestId: string | null;
    createStatus: Status; createError: string | null; createRequestId: string | null;
    createdDuringFetch: Room[];
}
const initialState: RoomsState = {items: [], status: 'idle', error: null, requestId: null,
    createStatus: 'idle', createError: null, createRequestId: null, createdDuringFetch: []};
type Config = {state: RootState; rejectValue: RoomFailure};
const mergeRooms = (items: Room[]) => [...new Map(items.map(room => [room.room_id, room])).values()].sort((a, b) => a.room_id - b.room_id);

export const fetchRooms = createAsyncThunk<Room[], void, Config>('rooms/fetch', async (_, api) => {
    const auth = api.getState().auth;
    const current = () => !api.signal.aborted && api.getState().auth === auth && api.getState().rooms.requestId === api.requestId;
    try {
        const rooms = await getRooms(api.signal);
        if (!current()) return api.rejectWithValue({kind: 'superseded', message: 'Requête remplacée.'});
        return rooms;
    } catch (error) {
        if (!current()) return api.rejectWithValue({kind: 'superseded', message: 'Requête remplacée.'});
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        if (error instanceof RoomApiError) {
            if (error.kind === 'unauthorized') {clearStoredSession(); api.dispatch(resetAuth());}
            return api.rejectWithValue({kind: error.kind, message: error.message});
        }
        return api.rejectWithValue({kind: 'invalid', message: 'Chargement des salons impossible.'});
    }
}, {condition: (_, api) => api.getState().auth.status === 'authenticated'});

export const createRoom = createAsyncThunk<Room, string, Config>('rooms/create', async (name, api) => {
    const auth = api.getState().auth;
    const current = () => !api.signal.aborted && api.getState().auth === auth && api.getState().rooms.createRequestId === api.requestId;
    try {
        const room = await postRoom(name, api.signal);
        if (!current()) return api.rejectWithValue({kind: 'superseded', message: 'Requête remplacée.'});
        return room;
    } catch (error) {
        if (!current()) return api.rejectWithValue({kind: 'superseded', message: 'Requête remplacée.'});
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        if (error instanceof RoomApiError) {
            if (error.kind === 'unauthorized') {clearStoredSession(); api.dispatch(resetAuth());}
            return api.rejectWithValue({kind: error.kind, message: error.message});
        }
        return api.rejectWithValue({kind: 'invalid', message: 'Création du salon impossible.'});
    }
}, {condition: (_, api) => api.getState().auth.status === 'authenticated' && api.getState().rooms.createStatus !== 'loading'});

const roomsSlice = createSlice({name: 'rooms', initialState, reducers: {}, extraReducers: builder => {
    builder.addCase(fetchRooms.pending, (state, action) => {
        state.status = 'loading'; state.error = null; state.requestId = action.meta.requestId; state.createdDuringFetch = [];
    }).addCase(fetchRooms.fulfilled, (state, action) => {
        if (state.requestId !== action.meta.requestId) return;
        state.items = mergeRooms([...action.payload, ...state.createdDuringFetch]);
        state.status = 'succeeded'; state.requestId = null; state.createdDuringFetch = [];
    }).addCase(fetchRooms.rejected, (state, action) => {
        if (state.requestId !== action.meta.requestId) return;
        state.requestId = null; state.createdDuringFetch = [];
        const cancelled = action.meta.aborted || action.payload?.kind === 'superseded';
        state.status = cancelled ? 'idle' : 'failed'; state.error = cancelled ? null : action.payload?.message ?? 'Chargement impossible.';
    }).addCase(createRoom.pending, (state, action) => {
        state.createStatus = 'loading'; state.createError = null; state.createRequestId = action.meta.requestId;
    }).addCase(createRoom.fulfilled, (state, action) => {
        if (state.createRequestId !== action.meta.requestId) return;
        state.items = mergeRooms([...state.items, action.payload]);
        if (state.status === 'loading') state.createdDuringFetch = mergeRooms([...state.createdDuringFetch, action.payload]);
        state.createStatus = 'succeeded'; state.createRequestId = null;
    }).addCase(createRoom.rejected, (state, action) => {
        if (state.createRequestId !== action.meta.requestId) return;
        state.createRequestId = null;
        const cancelled = action.meta.aborted || action.payload?.kind === 'superseded';
        state.createStatus = cancelled ? 'idle' : 'failed'; state.createError = cancelled ? null : action.payload?.message ?? 'Création impossible.';
    }).addCase(resetAuth, () => initialState).addCase(setUser, () => initialState)
        .addCase(startChecking, () => initialState).addCase(sessionUnavailable, () => initialState);
}});
export default roomsSlice.reducer;
```

**`src/features/rooms/roomMessagesSlice.ts`**

```typescript
import {createAsyncThunk, createSlice} from '@reduxjs/toolkit';
import type {PayloadAction} from '@reduxjs/toolkit';
import type {RootState} from '../../app/store';
import {resetAuth, sessionUnavailable, setUser, startChecking} from '../auth/authSlice';
import {clearStoredSession} from '../../user/loginApi';
import * as api from './roomMessagesApi';
import type {RoomMessage} from './roomMessagesApi';
import {RoomApiError} from './roomsApi';
import type {RoomFailure} from './roomsApi';
import {chronologicalMessages, isUserId} from '../../../lib/privateMessages.js';
import {publicRoomMessage} from '../../../lib/rooms.js';

type Status = 'idle' | 'loading' | 'succeeded' | 'failed';
export interface RoomMessagesState {
    roomId: number | null;
    items: RoomMessage[];
    hasLoaded: boolean;
    readStatus: Status;
    sendStatus: Status;
    readError: string | null;
    sendError: string | null;
    readRequestId: string | null;
    sendRequestId: string | null;
    confirmedDuringFetch: RoomMessage[];
}
const initialState: RoomMessagesState = {roomId: null, items: [], hasLoaded: false, readStatus: 'idle', sendStatus: 'idle',
    readError: null, sendError: null, readRequestId: null, sendRequestId: null, confirmedDuringFetch: []};
type ThunkConfig = {state: RootState; rejectValue: RoomFailure};

// Aucun token dans les arguments des thunks ou dans leurs actions.
export const fetchRoomMessages = createAsyncThunk<RoomMessage[], number, ThunkConfig>(
    'roomMessages/fetch', async (roomId, {getState, dispatch, signal, requestId, rejectWithValue}) => {
        const auth = getState().auth;
        const current = () => !signal.aborted && getState().auth === auth
            && getState().roomMessages.roomId === roomId && getState().roomMessages.readRequestId === requestId;
        try {
            const messages = await api.fetchRoomMessages(roomId, signal);
            if (!current()) return rejectWithValue({kind: 'superseded', message: 'Requête remplacée.'});
            return messages.map(message => publicRoomMessage(message, roomId));
        } catch (error) {
            if (!current()) return rejectWithValue({kind: 'superseded', message: 'Requête remplacée.'});
            if (error instanceof DOMException && error.name === 'AbortError') throw error;
            if (error instanceof RoomApiError) {
                if (error.kind === 'unauthorized') { clearStoredSession(); dispatch(resetAuth()); }
                return rejectWithValue({kind: error.kind, message: error.message});
            }
            return rejectWithValue({kind: 'invalid', message: 'Historique invalide. Veuillez réessayer.'});
        }
    }, {condition: (roomId, {getState}) => getState().auth.status === 'authenticated'
        && isUserId(roomId) && getState().roomMessages.roomId === roomId},
);

export const sendRoomMessage = createAsyncThunk<RoomMessage, {roomId: number; content: string}, ThunkConfig>(
    'roomMessages/send', async ({roomId, content}, {getState, dispatch, signal, requestId, rejectWithValue}) => {
        const auth = getState().auth;
        const current = () => !signal.aborted && getState().auth === auth
            && getState().roomMessages.roomId === roomId && getState().roomMessages.sendRequestId === requestId;
        try {
            const message = await api.sendRoomMessage(roomId, content, signal);
            if (!current()) return rejectWithValue({kind: 'superseded', message: 'Requête remplacée.'});
            if (message.senderId !== auth.user!.id) throw new Error('Invalid sender');
            return publicRoomMessage(message, roomId);
        } catch (error) {
            if (!current()) return rejectWithValue({kind: 'superseded', message: 'Requête remplacée.'});
            if (error instanceof DOMException && error.name === 'AbortError') throw error;
            if (error instanceof RoomApiError) {
                if (error.kind === 'unauthorized') { clearStoredSession(); dispatch(resetAuth()); }
                return rejectWithValue({kind: error.kind, message: error.message});
            }
            return rejectWithValue({kind: 'invalid', message: 'Envoi impossible. Veuillez réessayer.'});
        }
    }, {condition: ({roomId}, {getState}) => getState().auth.status === 'authenticated'
        && isUserId(roomId)
        && getState().roomMessages.roomId === roomId && getState().roomMessages.sendStatus !== 'loading'},
);

const roomMessagesSlice = createSlice({
    name: 'roomMessages', initialState,
    reducers: {
        openRoom: (_, action: PayloadAction<number>) => ({...initialState, roomId: action.payload}),
        clearRoomMessages: () => initialState,
    },
    extraReducers: builder => { builder
        .addCase(fetchRoomMessages.pending, (state, action) => {
            state.readStatus = 'loading'; state.readError = null;
            state.readRequestId = action.meta.requestId; state.confirmedDuringFetch = [];
        })
        .addCase(fetchRoomMessages.fulfilled, (state, action) => {
            if (state.readRequestId !== action.meta.requestId) return;
            state.items = chronologicalMessages([...action.payload, ...state.confirmedDuringFetch]);
            state.hasLoaded = true;
            state.confirmedDuringFetch = []; state.readRequestId = null; state.readStatus = 'succeeded';
        })
        .addCase(fetchRoomMessages.rejected, (state, action) => {
            if (state.readRequestId !== action.meta.requestId) return;
            state.readRequestId = null; state.confirmedDuringFetch = [];
            const cancelled = action.meta.aborted || action.payload?.kind === 'superseded';
            state.readStatus = cancelled ? 'idle' : 'failed';
            state.readError = cancelled ? null : action.payload?.message ?? 'Chargement impossible.';
        })
        .addCase(sendRoomMessage.pending, (state, action) => {
            state.sendStatus = 'loading'; state.sendError = null; state.sendRequestId = action.meta.requestId;
        })
        .addCase(sendRoomMessage.fulfilled, (state, action) => {
            if (state.sendRequestId !== action.meta.requestId) return;
            state.items = chronologicalMessages([...state.items, action.payload]);
            if (state.readStatus === 'loading') state.confirmedDuringFetch = chronologicalMessages([...state.confirmedDuringFetch, action.payload]);
            state.sendRequestId = null; state.sendStatus = 'succeeded';
        })
        .addCase(sendRoomMessage.rejected, (state, action) => {
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
export const {openRoom, clearRoomMessages} = roomMessagesSlice.actions;
export default roomMessagesSlice.reducer;
```

**`src/features/rooms/useRooms.ts`**

```typescript
import {useEffect} from 'react';
import {useDispatch, useSelector} from 'react-redux';
import type {RootState, AppDispatch} from '../../app/store';
import {fetchRooms} from './roomsSlice';

export function useRooms(roomId?: number) {
    const dispatch = useDispatch<AppDispatch>();
    const auth = useSelector((state: RootState) => state.auth);
    const rooms = useSelector((state: RootState) => state.rooms);
    useEffect(() => {
        if (auth.status !== 'authenticated') return;
        const request = dispatch(fetchRooms());
        return () => request.abort();
    }, [auth, roomId, dispatch]);
    return {...rooms, retry: () => dispatch(fetchRooms())};
}
```

**`src/pages/RoomsPage.tsx`**

```tsx
import React, {useEffect, useRef, useState} from 'react';
import type {FormEvent} from 'react';
import {Link, useNavigate} from 'react-router-dom';
import {useDispatch} from 'react-redux';
import type {AppDispatch} from '../app/store';
import {useRooms} from '../features/rooms/useRooms';
import {createRoom} from '../features/rooms/roomsSlice';
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
    return <main>
        <h1>Salons de discussion</h1>
        <p>Accessibles à tous les utilisateurs connectés.</p>
        {(rooms.status === 'loading' || rooms.status === 'idle') && <p role="status">Chargement des salons…</p>}
        {rooms.status === 'failed' && <div role="alert"><p>{rooms.error}</p><button onClick={rooms.retry}>Réessayer</button></div>}
        {rooms.status === 'succeeded' && rooms.items.length === 0 && <p>Aucun salon disponible.</p>}
        <ul>{rooms.items.map(room => <li key={room.room_id}><Link to={`/rooms/${room.room_id}`}>{room.name}</Link></li>)}</ul>
        <form onSubmit={submit} noValidate>
            <label htmlFor="room-name">Nom du nouveau salon</label>
            <input id="room-name" name="name" value={name} maxLength={50} required
                onChange={event => setName(event.target.value)} disabled={rooms.createStatus === 'loading'}
                aria-describedby="room-name-error" aria-invalid={!!(validationError || rooms.createError)} />
            <button type="submit" disabled={rooms.createStatus === 'loading'}>
                {rooms.createStatus === 'loading' ? 'Création en cours…' : 'Créer un salon'}</button>
            {(validationError || rooms.createError) && <p id="room-name-error" role="alert">{validationError || rooms.createError}</p>}
        </form>
        <Link to="/messages">Messagerie privée</Link>
    </main>;
}
```

**`src/pages/RoomPage.tsx`**

```tsx
import React, {Fragment, useEffect, useLayoutEffect, useRef, useState} from 'react';
import type {FormEvent} from 'react';
import {Link, useParams} from 'react-router-dom';
import {useDispatch, useSelector} from 'react-redux';
import type {AppDispatch, RootState} from '../app/store';
import type {AuthUser} from '../features/auth/authSlice';
import type {Room} from '../features/rooms/roomsApi';
import {useRooms} from '../features/rooms/useRooms';
import {clearRoomMessages, openRoom, sendRoomMessage} from '../features/rooms/roomMessagesSlice';
import {useMessagePolling} from '../features/messages/useMessagePolling';
import {isUserId, isMessageContent, MESSAGE_MAX_LENGTH} from '../../lib/privateMessages.js';
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
    const refresh = useMessagePolling(room.room_id, 'room');
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
        <h2>Salon : {room.name}</h2>
        <p>Tous les utilisateurs connectés peuvent lire et écrire ici.</p>
        {(!current || (!messages.hasLoaded && messages.readStatus === 'loading')) && <p role="status">Chargement des messages…</p>}
        {current && messages.readError && <p role={messages.hasLoaded ? 'status' : 'alert'} className="polling-error">{messages.readError}</p>}
        {current && messages.hasLoaded && messages.items.length === 0 && <p>Aucun message dans ce salon.</p>}
        <ol className="private-messages" aria-label="Messages" tabIndex={0} ref={list} onScroll={() => {
            if (list.current) nearBottom.current = list.current.scrollHeight - list.current.scrollTop - list.current.clientHeight < 80;
        }}>
            {current && messages.items.map(message => <li key={message.id}
                className={message.senderId === user.id ? 'message-sent' : 'message-received'}>
                <strong>{message.senderName}{message.senderId === user.id ? ' (vous)' : ''}</strong>
                <p>{message.content}</p><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString('fr-FR')}</time>
            </li>)}
        </ol>
        <button type="button" disabled={!current || messages.readStatus === 'loading'} onClick={refresh}>Actualiser</button>
        <form onSubmit={submit}>
            <label htmlFor="room-message">Votre message au salon</label>
            <textarea id="room-message" name="content" value={draft} maxLength={MESSAGE_MAX_LENGTH} disabled={sending}
                onChange={event => setDraft(event.target.value)} aria-describedby="room-message-help" />
            <p id="room-message-help">1 à {MESSAGE_MAX_LENGTH} caractères, sans être vide.</p>
            <button type="submit" disabled={!current || sending || !isMessageContent(draft)}>{sending ? 'Envoi en cours…' : 'Envoyer'}</button>
        </form>
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
    return <main><h1>UBO Relay Chat</h1>{content}<Link to="/rooms">Retour aux salons</Link></main>;
}
```

**`src/features/messages/useMessagePolling.ts`**

```typescript
import {useCallback, useEffect, useRef} from 'react';
import {useDispatch, useSelector, useStore} from 'react-redux';
import type {AppDispatch, RootState} from '../../app/store';
import {fetchMessages} from './messagesSlice';
import {fetchRoomMessages} from '../rooms/roomMessagesSlice';

export const MESSAGE_POLL_DELAY_MS = 8000;

export function useMessagePolling(recipientId: number, kind: 'private' | 'room' = 'private') {
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
        let request: ReturnType<ReturnType<typeof fetchMessages>> | ReturnType<ReturnType<typeof fetchRoomMessages>> | undefined;

        const conversation = () => {
            const state = store.getState();
            return kind === 'room' ? {id: state.roomMessages.roomId, readStatus: state.roomMessages.readStatus}
                : {id: state.messages.userId, readStatus: state.messages.readStatus};
        };

        const current = () => !disposed && store.getState().auth === auth
            && conversation().id === recipientId;
        const available = () => current() && document.visibilityState !== 'hidden' && navigator.onLine !== false;
        const clearTimer = () => { clearTimeout(timer); timer = undefined; };
        const schedule = () => {
            clearTimer();
            if (available()) timer = setTimeout(() => { void run(); }, MESSAGE_POLL_DELAY_MS);
        };
        const run = async () => {
            clearTimer();
            if (!available() || running) return;
            if (conversation().readStatus === 'loading') {
                // Une lecture équivalente existe déjà : attendre sa fin via l'abonnement.
                waitingForRead = true;
                return;
            }
            waitingForRead = false;
            running = true;
            interrupted = false;
            resumeAfterFlight = false;
            request = kind === 'room' ? dispatch(fetchRoomMessages(recipientId)) : dispatch(fetchMessages(recipientId));
            await request; // Un thunk RTK retourne une action, même en cas d'échec.
            request = undefined;
            running = false;
            if (!available()) return;
            if (resumeAfterFlight) {
                resumeAfterFlight = false;
                void run();
            } else if (conversation().readStatus === 'loading') waitingForRead = true;
            else schedule();
        };
        const unsubscribe = store.subscribe(() => {
            if (!current()) {
                clearTimer();
                request?.abort();
                return;
            }
            if (running) return;
            if (conversation().readStatus === 'loading') {
                clearTimer();
                waitingForRead = true;
            } else if (waitingForRead) {
                waitingForRead = false;
                // Une lecture annulée pendant le nettoyage StrictMode ne retarde pas le remontage.
                if (conversation().readStatus === 'idle') void Promise.resolve().then(run);
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
    }, [recipientId, kind, auth, dispatch, store]);

    return useCallback(() => refresh.current(), []);
}
```

**`src/app/store.ts`**

```typescript
import {configureStore} from "@reduxjs/toolkit";
import authReducer from "../features/auth/authSlice";
import usersReducer from "../features/users/usersSlice";
import messagesReducer from "../features/messages/messagesSlice";
import roomsReducer from "../features/rooms/roomsSlice";
import roomMessagesReducer from "../features/rooms/roomMessagesSlice";

export const store = configureStore({
    //Ici, authReducer est le reducer global du slice, généré automatiquement par createSlice. Il sait traiter toutes les actions de ce slice.
    // c est pour cette raison que il est en singulier et dans le slice en pleural
    reducer: {
        auth: authReducer,
        users: usersReducer,
        messages: messagesReducer,
        rooms: roomsReducer,
        roomMessages: roomMessagesReducer,
    },
});

// pour exporter le type ( pour le typescript)

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
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
import {RoomsPage} from './pages/RoomsPage';
import {RoomPage} from './pages/RoomPage';

function App() {

  return (
      <Routes>
          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route element={<ProtectedRoute />}>
              <Route path="/messages" element={<MessagesPage />} />
              <Route path="/messages/user/:userId" element={<ConversationPage />} />
              <Route path="/rooms" element={<RoomsPage />} />
              <Route path="/rooms/:roomId" element={<RoomPage />} />
          </Route>
          <Route path="*" element={<NotFoundPage />} />
      </Routes>
  );
}

export default App;
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
            <Link to="/rooms">Salons de discussion</Link>
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

**`vercel.json`**

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "functions": {
    "api/rooms.js": {
      "includeFiles": "node_modules/@vercel/postgres/dist/**"
    },
    "api/room-messages.js": {
      "includeFiles": "node_modules/@vercel/postgres/dist/**"
    },
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

