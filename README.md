# Boutique ARAFA TECHNOLOGIE

Site e-commerce autonome : boutique publique, paiement automatique (Moneroo), paiement à la livraison, suivi de commande et administration (`/admin`). Une seule application Node.js avec une base SQLite (un seul fichier `data.db`).

## 1. Prérequis
- Un serveur (VPS Linux) ou un hébergement qui accepte Node.js, version 20.6 ou plus
- Un nom de domaine avec HTTPS (obligatoire pour les paiements)

## 2. Installation
```bash
cd arafa-boutique
npm install
cp .env.example .env      # puis remplissez .env
npm start
```
Ouvrez `http://localhost:3000` (boutique) et `http://localhost:3000/admin` (administration).

Dans `.env`, renseignez au minimum : `BASE_URL`, `SESSION_SECRET`, `ADMIN_PASSWORD`, `WHATSAPP`.

## 3. Activer le paiement automatique (Moneroo)
1. Créez un compte marchand sur moneroo.io et finalisez la vérification (KYC) de l’entreprise.
2. Dans le tableau de bord Moneroo, récupérez la **clé secrète** : mettez-la dans `MONEROO_SECRET_KEY`.
3. Ajoutez un webhook vers `https://VOTRE-DOMAINE/api/webhooks/moneroo`, cochez les événements `payment.success`, `payment.failed` et `payment.cancelled`, choisissez un secret de signature et mettez-le dans `MONEROO_WEBHOOK_SECRET`.
4. Vérifiez dans Moneroo quels moyens sont activés pour la Guinée (GNF) sur votre compte, notamment MTN MoMo et Orange Money.
5. Testez d’abord en mode test avec une petite commande, puis passez en production.

Sans clé Moneroo, la boutique fonctionne quand même avec le paiement à la livraison uniquement.

Fonctionnement : le client est redirigé vers la page de paiement Moneroo, paie avec son compte Mobile Money, puis revient sur le site. Le webhook (signature HMAC vérifiée) confirme le paiement, le serveur re-vérifie le paiement auprès de Moneroo et compare le montant avant de passer la commande en « Payé ». Si le paiement échoue, le stock est remis automatiquement.

## 4. Mise en ligne sur un VPS (exemple Ubuntu)
```bash
sudo npm i -g pm2
pm2 start npm --name boutique -- start
pm2 save && pm2 startup
```
Placez Nginx devant (reverse proxy vers le port 3000) puis activez HTTPS gratuit :
```bash
sudo apt install nginx certbot python3-certbot-nginx
sudo certbot --nginx -d votre-domaine.com
```

## 5. Sauvegardes (important)
Toutes les données sont dans `data.db`. Copiez ce fichier chaque jour (cron + copie vers un autre serveur ou un stockage cloud). Sans sauvegarde, une panne de disque efface vos commandes.

## 6. Utilisation de l’administration (`/admin`)
- **Tableau de bord** : commandes du jour, chiffre d’affaires encaissé, montants à encaisser, stock faible
- **Commandes** : changer le statut (nouvelle, confirmée, préparation, livraison, livrée, annulée), marquer payé, noter, contacter le client sur WhatsApp, exporter en CSV. L’annulation remet le stock à jour
- **Produits** : ajouter, modifier, masquer, supprimer. Pour les photos, déposez les images dans `public/img/` et indiquez `/img/nom.jpg`
- **Livraison** : communes et frais
- **Sécurité** : changer le mot de passe

## 7. Pas encore inclus
Envoi automatique de SMS ou d’e-mails, upload de photos depuis l’admin, comptes clients, remboursements automatiques, plusieurs administrateurs, codes promo.
