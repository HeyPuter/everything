import { SHAPES } from "./shapes.js";
export let language = "en";
try {
  language = localStorage.getItem("whiteboard-language") === "fr" ? "fr" : "en";
} catch {}
export function setLanguage(value) {
  language = value === "fr" ? "fr" : "en";
  try {
    localStorage.setItem("whiteboard-language", language);
  } catch {}
  document.documentElement.lang = language;
}
// Without a prototype, text such as "constructor" is never a translation.
const pairs = {
  __proto__: null,
  "Move selection": "Déplacer la sélection",
  "In frame": "Dans le cadre",
  Group: "Groupe",
  Contains: "Contient",
  "visible object": "objet visible",
  "visible objects": "objets visibles",
  "Mind map parent": "Parent de la carte mentale",
  "Content language": "Langue du contenu",
  "Whole comment": "Commentaire entier",
  "Selected text": "Texte sélectionné",
  "The comment text changed. Reopen Content language to select the passage again.":
    "Le texte du commentaire a changé. Rouvrez Langue du contenu pour sélectionner à nouveau le passage.",
  "Apply to": "Appliquer à",
  "Language tag": "Code de langue",
  "Selected text or next typed text":
    "Texte sélectionné ou prochain texte saisi",
  "Whole object": "Objet entier",
  "Whole field": "Champ entier",
  "Select complete characters to set their language.":
    "Sélectionnez des caractères entiers pour définir leur langue.",
  "Apply language": "Appliquer la langue",
  "Enter a language tag, such as en, fr-CA, or es. Leave empty to inherit the surrounding language.":
    "Saisissez un code de langue, comme en, fr-CA ou es. Laissez vide pour hériter de la langue environnante.",
  "Enter a valid language tag, such as en or fr-CA.":
    "Saisissez un code de langue valide, comme en ou fr-CA.",
  "Select multiple objects": "Sélectionner plusieurs objets",
  "Turn on Select multiple objects, then click objects to add or remove them. Choose Done to use the selection.":
    "Activez Sélectionner plusieurs objets, puis cliquez sur les objets pour les ajouter ou les retirer. Choisissez Terminé pour utiliser la sélection.",
  "Start horizontal position": "Position horizontale du départ",
  "Start vertical position": "Position verticale du départ",
  "End horizontal position": "Position horizontale de l’arrivée",
  "End vertical position": "Position verticale de l’arrivée",
  "Choose an object for each end, or select Free endpoint and enter its position in board pixels.":
    "Choisissez un objet pour chaque extrémité, ou sélectionnez Extrémité libre et saisissez sa position en pixels du tableau.",
  "The endpoints exceed the board limits. Choose closer positions.":
    "Les extrémités dépassent les limites du tableau. Choisissez des positions plus rapprochées.",
  "Extend selection": "Étendre la sélection",
  "Turn on Extend selection, then click another cell to select a range.":
    "Activez Étendre la sélection, puis cliquez sur une autre cellule pour sélectionner une plage.",
  "Set export region": "Définir la zone d’exportation",
  "Use region": "Utiliser la zone",
  "Enter the top-left position and size of the export region in board pixels.":
    "Saisissez la position du coin supérieur gauche et la taille de la zone d’exportation en pixels du tableau.",
  "Move pin": "Déplacer le repère",
  "Horizontal position": "Position horizontale",
  "Vertical position": "Position verticale",
  "Set the pin position in board pixels.":
    "Définissez la position du repère en pixels du tableau.",
  "This pin moved. Close and reopen Move pin to use its current position.":
    "Ce repère a été déplacé. Fermez et rouvrez Déplacer le repère pour utiliser sa position actuelle.",
  Position: "Position",
  "Horizontal distance": "Distance horizontale",
  "Vertical distance": "Distance verticale",
  "Apply move": "Appliquer le déplacement",
  "Select objects that can be moved.":
    "Sélectionnez des objets qui peuvent être déplacés.",
  "Move exceeds the board limits. Enter a smaller distance.":
    "Le déplacement dépasse les limites du tableau. Saisissez une distance plus petite.",
  "Move the selection and its contents by a distance in board pixels. Positive values move right or down; negative values move left or up.":
    "Déplacez la sélection et son contenu d’une distance en pixels du tableau. Les valeurs positives déplacent vers la droite ou le bas ; les valeurs négatives vers la gauche ou le haut.",
  "Enable letter and symbol shortcuts":
    "Activer les raccourcis avec des lettres et des symboles",
  "Turn off shortcuts such as N, Shift + N, and ? to avoid accidental actions. Ctrl/Cmd and Alt/Option shortcuts remain available. This preference is saved on this device and shared with other open tabs.":
    "Désactivez les raccourcis tels que N, Maj + N et ? pour éviter les actions accidentelles. Les raccourcis Ctrl/Cmd et Alt/Option restent disponibles. Ce réglage est enregistré sur cet appareil et partagé avec les autres onglets ouverts.",
  "Image proportions are too extreme to replace.":
    "Les proportions de l’image sont trop extrêmes pour la remplacer.",
  "Replace image": "Remplacer l’image",
  "Replace from board": "Remplacer depuis le tableau",
  "Upload from device": "Importer depuis l’appareil",
  "Image URL": "URL de l’image",
  "Load image": "Charger l’image",
  "Images on this board": "Images de ce tableau",
  "Find an image": "Rechercher une image",
  "Previous images": "Images précédentes",
  "Next images": "Images suivantes",
  "Replacement preview": "Aperçu du remplacement",
  "Choose a replacement image.": "Choisissez une image de remplacement.",
  "Loading image…": "Chargement de l’image…",
  "Ready to replace. Undo restores the previous image.":
    "Prête à remplacer. Annulez pour restaurer l’image précédente.",
  "This image is already in place.": "Cette image est déjà en place.",
  "No other images on this board.": "Aucune autre image sur ce tableau.",
  "Image replaced. Undo restores it.":
    "Image remplacée. Annulez pour la restaurer.",
  "Replacement closed because the image changed or is no longer editable.":
    "Le remplacement a été fermé car l’image a changé ou ne peut plus être modifiée.",
  "Keep the image’s size, position, rotation, mask, links, and comments. The replacement fills its current area; use Crop image to adjust it.":
    "Conservez la taille, la position, la rotation, le masque, les liens et les commentaires. L’image de remplacement remplit la zone actuelle ; utilisez Recadrer l’image pour l’ajuster.",
  "Enter an HTTP or HTTPS image URL.":
    "Saisissez une URL d’image HTTP ou HTTPS.",
  "This image could not be loaded. Download it and choose Upload from device.":
    "Impossible de charger cette image. Téléchargez-la et choisissez Importer depuis l’appareil.",
  "Loading timed out. Try again or upload from device.":
    "Le chargement a expiré. Réessayez ou importez depuis l’appareil.",
  "Clear content": "Effacer le contenu",
  "Clear content (Ctrl/Cmd Backspace)":
    "Effacer le contenu (Ctrl/Cmd Retour arrière)",
  "Clear content of sticky notes and shapes":
    "Effacer le contenu des notes et des formes",
  "Select sticky notes or shapes to clear.":
    "Sélectionnez des notes ou des formes à vider.",
  "The selected content is already empty.":
    "Le contenu sélectionné est déjà vide.",
  "Content cleared. Undo restores it.":
    "Contenu effacé. Annulez pour le restaurer.",
  "Select object in group": "Sélectionner un objet du groupe",
  "Select whole group": "Sélectionner tout le groupe",
  "Select an object inside a group first.":
    "Sélectionnez d’abord un objet dans un groupe.",
  "Inside group · Double-click to edit · Escape selects the group":
    "Dans le groupe · Double-cliquez pour modifier · Échap sélectionne le groupe",
  "Double-click an object to select it within this group.":
    "Double-cliquez sur un objet pour le sélectionner dans ce groupe.",
  "Lock group": "Verrouiller le groupe",
  "Select a group member or edit the focused object":
    "Sélectionner un membre du groupe ou modifier l’objet actif",
  "Select a group member / whole group":
    "Sélectionner un membre / tout le groupe",
  "Selection settings": "Réglages de sélection",
  "Precise selection": "Sélection précise",
  "Precise selection: enclose at least 90% of each object.":
    "Sélection précise : encadrez au moins 90 % de chaque objet.",
  "Select objects when at least 90% is inside the selection box. Turn off to select touched objects. Tables and mind map nodes always require 90% coverage.":
    "Sélectionnez les objets dont au moins 90 % est dans le cadre de sélection. Désactivez pour sélectionner les objets touchés. Les tableaux et nœuds de carte mentale nécessitent toujours 90 % de couverture.",
  "Hold the mouse or your finger still for a moment, then drag to use precise selection over background objects. Hold Shift while dragging to add to your selection. Escape cancels.":
    "Maintenez la souris ou le doigt immobile un instant, puis faites glisser pour sélectionner précisément par-dessus les objets d’arrière-plan. Maintenez Maj pour ajouter à la sélection. Échap annule.",
  "Filter selection": "Filtrer la sélection",
  "Choose the object type to keep selected.":
    "Choisissez le type d’objet à conserver dans la sélection.",
  "Groups stay together. Frames keep their contents; mind map nodes keep their branches.":
    "Les groupes restent entiers. Les cadres conservent leur contenu et les nœuds de carte mentale leurs branches.",
  "The selection changed. Choose a type again.":
    "La sélection a changé. Choisissez à nouveau un type.",
  "This link is no longer on the board.": "Ce lien n’est plus sur le tableau.",
  "The attachment is still downloading. Try again shortly.":
    "La pièce jointe est encore en cours de téléchargement. Réessayez dans un instant.",
  "These objects are no longer on the board.":
    "Ces objets ne sont plus sur le tableau.",
  "Connection lines": "Lignes de connexion",
  Drawings: "Dessins",
  Images: "Images",
  Tables: "Tableaux de données",
  Links: "Liens",
  Attachments: "Pièces jointes",
  "Mind map nodes": "Nœuds de carte mentale",
  Groups: "Groupes",
  Frames: "Cadres",
  "Object dimensions": "Dimensions des objets",
  "Show dimensions and matching-size guides":
    "Afficher les dimensions et les repères de taille identique",
  "See the selection’s width and height in board pixels. Resize near another object’s width or height to match its size.":
    "Affichez la largeur et la hauteur de la sélection en pixels du canevas. Redimensionnez près de la largeur ou de la hauteur d’un autre objet pour obtenir la même taille.",
  "Matching sizes uses Snap to objects. Hold Alt/Option to bypass snapping. Exact numeric dimensions stay precise.":
    "La correspondance de taille utilise l’alignement sur les objets. Maintenez Alt/Option pour ignorer l’alignement. Les dimensions numériques exactes restent précises.",
  "Grid and snapping": "Grille et alignement",
  "Canvas grid": "Grille du canevas",
  "No grid": "Sans grille",
  "Line grid": "Grille en lignes",
  "Dot grid": "Grille en points",
  "Snap to grid": "Aligner sur la grille",
  "New objects, moves, and resize edges snap to the visible grid. Object alignment guides take priority.":
    "Les nouveaux objets, les déplacements et les bords redimensionnés s’alignent sur la grille visible. Les repères d’alignement des objets sont prioritaires.",
  "Hold Ctrl/Cmd or Alt/Option during a gesture to bypass grid snapping. Keyboard nudges and exact dimensions stay precise.":
    "Maintenez Ctrl/Cmd ou Alt/Option pendant un geste pour ignorer la grille. Les déplacements au clavier et les dimensions exactes restent précis.",
  Follow: "Suivre",
  Following: "Vous suivez",
  "Following you": "Vous suit",
  "one|{count} following you": "{count} vous suit",
  "{count} following you": "{count} vous suivent",
  "Stop following": "Ne plus suivre",
  "Bring to me": "Amener vers moi",
  "Bring everyone to me": "Amener tout le monde vers moi",
  "Live navigation": "Navigation en direct",
  Live: "En direct",
  "Not live yet": "Pas encore en direct",
  "Live cursors off": "Curseurs en direct désactivés",
  "Others’ cursors and changes in progress cannot be shown right now. Their saved edits still appear.":
    "Les curseurs des autres et leurs changements en cours ne peuvent pas être affichés pour le moment. Leurs modifications enregistrées apparaissent toujours.",
  "Board access": "Accès au tableau",
  "Find a participant": "Trouver un participant",
  "Show collaborator cursors": "Afficher les curseurs des collaborateurs",
  "No other participants are on this board.":
    "Aucun autre participant sur ce tableau.",
  "{count} participants": "{count} participants",
  "{name} joined": "{name} a rejoint le tableau",
  "{count} people joined": "{count} personnes ont rejoint le tableau",
  "{name} left": "{name} a quitté le tableau",
  "{count} people left": "{count} personnes ont quitté le tableau",
  "Being edited by {names}": "En cours de modification par {names}",
  "{count} participant": "{count} participant",
  "{count} participants, including you": "{count} participants, vous compris",
  "{count} participant, including you": "{count} participant, vous compris",
  "{count} person": "{count} personne",
  "{count} people": "{count} personnes",
  "Find a person": "Trouver une personne",
  "{name} mentioned you in a comment.":
    "{name} vous a mentionné dans un commentaire.",
  "{count} with new messages": "{count} avec de nouveaux messages",
  "New messages": "Nouveaux messages",
  Someone: "Quelqu’un",
  "Open discussion": "Ouvrir la discussion",
  "Click to add the shape · Drag to draw it at a size":
    "Cliquez pour ajouter la forme · Faites glisser pour la dessiner à la taille voulue",
  "Align and distribute": "Aligner et répartir",
  "Share this board?": "Partager ce tableau ?",
  "Sharing moves this board into your Puter account, so the people you invite can open it and work on it with you. It stays a shared board from then on; Duplicate still makes a personal copy.":
    "Le partage place ce tableau dans votre compte Puter, pour que les personnes invitées puissent l’ouvrir et y travailler avec vous. Il reste ensuite un tableau partagé ; Dupliquer en fait toujours une copie personnelle.",
  "Clear search": "Effacer la recherche",
  "Vertical alignment": "Alignement vertical",
  "Align text top": "Aligner le texte en haut",
  "Align text middle": "Centrer le texte verticalement",
  "Align text bottom": "Aligner le texte en bas",
  "and {count} more": "et {count} autres",
  "Show removed people": "Afficher les personnes retirées",
  "No one matches your search.": "Personne ne correspond à votre recherche.",
  "{count} selected note": "{count} note sélectionnée",
  "{count} selected notes": "{count} notes sélectionnées",
  "{count} tag": "{count} étiquette",
  "{count} tags": "{count} étiquettes",
  "{count} note": "{count} note",
  "{count} notes": "{count} notes",
  "{count} cluster": "{count} regroupement",
  "{count} clusters": "{count} regroupements",
  "{count} extra copy": "{count} copie supplémentaire",
  "{count} extra copies": "{count} copies supplémentaires",
  "{count} guide": "{count} guide",
  "{count} guides": "{count} guides",
  "No participants match your search.":
    "Aucun participant ne correspond à votre recherche.",
  "Invited you to follow": "Vous invite à suivre sa vue",
  Presenting: "Présente",
  "Others are following": "D’autres suivent",
  Dismiss: "Fermer",
  "Follow a participant’s view. Pan, zoom, click the board, or press Escape to stop.":
    "Suivez la vue d’un participant. Déplacez la vue, zoomez, cliquez sur le tableau ou appuyez sur Échap pour arrêter.",
  "Cannot follow a circular chain.":
    "Impossible de suivre une chaîne circulaire.",
  "Following stopped because the live view is unavailable.":
    "Le suivi est arrêté car la vue en direct est indisponible.",
  "Following stopped to avoid a loop.":
    "Le suivi est arrêté pour éviter une boucle.",
  "Asked participants to follow you.":
    "Les participants ont été invités à vous suivre.",
  "Asked {name} to follow you.": "Demande de vous suivre envoyée à {name}.",
  "A live connection is needed to bring participants to your view.":
    "Une connexion en direct est nécessaire pour amener les participants vers votre vue.",
  "Could not send the follow request. Try again.":
    "Impossible d’envoyer la demande de suivi. Réessayez.",

  "Workshop timer": "Minuteur d’atelier",
  Timer: "Minuteur",
  Minimize: "Réduire",
  "Time remaining": "Temps restant",
  Minutes: "Minutes",
  Seconds: "Secondes",
  min: "min",
  "Start timer": "Démarrer",
  "Pause timer": "Mettre en pause",
  "Resume timer": "Reprendre",
  "Reset timer": "Réinitialiser",
  "Play a chime on this device": "Jouer un son sur cet appareil",
  "Invalid workshop timer.": "Minuteur d’atelier non valide.",
  "The timer can run for up to 24 hours.":
    "Le minuteur peut durer jusqu’à 24 heures.",
  "Set a timer from 1 second to 24 hours.":
    "Réglez une durée de 1 seconde à 24 heures.",
  "Time’s up.": "Le temps est écoulé.",
  Ready: "Prêt",
  "Counting down": "Décompte en cours",
  Paused: "En pause",
  "The timer is shared with everyone on this board. Editors can control it.":
    "Le minuteur est partagé avec tout le monde sur ce tableau. Les éditeurs peuvent le contrôler.",
  "The timer keeps counting when minimized or when you leave this board.":
    "Le décompte continue quand le minuteur est réduit ou que vous quittez ce tableau.",

  "selected note": "note sélectionnée",
  tag: "étiquette",
  Tags: "Étiquettes",
  tags: "étiquettes",
  Tag: "Étiquette",
  "All tags": "Toutes les étiquettes",
  "Tag name": "Nom de l’étiquette",
  "Tag color": "Couleur de l’étiquette",
  "Current color": "Couleur actuelle",
  "Create tag": "Créer une étiquette",
  "Edit tag": "Modifier l’étiquette",
  "Save tag": "Enregistrer l’étiquette",
  "Search tags": "Rechercher des étiquettes",
  "No matching tags.": "Aucune étiquette correspondante.",
  "No matching tags. Press Enter to create “{name}”.":
    "Aucune étiquette correspondante. Appuyez sur Entrée pour créer « {name} ».",
  "Find tagged notes": "Trouver les notes étiquetées",
  "Delete tag from board": "Supprimer l’étiquette du tableau",
  "selected notes": "notes sélectionnées",
  "This selection is protected.": "Cette sélection est protégée.",
  "This tag changed. Reopen its settings.":
    "Cette étiquette a changé. Rouvrez ses paramètres.",
  "A sticky note can have up to 8 tags.":
    "Une note peut porter jusqu’à 8 étiquettes.",
  "A board can contain up to 1,000 tags.":
    "Un tableau peut contenir jusqu’à 1 000 étiquettes.",
  "Invalid board tag.": "Étiquette de tableau non valide.",
  "Enter a tag name.": "Saisissez un nom d’étiquette.",
  "A tag with this name already exists.":
    "Une étiquette portant ce nom existe déjà.",
  "This tag is also used on content hidden from you.":
    "Cette étiquette sert aussi sur du contenu qui vous est masqué.",
  "Unlock tagged objects before changing this tag.":
    "Déverrouillez les objets étiquetés avant de modifier cette étiquette.",
  "Tags apply to selected sticky notes. Renaming, recoloring, or deleting a tag affects the whole board. Up to 8 tags per note.":
    "Les étiquettes s’appliquent aux notes sélectionnées. Leur nom, couleur et suppression concernent tout le tableau. Jusqu’à 8 étiquettes par note.",
  "Column width": "Largeur des colonnes",
  "Row height": "Hauteur des lignes",
  "Fit columns to text": "Ajuster les colonnes au texte",
  "Fit rows to text": "Ajuster les lignes au texte",
  "Equal column widths": "Uniformiser les largeurs",
  "Equal row heights": "Uniformiser les hauteurs",
  "Resize column": "Redimensionner la colonne",
  "Resize row": "Redimensionner la ligne",
  "Enter a valid row height or column width.":
    "Saisissez une hauteur de ligne ou une largeur de colonne valide.",
  "Collapse branch": "Replier la branche",
  "Expand branch": "Déplier la branche",
  "Mind map branches": "Branches de carte mentale",
  "hidden node": "nœud masqué",
  "hidden comment": "commentaire masqué",
  "hidden nodes": "nœuds masqués",
  "hidden comments": "commentaires masqués",
  "{count} hidden node": "{count} nœud masqué",
  "{count} hidden comment": "{count} commentaire masqué",
  "{count} hidden nodes": "{count} nœuds masqués",
  "{count} hidden comments": "{count} commentaires masqués",
  "hidden in collapsed branches": "masqués dans des branches repliées",
  "Ctrl or Cmd + Enter to finish. Escape to cancel.":
    "Ctrl ou Cmd + Entrée pour terminer. Échap pour annuler.",
  "Moving a child without reassignment, or resizing it, switches to manual layout.":
    "Déplacer un enfant sans le rattacher, ou le redimensionner, active la disposition manuelle.",
  "Add child node": "Ajouter un nœud enfant",
  "Release to attach to": "Relâchez pour rattacher à",
  "Hold Ctrl/Cmd to move without reassigning":
    "Maintenez Ctrl/Cmd pour déplacer sans rattacher",
  "Moving branch without reassigning":
    "Déplacement de la branche sans rattachement",
  "Drag onto another node to move this branch · Hold Ctrl/Cmd to move freely":
    "Glissez sur un autre nœud pour rattacher cette branche · Maintenez Ctrl/Cmd pour déplacer librement",
  "Create mind map branches": "Créer des branches de carte mentale",
  "Add child above": "Ajouter un enfant au-dessus",
  "Add child to the right": "Ajouter un enfant à droite",
  "Add child below": "Ajouter un enfant en dessous",
  "Add child to the left": "Ajouter un enfant à gauche",
  "Add sibling node": "Ajouter un nœud frère",
  "Central idea": "Idée centrale",
  "New idea": "Nouvelle idée",
  "Untitled node": "Nœud sans titre",
  "Unlock “{name}” first: the mind map’s layout moves it.":
    "Déverrouillez d’abord « {name} » : la disposition de la carte mentale le déplace.",
  "Mind map controls": "Options de la carte mentale",
  "Move mind map branch": "Déplacer une branche de carte mentale",
  "Move branch earlier": "Avancer la branche",
  "Move branch later": "Reculer la branche",
  "Select a mind map node first.":
    "Sélectionnez d’abord un nœud de carte mentale.",
  "Layout nodes": "Organiser les nœuds",
  "Branch direction": "Direction des branches",
  "Branch lines": "Lignes des branches",
  "Keep current directions": "Conserver les directions actuelles",
  "Automatically lay out new branches":
    "Organiser automatiquement les nouvelles branches",
  "Find parent node": "Rechercher un nœud parent",
  "Make a separate mind map": "Créer une carte mentale séparée",
  "This mind map changed. Reopen its controls.":
    "Cette carte mentale a changé. Rouvrez ses options.",
  "A branch cannot be moved inside itself.":
    "Une branche ne peut pas être déplacée dans elle-même.",
  "The mind map is too large. Move it closer to the center or split a branch.":
    "La carte mentale est trop grande. Rapprochez-la du centre ou séparez une branche.",
  "Tab adds a child · Enter adds a sibling · Shift+Enter adds a line · Arrow keys navigate nodes":
    "Tab : ajouter un enfant · Entrée : ajouter un frère · Maj+Entrée : nouvelle ligne · Flèches : parcourir les nœuds",

  "Object link": "Lien de l’objet",
  "Edit cell": "Modifier la cellule",
  "Select one table first.": "Sélectionnez d’abord un tableau.",
  "Insert row above": "Insérer une ligne au-dessus",
  "Insert row below": "Insérer une ligne en dessous",
  "Delete selected rows": "Supprimer les lignes sélectionnées",
  "Insert column left": "Insérer une colonne à gauche",
  "Insert column right": "Insérer une colonne à droite",
  "Delete selected columns": "Supprimer les colonnes sélectionnées",
  "Clear cells": "Effacer les cellules",
  "Use latest value": "Utiliser la valeur actuelle",
  "This table is protected.": "Ce tableau est protégé.",
  "This table changed. Reopen its properties before applying these edits.":
    "Ce tableau a changé. Rouvrez ses propriétés avant d’appliquer ces modifications.",
  "Keep at least one row and one column.":
    "Conservez au moins une ligne et une colonne.",
  "Cell draft kept. Reopen the cell to review it.":
    "Brouillon conservé. Rouvrez la cellule pour le vérifier.",
  "This cell changed or is protected. Your draft is kept; copy it or use the latest value.":
    "Cette cellule a changé ou est protégée. Votre brouillon est conservé ; copiez-le ou utilisez la valeur actuelle.",
  "Arrows select cells · Shift extends selection · Enter edits · Tab moves · Escape cancels":
    "Flèches : sélectionner · Maj : étendre · Entrée : modifier · Tab : déplacer · Échap : annuler",
  "Object links": "Liens des objets",
  "Open object link": "Ouvrir le lien de l’objet",
  "Copy link to object": "Copier le lien vers l’objet",
  "Copy link to this object": "Copier le lien vers cet objet",
  "Object link copied.": "Lien de l’objet copié.",
  "Unable to create a link to this object.":
    "Impossible de créer un lien vers cet objet.",
  "No objects found.": "Aucun objet trouvé.",
  "Only people with board access can open this link.":
    "Seules les personnes ayant accès au tableau peuvent ouvrir ce lien.",
  "This link opens a board saved on this device.":
    "Ce lien ouvre un tableau enregistré sur cet appareil.",
  "Click a destination object on the canvas, choose one below, or enter a website URL.":
    "Cliquez sur un objet de destination, choisissez-en un ci-dessous ou saisissez une adresse Web.",
  "Link destination": "Destination du lien",
  "Find destination object": "Rechercher un objet de destination",
  "No object link.": "Aucun lien pour cet objet.",
  "The linked object is no longer on this board.":
    "L’objet lié ne se trouve plus sur ce tableau.",
  "The linked part of the board is not shown yet.":
    "La partie du tableau liée n’est pas encore affichée.",
  "Choose a valid frame.": "Choisissez un cadre valide.",
  "Another board is still being shared. Try again in a moment.":
    "Un autre tableau est encore en cours de partage. Réessayez dans un instant.",
  "Someone locked this object while you were editing it.":
    "Quelqu’un a verrouillé cet objet pendant que vous le modifiiez.",
  "{name} deleted this object while you were editing it.":
    "{name} a supprimé cet objet pendant que vous le modifiiez.",
  "This object was deleted by someone else while you were editing it.":
    "Quelqu’un d’autre a supprimé cet objet pendant que vous le modifiiez.",
  "Copy text": "Copier le texte",
  "Text copied.": "Texte copié.",
  "Could not copy the text.": "Impossible de copier le texte.",
  "This board changed in another tab. Reload to see the latest copy.":
    "Ce tableau a changé dans un autre onglet. Rechargez pour voir la dernière copie.",
  "This board changed in another tab. Your changes here are kept in Version history. Reload to see the latest copy.":
    "Ce tableau a changé dans un autre onglet. Vos modifications ici sont conservées dans l’historique des versions. Rechargez pour voir la dernière copie.",
  "Unsaved changes from another tab":
    "Modifications non enregistrées d’un autre onglet",
  "This board was deleted in another tab.":
    "Ce tableau a été supprimé dans un autre onglet.",
  "Not saved": "Non enregistré",
  "Someone locked this object while you were moving it.":
    "Quelqu’un a verrouillé cet objet pendant que vous le déplaciez.",
  "This object changed. Open it again to edit it.":
    "Cet objet a changé. Rouvrez-le pour le modifier.",
  "This object changed or is protected. Reopen its link settings.":
    "Cet objet a changé ou est protégé. Rouvrez les réglages de son lien.",
  "Choose a different object.": "Choisissez un autre objet.",
  "This board is unavailable on this device. Check your boards or Trash.":
    "Ce tableau n’est pas disponible sur cet appareil. Consultez vos tableaux ou la corbeille.",
  "Go to linked object": "Aller à l’objet lié",
  "Invalid object link.": "Lien d’objet non valide.",

  Comments: "Commentaires",
  Comment: "Commentaire",
  "Comment (C)": "Commentaire (C)",
  "Add comment": "Ajouter un commentaire",
  "Board comments": "Commentaires du tableau",
  "Close comments": "Fermer les commentaires",
  "Search comments": "Rechercher des commentaires",
  "Show comments": "Afficher les commentaires",
  "Open comments": "Commentaires ouverts",
  "Unread comments": "Commentaires non lus",
  "Resolved comments": "Commentaires résolus",
  "All comments": "Tous les commentaires",
  "New comment": "Nouveau commentaire",
  "Show pins": "Afficher les repères",
  Discussion: "Discussion",
  "Write a comment": "Rédiger un commentaire",
  "Write a reply": "Rédiger une réponse",
  "Enter adds a new line · Post comment sends":
    "Entrée ajoute une ligne · Publier le commentaire envoie",
  "Enter to post · Shift+Enter for a new line":
    "Entrée pour publier · Maj+Entrée pour une nouvelle ligne",
  "Cancel edit": "Annuler la modification",
  "Post comment": "Publier le commentaire",
  "Resolve discussion": "Résoudre la discussion",
  "Reopen discussion": "Rouvrir la discussion",
  "Discussion resolved": "Discussion résolue",
  "Discussion reopened": "Discussion rouverte",
  "Comment posted": "Commentaire publié",
  "Reply posted": "Réponse publiée",
  "Comment saved": "Commentaire enregistré",
  "{name} replied": "{name} a répondu",
  "{name} mentioned you": "{name} vous a mentionné",
  "{count} new messages in this discussion":
    "{count} nouveaux messages dans cette discussion",
  "No comments to show.": "Aucun commentaire à afficher.",
  "{count} discussion": "{count} discussion",
  "{count} discussions": "{count} discussions",
  "Deleted comment": "Commentaire supprimé",
  "Comment deleted": "Commentaire supprimé",
  "Edit comment": "Modifier le commentaire",
  "Delete comment": "Supprimer le commentaire",
  "Restore comment": "Restaurer le commentaire",
  "Save comment": "Enregistrer le commentaire",
  Reply: "Répondre",
  Edited: "Modifié",
  Resolved: "Résolu",
  Open: "Ouvert",
  "Draft comment": "Brouillon de commentaire",
  You: "Vous",
  "Show or hide comment pins": "Afficher ou masquer les repères de commentaire",
  "This discussion is no longer available.":
    "Cette discussion n’est plus disponible.",
  "This comment changed. Reopen it before editing.":
    "Ce commentaire a changé. Rouvrez-le avant de le modifier.",
  "This discussion has reached its reply limit.":
    "Cette discussion a atteint sa limite de réponses.",
  "This board has reached its comment limit.":
    "Ce tableau a atteint sa limite de commentaires.",
  "This comment's time is not valid.":
    "L’heure de ce commentaire n’est pas valide.",
  "Only the author can edit this comment.":
    "Seul l’auteur peut modifier ce commentaire.",
  "Invalid comment thread.": "Discussion non valide.",
  "Invalid comment message.": "Commentaire non valide.",
  "Mouse, trackpad, and touch": "Souris, pavé tactile et écran tactile",
  "Navigation mode": "Mode de navigation",
  "Auto-detect": "Détection automatique",
  Mouse: "Souris",
  Trackpad: "Pavé tactile",
  Touch: "Écran tactile",
  "Auto-detect recognizes wheel steps and smooth scrolling. Choose a device if scrolling feels wrong.":
    "La détection automatique distingue la molette du défilement fluide. Choisissez un périphérique si le défilement ne convient pas.",
  "Scroll to zoom. Right-drag, middle-drag, or Space-drag to pan.":
    "Utilisez la molette pour zoomer. Déplacez la vue avec le bouton droit, le bouton central ou Espace enfoncé.",
  "Scroll with two fingers to pan. Pinch or Ctrl/Cmd-scroll to zoom. Shift-scroll pans horizontally.":
    "Faites défiler avec deux doigts pour déplacer la vue. Pincez ou utilisez Ctrl/Cmd et le défilement pour zoomer. Maj et le défilement déplacent la vue horizontalement.",
  "Drag to pan and pinch to zoom. Tap an object to select it, then drag it to move. Hold for a moment, then drag to select several objects. Drawing tools still draw with one finger.":
    "Faites glisser pour déplacer la vue et pincez pour zoomer. Touchez un objet pour le sélectionner, puis déplacez-le. Maintenez le doigt un instant, puis faites glisser pour sélectionner plusieurs objets. Les outils de dessin utilisent toujours un doigt.",
  "This preference is saved on this device and shared with other open tabs.":
    "Cette préférence est enregistrée sur cet appareil et partagée avec les autres onglets ouverts.",

  Minimap: "Mini-carte",
  minimap: "mini-carte",
  "Minimap (M)": "Mini-carte (M)",
  "Close minimap": "Fermer la mini-carte",
  "Fit board": "Afficher tout",
  "Navigate board": "Parcourir le tableau",
  "Zoom in or out": "Zoom avant ou arrière",
  "Fit board / zoom to selection": "Afficher tout / zoom sur la sélection",
  "Click to jump or drag the visible area. Arrow keys pan; plus and minus zoom; Home fits the board; Escape closes the minimap.":
    "Cliquez pour vous déplacer ou faites glisser la zone visible. Les flèches déplacent la vue ; plus et moins changent le zoom ; Début affiche tout ; Échap ferme la mini-carte.",
  "Crop image": "Recadrer l’image",
  "Select one image.": "Sélectionnez une image.",
  "Invalid image crop.": "Recadrage d’image non valide.",
  "This crop exceeds the board size limits.":
    "Ce recadrage dépasse les dimensions maximales du tableau.",
  "This image has no editable area.": "Cette image n’a pas de zone modifiable.",
  "Cropping closed because the image changed or is no longer editable.":
    "Le recadrage a été fermé car l’image a changé ou n’est plus modifiable.",
  "Move crop area": "Déplacer la zone de recadrage",
  "Crop top left": "Recadrer en haut à gauche",
  "Crop top": "Recadrer en haut",
  "Crop top right": "Recadrer en haut à droite",
  "Crop right": "Recadrer à droite",
  "Crop bottom right": "Recadrer en bas à droite",
  "Crop bottom": "Recadrer en bas",
  "Crop bottom left": "Recadrer en bas à gauche",
  "Crop left": "Recadrer à gauche",
  "Reset original": "Rétablir l’original",
  "Aspect ratio": "Proportions",
  Freeform: "Libre",
  Original: "Original",
  Oval: "Ovale",
  Shape: "Forme",
  Left: "Gauche",
  Right: "Droite",
  Up: "Haut",
  Down: "Bas",
  Top: "Haut",
  "Exact crop (pixels)": "Recadrage précis (pixels)",
  "Apply crop": "Appliquer le recadrage",
  pixels: "pixels",
  "Drag the area or its handles. Arrow keys adjust by a pixel; Shift adjusts by ten. Alt/Option bypasses snapping.":
    "Faites glisser la zone ou ses poignées. Les flèches ajustent d’un pixel ; Maj de dix. Alt/Option désactive l’alignement automatique.",
  "Auto height": "Hauteur auto",
  "Automatic text height": "Hauteur automatique du texte",
  "Adjust height to fit the text. Resize to change its width.":
    "Adapter la hauteur au texte. Redimensionnez pour changer sa largeur.",
  "Height adjusts to the text. Change the width to rewrap it.":
    "La hauteur s’adapte au texte. Modifiez la largeur pour changer les retours à la ligne.",
  "Drag the corner horizontally to change text width. Alt/Option bypasses snapping.":
    "Faites glisser le coin horizontalement pour changer la largeur du texte. Alt/Option désactive l’alignement automatique.",
  "Text exceeds the board height limit. Widen the box or split the text into separate boxes.":
    "Le texte dépasse la hauteur maximale du tableau. Élargissez la zone ou répartissez le texte dans plusieurs zones.",
  "Command palette": "Palette de commandes",
  "Command palette (Ctrl/Cmd K)": "Palette de commandes (Ctrl/Cmd K)",
  "Search commands and boards": "Rechercher des commandes et des tableaux",
  "Commands and boards": "Commandes et tableaux",
  "No matching commands or boards. Try another word.":
    "Aucune commande ni aucun tableau correspondant. Essayez un autre mot.",
  "This command is no longer available.":
    "Cette commande n’est plus disponible.",
  "↑ ↓ to navigate · Enter to run · Esc to close":
    "↑ ↓ pour naviguer · Entrée pour exécuter · Échap pour fermer",
  "Keyboard shortcut": "Raccourci clavier",
  "Recent boards": "Tableaux récents",
  Create: "Créer",
  Edit: "Modifier",
  Arrange: "Organiser",
  Navigate: "Naviguer",
  Board: "Tableau",
  Help: "Aide",
  "Zoom to selection": "Zoom sur la sélection",
  "Nothing to undo.": "Rien à annuler.",
  "Nothing to redo.": "Rien à rétablir.",
  "Select shapes, notes, or text boxes.":
    "Sélectionnez des formes, des notes ou des zones de texte.",
  "Select an object with editable text.":
    "Sélectionnez un objet avec du texte modifiable.",
  "Select at least two objects or groups.":
    "Sélectionnez au moins deux objets ou groupes.",
  "Select at least three objects or groups.":
    "Sélectionnez au moins trois objets ou groupes.",
  "Select a group first.": "Sélectionnez d’abord un groupe.",
  "Auto-fit": "Ajustement auto",
  "Auto-fit text": "Ajuster automatiquement le texte",
  "Maximum font size": "Taille maximale de police",
  "Shrink text to fit. The font size is the maximum.":
    "Réduire le texte pour qu’il tienne. La taille de police est le maximum.",
  "Some text does not fit at the minimum size. Enlarge the object or shorten the text.":
    "Une partie du texte ne tient pas à la taille minimale. Agrandissez l’objet ou raccourcissez le texte.",
  "Quick diagram creation": "Création rapide de diagramme",
  "Quick connect top": "Connexion rapide en haut",
  "Quick connect right": "Connexion rapide à droite",
  "Quick connect bottom": "Connexion rapide en bas",
  "Quick connect left": "Connexion rapide à gauche",
  "Click to add a connected object or connect a nearby one. Drag to choose another target. Escape cancels.":
    "Cliquez pour ajouter un objet connecté ou relier un objet proche. Faites glisser pour choisir une autre cible. Échap annule.",
  "Add connected object": "Ajouter un objet connecté",
  "Connect to": "Connecter à",
  "Select one shape, sticky note, or text box.":
    "Sélectionnez une forme, une note adhésive ou une zone de texte.",
  Shapes: "Formes",
  "Shapes (S)": "Formes (S)",
  "Change shape": "Changer de forme",
  Diamond: "Losange",
  Triangle: "Triangle",
  Parallelogram: "Parallélogramme",
  Hexagon: "Hexagone",
  Star: "Étoile",
  Cylinder: "Cylindre",
  Terminator: "Terminaison",
  Process: "Processus",
  "Start or end": "Début ou fin",
  Decision: "Décision",
  "Input or output": "Entrée ou sortie",
  Database: "Base de données",
  Preparation: "Préparation",
  "Basic shape": "Forme simple",
  "Invalid shape.": "Forme non valide.",
  // Board validation, shown when an imported or migrated board is rejected.
  "The board contains an invalid object.":
    "Le tableau contient un objet non valide.",
  "Invalid object rotation.": "Rotation d’objet non valide.",
  "Unsupported image format.": "Format d’image non pris en charge.",
  "Invalid drawing.": "Dessin non valide.",
  "Invalid content language.": "Langue du contenu non valide.",
  "Invalid text highlight.": "Surlignage de texte non valide.",
  "Invalid font family.": "Police non valide.",
  "Invalid font size.": "Taille de police non valide.",
  "Invalid text style.": "Style de texte non valide.",
  "Invalid text color.": "Couleur de texte non valide.",
  "Invalid text alignment.": "Alignement du texte non valide.",
  "Invalid text formatting.": "Mise en forme du texte non valide.",
  "Invalid text list.": "Liste de texte non valide.",
  "Invalid object tags.": "Étiquettes d’objet non valides.",
  "Invalid table.": "Tableau de données non valide.",
  "Invalid table dimensions.": "Dimensions du tableau de données non valides.",
  "Invalid attachment.": "Pièce jointe non valide.",
  "Object dimensions must be positive.":
    "Les dimensions de l’objet doivent être positives.",
  "Invalid object relationship.": "Relation entre objets non valide.",
  "Invalid object lock.": "Verrouillage d’objet non valide.",
  "Invalid frame order.": "Ordre des cadres non valide.",
  "Invalid mind map node.": "Nœud de carte mentale non valide.",
  "Invalid mind map collapse state.":
    "État replié de la carte mentale non valide.",
  "Invalid frame membership.": "Appartenance à un cadre non valide.",
  "Invalid connector.": "Connecteur non valide.",
  "A board can contain at most 5,000 objects.":
    "Un tableau peut contenir au maximum 5 000 objets.",
  "Bulk sticky notes": "Notes adhésives en série",
  "The table is too tall. Use a smaller font or fewer lines.":
    "La table est trop haute. Utilisez une police plus petite ou moins de lignes.",
  "Paste spreadsheet": "Coller des cellules",
  "Choose how to add these cells. Blank cells keep their positions.":
    "Choisissez comment ajouter ces cellules. Les cellules vides conservent leur position.",
  Ideas: "Idées",
  "One sticky note per line. Empty lines are skipped.":
    "Une note adhésive par ligne. Les lignes vides sont ignorées.",
  "Paste as": "Coller en tant que",
  "Sticky notes": "Notes adhésives",
  "Plain text": "Texte brut",
  "Sticky color": "Couleur des notes",
  "Cluster sticky notes": "Regrouper les notes adhésives",
  "Cluster by": "Regrouper par",
  Color: "Couleur",
  "One named cluster": "Un regroupement nommé",
  "Cluster name": "Nom du regroupement",
  Cluster: "Regroupement",
  "Create clusters": "Créer les regroupements",
  "No tag": "Sans étiquette",
  notes: "notes",
  clusters: "regroupements",
  "extra copies": "copies supplémentaires",
  "extra copy": "copie supplémentaire",
  note: "note",
  cluster: "regroupement",
  "Select sticky notes first.": "Sélectionnez d’abord des notes adhésives.",
  "Choose a clustering method.": "Choisissez une méthode de regroupement.",
  "The cluster name changed. Reopen clustering.":
    "Le nom du regroupement a changé. Rouvrez le regroupement.",
  "The selected notes changed. Reopen clustering.":
    "Les notes sélectionnées ont changé. Rouvrez le regroupement.",
  "Select sticky notes outside a mind map.":
    "Sélectionnez des notes adhésives qui ne font pas partie d’une carte mentale.",
  "Enter a cluster name of up to 200 characters.":
    "Saisissez un nom de regroupement de 200 caractères maximum.",
  "These clusters would exceed the board limit of 5,000 objects.":
    "Ces regroupements dépasseraient la limite de 5 000 objets du tableau.",
  "These clusters would exceed the board geometry limit.":
    "Ces regroupements dépasseraient les limites géométriques du tableau.",
  "The notes changed. Review the updated clusters and try again.":
    "Les notes ont changé. Vérifiez les regroupements actualisés, puis réessayez.",
  "Selected notes move into editable frames. Notes leave their previous groups and frames; other objects stay in place. Notes with several tags are copied into each matching cluster.":
    "Les notes sélectionnées sont déplacées dans des cadres modifiables. Elles quittent leurs groupes et cadres précédents ; les autres objets restent en place. Les notes portant plusieurs étiquettes sont copiées dans chaque regroupement correspondant.",
  Yellow: "Jaune",
  Red: "Rouge",
  Lime: "Vert citron",
  Cyan: "Cyan",
  Pink: "Rose",
  Gray: "Gris",
  Violet: "Violet",
  "Dark green": "Vert foncé",
  "Dark blue": "Bleu foncé",
  "Dark gray": "Gris foncé",
  Black: "Noir",
  Green: "Vert",
  Blue: "Bleu",
  Purple: "Violet",
  Peach: "Pêche",
  White: "Blanc",
  // Sticky note colors, which name clusters grouped by color.
  Butter: "Beurre",
  Sage: "Sauge",
  Lilac: "Lilas",
  Cells: "Cellules",
  "Content preview": "Aperçu du contenu",
  "Cluster preview": "Aperçu des regroupements",
  "Add to board": "Ajouter au tableau",
  "Paste up to 50 rows and 100 columns at a time.":
    "Collez jusqu’à 50 lignes et 100 colonnes à la fois.",
  "Tables support up to 20 rows, 12 columns, and 2,000 characters per cell.":
    "Les tables acceptent jusqu’à 20 lignes, 12 colonnes et 2 000 caractères par cellule.",
  "Paste up to 1 million characters at a time.":
    "Collez jusqu’à 1 million de caractères à la fois.",
  "Check the quotes in the pasted spreadsheet cells.":
    "Vérifiez les guillemets dans les cellules collées.",
  "Paste one spreadsheet range at a time.":
    "Collez une plage de cellules à la fois.",
  "Use up to 20,000 characters per sticky note.":
    "Utilisez jusqu’à 20 000 caractères par note adhésive.",
  "Copy as image": "Copier en tant qu’image",
  "Copy as image (Ctrl/Cmd Shift C)":
    "Copier en tant qu’image (Ctrl/Cmd Maj C)",
  "Copy image": "Copier l’image",
  "Download PNG": "Télécharger le PNG",
  "Image of selected objects": "Image des objets sélectionnés",
  "Clipboard access is unavailable. Download the PNG or try copying again.":
    "L’accès au presse-papiers est indisponible. Téléchargez le PNG ou réessayez de copier.",
  "Could not copy the image. Use Copy as image to try again.":
    "Impossible de copier l’image. Utilisez Copier en tant qu’image pour réessayer.",
  "Image copied. Paste it into another app or board.":
    "Image copiée. Collez-la dans une autre application ou un tableau.",
  "An image copy is already in progress.":
    "Une copie d’image est déjà en cours.",
  "Select objects to copy as an image.":
    "Sélectionnez les objets à copier en tant qu’image.",
  "Copying selection as an image…": "Copie de la sélection en tant qu’image…",
  "Could not prepare the image. Please try again.":
    "Impossible de préparer l’image. Veuillez réessayer.",
  "Your browser cannot copy images here. Download the PNG instead.":
    "Votre navigateur ne peut pas copier d’images ici. Téléchargez le PNG.",

  "Connection line formatting": "Mise en forme des lignes de connexion",
  "Copy style": "Copier le style",
  "Font family": "Police de caractères",
  "Paste style": "Coller le style",
  "Copy style (Ctrl/Cmd Alt/Option C)":
    "Copier le style (Ctrl/Cmd Alt/Option C)",
  "Paste style (Ctrl/Cmd Alt/Option V)":
    "Coller le style (Ctrl/Cmd Alt/Option V)",
  "Select one object with a copyable style.":
    "Sélectionnez un objet dont le style peut être copié.",
  "Style copied. Select objects and paste style.":
    "Style copié. Sélectionnez des objets et collez le style.",
  "Copy a style first.": "Copiez d’abord un style.",
  "The copied style does not apply to this selection.":
    "Le style copié ne s’applique pas à cette sélection.",
  "This style is already applied.": "Ce style est déjà appliqué.",
  "Style pasted.": "Style collé.",
  Path: "Tracé",
  Straight: "Droit",
  Elbow: "Coudé",
  Curved: "Courbe",
  Stroke: "Trait",
  Solid: "Continu",
  Dashed: "Tirets",
  Dotted: "Pointillé",
  Thickness: "Épaisseur",
  Start: "Début",
  End: "Fin",
  None: "Aucun",
  Arrowhead: "Pointe de flèche",
  "Filled triangle": "Triangle plein",
  "Open triangle": "Triangle vide",
  "Filled diamond": "Losange plein",
  "Open diamond": "Losange vide",
  "Open circle": "Cercle vide",
  "Bar (one)": "Barre (un)",
  "Crow's foot (many)": "Patte d’oie (plusieurs)",
  Dot: "Point",
  "Connection endpoints": "Extrémités de connexion",
  "Free endpoint": "Extrémité libre",
  "Start object": "Objet de départ",
  "End object": "Objet d’arrivée",
  "Drag either round handle to reconnect. Hold Alt/Option to detach, or Shift for a straight angle.":
    "Faites glisser une poignée ronde pour reconnecter. Maintenez Alt/Option pour détacher, ou Maj pour un angle droit.",
  "Choose two different objects.": "Choisissez deux objets différents.",
  "Drag between objects to connect · Alt/Option for a free endpoint":
    "Reliez les objets par glissement · Alt/Option pour une extrémité libre",
  "Invalid line style.": "Style de ligne invalide.",
  "Invalid line thickness.": "Épaisseur de ligne invalide.",

  "Open to rename": "Ouvrir pour renommer",
  "Only people who can edit this board rename it.":
    "Seules les personnes qui peuvent modifier ce tableau le renomment.",
  "Share board": "Partager le tableau",
  "Shared board": "Tableau partagé",
  Participants: "Participants",
  Editing: "Modification",
  "Join shared board": "Rejoindre un tableau partagé",
  "Board link": "Lien du tableau",
  "Join board": "Rejoindre le tableau",
  "Sign in with Puter to join this board.":
    "Connectez-vous à Puter pour rejoindre ce tableau.",
  "Paste the link you were given to open the board.":
    "Collez le lien que vous avez reçu pour ouvrir le tableau.",
  "You were invited to a shared board. Choose Join board to open it.":
    "Vous avez reçu une invitation à un tableau partagé. Choisissez Rejoindre le tableau pour l’ouvrir.",
  "Choose Join board to open this shared board.":
    "Choisissez Rejoindre le tableau pour ouvrir ce tableau partagé.",
  "Can edit": "Peut modifier",
  "Can view": "Peut consulter",
  "View only": "Lecture seule",
  "Comment only": "Commentaires uniquement",
  "You can now edit this board.": "Vous pouvez maintenant modifier ce tableau.",
  "You can now manage this board's participants and run its facilitation.":
    "Vous pouvez maintenant gérer les participants de ce tableau et en animer les activités.",
  "You can still edit this board, but no longer manage its participants or facilitation.":
    "Vous pouvez toujours modifier ce tableau, mais vous n’en gérez plus les participants ni l’animation.",
  "You can now comment on this board, but not change its content.":
    "Vous pouvez maintenant commenter ce tableau, mais pas modifier son contenu.",
  "You can now only view this board.":
    "Vous ne pouvez plus que consulter ce tableau.",
  Owner: "Propriétaire",
  Removed: "Retiré",
  "Access for": "Accès pour",
  "Link access": "Accès par lien",
  "Create invitation": "Créer une invitation",
  "Copy link": "Copier le lien",
  "Link copied.": "Lien copié.",
  "Copy the selected link.": "Copiez le lien sélectionné.",
  "This board is read-only.": "Ce tableau est en lecture seule.",
  "This board is read-only for you. Ask the owner or a facilitator for access to edit or comment.":
    "Ce tableau est en lecture seule pour vous. Demandez au propriétaire ou à un animateur l’accès pour le modifier ou le commenter.",
  "This board's content is read-only for you. Choose Comment (C) to discuss it.":
    "Le contenu de ce tableau est en lecture seule pour vous. Choisissez Commentaire (C) pour en discuter.",
  "Only the owner or a facilitator can invite new participants.":
    "Seuls le propriétaire du tableau ou un animateur peuvent inviter de nouveaux participants.",
  "Anyone signed in with this invitation can join.":
    "Toute personne connectée disposant de cette invitation peut rejoindre le tableau.",
  "Create an invitation to share this access.":
    "Créez une invitation pour partager cet accès.",
  "Changes are shared as you type. Escape to finish.":
    "Les modifications sont partagées pendant la saisie. Échap pour terminer.",
  "Preparing collaboration…": "Préparation de la collaboration…",
  "Starting collaboration…": "Démarrage de la collaboration…",
  "Sharing failed · try again": "Échec du partage · réessayez",
  "Shared, but the copy in Puter could not be updated.":
    "Partagé, mais la copie dans Puter n’a pas pu être mise à jour.",
  "The collaboration server bundle could not load.":
    "Le module du serveur de collaboration n’a pas pu être chargé.",
  "Invalid collaboration server bundle.":
    "Module du serveur de collaboration non valide.",
  "Could not create a restricted collaboration credential.":
    "Impossible de créer un identifiant de collaboration restreint.",
  "Connecting to shared board…": "Connexion au tableau partagé…",
  "Still connecting to the shared board. Try again in a moment.":
    "Connexion au tableau partagé en cours. Réessayez dans un instant.",
  "Some images or files have not downloaded from the shared board yet. Try again in a moment.":
    "Certaines images ou certains fichiers du tableau partagé ne sont pas encore téléchargés. Réessayez dans un instant.",
  "Some images or files of this shared board are not on this device yet. Open the board to download them, then try again.":
    "Certaines images ou certains fichiers de ce tableau partagé ne sont pas encore sur cet appareil. Ouvrez le tableau pour les télécharger, puis réessayez.",
  "Sharing update could not finish. Reopen this board to retry.":
    "La mise à jour du partage n’a pas abouti. Rouvrez ce tableau pour réessayer.",
  "Saving shared changes…": "Enregistrement des modifications partagées…",
  "Access changed · unsent changes stay on this device":
    "Accès modifié · les modifications non envoyées restent sur cet appareil",
  "Saved · live": "Enregistré · en direct",
  "Text you were typing when the board closed was put back.":
    "Le texte que vous saisissiez à la fermeture du tableau a été rétabli.",
  "Saved · board full, no live presence":
    "Enregistré · tableau complet, sans présence en direct",
  "Saved · periodic sync": "Enregistré · synchronisation périodique",
  "Connected · periodic sync": "Connecté · synchronisation périodique",
  "This board needs a newer version of the app · reload":
    "Ce tableau nécessite une version plus récente de l’application · rechargez",
  "Showing {shown} of {total} matching objects. Search for a frame's name to list everything it holds, or search to narrow the list.":
    "Affichage de {shown} objets sur {total} correspondants. Cherchez le nom d’un cadre pour lister tout ce qu’il contient, ou cherchez pour réduire la liste.",
  "Showing the first {shown} of {total} matching objects. Search to narrow the list.":
    "Affichage des {shown} premiers objets sur {total} correspondants. Cherchez pour réduire la liste.",
  "Offline · changes saved on this device":
    "Hors ligne · modifications enregistrées sur cet appareil",
  "Uploading images · waiting for the board's server":
    "Envoi des images · en attente du serveur du tableau",
  "This board has reached its 1 GB limit for images and files.":
    "Ce tableau a atteint sa limite de 1 Go pour les images et les fichiers.",
  "An image or file could not be saved to the shared board.":
    "Une image ou un fichier n’a pas pu être enregistré sur le tableau partagé.",
  "Some changes could not be saved because they conflicted with the shared board.":
    "Certaines modifications n’ont pas pu être enregistrées, car elles étaient en conflit avec le tableau partagé.",
  "Board unavailable · local changes retained":
    "Tableau indisponible · modifications locales conservées",
  "Access changed · local changes retained":
    "Accès modifié · modifications locales conservées",
  "Local recovery failed. Keep this tab open.":
    "La récupération locale a échoué. Gardez cet onglet ouvert.",
  "Could not connect · local copy available":
    "Connexion impossible · copie locale disponible",
  "Connection lost. Changes are saved on this device and sync when it returns.":
    "Connexion perdue. Les modifications sont enregistrées sur cet appareil et se synchroniseront à son retour.",
  "Back online · changes synced":
    "De nouveau en ligne · modifications synchronisées",
  "The shared board cannot be reached. Changes stay on this device.":
    "Le tableau partagé est inaccessible. Les modifications restent sur cet appareil.",
  "Shared board available again · changes synced":
    "Tableau partagé de nouveau disponible · modifications synchronisées",
  "Cannot reach the shared board · retrying · view only":
    "Tableau partagé injoignable · nouvel essai · lecture seule",
  "Cannot reach the shared board. It is view only until it reconnects.":
    "Tableau partagé injoignable. Il reste en lecture seule jusqu’à la reconnexion.",
  "Setting up sharing…": "Configuration du partage…",
  "Uploading the board…": "Envoi du tableau…",
  "Uploading images · {count} left, waiting for the board's server…":
    "Envoi des images · encore {count}, en attente du serveur du tableau…",
  "This can take a few seconds. You can close this and look around; editing resumes once sharing is ready.":
    "Cela peut prendre quelques secondes. Vous pouvez fermer cette fenêtre et explorer le tableau ; la modification reprendra une fois le partage prêt.",
  "Sharing is ready. Select Share board to invite people.":
    "Le partage est prêt. Sélectionnez Partager le tableau pour inviter des personnes.",
  "Invalid board invitation.": "Invitation au tableau non valide.",
  "Invalid Whiteboard server address.":
    "Adresse de serveur Whiteboard non valide.",
  "The collaboration server is still starting. Try Share again shortly.":
    "Le serveur de collaboration démarre encore. Réessayez Partager dans un instant.",
  "Your Puter account changed. Reopen the shared board.":
    "Votre compte Puter a changé. Rouvrez le tableau partagé.",
  "Could not synchronize this board.": "Impossible de synchroniser ce tableau.",
  "Could not reach the shared board. Check your connection and try again.":
    "Impossible de joindre le tableau partagé. Vérifiez votre connexion et réessayez.",
  "The server did not acknowledge this edit.":
    "Le serveur n’a pas confirmé cette modification.",

  "Find on board": "Rechercher dans le tableau",
  "Find on board (Ctrl/Cmd F)": "Rechercher dans le tableau (Ctrl/Cmd F)",
  "Search this board": "Rechercher dans ce tableau",
  "Close search": "Fermer la recherche",
  "All content": "Tout le contenu",
  "Content type": "Type de contenu",
  "Previous result": "Résultat précédent",
  "Next result": "Résultat suivant",
  "Result {n} of {count}": "Résultat {n} sur {count}",
  "Previous page": "Page précédente",
  "Next page": "Page suivante",
  "Select on board": "Sélectionner sur le tableau",
  "Show results": "Afficher les résultats",
  "Search text, links, file names, and table cells.":
    "Recherchez du texte, des liens, des noms de fichiers et des cellules.",
  "Enter: next result · Shift+Enter: previous · Escape: close":
    "Entrée : suivant · Maj+Entrée : précédent · Échap : fermer",
  "Untitled object": "Objet sans titre",
  Attachment: "Pièce jointe",
  Drawing: "Dessin",
  "Adding files…": "Ajout des fichiers…",
  "Files added.": "Fichiers ajoutés.",
  "Drop content here": "Déposez le contenu ici",
  "Images, files, text, and links": "Images, fichiers, texte et liens",
  "Copy, cut, or paste objects": "Copier, couper ou coller des objets",
  "Ctrl or Cmd + C / X / V": "Ctrl ou Cmd + C / X / V",
  "This selection is too large to copy. Export a board file instead.":
    "Cette sélection est trop volumineuse pour être copiée. Exportez un fichier de tableau.",
  "This selection is too large to paste.":
    "Cette sélection est trop volumineuse pour être collée.",
  "This clipboard content is not supported.":
    "Ce contenu du presse-papiers n’est pas pris en charge.",
  "Paste up to 20,000 characters at a time.":
    "Collez jusqu’à 20 000 caractères à la fois.",
  "This text is at its length limit, so the end of what was added was left out.":
    "Ce texte a atteint sa longueur maximale : la fin de ce qui a été ajouté a été omise.",
  "Could not read this file.": "Impossible de lire ce fichier.",
  "This image could not be read.": "Cette image n’a pas pu être lue.",
  "Add up to 20 files and 50 MB at a time.":
    "Ajoutez jusqu’à 20 fichiers et 50 Mo à la fois.",
  "Could not decode an image.": "Impossible de décoder une image.",
  "Choose an image with fewer than 40 million pixels.":
    "Choisissez une image de moins de 40 millions de pixels.",
  "A board can contain up to 5,000 objects.":
    "Un tableau peut contenir jusqu’à 5 000 objets.",
  "Could not add these files.": "Impossible d’ajouter ces fichiers.",
  "Could not copy these objects. Your board is unchanged.":
    "Impossible de copier ces objets. Votre tableau est inchangé.",
  "Could not paste this content.": "Impossible de coller ce contenu.",
  "Choose a tool, then click the canvas. Double-click an object to edit its text. Drag a corner to resize. Paste text, links, or images, or drop files onto the canvas.":
    "Choisissez un outil, puis cliquez sur le tableau. Double-cliquez sur un objet pour modifier son texte. Faites glisser un coin pour le redimensionner. Collez du texte, des liens ou des images, ou déposez des fichiers sur le tableau.",
  "Editing text": "Modification du texte",
  Done: "Terminé",
  "Text formatting": "Mise en forme du texte",
  Bold: "Gras",
  Italic: "Italique",
  Underline: "Souligné",
  Strikethrough: "Barré",
  Lists: "Listes",
  "Text links": "Liens du texte",
  "Insert or edit text link": "Insérer ou modifier un lien dans le texte",
  "Link URL": "Adresse du lien",
  "Apply link": "Appliquer le lien",
  "Edit link": "Modifier le lien",
  Previous: "Précédent",
  Next: "Suivant",
  "Remove link": "Supprimer le lien",
  "Open link in new tab": "Ouvrir le lien dans un nouvel onglet",
  "The selected text changed. Select it again.":
    "Le texte sélectionné a changé. Sélectionnez-le à nouveau.",
  "Select one text object.": "Sélectionnez un objet contenant du texte.",
  "Ctrl/Cmd + Alt/Option + K": "Ctrl/Cmd + Alt/Option + K",
  "List formatting": "Mise en forme des listes",
  "Bulleted list": "Liste à puces",
  "Numbered list": "Liste numérotée",
  "Increase indent": "Augmenter le retrait",
  "Decrease indent": "Diminuer le retrait",
  "In lists, Tab changes indent, Shift+Enter continues an item, and Enter on an empty item exits the list.":
    "Dans une liste, Tab change le retrait, Maj+Entrée continue un élément et Entrée sur un élément vide quitte la liste.",
  "Indent / outdent a list item":
    "Augmenter / diminuer le retrait d’un élément de liste",
  "Move between the selection or its text and its toolbar":
    "Passer de la sélection ou de son texte à sa barre d’outils, et inversement",
  "Selection tools": "Outils de la sélection",
  Undone: "Action annulée",
  Redone: "Action rétablie",
  "Nothing to undo": "Rien à annuler",
  "Nothing to redo": "Rien à rétablir",
  "Brought to front": "Mis au premier plan",
  "Sent to back": "Mis à l’arrière-plan",
  "Brought forward": "Avancé d’un plan",
  "Sent backward": "Reculé d’un plan",
  Ungrouped: "Groupe dissocié",
  "{count} object grouped": "{count} objet groupé",
  "{count} objects grouped": "{count} objets groupés",
  "Out of the frame": "Hors du cadre",
  Size: "Taille",
  "Connects to": "Relié à",
  "Attached to": "Attaché à",
  "Connected from": "Relié depuis",
  "open discussion": "discussion ouverte",
  "open discussions": "discussions ouvertes",
  "one|and {count} more": "et {count} autre",
  "and {count} more": "et {count} autres",
  "Continue a list item on a new line":
    "Continuer un élément de liste sur une nouvelle ligne",
  "Tab / Shift + Tab": "Tab / Maj + Tab",
  "Shift + Enter": "Maj + Entrée",
  "Shift + C": "Maj + C",
  "Shift + N": "Maj + N",
  "Space / right / middle + drag":
    "Espace / clic droit / clic central + glisser",
  "Ctrl/Cmd + Plus/Minus": "Ctrl/Cmd + Plus/Moins",
  "Arrow keys": "Touches fléchées",
  "Alt / Option + drag": "Alt / Option + glisser",
  "Alt / Option + Arrow keys": "Alt / Option + touches fléchées",
  "Alt / Option during drag": "Alt / Option pendant le glissement",
  Escape: "Échap",
  "Shift + resize": "Maj + redimensionnement",
  "Ctrl/Cmd + Alt/Option + Shift + Plus/Minus":
    "Ctrl/Cmd + Alt/Option + Maj + Plus/Moins",
  Enter: "Entrée",
  "Ctrl/Cmd + Shift + Down / Up": "Ctrl/Cmd + Maj + Bas / Haut",
  "Ctrl/Cmd + Alt/Option + Shift + K": "Ctrl/Cmd + Alt/Option + Maj + K",
  "Ctrl/Cmd + Alt/Option + Shift + C": "Ctrl/Cmd + Alt/Option + Maj + C",
  "Ctrl/Cmd + Alt/Option + Shift + H": "Ctrl/Cmd + Alt/Option + Maj + H",
  "Moved to the trash.": "Placé dans la corbeille.",
  "Deleted {date}": "Supprimé le {date}",
  "Version history (Ctrl/Cmd Alt/Option Shift H)":
    "Historique des versions (Ctrl/Cmd Alt/Option Maj H)",
  "Ctrl or Cmd + Z": "Ctrl ou Cmd + Z",
  "Ctrl or Cmd + D": "Ctrl ou Cmd + D",
  "Ctrl or Cmd + Shift + L": "Ctrl ou Cmd + Maj + L",
  "Ctrl/Cmd + Shift + C": "Ctrl/Cmd + Maj + C",
  "Ctrl or Cmd + [ / ]": "Ctrl ou Cmd + [ / ]",
  "Ctrl or Cmd + Shift + [ / ]": "Ctrl ou Cmd + Maj + [ / ]",
  "Page Down / Page Up": "Page suivante / Page précédente",
  "A or L / P / E / F": "A ou L / P / E / F",
  "Ctrl/Cmd + Backspace": "Ctrl/Cmd + Retour arrière",
  "Delete / Backspace": "Suppr / Retour arrière",
  Find: "Rechercher",
  Delete: "Supprimer",
  Share: "Partager",
  View: "Affichage",
  Selection: "Sélection",
  Insert: "Insérer",
  "Previous results": "Résultats précédents",
  "Next results": "Résultats suivants",
  "Selected objects": "Objets sélectionnés",
  "Selected region": "Zone sélectionnée",
  Row: "Ligne",
  Column: "Colonne",
  "Highlight text": "Surligner le texte",
  "Remove highlight": "Supprimer le surlignage",
  "No highlight": "Sans surlignage",
  "Text color": "Couleur du texte",
  "Custom color": "Couleur personnalisée",
  "Automatic text color": "Couleur du texte automatique",
  "Text alignment": "Alignement du texte",
  "Align text left": "Texte à gauche",
  "Align text center": "Texte centré",
  "Align text right": "Texte à droite",
  "Font size": "Taille du texte",
  Mixed: "Mixte",
  "Object properties": "Propriétés de l’objet",
  "Edit text on canvas": "Modifier le texte sur le tableau",
  "Finish editing": "Terminer la modification",
  "Cancel text edit": "Annuler la modification du texte",
  "Ctrl or Cmd + Enter to finish. Escape to cancel. Enter adds a new line.":
    "Ctrl ou Cmd + Entrée pour terminer. Échap pour annuler. Entrée ajoute une ligne.",
  "Board library": "Bibliothèque de tableaux",
  "Recovered board": "Tableau récupéré",
  "Space + drag": "Espace + glisser",
  "Ctrl or Cmd + scroll": "Ctrl ou Cmd + défilement",
  "Shift or Ctrl/Cmd + click": "Maj ou Ctrl/Cmd + clic",
  "Ctrl or Cmd + Shift + Z or Ctrl or Cmd + Y":
    "Ctrl ou Cmd + Maj + Z ou Ctrl ou Cmd + Y",
  "Ctrl or Cmd + S": "Ctrl ou Cmd + S",
  "Shift + Arrow keys": "Maj + touches fléchées",
  "Move selected objects by 10": "Déplacer les objets sélectionnés de 10",
  "Arrow keys with nothing selected": "Touches fléchées sans sélection",
  "Ctrl/Cmd + B / I / U": "Ctrl/Cmd + B / I / U",
  "Bold, italic, or underline while typing":
    "Gras, italique ou souligné pendant la saisie",
  "Ctrl or Cmd + A": "Ctrl ou Cmd + A",
  "Select all objects": "Sélectionner tous les objets",
  "Ctrl or Cmd + G / Shift + G": "Ctrl ou Cmd + G / Maj + G",
  "Group / ungroup selection": "Grouper / dissocier la sélection",
  "Show these shortcuts": "Afficher ces raccourcis",
  "Fullscreen is unavailable. Presentation remains open.":
    "Le plein écran est indisponible. La présentation reste ouverte.",
  "Could not restore this version.": "Impossible de restaurer cette version.",
  "Could not export this board.": "Impossible d’exporter ce tableau.",
  "This area is too large for a readable PDF at this scale. Choose a smaller scale, or export frames or a selected region.":
    "Cette zone est trop grande pour un PDF lisible à cette échelle. Choisissez une échelle plus petite, ou exportez des cadres ou une région sélectionnée.",
  "Too many PDF pages. Export fewer frames at a time.":
    "Trop de pages PDF. Exportez moins de cadres à la fois.",
  "Too many PDF pages. Fit each area on one page, or export fewer frames at a time.":
    "Trop de pages PDF. Mettez chaque zone sur une seule page, ou exportez moins de cadres à la fois.",
  "Choose a file smaller than 500 MB.":
    "Choisissez un fichier de moins de 500 Mo.",

  "Whiteboard home": "Accueil Whiteboard",
  "Personal workspace": "Espace personnel",
  "All boards": "Tous les tableaux",
  Favorites: "Favoris",
  Trash: "Corbeille",
  Appearance: "Apparence",
  Preferences: "Préférences",
  System: "Système",
  Light: "Clair",
  Dark: "Sombre",
  "Powered by Puter": "Propulsé par Puter",
  Workspace: "Espace de travail",
  "Keyboard shortcuts": "Raccourcis clavier",
  "Start with a little inspiration": "Un peu d’inspiration pour commencer",
  "Make it your own": "À votre image",
  "Blank board": "Tableau vierge",
  "A fresh start": "Un nouveau départ",
  "Mind map": "Carte mentale",
  "Your boards": "Vos tableaux",
  "Favorite boards": "Tableaux favoris",
  "New board": "Nouveau tableau",
  "Search boards": "Rechercher des tableaux",
  "Search your boards": "Rechercher dans vos tableaux",
  "Sort boards": "Trier les tableaux",
  "Last edited": "Dernière modification",
  Name: "Nom",
  "Grid view": "Vue en grille",
  "List view": "Vue en liste",
  "Board layout": "Affichage des tableaux",
  Location: "Emplacement",
  "Fill color": "Couleur de remplissage",
  Border: "Bordure",
  "Text style": "Style du texte",
  "Import board file": "Importer un tableau",
  "A world of possibility": "Un monde de possibilités",
  "No boards found": "Aucun tableau trouvé",
  "Keep your best ideas close": "Gardez vos meilleures idées à portée de main",
  "Your next idea starts here": "Votre prochaine idée commence ici",
  "Trash is empty": "La corbeille est vide",
  "Boards you move to the trash wait here until you restore them or delete them permanently.":
    "Les tableaux mis à la corbeille attendent ici jusqu’à ce que vous les restauriez ou les supprimiez définitivement.",
  "Try different words.": "Essayez d’autres mots.",
  "Star a board to find it here.":
    "Ajoutez un tableau aux favoris pour le retrouver ici.",
  "Create a board or choose a template above.":
    "Créez un tableau ou choisissez un modèle ci-dessus.",
  "Untitled board": "Tableau sans titre",
  "Back to boards": "Retour aux tableaux",
  "Board name": "Nom du tableau",
  "Saved on this device": "Enregistré sur cet appareil",
  "Save to Puter": "Enregistrer sur Puter",
  "Saved to Puter · Save again":
    "Enregistré sur Puter · Enregistrer de nouveau",
  "Save shared changes now":
    "Enregistrer les modifications partagées maintenant",
  "On this device": "Sur cet appareil",
  "Boards stay in this browser until you sign in.":
    "Les tableaux restent dans ce navigateur tant que vous n’êtes pas connecté.",
  "Open from Puter": "Ouvrir depuis Puter",
  "Not on this device yet": "Pas encore sur cet appareil",
  "Export board": "Exporter le tableau",
  "Drawing tools": "Outils de création",
  Select: "Sélectionner",
  Pan: "Déplacer la vue",
  "Sticky note": "Note adhésive",
  Text: "Texte",
  Rectangle: "Rectangle",
  Ellipse: "Ellipse",
  Arrow: "Flèche",
  Draw: "Dessiner",
  Eraser: "Gomme",
  Frame: "Cadre",
  "Add image": "Ajouter une image",
  "Personal board": "Tableau personnel",
  "Board objects": "Objets du tableau",
  "Zoom out": "Zoom arrière",
  "Zoom in": "Zoom avant",
  "Reset zoom to 100 percent": "Rétablir le zoom à 100 %",
  "Fit board to screen": "Ajuster le tableau à l’écran",
  "Butter color": "Couleur beurre",
  "Sticky note color": "Couleur des notes adhésives",
  "Frame format": "Format du cadre",
  Custom: "Personnalisé",
  "Slide 16:9": "Diapositive 16:9",
  "Slide 4:3": "Diapositive 4:3",
  "Square 1:1": "Carré 1:1",
  Phone: "Téléphone",
  Tablet: "Tablette",
  Desktop: "Ordinateur",
  "Sage color": "Couleur sauge",
  "Blue color": "Couleur bleue",
  "Lilac color": "Couleur lilas",
  "Peach color": "Couleur pêche",
  "White color": "Couleur blanche",
  "Drawing color": "Couleur du dessin",
  "Graphite color": "Couleur graphite",
  "Red color": "Couleur rouge",
  "Green color": "Couleur verte",
  "Orange color": "Couleur orange",
  "Purple color": "Couleur violette",
  "Edit selected object": "Modifier l’objet sélectionné",
  "Duplicate selection": "Dupliquer la sélection",
  "Duplicate left": "Dupliquer à gauche",
  "Duplicate right": "Dupliquer à droite",
  "Duplicate above": "Dupliquer au-dessus",
  "Duplicate below": "Dupliquer en dessous",
  "Drag a copy": "Faire glisser une copie",
  "Duplicate in a direction": "Dupliquer dans une direction",
  "The duplicate would be outside the board limits.":
    "La copie serait en dehors des limites du tableau.",
  "Bring to front": "Mettre au premier plan",
  "Delete selection": "Supprimer la sélection",
  "Select and move · Double-click to edit · Space to pan":
    "Sélectionner et déplacer · Double-clic pour modifier · Espace pour naviguer",
  "Select objects to read them · Space to pan":
    "Sélectionnez des objets pour les lire · Espace pour naviguer",
  "Select objects to read them · Comment (C) to discuss · Space to pan":
    "Sélectionnez des objets pour les lire · Commentaire (C) pour en discuter · Espace pour naviguer",
  "Drag to move around your board":
    "Faites glisser pour vous déplacer dans le tableau",
  "Draw freely on the canvas": "Dessinez librement sur le tableau",
  "Drag across drawings to erase them":
    "Faites glisser sur les dessins pour les effacer",
  "This drawing is full. Draw again to continue.":
    "Ce dessin est plein. Dessinez de nouveau pour continuer.",
  "Click to add a sticky note · Drag to draw one at a size":
    "Cliquez pour ajouter une note adhésive · Glissez pour en dessiner une à la taille voulue",
  "Click to add text · Drag to set its width":
    "Cliquez pour ajouter du texte · Glissez pour fixer sa largeur",
  "Click to add a rectangle · Drag to draw one at a size":
    "Cliquez pour ajouter un rectangle · Glissez pour en dessiner un à la taille voulue",
  "Click to add an ellipse · Drag to draw one at a size":
    "Cliquez pour ajouter une ellipse · Glissez pour en dessiner une à la taille voulue",
  "Click to add a frame · Drag to draw one around objects":
    "Cliquez pour ajouter un cadre · Glissez pour en dessiner un autour d’objets",
  "Click the canvas to add a comment":
    "Cliquez sur le tableau pour ajouter un commentaire",
  "Drag across the board to choose the area to export":
    "Faites glisser sur le tableau pour choisir la zone à exporter",
  "Drag from start to end": "Faites glisser du début à la fin",
  "Your text": "Votre texte",
  "Close dialog": "Fermer la fenêtre",
  Width: "Largeur",
  Height: "Hauteur",
  "Save changes": "Enregistrer les modifications",
  "Take your ideas with you": "Emportez vos idées",
  "Export a visual snapshot or a fully editable backup.":
    "Exportez une image ou une sauvegarde modifiable.",
  "PNG image": "Image PNG",
  "JPEG image": "Image JPEG",
  "PDF document": "Document PDF",
  "Whiteboard file": "Fichier Whiteboard",
  "Import it later and keep creating": "Importez-le plus tard pour continuer",
  "Board options": "Options du tableau",
  "Move to trash": "Mettre à la corbeille",
  "Move this board to the trash?": "Mettre ce tableau à la corbeille?",
  "Boards in the trash can be restored from there.":
    "Les tableaux dans la corbeille peuvent être restaurés à partir de là.",
  "The copy saved in Puter is kept.":
    "La copie enregistrée sur Puter est conservée.",
  Duplicate: "Dupliquer",
  "Save name": "Enregistrer le nom",
  "Board name saved. You changed it while saving. Save again to update the name.":
    "Le nom du tableau est enregistré. Vous l’avez modifié pendant l’enregistrement. Enregistrez de nouveau pour mettre le nom à jour.",
  "This board changed in another tab. Your name draft is kept. Save again to rename the latest copy.":
    "Ce tableau a changé dans un autre onglet. Votre nom est conservé. Enregistrez de nouveau pour renommer la dernière copie.",
  "Your name draft is kept here.": "Votre nom est conservé ici.",
  "This board is in the trash. Your name draft is kept here.":
    "Ce tableau est dans la corbeille. Votre nom est conservé ici.",
  "Keep board": "Conserver le tableau",
  "Delete board": "Mettre à la corbeille",
  "Restore board": "Restaurer le tableau",
  "Saving…": "Enregistrement…",
  "Saved locally": "Enregistré localement",
  "Storage full": "Stockage plein",
  "Saving to Puter…": "Enregistrement sur Puter…",
  "Saved to Puter": "Enregistré sur Puter",
  "Cloud save failed": "Échec de l’enregistrement dans le nuage",
  "Newer copy in Puter": "Copie plus récente sur Puter",
  "A newer copy of this board is saved in Puter.":
    "Une copie plus récente de ce tableau est enregistrée sur Puter.",
  "Open newer copy": "Ouvrir la copie plus récente",
  "copy on this device": "copie sur cet appareil",
  "Opened the copy from Puter. The edits made on this device are kept as their own board.":
    "La copie de Puter est ouverte. Les modifications faites sur cet appareil sont conservées dans un tableau à part.",
  "Could not open the copy in Puter.":
    "Impossible d’ouvrir la copie sur Puter.",
  "The cloud board index is invalid. Your files remain in Puter.":
    "L’index des tableaux dans le nuage est invalide. Vos fichiers restent dans Puter.",
  "Invalid board identifier.": "Identifiant de tableau invalide.",
  "The AI request failed.": "La demande à l’IA a échoué.",
  "Could not move this board to the trash.":
    "Impossible de mettre ce tableau à la corbeille.",
  // Added to the names of duplicated and imported boards.
  copy: "copie",
  imported: "importé",
  "Could not save the copy on this device.":
    "Impossible d’enregistrer la copie sur cet appareil.",
  "Could not save this change on this device.":
    "Impossible d’enregistrer cette modification sur cet appareil.",
  "Could not save locally. Export your board to keep a copy.":
    "Enregistrement local impossible. Exportez votre tableau pour en conserver une copie.",
  "Cloud save failed. Your local copy is safe. Use Save to Puter to retry.":
    "Échec de l’enregistrement sur Puter. Votre copie locale est conservée. Réessayez avec Enregistrer sur Puter.",
  "Board imported.": "Tableau importé.",
  "A newer local copy was kept.":
    "La copie locale plus récente a été conservée.",
  Language: "Langue",
  "More tools": "Autres outils",
  Link: "Lien",
  Table: "Tableau de données",
  "File attachment": "Pièce jointe",
  "Add link": "Ajouter un lien",
  "Add table": "Ajouter un tableau de données",
  "Attach file": "Joindre un fichier",
  "Add content": "Ajouter du contenu",
  "Open link": "Ouvrir le lien",
  "Select a link card first.": "Sélectionnez d’abord une carte de lien.",
  "Download attachment": "Télécharger la pièce jointe",
  "Import contents": "Importer le contenu",
  "Files added. To add a document’s contents to the board, open its file card and choose Import contents.":
    "Fichiers ajoutés. Pour ajouter le contenu d’un document au tableau, ouvrez sa carte de fichier et choisissez Importer le contenu.",
  URL: "Adresse URL",
  Label: "Libellé",
  Rows: "Lignes",
  Columns: "Colonnes",
  "Add row": "Ajouter une ligne",
  "Add column": "Ajouter une colonne",
  "Remove last row": "Supprimer la dernière ligne",
  "Remove last column": "Supprimer la dernière colonne",
  "Table cells": "Cellules du tableau",
  "File name": "Nom du fichier",
  "Choose a file smaller than 10 MB.":
    "Choisissez un fichier de moins de 10 Mo.",
  "Enter a valid http or https link.":
    "Saisissez une adresse http ou https valide.",
  "Group selection": "Grouper la sélection",
  "Ungroup selection": "Dissocier la sélection",
  "Connect selected objects": "Relier les objets sélectionnés",
  "Select exactly two objects to connect.":
    "Sélectionnez exactement deux objets à relier.",
  "Select at least two objects to group.":
    "Sélectionnez au moins deux objets à grouper.",
  "Already grouped.": "Déjà groupés.",
  "Organize selection": "Organiser la sélection",
  "Lock selection": "Verrouiller la sélection",
  "Lock frame": "Verrouiller le cadre",
  "Unlock selection": "Déverrouiller la sélection",
  "Lock or unlock selection": "Verrouiller ou déverrouiller la sélection",
  "Unlock all objects": "Déverrouiller tous les objets",
  "Protected selection": "Sélection protégée",
  "More options": "Plus d’options",
  "Unlock to move, edit, or delete.":
    "Déverrouillez pour déplacer, modifier ou supprimer.",
  "Unlock protected objects before changing this selection.":
    "Déverrouillez les objets protégés avant de modifier cette sélection.",
  "Workshop content hidden from you was left out of the copy.":
    "Le contenu d’atelier qui vous est masqué n’a pas été inclus dans la copie.",
  "Hidden object": "Objet masqué",
  "Choose a visible object.": "Choisissez un objet visible.",
  "Hidden objects cannot be cut. Copy the selection instead.":
    "Les objets masqués ne peuvent pas être coupés. Copiez plutôt la sélection.",
  "Hidden objects cannot be copied.":
    "Les objets masqués ne peuvent pas être copiés.",
  "Selection locked.": "Sélection verrouillée.",
  "Selection unlocked.": "Sélection déverrouillée.",
  "All objects unlocked.": "Tous les objets sont déverrouillés.",
  "No locked objects.": "Aucun objet verrouillé.",
  "Frame locked. Its contents remain editable.":
    "Cadre verrouillé. Son contenu reste modifiable.",
  Locked: "Verrouillé",
  "Rotated selections keep their proportions. Alt/Option bypasses snapping.":
    "Les sélections pivotées conservent leurs proportions. Alt/Option désactive l’alignement.",
  "Rotate selection": "Faire pivoter la sélection",
  "Angle (degrees)": "Angle (degrés)",
  "Rotate by (degrees)": "Rotation relative (degrés)",
  "Reset angle": "Réinitialiser l’angle",
  "Apply rotation": "Appliquer la rotation",
  "Select shapes, text, images, cards, or drawings to rotate.":
    "Sélectionnez des formes, du texte, des images, des cartes ou des dessins à faire pivoter.",
  "Drag the rotation handle below the left corner. Hold Shift to snap to 15° steps. Escape cancels.":
    "Faites glisser la poignée de rotation sous le coin gauche. Maintenez Maj pour des pas de 15°. Échap annule.",
  "Enter a valid angle.": "Saisissez un angle valide.",
  "This rotation exceeds the board limits.":
    "Cette rotation dépasse les limites du tableau.",
  "Keep proportions when resizing rotated objects together.":
    "Conservez les proportions pour redimensionner ensemble des objets pivotés.",
  "Resize selection": "Redimensionner la sélection",
  "Resize frame": "Redimensionner le cadre",
  "Frame contents stay in place.": "Le contenu du cadre reste en place.",
  "Resize objects and their spacing together.":
    "Redimensionnez ensemble les objets et leur espacement.",
  "Keep proportions": "Conserver les proportions",
  "Scale text with objects": "Redimensionner le texte avec les objets",
  "Apply size": "Appliquer les dimensions",
  "Select objects with a resizable area.":
    "Sélectionnez des objets ayant une surface redimensionnable.",
  "Drag the corner to resize. Shift toggles proportions; Alt/Option bypasses snapping.":
    "Faites glisser le coin pour redimensionner. Maj inverse le maintien des proportions ; Alt/Option désactive temporairement l’alignement magnétique.",
  "Size adjusted to keep content readable. Review and apply again.":
    "Dimensions ajustées pour garder le contenu lisible. Vérifiez puis appliquez à nouveau.",
  "Toggle proportions while resizing":
    "Inverser le maintien des proportions pendant le redimensionnement",
  "Enter valid dimensions.": "Saisissez des dimensions valides.",
  "This size exceeds the board limits.":
    "Ces dimensions dépassent les limites du tableau.",
  "Keep text between 8 and 100 pixels.":
    "Gardez le texte entre 8 et 100 pixels.",
  "Text stays between 8 and 100 pixels, so this selection cannot be resized further.":
    "Le texte reste entre 8 et 100 pixels : cette sélection ne peut pas être redimensionnée davantage.",
  "The selection changed. Select it again.":
    "La sélection a changé. Sélectionnez-la à nouveau.",
  "Snap to objects": "Alignement magnétique",
  "Snapping on. Hold Alt/Option to bypass.":
    "Alignement magnétique activé. Maintenez Alt/Option pour le désactiver temporairement.",
  "Snapping off.": "Alignement magnétique désactivé.",
  "Added by": "Ajoutée par",
  "Show sticky note authors": "Afficher les auteurs des notes adhésives",
  "Hide sticky note authors": "Masquer les auteurs des notes adhésives",
  "Sticky notes show who added them.":
    "Les notes adhésives indiquent qui les a ajoutées.",
  "Sticky note authors hidden.": "Auteurs des notes adhésives masqués.",
  "After a pen, fingers only move the board":
    "Après le stylet, les doigts ne font que déplacer le tableau",
  "After a pen, fingers only move the board.":
    "Après le stylet, les doigts ne font que déplacer le tableau.",
  "Fingers draw and select, even after a pen.":
    "Les doigts dessinent et sélectionnent, même après le stylet.",
  "Pen in use: one finger moves the board and two zoom. You can change this in Preferences.":
    "Stylet utilisé : un doigt déplace le tableau, deux doigts zooment. Vous pouvez changer cela dans les Préférences.",
  "Temporarily bypass snapping":
    "Désactiver temporairement l’alignement magnétique",
  "Cancel the current move or resize":
    "Annuler le déplacement ou le redimensionnement en cours",
  "Create frame around selection": "Créer un cadre autour de la sélection",
  "Move into frame": "Placer dans un cadre",
  "No frame": "Aucun cadre",
  "Align left": "Aligner à gauche",
  "Align top": "Aligner en haut",
  "Align right": "Aligner à droite",
  "Align bottom": "Aligner en bas",
  "Center vertically": "Centrer verticalement",
  "Distribute horizontally": "Répartir horizontalement",
  "Distribute vertically": "Répartir verticalement",
  "Send to back": "Mettre à l’arrière-plan",
  "Bring forward": "Avancer d’un plan",
  "Send backward": "Reculer d’un plan",
  Alignment: "Alignement",
  Spacing: "Espacement",
  "Layer order": "Ordre des plans",
  "Group and organize": "Grouper et organiser",
  "Select at least three objects or groups to distribute evenly.":
    "Sélectionnez au moins trois objets ou groupes pour les répartir uniformément.",
  "Send backward / bring forward": "Reculer / avancer d’un plan",
  "Send to back / bring to front": "Mettre à l’arrière-plan / au premier plan",
  "Center horizontally": "Centrer horizontalement",
  "Save as reusable content": "Enregistrer comme contenu réutilisable",
  "Frames and navigation": "Cadres et navigation",
  "Add a frame to organize content and create presentation slides.":
    "Ajoutez un cadre pour organiser le contenu et créer des diapositives.",
  "Go to frame": "Aller au cadre",
  "Add frame": "Ajouter un cadre",
  "Present from this frame": "Présenter à partir de ce cadre",
  "Export selected frames": "Exporter les cadres sélectionnés",
  "The frames were added without their agenda steps: the agenda holds at most 60 steps.":
    "Les cadres ont été ajoutés sans leurs étapes : l’ordre du jour compte au plus 60 étapes.",
  "Move frame earlier": "Avancer le cadre",
  "Move frame later": "Reculer le cadre",
  "Copy link to frame": "Copier le lien du cadre",
  "Showing frame {number} of {count}":
    "Affichage du cadre {number} sur {count}",
  "Search frames": "Rechercher des cadres",
  "No frames match your search.":
    "Aucun cadre ne correspond à votre recherche.",
  "Arrow keys move between frames. Alt and the up or down arrow move a frame earlier or later.":
    "Les touches fléchées passent d’un cadre à l’autre. Alt et la flèche vers le haut ou vers le bas déplacent un cadre plus tôt ou plus tard.",
  "Arrow keys move between frames.":
    "Les touches fléchées passent d’un cadre à l’autre.",
  "Frames can be reordered once the facilitator shows every frame.":
    "Les cadres pourront être réordonnés quand l’animateur affichera tous les cadres.",
  Section: "Section",
  Presentation: "Présentation",
  Present: "Présenter",
  "Present board": "Présenter le tableau",
  "Start presentation": "Démarrer la présentation",
  "Choose frames in presentation order.":
    "Choisissez les cadres dans l’ordre de présentation.",
  "This board has no frames, so it presents as one slide. Add frames to make slides.":
    "Ce tableau n’a pas de cadres : il se présente en une seule diapositive. Ajoutez des cadres pour créer des diapositives.",
  "Present selection": "Présenter la sélection",
  "Previous slide": "Diapositive précédente",
  "Next slide": "Diapositive suivante",
  "Exit presentation": "Quitter la présentation",
  Fullscreen: "Plein écran",
  "Selected content": "Contenu sélectionné",
  "Entire board": "Tableau entier",
  "Export scope": "Zone à exporter",
  "Selected objects or region": "Objets ou région sélectionnés",
  "Export region": "Région d’exportation",
  "Defined frames": "Cadres définis",
  "Export format": "Format d’exportation",
  Export: "Exporter",
  "Select objects or draw a region first.":
    "Sélectionnez des objets ou dessinez une région.",
  "Add a frame before exporting sections.":
    "Ajoutez un cadre avant d’exporter des sections.",
  "PDFs include a board overview and readable detail pages for large areas. Images export one region at a time.":
    "Les PDF comprennent une vue d’ensemble et des pages de détail lisibles pour les grandes zones. Les images exportent une région à la fois.",
  "Select export region": "Sélectionner une région à exporter",
  "Region selected. Open Export to use it, or press Escape to clear it.":
    "Zone sélectionnée. Ouvrez Exporter pour l’utiliser, ou appuyez sur Échap pour l’effacer.",
  "Export region cleared.": "Zone d’exportation effacée.",
  "Clear export region": "Effacer la zone d’exportation",
  "Clear region": "Effacer la région",
  "Version history": "Historique des versions",
  "Create checkpoint": "Créer un point de restauration",
  "Checkpoint name": "Nom du point de restauration",
  Checkpoint: "Point de restauration",
  "Restore version": "Restaurer cette version",
  "Before restoration": "Avant la restauration",
  "Board edit": "Modification du tableau",
  "Before deletion": "Avant la suppression",
  "No saved versions yet.": "Aucune version enregistrée pour le moment.",
  "The 30 most recent versions are kept on this device, and one for each quarter hour of the last 30 days (up to 200 more), within 50 MB; when space runs short, the last version of each day is kept before the others. Pictures shared by several versions are stored once. Named checkpoints and the version saved before each restoration are kept apart from these: the newest 100, within another 50 MB.":
    "Les 30 versions les plus récentes sont conservées sur cet appareil, ainsi qu’une par quart d’heure des 30 derniers jours (jusqu’à 200 de plus), dans une limite de 50 Mo ; quand la place manque, la dernière version de chaque jour est conservée avant les autres. Les images communes à plusieurs versions ne sont stockées qu’une fois. Les points de restauration nommés et la version enregistrée avant chaque restauration sont conservés à part : les 100 plus récents, dans une limite de 50 Mo supplémentaires.",
  "Version restored.": "Version restaurée.",
  "Checkpoint saved.": "Point de restauration enregistré.",
  "Could not save the checkpoint. Export a backup.":
    "Impossible d’enregistrer le point de restauration. Exportez une sauvegarde.",
  "Could not save a recovery version. Export a backup.":
    "Impossible d’enregistrer une version de récupération. Exportez une sauvegarde.",
  "Template library": "Bibliothèque de modèles",
  "Browse all templates": "Parcourir tous les modèles",
  "Search templates": "Rechercher des modèles",
  "All categories": "Toutes les catégories",
  "Use template": "Utiliser ce modèle",
  "Insert into board": "Insérer dans le tableau",
  "My reusable content": "Mon contenu réutilisable",
  "No reusable content yet. Select objects on a board, then choose Save as reusable content from the right-click menu or More options.":
    "Aucun contenu réutilisable. Sélectionnez des objets dans un tableau, puis choisissez Enregistrer comme contenu réutilisable dans le menu contextuel ou Plus d’options.",
  "Reusable content saved.": "Contenu réutilisable enregistré.",
  "Could not save this content on this device.":
    "Impossible d’enregistrer ce contenu sur cet appareil.",
  "Delete template": "Supprimer le modèle",
  "Confirm delete": "Confirmer la suppression",
  "Confirm remove": "Confirmer le retrait",
  "Use arrow keys or Space to navigate slides. Press Escape to exit.":
    "Utilisez les touches fléchées ou Espace pour naviguer. Appuyez sur Échap pour quitter.",
  "Swipe left or right, or use the buttons, to change slides.":
    "Balayez vers la gauche ou la droite, ou utilisez les boutons, pour changer de diapositive.",
  Objects: "Objets",
  "{count} board found": "{count} tableau trouvé",
  "{count} boards found": "{count} tableaux trouvés",
  "{count} object": "{count} objet",
  "{count} objects": "{count} objets",
  Deleted: "Suppression",
  "{count} object selected": "{count} objet sélectionné",
  "{count} objects selected": "{count} objets sélectionnés",
  "{count} object deleted": "{count} objet supprimé",
  "{count} objects deleted": "{count} objets supprimés",
  "Search objects": "Rechercher des objets",
  "Select an object to move it with the arrow keys. Press Enter to edit.":
    "Sélectionnez un objet, déplacez-le avec les flèches, puis appuyez sur Entrée pour le modifier.",
  "Your board is empty. Add a note or shape to get started.":
    "Votre tableau est vide. Ajoutez une note ou une forme.",
  "Canvas objects": "Objets du tableau",
  "Arrow keys, Home and End move between objects.":
    "Les touches fléchées, Début et Fin passent d’un objet à l’autre.",
  "Arrow keys, Home and End move between objects. Page Down and Page Up move to the next or previous frame.":
    "Les touches fléchées, Début et Fin passent d’un objet à l’autre. Page suivante et Page précédente passent au cadre suivant ou précédent.",
  "Whiteboard canvas. Use Board objects to select and edit objects with the keyboard.":
    "Tableau blanc. Utilisez Objets du tableau pour sélectionner et modifier les objets au clavier.",
  "Undo (Ctrl/Cmd Z)": "Annuler (Ctrl/Cmd Z)",
  "Redo (Ctrl/Cmd Shift Z)": "Rétablir (Ctrl/Cmd Maj Z)",
  "Choose a tool, then click the canvas. Double-click an object to edit its text. Drag a corner to resize.":
    "Choisissez un outil, puis cliquez sur le tableau. Double-cliquez sur un objet pour modifier son texte. Faites glisser un coin pour le redimensionner.",
  "Select / pan": "Sélectionner / naviguer",
  "Sticky note / text": "Note adhésive / texte",
  "Rectangle / ellipse": "Rectangle / ellipse",
  "Arrow / draw / eraser / frame": "Flèche / dessin / gomme / cadre",
  "Move around the canvas": "Naviguer dans le tableau",
  "Zoom toward the pointer": "Zoomer vers le pointeur",
  "Select multiple objects": "Sélectionner plusieurs objets",
  "Move selected objects": "Déplacer les objets sélectionnés",
  "Edit the focused object": "Modifier l’objet actif",
  Undo: "Annuler",
  Copy: "Copier",
  Cut: "Couper",
  Paste: "Coller",
  "Select all": "Tout sélectionner",
  "Select none": "Tout désélectionner",
  "Shift + drag": "Maj + glisser",
  "Move straight across or down":
    "Déplacer en ligne droite, horizontalement ou verticalement",
  "Elsewhere, Tab or Ctrl/Cmd+D goes on to a new sticky note.":
    "Ailleurs, Tab ou Ctrl/Cmd+D passe à une nouvelle note adhésive.",
  "Right-click / Shift + F10": "Clic droit / Maj + F10",
  "Open the menu of the selection or board":
    "Ouvrir le menu de la sélection ou du tableau",
  "Object actions": "Actions sur l’objet",
  "Board actions": "Actions du tableau",
  "The clipboard is empty.": "Le presse-papiers est vide.",
  "Your browser did not allow access to the clipboard. Press Ctrl/Cmd+C to copy.":
    "Votre navigateur n’a pas autorisé l’accès au presse-papiers. Appuyez sur Ctrl/Cmd+C pour copier.",
  "Your browser did not allow access to the clipboard. Press Ctrl/Cmd+X to cut.":
    "Votre navigateur n’a pas autorisé l’accès au presse-papiers. Appuyez sur Ctrl/Cmd+X pour couper.",
  "Your browser did not allow access to the clipboard. Press Ctrl/Cmd+V to paste.":
    "Votre navigateur n’a pas autorisé l’accès au presse-papiers. Appuyez sur Ctrl/Cmd+V pour coller.",
  Redo: "Rétablir",
  "Delete selection": "Supprimer la sélection",
  "Keyboard-only? Use Board objects to select an object. Tool shortcuts add objects in the center of your view.":
    "Au clavier : utilisez Objets du tableau pour sélectionner un objet. Les raccourcis ajoutent les objets au centre de la vue.",
  "Drag to move this object. Use the corner handle to resize images.":
    "Faites glisser cet objet pour le déplacer. Utilisez la poignée d’angle pour redimensionner les images.",
  "Choose a file smaller than 20 MB.":
    "Choisissez un fichier de moins de 20 Mo.",
  "Choose an image smaller than 5 MB.":
    "Choisissez une image de moins de 5 Mo.",
  "Choose an image smaller than 30 MB.":
    "Choisissez une image de moins de 30 Mo.",
  "This image could not be made small enough to add.":
    "Cette image n’a pas pu être réduite suffisamment pour être ajoutée.",
  "Choose a PNG, JPEG, WebP, GIF, or BMP image.":
    "Choisissez une image PNG, JPEG, WebP, GIF ou BMP.",
  "Could not open image.": "Impossible d’ouvrir l’image.",
  "Could not import this file.": "Impossible d’importer ce fichier.",
  "Could not open cloud board.":
    "Impossible d’ouvrir le tableau dans le nuage.",
  "Puter could not load. Check your connection and try again.":
    "Puter n’a pas pu être chargé. Vérifiez votre connexion et réessayez.",
  "Could not connect to Puter.": "Connexion à Puter impossible.",
  "Could not connect. Please try again.":
    "Connexion impossible. Veuillez réessayer.",
  "Export failed. Please try again.":
    "L’exportation a échoué. Veuillez réessayer.",
  "This is not a supported Whiteboard file.":
    "Ce fichier Whiteboard n’est pas pris en charge.",
  "Your browser storage is unavailable.":
    "Le stockage de votre navigateur est indisponible.",
  "Enable site storage and reload to start creating safely.":
    "Activez le stockage du site et rechargez la page pour commencer.",
  Reload: "Recharger",
  Close: "Fermer",
  Create: "Créer",
  Cancel: "Annuler",
  Save: "Enregistrer",
  "Select objects first.": "Sélectionnez d’abord des objets.",
  "Select one object first.": "Sélectionnez d’abord un seul objet.",
  "Trash is empty.": "La corbeille est vide.",
  "Board moved to Trash.": "Tableau déplacé dans la corbeille.",
  "Board restored.": "Tableau restauré.",
  "Delete permanently": "Supprimer définitivement",
  "Delete this board permanently?": "Supprimer ce tableau définitivement ?",
  "This removes the board and its recovery versions from this device. It cannot be undone.":
    "Le tableau et ses versions de récupération sont retirés de cet appareil. Cette action est irréversible.",
  "Keep in trash": "Garder dans la corbeille",
  "Board deleted permanently.": "Tableau supprimé définitivement.",
  "Could not delete this board from this device.":
    "Impossible de supprimer ce tableau de cet appareil.",
  "Could not delete this content on this device.":
    "Impossible de supprimer ce contenu sur cet appareil.",
  "Reduce the selection to one region for image export.":
    "Choisissez une seule région pour exporter une image.",
  "Choose at least one frame.": "Choisissez au moins un cadre.",
  "The presented frames are no longer available.":
    "Les cadres présentés ne sont plus disponibles.",
  "No templates found.": "Aucun modèle trouvé.",
  "No matching objects.": "Aucun objet correspondant.",
  "This board is too spread out to show whole. Showing the part with the most objects.":
    "Ce tableau est trop étendu pour être affiché en entier. Affichage de la partie qui contient le plus d’objets.",
  "Remove from frame": "Retirer du cadre",
  "Board edit saved": "Modification enregistrée",
  "action|Open": "Ouvrir",
  "key|Shift": "Maj",
  "key|Enter": "Entrée",
  "key|Backspace": "Retour arrière",
  "key|Delete": "Suppr",
  "key|Minus": "Moins",
  "key|Up": "Haut",
  "key|Down": "Bas",
  "notification|Reply": "Réponse",
  "results|Top": "Premiers",
  "Invite people to edit, comment on, or view this board. Invitation links expire after seven days.":
    "Invitez des personnes à modifier, commenter ou consulter ce tableau. Les liens d’invitation expirent après sept jours.",
  "Copy the board's link to send it to people who already have access to it.":
    "Copiez le lien du tableau pour l’envoyer à des personnes qui y ont déjà accès.",
  "Creating link…": "Création du lien…",
  "Reset link": "Réinitialiser le lien",
  "The link now gives the chosen access. Links copied earlier keep the access they had.":
    "Le lien donne désormais l’accès choisi. Les liens copiés auparavant conservent leur accès.",
  "Earlier links no longer work. People already on the board keep access.":
    "Les anciens liens ne fonctionnent plus. Les personnes déjà sur le tableau conservent leur accès.",
  "Anyone signed in with it can join.":
    "Toute personne connectée qui l’utilise peut se joindre.",
  "Members of the organization signed in with it can join.":
    "Les membres de l’organisation connectés qui l’utilisent peuvent se joindre.",
  "Anyone signed in with it can join. People outside the organization join as guests with “{role}” access, the most your organization gives guests.":
    "Toute personne connectée qui l’utilise peut se joindre. Les personnes de l’extérieur de l’organisation se joignent comme invités avec l’accès « {role} », le plus élevé que votre organisation accorde aux invités.",
  "Anyone signed in with it can join. People outside the organization join as guests.":
    "Toute personne connectée qui l’utilise peut se joindre. Les personnes de l’extérieur de l’organisation se joignent comme invités.",
  "It opens for people who already have access.":
    "Il s’ouvre pour les personnes qui ont déjà accès.",
  "Your organization has turned off Miro imports.":
    "Votre organisation a désactivé les importations depuis Miro.",
  Planning: "Planification",
  "This export is too large. Export fewer frames at a time.":
    "Cette exportation est trop volumineuse. Exportez moins de cadres à la fois.",
  "This feature could not load. Check your connection and try again.":
    "Cette fonction n’a pas pu se charger. Vérifiez votre connexion et réessayez.",
};
// Feature modules register their own French strings next to their code.
// Existing entries win so a module cannot silently change shared labels.
export function addTranslations(entries) {
  for (const [english, french] of Object.entries(entries))
    if (!Object.hasOwn(pairs, english)) pairs[english] = french;
}
const types = {
  __proto__: null,
  note: "note adhésive",
  text: "texte",
  rect: "rectangle",
  ellipse: "ellipse",
  arrow: "flèche",
  pen: "dessin",
  frame: "cadre",
  image: "image",
  table: "tableau de données",
  link: "lien",
  file: "pièce jointe",
  embed: "intégration",
};
// A context tells apart words that translate differently, such as "Open" as
// a state and as an action: t("Open", "action") uses the "action|Open" entry.
export function t(text, context) {
  // Anything other than text, such as a missing error message, passes
  // through as it does in English.
  if (language !== "fr" || typeof text !== "string") return text;
  if (context && pairs[`${context}|${text}`])
    return pairs[`${context}|${text}`];
  if (pairs[text]) return pairs[text];
  let m;
  if (
    (m = text.match(
      /^(Select|Pan|Sticky note|Text|Rectangle|Ellipse|Arrow|Draw|Frame) \((\w)\)$/,
    ))
  )
    return `${pairs[m[1]]} (${m[2]})`;
  if ((m = text.match(/^Edit (.+)$/)) && types[m[1]])
    return `Modifier : ${types[m[1]]}`;
  // French counts 0 and 1 in the singular.
  if ((m = text.match(/^(\d+) results?$/)))
    return `${m[1]} résultat${Number(m[1]) < 2 ? "" : "s"}`;
  if ((m = text.match(/^(\d+) selected$/))) return `${m[1]} sélectionné(s)`;
  if (
    (m = text.match(
      /^(All boards|Favorites|Your boards|Favorite boards) (\d+)$/,
    ))
  )
    return `${pairs[m[1]]} ${m[2]}`;
  // The favorite star is a toggle: its name stays put and its pressed state
  // says whether the board is a favorite.
  if ((m = text.match(/^(Open|Favorite|Options for|Restore or delete) (.+)$/)))
    return `${{ Open: "Ouvrir", Favorite: "Favori :", "Options for": "Options pour", "Restore or delete": "Restaurer ou supprimer" }[m[1]]} ${m[2]}`;
  if ((m = text.match(/^(\d+) objects/)))
    return text.replace(`${m[1]} objects`, `${m[1]} objets`);
  return text;
}
// The message for a count, with {count} filled in: `one` where the language
// takes its singular, 1 in English and 0 or 1 in French, `other` elsewhere.
// A singular that English writes like its plural, such as "{count} done",
// is translated from its "one|" entry.
const pluralRules = {};
// Compares names as people read them in the language, "person2" before
// "person10"; one collator serves a whole sort of hundreds of names.
export const nameOrder = () =>
  new Intl.Collator(language === "fr" ? "fr-CA" : "en-CA", { numeric: true })
    .compare;
