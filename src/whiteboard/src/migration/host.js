import { board as newBoard, uid } from "../model.js";
import { createMiroMigration } from "./migration-ui.js";
import { SharedDocument } from "../collaboration/document.js";
import { CollaborationSession } from "../collaboration/session.js";
import { call } from "../collaboration/api.js";
import { encode } from "../collaboration/protocol.js";

const LOG = "whiteboard/migration/miro-log.json";
export const LOCAL_ONLY_WARNING =
  "Saved only on this device, so its Miro owner and members were not added. An organization administrator can migrate it to a shared board that keeps their roles.";
// The session that creates a shared board keeps its media in memory while
// uploading. Nothing is stored on this device, where the images and files
// of every migrated board would otherwise stay.
const NO_STORE = {
  collaborationRows: async () => [],
  collaborationPut: async () => {},
  collaborationDelete: async () => {},
};

// A board the log cannot record must not stay behind. One that cannot be
// removed, as under a legal hold, is named in the error instead, so it is
// not left live and unknown, and copied again on a retry. Returns the error
// to report.
export async function discardCopy(remove, room, error) {
  const removed = await remove().then(
    () => true,
    (failure) => failure?.status === 404,
  );
  if (removed) return error;
  const reason = String(error?.message || error).replace(/\.$/, "");
  return Error(
    `The board could not be migrated (${reason}), and the shared board created for it (${room}) could not be removed. Remove it from Organization boards.`,
  );
}
// Connects the Miro migration dialog to this app: organization
// administrators migrate into shared boards on the organization's worker
// (keeping each board's owner and member roles by email), everyone else into
// boards on this device. The migration log is a file in the person's Puter
// drive.
export function createMigrationHost({
  org,
  puter,
  modal,
  toast,
  download,
  addLocalBoard,
  removeLocalBoard,
  device = () => "",
}) {
  async function sharedBoard(value, server, user, room) {
    const staging = new CollaborationSession({
      puter: puter(),
      server,
      room,
      user,
      store: NO_STORE,
      changed() {},
      activity() {},
      status() {},
    });
    const seed = new SharedDocument();
    try {
      const prepared = await staging.prepare(value);
      seed.commit(prepared);
      await staging.request("create", {
        update: encode(seed.update()),
        source: "miro",
      });
      // A board with more pictures than a person may add in a minute waits
      // for the rest to go up.
      await staging.uploadEveryAsset();
    } finally {
      seed.destroy();
      staging.shared.destroy();
    }
  }
  return createMiroMigration({
    // Templates go to the organization library, which needs a member.
    canTemplate: () => org.isMember,
    // The organization's own domains tell its people from guests.
    domains: () => org.policy?.()?.domains || [],
    modal,
    toast,
    download: (name, text, type) => download(text, name, type),
    fetch: (url, init) =>
      puter().net?.fetch ? puter().net.fetch(url, init) : fetch(url, init),
    async createBoard(
      value,
      { ownerEmail, members = [], source, asTemplate } = {},
    ) {
      const target = { ...newBoard(value.title), ...value, id: uid() };
      if (asTemplate && !org.isMember)
        throw Error("Templates are saved to an organization library.");
      if (asTemplate) {
        const { item } = await org.request("library.submit", {
          name: target.title,
          description: source?.viewLink || "",
          category: "Migrated from Miro",
          board: JSON.stringify(target),
        });
        return { id: "library:" + item.id };
      }
      // Applying owners and roles to a shared board is an administrator task.
      if (org.server && org.isAdmin) {
        const people = members.map((m) => ({
          email: m.role === "owner" ? m.email || ownerEmail : m.email,
          name: m.name,
          role: m.role,
          guest: !!m.guest,
        }));
        if (ownerEmail && !people.some((m) => m.role === "owner"))
          people.push({ email: ownerEmail, role: "owner", guest: false });
        const user = await puter().auth.getUser();
        const room = uid();
        let applied;
        try {
          await sharedBoard(target, org.server, user, room);
          applied = await org.request("migration.apply", {
            room,
            members: people,
            source,
          });
        } catch (error) {
          throw await discardCopy(
            () => call(puter(), org.server, { op: "delete", room }),
            room,
            error,
          );
        }
        // Members the board could not take are named in the log, so the
        // report does not count people who will not find the board.
        const missing = (applied?.skipped || []).length;
        return {
          id: "room:" + room,
          warnings: [
            ...(applied?.warnings || []),
            ...(missing
              ? [
                  `${missing} Miro ${missing === 1 ? "member has" : "members have"} no email address and ${missing === 1 ? "was" : "were"} not added. Map their Miro user IDs to email addresses and migrate the board again to include them.`,
                ]
              : []),
          ],
        };
      }
      await addLocalBoard(target);
      // Boards on this device can only be rolled back here. They have no
      // owner or members, so the log does not read as a complete copy.
      return {
        id: `local:${device()}:${target.id}`,
        warnings: ownerEmail || members.length ? [LOCAL_ONLY_WARNING] : [],
      };
    },
    async deleteBoard(id) {
      const [kind, value] = [
        id.slice(0, id.indexOf(":")),
        id.slice(id.indexOf(":") + 1),
      ];
      // A board or template someone already removed counts as removed.
      const gone = (error) => {
        if (error?.status !== 404) throw error;
      };
      if (kind === "library")
        return org.request("library.remove", { id: value }).catch(gone);
      if (kind === "room")
        return call(puter(), org.server, { op: "delete", room: value }).catch(
          gone,
        );
      const [owner, board] = value.includes(":")
        ? value.split(":")
        : [null, value];
      if (owner !== null && owner !== device())
        throw Error(
          "This board was migrated to another device. Roll it back on that device.",
        );
      return removeLocalBoard(board);
    },
    async saveLog(json) {
      await puter().fs.write(LOG, json, {
        overwrite: true,
        createMissingParents: true,
        dedupeName: false,
      });
    },
    // No log yet is a fresh start; any other failure must not be mistaken
    // for one, or saving would replace the earlier log.
    async loadLog() {
      try {
        return await (await puter().fs.read(LOG)).text();
      } catch (error) {
        if (
          ["subject_does_not_exist", "ENOENT", "not_found"].includes(
            error?.code,
          )
        )
          return null;
        throw error;
      }
    },
  });
}
