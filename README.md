# NordRen — préparation à la production

Site de réservation de nettoyage : Node.js 24, Express, PostgreSQL, frontend HTML/CSS/JS. Paiement comptant après prestation, sans paiement en ligne.

## État actuel

L'application fonctionne localement avec un backend et une base persistante. Elle n'est pas encore publiée. L'ouverture au public nécessite les informations réelles de l'entreprise, les textes légaux finalisés, un domaine HTTPS, PostgreSQL hébergé et un compte SMTP. `BOOKING_ENABLED=false` par défaut empêche de prendre des réservations avant cette configuration. Les comptes de démonstration ne sont plus acceptés; les anciennes données du navigateur ne sont pas importées ou supprimées.

## Démarrer localement

```powershell
npm ci
Copy-Item .env.example .env
npm run dev
```

Ouvrir http://localhost:5174. Le port 5174 évite de confondre l'ancien serveur de démo et le nouveau backend. Node 24 est requis.

Sans `DATABASE_URL`, le développement utilise PGlite (moteur PostgreSQL embarqué) dans `.data/postgres`. La production exige PostgreSQL externe et n'utilise jamais ce mode. Ne pas lancer deux processus sur le même répertoire PGlite.

En local, `MAIL_MODE=file` enregistre les messages dans `.data/mail/*.json`, sans envoyer d'e-mails. Ces fichiers contiennent des liens de vérification privés; ne pas les partager ni les committer. Pour tester une réservation locale, mettre `BOOKING_ENABLED=true`, redémarrer, créer un compte et ouvrir le lien de vérification de son message local. Les textes légaux restent des brouillons pour les essais uniquement.

## Fonctionnalités

- Inscription, connexion, déconnexion, vérification e-mail et réinitialisation de mot de passe.
- Mots de passe hachés avec scrypt N=131072/r=8/p=1; sessions opaques stockées sous forme de hash; cookies HttpOnly/SameSite et Secure en production.
- Contrôle des rôles et propriétaires côté serveur. Un client ne voit que ses réservations; un agent ne voit que les missions qui lui sont assignées.
- Validation serveur, calcul du prix serveur, contrôle des dates (à partir de demain, un an maximum), zone postale configurable.
- Réservations idempotentes, transactions SQL, journal des changements et file d'e-mails persistante avec reprises.
- Réception des demandes de devis et de contact dans le tableau de bord admin.
- Interface mobile-first dédiée aux clients, agents et administrateurs : barre d'application, navigation inférieure, cartes tactiles et actions adaptées à chaque rôle.
- Manifeste PWA avec mode autonome, couleurs système et icône NordRen. L'installation dépend du navigateur et d'un domaine HTTPS en production.
- Protection CSRF par session et contrôle strict de l'origine, limitation des requêtes en base, CSP sans scripts inline, fichiers publics explicitement autorisés.
- Aucun mot de passe, token de session ou réservation dans localStorage.

Les réservations sont des demandes : un administrateur confirme le créneau. La fréquence choisie n'engendre pas automatiquement une série de rendez-vous. Aucun paiement n'est marqué reçu à la fin d'une prestation : l'administrateur doit le confirmer séparément. Le service ne fournit pas encore de facturation comptable, de gestion automatique de capacité, de SMS ou de MFA.

## Comptes administrateurs et agents

Aucun compte privilégié n'est créé automatiquement. Préparer un fichier JSON privé **hors du projet**, avec `name`, `email`, `phone`, `password` (15 caractères minimum) et `role` (`admin` ou `cleaner`). Vérifier l'identité et l'adresse du collaborateur avant d'utiliser cet outil, qui crée un compte vérifié.

```powershell
npm run staff:create -- C:\chemin-prive\collaborateur.json
```

L'outil refuse un e-mail existant et ne modifie pas un compte existant. Supprimer le fichier contenant le mot de passe après sa remise par un canal sûr. Ne pas mettre de mot de passe dans une ligne de commande ou dans Git. Sur PostgreSQL cet outil peut fonctionner pendant que le serveur tourne; en PGlite, arrêter d'abord le serveur.

## Déploiement