// Whether the language writes a count in the singular: 1 in English, 0
// and 1 in French.
export function singular(count) {
  const locale = language === "fr" ? "fr-CA" : "en-CA";
  pluralRules[locale] ??= new Intl.PluralRules(locale);
  return pluralRules[locale].select(count) === "one";
}
export function plural(count, one, other) {
  const single = singular(count);
  return t(single ? one : other, single ? "one" : undefined).replace(
    "{count}",
    count,
  );
}
// A label and what it names, as "Label: value". French sets the colon apart
// with a space.
export const labelled = (label, value) =>
  `${label}${language === "fr" ? " : " : ": "}${value}`;
const sources = new WeakMap();
const attributeSources = new WeakMap();
// The language of the last pass over the whole page. English text needs no
// translation, so once a whole pass has rendered the page in English (which
// restores it after French), further passes have nothing to do and return
// at once: this runs on each draw.
let renderedLanguage = null;
// In French every pass walks the page, so a pass runs only once the page
// has changed since the last one; the observer ignores the pass's own
// writes, which it takes before they are delivered.
let changed = true,
  observer = null,
  observed = null;
// A write of the value already there, as a paint makes each frame for the
// zoom label or a control's name, changes nothing to translate.
const realChange = (r) =>
  r.type === "attributes"
    ? r.oldValue !== r.target.getAttribute(r.attributeName)
    : r.type === "characterData"
      ? r.oldValue !== r.target.data
      : !(
          r.addedNodes.length === 1 &&
          r.removedNodes.length === 1 &&
          r.addedNodes[0].nodeType === 3 &&
          r.removedNodes[0].nodeType === 3 &&
          r.addedNodes[0].data === r.removedNodes[0].data
        );
