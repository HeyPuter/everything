// Canadian French for messages the collaboration and organization workers
// return. Screens show them as they arrive, so they load with the app.
// Messages only the SCIM and REST APIs return stay in English for the
// machines that read them.
import { addTranslations } from "./i18n.js";

addTranslations({
  // Access and sign-in
  "Could not verify this collaboration request.":
    "Impossible de vérifier cette demande de collaboration.",
  "Request too large": "Demande trop volumineuse",
  "A JSON request body is required.": "Un corps de demande JSON est requis.",
  "Invalid JSON request.": "Demande JSON non valide.",
  "The board could not synchronize. Please retry.":
    "Le tableau n’a pas pu se synchroniser. Veuillez réessayer.",
  "The shared board's storage is busy. Try again shortly.":
    "Le stockage du tableau partagé est occupé. Réessayez dans quelques instants.",
  "This change adds a file that was not uploaded.":
    "Cette modification ajoute un fichier qui n’a pas été téléversé.",
  "Too much feedback at once. Try again in an hour.":
    "Trop de commentaires d’un coup. Réessayez dans une heure.",
  "Sign in with Puter to continue.":
    "Connectez-vous avec Puter pour continuer.",
  "Board not found.": "Tableau introuvable.",
  "You no longer have access to this board.":
    "Vous n’avez plus accès à ce tableau.",
  "Your board access was removed.": "Votre accès au tableau a été retiré.",
  "Your guest access to this board has expired.":
    "Votre accès invité à ce tableau a expiré.",
  "Your organization account is deactivated.":
    "Votre compte de l’organisation est désactivé.",
  "Your organization does not allow guest access.":
    "Votre organisation n’autorise pas l’accès des invités.",
  "Your organization only allows its own members on this board.":
    "Votre organisation n’autorise que ses propres membres sur ce tableau.",
  "Only members of the organization can change who can open this board.":
    "Seuls les membres de l’organisation peuvent changer qui peut ouvrir ce tableau.",
  "This invitation has expired or was revoked.":
    "Cette invitation a expiré ou a été révoquée.",
  "This link is only for members of the organization. Ask the person who shared it for a guest invitation.":
    "Ce lien est réservé aux membres de l’organisation. Demandez une invitation d’invité à la personne qui l’a partagé.",
  "This organization invitation has expired or was revoked.":
    "Cette invitation à l’organisation a expiré ou a été révoquée.",
  "This board has reached its participant limit.":
    "Ce tableau a atteint sa limite de participants.",
  "This board has reached its 1 GB limit for images and files.":
    "Ce tableau a atteint sa limite de 1 Go pour les images et les fichiers.",
  "This board is archived and read-only.":
    "Ce tableau est archivé et en lecture seule.",
  "This board is under a legal hold and cannot be deleted.":
    "Ce tableau fait l’objet d’une conservation légale et ne peut pas être supprimé.",
  "This board is being permanently deleted.":
    "Ce tableau est en cours de suppression définitive.",
  "This board is already being created. Please retry sharing.":
    "Ce tableau est déjà en cours de création. Réessayez de le partager.",
  "Commenters can add comments but cannot change board content.":
    "Les commentateurs peuvent ajouter des commentaires, mais pas modifier le contenu du tableau.",
  "This change continues another participant's edits.":
    "Cette modification prolonge les modifications d’un autre participant.",
  "This change spans too many editing sessions.":
    "Cette modification couvre trop de sessions d’édition.",
  "Invalid collaboration update.": "Mise à jour de collaboration non valide.",
  "Only organization members can file boards into spaces.":
    "Seuls les membres de l’organisation peuvent classer des tableaux dans des espaces.",
  "Choose a space or team that exists.":
    "Choisissez un espace ou une équipe qui existe.",
  "Choose a team for this board first.":
    "Choisissez d’abord une équipe pour ce tableau.",
  "Member not found.": "Membre introuvable.",
  "Your organization does not let guests facilitate boards.":
    "Votre organisation ne permet pas aux invités d’animer des tableaux.",
  "Your organization lets guests view and comment on boards, not edit them.":
    "Votre organisation permet aux invités de consulter et de commenter les tableaux, mais pas de les modifier.",
  "Your organization lets guests only view boards.":
    "Votre organisation permet seulement aux invités de consulter les tableaux.",
  "Choose a role an invitation can give.":
    "Choisissez un rôle qu’une invitation peut donner.",
  "Only a guest's access can be renewed.":
    "Seul l’accès d’un invité peut être renouvelé.",
  "Invalid role change.": "Changement de rôle non valide.",
  "Invalid visibility.": "Visibilité non valide.",
  "Invalid default role.": "Rôle par défaut non valide.",
  "Only the board owner can manage access.":
    "Seul le propriétaire du tableau peut gérer l’accès.",
  "Only the board owner can invite facilitators.":
    "Seul le propriétaire du tableau peut inviter des animateurs.",
  "Only the board owner can change facilitators.":
    "Seul le propriétaire du tableau peut changer les animateurs.",
  "Only the board owner can finish creating this board.":
    "Seul le propriétaire du tableau peut terminer sa création.",
  "Only the board owner or an administrator can do this.":
    "Seuls le propriétaire du tableau ou un administrateur peuvent le faire.",
  "Only the board owner or an administrator can transfer ownership.":
    "Seuls le propriétaire du tableau ou un administrateur peuvent en transférer la propriété.",
  "Only the account owner can transfer boards owned by the account owner or an administrator.":
    "Seul le propriétaire du compte peut transférer les tableaux appartenant au propriétaire du compte ou à un administrateur.",
  "Only the board owner or an administrator can connect Slack.":
    "Seuls le propriétaire du tableau ou un administrateur peuvent connecter Slack.",
  "Your organization has turned off Slack.":
    "Votre organisation a désactivé Slack.",
  "Only the server owner can create boards.":
    "Seul le propriétaire du serveur peut créer des tableaux.",
  // Saving and sharing
  "Collaboration request is too large.":
    "La demande de collaboration est trop volumineuse.",
  "This change depends on edits that have not arrived yet.":
    "Cette modification dépend de modifications qui ne sont pas encore arrivées.",
  "Update checksum does not match.":
    "La somme de contrôle de la modification ne correspond pas.",
  "Invalid asset.": "Fichier non valide.",
  "Invalid shared asset.": "Fichier partagé non valide.",
  "Invalid peer key.": "Clé de pair non valide.",
  "Invalid identifier.": "Identifiant non valide.",
  "Session belongs to another participant.":
    "Cette session appartient à un autre participant.",
  "Unknown collaboration operation.": "Opération de collaboration inconnue.",
  "This change was rejected.": "Cette modification a été refusée.",
  "This board could not be shared.": "Ce tableau n’a pas pu être partagé.",
  "Choose a version.": "Choisissez une version.",
  "Choose someone in your organization.":
    "Choisissez une personne de votre organisation.",
  // Organization membership and email
  "Only organization members can do this.":
    "Seuls les membres de l’organisation peuvent le faire.",
  "Only organization administrators can do this.":
    "Seuls les administrateurs de l’organisation peuvent le faire.",
  "Only organization administrators can place legal holds.":
    "Seuls les administrateurs de l’organisation peuvent imposer une conservation légale.",
  "Only the account owner can set up the organization.":
    "Seul le propriétaire du compte peut créer l’organisation.",
  "Only the account owner can appoint administrators.":
    "Seul le propriétaire du compte peut nommer des administrateurs.",
  "Only the account owner can change an administrator.":
    "Seul le propriétaire du compte peut modifier un administrateur.",
  "Only the account owner can invite administrators.":
    "Seul le propriétaire du compte peut inviter des administrateurs.",
  "The account owner's role cannot change.":
    "Le rôle du propriétaire du compte ne peut pas changer.",
  "Invalid organization role.": "Rôle dans l’organisation non valide.",
  "Invalid account status.": "État du compte non valide.",
  "This user has not signed in yet.":
    "Cette personne ne s’est pas encore connectée.",
  "User not found.": "Personne introuvable.",
  "Team not found.": "Équipe introuvable.",
  "This team is being changed. Please try again.":
    "Cette équipe est en cours de modification. Veuillez réessayer.",
  "Unknown organization operation.": "Opération d’organisation inconnue.",
  "Join the organization to save preferences.":
    "Joignez-vous à l’organisation pour enregistrer vos préférences.",
  "Enter a valid email address.": "Entrez une adresse courriel valide.",
  "That code is not correct.": "Ce code n’est pas le bon.",
  "This code expired. Request a new one.":
    "Ce code a expiré. Demandez-en un nouveau.",
  "Too many requests. Try again in a minute.":
    "Trop de demandes. Réessayez dans une minute.",
  "Too many attempts. Request a new code.":
    "Trop de tentatives. Demandez un nouveau code.",
  "Too many attempts. Try again in an hour.":
    "Trop de tentatives. Réessayez dans une heure.",
  "Too many verification emails. Try again in an hour.":
    "Trop de courriels de vérification. Réessayez dans une heure.",
  "This email address is already linked to another account.":
    "Cette adresse courriel est déjà liée à un autre compte.",
  "Your identity provider manages your email address. Ask your administrator to change it.":
    "Votre fournisseur d’identité gère votre adresse courriel. Demandez à votre administrateur de la modifier.",
  "The verification email could not be sent. Ask your administrator to check the organization's Puter plan.":
    "Le courriel de vérification n’a pas pu être envoyé. Demandez à votre administrateur de vérifier l’abonnement Puter de l’organisation.",
  "Use an email address in your organization's domain, or ask an administrator for an invitation.":
    "Utilisez une adresse courriel du domaine de votre organisation, ou demandez une invitation à un administrateur.",
  "Verify an email address in your organization's domain, or ask an administrator for an invitation.":
    "Vérifiez une adresse courriel du domaine de votre organisation, ou demandez une invitation à un administrateur.",
  // Organization settings
  "Enter valid email domains, such as example.ca.":
    "Entrez des domaines de courriel valides, comme exemple.ca.",
  "A domain anyone can register under, such as co.uk, cannot be the organization's. Enter its own domain.":
    "Un domaine sous lequel n’importe qui peut s’enregistrer, comme co.uk, ne peut pas être celui de l’organisation. Entrez son propre domaine.",
  "Public email domains such as gmail.com cannot be the organization's: anyone can have an address there.":
    "Les domaines de courriel publics comme gmail.com ne peuvent pas être ceux de l’organisation : n’importe qui peut y avoir une adresse.",
  "Enter up to ten valid alert email addresses.":
    "Entrez jusqu’à dix adresses courriel valides pour les alertes.",
  "Enter up to ten valid report email addresses.":
    "Entrez jusqu’à dix adresses courriel valides pour les rapports.",
  "Enter at least one recipient for scheduled reports.":
    "Entrez au moins un destinataire pour les rapports planifiés.",
  "Enter a valid HTTPS address.": "Entrez une adresse HTTPS valide.",
  "Enter a valid HTTPS webhook URL.": "Entrez une URL de webhook HTTPS valide.",
  "Webhooks must use a public internet address.":
    "Les webhooks doivent utiliser une adresse Internet publique.",
  "This administrator invitation was already used.":
    "Cette invitation d’administrateur a déjà été utilisée.",
  "Choose an active member of your organization.":
    "Choisissez un membre actif de votre organisation.",
  "This change is too large to save.":
    "Cette modification est trop volumineuse pour être enregistrée.",
  "The webhook secret is not available yet.":
    "Le secret du webhook n’est pas encore disponible.",
  "The SIEM endpoint must use a public internet address.":
    "Le point de terminaison SIEM doit utiliser une adresse Internet publique.",
  "Webhook not found.": "Webhook introuvable.",
  "Enter a Slack incoming webhook URL.":
    "Entrez l’URL d’un webhook entrant Slack.",
  "Enter your Jira Cloud site, such as team.atlassian.net.":
    "Entrez votre site Jira Cloud, comme equipe.atlassian.net.",
  "Enter a Jira project key, such as OPS.":
    "Entrez une clé de projet Jira, comme OPS.",
  "Enter the Microsoft Entra tenant ID.":
    "Entrez l’ID du locataire Microsoft Entra.",
  "Enter the application (client) ID.": "Entrez l’ID d’application (client).",
  "Enter the data collection endpoint logs ingestion URL.":
    "Entrez l’URL d’ingestion des journaux du point de terminaison de collecte de données.",
  "Enter the data collection rule immutable ID.":
    "Entrez l’ID immuable de la règle de collecte de données.",
  "Enter the stream name, such as Custom-WhiteboardAudit.":
    "Entrez le nom du flux, comme Custom-WhiteboardAudit.",
  "Enter the bearer token again for the new endpoint.":
    "Entrez de nouveau le jeton du porteur pour le nouveau point de terminaison.",
  "Unknown integration secret.": "Secret d’intégration inconnu.",
  "Add the SIEM HTTPS endpoint.":
    "Ajoutez le point de terminaison HTTPS du SIEM.",
  "Add the Sentinel client secret.": "Ajoutez le secret client de Sentinel.",
  "Complete the Sentinel connection settings.":
    "Remplissez les paramètres de connexion à Sentinel.",
  "The SIEM test failed.": "L’essai du SIEM a échoué.",
  "Choose a SIEM destination to send a test event.":
    "Choisissez une destination SIEM pour envoyer un événement d’essai.",
  "The webhook test failed.": "L’essai du webhook a échoué.",
  "Could not reach Slack.": "Impossible de joindre Slack.",
  "Puter enforces multifactor authentication at sign-in, so there is nothing to turn on here.":
    "Puter impose l’authentification multifacteur à la connexion; il n’y a donc rien à activer ici.",
  "Choose at least one scope.": "Choisissez au moins une portée.",
  "Choose a whole number of days for the key to expire.":
    "Choisissez un nombre entier de jours avant l’expiration de la clé.",
  "API key not found.": "Clé d’API introuvable.",
  "Invalid date range.": "Plage de dates non valide.",
  // Spaces, library, feedback and AI
  "Only organization members can manage spaces.":
    "Seuls les membres de l’organisation peuvent gérer les espaces.",
  "A space with this name already exists.": "Un espace porte déjà ce nom.",
  "Only organization members can share library content.":
    "Seuls les membres de l’organisation peuvent partager du contenu de la bibliothèque.",
  "Library item not found.": "Élément de bibliothèque introuvable.",
  "Invalid library description language.":
    "Langue de la description de bibliothèque invalide.",
  "This item is awaiting approval.": "Cet élément attend une approbation.",
  "This content is too large for the library.":
    "Ce contenu est trop volumineux pour la bibliothèque.",
  "Your library items awaiting approval have reached 250 MB. Share more once an administrator has reviewed them.":
    "Vos éléments de bibliothèque en attente d’approbation ont atteint 250 Mo. Partagez-en d’autres une fois qu’un administrateur les aura examinés.",
  "Library items awaiting approval have reached the organization's 1 GB limit. Share this once an administrator has reviewed them.":
    "Les éléments de bibliothèque en attente d’approbation ont atteint la limite de 1 Go de l’organisation. Partagez celui-ci une fois qu’un administrateur les aura examinés.",
  "Choose a rating from 1 to 5.": "Choisissez une note de 1 à 5.",
  "Only people in the organization can send feedback.":
    "Seules les personnes de l’organisation peuvent envoyer des commentaires.",
  "Choose a PNG, JPEG, or WebP photo.":
    "Choisissez une photo PNG, JPEG ou WebP.",
  "AI features are available to organization members.":
    "Les fonctions d’IA sont offertes aux membres de l’organisation.",
  "Nothing to send to AI.": "Rien à envoyer à l’IA.",
  "Unknown AI task.": "Tâche d’IA inconnue.",
  "Choose events by audit action or prefix, such as board or user.role, or * for every event.":
    "Choisissez les événements par action d’audit ou par préfixe, comme board ou user.role, ou * pour tous les événements.",
});
