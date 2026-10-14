# Google Workspace directory sync

Google Workspace provisions only the apps in its own catalog automatically, so Whiteboard includes a small Apps Script, [`whiteboard-sync.gs`](whiteboard-sync.gs), that runs in your Google Workspace at no cost and keeps your Whiteboard organization in step with the directory through its SCIM 2.0 API:

| In Google Workspace                                      | In Whiteboard                                                                                                                    |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| A user in scope (all users, or those `USER_QUERY` finds) | A person, provisioned under their primary address; they join when they sign in and verify it                                     |
| Name or primary address changes                          | The same changes                                                                                                                 |
| User in a guest organizational unit (`GUEST_ORG_UNITS`)  | Guest role and guest license; everyone else is a member with a full license                                                      |
| User suspended or archived                               | Deactivated: their sessions end on every board                                                                                   |
| User deleted, or moved out of scope                      | Removed from the identity provider's view and deactivated, so their address can go to someone new without reaching their account |
| A group listed in `GROUPS`                               | A team of the same name with the group's people, including those of groups inside it; renamed when it is renamed                 |

People are matched by their Google user ID (kept as the SCIM `externalId`, `google:<id>`), then by address, so someone who already joined with their work address is linked rather than duplicated. A record that holds the address but carries another identifier, another Google user's or another provisioning tool's, is never taken over: the run logs the conflict for an administrator. People provisioned another way, and administrators' role, are left alone; the account owner appoints administrators in Whiteboard. Each run compares the directory with Whiteboard and sends only the differences.

Google Workspace is the source of truth for who is active: someone deactivated only in Whiteboard is reactivated at the next run while they are active in Google. To end someone's access, suspend them in Google Workspace, which also ends their Google sign-in.

## Set up

1. As the organization's account owner, open **Organization settings → Security**, create an API key with the `scim` scope, and copy it. Only a key the account owner creates can deactivate an administrator who is suspended in Google. The worker's address is the SCIM base URL without `/scim/v2`.
2. As a Google Workspace administrator who can read users and groups, open [script.google.com](https://script.google.com), create a project, and paste the contents of `whiteboard-sync.gs` into `Code.gs`.
3. Under **Services**, add the **Admin SDK API** (identifier `AdminDirectory`).
4. Under **Project Settings → Script properties**, add:

   | Property               | Value                                                                                                                                          |
   | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
   | `WHITEBOARD_URL`       | The worker's address, such as `https://whiteboard-abc.puter.work`                                                                              |
   | `WHITEBOARD_SCIM_KEY`  | The API key                                                                                                                                    |
   | `USER_QUERY`           | Optional. An [Admin SDK user search](https://developers.google.com/admin-sdk/directory/v1/guides/search-users), such as `orgUnitPath='/Staff'` |
   | `GUEST_ORG_UNITS`      | Optional. Organizational units whose people are guests, comma separated, such as `/Contractors`                                                |
   | `GROUPS`               | Optional. Group addresses to keep as teams, comma separated                                                                                    |
   | `DRY_RUN`              | `true` for a first run that only logs what it would change                                                                                     |
   | `ALLOW_LARGE_REMOVALS` | `true` to let one run remove more than a fifth of the people it provisioned (see Notes)                                                        |

5. Select `syncWhiteboard` and **Run**. Approve the permissions, then read the execution log. Remove `DRY_RUN` (or set it to `false`) and run it again.
6. Under **Triggers**, add a time-driven trigger for `syncWhiteboard`, for example every 15 minutes.

People then sign in to Puter with **Sign in with Google** and verify their work address once (**Verify your email** in the board library); their provisioned role, license, and teams apply from then on.

## Notes

- A run stops after about four and a half minutes, within Apps Script's six-minute limit, and the next run continues, so a first sync of thousands of people takes a few runs. Changes are sent 20 at a time.
- A change Whiteboard refuses, such as an address another person already holds, is logged and counted as failed, and the others go ahead. A suspension is sent on its own, so it goes through even when a rename sent with it is refused.
- A run that finds no users changes nothing, and one in which more than a fifth of the people it provisioned (and more than ten) left the directory removes none of them and logs why, in case the directory answered only in part; set `ALLOW_LARGE_REMOVALS` to `true` for one run when that is right.
- Only one run works at a time: one started while another runs stops at once.
- Removing a group from `GROUPS` leaves its team as it is; delete the team in Whiteboard if it is no longer wanted.
- Anyone who can edit the script project can read its script properties: keep the project to the administrators who run it. To replace the key, create a new one, update `WHITEBOARD_SCIM_KEY`, and revoke the old one.
- Every change is recorded in the organization's audit log (`scim.user.created`, `scim.user.updated`, `scim.group.created`, `scim.group.updated`), with the API key that made it, and is exported to a SIEM with the rest.