function watchPage() {
  const Observer = document.defaultView?.MutationObserver;
  if (observed === document.body || typeof Observer !== "function") return;
  observer?.disconnect();
  observer = new Observer((records) => {
    if (records.some(realChange)) changed = true;
  });
  observed = document.body;
  changed = true;
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    characterDataOldValue: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ["aria-label", "title", "placeholder"],
  });
}
export function translateUI(root = document.body) {
  if (document.documentElement.lang !== language)
    document.documentElement.lang = language;
  const whole = root === document.body;
  if (whole) {
    watchPage();
    // Changes made just now are still on their way to the observer.
    if (
      renderedLanguage === language &&
      (language !== "fr" ||
        (observer && !changed && !observer.takeRecords().some(realChange)))
    )
      return;
    renderedLanguage = language;
  } else if (language !== "fr" && renderedLanguage === language) return;
  const skipped =
    "[data-user-content],textarea,script,style,.board-info h3,#board-outline";
  if (root.closest?.(skipped)) return;
  // Reject excluded subtrees once instead of checking every text node's
  // ancestors; this runs on each draw.
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    (node) =>
      node.nodeType === 3
        ? NodeFilter.FILTER_ACCEPT
        : node.matches(skipped)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_SKIP,
  );
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const source = sources.get(node);
    const raw =
      source && source.rendered === node.textContent
        ? source.original
        : node.textContent;
    const value = raw.trim();
    const output = raw.replace(value, () => t(value));
    if (output !== node.textContent) node.textContent = output;
    sources.set(node, { original: raw, rendered: output });
  }
  root.querySelectorAll("[aria-label],[title],[placeholder]").forEach((el) => {
    const attributes = attributeSources.get(el) || {};
    // A title on user content, such as a board card's full name, is the
    // content itself.
    const user =
      el.hasAttribute("title") && !!el.closest("[data-user-content]");
    for (const attr of ["aria-label", "title", "placeholder"])
      if (el.hasAttribute(attr) && !(user && attr === "title")) {
        const current = el.getAttribute(attr);
        const source = attributes[attr];
        const original =
          source?.rendered === current ? source.original : current;
        const rendered = t(original);
        if (rendered !== current) el.setAttribute(attr, rendered);
        attributes[attr] = { original, rendered };
      }
    attributeSources.set(el, attributes);
  });
  // The pass's own writes are not changes to translate again.
  if (whole) {
    observer?.takeRecords();
    changed = false;
  }
}
// What kind of object this is, in words people use rather than the type
// names stored in board files.
const englishTypes = {
  __proto__: null,
  note: "Sticky note",
  text: "Text",
  rect: "Rectangle",
  ellipse: "Ellipse",
  arrow: "Arrow",
  pen: "Drawing",
  frame: "Frame",
  image: "Image",
  link: "Link",
  table: "Table",
  file: "Attachment",
  embed: "Embedded content",
};
export const objectKind = (i) =>
  i.type === "rect" && i.shape
    ? t(SHAPES.find((s) => s.key === i.shape)?.name || "Rectangle")
    : (language === "fr" ? types : englishTypes)[i.type] || i.type;
