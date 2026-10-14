# Microsoft Sentinel integration

A Whiteboard organization exports its audit log to Microsoft Sentinel in near real time. Two supported patterns share the same record format.

| Pattern            | How it works                                                                                                                                                        | When to use it                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Push (recommended) | The organization's worker sends each batch of audit events to the Azure Monitor Logs Ingestion API within seconds of the activity while the organization is in use. | Default for Sentinel. No polling infrastructure.      |
| Pull               | Sentinel (or any SIEM) polls `GET /v1/audit?format=ndjson` with an API key that has the `audit:read` scope, paging with the `X-Next-Cursor` header.                 | When outbound pushes are not wanted, or for backfill. |

## Push setup

1. Register an application in Microsoft Entra ID and create a client secret. Note the tenant ID and the application (client) ID, and the object ID of its enterprise application (service principal).
2. Deploy [`whiteboard-sentinel.json`](whiteboard-sentinel.json) to the resource group of the Log Analytics workspace that Sentinel uses:

   ```sh
   az deployment group create \
     --resource-group <resource-group> \
     --template-file docs/sentinel/whiteboard-sentinel.json \
     --parameters workspaceName=<workspace> servicePrincipalObjectId=<object-id>
   ```

   The template creates the `WhiteboardAudit_CL` table, a data collection endpoint, a data collection rule with the `Custom-WhiteboardAudit` stream, and grants the application the Monitoring Metrics Publisher role on the rule. Its outputs are the logs ingestion endpoint and the rule's immutable ID.

3. In Whiteboard, open **Organization settings → Security → SIEM export**, choose **Microsoft Sentinel**, and enter the tenant ID, application ID, client secret, the logs ingestion endpoint, the data collection rule immutable ID, and `Custom-WhiteboardAudit` as the stream. Choose the event categories to export.
4. Select **Send test event**. A `siem.test` record appears in `WhiteboardAudit_CL` within a few minutes of the first ingestion (new tables can take longer on first use). The Security tab shows the last delivery time, the number of events sent, and the last error.

The client secret is stored only in the organization's worker storage with sharing disabled and is never returned to browsers. Access tokens are requested with the client credentials flow for the `https://monitor.azure.com//.default` scope and cached until shortly before they expire.

### Delivery behavior

- Every administrative, security, access, sharing, API, and (optionally) board content event is written to the audit log first, then exported. Export is at-least-once: each record carries a unique `EventId` for de-duplication.
- The worker keeps an export cursor. If Sentinel is unreachable, the next request resumes from the cursor, so no events are skipped.
- Administrative, security, access, and sharing events are sent as they happen, with any events waiting. Board content events and API reads, which come in bursts, are sent at most every 10 seconds, with a request to the organization once that time has passed.
- Each call to the ingestion API stays under its 1 MB limit. A record too large to send alone, which is rare, is sent without its `Details`, which stay in the audit log.

## Record format

| Column                                 | Type     | Description                                                                                                          |
| -------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `TimeGenerated`                        | datetime | When the event happened (UTC)                                                                                        |
| `EventId`                              | string   | Unique, sortable event identifier                                                                                    |
| `Category`                             | string   | `admin`, `security`, `access`, `sharing`, `content`, or `api`                                                        |
| `Action`                               | string   | For example `board.visibility.link`, `board.role.changed`, `user.deactivated`, `apikey.created`, `scim.user.updated` |
| `ActorId`, `ActorName`                 | string   | Puter account UUID and username, or the API key for API and SCIM calls                                               |
| `TargetType`, `TargetId`, `TargetName` | string   | What the action affected (board, user, team, space, API key, webhook, organization)                                  |
| `BoardId`                              | string   | Board the event relates to, if any                                                                                   |
| `SourceIp`, `UserAgent`                | string   | Request origin when available                                                                                        |
| `Details`                              | dynamic  | Action-specific fields, such as `from` and `to` roles                                                                |

## Example queries

Boards opened to anyone with the link in the last day:

```kusto
WhiteboardAudit_CL
| where TimeGenerated > ago(1d) and Action == "board.visibility.link"
| project TimeGenerated, ActorName, BoardId, Details
```

Guests joining boards, by board:

```kusto
WhiteboardAudit_CL
| where Action == "board.guest.joined"
| summarize Guests = dcount(ActorId) by BoardId, bin(TimeGenerated, 1d)
```

Permission changes and deactivations:

```kusto
WhiteboardAudit_CL
| where Action in ("board.role.changed", "user.role.changed", "user.deactivated", "scim.user.updated")
| project TimeGenerated, Action, ActorName, TargetName, Details
```

An analytics rule on the first query gives Sentinel incidents for public sharing. Whiteboard can also alert administrators directly by email and Slack for public sharing, guest access, permission changes, and policy changes.