1. Créer une base PostgreSQL dans la région choisie avec sauvegardes et accès restreint. Mettre la connexion dans `DATABASE_URL`. Pour une connexion publique, utiliser TLS avec validation du certificat (`sslmode=verify-full` et la CA du fournisseur si nécessaire); ne pas désactiver la vérification TLS.
2. Copier `.env.example` vers `.env` sur le serveur ou renseigner les secrets dans l'hébergeur. Configurer `NODE_ENV=production`, `APP_ORIGIN=https://votre-domaine`, `HOST=0.0.0.0`, un secret aléatoire `RATE_LIMIT_SECRET`, l'identité légale, les coordonnées et SMTP.
3. Publier les vrais documents dans `public/legal/`. Définir `LEGAL_VERSION` et `LEGAL_APPROVED=true` après validation. Confirmer les prix, taxes, règles d'annulation et zones desservies. Les fichiers DRAFT bloquent le démarrage de production.
4. Créer l'administrateur et les agents. Appliquer `npm run migrate`. Les migrations sont aussi exécutées au démarrage sous verrou.
5. Exécuter `npm run check:production`. Le contrôle vérifie configuration, documents, base, administrateur et connexion SMTP; il n'envoie pas de message. Tester séparément la réception d'un e-mail en staging avec une adresse autorisée et vérifier SPF/DKIM/DMARC auprès du fournisseur.
6. Déployer avec `npm ci --omit=dev` et `npm start`, ou construire le `Dockerfile`. Mettre un reverse proxy HTTPS devant le port interne. Régler `TRUST_PROXY_HOPS` sur le nombre **exact** de proxies de confiance; ne pas rendre l'application directement accessible si elle fait confiance aux en-têtes du proxy.
7. Effectuer un parcours complet en staging, contrôler les permissions et tester une restauration de sauvegarde. Ouvrir ensuite les réservations avec `BOOKING_ENABLED=true`.

`compose.yaml` fournit PostgreSQL 17 et l'application, avec volume persistant et port web lié à localhost. Définir un `POSTGRES_PASSWORD` aléatoire hexadécimal (compatible URL) dans `.env`; le fichier Compose ne publie pas le port de la base. Il faut installer/configurer le proxy HTTPS sur l'hôte. Le démon Docker n'étant pas actif sur cette machine lors de la préparation, la construction et le lancement Docker restent à vérifier sur l'hôte cible.

## Sauvegardes, reprise et exploitation

- Utiliser les sauvegardes chiffrées et la restauration à un instant donné du fournisseur PostgreSQL. Définir leur rétention et les accès selon la politique de l'entreprise.
- Pour une copie manuelle PostgreSQL : utiliser `pg_dump --format=custom --file=<fichier-prive>` avec les variables `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` et un fichier de mots de passe privé. Ne jamais exposer le mot de passe dans les arguments ou les logs.
- Tester `pg_restore --no-owner --dbname=<base-de-restauration-isolee> <sauvegarde>` dans une base distincte. Vérifier utilisateurs, réservations et historique avant tout basculement. Ne pas restaurer directement sur la production sans procédure d'incident.
- Surveiller `/health/live`, `/health/ready`, les erreurs serveur et la file d'e-mails visible par l'admin. Après 10 échecs, un e-mail nécessite une intervention; corriger SMTP puis réinitialiser ses tentatives via une opération DB autorisée. La livraison est au moins une fois : une panne après remise SMTP peut produire un doublon.
- Les sessions expirées, tokens et limites temporaires sont nettoyés chaque heure. Les corps des e-mails livrés sont effacés; leurs métadonnées sont supprimées après sept jours. Les e-mails non livrés restent privés en base pour reprise.
- La rétention des comptes, réservations, messages et audits doit être décidée par l'entreprise avant ouverture. Il n'y a pas de purge commerciale automatique tant que cette durée n'est pas définie. Traiter les demandes d'accès/suppression via une procédure administrative vérifiée, incluant exports, prestataires et sauvegardes.
- Les photos Unsplash et Google Fonts sont encore externes. Déclarer ces connexions dans la politique finale, ou auto-héberger des assets dont les droits sont vérifiés.
- Pour une mise à jour, conserver l'image précédente et une sauvegarde pré-migration. Les migrations sont incrémentales; ne pas supposer qu'une ancienne version accepte une nouvelle structure. Éviter de revenir à l'ancien serveur de démo.

