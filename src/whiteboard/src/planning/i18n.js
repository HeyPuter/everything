import { addTranslations } from "../i18n.js";

// Canadian French for every planning string.
addTranslations({
  Tasks: "Tâches",
  tasks: "tâches",
  task: "tâche",
  Task: "Tâche",
  "Task card": "Carte de tâche",
  "Task details": "Détails de la tâche",
  "Task timeline": "Chronologie des tâches",
  "Sticky note with status, owner, and dates":
    "Note adhésive avec statut, responsable et dates",
  "To do": "À faire",
  "In progress": "En cours",
  Blocked: "Bloquée",
  // Core strings already translate these for other uses; a task's status
  // and priority are feminine.
  "task|Done": "Terminée",
  "priority|None": "Aucune",
  "dependency|None": "Aucune",
  "one|{count} done": "{count} terminée",
  "{count} done": "{count} terminées",
  Low: "Basse",
  Medium: "Moyenne",
  High: "Haute",
  Status: "Statut",
  Assignee: "Responsable",
  Unassigned: "Non assignée",
  "On this board": "Sur ce tableau",
  "Not on this board": "Pas sur ce tableau",
  "Not on this board, so they are not notified and cannot open it. Share the board with them first.":
    "Cette personne n’est pas sur ce tableau : elle n’est pas avisée et ne peut pas l’ouvrir. Partagez d’abord le tableau avec elle.",
  Start: "Début",
  Due: "Échéance",
  "Start date": "Date de début",
  "Due date": "Date d’échéance",
  Priority: "Priorité",
  Mixed: "Mixte",
  Frame: "Cadre",
  "No frame": "Aucun cadre",
  Close: "Fermer",
  Jira: "Jira",
  "Jira status": "Statut Jira",
  ID: "ID",
  Yes: "Oui",
  Overdue: "En retard",
  "Blocked by": "Bloquée par",
  Predecessors: "Prédécesseurs",
  "Blocked by other tasks": "Bloquées par d’autres tâches",
  "Make task": "Convertir en tâche",
  "Remove task details": "Retirer les détails de la tâche",
  "Task details added.": "Détails de la tâche ajoutés.",
  "Task details removed.": "Détails de la tâche retirés.",
  "{count} selected object": "{count} objet sélectionné",
  "{count} selected objects": "{count} objets sélectionnés",
  "{count} task": "{count} tâche",
  "{count} tasks": "{count} tâches",
  "Task details apply to every selected sticky note, shape, or text. Each change can be undone.":
    "Les détails de la tâche s’appliquent à chaque note adhésive, forme ou texte sélectionné. Chaque modification peut être annulée.",
  "You can view these task details but not change them.":
    "Vous pouvez consulter ces détails de tâche, mais pas les modifier.",
  "The start date must be on or before the due date.":
    "La date de début doit précéder ou égaler la date d’échéance.",
  "Enter a valid date, with a year from 100 to 9999.":
    "Entrez une date valide, dont l’année va de 100 à 9999.",
  "This selection is protected.": "Cette sélection est protégée.",
  "Select sticky notes, shapes, or text to plan tasks.":
    "Sélectionnez des notes adhésives, des formes ou du texte pour planifier des tâches.",
  "Send to Jira": "Envoyer vers Jira",
  "Send selected tasks to Jira": "Envoyer les tâches sélectionnées vers Jira",
  "Refresh Jira status": "Actualiser le statut Jira",
  "Jira issues created": "Billets Jira créés",
  "Not created": "Non créés",
  "Not sent yet": "Pas encore envoyées",
  "Send to Jira again to create them.":
    "Envoyez de nouveau vers Jira pour les créer.",
  "They are not linked to their tasks because the board was closed, locked, or became read-only.":
    "Ils ne sont pas liés à leurs tâches, car le tableau a été fermé, verrouillé ou est passé en lecture seule.",
  "Not linked because their tasks were deleted or linked by someone else meanwhile":
    "Non liés, car leurs tâches ont été supprimées ou liées par quelqu’un d’autre entre-temps",
  "Jira did not accept the request.": "Jira n’a pas accepté la demande.",
  "Jira refused the integration account. Check its email and API token in Organization settings.":
    "Jira a refusé le compte d’intégration. Vérifiez son adresse courriel et son jeton d’API dans les paramètres de l’organisation.",
  "Jira says": "Selon Jira",
  "Not found in Jira, so not updated":
    "Introuvables dans Jira, donc non mis à jour",
  "Jira status updated": "Statut Jira mis à jour",
  "Jira status is up to date.": "Le statut Jira est à jour.",
  "No tasks are linked to Jira.": "Aucune tâche n’est liée à Jira.",
  "Could not reach Jira.": "Impossible de joindre Jira.",
  "Jira took too long. Send to Jira again to create the rest.":
    "Jira a mis trop de temps. Envoyez de nouveau à Jira pour créer le reste.",
  "Select tasks that are not linked to Jira yet.":
    "Sélectionnez des tâches qui ne sont pas encore liées à Jira.",
  "Select tasks first.": "Sélectionnez d’abord des tâches.",
  "Jira sync is available on organization boards. Share this board on your organization's server to use it.":
    "La synchronisation Jira est offerte sur les tableaux d’organisation. Partagez ce tableau sur le serveur de votre organisation pour l’utiliser.",
  "Join an organization to send tasks to Jira.":
    "Joignez-vous à une organisation pour envoyer des tâches vers Jira.",
  "Jira sync is available to organization members.":
    "La synchronisation Jira est offerte aux membres de l’organisation.",
  "This board is not on your organization's server, so it cannot use the organization's Jira connection.":
    "Ce tableau n’est pas sur le serveur de votre organisation; il ne peut donc pas utiliser la connexion Jira de l’organisation.",
  "Jira is not set up for your organization. Ask an administrator to enable it in organization settings.":
    "Jira n’est pas configuré pour votre organisation. Demandez à un administrateur de l’activer dans les paramètres de l’organisation.",
  "Jira is not set up for your organization.":
    "Jira n’est pas configuré pour votre organisation.",
  "Select items to send to Jira.":
    "Sélectionnez des éléments à envoyer vers Jira.",
  "Tasks are created in your organization's Jira project.":
    "Les tâches sont créées dans le projet Jira de votre organisation.",
  "planning|Summary": "Résumé",
  Completion: "Avancement",
  "Completion (%)": "Avancement (%)",
  "Tasks per assignee": "Tâches par responsable",
  Measure: "Mesure",
  Value: "Valeur",
  Assigned: "Assignées",
  "All statuses": "Tous les statuts",
  Everyone: "Tout le monde",
  "All frames": "Tous les cadres",
  "All tasks": "Toutes les tâches",
  "Group by": "Regrouper par",
  "No grouping": "Aucun regroupement",
  "Sort by": "Trier par",
  "Due date, earliest first": "Échéance, la plus proche d’abord",
  "Due date, latest first": "Échéance, la plus éloignée d’abord",
  "Task name": "Nom de la tâche",
  "Overdue only": "En retard seulement",
  "Blocked only": "Bloquées seulement",
  "{count} task shown": "{count} tâche affichée",
  "{count} tasks shown": "{count} tâches affichées",
  "Showing {shown} of {total} tasks.": "{shown} tâches affichées sur {total}.",
  "Show more tasks": "Afficher plus de tâches",
  "No tasks match these filters.": "Aucune tâche ne correspond à ces filtres.",
  "No tasks yet. Select sticky notes, shapes, or text and choose Task details, or add a task card.":
    "Aucune tâche pour l’instant. Sélectionnez des notes adhésives, des formes ou du texte et choisissez Détails de la tâche, ou ajoutez une carte de tâche.",
  "Show on board": "Afficher sur le tableau",
  "Untitled task": "Tâche sans titre",
  "Planning views": "Vues de planification",
  List: "Liste",
  Timeline: "Chronologie",
  "Timeline chart": "Diagramme chronologique",
  "Task preview": "Aperçu de la tâche",
  Lanes: "Couloirs",
  Lane: "Couloir",
  Days: "Jours",
  to: "au",
  Today: "Aujourd’hui",
  "Show as table": "Afficher sous forme de tableau",
  "Place on board as timeline": "Placer sur le tableau comme chronologie",
  "Timeline placed on the board. Bars link to their tasks.":
    "Chronologie placée sur le tableau. Les barres renvoient à leurs tâches.",
  "It does not update by itself; select it and choose Refresh timeline when tasks change.":
    "Elle ne se met pas à jour d’elle-même; sélectionnez-la et choisissez Actualiser la chronologie quand les tâches changent.",
  "Refresh timeline": "Actualiser la chronologie",
  "Timeline refreshed from the board’s tasks.":
    "Chronologie actualisée à partir des tâches du tableau.",
  "Select a timeline placed from the Tasks view.":
    "Sélectionnez une chronologie placée depuis la vue Tâches.",
  "This dependency would make these tasks wait for each other in a loop, so none of them could start.":
    "Cette dépendance ferait attendre ces tâches les unes les autres en boucle; aucune ne pourrait donc commencer.",
  "Tasks hidden from participants are left out.":
    "Les tâches masquées aux participants sont laissées de côté.",
  "These tasks are hidden from participants, so they are not placed on the board.":
    "Ces tâches sont masquées aux participants; elles ne sont donc pas placées sur le tableau.",
  "Add start or due dates to tasks first.":
    "Ajoutez d’abord des dates de début ou d’échéance aux tâches.",
  "Add start or due dates to tasks to see them on the timeline.":
    "Ajoutez des dates de début ou d’échéance aux tâches pour les voir dans la chronologie.",
  "task has no dates and is not shown.":
    "tâche n’a pas de dates et n’est pas affichée.",
  "tasks have no dates and are not shown.":
    "tâches n’ont pas de dates et ne sont pas affichées.",
  "Use the arrow keys to move between bars. Press Enter to show a task on the board.":
    "Utilisez les touches fléchées pour passer d’une barre à l’autre. Appuyez sur Entrée pour afficher une tâche sur le tableau.",
  "Lines connect tasks to the tasks they block.":
    "Les lignes relient les tâches à celles qu’elles bloquent.",
  "This task is no longer on the board.":
    "Cette tâche n’est plus sur le tableau.",
  "Export CSV": "Exporter en CSV",
  "Export Excel": "Exporter en Excel",
  "Update task status when a task moves into a frame named after a status (Kanban)":
    "Mettre à jour le statut d’une tâche déplacée dans un cadre qui porte le nom d’un statut (Kanban)",
  "Kanban status sync is on for this board.":
    "La synchronisation des statuts Kanban est activée pour ce tableau.",
  "Kanban status sync is off.":
    "La synchronisation des statuts Kanban est désactivée.",
  "Turn on Kanban status sync": "Activer la synchronisation des statuts Kanban",
  "Turn off Kanban status sync":
    "Désactiver la synchronisation des statuts Kanban",
  "Status updated": "Statut mis à jour",
  "Statuses updated": "Statuts mis à jour",
  Dependency: "Dépendance",
  "Start blocks end": "Le début bloque la fin",
  "Start depends on end": "Le début dépend de la fin",
  "Invalid task details.": "Détails de tâche non valides.",
  "Invalid task dependency.": "Dépendance de tâche non valide.",
  "Invalid planning settings.": "Paramètres de planification non valides.",
});
