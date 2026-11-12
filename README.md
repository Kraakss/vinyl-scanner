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

### 4. Lire la fiche
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
| `js/ocr.js` | Lecture de texte (Tesseract.js, chargé à la demande) |
| `js/rarity.js` | Calcul de la rareté |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installation et fonctionnement hors ligne |

Pas de serveur ni de proxy : l'API Discogs autorise les appels directs depuis le navigateur (CORS).

### Données stockées (préparation de la collection)
Chaque vinyle consulté est enregistré dans IndexedDB (store `releases`, clé = id Discogs) avec artiste, titre, labels, n° de catalogue, formats, genres, styles, titres, pochette, chiffres communauté, prix (`market`), rareté et `estimatedValue`. Les champs `inCollection` et `collection` (date d'ajout, état, prix d'achat, notes…) sont prévus pour la V2, avec des index sur l'artiste, le titre, le genre et la valeur pour les tris. Une sauvegarde JSON s'exporte depuis **Réglages**.
