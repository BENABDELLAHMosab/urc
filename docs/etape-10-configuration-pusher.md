# Étape 10 — Configuration locale de Pusher Beams

## Résultat de cette préparation

Le code de l’étape 10 est conservé. L’Instance ID public fourni est configuré pour Vite et pour les fonctions Node :

```dotenv
PUSHER_INSTANCE_ID=e165f6c1-93d2-4612-8b0f-48a389235223
VITE_PUSHER_INSTANCE_ID=e165f6c1-93d2-4612-8b0f-48a389235223
PUSHER_SECRET_KEY=<valeur privée déjà renseignée localement>
```

Les deux identifiants publics et la clé fournie sont enregistrés dans `.env.local`, à la racine de `urc`. La notation ci-dessus masque volontairement la clé : ne pas recopier ce texte de remplacement dans le fichier. Les autres lignes existantes ont été conservées et les permissions du fichier sont limitées à son propriétaire (0600). Ne pas la copier dans une conversation, un rapport, une capture ou un fichier suivi par Git. Ne pas créer de variable `VITE_PUSHER_SECRET_KEY`.

La configuration locale est renseignée et le SDK serveur s’initialise ; aucune réception réelle n’est encore confirmée. Aucun abonnement réel, envoi de notification, message de test réel, modification du tableau de bord Pusher ou déploiement n’a été effectué.

## Fichiers inspectés et modifications exactes de cette préparation

| Fichier / groupe inspecté | Conclusion et action |
| --- | --- |
| `public/service-worker.js` | Import officiel et clic sécurisé conservés ; aucune modification |
| `api/beams.js`, `lib/session.js` | Authentification Redis/Bearer conservée ; aucune modification de cette finalisation |
| `lib/beams.js` | Ajout du chargement natif de `.env.local` uniquement en développement quand les paramètres serveur Pusher manquent ; import ES du SDK conservé |
| `api/message.js`, `api/room-messages.js` | Publication après stockage privé, aucune publication de groupe ; aucune modification |
| `src/features/notifications/pushController.ts` | Permissions volontaires, TokenProvider et nettoyage conservés ; aucune modification |
| `src/features/notifications/usePushNotifications.ts` | Lecture de `VITE_PUSHER_INSTANCE_ID` conservée ; aucune modification |
| `src/features/notifications/NotificationControls.tsx` | Boutons Activer/Désactiver conservés ; aucune modification |
| `src/pages/MessagesPage.tsx`, `src/features/auth/`, `src/routes/ProtectedRoute.tsx`, `src/user/Login.tsx` | Contrôles, restauration et protection existants conservés ; aucune modification |
| `vercel.json`, `vite.config.ts`, `.gitignore` | Règles de service statique et exclusion Git adéquates ; aucune modification |
| `package.json` | Commande `dev:vercel` de la préparation précédente conservée ; `npx vercel dev` fonctionne désormais aussi grâce au chargement côté serveur |
| `.env.local` | Instance IDs vérifiés et clé fournie enregistrée ; autres lignes conservées, fichier ignoré par Git |
| `.env`, `.vercel/.env.development.local` | Inspectés sans afficher leurs valeurs ; aucune modification |
| `scripts/auth.test.cjs` | Tests ajoutés : développement, production, fichier absent, priorité des variables héritées, marqueur local dev1 et absence de marqueur ; doublure du chargement natif isolée du vrai fichier |
| `scripts/vercel-packaging.test.cjs` | Assertions ajoutées : aucun fichier `.env*` dans le traçage ni dans les artefacts serveur |
| `scripts/notifications-browser.mjs` | Parcours simulé conservé et rejoué, aucune modification |
| `docs/etape-10-notifications.md` | Livrable de l’intégration inspecté ; aucune modification |
| `docs/etape-10-configuration-pusher.md` | Mise à jour du guide après configuration complète |

Les modifications déjà présentes dans le répertoire avant cette préparation appartiennent aux interventions précédentes et sont conservées. Aucune dépendance n’a été réinstallée, aucun lockfile modifié. Redux, les tables PostgreSQL, l’authentification, le polling et le stockage/TTL Redis restent inchangés.

## Particularité de Vercel local et fichiers synchronisés

Le `.env.local` existant porte un en-tête indiquant une génération par Vercel. Il est ignoré par Git, vérifié avec `git check-ignore .env.local`. Son contenu préexistant a été conservé lors de l’ajout des paramètres Pusher.

