# Suivi de consommation d'eau SEDIF

Cette intégration ajoute à Gladys un appareil « Compteur d'eau SEDIF » qui suit
votre consommation d'eau potable à partir de votre espace client
[leaudiledefrance.fr](https://www.leaudiledefrance.fr/).

Le SEDIF (Syndicat des Eaux d'Île-de-France) est l'autorité organisatrice du
service public de l'eau pour environ 4 millions d'habitants de la banlieue
parisienne ; le service est exploité par Veolia sous la marque « L'Eau
d'Île-de-France ». C'est sur l'espace client de cet exploitant que vos relevés
sont publiés, et c'est donc là que cette intégration va les chercher.

## Ce que vous obtenez

L'appareil créé porte deux mesures, toutes deux historisées (vous pouvez donc en
tracer les courbes et les utiliser dans des scènes) :

| Mesure                       | Unité | Description                                                      |
| ---------------------------- | ----- | ---------------------------------------------------------------- |
| **Index du compteur**        | m³    | Le relevé total du compteur, celui qui figure sur votre facture. |
| **Consommation quotidienne** | L     | Le volume consommé sur la journée.                               |

## Prérequis

- Un compte sur [leaudiledefrance.fr](https://www.leaudiledefrance.fr/), avec un
  contrat actif. Si vous n'en avez pas encore, créez-le sur le site : c'est le
  même compte que celui utilisé pour consulter vos factures.
- Un compteur télérelevé. Le SEDIF a généralisé le télérelevé, mais si votre
  compteur ne l'est pas encore, l'espace client n'affiche pas d'historique
  quotidien et l'intégration n'aura rien à importer.
- Vérifiez **avant l'installation** que la page « Historique » de votre espace
  client affiche bien une courbe quotidienne en litres. Si elle est vide côté
  site, elle le sera aussi côté Gladys.

## Configuration

| Champ                              | Rôle                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Adresse e-mail**                 | L'identifiant de votre espace client.                                                                                  |
| **Mot de passe**                   | Le mot de passe du même compte. Il est chiffré par Gladys et n'est jamais renvoyé vers votre navigateur.               |
| **Numéro de contrat**              | À renseigner uniquement si votre compte porte plusieurs contrats (plusieurs logements). Il figure sur votre facture.   |
| **Intervalle de rafraîchissement** | Par défaut 6 heures. Le compteur n'étant relevé qu'une fois par jour, il n'y a rien à gagner à descendre plus bas.     |
| **Historique à importer**          | Nombre de jours repris lors du premier import. 30 jours par défaut, jusqu'à 3 ans.                                     |
| **Inclure les relevés estimés**    | Désactivé par défaut. Voir « Relevés mesurés et estimés » plus bas.                                                    |
| **URL de la page Historique**      | À laisser vide. Utile seulement si l'exploitant déplace sa page d'historique et que l'intégration ne la retrouve plus. |

Une fois les champs remplis, utilisez le bouton **Tester la connexion** : il se
connecte réellement à l'espace client et vous renvoie le dernier relevé
disponible. C'est le moyen le plus rapide de vérifier vos identifiants avant
d'attendre le premier relevé automatique.

Le bouton **Réimporter l'historique** oublie le curseur d'import et republie
toute la période configurée. Il sert après un changement de la valeur
« Historique à importer », ou si vous avez supprimé des données dans Gladys.

## Délai des données

Les relevés ne sont pas temps réel. Le compteur est télérelevé une fois par
jour et l'exploitant publie la donnée avec **un à deux jours de décalage** :
l'appareil affiche donc la consommation d'avant-hier, pas celle de la minute.
C'est une limite du service, pas de l'intégration.

Chaque relevé est publié dans Gladys **à sa date réelle**, pas à la date de
l'import : votre courbe de consommation est donc correctement datée, y compris
pour l'historique repris au premier démarrage.

L'intégration gère elle-même son rythme de rafraîchissement, sans passer par le
mécanisme de scrutation de Gladys (qui ne descend pas en dessous d'un
rafraîchissement par minute — inadapté à une donnée quotidienne coûteuse à
récupérer). Un premier relevé a lieu une quinzaine de secondes après le
démarrage ou après chaque modification de la configuration, puis à l'intervalle
que vous avez choisi.

## Relevés mesurés et estimés

L'espace client indique pour chaque journée si la valeur a été **mesurée** ou
**estimée**. Une estimation comble un trou entre deux relevés réels, et l'index
qui en résulte peut « reculer » une fois la vraie mesure connue — ce qui produit
des courbes incohérentes et fausse tout calcul de consommation.

Par défaut, l'intégration ignore donc les relevés estimés : une journée sans
mesure réelle est simplement absente de la courbe, et apparaîtra plus tard si
l'exploitant publie la vraie valeur. L'option « Inclure les relevés estimés »
existe si vous préférez une courbe continue à une courbe exacte.

## Comment l'intégration récupère les données

Ni le SEDIF ni son exploitant ne publient d'API pour les données de
consommation. L'espace client est un site Salesforce dont les échanges sont
signés et changent à chaque mise à jour du site.

Cette intégration procède donc comme vous le feriez : elle ouvre un navigateur
sans interface graphique (Chromium), se connecte avec vos identifiants, ouvre la
page « Historique », sélectionne l'affichage en litres par jour, et lit le
fichier CSV que produit le bouton de téléchargement. Le fichier n'est jamais
écrit sur le disque : il est lu directement dans la page.

**Conséquence à connaître :** cette approche dépend de la structure des pages du
site. Si l'exploitant refond son espace client, l'intégration peut cesser de
fonctionner du jour au lendemain, jusqu'à une mise à jour. Le badge de l'appareil
passe alors en orange et les logs de l'intégration (`docker logs`) indiquent
quelle étape a échoué.

## Vos identifiants

Vos identifiants ne quittent jamais votre installation Gladys. Ils sont stockés
chiffrés par Gladys, transmis à l'intégration qui tourne dans son propre
conteneur chez vous, et utilisés uniquement pour se connecter à
`connexion.leaudiledefrance.fr`. Aucun service tiers n'est contacté.

## En cas de problème

- **« Tester la connexion » signale des identifiants refusés** : vérifiez-les en
  vous connectant à la main sur le site. Un compte peut aussi être temporairement
  bloqué après plusieurs échecs.
- **Aucune donnée après plusieurs heures** : ouvrez la page « Historique » de
  votre espace client. Si elle n'affiche pas de courbe quotidienne, votre
  compteur n'est probablement pas télérelevé.
- **Le badge de l'appareil est orange** : soit le dernier import a échoué, soit
  l'exploitant n'a rien publié depuis plus de quatre jours. L'infobulle du badge
  donne la raison.
- **La courbe s'arrête net à une date passée** : c'est le comportement attendu
  quand l'exploitant cesse de publier ; les jours manquants seront importés dès
  qu'ils apparaîtront sur le site.
- **« L'action a échoué. Vérifiez que l'intégration est démarrée. »** : Gladys
  accorde au maximum 120 secondes à un bouton pour répondre. L'intégration
  s'arrête d'elle-même avant cette limite pour vous renvoyer une vraie
  explication ; si vous voyez malgré tout ce message générique, c'est que le
  conteneur ne répond plus du tout — regardez ses logs.

## Charge machine

Ouvrir un navigateur coûte cher : comptez quelques centaines de Mo de mémoire
et plusieurs dizaines de secondes de processeur à chaque relevé. C'est pourquoi
l'intervalle par défaut est de 6 heures et que le minimum est d'une heure.

L'intégration n'ouvre **jamais deux navigateurs à la fois** : si vous cliquez
sur un bouton pendant qu'un relevé automatique tourne, le second refuse de
démarrer et vous le dit. Chaque session a également une durée maximale
au-delà de laquelle le navigateur est tué, pour qu'une page bloquée ne laisse
pas un Chromium tourner indéfiniment.

Si votre machine reste chargée en permanence alors que l'intégration est
installée, arrêtez-la depuis Gladys : la charge doit retomber immédiatement.
Si ce n'est pas le cas, elle vient d'autre chose — la construction de l'image
Docker, par exemple, est bien plus lourde que son exécution.
