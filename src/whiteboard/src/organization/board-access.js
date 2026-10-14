import { escape } from "../model.js";
import { busy } from "../accessibility/busy.js";
import { addTranslations, labelled, nameOrder, t } from "../i18n.js";
import { canManage } from "../collaboration/protocol.js";
import { orderedFrames } from "../scene.js";

// Slack's status and reason for refusing a channel's last post, such as
// "404, no_service", from the worker's message.
const slackReason = (message) => {
  const m = /\((\d+)\)(?::\s*([\w.-]+))?/.exec(message);
  return m ? [m[1], m[2]].filter(Boolean).join(", ") : "";
};

export const ROLE_LABELS = {
  owner: "Owner",
  facilitator: "Facilitator",
  editor: "Can edit",
  commenter: "Can comment",
  viewer: "Can view",
  removed: "Removed",
};
// Roles someone may hand out: facilitators manage participants, but only the
// owner (or an administrator) appoints facilitators. A guest is offered no
// more than the organization lets guests have.
export function assignableRoles(role, limit) {
  const roles =
    role === "owner"
      ? ["facilitator", "editor", "commenter", "viewer"]
      : canManage(role)
        ? ["editor", "commenter", "viewer"]
        : [];
  const order = ["facilitator", "editor", "commenter", "viewer"];
  return limit
    ? roles.filter((r) => order.indexOf(r) >= order.indexOf(limit))
    : roles;
}
// A link to a section of a board opens the board focused on that frame.
export function sectionLink(link, frameId) {
  if (!frameId) return link;
  const url = new URL(link);
  const params = new URLSearchParams(url.hash.slice(1));
  params.set("object", frameId);
  url.hash = params.toString();
  return url.href;
}

