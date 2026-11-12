// Indicateur simple de rareté, calculé à partir des chiffres Discogs :
//   have       = nombre de membres qui possèdent ce pressage
//   want       = nombre de membres qui le recherchent
//   numForSale = nombre d'exemplaires actuellement en vente
//
// Principe : un score de 0 à 100 qui monte quand peu de gens l'ont, quand peu
// d'exemplaires sont en vente, et quand la demande dépasse l'offre.
// Les seuils sont volontairement simples : modifie-les ici si besoin.

export const RARITY_LEVELS = {
  common: { label: 'Commun', hint: 'Facile à trouver' },
  uncommon: { label: 'Peu courant', hint: 'Se trouve, mais pas partout' },
  rare: { label: 'Rare', hint: 'Difficile à trouver' },
};

export function computeRarity({ have = 0, want = 0, numForSale = 0 }) {
  // 1. Possession (40 pts) : moins de 100 propriétaires = très peu répandu.
  const haveScore = have < 100 ? 40 : have < 300 ? 30 : have < 1000 ? 20 : have < 3000 ? 10 : 0;
  // 2. Offre (30 pts) : aucun ou très peu d'exemplaires en vente.
  const saleScore = numForSale === 0 ? 30 : numForSale <= 3 ? 25 : numForSale <= 10 ? 15 : numForSale <= 30 ? 5 : 0;
  // 3. Demande / possession (30 pts) : plus de gens le cherchent que ne l'ont.
  const ratio = want / Math.max(have, 1);
  const demandScore = ratio >= 2 ? 30 : ratio >= 1 ? 22 : ratio >= 0.5 ? 12 : ratio >= 0.25 ? 5 : 0;

  // Si personne ne l'a ni ne le cherche, on manque de données : rester prudent.
  const score = have + want === 0 ? 0 : haveScore + saleScore + demandScore;
  const level = score >= 60 ? 'rare' : score >= 35 ? 'uncommon' : 'common';
  return { level, label: RARITY_LEVELS[level].label, score, ratio: Math.round(ratio * 100) / 100 };
}