// An object's kind as a label of its own, as over a search result:
// "Sticky note", in French "Note adhésive", after "Locked · " when locked.
export const kindLabel = (i) => {
  const kind = objectKind(i);
  return `${i.locked ? `${t("Locked")} · ` : ""}${kind.charAt(0).toLocaleUpperCase(language)}${kind.slice(1)}`;
};
// The title of an object's properties dialog.
export const editTitle = (i) =>
  language === "fr"
    ? `Modifier : ${objectKind(i)}`
    : `Edit ${objectKind(i).toLowerCase()}`;
export function objectNameContent(i) {
  const value = i.text || i.alt || i.fileName;
  if (value || !i.cells) return value || "";
  const text = i.cells.flat().filter(Boolean).join(" · ");
  let end = Math.min(300, text.length);
  const previous = text.charCodeAt(end - 1),
    next = text.charCodeAt(end);
  if (
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    next >= 0xdc00 &&
    next <= 0xdfff
  )
    end--;
  return text.slice(0, end);
}
// An untitled frame is named by its place in the frame order, "Frame 3",
// as new frames are, so that it can be told apart and searched for.
export const untitledFrame = (n) => `${t("Frame")} ${n + 1}`;
// "Sticky note: Idea", or in French "note adhésive : Idée", with the space
// French sets before a colon. The kind stays as written, since the name is
// also used within sentences.
export const objectName = (i) =>
  `${i.locked ? `${t("Locked")} · ` : ""}${labelled(
    objectKind(i),
    objectNameContent(i) ||
      (language === "fr" ? "Objet sans titre" : "Untitled object"),
  )}`;
