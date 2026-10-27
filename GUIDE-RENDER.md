# Publication sur Render

1. Déposez les fichiers de ce dossier dans un dépôt GitHub privé (ne publiez pas .env).
2. Render > New > Web Service > connecter ce dépôt.
3. Runtime Node ; Build Command `npm install` ; Start Command `npm start`.
4. Variables d’environnement (Render > Environment):
   - `NODE_VERSION=22.16.0`
   - `SESSION_SECRET` : secret aléatoire de 32 octets ou plus
   - `ADMIN_PASSWORD` : mot de passe administrateur robuste
   - `BOUTIQUE=ARAFA TECHNOLOGIE`
   - `WHATSAPP=224XXXXXXXXX` : votre numéro réel
   - `BASE_URL=https://VOTRE-SERVICE.onrender.com`
   - `DB_PATH=/var/data/data.db`
   - `FALLBACK_EMAIL_DOMAIN=arafatechnologie.store`
5. Pour ne pas perdre commandes et produits, choisir un service Render payant avec Persistent Disk et monter le disque sur `/var/data`. Ne pas utiliser l'offre gratuite pour les ventes.
6. Tester `/` et `/admin`, puis configurer le domaine personnalisé dans Render et les DNS dans OVH si désiré. Mettre à jour BASE_URL après ce changement.
7. Configurer Moneroo seulement après test complet de la boutique et de la livraison.