export function createBoardAccess({
  org,
  session,
  board,
  hidden = () => false,
  modal,
  toast,
  icon,
  refresh = () => {},
  home = () => {},
}) {
  const api = {
    roleOptions(role, selected = "editor") {
      return assignableRoles(role)
        .map(
          (r) =>
            `<option value="${r}" ${r === selected ? "selected" : ""}>${t(ROLE_LABELS[r])}</option>`,
        )
        .join("");
    },
    // What the board's own organization lets it be shared with, as its
    // worker says. A worker from before that is judged by the viewer's own
    // organization: only a board on its server follows its policy.
    sharing(told = session()?.sharing) {
      if (told) return told;
      const inOrg = !!org.info?.configured && org.server === session()?.server;
      const policy = org.policy();
      return {
        organization: inOrg,
        member: !inOrg || !!org.isMember,
        guests:
          inOrg &&
          policy?.guestAccess !== false &&
          policy?.externalSharing !== "none" &&
          !policy?.restrictToOrganization,
        publicLinks:
          !inOrg ||
          (!!policy?.publicLinks && policy?.externalSharing === "anyone"),
      };
    },
    // Extra share controls: guest invitations and whole-board or section links.
    shareControls() {
      const b = board();
      const frames = b ? orderedFrames(b.items) : [];
      const sharing = api.sharing();
      // Where the organization admits guests, a link can still be kept to
      // its members; where it does not, every link is.
      const guests = sharing.organization && sharing.guests;
      return `${guests ? `<label class="check-field"><input type="checkbox" id="share-members"><span>${t("Only members of the organization can join with this link")}<small>${t("Otherwise people outside it join as guests, marked in the participant list, and their access can expire.")}</small></span></label>` : ""}${frames.length ? `<label class="field">${t("Link opens")}<select id="share-scope"><option value="">${t("The entire board")}</option>${frames.map((f) => `<option value="${escape(f.id)}">${escape(labelled(t("Section"), f.text || t("Untitled frame")))}${hidden(f.id) ? ` (${t("not shown to participants yet")})` : ""}</option>`).join("")}</select></label>` : ""}`;
    },
    async settings() {
      const s = session();
      if (!s) return;
      if (!canManage(s.role))
        return toast(
          "Only the board owner or a facilitator can change board settings.",
        );
      const inOrg = !!org.info?.configured && org.server === s.server;
      // Spaces and teams are organization member data; guests do not file
      // boards into them.
      const organize = inOrg && org.isMember;
      const optional = (promise) => promise.catch(() => null);
      // Settings still open without the optional lists.
      const [spaceList, teamList, memberList, answer] = await Promise.all([
        organize
          ? optional(org.request("spaces.list").then((r) => r.spaces))
          : [],
        organize
          ? optional(org.request("teams.list").then((r) => r.teams))
          : [],
        optional(s.request("members").then((r) => r.members)),
        optional(s.request("settings.get")),
      ]);
      const latest = answer?.settings,
        latestSharing = answer?.sharing;
      // The person may have left this board while the lists loaded; the
      // dialog would then act on a board that is no longer open.
      if (s.closed || session() !== s) return;
      // Spaces, teams, and members are listed by name, as in the admin
      // console, rather than in storage order.
      const order = nameOrder();
      const spaces = [...(spaceList || [])].sort((a, b) =>
          order(a.name, b.name),
        ),
        teams = [...(teamList || [])].sort((a, b) => order(a.name, b.name)),
        members = [...(memberList || [])].sort((a, b) =>
          order(a.username || a.uuid, b.username || b.uuid),
        );
      if (latest) s.settings = { ...s.settings, ...latest };
      const sharing = api.sharing(latestSharing || s.sharing);
      // Who can open an organization's board is for its members to decide;
      // a guest facilitating it sees the choices but cannot change them.
      const decides = sharing.member || s.role === "owner";
      const current = s.settings || {
        visibility: "private",
        orgRole: "editor",
        linkRole: "viewer",
        teamRole: "none",
      };
      // Only send the space and team when their current values and choices
      // are known, so saving other settings never clears them.
      const organizeKnown = !!(latest && spaceList && teamList);
      // What the form showed when it opened, or last saved.
      const shown = {
        visibility: current.visibility,
        orgRole: current.orgRole,
        linkRole: current.linkRole,
        teamRole: current.teamRole || "none",
      };
      const linksAllowed = sharing.publicLinks;
      const owner = s.role === "owner";
      modal(
        "Board settings",
        `<form id="board-settings" class="policy-form"><fieldset ${decides ? "" : 'disabled aria-describedby="bs-members-only"'}><legend>${t("Who can open this board")}</legend>${decides ? "" : `<p class="dialog-copy" id="bs-members-only">${t("Only members of the organization can change who can open this board.")}</p>`}${[
          ["private", "Only invited people"],
          ...(sharing.organization
            ? [["organization", "Everyone in the organization"]]
            : []),
          ["link", "Anyone signed in with the link"],
        ]
          .map(
            ([v, l]) =>
              `<label class="check-field"><input type="radio" name="bs-visibility" value="${v}" ${current.visibility === v ? "checked" : ""} ${v === "link" && !linksAllowed ? "disabled" : ""}><span>${t(l)}${v === "link" && !linksAllowed ? `<small>${t("Your organization does not allow public board links.")}</small>` : ""}</span></label>`,
          )
          .join(
            "",
          )}${sharing.organization ? `<label class="field">${t("Role for organization members")}<select id="bs-org-role">${["editor", "commenter", "viewer"].map((r) => `<option value="${r}" ${current.orgRole === r ? "selected" : ""}>${t(ROLE_LABELS[r])}</option>`).join("")}</select></label>` : ""}<label class="field">${t("Role for people with the link")}<select id="bs-link-role">${["editor", "commenter", "viewer"].map((r) => `<option value="${r}" ${current.linkRole === r ? "selected" : ""}>${t(ROLE_LABELS[r])}</option>`).join("")}</select></label></fieldset>${organize ? `<fieldset><legend>${t("Organize")}</legend><label class="field">${t("Space")}<select id="bs-space"><option value="">${t("None")}</option>${spaces.map((sp) => `<option value="${escape(sp.id)}" ${current.space === sp.id ? "selected" : ""} data-user-content>${escape(sp.name)}</option>`).join("")}</select></label><label class="field">${t("Team")}<select id="bs-team"><option value="">${t("None")}</option>${teams.map((tm) => `<option value="${escape(tm.id)}" ${current.team === tm.id ? "selected" : ""} data-user-content>${escape(tm.name)}</option>`).join("")}</select></label><label class="field">${t("Role for team members")}<select id="bs-team-role" aria-describedby="bs-team-role-note" ${current.team && decides ? "" : "disabled"}>${["none", "editor", "commenter", "viewer"].map((r) => `<option value="${r}" ${shown.teamRole === r ? "selected" : ""}>${t(r === "none" ? "No access" : ROLE_LABELS[r])}</option>`).join("")}</select><small id="bs-team-role-note">${t("People on the board’s team open it with this role for as long as they are on the team.")}<span id="bs-team-role-hint"${current.team ? " hidden" : ""}> ${t("Choose a team first.")}</span></small></label>${org.allows("slack") && latest?.integrations ? `<label class="field">${t("Slack channel webhook for mentions (optional)")} ${latest.slack ? `<span class="badge">${t("Connected")}</span>` : ""}<input id="bs-slack" type="url" placeholder="https://hooks.slack.com/services/…" autocomplete="off"${latest.slackError ? ' aria-describedby="bs-slack-error"' : ""}></label>${latest.slackError ? `<p class="dialog-copy" id="bs-slack-error">${t("Slack stopped taking this board's posts ({reason}). Connect the channel again with a new webhook URL.").replace("{reason}", () => escape(slackReason(latest.slackError)))}</p>` : ""}${latest.slack ? `<label class="check-field"><input type="checkbox" id="bs-slack-off"><span>${t("Disconnect Slack")}</span></label>` : ""}` : ""}</fieldset>` : ""}${decides || organize ? `<div class="dialog-footer"><button class="primary">${t("Save settings")}</button></div>` : ""}</form>${
          owner
            ? `<section class="policy-form"><h3>${t("Ownership and lifecycle")}</h3><div class="inline-form"><div class="share-link-row"><label class="field">${t("Transfer ownership to")}<select id="bs-transfer"><option value="">${t("Choose a member")}</option>${members
                .filter(
                  (m) =>
                    m.role !== "owner" &&
                    m.role !== "removed" &&
                    !m.guest &&
                    !m.inactive,
                )
                .map(
                  (m) =>
                    `<option value="${escape(m.uuid)}" data-user-content>${escape(m.username || m.uuid)}</option>`,
                )
                .join(
                  "",
                )}</select></label><button class="secondary" id="bs-transfer-go">${t("Transfer")}</button></div></div><div class="dialog-footer"><button class="secondary" id="bs-archive">${icon("archive")}${t(current.archived ? "Unarchive board" : "Archive board")}</button><button class="text-btn danger" id="bs-delete">${t("Delete board for everyone")}</button></div></section>`
            : ""
        }<p id="bs-status" class="dialog-status" role="status"></p>`,
        (d) => {
          const out = d.querySelector("#bs-status");
          // What happened, told apart as an error or a success by its look.
          const say = (text, kind = "") => {
            out.textContent = text;
            if (kind) out.dataset.kind = kind;
            else delete out.dataset.kind;
          };
          // Where the board is filed as shown when the dialog opened, or
          // last saved, compared on saving.
          const filed = {
            space: d.querySelector("#bs-space")?.value,
            team: d.querySelector("#bs-team")?.value,
          };
          // The role for a team's members is chosen once the board has a
          // team; a board taken out of its team gives no one access.
          const teamRole = d.querySelector("#bs-team-role");
          d.querySelector("#bs-team")?.addEventListener("change", (e) => {
            teamRole.disabled = !e.target.value || !decides;
            if (!e.target.value) teamRole.value = "none";
            d.querySelector("#bs-team-role-hint").hidden = !!e.target.value;
          });
          const run = async (button, fn) => {
            const done = busy(button);
            try {
              await fn();
            } catch (error) {
              say(t(error.message), "error");
            } finally {
              done();
            }
          };
          d.querySelector("#board-settings").onsubmit = (e) => {
            e.preventDefault();
            run(e.submitter, async () => {
              const chosen = {
                visibility: d.querySelector('[name="bs-visibility"]:checked')
                  ?.value,
                orgRole: d.querySelector("#bs-org-role")?.value,
                linkRole: d.querySelector("#bs-link-role").value,
                teamRole: organizeKnown ? teamRole?.value : undefined,
              };
              // Only what was changed here is sent, so saving never undoes a
              // change someone else made while this dialog was open.
              const payload = Object.fromEntries(
                Object.entries(chosen).filter(
                  ([key, value]) => value !== undefined && value !== shown[key],
                ),
              );
              if (organizeKnown && d.querySelector("#bs-space"))
                for (const key of ["space", "team"]) {
                  const value = d.querySelector(`#bs-${key}`).value;
                  if (value !== filed[key]) payload[key] = value || null;
                }
              const slack = d.querySelector("#bs-slack")?.value;
              if (slack) payload.slack = slack;
              else if (d.querySelector("#bs-slack-off")?.checked)
                payload.slack = "";
              const { settings } = await s.request("settings", payload);
              s.settings = settings;
              Object.assign(shown, chosen);
              // The board's role for its team as saved, which leaving the
              // team empty clears.
              if (teamRole && settings?.teamRole) {
                teamRole.value = shown.teamRole = settings.teamRole;
                teamRole.disabled = !settings.team || !decides;
              }
              if (organizeKnown && d.querySelector("#bs-space"))
                for (const key of ["space", "team"])
                  filed[key] = d.querySelector(`#bs-${key}`).value;
              // A saved webhook is not sent again with later changes, and
              // the dialog shows whether Slack is now connected.
              if (payload.slack !== undefined) {
                const input = d.querySelector("#bs-slack"),
                  field = input.closest("label"),
                  connected = !!payload.slack;
                input.value = "";
                field.querySelector(".badge")?.remove();
                const off = d.querySelector("#bs-slack-off");
                if (connected) {
                  const badge = document.createElement("span");
                  badge.className = "badge";
                  badge.textContent = t("Connected");
                  input.before(badge);
                  if (off) off.checked = false;
                  else
                    field.insertAdjacentHTML(
                      "afterend",
                      `<label class="check-field"><input type="checkbox" id="bs-slack-off"><span>${t("Disconnect Slack")}</span></label>`,
                    );
                } else off?.closest("label").remove();
              }
              // The dialog says so itself; a notification as well would
              // say the same thing twice in two wordings.
              say(t("Settings saved."), "success");
            });
          };
          // Giving the board away takes a second press, which names who
          // receives it; choosing someone else asks again.
          const transfer = d.querySelector("#bs-transfer-go");
          d.querySelector("#bs-transfer")?.addEventListener("change", () => {
            delete transfer.dataset.confirm;
            transfer.textContent = t("Transfer");
          });
          transfer?.addEventListener("click", (e) =>
            run(e.currentTarget, async () => {
              const field = d.querySelector("#bs-transfer");
              const uuid = field.value;
              if (!uuid) throw Error(t("Choose a member."));
              if (transfer.dataset.confirm !== uuid) {
                transfer.dataset.confirm = uuid;
                const ask = t(
                  "Select again to transfer ownership to {name}",
                ).replace(
                  "{name}",
                  () => field.selectedOptions[0]?.textContent || uuid,
                );
                transfer.textContent = ask;
                // The renamed button keeps focus, so say what it now asks.
                say(ask);
                return;
              }
              // A transfer that failed asks again before the next one.
              delete transfer.dataset.confirm;
              transfer.textContent = t("Transfer");
              await s.request("transfer", { uuid });
              await s.heartbeat?.();
              // Transfer, archive, and delete belong to the new owner now,
              // unless this person keeps owner rights as an administrator.
              if (s.role === "owner") {
                say(t("Ownership transferred."), "success");
                return;
              }
              d.querySelector("#bs-transfer-go").closest("section").remove();
              d.querySelector("#board-settings .primary")?.focus();
              say(
                t("Ownership transferred. You are now a facilitator."),
                "success",
              );
            }),
          );
          d.querySelector("#bs-archive")?.addEventListener("click", (e) =>
            run(e.currentTarget, async () => {
              const { settings } = await s.request(
                current.archived ? "unarchive" : "archive",
              );
              s.settings = settings;
              // The board locks or unlocks now, not at the next check-in,
              // so no edit is made on an archived board and refused later.
              await s.heartbeat?.();
              d.close();
              toast(
                settings.archived
                  ? "Board archived. It is now read-only."
                  : "Board unarchived. It can be edited again.",
              );
            }),
          );
          const del = d.querySelector("#bs-delete");
          del?.addEventListener("click", (e) =>
            run(e.currentTarget, async () => {
              if (!del.dataset.confirm) {
                del.dataset.confirm = "1";
                del.textContent = t("Select again to delete for everyone");
                // The renamed button keeps focus, so say what it now asks.
                say(t("Select again to delete for everyone"));
                return;
              }
              await s.request("delete");
              d.close();
              toast(
                "Board deleted. An administrator can restore it during the retention period.",
              );
              home();
            }),
          );
          refresh();
        },
      );
    },
  };
  return api;
}

