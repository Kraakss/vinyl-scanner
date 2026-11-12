# Vinyl Scanner — mes collections

Application web (PWA) pour gérer 4 collections depuis le téléphone : **Vinyles**, **Jeux vidéo**, **DVD** et **Grands Classiques Disney**. On scanne le code-barres (ou on cherche par titre), l'appli affiche la fiche, prévient si l'objet est **déjà dans la collection**, et estime la valeur des vinyles (Discogs) et des jeux (eBay.fr).

**Appli en ligne :** https://kraakss.github.io/vinyl-scanner/

Toutes les données restent sur le téléphone. Les clés secrètes (IGDB, eBay, TMDB) sont uniquement dans ton serveur Cloudflare, jamais dans ce dépôt.

---

## Guide rapide

### 1. Installer l'appli sur le téléphone
Ouvre le lien ci-dessus sur ton téléphone, puis :
- **Android (Chrome)** : menu **⋮** → **Ajouter à l'écran d'accueil** (ou **Installer l'application**).
- **iPhone (Safari obligatoirement)** : bouton **Partager** (carré avec flèche) → **Sur l'écran d'accueil** → **Ajouter**.

### 2. Vinyles : ton jeton Discogs (une seule fois)
1. Sur discogs.com : **Paramètres → Développeurs** (https://www.discogs.com/settings/developers) → **Générer un nouveau jeton** → copie-le.
2. Dans l'appli : **Réglages** → colle le jeton → **Enregistrer** (« ✓ Jeton valide »).

Facultatif, pour les prix par état (M, NM, VG+…) : remplis tes paramètres vendeur Discogs (https://www.discogs.com/settings/seller/, devise **EUR**).

### 3. Jeux vidéo, DVD, affiches Disney : ton serveur gratuit
Ces trois collections passent par un petit serveur gratuit (Cloudflare Worker) qui garde tes clés secrètes. Suis la section **[Configurer le serveur](#configurer-le-serveur)** ci-dessous (environ 30 minutes, une seule fois). Sans serveur, la grille Disney fonctionne quand même, mais sans les affiches ni la reconnaissance automatique des codes-barres.

---

## Utilisation

L'écran d'**Accueil** affiche les 4 collections. Chaque bloc a son bouton **Scanner** et son bouton **Collection**. La barre du bas change selon la collection où tu te trouves (Accueil et Réglages sont toujours là).

### Vinyles (inchangé)
- **Scanner** : code-barres au dos de la pochette.
- **N° cat.** : **« Scanner le n° en direct »**. Place le numéro de catalogue dans le cadre. Les numéros lus apparaissent en boutons ; touche le bon, la recherche Discogs part toute seule. La lampe ⚡ s'affiche si ton téléphone le permet. Tu peux aussi taper le numéro, ou utiliser « Lire le n° sur une photo ».
- **Collection**, **Stats**, **Actualiser les prix** (Discogs), **Historique**, **import Record Scanner** (dans Réglages) : comme avant.
- **Alerte** : bandeau rouge (même version), orange (même album, autre version), vert (pas possédé).

### Jeux vidéo (avec estimation de prix)
- **Scanner** : le code-barres donne le titre du jeu (base gratuite UPCitemdb, sinon eBay), puis l'appli propose les jeux IGDB correspondants. La plateforme est détectée dans le titre du produit ; sinon choisis-la dans la liste sous la caméra.
- **Recherche** : titre + plateforme (obligatoire).
- **Fiche** : jaquette, infos IGDB, puis **complet / loose / neuf**, **état** et **région** (PAL…) → **Ajouter à ma collection**. Le code-barres scanné est mémorisé : la prochaine fois, la fiche s'ouvre directement.
- **Prix** : médiane des annonces **en cours** sur eBay.fr pour ce titre et cette plateforme. Les lots, accessoires, boîtes vides, imports et autres plateformes sont écartés, ainsi que les prix aberrants. L'appli distingue complet / loose / neuf quand il y a assez d'annonces. Tu vois la médiane, la fourchette, le nombre d'annonces utilisées et la date. **Corriger la valeur** permet de la saisir à la main (vide le champ pour revenir à eBay).
- **Collection → Actualiser les prix** : met à jour tous les jeux (environ 40 par minute), avec progression, pause et reprise.
- **Alerte** : rouge (même jeu, même plateforme), orange (même jeu sur une autre plateforme), vert.

### DVD (sans prix)
- **Scanner** ou **Recherche** par titre (films et séries, infos TMDB). Le format est deviné d'après le code-barres (Blu-ray, 4K…).
- **Fiche** : format (DVD, Blu-ray, 4K, 3D, VHS), édition, état → **Ajouter**.
- **Stats** : nombre, répartition par format, par genre et par décennie.

### Disney (Grands Classiques)
- **Classiques** : la grille numérotée. En couleur et en surbrillance ceux que tu as, grisés avec un cadenas ceux qui manquent, « À venir » pour les prochains. En haut : compteur « X / total », barre de progression et filtre **Tous / Possédés / Manquants**.
- **Fiche** (toucher une vignette) : **Je l'ai** / **Je ne l'ai plus**, format, édition, état, note.
- **Scanner** (scan en série, la caméra reste allumée) :
  - code déjà connu → réponse immédiate « **Vous l'avez déjà (n°X)** » ou « **Vous ne l'avez pas — Ajouter** » (un toucher, avec une animation) ;
  - code inconnu → l'appli propose le film probable d'après le titre du produit, sinon tu choisis le numéro dans la liste. Le lien code-barres → film est retenu pour la suite.
- **Nouveau Classique** : voir [Mettre à jour la liste Disney](#mettre-à-jour-la-liste-disney).

### Sauvegardes (Réglages → Sauvegarde)
- Pour chaque collection : **CSV** (tableau Excel) et **JSON** (sauvegarde à restaurer).
- **Sauvegarde complète des 4 collections (JSON)**.
- **Restaurer une sauvegarde JSON** : accepte une sauvegarde complète, celle d'une seule collection, ou une ancienne sauvegarde de la v1.
- **Copie de sécurité des vinyles d'avant la v2** : faite automatiquement lors du passage à la v2.

---

## Configurer le serveur

Il te faut 4 comptes gratuits : **Cloudflare** (le serveur), **Twitch** (pour IGDB, les jeux), **eBay Developers** (prix des jeux) et **TMDB** (films et affiches). Note chaque clé dans un endroit sûr au fur et à mesure.

### Étape 1 — Créer le Worker sur Cloudflare
1. Crée un compte sur https://dash.cloudflare.com/sign-up (gratuit) et confirme ton e-mail.
2. Dans le menu de gauche : **Compute (Workers)** → **Workers & Pages** → **Create** → **Create Worker** (modèle « Hello World »).
3. Nom : `vinyl-scanner-api` → **Deploy**.
4. Clique **Edit code**. Efface tout le code affiché.
5. Ouvre https://github.com/Kraakss/vinyl-scanner/blob/main/worker/worker.js, clique l'icône **Copy raw file** (deux carrés), puis colle le code dans l'éditeur Cloudflare.
6. Clique **Deploy**. Note l'adresse du Worker, du type `https://vinyl-scanner-api.TON-NOM.workers.dev`.
7. Vérification : ouvre cette adresse dans le navigateur. Tu dois voir `{"ok":true,…}`.

### Étape 2 — Clés IGDB (jeux vidéo) via Twitch
1. Crée un compte sur https://www.twitch.tv, puis active la **double authentification** (Paramètres → Sécurité). Twitch l'exige pour les développeurs.
2. Va sur https://dev.twitch.tv/console → **Register Your Application** :
   - Name : `vinyl-scanner-ton-pseudo` (le nom doit être unique)
   - OAuth Redirect URLs : `http://localhost`
   - Category : `Application Integration`
   - Client Type : `Confidential`
3. **Create**, puis **Manage** sur l'application. Copie le **Client ID**. Clique **New Secret** et copie le **Client Secret** (il ne s'affiche qu'une fois).

### Étape 3 — Clés eBay (prix des jeux)
1. Crée un compte sur https://developer.ebay.com (**Register**). La validation peut prendre jusqu'à une journée.
2. **Hi, ton nom → Application Keysets** → crée un keyset **Production** (nom : `vinyl-scanner`).
3. eBay demande de gérer les « Marketplace Account Deletion notifications ». Choisis l'**exemption** : l'appli ne stocke aucune donnée de compte eBay. Dans la page **Alerts & Notifications**, sélectionne *Exempted from Marketplace Account Deletion*, puis la raison *I do not persist eBay data*.
4. Copie l'**App ID (Client ID)** et le **Cert ID (Client Secret)** du keyset **Production**, pas Sandbox.

### Étape 4 — Clé TMDB (DVD et affiches Disney)
1. Crée un compte sur https://www.themoviedb.org/signup.
2. **Paramètres → API** (https://www.themoviedb.org/settings/api) → demande une clé : type **Developer**, usage personnel. Remplis le formulaire simplement (application : « collection personnelle »).
3. Copie le **Jeton d'accès en lecture à l'API** (« API Read Access Token », la longue clé qui commence par `eyJ`).

### Étape 5 — Mettre les clés dans le Worker
Dans Cloudflare → ton Worker `vinyl-scanner-api` → **Settings** → **Variables and Secrets** → **Add**. Pour chaque ligne, choisis le type **Secret** :

| Nom (à recopier exactement) | Valeur |
|---|---|
| `TWITCH_CLIENT_ID` | Client ID Twitch |
| `TWITCH_CLIENT_SECRET` | Client Secret Twitch |
| `EBAY_CLIENT_ID` | App ID eBay (Production) |
| `EBAY_CLIENT_SECRET` | Cert ID eBay (Production) |
| `TMDB_TOKEN` | API Read Access Token TMDB |

Clique **Deploy** (ou **Save**) pour enregistrer.

### Étape 6 — Relier l'appli
Dans l'appli : **Réglages → Serveur des jeux, DVD et Disney** → colle l'adresse du Worker → **Enregistrer et tester**. Les 4 lignes doivent afficher ✓. Une ligne ✗ indique la clé à vérifier.

**Quotas gratuits** :
- Cloudflare : 100 000 requêtes par jour.
- eBay : 5 000 recherches par jour. Les résultats sont gardés 6 h par le Worker.
- IGDB et TMDB : largement suffisants.
- UPCitemdb (reconnaissance des codes-barres) : environ 100 par jour. Au-delà, eBay prend le relais.

**Sécurité** : le Worker n'accepte que les demandes venant de ton appli (`https://kraakss.github.io`). Pour changer ce réglage, ajoute une variable `ALLOWED_ORIGINS`.

---

## Mettre à jour la liste Disney
La liste est dans `data/disney-classiques.json`. Quand un nouveau Grand Classique sort :
1. Sur GitHub, ouvre le fichier → crayon ✏️.
2. Copie la dernière ligne et colle-la en dessous. Mets une virgule à la fin de l'avant-dernière ligne.
3. Change `n` (numéro suivant), `titre`, `annee`, `en` (titre anglais) et `sortie` (date de sortie en France, `AAAA-MM-JJ`).
4. **Commit changes**. Un film dont la date de sortie n'est pas passée s'affiche « À venir » et n'est pas compté.

La liste actuelle compte 64 Classiques (n°1 *Blanche-Neige* → n°64 *Zootopie 2*). Le n°65, *Billie : À la croisée des mondes* (*Hexed*), sort le 25 novembre 2026 : il sera compté automatiquement à partir de cette date.

## Désactiver le scan du n° en direct
Si le scan en direct fonctionne mal sur ton téléphone, ouvre `js/config.js` et mets `LIVE_CATNO = false`. La saisie manuelle et le mode photo restent disponibles. Le code de cette fonction est isolé dans `js/livecatno.js`.

## Mettre à jour l'appli
- sur github.com : ouvre le fichier → crayon ✏️ → **Commit changes** ;
- ou depuis le PC : `git add -A && git commit -m "message" && git push`.

GitHub Pages republie en 1 à 2 minutes. Sur le téléphone, ferme puis rouvre l'appli avec du réseau.

---

## Structure technique
| Fichier | Rôle |
|---|---|
| `index.html`, `css/style.css` | Écrans et design (mobile, mode sombre) |
| `js/app.js` | Navigation, accueil, vinyles, réglages |
| `js/core/ui.js` | Outils d'affichage communs (prix, dates, graphiques, bandeaux) |
| `js/core/media.js` | Section générique Jeux / DVD : scan, recherche, fiche, collection, stats |
| `js/core/backend.js` | Appels au Worker |
| `js/core/job.js` | Tâches de fond avec reprise (mise à jour des prix des jeux) |
| `js/games.js`, `js/games-pricing.js` | Jeux vidéo : IGDB, plateformes, estimation eBay |
| `js/dvd.js` | DVD : TMDB |
| `js/disney.js`, `data/disney-classiques.json` | Grands Classiques Disney |
| `js/livecatno.js`, `js/config.js` | Scan du n° de catalogue en direct (désactivable) |
| `js/discogs.js`, `js/collection.js`, `js/refresh.js`, `js/rarity.js` | Vinyles : Discogs, collection, prix, rareté |
| `js/db.js` | Base IndexedDB (version 2) |
| `js/scanner.js`, `js/ocr.js` | Codes-barres (html5-qrcode) et lecture de texte (Tesseract.js) |
| `worker/worker.js` | Cloudflare Worker (IGDB, eBay, TMDB, codes-barres) |

### Données (IndexedDB `vinyl-scanner`, version 2)
- `releases` + `history` : vinyles et historique. Ils sont **inchangés** depuis la v1.
- `items` : jeux et DVD.
- `disney` : Classiques possédés.
- `barcodes` : codes-barres mémorisés.
- `meta` : cache des affiches.
- `snapshots` : copie de sécurité faite au passage en v2.

La migration v1 → v2 ne fait qu'**ajouter** des espaces de stockage ; elle ne modifie aucun vinyle.