La CLI Vercel installée lit le fichier `.env` pour ses variables serveur et peut récupérer les variables Development du projet lié. Elle ne charge pas automatiquement `.env.local` de la même manière que Vite. Ajouter uniquement quelques variables dans `.env` peut aussi modifier le choix des variables serveur par cette version de CLI ; ce fichier n’a donc pas été modifié.

La commande facultative ajoutée à la préparation précédente est :

```json
"dev:vercel": "node --env-file=.env.local ./node_modules/vercel/dist/index.js dev"
```

Node charge le fichier dans l’environnement du processus avant le lancement de la CLI. La CLI et ses fonctions héritent de ces paramètres ; Vite reçoit aussi les variables publiques. Cette commande utilise le Vercel déjà installé, sans installation ni déploiement. Elle requiert une version Node prenant en charge `--env-file` ; le Node 22 utilisé pour les vérifications le prend en charge.

La commande demandée est maintenant utilisable directement :

```bash
cd /home/mba-laptop/TP_reacte/urc
npx vercel dev
```

Dans `lib/beams.js`, `process.loadEnvFile('.env.local')` est appelé uniquement lorsque `VERCEL_ENV=development` ou `NOW_REGION=dev1`, hors production, et qu’un paramètre Pusher manque. Les paramètres serveur non vides restent prioritaires ; des emplacements Pusher vides peuvent être complétés. Le chargeur natif conserve les autres valeurs déjà présentes dans l’environnement. En production, ce chargement local est désactivé : utiliser les variables Vercel serveur. Le chargement natif évite de tracer le fichier privé comme une ressource à inclure dans les bundles. Les tests vérifient explicitement cette exclusion. Le Node 22 local prend en charge cette API.

On peut aussi utiliser la commande facultative existante :

```bash
cd /home/mba-laptop/TP_reacte/urc
npm run dev:vercel -- --listen 3000
```

Arrêter auparavant le serveur local existant avec Ctrl+C dans son terminal, afin de libérer 3000. Un redémarrage du serveur reste recommandé après modification de la configuration. `npm run dev` seul ne sert pas les API Vercel. `npx vercel dev` est maintenant pris en charge par le repli local serveur ; l’ancienne limitation est corrigée.

Attention : `vercel env pull` peut réécrire `.env.local`, tandis que `vercel pull` gère les fichiers sous `.vercel`. Aucune synchronisation n’a été lancée ici. Avant une future synchronisation, préserver ses ajouts locaux de manière privée, puis vérifier leur présence sans afficher les valeurs. Si des variables Pusher Development distantes existent plus tard, les maintenir cohérentes avec la configuration locale et vérifier les priorités de la CLI avant de démarrer. Ne pas modifier les variables Neon/Redis pour ajouter Pusher.