addTranslations({
  Owner: "Propriétaire",
  Facilitator: "Animateur",
  "Can edit": "Peut modifier",
  "Can comment": "Peut commenter",
  "Can view": "Peut consulter",
  Removed: "Retiré",
  "Guest access ended": "Accès invité terminé",
  "Can no longer open this board": "Ne peut plus ouvrir ce tableau",
  "Access until {date}": "Accès jusqu’au {date}",
  "Renew access": "Renouveler l’accès",
  "Renew access for {name}": "Renouveler l’accès de {name}",
  "Access renewed.": "Accès renouvelé.",
  "Access renewed until {date}.": "Accès renouvelé jusqu’au {date}.",
  "Only members of the organization can join with this link":
    "Seuls les membres de l’organisation peuvent se joindre avec ce lien",
  "Otherwise people outside it join as guests, marked in the participant list, and their access can expire.":
    "Sinon, les personnes de l’extérieur se joignent comme invités, signalés dans la liste des participants, et leur accès peut expirer.",
  "Link opens": "Le lien ouvre",
  "The entire board": "Le tableau entier",
  Section: "Section",
  "not shown to participants yet": "pas encore montré aux participants",
  "Untitled frame": "Cadre sans titre",
  "Only the board owner or a facilitator can change board settings.":
    "Seuls le propriétaire du tableau ou un animateur peuvent modifier les paramètres du tableau.",
  "Board settings": "Paramètres du tableau",
  "Who can open this board": "Qui peut ouvrir ce tableau",
  "Only invited people": "Seulement les personnes invitées",
  "Everyone in the organization": "Tout le monde dans l’organisation",
  "Anyone signed in with the link": "Toute personne connectée ayant le lien",
  "Your organization does not allow public board links.":
    "Votre organisation n’autorise pas les liens publics vers les tableaux.",
  "Role for organization members": "Rôle des membres de l’organisation",
  "Role for people with the link": "Rôle des personnes ayant le lien",
  "Role for team members": "Rôle des membres de l’équipe",
  "No access": "Aucun accès",
  "People on the board’s team open it with this role for as long as they are on the team.":
    "Les personnes de l’équipe du tableau l’ouvrent avec ce rôle tant qu’elles font partie de l’équipe.",
  "Choose a team first.": "Choisissez d’abord une équipe.",
  Organize: "Organiser",
  Space: "Espace",
  Team: "Équipe",
  None: "Aucun",
  "Slack stopped taking this board's posts ({reason}). Connect the channel again with a new webhook URL.":
    "Slack n’accepte plus les publications de ce tableau ({reason}). Connectez de nouveau le canal avec une nouvelle URL de webhook.",
  "Slack channel webhook for mentions (optional)":
    "Webhook du canal Slack pour les mentions (facultatif)",
  Connected: "Connecté",
  "Disconnect Slack": "Déconnecter Slack",
  "Save settings": "Enregistrer les paramètres",
  "Ownership and lifecycle": "Propriété et cycle de vie",
  "Transfer ownership to": "Transférer la propriété à",
  "Choose a member": "Choisir un membre",
  Transfer: "Transférer",
  "Unarchive board": "Désarchiver le tableau",
  "Archive board": "Archiver le tableau",
  "Delete board for everyone": "Supprimer le tableau pour tout le monde",
  "Settings saved.": "Paramètres enregistrés.",
  "Choose a member.": "Choisissez un membre.",
  "Ownership transferred. You are now a facilitator.":
    "Propriété transférée. Vous animez maintenant ce tableau.",
  "Ownership transferred.": "Propriété transférée.",
  "Board archived. It is now read-only.":
    "Tableau archivé. Il est maintenant en lecture seule.",
  "Board unarchived. It can be edited again.":
    "Tableau désarchivé. Il peut de nouveau être modifié.",
  "Select again to transfer ownership to {name}":
    "Sélectionnez de nouveau pour transférer la propriété à {name}",
  "Select again to delete for everyone":
    "Sélectionnez de nouveau pour supprimer pour tout le monde",
  "Board deleted. An administrator can restore it during the retention period.":
    "Tableau supprimé. Un administrateur peut le restaurer pendant la période de conservation.",
  Guest: "Invité",
});
