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
  contrat actif. C'est le même compte que celui utilisé pour consulter vos
  factures.
- Un compteur télérelevé. Le SEDIF a généralisé le télérelevé, mais si votre
  compteur ne l'est pas encore, l'espace client n'affiche pas d'historique
  quotidien et l'intégration n'aura rien à importer.
- Vérifiez **avant l'installation** que la page « Historique » de votre espace
  client affiche bien une courbe quotidienne. Si elle est vide côté site, elle
  le sera aussi côté Gladys.

## Configuration

| Champ                              | Rôle                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Origine des relevés**            | Automatique (par défaut) ou fichier CSV déposé. Voir ci-dessous.                                                   |
| **Adresse e-mail**                 | L'identifiant de votre espace client. Inutile en mode fichier déposé.                                              |
| **Mot de passe**                   | Le mot de passe du même compte. Stocké en clair par Gladys — voir « Vos identifiants ».                            |
| **Numéro de contrat**              | À renseigner uniquement si votre compte porte plusieurs contrats. Il figure sur votre facture.                     |
| **Intervalle de rafraîchissement** | Par défaut 6 heures. Le compteur n'étant relevé qu'une fois par jour, il n'y a rien à gagner à descendre plus bas. |
| **Historique à importer**          | Nombre de jours repris lors du premier import. 30 jours par défaut, jusqu'à 3 ans.                                 |
| **Inclure les relevés estimés**    | Désactivé par défaut. Voir « Relevés mesurés et estimés ».                                                         |

Une fois les champs remplis, utilisez le bouton **Tester la connexion** : il se
connecte réellement et vous renvoie le dernier relevé disponible. C'est le moyen
le plus rapide de vérifier vos identifiants.

Le bouton **Réimporter l'historique** oublie le curseur d'import et republie
toute la période configurée. Il sert après un changement de la valeur
« Historique à importer », ou si vous avez supprimé des données dans Gladys.

## Deux façons de récupérer les relevés

Les deux modes produisent exactement le même appareil et les mêmes courbes.

### Automatique — recommandé

L'intégration se connecte à votre espace client et lit son historique. Quelques
requêtes HTTP toutes les six heures : aucun navigateur, quelques mégaoctets de
mémoire, négligeable même sur un Raspberry Pi.

### Fichier CSV déposé

Aucun identifiant : vous téléchargez le fichier depuis l'espace client, vous le
déposez dans le dossier d'import de l'intégration, elle s'occupe du reste.

1. Sur [leaudiledefrance.fr](https://www.leaudiledefrance.fr/), ouvrez la page
   **Historique**, choisissez l'affichage **Litres** puis **Jours**, et cliquez
   sur **Télécharger la période**. Vous obtenez `historique_jours_litres.csv`.
2. Déposez ce fichier dans `/data/import` du conteneur de l'intégration :

   ```bash
   # Repérez le conteneur (son nom contient "sedif")
   docker ps --format '{{.Names}}' | grep sedif

   # Copiez le fichier dedans
   docker cp historique_jours_litres.csv <nom-du-conteneur>:/data/import/
   ```

3. Cliquez sur **Tester la connexion** puis sur **Réimporter l'historique**.

Vous pouvez déposer **plusieurs fichiers** : ils sont tous lus et fusionnés. Un
export de juillet à côté d'un export d'août rallonge simplement l'historique.
Les fichiers ne sont jamais supprimés, et redéposer deux fois le même n'a aucun
effet — le curseur d'import sait déjà ce que Gladys possède.

Choisissez ce mode si vous préférez que rien ne se connecte à votre espace
client sans vous, ou si le mode automatique tombe en panne.

## Délai des données

Les relevés ne sont pas temps réel. Le compteur est télérelevé une fois par jour
et l'exploitant publie la donnée avec **un à deux jours de décalage** :
l'appareil affiche donc la consommation d'avant-hier, pas celle de la minute.
C'est une limite du service, pas de l'intégration.

Chaque relevé est publié dans Gladys **à sa date réelle**, pas à la date de
l'import : votre courbe est donc correctement datée, y compris pour l'historique
repris au premier démarrage.

L'intégration gère elle-même son rythme, sans passer par le mécanisme de
scrutation de Gladys (qui ne descend pas en dessous d'un rafraîchissement par
minute — inadapté à une donnée quotidienne). Un premier relevé a lieu une minute
après le démarrage ou après chaque modification de la configuration, puis à
l'intervalle choisi.

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

Ni le SEDIF ni son exploitant ne publient d'API documentée. L'espace client est
un site Salesforce, et l'intégration parle le même protocole que ses propres
pages : elle se connecte, liste vos contrats, lit le compteur du contrat, puis
demande l'historique quotidien. Ce sont exactement les échanges que fait votre
navigateur quand vous ouvrez la page « Historique ».

**Conséquence à connaître :** ce protocole n'est pas un engagement de
l'exploitant. Une refonte de son espace client peut le changer, et l'intégration
cesserait alors de fonctionner jusqu'à une mise à jour. Le badge de l'appareil
passe en orange et le message d'erreur nomme l'étape qui a échoué. Le mode
« fichier déposé » reste disponible en attendant.

## Vos identifiants

Vos identifiants ne quittent jamais votre installation : ils sont transmis à
l'intégration, qui tourne dans son propre conteneur chez vous, et servent
uniquement à se connecter à `connexion.leaudiledefrance.fr`. Aucun service tiers
n'est contacté.

En revanche, sachez comment ils sont conservés : **Gladys stocke la
configuration des intégrations en clair dans sa base de données**. Le mot de
passe n'est pas chiffré. Le champ est déclaré « secret », ce qui garantit
seulement qu'il n'est jamais renvoyé vers l'interface web — pas qu'il est
protégé sur le disque.

Concrètement, quiconque peut lire la base de données de Gladys, ou une
sauvegarde de celle-ci, peut lire ce mot de passe. D'où deux précautions :

- traitez vos sauvegardes Gladys comme un document contenant un mot de passe ;
- n'utilisez pas ici un mot de passe que vous réutilisez ailleurs.

Si cela vous gêne, le mode **« Fichier CSV déposé »** ne demande aucun
identifiant.

## En cas de problème

- **Identifiants refusés** : vérifiez-les en vous connectant à la main sur le
  site. Un compte peut aussi être temporairement bloqué après plusieurs échecs.
- **« Aucun compteur rattaché au contrat »** : votre compteur n'est
  probablement pas télérelevé, et l'espace client n'a pas d'historique
  quotidien à donner.
- **« Le contrat X ne fait pas partie des contrats actifs »** : le message liste
  les contrats trouvés ; recopiez-en un, ou videz le champ pour prendre le seul
  contrat du compte.
- **Une erreur nommant une classe `LTN...`** : l'exploitant a changé son
  application. C'est le cas qui demande une mise à jour de l'intégration ;
  basculez sur « Fichier CSV déposé » en attendant.
- **Le badge de l'appareil est orange** : soit le dernier relevé a échoué, soit
  l'exploitant n'a rien publié depuis plus de quatre jours. L'infobulle du badge
  donne la raison.
- **La courbe s'arrête net à une date passée** : c'est le comportement attendu
  quand l'exploitant cesse de publier ; les jours manquants seront importés dès
  qu'ils apparaîtront.