## Vérification

```powershell
npm test
npm audit --omit=dev
npm run check:production
```

Les tests API utilisent une base PostgreSQL isolée en mémoire avec PGlite, ou `TEST_DATABASE_URL` dont le nom de base doit finir par `_test`. **Cette base de test est vidée entre les tests.** Le workflow GitHub Actions utilise PostgreSQL 17 réel. Ce workflow est fourni mais n'a pas été exécuté sur GitHub tant que le projet n'y est pas publié.

Le contrôle production échoue volontairement si les paramètres de publication manquent. Cela ne signifie pas que le serveur local ne fonctionne pas.

Références d'implémentation : [sécurité Express](https://expressjs.com/en/advanced/best-practice-security/), [stockage des mots de passe OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [TLS node-postgres](https://node-postgres.com/features/ssl).

## Notifications, entreprises et itinéraires

La cloche est disponible dans chaque espace connecté. Les notifications restent privées en base et sont transmises en direct pendant que la page est visible (vérification serveur toutes les 2 secondes). Une vérification toutes les 15 secondes sert de secours si la connexion directe est indisponible. Il s'agit de notifications dans l'application, pas de notifications système lorsque l'application est fermée. Une nouvelle réservation informe les administrateurs; sa confirmation et ses changements de statut informent le client; une affectation informe l'agent désigné avec la date, l'heure et l'adresse. Le bouton « Bekræft & tildel team » confirme une nouvelle demande et affecte un agent actif en une seule transaction; une répétition identique ne renvoie pas de notification. Une réclamation du client informe les administrateurs et l'agent actuellement affecté. Le client consulte les réponses depuis « Mine beskeder », et l'administration ou l'équipe depuis « Reklamationer ». Une réaffectation transfère l'accès aux réclamations et signale les dossiers encore ouverts au nouvel agent.

Le choix « Privat / Erhverv » de l'accueil ouvre la présentation des solutions pour entreprises : bureaux, cliniques et grands locaux. Le formulaire accepte des surfaces jusqu'à 100 000 m² et transmet une demande de devis individuel à l'administration, avec une notification. Aucun tarif professionnel fixe ni réservation automatique ne découle de ce formulaire.

L'étape « Adresse & tidspunkt » accepte un lien Google Maps facultatif en plus de l'adresse. Le bouton « Go · Kort & rute » de la mission ouvre une carte dans la même page. L'agent peut autoriser sa position actuelle ou saisir une adresse de départ. Leaflet est hébergé localement; les fonds de carte utilisent OpenStreetMap, la recherche d'adresse Nominatim et les trajets OSRM. Ces services nécessitent Internet. La durée est indicative, sans trafic en direct ni guidage vocal. Les liens Google partagés sont développés uniquement vers des domaines Maps autorisés; si aucune coordonnée ne peut être extraite, l'adresse saisie est recherchée. Le lien original reste accessible pour vérifier le point exact. La position de départ n'est pas enregistrée dans la base.

Les tests utilisent des réponses cartographiques locales pour vérifier les permissions et le trajet sans transmettre de données réelles. Le bouton WhatsApp reste accessible aux visiteurs et clients, et est masqué pour les administrateurs et agents.

## Photos avant / après

Chaque réservation dispose d'un bouton « Før / efter · Billeder » dans les espaces client, admin et agent. Seul l'agent actuellement assigné peut ajouter des photos : « avant » au statut `assigned`, « après » au statut `progress`. Les photos sont verrouillées lorsque la mission est terminée ou annulée. Les anciennes missions restent utilisables sans photos; la présence de photos n'est pas encore une condition obligatoire de changement de statut. Le rapport indique explicitement les catégories manquantes.

L'agent peut choisir une image existante ou utiliser l'entrée caméra sur un téléphone compatible. Renseigner le même nom de pièce et cadrer la même zone facilite la comparaison. Formats : JPEG, PNG, WebP, 8 Mo maximum par fichier, 40 millions de pixels, 8 photos par catégorie. HEIC n'est pas pris en charge : exporter en JPEG. Une photo identique ne peut pas être utilisée à la fois « avant » et « après ». Un nouvel envoi du même fichier dans la même catégorie ne crée pas de doublon.

