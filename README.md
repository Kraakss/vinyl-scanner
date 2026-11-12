# Vinyl Scanner

Application web (PWA) pour identifier ses vinyles avec Discogs : scan du code-barres, saisie du numéro de catalogue ou photo du numéro (lecture du texte sur le téléphone). Affiche la fiche du disque, les prix en euros et un indicateur de rareté.

**Appli en ligne :** https://kraakss.github.io/vinyl-scanner/

---

## Guide rapide

### 1. Installer l'appli sur le téléphone
Ouvre le lien ci-dessus sur ton téléphone, puis :
- **Android (Chrome)** : menu **⋮** → **Ajouter à l'écran d'accueil** (ou **Installer l'application**).
- **iPhone (Safari obligatoirement)** : bouton **Partager** (carré avec flèche) → **Sur l'écran d'accueil** → **Ajouter**.

L'icône « Vinyles » apparaît ; l'appli s'ouvre en plein écran comme une vraie appli.

### 2. Ajouter ton jeton Discogs (une seule fois)
1. Sur discogs.com, connecte-toi puis va dans **Paramètres → Développeurs** : https://www.discogs.com/settings/developers
2. Touche **Générer un nouveau jeton**, puis copie-le.
3. Dans l'appli : onglet **Réglages** → colle le jeton → **Enregistrer**. Le message « ✓ Jeton valide » confirme.

Le jeton reste uniquement sur ton téléphone (il n'est jamais dans le code ni sur GitHub).

**Facultatif, pour avoir les prix suggérés par état (M, NM, VG+…)** : Discogs ne les donne qu'aux comptes qui ont rempli leurs paramètres vendeur : https://www.discogs.com/settings/seller/ (choisis la devise **EUR**). Pas besoin de vendre quoi que ce soit.

### 3. Les trois façons de chercher
- **Scanner** : « Démarrer la caméra », autorise la caméra, vise le code-barres au dos de la pochette. La recherche part toute seule. Si ça ne lit pas : « Scanner depuis une photo », ou tape les chiffres.
- **N° cat.** : tape le numéro de catalogue (ex. `PB 41447`), ajoute l'artiste ou le label si trop de résultats.
- **Photo** : photographie le numéro de catalogue de près. Le texte est lu sur le téléphone (la 1re fois, ~5 Mo sont téléchargés). Touche le numéro proposé ou corrige-le, puis « Rechercher ».

S'il y a plusieurs pressages, une liste (pochette, pays, année, label, format) te permet de choisir le bon.

### 4. Importer ta collection Record Scanner
1. Dans Record Scanner, exporte ta collection en CSV et enregistre le fichier sur le téléphone (Fichiers / Téléchargements).
2. Dans l'appli : **Réglages → Importer depuis Record Scanner → Choisir le fichier CSV**.
3. Un résumé s'affiche : X importés, X doublons, X erreurs.

Le fichier est lu sur le téléphone et n'est envoyé nulle part (ni sur GitHub, ni ailleurs). Tu peux réimporter un export plus récent : les disques déjà présents ne sont pas dupliqués, et tes notes et états ne sont pas écrasés. Un même disque présent deux fois devient un seul disque avec une quantité de 2.

### 5. Alerte « déjà dans ma collection »
Quand tu ouvres la fiche d'un vinyle (scan, n° cat. ou photo), elle est comparée à ta collection :
- **bandeau rouge** : tu as déjà ce vinyle, dans la même version (avec la quantité) ;
- **bandeau orange** : tu as déjà cet album, mais dans une autre version. Tes versions sont listées (pays, année, label, n° cat.) et tu peux toucher chacune pour l'ouvrir ;
- **pastille verte** : tu ne l'as pas.

S'il y a plusieurs versions, la liste de choix affiche le même bandeau, et la version que tu possèdes porte la mention **Possédé**.

La comparaison utilise le *master* Discogs, c'est-à-dire l'identifiant commun à toutes les versions d'un même album. Pour les disques importés, l'appli le récupère tout doucement en arrière-plan (30 requêtes par minute au maximum, seulement quand l'appli est ouverte), et aussi pendant « Actualiser les prix ». Tant qu'il n'est pas connu, ou si l'album n'a pas de master, l'appli compare l'artiste et le titre (sans accents, majuscules ni ponctuation).

### 6. Ma collection
- **Onglet Collection** : tes disques en **liste** ou en **grille** de pochettes, avec la valeur totale. Tu peux chercher (artiste, titre, label, n° de catalogue), trier (valeur, artiste, titre, année, date d'ajout) et filtrer (genre, format, étagère).
- **Sur la fiche d'un vinyle** : « Ajouter à ma collection ». Une fois le disque dans ta collection, tu peux indiquer l'état du disque et de la pochette, l'étagère, la quantité, une note perso, ou le retirer.
- **Stats** (bouton en haut de la collection) : nombre de vinyles, valeur totale et moyenne, top 10 des plus chers, répartition par genre et par décennie.
- **Actualiser les prix** : va chercher le prix le plus bas actuel sur Discogs (en €) et les pochettes de toute la collection. Discogs limite à 60 requêtes par minute : compte environ **20 minutes la première fois** pour 470 disques (il faut aussi récupérer les pochettes), puis environ 10 minutes les fois suivantes. Pendant ce temps, tu peux utiliser l'appli normalement, mais garde-la ouverte. **Pause** / **Reprendre** à tout moment : si l'appli est fermée, elle reprend là où elle s'était arrêtée. Chaque disque affiche l'écart avec son ancienne valeur (▲ / ▼).

La valeur d'un disque, c'est d'abord le prix de Record Scanner, puis le prix le plus bas en vente sur Discogs après chaque actualisation. Si aucun exemplaire n'est en vente, l'ancienne valeur est conservée.

### 7. Sauvegarder
Dans **Réglages → Sauvegarde** :
- **Exporter la collection (CSV pour Excel)** : un tableau lisible dans Excel.
- **Sauvegarde complète (JSON)** : à garder en lieu sûr (Google Drive, e-mail…).
- **Restaurer une sauvegarde JSON** : pour tout récupérer, par exemple sur un nouveau téléphone.

### 8. Lire la fiche
- **Prix le plus bas actuel**, **nombre en vente**, **nombre de membres qui l'ont / le recherchent**.
- **Rareté** : Commun / Peu courant / Rare, calculée à partir de ces chiffres (règles dans `js/rarity.js`).
- **Actualiser les prix** : les fiches sont gardées 12 h, ce bouton force une mise à jour.
- **Historique** : tous les disques consultés, même hors connexion.

---

## Mettre à jour l'appli plus tard
Les fichiers sont dans le dépôt GitHub `vinyl-scanner`. Après une modification :
- soit sur github.com : ouvre le fichier → crayon ✏️ → **Commit changes** ;
- soit depuis le dossier du PC : `git add -A && git commit -m "message" && git push`.

GitHub Pages republie tout seul en 1 à 2 minutes. Sur le téléphone, ferme et rouvre l'appli (avec du réseau) pour récupérer la nouvelle version.

## Structure technique
| Fichier | Rôle |
|---|---|
| `index.html`, `css/style.css` | Écrans et design (mobile, mode sombre) |
| `js/app.js` | Navigation et affichage |
| `js/discogs.js` | Appels à l'API Discogs (jeton, limite de 60 requêtes/min, relance si 429) |
| `js/db.js` | Stockage IndexedDB (fiches + historique), prêt pour la future collection |
| `js/scanner.js` | Lecture code-barres (html5-qrcode, dans `vendor/`) |
| `vendor/papaparse.min.js` | Lecture des fichiers CSV (PapaParse) |
| `js/ocr.js` | Lecture de texte (Tesseract.js, chargé à la demande) |
| `js/rarity.js` | Calcul de la rareté |
| `js/collection.js` | Import Record Scanner, tris, filtres, statistiques, export CSV |
| `js/refresh.js` | Mise à jour des prix de la collection en tâche de fond (reprise possible) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installation et fonctionnement hors ligne |

Pas de serveur ni de proxy : l'API Discogs autorise les appels directs depuis le navigateur (CORS).

### Données stockées (préparation de la collection)
Chaque vinyle consulté est enregistré dans IndexedDB (store `releases`, clé = id Discogs) avec artiste, titre, labels, n° de catalogue, formats, genres, styles, titres, pochette, chiffres communauté, prix (`market`), rareté et `estimatedValue`. Les champs `inCollection` et `collection` (date d'ajout, état, prix d'achat, notes…) sont prévus pour la V2, avec des index sur l'artiste, le titre, le genre et la valeur pour les tris. Une sauvegarde JSON s'exporte depuis **Réglages**.