Références : [Vercel dev](https://vercel.com/docs/cli/dev), [gestion des variables Vercel](https://vercel.com/docs/cli/env). Le comportement local décrit ci-dessus a aussi été vérifié dans le code de la CLI effectivement installée.

## État des paramètres

| Paramètre | État local après préparation |
| --- | --- |
| `PUSHER_INSTANCE_ID` | Présent ; correspond à l’Instance ID fourni |
| `VITE_PUSHER_INSTANCE_ID` | Présent ; identique au paramètre serveur |
| `PUSHER_SECRET_KEY` | Présente ; valeur privée jamais reproduite |

Les variables Neon, Redis et Vercel préexistantes n’ont pas été remplacées. La clé fournie a été enregistrée uniquement dans le fichier local ignoré ; aucun appel à Pusher ne l’a transmise pendant les vérifications. Aucun secret n’a été ajouté à un fichier suivi par Git.

## Service worker et routes

Le fichier existant importe :

```javascript
importScripts('https://js.pusher.com/beams/service-worker.js');
```

Le dossier `public/` de Vite rend ce fichier accessible à `/service-worker.js` et le copie à la racine de la sortie de compilation. La règle SPA de `vercel.json` exclut les URL de fichiers avec extension : le worker n’est pas réécrit vers `index.html`.

Vérifications HTTP réellement exécutées :

| Serveur | Ressource | Résultat |
| --- | --- | --- |
| Serveur déjà présent sur `http://localhost:3000` | `/service-worker.js` | HTTP 200, type JavaScript, contenu identique à `public/service-worker.js` |
| Serveur déjà présent sur 3000 | `/api/beams` sans session | HTTP 401, code `UNAUTHORIZED` |
| Serveur déjà présent sur 3000 | `/api/message` sans session | HTTP 401, code `UNAUTHORIZED` |
| Serveur déjà présent sur 3000 | Module frontend des notifications | HTTP 200, Instance ID public correct, aucune référence à `PUSHER_SECRET_KEY` |
| Serveur de vérification sur `http://localhost:3001` | Les quatre contrôles précédents | Mêmes résultats |

La commande de vérification Vercel a choisi 3001 car 3000 était occupé. Seul ce serveur de vérification a été arrêté après les contrôles. Le serveur préexistant sur 3000 n’a pas été arrêté ni reconfiguré par cette intervention ; il devra être redémarré avec `npx vercel dev` pour repartir avec la configuration et le code actuels.

Le clic d’une notification reste limité à `/messages/user/<identifiant numérique valide>` sur la même origine ; les autres destinations aboutissent à `/messages`. Le service worker ignore les URL arbitraires du payload. La page passe toujours par `ProtectedRoute`. Si une authentification est nécessaire, le login reprend ensuite la destination privée autorisée.

## Authentification, permissions et envoi conservés

- Le SDK officiel Web est chargé avec l’Instance ID public.
- Le bouton **Activer les notifications** demande la permission uniquement après un clic. Aucun appel automatique à la demande de permission au chargement.
- `start()` puis `setUserId()` associent le navigateur à l’`externalId` de l’utilisateur courant via un TokenProvider authentifié.
- Le provider appelle `/api/beams?user_id=…` avec le Bearer de session URC, conservé hors de Redux et des logs.
- Le backend vérifie la session Redis et exige que `user_id` corresponde à l’identité de cette session. Il signe le format officiel `{token: ...}` ; aucune demande pour une autre identité n’est acceptée.
- La requête est sur la même origine que l’application. Aucun CORS permissif ni `Access-Control-Allow-Origin: *` n’est nécessaire. Le GET avec header Authorization est conservé et les réponses sont `no-store`. La fonction Node utilise l’import ES compatible avec le SDK serveur CommonJS.
- Sans clé serveur, une demande authentifiée Beams répond 503 `PUSH_NOT_CONFIGURED` ; une demande sans session répond d’abord 401. La messagerie peut continuer de fonctionner sans Push.
- Une désactivation, une invalidation de session ou un changement d’identité déclenche le nettoyage SDK avec `stop()`. Les activations obsolètes sont invalidées. Une association existante du même compte peut être reconnue après restauration, sans nouvelle demande de permission.
- Pour les messages privés, Redis doit confirmer le stockage avant `publishToUsers`. Seul le destinataire issu de PostgreSQL est notifié. Le titre et le texte sont génériques et ne contiennent pas le message privé.
- Une panne de publication n’annule pas un message déjà stocké : HTTP 201 reste conservé. Aucun push n’est émis pour les salons.

Aucun appel à `addDeviceInterest('hello')` ou `publishToInterests` n’est ajouté au parcours. L’assistant Pusher sert à vérifier le premier appareil ; il ne faut pas copier son exemple d’abonnement public dans URC.

## Manipulations à faire soi-même dans Pusher Dashboard

1. Ouvrir l’instance Beams correspondant à l’Instance ID public indiqué plus haut et vérifier le parcours Web dans son tableau de bord. La clé fournie est déjà renseignée localement ; aucune nouvelle transmission de clé n’est nécessaire.
2. Ne modifier la clé dans `urc/.env.local` que si elle est remplacée depuis Pusher. Elle doit rester exclusivement dans `PUSHER_SECRET_KEY`, jamais dans une variable `VITE_*` ou un fichier suivi par Git.
3. Revenir à l’assistant **Register your first web device** et sélectionner le parcours Web si demandé. L’URL du worker local est `http://localhost:3000/service-worker.js` ; son contenu est déjà prêt. Ne pas remplacer le worker par l’exemple minimal : cela supprimerait la validation des clics.
4. Démarrer URC avec `npx vercel dev`, puis utiliser le bouton d’activation dans Firefox selon la procédure ci-dessous. C’est ce clic volontaire qui doit enregistrer le premier appareil. Attendre ensuite que l’assistant détecte cet appareil ou utiliser son contrôle de vérification s’il est proposé.
5. Si l’assistant propose de s’abonner à l’intérêt **hello** ou d’envoyer un push d’exemple vers cet intérêt, laisser ces exemples de côté. URC utilise les utilisateurs authentifiés ; vérifier la livraison avec un message privé entre comptes de test.
6. Aucune étape de déploiement n’est requise pour ce test localhost. Les réglages de l’instance sur le site restent à effectuer par l’utilisateur ; ils n’ont pas été consultés ni changés automatiquement.

Références officielles : [intégration Web et onglet Keys](https://pusher.com/docs/beams/getting-started/web/sdk-integration/), [publication pour un utilisateur authentifié](https://pusher.com/docs/beams/guides/publish-to-specific-user/web/). La documentation autorise localhost pour le développement ; les sites distants doivent utiliser HTTPS.

## Tester volontairement l’activation dans Firefox

Cette procédure crée un véritable abonnement uniquement lorsque l’utilisateur décide de cliquer.

1. La clé est déjà renseignée. Arrêter l’ancien serveur et lancer `npx vercel dev`. Vérifier que le terminal annonce bien **localhost:3000** ; si le port est occupé, libérer le serveur concerné soi-même avant de poursuivre.
2. Dans un profil Firefox normal prenant en charge Web Push, ouvrir `http://localhost:3000/service-worker.js` : du JavaScript doit apparaître. Utiliser ensuite exactement l’origine `http://localhost:3000` pour tout le test, sans alterner avec `127.0.0.1` ou le domaine Vercel.
3. Se connecter à un compte URC de test puis ouvrir `/messages`. Le panneau Notifications doit être visible. Le simple chargement de cette page ne doit pas afficher de demande de permission.
4. Cliquer **Activer les notifications** puis accepter la demande Firefox. Attendre **Notifications activées sur ce navigateur**. Si la permission avait été accordée auparavant, Firefox peut ne pas rouvrir le dialogue.
5. Dans l’onglet Réseau, vérifier uniquement le statut de `/api/beams` : HTTP 200 attendu après connexion avec clé valide. Ne pas copier ses headers Authorization ni sa réponse, qui contient un token. Un 401 indique une session à renouveler ; un 503 `PUSH_NOT_CONFIGURED` indique une clé serveur absente ou un serveur non redémarré.
6. Si la permission est refusée, la page l’indique et ne redemande pas en boucle. Pour un nouvel essai, modifier manuellement la permission Notifications du site dans les paramètres Firefox, puis recharger la page. Vérifier aussi les permissions système et le mode Ne pas déranger.
7. Pour annuler le test, cliquer **Désactiver les notifications** sur `/messages`. La désactivation SDK ne révoque pas la permission Firefox : elle désassocie cet appareil. Une réactivation ultérieure peut donc ne pas redemander l’autorisation.

La disponibilité dépend du navigateur et de ses politiques ; éviter les fenêtres privées pour ce premier essai. Ne pas considérer le seul enregistrement du worker comme la preuve d’une association authentifiée réussie.

## Test réel entre deux comptes

Utiliser deux comptes de test existants : Alice et Bob. Employer **deux profils Firefox normaux distincts** (créés depuis `about:profiles`) ou deux navigateurs compatibles. Deux simples onglets du même profil partagent l’appareil Beams et ne constituent pas une isolation fiable entre deux identités.

1. Profil Bob : se connecter à Bob, ouvrir `/messages` et activer volontairement les notifications. Vérifier l’état activé.
2. Profil Alice : se connecter à Alice, ouvrir la conversation privée avec Bob. Alice n’a pas besoin d’activer Push pour envoyer un message.
3. Envoyer volontairement un texte de test non sensible. Vérifier HTTP 201 et l’apparition du message dans la conversation. Vérifier que Bob voit ce message dans sa conversation via le polling lorsqu’elle est ouverte.
4. Observer la notification côté Bob : titre **UBO Relay Chat**, texte **Nouveau message privé.** Aucun texte du message ne doit y figurer. Alice ne doit pas recevoir de notification pour son propre envoi.
5. Cliquer la notification côté Bob : la destination attendue est la conversation avec Alice, sous `/messages/user/<id-Alice>`. Un nouvel onglet peut ne pas disposer du token URC conservé en `sessionStorage` ; il doit alors afficher le login et reprendre la destination seulement après authentification. Cette demande de connexion est compatible avec la protection existante.
6. Avec les comptes de test, vérifier séparément qu’un message dans un salon ne déclenche pas de push. Cela n’abonne personne à un groupe.
7. Désactiver les notifications côté Bob à la fin si cet abonnement de test n’est plus souhaité.

Un navigateur fermé, un système en veille ou une politique système peut retarder ou empêcher l’affichage ; ne pas conclure à une perte du message à partir d’une absence de notification. Si la publication échoue après stockage, le message reste envoyé et la réponse reste 201.

## Vérifications exécutées pendant cette préparation

| Contrôle | Résultat |
| --- | --- |
| `node scripts/auth.test.cjs` | 337 tests réussis, incluant sept tests de chargement local et cinq tests de diagnostic d’échec |
| `node scripts/vercel-packaging.test.cjs` | 8 tests réussis, incluant chargement ES natif et vrais artefacts Vercel isolés |
| TypeScript application : `tsc --project tsconfig.app.json --noEmit --incremental false --pretty false` | Réussi |
| TypeScript configuration : `tsc --project tsconfig.node.json --noEmit --incremental false --pretty false` | Réussi |
| `node scripts/notifications-browser.mjs` | Firefox réel, API et SDK Pusher simulés : réussi |
| Build Vite avec `.env.local` chargé | Réussi ; Instance ID public trouvé dans les chunks, valeur réelle de la clé et nom `PUSHER_SECRET_KEY` absents |
| Build temporaire du test navigateur | Réussi ; copie exacte de `service-worker.js` à la racine vérifiée |
| Chargement natif en mode développement avec variables Pusher initialement absentes | SDK serveur initialisé, Instance ID et clé comparés en mémoire au fichier local, aucune requête Pusher |
| `npx --no-install vercel dev --listen 3000` | CLI installée démarrée sans préchargement manuel de `.env.local` ; repli sur 3001 car 3000 occupé ; HTTP vérifié sur les deux ports |
| `git check-ignore .env.local` | Fichier ignoré |
| Préservation des autres lignes de `.env.local` | Vérifiée avant écriture |
| `git diff --check` | Réussi |

Les tests Node conservent les vérifications d’identité Beams, configuration manquante, permissions, nettoyage, publication privée après stockage, absence de contenu privé, panne Pusher avec réponse 201, absence de push après panne Redis et absence de push de groupe. Le test navigateur remplace le SDK et les API par des simulations : aucune permission réelle ni souscription réelle n’est demandée. Les contrôles HTTP réels sont tous sans session et ne sollicitent aucune publication.

## Blocages et limites restantes

- La clé est présente et le SDK peut s’initialiser localement. Sa validité auprès de Pusher et les réglages du tableau de bord ne sont pas confirmés par les tests simulés : l’authentification Beams réelle reste à vérifier lors du clic volontaire de l’utilisateur.
- Le parcours authentifié réel, l’association sur Pusher et la réception système entre Alice et Bob restent à exécuter par l’utilisateur. Aucun de ces contrôles n’est déclaré réussi ici.
- Le serveur déjà ouvert sur 3000 doit être redémarré après modification des variables serveur. Si une future synchronisation Vercel réécrit `.env.local`, vérifier les paramètres avant de reprendre le test.
- Une expiration de session pendant que la page est fermée ne peut pas lancer le nettoyage navigateur. La déconnexion dans un autre profil/onglet ou une panne réseau ne garantit pas une suppression distante immédiate. Les limites de révocation et de coordination entre onglets décrites dans `etape-10-notifications.md` restent présentes.
- Pas de push de groupe, de file de reprise, de garantie de livraison, de restauration globale supplémentaire ou de changement du stockage. Le polling existant reste nécessaire pour afficher les messages.

Préparation terminée ; attendre le retour de l’utilisateur avant toute autre modification.

## État final de cette finalisation

Fichiers modifiés pour cette demande : `.env.local` (ignoré), `lib/beams.js`, `scripts/auth.test.cjs`, `scripts/vercel-packaging.test.cjs` et ce guide. Les modifications des étapes précédentes restent conservées. Aucun blocage de code identifié dans les contrôles exécutés ; aucune notification réelle n’est encore déclarée reçue.

## Correction du message « non configurées » après activation

Dans la CLI installée, les fonctions de `vercel dev` reçoivent `NOW_REGION=dev1`, alors que `VERCEL_ENV=development` n’est pas systématiquement transmis au même processus. Le chargeur reconnaît maintenant ces deux marqueurs de développement. Une valeur explicite de production (`VERCEL_ENV` ou `NODE_ENV`) interdit toujours la lecture locale.

Vérifications de cette correction : 332 tests applicatifs et 8 tests de chargement/empaquetage réussis. Un contrôle supplémentaire a lancé le vrai `dev-server.mjs` du SDK Node Vercel avec `NOW_REGION=dev1`, sans `VERCEL_ENV` ni variables Pusher héritées : le client serveur a bien été initialisé depuis le fichier local, sans abonnement ni appel réseau Pusher. Le worker de contrôle temporaire a été arrêté et supprimé.

Après correction, arrêter le serveur existant, relancer `npx vercel dev` depuis `urc`, puis effectuer un rechargement complet de Firefox (Ctrl+Maj+R) avant de cliquer à nouveau sur Activer. L’état « non configurées » d’une tentative précédente reste dans le contrôleur frontend jusqu’au rechargement. La réception réelle reste à vérifier par l’utilisateur.

## Diagnostic d’un échec d’activation après configuration

Le texte « Le nettoyage peut avoir échoué » était affiché pour toute erreur du SDK, même lorsque le nettoyage avait réussi. Le contrôleur conserve maintenant uniquement une étape fixe, un statut HTTP reconnu et un indicateur d’échec effectif du nettoyage. L’erreur brute, ses paramètres, les tokens et les données du compte ne sont jamais ajoutés au diagnostic, à Redux ou aux logs.

Les étapes sont : demande de permission, préparation du SDK/service worker, désassociation, enregistrement du navigateur auprès de Pusher, autorisation auprès du serveur URC, puis association du navigateur au compte Pusher. Le panneau affiche la description de l’étape en échec et le statut HTTP éventuel. Il mentionne un échec supplémentaire de désassociation uniquement si le nettoyage de rattrapage a réellement rejeté sa promesse.

Vérifications : 337 tests applicatifs réussis, TypeScript application réussi, parcours Firefox simulé et build Vite réussis, `git diff --check` réussi. Le navigateur simulé reproduit un rejet HTTP 400 de l’enregistrement Pusher, vérifie l’affichage de la bonne étape sans détail fournisseur, puis réussit une nouvelle activation. Le build conserve son avertissement de taille de chunk.

Un GET sans clé ni abonnement sur la configuration Web Push publique de l’instance a répondu HTTP 200. Ce contrôle ne valide ni la clé secrète, ni les permissions Firefox, ni l’association authentifiée ou la livraison de notifications. La cause de l’erreur réelle reste à déterminer avec l’étape et le statut affichés par le nouveau diagnostic, ou la requête en échec dans F12 → Réseau. Ne jamais transmettre le header Authorization ou une réponse contenant un token.

Fichiers concernés par cette amélioration : `pushController.ts`, `usePushNotifications.ts`, `NotificationControls.tsx`, `scripts/auth.test.cjs`, `scripts/notifications-browser.mjs` et ce guide. Aucun abonnement réel ni envoi de notification n’a été déclenché.

## Vérification de l’horloge lors du refus HTTP 401

Les en-têtes fournis pour l’échec montrent un token Beams daté environ 48 secondes après l’heure annoncée dans la réponse Pusher. La vérification locale en mémoire a confirmé que sa signature correspond à la clé du fichier local et que sa durée est de 24 heures. Aucun token ni clé n’est reproduit dans ce guide. Cette vérification ne prouve pas que la clé locale est celle actuellement attendue par Pusher.

Un GET public sans identifiants ni abonnement a confirmé une avance d’environ 49 secondes de l’horloge locale sur le champ Date retourné par Pusher. Ce décalage est une cause possible du refus d’un token considéré comme émis dans le futur. Il faut synchroniser l’horloge de l’ordinateur depuis les paramètres système, redémarrer le serveur local et refaire une activation volontaire afin d’obtenir un nouveau token. Aucune modification de l’horloge système ni décalage artificiel des tokens n’a été appliqué par cette intervention.

Si le 401 persiste après synchronisation, consulter les champs error et description de la réponse à PUT /user chez Pusher, sans copier les en-têtes Authorization ni le token. Le corps de cette erreur reste nécessaire pour distinguer la signature, la validité temporelle et les autres causes possibles. Aucun appel de publication ou d’association n’a été déclenché automatiquement.