Les originaux et les aperçus sont conservés dans PostgreSQL (`booking_photos`), hors des fichiers publics : aucune configuration de bucket public ni de disque supplémentaire dans Docker. Une sauvegarde/restauration PostgreSQL inclut donc aussi les photos; dimensionner le stockage et la rétention en conséquence (jusqu'à 128 Mo d'originaux par réservation, plus aperçus). Pour un volume important, prévoir une évolution vers un stockage objet privé avant la montée en charge.

Chaque lecture d'un aperçu ou téléchargement d'un original revérifie la session et l'appartenance au dossier. Le client propriétaire, l'admin et l'agent actuellement assigné peuvent consulter; un agent réassigné perd cet accès. L'API ne permet ni modification ni suppression des photos. Une suppression nécessaire pour la vie privée doit passer par une procédure administrative contrôlée, incluant les sauvegardes, et non par une modification silencieuse du dossier.

Un aperçu JPEG est décodé puis recréé sans métadonnées EXIF. L'original demeure inchangé et peut contenir ses métadonnées d'origine; il est uniquement servi en pièce jointe privée. L'heure affichée est l'heure de réception serveur à Copenhague, pas une preuve de l'heure de prise de vue. Un hash SHA-256 relie l'original au journal d'audit. Cela facilite la revue contradictoire d'une réclamation; ce n'est ni une preuve inviolable face à un administrateur de base, ni une décision automatique contre le client.

Avant mise en service, intégrer la documentation photographique dans les informations client, fixer sa durée de conservation et limiter les prises aux surfaces utiles (éviter personnes, documents et effets privés). Autoriser une taille de requête d'au moins 9 Mo dans le reverse proxy, sans supprimer la limite de 8 Mo contrôlée par l'application. Tester l'entrée caméra sur les téléphones réellement utilisés par l'équipe.

## Teams, disponibilité et mises à jour

- Dans « Konti & kunder », créer un team avec plusieurs comptes actifs. À l'attribution, chaque membre reçoit la réservation, les photos, la carte et les réclamations. La liste des membres est figée pour cette réservation : modifier le groupe ne donne pas accès aux anciennes réservations.
- « Bekræft & tildel team » permet de choisir une personne ou un groupe, avec une durée prévue (120 minutes par défaut, ajustable par l'administrateur). Le serveur verrouille les comptes dans l'ordre et rejette les chevauchements, même lors de deux attributions simultanées et via l'ancien endpoint. Seuls les créneaux assigned/progress occupent le planning. Ce contrôle ne calcule pas les temps de trajet ; les inclure dans la durée planifiée si nécessaire.
- Les listes et compteurs se mettent à jour après un événement de notification. Les formulaires et fenêtres ouverts sont préservés ; le rendu attend leur fermeture. Le bouton « Opdater » reste disponible.

## Notifications téléphoniques

Installer web-push est inclus dans les dépendances. Après achat du domaine/VPS, activer HTTPS puis lancer `node scripts/generate-push-keys.js` une seule fois et renseigner `VAPID_SUBJECT` (adresse mailto réelle ou URL HTTPS de l'entreprise). Les clés restent dans `.env`, jamais dans le dépôt. Les utilisateurs activent les notifications depuis leur profil et accordent la permission sur leur appareil ; iOS demande une PWA installée compatible. Ne pas remplacer les clés lors d'un redéploiement.

Le service worker reçoit les notifications et ouvre l'inbox du rôle connecté. La file persistante retente les erreurs temporaires et supprime les abonnements expirés. Les messages affichés sur l'écran verrouillé restent génériques pour ne pas exposer les adresses clients. La déconnexion/révocation de session retire l'abonnement de cette session. La réception réelle dépend de la permission, de la connexion et des restrictions du système ; les tests automatisés simulent le fournisseur de push sans contacter d'appareil réel.

SMTP, domaine, identité de l'entreprise et validation des textes légaux restent différés à l'achat de l'hébergement, à la demande du propriétaire. Le mode local conserve les e-mails en fichiers de test ; il ne prétend pas livrer aux clients. Le panneau des messages indique ce mode. Les vérifications de production continuent à bloquer une publication incomplète.
